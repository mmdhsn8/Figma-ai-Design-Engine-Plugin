# Autonomous end-to-end debug report

## Scope and safety boundary

The registered checkout is `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated`; `manifest.json` points to `dist/plugin.js` and `dist/ui.html`. The repository was clean on `main` at `7a2261e` before this work. No branch, commit, or remote operation was performed.

The supplied screenshot shows the valuable `Test Shop — Phase 1 Storefront` Figma file open. No Figma canvas mutation, provider call, or live acceptance attempt was made. Tests use the production task runner and plugin executor with the repository’s Figma API mock. The existing document and its checkpoints were not changed.

## Causal analysis

The failure was produced by multiple independent geometry defects:

1. The model created a page-root mobile screen at 390×201 although the task described a 390px-class mobile screen. Its vertical Auto Layout flow required about 835–871px. The creation schema accepted the dimensions without comparing them with the saved mobile viewport.
2. The nested frame was 350px wide with 20px left and right padding, leaving 310px for content. Task-owned children were 310–330px wide. The repairer only attempted vertical HUG sizing and treated cross-axis overflow as unsupported.
3. A confirmed `set_auto_layout(repairOverflow=true)` mutation was counted even though fresh geometry was unchanged. The next identical action was correctly prevented as a replay, but no alternate supported strategy existed.
4. The verifier correctly reported clipped geometry. It could not distinguish intentional vertical viewport scrolling from accidental clipping because the tool and native snapshot did not retain Figma’s `overflowDirection` property.

The 390×201 root was therefore invalid model output accepted at the source; the cross-axis failure was a repair-engine limitation. The native verifier was not the source of the reported error.

## Changes

- `src/ui/chat-task.ts`: before dispatch, reject the first planned page-root screen frame for a saved mobile create stage when its width is in the mobile range (320–500px) and its dimensions differ from the exact planned viewport. Also reject later `set_properties` dimension changes or AUTO sizing that would alter that viewport. The whole batch is rejected before native mutation; the bounded correction count is checkpointed. Other page-level frames remain available for components and content.
- `src/shared/figma-tools.ts`, `src/shared/chat-tools.ts`, `src/plugin/figma-tool-executor.ts`, `src/plugin/native-design-verification.ts`, `src/shared/native-visual-quality.ts`, and `src/shared/messages.ts`: expose, persist, and read back Figma `overflowDirection`.
- `src/shared/native-visual-quality.ts`: allow clipping only along the explicitly configured scroll axis. A vertically scrollable frame still reports horizontal overflow.
- `src/plugin/auto-layout-repair.ts`: for current task-owned vertical Auto Layout, fill oversized direct children to the available cross-axis width when the parent is fixed on that axis; then HUG the parent’s vertical content when safe. Text is eligible only when native text sizing can preserve its content. The fixed viewport remains unchanged, and the repair requires fresh native readback.
- `tests/native-repair-recovery.test.ts` and `tests/native-visual-quality.test.ts`: add the 390×201 rejection, 330px-in-310px repair, explicit scroll-axis check, no-duplicate assertion, and three-stage integration reproducer.
- `package.json`: add `npm run qa:native-repair`.

No Chat JSX or `.chat-*` CSS was changed.

## Before and after evidence

Supplied incident: task `chat-1794653946739-aqb6ql`, stage 1 of 3; 27 confirmed mutations, 24 confirmed nodes, 3 verification attempts, 4 clipped-child findings, 2 repair attempts, only 1 executed, and 0 findings resolved. The sanitized diagnostic showed a 390×201 root, a 350×145 body with 20px padding, and 330px content against 310px available width. `op-30` changed no measured geometry; `op-32` was a prevented idempotent replay.

Deterministic end-to-end fixture after the fix: the invalid 390×201 root was rejected before dispatch, and a later attempt to change the corrected root to 201px with `set_properties` was also rejected. The corrected 390×844 root was marked for vertical scrolling; the 330px task-owned child filled the 310px content width, and its parent grew from 145px to 875px using native HUG semantics. The 844px viewport stayed fixed. The test drove real `runChatTask`, `FigmaToolExecutor`, verification, repair scheduling, checkpointing, and stage progression. All three stages completed with complete QA coverage and zero findings; five native mock nodes were created, one repair mutation was executed, and no duplicate nodes appeared.

These are integration-harness results, not Figma Desktop evidence. A mock models the documented property effects for FILL and HUG; it cannot prove Desktop’s actual reflow or rendered appearance.

## Verification status

Final verification passed: `npm run qa:native-repair` (13 tests), `npm test` (585 tests across 34 files), `npm run typecheck`, `npm run lint`, Companion TypeScript compilation, `npm run build`, `npm run verify:phase5`, and `git diff --check`. `verify:phase5` confirmed the registered manifest and booted the compiled Companion on an ephemeral loopback; it did not perform Figma Desktop acceptance.

Live Figma acceptance is **BLOCKED** because the only visible document is the protected Test Shop file and no disposable document was approved. No real Figma frame was generated. Production readiness is **NO-GO** until the same scenario is verified in an explicitly approved disposable Figma document and the remaining acceptance scenarios are run.
