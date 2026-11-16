# Phase 4 — Existing Composition Audit

## Baseline captured before implementation

- Checkout: `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated`
- Branch / commit: `main` / `b08a9deba9b40327fbb185a068d126ae0efee5db`
- Worktree: clean at baseline.
- Registered manifest: `manifest.json`, plugin ID `1574493506249715820`, `main: dist/plugin.js`, `ui: dist/ui.html`; Companion dev endpoint is loopback `http://localhost:1455`; no additional remote domains are allowed.
- Baseline tests: `npm test -- --maxWorkers=1` — 41 files and 699 tests passed.
- Registered manifest verifier: `npm run verify:phase5` passed and identified this checkout’s `manifest.json`. Its output explicitly does not claim OAuth or Desktop acceptance.

## Source-traced integration map

1. `src/ui/App.tsx` pins the selected model, engine route, Brand Kit and Skills to a `ChatTask`, then connects `renderProgram` and `inspectProgram` to `runChatTask`.
2. `src/ui/chat-task.ts` routes a new Universal create request to `src/ui/universal-design-task.ts`; the Legacy route remains separate. Existing task routing is stored on the task, so resumed tasks do not need to infer a new engine selection.
3. `src/ui/universal-design-task.ts` turns the plain-language request into a `ProjectPlanV1`, checkpoints it, asks for one `DesignProgramV1` for each planned screen, normalizes IDs/order/viewport, applies the task-pinned Brand Kit, validates, checkpoints a fingerprint, and calls the render bridge. Repair is bounded to one request.
4. Visual decisions currently arrive primarily through a free-form `visualIntent`, node tree, token map and screen purpose in `src/shared/design-program.ts`. The Phase 3 model instructions are assembled in `src/ui/universal-design-task.ts`; the authenticated Companion prompt and tool definitions are in `src/companion/server.ts` and `src/shared/chat-tools.ts`.
5. `src/shared/design-program-adapter.ts` maps the declarative tree to the existing `MultiScreenSpec`, resolves color tokens, preserves Auto Layout, maps text to font family/weight, and turns image requests into labeled placeholder frames. `src/plugin/design-program-spike.ts` routes that batch through `renderMultiScreenDesign` and task-owned native-reference registration.
6. `src/plugin/main.ts` is the Figma bridge handler. It verifies current page/document scope before calling the local renderer and returns a render result for UI-side readback. `src/ui/universal-design-task.ts` checks native root uniqueness, viewport/scroll, subtree count, supported editable node types and presence of text before the task is completed.
7. Pinned Brand Kit asset bytes already have a task-scoped storage seam in `src/plugin/brand-kit-storage.ts` (`resolvePinnedBrandVisualAssets`), but the Universal design-program render bridge did not pass that catalog into the compiler. The existing visual asset parsing and native image plumbing live in `src/shared/visual-assets.ts` and `src/plugin/renderer.ts`.

## Constraints evidenced in source

- `findingsForProgram` in `src/ui/universal-design-task.ts` rejects programs based on a fixed minimum node/text/role count. This can reject a legitimately sparse confirmation state without proving its content or task affordances are inadequate.
- The current compose instruction asks for at least three planned regions and placeholder assets. It does not request an auditable semantic layout choice, reusable per-project visual language, or distinguishable structures for screens with different purposes.
- `tests/universal-design-chat.test.ts` uses a fixed three-region tree builder across its domain cases. That proves routing and schema behavior for those fixtures, but not varied model-selected layouts or a held-out domain.
- `DesignProgramV1` parses only placeholder images in the current adapter path; non-placeholder assets are rejected even though the node schema has provenance fields for approved assets.
- Adapter-level visual quality findings are warnings attached to the compiled screen; the Universal task’s correction decision currently focuses on parse/compile errors. Native checks remain authoritative for the properties they read back.

These are implementation constraints, not a claim that a live model or actual Figma output was observed to fail for each reason. Live visual quality was not measured at baseline.

## Existing implementation reused

Phase 4 is constrained to the existing `ProjectPlanV1` → `DesignProgramV1` → `MultiScreenSpec` → native renderer and existing task/checkpoint/ownership system. Brand Kit pinning, asset hash validation, shared visual audits, native readback and the separate Legacy route are reused. This report is intentionally written before source changes; final reports record the resulting implementation and test evidence.
