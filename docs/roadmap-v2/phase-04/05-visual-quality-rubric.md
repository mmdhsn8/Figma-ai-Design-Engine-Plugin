# Phase 4 — Visual Quality Rubric

Two kinds of evidence stay separate: deterministic preflight is automated; aesthetic fit is a human judgment.

## Automated checks implemented or reused

- The compose request must cover the current planned regions, roles, entities and shared project language. Early screens with different roles are checked for repeated topology. Content must contain meaningful text; there is no fixed minimum node/text count.
- The DesignProgram parser checks region/container references and role agreement, asset declarations, bounded node structure, fixed-axis feasibility and 44×44 minimum interactive dimensions.
- Existing `auditVisualQuality` diagnostics include ordinary-text contrast below 4.5:1, interactive targets below 44×44, and overflow-risk heuristics. The Universal task routes contrast, overflow and small-target warnings into its bounded correction findings. The existing native readback and failure handling remain in force.
- The viewport presets are fixed at mobile 390×844 or desktop 1440×900. Vertical scrolling is represented in the task/render contract and checked for clipping/vertical overflow on the returned root.
- Assets are checked for pinned revision membership and hash integrity; missing assets remain disclosed placeholders.

These are partial objective checks. Text overflow includes a length heuristic; fixed-axis preflight does not model every Figma host transformation or font metric. The test mock is not evidence of exact Desktop geometry.

## Preregistered human review rubric

Rate each dimension 1–5 on actual 100% Desktop views, then review the set overall:

1. Brief/domain fit and meaningful content.
2. Visual hierarchy and scan path.
3. Composition balance, density and whitespace discipline.
4. Typography and legibility, including Persian RTL and English LTR.
5. Color, imagery/illustration and brand coherence.
6. Screen-role distinction with cross-screen consistency.
7. Professional polish and real-product suitability.
8. Native editability, asset honesty, usability and accessibility.

The Phase 4 target is median ≥4/5 across reviewed screens, no critical category below 3/5, no blocking structural QA, and no unresolved placeholder represented as real photography. This is a human acceptance target, never an algorithm-generated score.

## Current result

No human reviewer inspected Figma Desktop screenshots or layer trees in this run. Human scores are **NOT MEASURED** and visual acceptance is **PENDING**. Passing automated tests cannot satisfy the human threshold.
