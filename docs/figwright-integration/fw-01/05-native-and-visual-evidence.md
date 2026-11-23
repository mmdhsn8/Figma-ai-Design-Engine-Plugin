# 05 — Native and visual evidence

## Live evidence

No approved test file/page was open. No native tree, page ID, root ID, node count, component instance, geometry, screenshot, Layers panel, text edit, save confirmation, or before/after node comparison was captured.

| Requirement | Ours | Figwright |
|---|---|---|
| Disposable file/page identity | NOT MEASURED | NOT MEASURED |
| Exact task-owned root IDs and order | NOT MEASURED | NOT MEASURED |
| Fresh native tree readback | NOT MEASURED | NOT MEASURED |
| Native node/component-instance counts | NOT MEASURED | NOT MEASURED |
| Persian shaping or English typography | NOT MEASURED | NOT MEASURED |
| Bounds, clipping, scroll, touch targets, contrast | NOT MEASURED | NOT MEASURED |
| 100% and fit-to-screen canvas screenshots | NOT CAPTURED | NOT CAPTURED |
| Layers-panel screenshots | NOT CAPTURED | NOT CAPTURED |
| Manual editability check | NOT MEASURED | NOT MEASURED |
| Blind human reviewer count/scores | 0 reviewers; NOT REVIEWED | 0 reviewers; NOT REVIEWED |
| Recovery or scoped-edit identity comparison | NOT MEASURED | NOT MEASURED |

## Source evidence, separate from live evidence

Source inspection confirms that the current plugin has a native verification function that freshly resolves the screen root and traverses bounded native children, recording actual node bounds, transforms, layout sizing, clipping/overflow, and quality findings. It is defined in src/plugin/native-design-verification.ts as verifyNativeDesign. The renderer reports actual created/reused components and node counts in src/plugin/renderer.ts.

The pinned Figwright MCP registry includes get_node/get_document/get_screenshot and save_screenshots tools. Its figma-build skill says to inspect the native result, compare screenshots, correct discrepancies, and screenshot again. These are documented capabilities and workflow guidance; no connected MCP tool response or screenshot was observed.

Neither source inspection nor the local harness proves visual polish, Persian shaping, connected component instances, safe editing, or actual Desktop geometry. Do not treat this page as acceptance evidence.

## Evidence handoff format

For each later live screen, attach sanitized canvas and Layers screenshots from the approved disposable file, exact root/node IDs, a native tree summary, component-master/instance status, QA checklist with actual values/findings, and reviewer scores. Screenshots must exclude/redact account chrome and contain only synthetic test content. Record all IDs as belonging to the specifically approved test scope.

## Continuation evidence — 2026-11-22

No Figma Desktop screenshot or native readback was captured. The available-app inventory contained no Figma Desktop window. The Firefox window titled “Figma Design Status — Mozilla Firefox” was deliberately left unopened because its identity is not an approved disposable test scope. There are no F0/F1 root IDs, canvas screenshots, Layers screenshots, or visual scores to append.
