# Phase 4 → Phase 5 Handoff

## Verified current rendering contract

The adapter supports row/column Auto Layout and editable containers, text, rectangles, ellipses, vectors and image fills. Mobile and desktop plans use fixed 390×844 and 1440×900 viewport presets. Vertical overflow and clipping are represented in the existing renderer contract. Local mocks assert geometry for the current supported subset; Phase 4 fixed one adapter counter-axis conflict and made program-level root references unique across programs.

## Specific native convergence work still requiring evidence

- The DesignProgram language has no native grid node or first-class chart, table, calendar, overlay, component or instance reference. Data-heavy interfaces can currently be built from frames/text/basic shapes; they do not receive semantic host-native chart/table behavior.
- `responsiveIntent` is recorded as composition intent, but the current screen presets are fixed-size. Responsive adaptation across arbitrary widths is not proven.
- The mock does not reproduce Figma’s full Auto Layout, font metrics, image crop, transformed bounds or native rendering. Child geometry and text wrapping must be read back from the host on the authorized disposable-file matrix before making a convergence claim.
- Actual font availability/shaping for Persian RTL, host-level scroll behavior, and placement of multiple screen clusters have not been measured in Desktop during this phase.

These are source-backed native-surface limits or unmeasured host behaviors, not claims of a reproduced live failure. Phase 5 should compare preflight and actual Figma node geometry for the same generated programs and keep native verification fail-closed when coverage is incomplete. No renderer replacement architecture is proposed here.
