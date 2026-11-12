# Phase 8 — Model Management, Connectivity, and Recovery

## Baseline and architecture map

- The registered `manifest.json` is the active checkout's manifest and points to `dist/plugin.js` and `dist/ui.html`. Its development network allowlist is `http://localhost:1455`; production domains are `none`. The plugin UI opens at 440×720 in `src/plugin/main.ts`.
- The UI in `src/ui/App.tsx` owns Companion reachability/auth snapshots, model catalog and selection, settings, generation, and the long-lived Chat task controller. `src/ui/companion-client.ts` uses the local Companion URL and maps safe error categories. The Companion routes in `src/companion/server.ts` perform authenticated model listing and Responses calls; OAuth credentials live behind `credential-store.ts` and secure-storage interfaces.
- Existing chat conversation history is version 1 and document/page scoped in `src/shared/chat-history.ts` and `src/plugin/chat-history-storage.ts`. Task checkpoints are separate, version 1 records handled by `src/shared/chat-task.ts` and `src/plugin/chat-task-storage.ts`. Local pairing restore tickets are separately stored in Figma `clientStorage`.
- The existing Companion supports system-browser sign-in, explicit plan-use authorization, account-visible model discovery, fixed Responses smoke verification, bounded upstream requests, and refresh-token handling when the provider returns one. No API-key flow or subscription-derived model inference is present.
- Phase 7's Chat baseline is the frozen route-branch SHA-256 `56d6d0c34d076ab32942bfcd8feb754f951d67593311864946298383b2e50522`; the frozen CSS prefix SHA-256 is `e268f69387f50a007b7a3ce54b258f711241c9f02c693dbcb1164e4811b2bdf6`. The approval requires that the Chat route branch and CSS baseline remain unchanged.
- Phase 6.9's open acceptance gates remain open: `LIVE-1`, `SCALE-1`, `DESIGN-1`, `DESIGN-2`, and `REG-1`. Desktop/live authenticated-provider acceptance was not established by the Phase 7 source/build evidence.

## Gap register (before implementation)

| Severity | Existing source                                                                      | Gap and reproduction                                                                                                                                                                                  | Planned fix                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | `src/ui/inference-eligibility.ts:19-25`; `src/ui/App.tsx:1885-1909`                  | Refresh models with a removed selected model; `retainSelectedAccountModel` silently falls back to the last verified or first listed model. That changes execution behavior without the user's choice. | Keep an existing saved/conversation selection even when the current catalog does not contain it; make unavailability explicit and require explicit selection. Preserve the existing first-launch default only when no selection exists. |
| High     | `src/ui/App.tsx:1511-1587`; `src/shared/chat-task.ts:426-439`                        | Start a task, change Settings model, then reload/resume. The checkpoint has no effective model identity and resumed inference uses the current React selection.                                       | Add an optional validated model snapshot to new checkpoints; use it for all resumes/retries. Preserve legacy checkpoints and bind the historical conversation's recorded model when present.                                            |
| High     | `src/ui/App.tsx:465, 648-659, 1220-1240`; `src/plugin/main.ts:19, 166-200`           | Select a model, close/reopen the plugin with no selected conversation. The global selection is held only in React state/conversation metadata and is not a durable user preference.                   | Add a versioned Figma `clientStorage` model preference alongside, but separate from, the pairing ticket and chat history. Validate and preserve malformed/future records before explicit replacement.                                   |
| Medium   | `src/ui/App.tsx:1044-1133, 1885-1915`; `src/ui/companion-client.ts:395-402, 897-937` | Start a slow model refresh, switch/disconnect account or issue a newer refresh. An older response can still overwrite current state; local UI fetches have no explicit deadline.                      | Add abort/timeout support, request-generation guards, and consume catalog plus status from the same authenticated response.                                                                                                             |
| Medium   | `src/ui/App.tsx:194-267, 1044-1120`; `src/ui/inference-eligibility.ts`               | Local reachability is represented as a coarse UI state and account/provider/model readiness are inferred in separate checks; `/health` alone can look connected.                                      | Derive a single user-facing service state from reachability, auth, provider errors, catalog, and selected-model verification while retaining the underlying independent facts.                                                          |
| Medium   | `src/ui/App.tsx:1977-1990`                                                           | Disconnecting an account clears the in-memory model selection along with connection-scoped state. This needlessly loses a preference and can appear as data reset.                                    | Preserve the saved model preference independently; clear only account/session/catalog/verification state. Never clear chat history or task checkpoints.                                                                                 |
| Low      | `src/ui/companion-client.ts:910-937`; `src/ui/App.tsx:1885-1915`                     | Authenticated model discovery reports safe server categories but does not make catalog request cancellation/deadline or stale-result behavior explicit.                                               | Reuse safe categorized errors, add bounded UI request timeout, and test cancellation and stale catalog reconciliation.                                                                                                                  |

## Implementation plan

1. Add validated, versioned model preference persistence in the existing plugin-to-UI/clientStorage boundary; retain corrupt or unknown bytes before a user-initiated overwrite.
2. Make model catalog reconciliation preserve explicit choices, add request deadlines/cancellation and stale-response guards, and surface a derived connection/model state in existing non-Chat Settings.
3. Snapshot the effective model on new Chat task checkpoints and use that identity across retry/resume; leave legacy checkpoint data valid and keep native task guards unchanged.
4. Add focused storage, catalog reconciliation, connection-state, checkpoint compatibility, race, and Chat-freeze regression tests.
5. Run the requested test/typecheck/lint/build/Companion/Phase 5 checks, verify manifest/artifact freshness and formatting for changed files, then record live acceptance as verified or unverified with its concrete reason.

## Before/after gap register

| Gap                                   | Before                                                                                                            | After                                                                                                                                                                                             | Evidence                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Removed or stale selected model       | Catalog reconciliation could silently fall back to a different available model.                                   | Explicit selections survive reordered/empty/stale catalogs. An unavailable choice stays visible and inference eligibility blocks it until the user selects a currently verified model.            | `tests/inference-eligibility.test.ts`, `tests/model-management.test.ts`                           |
| Model preference lifetime             | Selection was only in UI/conversation state.                                                                      | A version 1 preference is loaded and saved through the plugin `clientStorage` message boundary. The preference is distinct from per-conversation and per-task model identity.                     | `tests/model-management.test.ts`, `tests/messages.test.ts`                                        |
| Corrupt or future preference          | No global preference format existed.                                                                              | Invalid data is reported without printing it. Before an explicit replacement, original value is copied to a bounded sidecar; a full/invalid/unwritable sidecar fails closed.                      | storage tests for corrupt/future input and sidecar write failure                                  |
| Active task model changes             | Checkpoint did not bind future inference to its model.                                                            | New task checkpoints record a validated model ID. Retry/resume reuses that ID. Settings offers an explicit checkpoint update only for an inactive, incomplete task and a verified selected model. | `tests/chat-task.test.ts`, `tests/model-management.test.ts`, existing task-runner regressions     |
| Catalog race/account switch           | Refreshes lacked UI deadline/cancellation, and a delayed server model response could outlive its account session. | UI refreshes are abortable, time-bounded, and fenced by request generation and token. Server refuses a model response if its captured authenticated session is no longer current.                 | `tests/companion-client.test.ts`, delayed account-switch case in `tests/companion-server.test.ts` |
| Readiness represented by local health | Companion availability could be mistaken for account/model readiness.                                             | Settings derives a status from local reachability, auth/session state, provider/catalog errors, selected model availability, and successful inference verification.                               | connection-state cases in `tests/model-management.test.ts` and UI status tests                    |

## Architecture and behavior

```text
Settings/More model controls (src/ui/App.tsx)
  -> typed UI/plugin messages (src/shared/messages.ts)
  -> Figma clientStorage preference boundary (src/plugin/main.ts)
  -> validated v1 record + preserved-corrupt sidecar (src/plugin/model-preference-storage.ts)

Settings refresh
  -> Companion client: bounded /v1/models request and safe error categories
  -> Companion authenticated provider session: account-visible catalog + auth status
  -> generation/token/session guards before catalog state is accepted
  -> selected-model availability + Responses verification gate

Chat task start/resume
  -> task checkpoint captures model ID (src/shared/chat-task.ts)
  -> existing task runner and inference client receive the pinned model
  -> existing checkpoints, operation guards, native readback and verification remain authoritative
```

No second model registry, orchestration controller, OAuth flow, or history store was introduced. Account credentials remain in the Companion's existing credential-store boundary. The model-preference record contains only a validated provider model identifier; it has no token, account ID, prompt, or provider payload.

### Model state definitions

The derived Settings state (`src/shared/model-preference.ts`) is one of:

| State                     | Meaning shown to the user                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `checking`                | The catalog/auth check is pending or no successful catalog check exists yet.                                                                |
| `companion_unavailable`   | Local Companion is not reachable. This says nothing about saved credentials.                                                                |
| `authentication_required` | Sign-in, plan-use scope, or account eligibility is missing.                                                                                 |
| `session_expired`         | The existing Companion/provider flow reports expired authorization; user can use the existing sign-in path. No new refresh promise is made. |
| `provider_unavailable`    | A bounded request timed out, connection failed, or provider returned a temporary service outage.                                            |
| `rate_limited`            | Provider rate limit was returned.                                                                                                           |
| `model_unavailable`       | Selected model was removed, is unauthorized, or failed account verification. Saved preference is retained.                                  |
| `model_unverified`        | Catalog is known but the selected model has not passed the existing Responses smoke verification.                                           |
| `ready`                   | The current session has an authorized catalog and the selected model matches the Companion's inference-verified model.                      |
| `unknown_error`           | An unclassified safe error needs review; raw payload/stack is not surfaced.                                                                 |

The lower-level local connection and auth snapshots remain separate facts. A local `/health` success alone never sets `ready`. Catalog refresh is user initiated, aborts a preceding refresh, has a 20 second request deadline, and uses request revision plus captured-token checks. The Companion also checks the captured live session after its provider response, returning an account mismatch rather than presenting a stale catalog. The existing Companion's own health polling remains bounded at its existing cadence; this change adds no retry/poll loop. Sign-in and disconnect invalidate catalog work but do not clear model preference, chat history, checkpoints, or canvas content.

### Preference, migration, and recovery

- New key: `fad.model-preference.v1`, schema `{ version: 1, selectedModel }`, validated against a 1–200 character safe model-ID alphabet.
- Preservation sidecar: `fad.model-preference-preserved.v1`, at most eight archived original values with timestamps. On malformed/unknown preference, loading is read-only. A user choice archives the previous value before writing the replacement; archive corruption, capacity exhaustion, quota failure, or write failure stops the replacement and reports failure. The old bytes/value are not reset to make recovery succeed.
- Existing v1 task records are backward compatible: `model` is optional and validated when present. No destructive task/history migration is needed. New tasks snapshot it; legacy task resume resolves from that task's stored conversation selection at its already existing explicit resume action and saves the model into its next checkpoint.
- Existing conversation history remains separate and retains its own model and stable ID. Conversation model validation now accepts the same 200-character bound, without rewriting stored records. Drafts are not merged with history or tasks.
- Saved preference is distinct from a currently verified catalog choice and from a model pinned to a task. On startup a saved model is restored but cannot pass inference eligibility until it is available and verified. Reordering does not change it; removal or offline state keeps it saved and blocks use. A first catalog choice is saved only when no prior user preference exists and the old first-available default behavior applies.
- A user changing Settings does not redirect an existing task. To change the model for future steps of a paused/inactive task, the user must select a verified model and activate the explicit task checkpoint action. It is disabled while a chat or native operation is active. The existing task ledger and checkpoint fields are copied unchanged. An unknown in-flight request outcome is not automatically replayed by this UI work.
- Save requests are serialized in the plugin storage adapter. UI messages have request IDs and bounded pending lifetimes. Write acknowledgements only update the UI after success; errors do not claim persistence.

## Security and data safety

- The registered manifest remains restricted to production `none` and development `http://localhost:1455`. The existing loopback and origin/CSRF approval mechanisms were not loosened. No provider endpoint or OAuth callback allowlist was added.
- OAuth tokens/refresh credentials stay in the existing Companion credential-store boundary. They are not included in model preferences, chat history, task metadata, diagnostics, or this document. User-facing errors use existing safe categories and concise explanations.
- Account disconnect/sign-out affects only the existing connection/session boundary and catalog state. It does not remove conversations, task ledgers, checkpoints, canvas nodes, page selection, or settings.
- Preference writes use Figma `clientStorage` only; no Figma document, canvas, or node API is called from the model-preference message handler. Existing native verification and fail-closed task completion behavior were left in place.
- The model-catalog route's account-switch fence is covered with realistic mocked provider latency. This does not establish provider behavior during live OAuth or guarantee that a real external provider never revokes authorization between operations.

## Chat freeze and non-Chat UI review

- The Chat conditional route branch in `src/ui/App.tsx` still matches the approved SHA-256 `56d6d0c34d076ab32942bfcd8feb754f951d67593311864946298383b2e50522`; `tests/ui.test.tsx` asserts it and keeps the approved Chat markup snapshot.
- The Chat CSS prefix before `/* Phase 7 non-Chat refinements.` still matches `e268f69387f50a007b7a3ce54b258f711241c9f02c693dbcb1164e4811b2bdf6`. New CSS is scoped to the Settings model status and explicit task-model choice, after this boundary. No Chat classes, layout tokens, or Chat styles changed.
- `App.tsx` does change outside the Chat branch for preference state, catalog cancellation, task model pinning, and Settings display. Chat's task request path now carries the model already selected for that conversation and reuses the pinned ID for later inference. This is a nonvisual lifecycle integration required to prevent silent task-model substitution.
- Before/after for non-Chat surfaces: **Home** retains Phase 7's existing recent task/conversation and capability dashboard; it now restores the persisted model selection through shared app state. **Chat** is source/style protected as above; visual Desktop equivalence was not measured. **History** retains stable conversation/task records and chronology, with its existing open/resume paths now displaying the model actually pinned to that task; no delete/rename semantics were added. **More** keeps the existing connection/model summary and accurate future-feature labels; model status now distinguishes local, auth, provider, catalog, and verification state. **Settings** adds the saved preference/current selection/task-pinned model distinction, actionable offline/auth/model error context, explicit catalog refresh and safe model selection/checkpoint update. No second Settings experience was added.

### Accessibility and panel constraints

- Existing 440×720 default remains set in `src/plugin/main.ts`. No resize protocol or minimum-width policy was changed. The non-Chat Settings metadata uses semantic status text, native select/button controls, explicit disabled guards, LTR `bdi` for IDs, visible existing focus styling, and isolated `overflow-wrap:anywhere` styles for long technical labels in narrow panels.
- Navigation and Chat execution controller remain at the existing app shell level, avoiding task-controller remount on route changes. Existing drawer focus management is covered by UI regressions. Catalog calls are aborted on account changes/unmount, and pending preference responses are timed out and cleaned up.
- Automated markup/CSS checks verify protected Chat source and selectors. No live 440×720 or alternate-height panel rendering, Persian glyph shaping, screen reader session, or keyboard-only Desktop test was performed. The current product does not ship a complete Persian localization for these Settings status labels; mixed technical IDs are explicitly LTR.

## Exact changed files

- `src/shared/model-preference.ts` — validated preference, catalog-state mapping, task-model helper.
- `src/plugin/model-preference-storage.ts` — bounded serialized preference writes and corrupt-value preservation sidecar.
- `src/shared/messages.ts`, `src/plugin/main.ts` — typed request/reply protocol and clientStorage adapter.
- `src/shared/chat-task.ts`, `src/shared/chat-history.ts` — compatible model snapshot validation and 200-character conversation model acceptance.
- `src/ui/companion-client.ts`, `src/companion/server.ts` — bounded/cancellable model discovery and authenticated-session race fence.
- `src/ui/inference-eligibility.ts`, `src/ui/App.tsx`, `src/ui/styles.css` — selection retention, durable restore, truthful status, safe task pinning, Settings UI, and isolated narrow-panel wrapping.
- `tests/model-management.test.ts`, `tests/companion-client.test.ts`, `tests/companion-server.test.ts`, `tests/messages.test.ts`, `tests/inference-eligibility.test.ts`, `tests/chat-task.test.ts`, `tests/ui.test.tsx` — focused persistence/state/race/compatibility/freeze regressions.
- `docs/phase-8-model-management.md` — this implementation and acceptance record.

## Automated verification

Automated test doubles simulate Companion and provider responses; they are mock evidence, never authenticated-inference evidence. The `verify:phase5` script verifies the registered manifest and output freshness and boots compiled Companion health on ephemeral loopback; that health probe is not an OAuth, account, or inference test.

| Check                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                             | **PASS** — 31 files; 517 passed, 1 skipped (518 total).                                                                                                                                                                                                                                                                                                                                                                |
| `npm run typecheck`                    | **PASS** — clean.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run lint`                         | **PASS** — zero warnings.                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run build`                        | **PASS** — built `dist/ui.html` and `dist/plugin.js`.                                                                                                                                                                                                                                                                                                                                                                  |
| `npx tsc -p tsconfig.companion.json`   | **PASS** — clean.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run verify:phase5`                | **PASS** — registered manifest and current plugin/UI/Companion entrypoints verified; compiled Companion health booted on ephemeral loopback. No OAuth/Desktop acceptance.                                                                                                                                                                                                                                              |
| `git diff --check`                     | **PASS** — no whitespace errors; Git printed expected LF→CRLF working-copy notices.                                                                                                                                                                                                                                                                                                                                    |
| Targeted Prettier on 19 modified files | **12 PASS; 7 existing formatting failures.** The failing files (`src/shared/chat-task.ts`, `src/shared/messages.ts`, `src/ui/App.tsx`, `src/ui/companion-client.ts`, `tests/chat-task.test.ts`, `tests/companion-client.test.ts`, `tests/companion-server.test.ts`) were also unformatted at `HEAD`; they were not mass-reformatted to avoid unrelated churn. New files, CSS, docs, and the other modified files pass. |
| `npm run format:check`                 | **FAIL — 117 repository files** are not Prettier-clean. This repo-wide debt predates this change; no repository-wide formatting was applied.                                                                                                                                                                                                                                                                           |

### Registered manifest and artifact freshness

`npm run verify:phase5` confirmed Figma Desktop's registered development manifest is `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated\manifest.json`; it points to `dist/plugin.js` and `dist/ui.html`. Network access remains production `none`, development `http://localhost:1455`. The verifier confirmed the newly built registered UI/plugin and Companion entrypoints are current.

| Artifact                             |     Bytes | SHA-256                                                            |
| ------------------------------------ | --------: | ------------------------------------------------------------------ |
| `manifest.json`                      |       325 | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |
| `dist/plugin.js`                     | 1,638,611 | `1C9B1F7E7B30177CC29BA5A6110C425BFC8991EA57B50C702C17EE122BF91767` |
| `dist/ui.html`                       | 1,203,396 | `A87347658846077A9F91B2FA59F13DC38ECB92D35BAE8165F12FB51760B50955` |
| `dist-companion/companion/main.js`   |     2,563 | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` |
| `dist-companion/companion/server.js` |   164,816 | `CAFEECA695CE87BFBD70BAB83A40FBA1617E2BABB803B75055858EFEBEC572AA` |

## Live acceptance matrix

No Figma Desktop screenshot/capture or authenticated-provider inference was obtained for this phase. Two capture attempts during the preceding registered-plugin acceptance timed out even though a Figma process was present; a process/window check is not acceptance evidence. The Phase 8 scenarios below are therefore deliberately marked **UNVERIFIED**, and the real-provider model IDs and model-used evidence are unavailable.

| Scenario                                                                | Evidence/status                                                                | Concrete reason                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Companion offline → online and account sign-in/reauth                   | **UNVERIFIED**                                                                 | No Desktop interaction/capture or live Companion credential session.                                |
| Authenticated model discovery, real IDs, selection and inference        | **UNVERIFIED**                                                                 | Only mocked provider/list responses were used; no authenticated inference was manufactured.         |
| Plugin close/reopen restores preference/history without replay          | **UNVERIFIED live**; persistence adapter/reopen semantics automated with mocks | Figma Desktop lifecycle not exercised.                                                              |
| Companion restart and session expiry                                    | **UNVERIFIED**                                                                 | No live account or Companion restart test.                                                          |
| Active task + connection loss + safe recovery/no duplicate native nodes | **UNVERIFIED**                                                                 | No task was run against a disposable Figma file; native canvas effects were not exercised.          |
| Settings/More navigation during Chat task and Chat appearance           | **UNVERIFIED visually**; source, route and snapshot regressions pass           | No screenshot-capable Desktop session.                                                              |
| 440×720 and expanded panel, scroll, Persian RTL                         | **UNVERIFIED live**                                                            | Source constraints and isolated wrapping are checked; host rendering/glyph layout was not captured. |
| Incomplete native verification never appears successful                 | Existing Phase 5/6 fail-closed tests retained and run; **UNVERIFIED live**     | This phase did not run a native Desktop mutation/verification.                                      |

## Remaining limitations and Phase 9 handoff

- Desktop and authenticated-provider acceptance are still required before release readiness. Use a disposable Figma test file and actual provider-visible model IDs; verify the task's stored model ID against actual Companion inference logs with sensitive fields sanitized. Never test on the original Charm canvas.
- Phase 6.9 gates remain open: `LIVE-1`, `SCALE-1`, `DESIGN-1`, `DESIGN-2`, and `REG-1`. Phase 8 does not close live visual/native acceptance, 100–400-screen render limits, photo provider/provenance, aesthetic/Persian shaping review, or Phase 5.9.5 live targeting/recovery.
- Model preference storage is versioned and validated, but Figma `clientStorage` does not expose a multi-key atomic transaction. The archive-before-replacement sequence is fail-closed and retryable; a crash after archive write but before preference write can leave a harmless duplicate archived value on the next explicit attempt.
- Provider token renewal remains exactly the existing Companion capability; no new refresh/auth flow or API-key fallback was added. If current provider authorization expires, Settings directs the user through the existing sign-in route.
- No Brand Kit or Design Skills implementation is included. Phase 9 engineering may proceed from this source state, with its own audit and explicit preservation of the still-open release gates.

**Verdict:** Phase 8 model/connection engineering is implemented; functional tests, typecheck, lint, build, Companion compilation, registered-artifact verification, and targeted formatting of clean files pass. Conditional GO for Phase 9 engineering. The inherited repository-wide formatting failures are recorded above. This is **not release-ready** until live Desktop and authenticated-provider acceptance pass. Chat source/style preservation is proven by static/snapshot guards; pixel-level visual equivalence remains unverified.
