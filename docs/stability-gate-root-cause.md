# Persisted reference-alias collision — root cause and acceptance gate

**Status:** automated and scripted acceptance pass, including the `inspect_nodes` schema hotfix; authenticated Figma Desktop acceptance is **PENDING**. No Phase 5.9 work or production-readiness claim is included.

## Evidence boundary

- The source path and a persisted-state regression reproduce the reported `ambiguous_alias` failure. The regression was run against the old resolver and failed there; it passes after the resolver change.
- The reproducer is synthetic: it creates a page-global `store_mobile` reference, inspects it from a task, creates a task-owned node under the same alias, saves a checkpoint after one committed mutation, reloads it, recreates the executor, and resumes. It is not evidence that the live document had this exact owner or history.
- The exact live owner of `store_mobile`, the original rejected operation, and the live checkpoint contents remain unknown until sanitized diagnostics are supplied. Do not infer them from the fixture.
- The separate planning-metadata rejection documented in [phase-5-8-stability-gate.md](phase-5-8-stability-gate.md) is not proof of this resolver failure or its cause.

## Root cause

The application maintains two related but distinct stores: page-scoped native-node references in the tool executor, and a document/page-scoped chat-task checkpoint. An existing page node can already have the literal reference `store_mobile`. When a task inspects it, `registerLogicalRef` records that it was inspected by that task. A new task-owned creation using the same alias receives a task-scoped canonical reference and stores the alias separately.

On a later operation, `resolveTaskAction` finds the unique current-task alias and the same-literal page reference. The old resolver threw `ambiguous_alias` when that page reference had also been inspected by the current task, even though the task-owned alias mapped to one canonical reference. The failure occurred before the action reached the native-node resolver; a safe, already-created task node was therefore mistaken for an ambiguous target. A one-operation checkpoint could persist this state, so reload/resume repeated the same failure.

The resolver now treats a **unique current-task alias mapping** as authoritative over a same-literal page reference. It still validates the canonical reference against persisted page/node identity before targeting anything. Multiple current-task nodes with the same alias remain ambiguous and fail closed.

## Follow-up hotfix: `inspect_nodes.maxNodes`

The supplied live screenshot showed an authenticated Responses call rejected at `arguments.maxNodes` with `arguments_schema/too_big`, after 1 of 3 stages and 31 confirmed mutations (17 model rounds, 19 batches). The screenshot establishes that the value was numeric and above 25, but does not show the scalar; the sanitized diagnostic did not retain it, and its exact historical value is unavailable. Do not infer a value.

The authenticated `/v1/chat` route sends `CHAT_FUNCTION_TOOLS`, generated from the same strict `FigmaToolActionSchema` used to parse calls. The tool schema advertises `maxNodes` as an integer 1–25 (default 25), `depth` as 0–4 (default 2), and at most 20 refs. The parser now clamps only finite numeric values outside the read-only inspection bounds before strict validation; missing values still use schema defaults. It does not coerce strings, booleans, nulls, or in-range fractions. Native inspection output remains capped at 25 nodes. Invalid values return the exact accepted range and safe type/finite-number diagnostics without echoing full arguments.

The regression in `tests/companion-server.test.ts` verifies the authenticated Responses schema, local clamping, and a storage-backed three-stage Stop/Resume/Retry path. It commits 31 native mock nodes, reloads the checkpoint, inspects between stages, injects a pre-commit stage-three failure, retries only that stage, and verifies the same 31 node IDs remain with no duplicate stage frames. This is automated simulated acceptance, not a new live Desktop run.

## Call path and state boundaries

1. `src/ui/App.tsx` (`sendChatMessage`) builds/resumes the task and checkpoints it through `chatTaskBridge`.
2. `src/ui/chat-task.ts` (`runChatTask`, `chatTaskInput`) manages planning, confirmed calls, operation IDs, retries, and saved continuation state.
3. `src/ui/companion-client.ts` (`streamAuthorizedChat`) sends the authorized turn to `src/companion/server.ts` (`handleChat`, `/v1/chat`). The companion validates Responses function calls and streams `tool_calls` through SSE.
4. `runChatTask` dispatches approved operations to `App.tsx` (`runToolOperations`) as `tool-execute` messages. `src/plugin/main.ts` validates the message with `UIToPluginSchema` and dispatches it to the executor.
5. `src/plugin/figma-tool-executor.ts` runs `executeBatch` → `executeOperation` → `resolveTaskAction` → `actionResult`. `resolveTaskAction` selects a canonical task reference; `resolveRef` verifies the persisted reference and the current Figma page before a native node can be targeted.
6. `src/plugin/chat-task-storage.ts` stores/reloads the checkpoint under the active file/page key. The executor separately persists page-scoped references and operation/idempotency records in client storage; node plugin data binds canonical ref, task, operation, and creation fingerprint.

The Responses/OAuth service and Figma objects in automated tests are controlled mocks. This call path is production code under test, not authenticated live-model or Desktop execution.

## Resolver and safety invariants

- If exactly one current-task mapping exists for an alias, resolve to its canonical reference rather than the same-literal page ref.
- Before editing, `resolveRef` confirms the stored page and node still exist on the current page, the node carries the canonical ref, and the reference remains unique. For records that have the new identity fields it also checks parent, node type, and creation fingerprint; task and creation-operation metadata are checked when present. Legacy records retain their prior checks.
- A stale, moved, changed, missing, foreign-page, unconfirmed, or otherwise uncertain target is not guessed or recreated. A genuinely duplicated current-task alias returns at most three canonical candidates plus the bounded total count and tells the caller to inspect candidates one at a time.
- `parentId` is updated only after an authorized append/reparent operation succeeds and its undo commit is made. An out-of-band move or fingerprint tamper fails closed; a successfully authorized move remains resolvable for later edits.
- The change does not loosen schemas, ownership, page scope, idempotency, deletion consent, cancellation, or retry rules. Existing user-owned content still requires the established inspection path.

## Acceptance matrix

| Check                                   | Evidence                                                                                                                      | Result and limit                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reported alias collision                | `tests/companion-server.test.ts`: `continues a persisted one-commit task without colliding with an inspected page alias`      | **PASS simulated.** Old resolver reproduced `ambiguous_alias`; fixed resolver resumes the saved task without creating a duplicate. The live document's exact state remains unknown.                                                                                                     |
| Duplicate task aliases                  | `tests/figma-tool-executor.test.ts`: `returns bounded canonical candidates when persisted current-task aliases are ambiguous` | **PASS automated.** Fails closed, gives bounded candidates and a usable inspection path.                                                                                                                                                                                                |
| Moved/tampered references               | `tests/figma-tool-executor.test.ts`: moved-node and authorized-reparent regressions                                           | **PASS automated.** Unapproved move/fingerprint change is rejected; authorized reparent updates identity after commit and permits a later edit.                                                                                                                                         |
| Diagnostic privacy                      | `tests/chat-task.test.ts`: sanitized diagnostic regression                                                                    | **PASS automated.** Copy data contains safe identifiers, allowlisted category/code, counts, and no prompt, node content, raw arguments, or arbitrary injected code text.                                                                                                                |
| Exact Persian storefront and follow-up  | `tests/companion-server.test.ts`: scripted end-to-end HTTP/SSE integration                                                    | **PASS simulated.** Scripted model creates thirteen editable mock nodes, survives a lost acknowledgement/checkpoint reload, then recolors only two existing purchase-button frames. Node count stays thirteen and the header fill is unchanged. No actual visual rendering is assessed. |
| `inspect_nodes` schema and continuation | `tests/chat-tools.test.ts`, `tests/companion-server.test.ts`: authenticated schema, bounded normalization, three-stage retry  | **PASS automated.** 31 committed native mock nodes retain their identities through Stop, Resume, an inspection between stages, a failed stage-three write, and Retry; no duplicate frames are created. The historical rejected scalar remains unknown.                                  |
| Repository verification                 | 338 tests / 26 files; typecheck; companion TypeScript emit; lint; format; build; `verify:phase5`                              | **PASS automated.** The compiled-entrypoint check explicitly performs no OAuth or Figma Desktop acceptance.                                                                                                                                                                             |
| Authenticated Figma Desktop             | No native Desktop-control endpoint is attached to this session                                                                | **PENDING.** The hotfix has not yet been exercised with the authenticated Desktop workflow or visually accepted.                                                                                                                                                                        |

## Manual Desktop gate

Run this with the normal authenticated account-visible model and a development plugin rebuilt from the current source. Keep the previously failing page intact; use a separate test page for a clean run. Do not clear task/reference storage to manufacture a pass.

1. Run `npm run build` and `npx tsc -p tsconfig.companion.json`, restart the companion through the normal local workflow, and reload the development plugin in Figma Desktop. Confirm the expected account/model is available; run the normal Settings smoke check if needed.
2. Keep only `[FAD_CHAT_DIAGNOSTIC]` companion lines and the UI's **Copy sanitized diagnostic** output if a task fails. The copied bundle contains task/stage/call/tool/operation identifiers, failure category/code, reference-resolution code/count, committed-operation count, rounds, batches, and a retry signature. It excludes the prompt, canvas text, raw arguments, and candidate contents. Do not share raw Responses bodies, tokens, credentials, or full plugin tool-result payloads.
3. Send exactly:

   > یک صفحه موبایل 390×844 برای فروشگاه لباس فارسی طراحی کن؛ شامل هدر، جست‌وجو، دسته‌بندی‌ها، بنر، دو کارت محصول با قیمت تومان و دکمه خرید. تمام عناصر قابل‌ویرایش باشند.

4. Require every stage to complete. Inspect the canvas and Layers panel for a 390×844 storefront with editable header, search, categories, banner, two product cards, toman prices, and purchase buttons. Confirm there are no duplicate layers or unresolved reference errors. Save a screenshot showing the canvas, Layers panel, and final task state.
5. Send exactly: `رنگ دکمه‌های خرید را صورتی کن؛ بقیه عناصر تغییر نکنند.` Verify that only the existing purchase-button nodes change, no node is added, and the rest of the page remains unchanged. Keep before/after screenshots or safe node-count evidence.
6. On a separate test run, stop after a visible commit, reload the plugin, and resume/retry the saved task. Confirm already committed node identities remain and no duplicate layers appear. Then, if appropriate, retry on the preserved previously failing page; uncertain legacy state must request inspection rather than recreate nodes.
7. Record the model slug, build/reload time, elapsed time, completed stages, node counts, and any safe diagnostic. Stop after repeated-error termination; do not loop retries. Return the sanitized diagnostic and screenshots for human review.

Until that authenticated manual gate is completed, acceptance remains **BLOCKED**. No live owner or rejected-operation attribution is established by this document.
