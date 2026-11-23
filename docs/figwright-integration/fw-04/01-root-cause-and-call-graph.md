# FW-4 — Root cause and production call graph

## Existing Universal path

| Stage | Current owner and source | Relevant behavior |
|---|---|---|
| Plan, normalize and preflight | `src/ui/universal-design-task.ts` | The task stores the canonical `DesignProgramV1` and fingerprint in the existing per-screen checkpoint. It validates design geometry, contrast, RTL and capability requirements before native work. |
| Render dispatch | `src/ui/design-program-bridge.ts` → `src/plugin/main.ts` | The UI sends one saved screen request to Figma main. Main validates the strict message, checks document/page scope, resolves the pinned asset list and only grants FW-2 reuse through its existing revalidation path. |
| Lowering and font preparation | `src/shared/design-program-adapter.ts` → `src/plugin/renderer.ts` | The same program lowers to native frame/text/shape specs with stable logical references and sizing modes. The renderer resolves and loads required fonts before creating a screen tree; an unavailable required script font fails before construction. |
| Native mutation order | `src/plugin/renderer.ts` — `applyLayout`, `setTextTypography`, `appendDesignNode`, `buildFrameChildren` | Frames are sized/configured, children are created and attached in program order, then each child receives its sizing properties. Text receives its loaded font and auto-resize settings before/after attachment. Later children can trigger another Auto Layout reflow. |
| First native readback | `src/plugin/design-program-spike.ts` — `verifyScreen` → `src/plugin/design-program-geometry.ts` — `inspectProgramGeometry` | Verification runs after the full screen tree has been built. It checks page/task ownership, expected hierarchy, transforms and bounds, overflow, text properties, layout values, assets, and component identity. FW-4 adds actual child sizing-mode and text auto-resize comparison here. |
| Adoption and task readback | `src/plugin/figma-tool-executor.ts` — `registerRenderedGeneration`, `inspectTaskNativeNodes` → `src/ui/universal-design-task.ts` | Figma registers the verified subtree with the existing task executor. The UI requests native readback using the same screen fingerprint/root ID, then the existing Universal task owner saves the rendered/verified checkpoint. FW-4 adds sizing expectations to this existing readback request; it adds no RPC or ledger. |
| Stop and Resume | `src/ui/universal-design-task.ts`, `src/plugin/design-program-spike.ts`, `src/plugin/renderer.ts` | The existing task owner fences cancellation and stale responses. The renderer is called with `preserveFailedProgramNodes`; a persisted root ID is reconciled before writes. FW-4 repairs only a new root in the current render, never a reused or recovering root. |

## Proven gap and bounded correction

The renderer writes child sizing in `appendDesignNode` after `parent.appendChild(node)`. `buildFrameChildren` then continues to append later siblings. The old `inspectProgramGeometry` compared realized dimensions and layout properties but did not compare a native child’s actual `layoutSizingHorizontal` or `layoutSizingVertical` to the compiled `DesignNode.sizing`. Its text check allowed either `HEIGHT` or `WIDTH_AND_HEIGHT`, rather than checking the planned text mode. Therefore a later native reflow that changed one of those accepted properties could pass this particular readback if bounds still happened to fit.

The implementation proves the verifier gap directly and reproduces the failure window with a deterministic test-only fake-runtime fault: when a later sibling is appended, the fake changes previous children to `FIXED` and changes earlier program text from `HEIGHT` to the other accepted value, `WIDTH_AND_HEIGHT`. Gate off retains prior behavior and does not identify this injected mode-only discrepancy. Gate on finds it and restores the compiled values on the new task root. This is a reproducible mock case; whether a supported Figma Desktop version causes this exact property reset remains unverified.

The repair does not resize or reorder nodes. It proceeds only when the first complete report contains sizing mismatches and no other finding, the root is still under the requested page with this task ID and program fingerprint, and each target maps to a unique planned logical reference beneath that root. Parent links must already match and each target must still be an Auto Layout child. Unsupported setters, absolute-positioned nodes, incomplete trees, moved roots, mismatched fingerprints, reused roots, and recovery roots are not repaired.

## Other geometry protections retained

`inspectProgramGeometry` already projects transformed child bounds into parent-local coordinates and checks horizontal and vertical overflow. It permits the established vertical-scroll body boundary and known SVG crop case. Text render bounds are checked when the parent axes are axis-aligned; missing measurable text bounds remain incomplete. The existing native visual-quality tests cover sibling overlap, clipping, transformed RTL layout and configured scroll. FW-4 does not add a second visual-geometry engine or infer glyph shaping from character count.

## Readback stages

1. **Preflight expectation:** compiled program `DesignNode.sizing` plus the text auto-resize mode. The later UI readback projection is derived from the saved `screen.program` and carries only logical/parent references and expected layout modes.
2. **Native readback:** actual node parent, layout sizing properties, text auto-resize, bounds and existing task/fingerprint receipt are read from Figma APIs.
3. **Repair:** only the allowed property values are assigned to proven current-task descendants.
4. **Verification readback:** the full native geometry inspection runs again. Any remaining finding fails the render.
5. **Task readback and checkpoint:** the existing UI task owner independently inspects the adopted root and marks the screen verified only when its existing native readback checks pass.

Font loads have completed before screen node creation. FW-4 does not change characters or font ranges, so the sizing-only repair does not need to load another font. It does not infer glyph shaping, ligature, bidi or screenshot truth; those require the live acceptance steps.
