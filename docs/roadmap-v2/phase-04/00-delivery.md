# Phase 4 — Delivery

**Status: CODE COMPLETE / LIVE PENDING**

Implemented the Phase 4 general composition path inside the existing Universal Chat → plan → `DesignProgramV1` → `MultiScreenSpec` → native renderer flow. The Universal Chat coordinator now persists a shared project visual language, asks for a semantic composition per screen, validates the editable program against that intent, applies the pinned Brand Kit and current Skills context, preflights composition/layout findings, and sends authorized local Brand Kit assets through the existing renderer.

## Delivered

- Added a bounded, versioned project visual-language and screen-composition contract in `src/shared/design-composition.ts`.
- Kept legacy `DesignProgramV1` parse compatibility while requiring both new composition fields for fresh Universal compose calls.
- Replaced the old fixed node/role/text minimum with content, semantic-region, role, entity-reference, topology, viewport, touch-target and actionable visual-preflight checks. A legitimate single-region confirmation screen is covered.
- Connected the shared color, typography, spacing and radius decisions to the existing native adapter; explicit prompt-level palette overrides remain ahead of Brand Kit defaults.
- Connected task-pinned, hash-verified local Brand Kit image assets to editable native image fills. Unavailable or unselected assets stay clearly labeled as placeholders or fail with bounded resolution errors.
- Preserved task-owned rendering and checkpoint boundaries. The universal screen identity is included in native logical references to prevent reuse collisions between programs.
- Added regression evidence for education, booking, SaaS analytics and an independently authored marine-archive brief through the same Universal Chat coordinator and local renderer harness.

## Evidence and limits

The local suite, typecheck, lint, build and registered-manifest verifier pass (details and hashes in [07-test-and-performance-evidence.md](07-test-and-performance-evidence.md)). No Figma Desktop session, live authenticated model request, screenshots, or human visual review were performed. Therefore there is no professional-aesthetic acceptance score and the product-quality claim remains pending.

Verified native output in this phase is limited to the existing renderer’s editable frames, text, rectangles, ellipses, vectors and image fills. The DesignProgram contract still has no first-class grid, chart, table, calendar, overlay, or component/instance node. See [09-phase-05-handoff.md](09-phase-05-handoff.md).

## Phase 5 decision

**GO for Phase 5’s scoped local native-layout and host-convergence work. NO-GO for release or a claim of live professional visual quality** until the approved disposable-file Desktop matrix and human rubric in [08-live-desktop-acceptance.md](08-live-desktop-acceptance.md) are completed.

No commit or push was made.
