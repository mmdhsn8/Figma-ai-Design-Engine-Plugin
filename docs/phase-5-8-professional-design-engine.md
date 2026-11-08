# Phase 5.8 — Professional Visual Design Engine

## Evidence-based starting point

The user-reported live baseline is a Persian 390×844 fashion storefront with **4/4 stages and 23 confirmed native operations**. The reported visual issues are weak hierarchy, plain cards, excess whitespace, limited styling, and no rich product imagery. The run's screenshot and operation ledger are not present in this repository, so the count and appearance remain user-reported; the deterministic proxy in `tests/professional-design-fixtures.ts` is explicitly synthetic and is not claimed as a reconstruction of the screenshot.

Repository evidence from the tool schemas and renderer:

| Capability             | Existing JSON / Design System path                                             | Conversational native tools at baseline                                                                              |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Fill / stroke / radius | solid and gradient fills, stroke alignment/dashes, per-corner radius           | solid fill, limited creation stroke and uniform radius; no opacity, shadow or style on create                        |
| Effects                | drop/inner shadow and layer/background blur                                    | no chat effect field                                                                                                 |
| Typography             | family/style, size, line height, letter spacing, decoration, alignment, resize | creation has font and size; updates omit font family/style, line height, letter spacing and resize                   |
| Layout                 | nested Auto Layout and FILL/HUG normalization                                  | basic nested Auto Layout, padding, gaps, alignment and direct-child sizing                                           |
| Reuse and tokens       | native Design System components/instances and local styles in JSON renderer    | no conversational component/instance action; an existing paint style can be applied by ID only after creation        |
| Images / icons         | authorized embedded assets and bounded vector paths in JSON renderer           | no chat image, vector, or icon action; arbitrary URLs/code are not permitted                                         |
| Quality review         | JSON preflight diagnostics                                                     | inspection is model-requested; summaries omit absolute bounds and styles; no automatic per-stage structural review   |
| Planning               | generic identity / primary / supporting JSON section prompts                   | model returns only stage-name strings; no typed design brief, logical-ref targets, or measurable completion criteria |

The existing `phase-2-storefront.json` is a richer Persian **JSON renderer sample**, not the reported Phase 5.7 chat output. It demonstrates a polished-path capability gap rather than proving chat quality. `phase-4.5-visual-design.json`, `visual-ltr-fixture.json`, `src/plugin/visual-rendering.ts`, `src/plugin/design-system/style-registry.ts`, and `component-registry.ts` also show that native visual styles and owned component recipes already exist in the non-chat workflow. Figma API typings confirm native text line-height, letter-spacing, alignment, resize, effects, opacity, and corner radii are available. The Plugin API has no text-direction setter in the installed typings: chat's `direction: RTL` is a safe alignment hint, not a guarantee of bidirectional shaping.

## Deterministic baseline and acceptance criteria

`tests/native-visual-quality.test.ts` evaluates a synthetic 23-node Persian mobile proxy (390×844), a Persian desktop fixture (1440×900), and an English LTR mobile fixture. It checks actual refs/sections, geometry, empty text, clipping, Auto Layout overlap, measurable contrast, viewport dimensions, at least two consistently styled product cards, a 24px+ title with a distinct scale, 44px+ purchase targets, labeled non-photo fallbacks, and content coverage/gaps. It reports findings rather than a subjective overall score.

The synthetic proxy is marked with the user-reported 23 operation / four stage metadata, has 23 fixture nodes, and intentionally fails the hero, hierarchy, card, target-size, and spacing criteria. The three target fixtures pass. These are deterministic unit fixtures—not screenshots, model output, or Desktop evidence. The test runs against mock node geometry and cannot evaluate optical balance, actual Persian font shaping, or visual appeal.

## Design safeguards and API limits

- Maintain authenticated model selection, document/page-scoped checkpoints, strict typed allowlists, operation IDs, idempotency, executor bounds, sequential commits, and user-owned canvas content.
- Existing document color/text styles take precedence when explicitly selected; use local styles/tokens rather than silently changing them. If no user palette/system is selected, use a small fashion-appropriate palette and consistent spacing/radii.
- Use 2-column mobile product cards and a centered max-width multi-column desktop grid; do not stretch mobile content across desktop.
- With no authorized product asset, render an editable native illustration or calm image-region fallback and label it clearly as **not a real product photo**. Do not claim that chat has image, icon, or vector creation unless a real allowlisted action is added and tested.
- Keep fallback fonts honest: report the selected font when the requested family/style is unavailable. Native alignment and Unicode text do not establish full RTL shaping support.
- Design System master creation/instance reuse is available only through the existing JSON path. Conversational recipes should remain composed, editable frames and nodes unless a safe, provenance-aware native component action is separately justified.

## Validation and live acceptance

Automated tests can verify schemas, plan bounds, tool behavior, geometry checks, and task replay, but cannot establish a professional appearance. No Figma Desktop screenshot, Layers-panel inspection, authenticated live-model result, font-shaping check, or real latency measurement is included in this evidence. **Visual acceptance remains UNVERIFIED.**

Automated verification completed on 2026-11-05:

- `npm test` — 309 tests passed.
- `npm run typecheck` and `npx tsc -p tsconfig.companion.json --noEmit` — passed.
- `npm run lint` and `npm run format:check` — passed.
- `npm run build` and companion TypeScript emit — passed.
- `npm run verify:phase5` — passed for compiled plugin/UI/companion entrypoints and local health startup; it explicitly performs no OAuth or Figma Desktop acceptance.

Manual acceptance checklist:

1. Restart the companion and reload the current development plugin in Figma Desktop; keep the current authenticated model and its normal selection.
2. Send once: «یک صفحه موبایل ۳۹۰×۸۴۴ برای فروشگاه لباس فارسی طراحی کن؛ هدر، جست‌وجو، دسته‌بندی‌ها، بنر جذاب، دو کارت محصول با نام و قیمت تومان و دکمه خرید داشته باشه. طراحی حرفه‌ای و مدرن باشه.»
3. Watch progressive stage commits. Inspect the Layers panel for editable native nodes, correct 390×844 frame, Persian text, typography fallback message, image-fallback disclosure, and no overflow/overlap or unexplained blank blocks. Compare a screenshot with the user-provided baseline if available.
4. Send: «رنگ دکمه‌های خرید را صورتی کن و فاصله کارت‌ها را کمتر کن؛ بقیه صفحه را تغییر نده.» Confirm only those existing nodes change and no cards or frames are duplicated.
5. Request a desktop adaptation; verify a centered, responsive multi-column layout and no movement of existing content.
6. Stop mid-stage, reload, Resume/Retry, and replay an operation. Confirm committed nodes remain and no duplicates appear. Test unavailable font and absent authorized product image; inspect truthful fallback messaging.

Record actual Desktop screenshots and elapsed time before calling the work production-ready. Do not substitute these scripted fixtures for that acceptance.

## Logical-reference collision hotfix

### Root cause established from code

`runChatTask` previously sent the model's creation refs directly to `createFigmaToolExecutor`. The executor's `fad.figma-tools.v1:<file>:<page>` registry outlives the separate `fad.chat-task.v1:<document-page>` checkpoint. Its creation guard rejected any existing `state.refs[ref]`, whereas idempotency recognized only an identical operation ID/key and fingerprint. Consequently a second task using `store`/`header`, or the same task issuing a new call ID for an already-created alias, hit a page-wide reservation. A stale/deleted node also remained reserved. Inspection did not namespace model-created aliases, and context did not list registered refs. The screenshot does not identify which saved operation owns the particular live `store`; that provenance remains unverified.

### Fix and safety boundaries

- New chat checkpoints opt into `referenceScope: task-v1`. The trusted operation envelope carries the checkpoint task ID, not a model-supplied task ID. Creation aliases map deterministically to bounded `task-<fingerprint>` refs; registry entries persist task ownership, the alias, native node ID, and original creation operation ID. Hash collisions or inconsistent metadata fail closed rather than sharing a node.
- Every reference-bearing action, child rule, inspection, parent, and QA operation uses the same mapping. Results expose canonical refs; checkpoint summaries retain them for subsequent messages. Context provides a bounded registry listing marked as requiring inspection. A different task must inspect an explicit existing ref (or selection) before editing it.
- Repeated creation reuses only a uniquely resolved, same-task node whose original completed executor operation, node tags, type and parent agree. It does not apply the repeated call's styling; results explicitly instruct the model to use `set_properties`. Reuse is not counted as a new canvas commit.
- The chat ledger supplies the original creation ID when a confirmed alias is requested again. Missing registry evidence is then a checkpoint conflict, not permission to recreate. Legacy task refs and in-flight IDs are not renamed; legacy reuse requires a matching confirmed same-task creation ID from that ledger.
- Deleted/stale refs, ambiguous copied tags, mismatched ownership, unconfirmed creation operations, and missing registry evidence return structured `referenceResolution` details with inspection/status alternatives. Two automatic reference-correction turns are permitted; unresolved operations still block stage completion. Reservation checks, fingerprints, page checks, write-ahead persistence, safety budgets, and editable native creation remain active.

Regression coverage includes two `store`/`header` tasks on one page, same-task reuse after executor reload, inspected follow-up edits without duplication, legacy collisions and verified reuse, missing checkpoints/registry evidence, deleted and ambiguous refs, interrupted creation recovery with the original ID, scoped task retries, and progressive scoped stage QA after a lost acknowledgement. These are deterministic tests, not the actual Desktop run.

Hotfix verification on 2026-11-05: **320 tests passed** across 26 files; UI/plugin and companion typechecks, lint, formatting, plugin/UI build, companion emit, and `verify:phase5` passed. The build verification checks local compiled entrypoints and health startup only.

**Authenticated Figma Desktop acceptance: UNVERIFIED.** Restart the companion and reload the development plugin. On one page, run the Persian storefront request, then a second new storefront request, then select/inspect the original header and request a targeted edit. Confirm distinct editable storefronts, no duplicate headers on repeat creation, original-node follow-up edits, and stable Stop/Resume/Retry behavior. Capture the structured resolution code and operation ID if any inspection-required failure remains; do not send prompts or raw payloads in diagnostics.
