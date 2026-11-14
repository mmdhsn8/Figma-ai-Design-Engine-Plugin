# Phase 10 — Professional Design Skills Manager

## Baseline audit and gap register

### Registered checkout and existing contracts

- Registered checkout: `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated`; `manifest.json` points at `dist/plugin.js` and `dist/ui.html`. The Companion uses `tsconfig.companion.json`.
- The `skills`, `skill-detail`, and `skill-add` routes exist in `src/ui/workspace-routes.ts` and More navigation, but `src/ui/workspace-detail-view.tsx` deliberately renders unavailable placeholders. `MoreMenu` currently marks Skills as future work.
- Chat's approved markup is snapshotted in `tests/__snapshots__/ui.test.tsx.snap`; Chat and `.chat-*` CSS are frozen by UI regressions. New controls must be on the existing non-Chat Skills/More routes.
- Chat creation in `src/ui/App.tsx` pins the selected model and Brand Kit before saving the task. `ChatTaskSchema` is strict and legacy tasks omit the optional Brand Kit pin. `chatTaskInput` in `src/ui/chat-task.ts` supplies the model with a compact serialized task checkpoint.
- Structured generation flows through `DesignGenerationRequest` → `createDesignPlan`/`DesignBrief` → Companion `/v1/design` → generated sections → `VisualDesignSpec` → native rendering/verification. `DraftManifest` pins model and Brand Kit; Companion draft recovery validates the manifest and resumes saved sections.
- Brand Kit uses an isolated `clientStorage` prefix, immutable per-revision records, bounded preservation, future-version read-only behavior, and revision pinning. Design Skills must use separate keys and preserve its immutable source snapshot in new task checkpoints.
- Existing tool whitelist, task preflight, native QA, progressive section checkpoints, and account-session fencing remain the enforcement boundary. Markdown must not be able to change those capabilities.

### Severity and implementation gaps

| Severity | Gap and source                                                                                                                                                             | Acceptance test                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | No Skill schema, versioning, Markdown bounds, safe frontmatter parser, immutable pin, or selection engine (`src/shared/*`).                                                | Strict parser, malicious/frontmatter/UTF-8/size tests; deterministic matching, conflict and precedence fixtures.                          |
| P0       | No independent Skill persistence, quota, revision conflict, recovery sidecar, or future-version behavior (`src/plugin/*`).                                                 | CRUD, import idempotency, immutable history, stale-write, interruption, corruption, sidecar-failure and quota tests.                      |
| P0       | Skills cannot influence either Chat planning or structured design/native checks (`src/ui/chat-task.ts`, `src/shared/design-generation.ts`, `src/ui/design-generation.ts`). | Before/after fixtures show required pattern/layout changes, Brand Kit precedence, task pins and native structural checks.                 |
| P1       | Existing Skills routes are placeholders and there is no safe Markdown preview/import/export/library workflow (`src/ui/workspace-detail-view.tsx`).                         | UI tests cover library, edit/import/export, enabled/default selection, accessibility, state/errors and isolated class names.              |
| P1       | No checkpoint pin/recovery behavior for active tasks; no tests for account/task isolation or retry behavior.                                                               | Chat/Draft schema compatibility and exact pinned snapshot survive updates, archive, disable, reload and resume.                           |
| P1       | No storage usage or capability disclosure; imported content could be mistaken for executable/trusted instructions.                                                         | UI makes source/trust/capability status visible; assert no `dangerouslySetInnerHTML`, eval, fetch-from-Markdown, or tool-escalation path. |

### Integration plan

1. Add a strict versioned Skill model with preserved Markdown source, bounded sanitized derived guidance, allowlisted structured pattern requirements, stable revisions, and deterministic selector.
2. Add a dedicated clientStorage namespace/index/revision store, safe import/export commands, revision checks, bounded recovery sidecar, quota accounting, and request-scoped UI bridge.
3. Replace only the non-Chat Skills routes with a Persian-first accessible manager; keep the approved Chat page JSX and Chat CSS unchanged.
4. Pin resolved Skill snapshots in new Chat tasks and structured draft manifests. Add bounded guidance at planner/spec boundaries; preserve model and Brand Kit pins independently and keep legacy tasks brand/skill-free.
5. Convert safe structured Skill requirements into existing pattern catalog checks and native assertions; user Markdown may not grant execution permissions or bypass any existing QA/tool gate.
6. Add parser/store/selection/task/integration/UI security regressions; run full checks and verify the registered build. Live Desktop/provider acceptance will remain explicitly unverified if no confirmed disposable file/session is available.

## Implementation record

### Delivered

- Added the versioned Skill model, bounded Markdown parser, derived guidance sanitizer, stable revision identity, prompt projection, and deterministic selector in `src/shared/design-skill.ts` and `src/shared/design-skill-selection.ts`. The source Markdown remains available for review and editing. Only bounded derived guidance and structured metadata can enter model requests. The content fingerprint detects accidental mismatch and supports deduplication; it is not an authenticity signature.
- Added the isolated `fad.design-skills.v1:*` storage namespace in `src/plugin/design-skill-storage.ts`. Revisions are immutable; updates create a new revision. Writes are serialized, stale revisions conflict, imports deduplicate, and archive/restore/remove preserve recovery history. Corrupt indexes recover from valid revision records; future versions become read-only. The recovery sidecar is capped at 1,000 entries / 512 KiB and fails closed at the cap. Skill storage has a separate 1.5 MiB budget; this accounts for the Skills namespace, not aggregate Figma `clientStorage` usage.
- Added request-correlated UI/plugin storage messages and a Persian-first RTL manager for library/detail/add routes. It supports local Markdown/bundle import, Markdown/bundle export, safe text preview, editing, duplication, immutable revision history/restore, search/filtering, enable/default controls, compatibility/conflict configuration, and visible trust/storage/error states. Imported material is unverified and disabled by default. Preview renders as text; Markdown does not execute.
- Added deterministic selection for explicit Chat mentions, defaults, and eligible domain suggestions, with locale/task/screen checks, a three-Skill limit, and surfaced incompatibilities. Resolved full revision snapshots are pinned to new tasks; changing, disabling, or archiving a library Skill does not mutate an existing task snapshot.
- Integrated pinned Skills into Chat planning and structured generation/native validation. Chat receives a bounded one-time JSON guidance context and compact revision/pattern provenance; the source Markdown is not sent. Structured generation receives bounded guidance and allowlisted required-pattern IDs. Native checks require those patterns to be present. Brand Kit tokens remain independently pinned and authoritative. Legacy Chat tasks and draft manifests can omit Skills.
- Kept Chat JSX and `.chat-*` styles unchanged; existing Chat snapshot regression passes. Skills manager styling is scoped to `.skills-*`; `MoreOptionsAccordion` was left untouched.

### Automated verification

| Check                                                          | Result                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=1`                                   | Pass — 33 files, 544 tests                                                                          |
| `npm run typecheck`                                            | Pass                                                                                                |
| `npm run lint`                                                 | Pass                                                                                                |
| `npm run build`                                                | Pass — UI and plugin bundles built                                                                  |
| `npx tsc -p tsconfig.companion.json`                           | Pass                                                                                                |
| `npm run verify:phase5`                                        | Pass — registered manifest path and compiled entrypoints checked; ephemeral Companion boot verified |
| `npx vitest run tests/design-skills.test.ts tests/ui.test.tsx` | Pass — 2 files, 27 tests                                                                            |
| `git diff --check`                                             | Pass — Git emitted only its configured LF/CRLF normalization warnings                               |

The first parallel full-suite run timed out two CPU-heavy pre-existing tests. Each timed-out test passed alone, then the complete suite passed with one worker; the recorded result above is the one-worker run. The registered Phase 5 verifier initially flagged `TextEncoder` in the plugin bundle. The Skill fingerprint was changed to deterministic UTF-8 byte iteration without browser globals, a fixed Persian/Unicode fingerprint regression was added, and the verifier then passed.

### Runtime acceptance and open gates

| Area                                                                                                                                                                          | Evidence                                                            | Status                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Skill parsing, bounds, trust handling, selector determinism/conflicts, storage revisions/recovery, snapshot pinning, structured required-pattern checks, Brand Kit precedence | `tests/design-skills.test.ts`                                       | Automated pass                                        |
| Existing Chat markup/layout snapshot                                                                                                                                          | `tests/ui.test.tsx`                                                 | Automated pass                                        |
| Registered plugin/UI build and Companion startup                                                                                                                              | `npm run verify:phase5`                                             | Automated pass; no OAuth/provider inference performed |
| Open Figma Desktop manager interactions, import/export, restart/reload, and legacy migration                                                                                  | Requires the Skills panel to be exercised in Desktop                | **UNVERIFIED**                                        |
| Chat planning with an authenticated provider and skill conflicts/selection                                                                                                    | Requires an authenticated provider session                          | **UNVERIFIED**                                        |
| Native generation, visible Figma rendering, and exact resume after interruption                                                                                               | Requires a confirmed disposable Figma document                      | **UNVERIFIED**                                        |
| Live multi-screen and 100–400 screen generation/performance                                                                                                                   | Requires a confirmed disposable Figma document and provider session | **UNVERIFIED**                                        |

No live Figma document was modified because the currently open document was not confirmed disposable. Automated evidence supports implementation readiness, but does not establish live Desktop, provider, or visual acceptance. The branch remains `main` with uncommitted local Phase 10 changes; nothing from this Phase 10 work has been committed or pushed to GitHub.
