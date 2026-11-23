# FW-4 — Geometry contract and convergence

## Gate and path

`VITE_FW4_GEOMETRY=fw4-geometry-v1` enables FW-4 in both the Universal UI task and the Figma plugin. Missing, empty, or any other value leaves it off. The default build remains off. No runtime toggle, persisted preference, second executor, checkpoint field, transaction ID, or storage owner was added. FW-3 remains a non-mutating planning contract.

The renderer continues to consume the existing canonical `DesignProgramV1` and its existing lowered native specs. UI readback expectations are projected from the saved program on demand; they are not persisted. The screen fingerprint and original `nativeRootNodeId` remain the existing identity.

## Typed readback projection

`NativeLayoutExpectationV1` contains:

```ts
{
  logicalRef: string;
  parentLogicalRef: string;
  horizontalSizing: "FIXED" | "HUG" | "FILL";
  verticalSizing: "FIXED" | "HUG" | "FILL";
  textAutoResize?: "HEIGHT" | "WIDTH_AND_HEIGHT";
}
```

`projectNativeLayoutExpectations` includes the generated content frame and the saved screen’s planned nodes. It uses the same stable logical references produced by `design-program-adapter.ts`, applies the same 120-character cap, and omits text, colors, font names, filenames and provider data. The expectation array is bounded by the existing `DESIGN_PROGRAM_LIMITS.nodes` plus its one generated content frame (301 entries). The strict task-native-inspect schema rejects unknown fields, bad enum values, duplicate logical refs and excess entries. The native plugin boundary validates the same message independently.

At the renderer boundary, the checker compares the existing compiled native `DesignNode.sizing` against actual Figma child sizing, and compares the planned text auto-resize against the actual text node. At the later task-native readback boundary, the plugin matches the saved expectations against actual nodes by logical reference, checks parent logical reference, and marks missing expectations as incomplete. The existing receipt continues to check the rest of the adopted root. A discrepancy cannot be silently treated as a successful readback.

## Limits and correction rules

- One pass, at most one repair attempt per mismatched task-owned node; the tree remains bounded by the existing 300-node native geometry traversal.
- Only `layoutSizingHorizontal`, `layoutSizingVertical` and a text node’s already-planned `textAutoResize` may be restored.
- The page, root task ID, saved program fingerprint, complete hierarchy and native parent links must match before a repair. Each target must be below that root, have a unique planned logical ref, be an Auto Layout child, and not be absolute-positioned.
- The first report must be complete and contain only `native_layout_sizing_mismatch` findings. A wrong parent, overflow, missing node, ownership conflict, unsupported transform, unreadable text bound, failed font or any other defect blocks repair.
- HUG is applied only to native FRAME/TEXT nodes. FILL/FIXED use the existing supported child sizing properties. Setter errors become `native_layout_convergence_failed` and the final native inspection still runs.
- Reused screens and roots recovered after interruption are read and validated but never modified by this correction pass. If the tree is moved, missing, ambiguous, incomplete or stale, the existing task requires inspection/recovery rather than recreating a root.
- No attached layer is deleted. A failed screen retains its original task-owned root and IDs under the existing `preserveFailedProgramNodes` path. No sibling, master or unrelated node is a correction target.

Text font loading and native text construction remain in the existing renderer. The project’s available-font resolution and explicit Arabic/Persian fallback path run before rendering. FW-4 changes no copy, font, font size, line height, truncation policy, or color. Figma’s text API does not expose per-glyph shaping results; correct mixed-script shaping and visible wrapping still require Desktop inspection.

## Diagnostics and outcomes

The plugin trace uses `fw4_layout_expectation` for compiled expectations and `fw4_geometry_readback` / `fw4_geometry_convergence` for native observation, including coverage, finding codes, bounded attempt counts and repaired-node count. It does not log text. UI task traces identify the exact gate on the existing native-readback request and then record the returned findings/coverage.

| Stage | Observable result | Task consequence |
|---|---|---|
| Preflight expectation | bounded planned refs and sizing modes | no native change |
| First native readback | actual modes, parents and complete geometry report | clean continues; only sizing mismatches may enter the new-root repair pass |
| Repair | property assignment count, no node creation/deletion | remains uncommitted until readback |
| Final renderer readback | complete native properties and bounds | any remaining finding fails the render and leaves the root for inspection |
| Task-native readback | actual adopted root checked against fingerprint/receipt and saved expected modes | existing task owner decides verification |
| Checkpoint save | existing ChatTask checkpoint owner and revision semantics | no second success authority or persistence ledger |

## Figma API references

The implementation uses the installed `@figma/plugin-typings` 1.126.x union and API properties. Official API documentation consulted for reflow/sizing semantics, text auto-resize and font requirements:

- [Auto Layout mode](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutmode/)
- [FrameNode and Auto Layout frame sizing](https://developers.figma.com/docs/plugins/api/FrameNode/)
- [Horizontal child sizing](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutsizinghorizontal/)
- [TextNode auto resize](https://developers.figma.com/docs/plugins/api/properties/TextNode-textautoresize/)
- [Loading fonts](https://developers.figma.com/docs/plugins/api/properties/figma-loadfontasync/)
- [Working with mixed-style text](https://developers.figma.com/docs/plugins/working-with-text/)

The local fake runtime validates the state machine and setter recovery. It does not prove a Desktop version’s reflow behavior, typography, or final visual geometry.
