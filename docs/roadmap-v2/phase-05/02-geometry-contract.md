# Geometry contract v1

The Design Program and its existing native adapter remain the source of planned hierarchy and dimensions. The shared helper calculates a preflight lower bound from fixed sizes, fill/hug minimums, padding and gaps. Explicit horizontal wrap changes that lower bound to the widest required item plus insets. Wrap requires bounded horizontal width.

The host verifier projects all four child corners into the direct parent's local axes using the inverse parent transform. It checks content bounds, excluding stroke and effect extents. Missing, nonfinite or noninvertible transforms prevent full coverage. The geometric comparison uses 0.001 px for floating point error. This contract does not estimate glyph, shadow or stroke bounds. The placement planner independently uses its existing canvas obstacle adapter.

Observed data includes native IDs, parentage, layout mode, insets, dimensions, clipping and asset or text properties where applicable. The report returns numeric rectangles and rule codes without canvas text. Receipt metadata is additive. Older checkpoints with no receipt can be freshly measured and still must meet the existing count and viewport checks.
