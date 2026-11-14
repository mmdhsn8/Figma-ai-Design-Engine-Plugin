# Phase 9 — Brand Kit Manager

## Baseline gap register and integration plan

### Registered checkout and existing contracts

- Registered checkout: `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated`.
- `manifest.json` points to `dist/plugin.js` and `dist/ui.html`. The Companion is compiled by `tsconfig.companion.json` to `dist-companion/companion/main.js`.
- Navigation already exposes `brand-kit` and `brand-kit-create`; both currently render the Phase A unavailable placeholder in `src/ui/workspace-detail-view.tsx`. Chat is rendered in a separate branch in `src/ui/App.tsx`, and `tests/ui.test.tsx` snapshots the approved Chat markup and checks the stylesheet prefix.
- AI Chat tasks use strict `ChatTaskSchema` v1 checkpoints in document/page-scoped Figma `clientStorage` (`fad.chat-task.v2:<document>:<chat>`). The task already pins its model; old task records omit `model` and remain supported. The model is applied before the first task save and remains pinned on resume.
- The structured generator builds `DesignGenerationRequest` → `DesignPlan`/`DesignBrief` → generated screen sections → `VisualDesignSpec`/multi-screen spec → Figma native renderer and verification. `DraftManifestSchema` v1 pins the model and request, and saved screen/section checkpoints are held by the existing local Companion draft store. The native renderer already resolves semantic design-system tokens, handles font fallback, and accepts validated local visual assets.
- History is separate from task checkpoints. Phase 7 preserves malformed entries in a bounded versioned sidecar before writes; Phase 9 must not rewrite or share its keys.
- Figma documents a 5 MiB aggregate `clientStorage` quota and JSON-size accounting for values (with `Uint8Array` counted by byte length). Brand metadata therefore needs strict bounds, while binary assets must use separate bounded records. [Figma clientStorage](https://developers.figma.com/docs/plugins/api/figma-clientStorage/)

### Gaps before implementation

| Area                 | Current contract                                                                                                          | Phase 9 gap                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Brand management     | Unavailable route placeholder; no Brand Kit records or brand store                                                        | Versioned identity/tokens/revisions, safe CRUD, import/export, asset metadata, integrity recovery, and an editor/preview are absent    |
| New-task selection   | Chat task and structured generation have separate task contracts                                                          | No default brand or immutable brand-revision pin on either task type                                                                   |
| Native generation    | Structured generator creates a visual brief/spec and semantic color design-system; Chat tasks plan native tool operations | Brand typography/spacing/effects/direction/assets are not inputs to either generation contract; brand values are not pinned for resume |
| Persistence/security | Figma `clientStorage` bridges already handle tasks, History, and model preference                                         | No Brand Kit storage adapter, revision conflict handling, sidecar, safe asset boundary, or future-version preservation                 |
| Navigation/Chat      | Brand Kit route is in More; Chat source/style regression baselines exist                                                  | Replace only Brand Kit routes; keep Chat JSX and `.chat-*` CSS unchanged and retain the baseline assertions                            |

### Integration plan

1. Add strict versioned Brand Kit schemas, semantic token resolution, theme inheritance, contrast helpers, asset/file bounds, and a stable revision hash.
2. Add a loss-preserving `clientStorage` adapter using independent index, immutable revision, asset, and damaged-record sidecar keys. Write immutable records before publishing index references; reject stale revisions and fail closed when archival or quota writes fail.
3. Replace the two Brand Kit placeholder routes with a Persian-first RTL editor/list/preview surface, safe import/export and local logo handling. Add a default-brand selector for future tasks and show task-pinned revisions read-only.
4. Pin a resolved brand snapshot and stable ID/revision in new Chat checkpoints and structured-generation draft manifests. Preserve existing brandless/legacy tasks. Apply token precedence at the planning/spec boundary and resolve semantic values before native rendering.
5. Add focused schema, store recovery, asset validation, revision pinning, token resolution, Chat preservation, and generated-spec regressions. Run the repository scripts and rebuild only the registered plugin/Companion outputs.

## Implementation record

### Delivery summary

Phase 9 adds a Persian-first Brand Kit Manager and connects immutable brand snapshots to Chat tasks and structured design generation. Existing brandless task checkpoints remain valid. New tasks pin the selected default brand revision and safe asset metadata; resuming a task continues using that exact snapshot even if the default changes later.

The manager provides search/sort, default selection, create/edit/duplicate/archive/restore, import/export, theme editing, contrast feedback, preview, and safe local asset handling. The editor exposes semantic palette roles, typography roles and font fallback identity, spacing, radii, strokes, shadows, grid, density, component defaults, and themes. Explicit task color and reading-direction constraints take precedence over the pinned brand values; brand values take precedence over domain defaults and generic fallbacks.

### Architecture and changed files

| Area                           | Implementation                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain contract                | `src/shared/brand-kit.ts` defines the strict v1 schema, semantic tokens, immutable revision snapshots, themes, asset provenance/rights/hash metadata, token precedence, reading-direction resolution, and color contrast helpers.                                                                                                                 |
| Persistence                    | `src/plugin/brand-kit-storage.ts` uses a separately prefixed Figma `clientStorage` index, immutable revision records, asset records, and a bounded recovery sidecar. `src/plugin/main.ts` and `src/shared/messages.ts` register the typed bridge.                                                                                                 |
| Manager UI                     | `src/ui/brand-kit-bridge.ts`, `src/ui/brand-kit-manager.tsx`, `src/ui/App.tsx`, `src/ui/workspace-detail-view.tsx`, and `src/ui/styles.css` replace the Brand Kit placeholders with the RTL management and preview flow. Chat markup and `.chat-*` style baselines remain covered by regression tests.                                            |
| Chat task pinning              | `src/shared/chat-task.ts`, `src/shared/chat-tools.ts`, and `src/ui/chat-task.ts` preserve the pinned revision in task context, apply brand tokens to the design brief, and retain task prompt color/direction overrides.                                                                                                                          |
| Structured generation          | `src/shared/design-generation.ts`, `src/shared/generation-draft.ts`, `src/shared/visual-design-spec.ts`, `src/shared/schema.ts`, `src/shared/visual-schema.ts`, and `src/shared/native-visual-quality.ts` carry the immutable pin through plans and resume, resolve semantic tokens into visual specs, and retain provenance for token conflicts. |
| Native render and verification | `src/ui/design-generation.ts`, `src/plugin/generation-controller.ts`, `src/plugin/renderer.ts`, and `src/plugin/native-design-verification.ts` apply palette, typography, spacing, radii, effects, grid values, and validated local logo assets, then verify their semantic values in the native renderer contract.                               |
| Companion draft restore        | `src/companion/draft-store.ts` and `src/companion/server.ts` preserve and return the pinned draft snapshot. `src/ui/companion-client.ts` uses the required `.js` import path for the compiled Companion TypeScript project.                                                                                                                       |
| Regressions                    | `tests/brand-kit.test.ts`, `tests/renderer.test.ts`, and `tests/ui.test.tsx` cover schema/store recovery, future-version read-only behavior, asset bounds, task pinning, RTL/English rendering, native token application, Chat markup/style baselines, and Brand Kit states.                                                                      |

### Storage, recovery, and safety boundaries

- Brand records are isolated under the Brand Kit storage prefix. Existing Chat task, History, model-preference, and Companion draft keys are not migrated or reused.
- Writes create immutable revision and asset records before publishing the new index. Stale revision conflicts are rejected. Damaged records are preserved in the bounded recovery sidecar before replacement; if preservation or quota checks fail, the write fails closed.
- A future schema version is preserved and shown read-only. The manager does not overwrite an unreadable future-version record.
- Bounds are 100 brands, 8 assets per brand, 256 KiB per asset, 1 MiB total assets per brand, and a 1 MiB recovery sidecar. These limits leave headroom under Figma's documented 5 MiB aggregate `clientStorage` quota.
- Local image/SVG data is validated and normalized before use. The stored FNV-1a 32-bit content hash detects accidental mismatch only; it is not a cryptographic integrity or authenticity proof. The rights note is user-supplied/self-attested, local storage is not encrypted, and no remote asset/font provider is included.

### Verification and registered artifacts

| Check                                   | Result                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=8`            | Passed: 32 files, 532 tests.                                                                                                                                                                             |
| `npm run typecheck`                     | Passed.                                                                                                                                                                                                  |
| `npm run lint`                          | Passed with `--max-warnings=0`.                                                                                                                                                                          |
| `npx tsc -p tsconfig.companion.json`    | Passed.                                                                                                                                                                                                  |
| `npm run build`                         | Passed; produced the registered plugin/UI and Companion output.                                                                                                                                          |
| `npm run verify:phase5`                 | Passed: `manifest.json` registration and current plugin/UI/Companion entrypoints verified; compiled Companion booted on ephemeral loopback. No OAuth or Desktop acceptance was performed by this script. |
| Focused Prettier check of Phase 9 files | Passed after excluding five touched legacy-layout files: `src/shared/messages.ts`, `src/ui/App.tsx`, `src/ui/companion-client.ts`, `src/shared/chat-task.ts`, and `src/shared/chat-tools.ts`.            |
| `npm run format:check`                  | Still fails on 106 repository files with legacy formatting violations. Those files were left unformatted to avoid unrelated churn.                                                                       |
| `git diff --check`                      | Passed; Git emitted only working-tree LF/CRLF conversion notices.                                                                                                                                        |

The registered manifest is `manifest.json` → `dist/plugin.js` and `dist/ui.html`. Build output recorded on 2026-11-14:

| Artifact                             |     Bytes | SHA-256                                                            |
| ------------------------------------ | --------: | ------------------------------------------------------------------ |
| `manifest.json`                      |       325 | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |
| `dist/plugin.js`                     | 1,736,384 | `9AB1D101C33B40D4D49D9078CC7AF7205BFA251DA3E905FD6FBCF7A5DD390526` |
| `dist/ui.html`                       | 1,267,647 | `91B12266DC100F874A9F65A262F7DB92FA8B7573A6054E9D71865D3C889A2698` |
| `dist-companion/companion/main.js`   |     2,563 | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` |
| `dist-companion/companion/server.js` |   165,371 | `A28CAA5BD5951555C7B5C86A2AEE5B1371969A1D57D21E336DC4348E9C68A347` |

### Mock and live acceptance matrix

| Scenario                                                                                                          | Evidence                                                                                                                                                                            | Status                               |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Persian commerce and English dashboard                                                                            | Renderer and UI fixtures cover both language/direction paths with pinned Brand Kit tokens.                                                                                          | Mock-tested.                         |
| Native token application                                                                                          | Mock native nodes verify semantic colors, font family/style, stroke, radius, shadow, spacing, and responsive grid values.                                                           | Mock-tested.                         |
| 100-screen rendering fixture                                                                                      | 100 roots / 300 nodes, 52.4 ms, sampled heap delta 1,560,368 bytes in the latest local mock run. The test also enforces a 5 s render ceiling and 64 MiB sampled heap-delta ceiling. | Mock-tested; not a native Figma SLA. |
| 10-screen visual demo fixture                                                                                     | 10 roots / 325 nodes, 56.8 ms, sampled heap delta 15,625,304 bytes in the latest local mock run.                                                                                    | Mock-tested; not a native Figma SLA. |
| 400-screen bounded planning                                                                                       | Existing `tests/design-generation.test.ts` plans 400 mobile screens and 400 responsive counterparts. This tests planning only, not rendering those screens.                         | Existing planner test.               |
| Figma Desktop canvas render and visible-background selection                                                      | The open file was `Test Shop — Phase 1 Storefront`; it was not confirmed to be a disposable target. No canvas or `clientStorage` mutation was made.                                 | Unverified.                          |
| Live Chat behavior, UI pixel equivalence, host font availability, and persisted clientStorage recovery in Desktop | No disposable Desktop document was available for acceptance.                                                                                                                        | Unverified.                          |
| Real model/provider inference and remote asset/font delivery                                                      | Automated checks use local mocks and do not call a model provider or remote asset service.                                                                                          | Unverified/not implemented.          |

### Engineering verdict and inherited gates

**Phase 9 engineering implementation: complete. Live/release acceptance: partial.** Automated checks and the registered build pass. Desktop rendering, visible-background selection, Chat pixel/behavior acceptance, real-provider inference, and persisted-clientStorage recovery remain unverified, so this does not claim production or release readiness.

**Phase 10: conditional go for engineering work; no-go for release acceptance until inherited gates are closed.** Carry forward Phase 6.9 gates `LIVE-1`, `SCALE-1`, `DESIGN-1`, `DESIGN-2`, and `REG-1`; the 400-screen planner test does not close the live scale gate. Keep Phase 5.9.5's separate ledger and its live visible-background selection, edit-plan reference, and Stage 2 recovery requirements open. Phase 7/8 live Desktop, account/auth, model selection, and inference gates also remain open. No claim is made that this implementation closes those gates.

No commit or push was created. The pre-existing Figma document and its `clientStorage` were not touched.
