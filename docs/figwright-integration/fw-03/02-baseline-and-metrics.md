# FW-3 — baseline and local metrics

## Hypothesis and unit

Bounded hypothesis: if a future typed batch can replace the current one-screen render message while keeping the same root, adoption, geometry, readback and checkpoint owner, it may reduce UI↔plugin dispatches. It cannot be expected to reduce Figma API operations automatically. No target percentage was set.

The baseline source already dispatches one full `DesignProgramV1` per screen to Figma main and performs a separate readback message. Node creation/layout/paint work is already executed inside the renderer in one plugin request. Therefore a second message per operation is a regression. The candidate measured here is planning-only and does not dispatch; it is not proof that a native batch writer is beneficial.

## Harness

Run `node scripts/benchmark-fw3-native-batch.mjs`. It uses the existing `renderDesignProgramLocal`, `createFigmaToolExecutor`, and deterministic `tests/figma-mock.ts` with identical per-scenario inputs for gate off and gate-on planning-only. The renderer executes and readback is requested in both variants. Gate-on then serializes/validates a candidate plan and retains the same renderer. This is an offline fake runtime: no Desktop, bridge UI, model/provider, network, or actual Figma document is involved.

F1 uses the existing Persian learning one-screen program; F3 uses three Persian booking screens; F10 is a newly synthesized Persian building-management program with ten screens and illustrative content. F10 is a local fixture only and does not change the frozen FW-1 rubric. Timings are one harness run per variant, in-process wall-clock milliseconds; the test host was the current Windows/Node runtime. They do not estimate Figma render speed or user-perceived latency.

`sourceModeled*Dispatches` are counted at the harness call sites corresponding to the current UI owner and plugin bridge code; `bridgeMessagesObserved` is `null` because this plugin-only harness does not instantiate the UI window bridge. Likewise `checkpointOperations` is `null`: the harness does not execute the UI task owner. `sourceKnownCheckpointWritesAfterSavedProgram` records three existing successful-route save points per screen (rendering, rendered acknowledgement, verified readback) from `universal-design-task.ts`; task completion adds a final save. Plugin `clientStorage` reads and writes are counted separately as adoption state, not mislabeled as UI checkpoint writes.

## Results

| Fixture | Screens | Modeled render dispatches off/on | Modeled readback dispatches off/on | Figma API function calls off/on | Native mutation methods off/on | Nodes created and attached off/on | Candidate ops per screen | Candidate serialized bytes | Local harness ms off/on | Planner ms | Replay adds nodes | Errors / skips / recovery |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| F1 | 1 | 1 / 1 | 1 / 1 | 80 / 80 | 206 / 206 | 15 / 15 | 31 | 7,939 | 82.113 / 50.692 | 26.417 | 0 | 0 / 0 / 0 |
| F3 | 3 | 3 / 3 | 3 / 3 | 249 / 249 | 717 / 717 | 54 / 54 | 37 each | 29,383 | 102.090 / 84.229 | 6.766 | 0 | 0 / 0 / 0 |
| F10 | 10 | 10 / 10 | 10 / 10 | 719 / 719 | 1,898 / 1,898 | 150 / 150 | 31 each | 79,492 | 179.013 / 183.839 | 14.399 | 0 | 0 / 0 / 0 |

The local harness observed the same exact root ID arrays in gate-off and gate-on runs (`mock:10` for F1; `mock:10, mock:28, mock:46` for F3; `mock:10, mock:25, …, mock:145` for F10). All roots replayed without adding nodes. Plugin adoption storage calls were respectively 3 reads/2 writes, 9/6, and 30/20. Candidate plans were 31/37/31 operations per screen. Candidate bytes are serialized plan bytes and were not transported.

Gate-on causes **zero dispatch reduction** in this experiment because the candidate is not dispatched. Figma API calls, native mutations, tree counts and source-modeled dispatch counts did not change. Candidate planning adds payload and work. The mixed wall times have no repeated sampling or latency control, so no speed conclusion follows. This evidence supports the current no-go on native writer integration until a smaller actual transport opportunity is demonstrated.

The machine-readable counters, API method breakdown, mutation stages, sizes, root IDs, and limitations are in [03-local-benchmark.json](03-local-benchmark.json). Mutation counts cover the explicitly listed native methods, not direct property assignments. The output is reproducible for this harness but uses generated timestamps and local timings.
