# Phase 4 — Composition Contract

## Contract shape

`src/shared/design-composition.ts` defines two strict, bounded Zod schemas:

- `ProjectVisualLanguageV1`: project identity; semantic page/surface/text/primary/accent/border colors; heading/body fonts and display/title/body/caption sizes; ordered spacing scale; compact/control/surface radii; color mode; density; navigation model; and a short rationale.
- `ScreenCompositionV1`: a chosen archetype, decision trace, stable deterministic task/screen variation seed, focus node, responsive intent, 1–6 semantic regions referencing native container IDs, up to 12 planned entity refs, and up to 8 approved Brand Kit asset IDs.

The archetype vocabulary is generic: editorial, data-dense, task-focused, form-first, catalog-list, detail-reading, multi-panel, creative-asymmetric and custom. No domain name or fixture phrase is encoded in the production contract.

## Versioning and compatibility

`DesignProgramV1Schema` remains program version 1. The two composition properties are optional there, so previously saved version-1 programs continue to parse. `UniversalDesignProgramV1Schema`, used for new Universal compose calls, requires a project visual language and per-screen composition. The plan schema accepts the visual language optionally, and old plans without it receive a deterministic bounded default when resumed. This does not add a competing checkpoint store or change task IDs.

## Bounds and validation

The existing program bounds remain: 1–10 screens, 300 nodes, depth 8, 100 children per container, and bounded labels. New universal composition regions must map to existing editable containers, their roles must agree, the focus and region IDs must exist, the saved entity refs must be used, and declared asset use must agree with image nodes. Fixed-axis child sizing is checked before rendering; interactive nodes under 44×44 are rejected by the design-program boundary.

Asset validation is capability-based. Only asset IDs in the task-pinned Brand Kit revision are accepted. URL fields and arbitrary remote assets are rejected by the strict schema. Existing component/variable references remain subject to the existing verification and authorization checks; this phase does not introduce an executable code path.

## Trust and side effects

Provider output is parsed before use. Screen composition references are checked against the editable node tree and saved plan. The renderer receives only task-selected, locally stored assets whose content hash is revalidated. Asset bundle size is capped at 700 KiB and resolver failures return bounded error codes. There are no external asset fetches, user-file scans, model-generated JavaScript execution, or changes to the provider/network allowlist.
