# Layout contract

New section normalization uses the existing visual composition version 1 and section identity. Original node widths, padding and gaps define the section-local width budget after insets. Semantic controls keep at least 44×44 px. Horizontal rows consume the sum of widths and gaps; vertical containers consume heights and gaps. Mobile keeps a 390×844 native scroll viewport, separate from 350 px content and bounded section sizing. The renderer continues to use fixed horizontal widths and content-driven editable text heights.

The repair does not treat model text measurements as native measurements. Persisted and rendered output still passes the existing strict schemas, section quotas, role coverage, native readback and ownership checks.
