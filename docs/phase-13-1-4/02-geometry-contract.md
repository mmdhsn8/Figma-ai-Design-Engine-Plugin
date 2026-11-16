# Geometry and repair eligibility

Predicted dimensions stay in the existing section and VisualDesignSpec contracts. Native QA uses actual absolute transforms and transformed corners in parent-local coordinates. A native recovery candidate instead uses the direct child's relative transform, and accepts only a unit linear transform. Width or top overflow, rotations of the child, nonvertical or nonfixed parent, absolute or fill-height children, unsupported scroll/align modes, ambiguous identity and incomplete scan are refused.

| Finding | Decision |
|---|---|
| Undersized target, crowded row, known low contrast | Existing deterministic pre-save expansion, wrapping and semantic color repair |
| Vertical overflow in declared native scroll viewport | Existing axis-specific QA |
| One bottom-clipped auto-height text in a committed vertical frame | One fixed-height correction of at most 32 px, constrained by the section budget and parent maximum |
| Unrelated, unmeasurable, or unresolved native issue | Preserve checkpoint and reject completion |

The adjustment preserves width sizing, viewport, native IDs and clipping. Existing QA thresholds remain active.
