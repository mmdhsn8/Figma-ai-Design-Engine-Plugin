# Phase 4 — Native and Recovery Regression Evidence

## Existing native path reused

Universal programs still compile to the existing `MultiScreenSpec`, pass through `renderDesignProgramLocal`/`renderMultiScreenDesign`, and use the existing native ownership, operation and readback path. The Phase 4 adapter emits editable native frames/containers, text, rectangles, ellipses, vectors and local image fills. It does not replace the renderer or add a second checkpoint database.

## Local regression evidence

- All existing tests passed in the full suite (41 files; 703 tests).
- The Universal chat tests cover same-task plan/program persistence before render, bounded semantic repair, refusing render after unresolved findings, ambiguous-render resume without duplicate root, an independently held-out domain, sparse confirmation, stable composition seed, shared language and verified pinned-image native fill.
- The DesignProgram mock tests cover RTL ordering, mobile vertical-scroll clipping, desktop width, nested mock geometry, task-scoped readback, one scoped heading edit, unchanged snapshots of other screens and replay with the same roots.
- Adapter reuse testing exposed and fixed a program-identity collision in content-wrapper logical refs; native references now include both program and screen identity.
- `tests/brand-kit.test.ts` checks selected/pinned asset resolution, stale or missing asset handling, Brand Kit persistence and token override behavior.
- Route compatibility/default preference, old feature-flag migration and persisted Universal/Legacy precedence remain covered by the Universal route regression suite; the Phase 4 diff does not modify engine selection, Settings UI, task routing, History, login or the Legacy renderer.

## Scope of evidence

These are scripted tests over the local Figma API mock. No protected Figma document was opened or changed, and no actual Desktop node tree/readback or visual screenshot was captured. They do not establish exact Figma Auto Layout geometry, installed-font behavior, cross-page placement behavior or runtime recovery against a live document.
