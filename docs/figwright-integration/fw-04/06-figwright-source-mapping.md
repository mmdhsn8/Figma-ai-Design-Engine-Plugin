# FW-4 — Pinned Figwright and Figma API source map

## Pinned upstream

Audit target: `awdr74100/figwright` release `v0.8.0`, pinned commit `458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca`. These are the paths/symbols recorded in the FW-3 pinned source audit at that same commit; no `main` branch or later release is used for the integration rationale.

| Pinned source path and symbol | FW-4 relevance | Adaptation / rejected pattern |
|---|---|---|
| `packages/mcp/src/tools/wire-schema.ts` — `WIRE_TOOL_SCHEMAS`, `checkBatchOps` | Per-operation contracts must be validated as data at the boundary. | FW-4 adds a strict bounded sizing expectation to the existing inspection request. It does not add a new mutation contract or MCP dependency. |
| `packages/plugin/src/handlers/batch.ts` — `BATCHABLE_TOOLS`, `parseOps`, `createBatchHandler` | The plugin owns actual Figma operations and ordered execution. | FW-3 already proved the existing renderer is one page program per dispatch and deliberately remained planning-only. FW-4 does not introduce another batch executor or copy its rollback path. |
| `packages/plugin/src/handlers/batch-refs.ts` — `earlierRef`, `opNeedsEarlierResults`, `resolveOpRefs` | Native node IDs are resolved at the Figma plugin boundary. | Not applicable to layout convergence: FW-4 uses the existing renderer’s `fad.design.logical-ref` and existing task-owned root resolution. No in-batch reference model was added. |
| `packages/plugin/src/handlers/batch.ts` — snapshot/restore and rollback-error reporting | A Figma mutation and a ChatTask checkpoint are not an atomic database transaction. | Do not delete an attached root or claim rollback atomicity. FW-4 repairs only safe properties and retains the root if final readback fails. |
| `packages/mcp/src/index.ts` — server tool registration/dispatch | Upstream orchestration and plugin mutation have separate responsibilities. | No MCP server, provider, new bridge, or orchestration layer is added. Existing UI task owner remains the sole checkpoint authority. |
| `LICENSE` — MIT | Upstream license attribution boundary. | No Figwright source code is copied. The implementation is independently authored from the local renderer and API contracts; no upstream code attribution block was needed. |

The full existing pinned map, including the original FW-3 analysis of operation validation, reference ordering, rollback coverage and acknowledgement limitations, is [here](../fw-03/01-upstream-source-map.md).

## Figma API semantics used

Installed typings are `@figma/plugin-typings` 1.126.x, as specified by the project dependency. The official docs consulted are linked in [02-geometry-contract-and-convergence.md](02-geometry-contract-and-convergence.md): layout-mode changes can reflow Auto Layout descendants; FILL/HUG are constrained by node and parent type; text auto-resize affects measured dimensions; and text mutations that affect shaping require loaded fonts.

The renderer’s sizing assignment order was left intact. FW-4 reads the resulting native values after all siblings are attached, makes only a proven task-owned sizing correction, then reads back again. It does not use a layout-mode toggle as a probe, estimate text width from character count, or infer Figma behavior from browser flexbox.

## Local source correspondence

| Existing source | FW-4 use |
|---|---|
| `src/shared/fw4-geometry.ts` | Build gate and redacted bounded expectation projection from the canonical saved screen program. |
| `src/plugin/design-program-geometry.ts` | Compare expected vs actual size modes and text auto-resize; perform one restricted convergence pass and final inspection. |
| `src/plugin/design-program-spike.ts` | Gate the production `verifyScreen` path, trace expectation/readback phases, preserve failed attached roots. |
| `src/plugin/figma-tool-executor.ts` | Validate expectations during the existing task-native readback. |
| `src/ui/universal-design-task.ts`, `src/shared/messages.ts` | Send checkpoint-derived expectations through the existing inspection message and keep the existing checkpoint owner. |

The measured mock fault is a test-only property reset after sibling append. It validates the recovery guard and exact readback behavior, not a claim that Desktop Figma 1.126 resets sizing this way.
