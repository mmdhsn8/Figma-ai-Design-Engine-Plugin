# Host readback and convergence

The precommit verifier checks the lowered tree after native creation and asynchronous style binding. It checks expected hierarchy, editable text properties, layout settings, sizing bounds and direct parent containment. It checks every node up to the route's bounded traversal limit. The executor reads the owned root again after adoption and UI acknowledgement. It compares a local receipt and runs a fresh geometry pass. Incomplete coverage or any discrepancy keeps the screen unverified.

| Synthetic case | Expected classification |
| --- | --- |
| Parent page x=510, width 390 and child right edge at local 545 | 155 px horizontal overflow |
| Same parent with child right edge at local 410 or 394 | 20 px or 4 px horizontal overflow |
| 44 px parent containing a 50 px text box | 6 px vertical overflow |
| 350 px row requiring 504 px | 154 px preflight deficit |
| Fixed scroll viewport with longer inner body | Only bottom overflow at the authorized viewport/body boundary is allowed |

One repair can grow the newly created synthetic scroll body based on the measured bounds of its child. It runs only when every current finding is a vertical overflow at that body boundary. The whole screen is then measured again. New screen construction is discarded through the renderer tracker if verification fails. Replay does not apply this correction. Text without visible effects also checks the reported paint AABB when parent axes are aligned. Glyph-level clipping within a text box and detailed font shaping still require Desktop inspection.
