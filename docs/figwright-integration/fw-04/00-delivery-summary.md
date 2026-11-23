# FW-4 — Layout & Geometry Convergence

**Status: CODE COMPLETE / LIVE PENDING.** Final local verification passed as recorded in `03-test-and-fault-evidence.md`. The FW-4 gate reaches the existing Universal renderer and native readback path. Figma Desktop acceptance has not run.

## What changed

- Added `VITE_FW4_GEOMETRY=fw4-geometry-v1`, default off. The UI and plugin builds use the same exact opt-in value.
- Gate-on screen verification now checks native `layoutSizingHorizontal`, `layoutSizingVertical`, and planned text auto-resize after the complete child tree has been attached.
- A single repair pass may restore those sizing properties on a newly created root whose page, task ID, program fingerprint, parentage, and full geometry coverage already match. The pass changes no dimensions, text, font, parent, paint, or sibling order. It rereads the complete root before the renderer can acknowledge it.
- The existing task-native readback receives a strict, bounded projection of the checkpointed `DesignProgramV1` sizing intent. The projection contains logical references and layout modes, never user copy. A missing expected node or changed mode fails native verification.
- The existing ChatTask / Universal task owner, render request identity, root receipt, adoption registry, checkpoint and Resume route remain in control. FW-3 remains planning-only.

## Safety and scope

Gate off follows the previous renderer verification path. Gate on does not repair reused or recovering roots. A repair failure or remaining geometry finding fails the screen and leaves attached task-owned content for inspection; no attached root is deleted or recreated. The new repair is property-only and will not detach FW-2 instances or mutate component masters.

The correction scope is intentionally narrow: planned HUG/FILL/FIXED modes and the corresponding supported text auto-resize value. Existing preflight, visual-quality, geometry, font resolution, FW-2 reference validation, native adoption and checkpoint checks remain active. The renderer still creates one page program per existing request; FW-4 adds no native batch executor and makes no dispatch or speed claim.

## Evidence

Local tests reproduce a controlled sibling-reset fault in the repository fake runtime: gate off leaves the wrong mode undetected; gate on repairs the task-owned node and performs a second native geometry readback. Separate tests mutate a rendered node and confirm the later task-native readback rejects the changed actual sizing mode. The fake runtime is not Figma Desktop and does not establish that this exact reset occurs in Figma.

The 1/3/10-screen local comparison is in [04-local-before-after-metrics.json](04-local-before-after-metrics.json). Clean gate-on runs had the same node tree, API calls, sizing writes and geometry-readback count as gate off. In the injected-fault lane, the post-render probe found 5/27/50 sizing discrepancies for F1/F3/F10 with gate off; gate on corrected those 5/27/50 nodes, added one final verification readback per affected screen, and kept root IDs stable on renderer replay. Actual UI bridge dispatches, ChatTask checkpoint writes, Desktop typography, visual quality, and elapsed Figma time were not measured.

## Remaining acceptance

Run the separate disposable-document procedure in [05-live-desktop-acceptance.md](05-live-desktop-acceptance.md) before enabling the flag in a user build or claiming live reliability. Do not use the protected Test Shop document.
