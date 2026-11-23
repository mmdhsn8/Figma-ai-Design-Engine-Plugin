# FW-3 — contract and ownership

## Implemented contract

`src/shared/native-batch.ts` defines strict Zod v4 request, operation and receipt schemas, JSON serialize/parse helpers, admission validation, a backward-reference resolver and a planning-only compiler from canonical `DesignProgramV1`. The same request validator is intended to be called at both UI/bridge and Figma main boundaries; the planner currently calls it locally. No native main handler or bridge route consumes it yet.

Request V1 scope fields are `taskId`, `screenId`, the existing canonical program `checkpointFingerprint`, `batchId`, `requestedPageId`, and `authorizedRootId`. The fingerprint confirms that this request belongs to the saved screen program. The repository's durable ChatTask revision is a `{ hash, bytes }` pair produced by `chatTaskBridge`, but `runUniversalDesignTask`'s `save` and `renderProgram` callbacks do not expose that revision to this adapter. FW-3 does not invent a revision or add a second ledger; binding the durable revision at a future mutation boundary requires plumbing it through the existing owner. That handoff has not been implemented. `batchId` is the existing render `requestId` for that in-flight transaction, not a new ledger or persistent identity. Operation IDs are local to one batch. Supported operations are create-frame, create-text, create-shape (rectangle/ellipse), set-layout and set-paint (solid only). References are tagged task-owned root or within-batch create IDs; unknown fields, operation kinds and unsafe payload fields fail closed.

References must point backward to an earlier create in this same ordered request. The request has one authorized root and one page. Validation rejects stale task/screen/page/checkpoint/batch, stopped state, a missing or foreign root, wrong page/parent, non-root task-owned references and operation references to absent/non-create/later operations. Cycle detection is implicit in the backward-only edge rule. The resolver additionally requires the referenced creation to have produced an ID; expected page is checked for task-owned references.

## Bounds and rationale

| Bound | Value | Basis |
|---|---:|---|
| Operations | `DESIGN_PROGRAM_LIMITS.nodes * 2` (600) | Existing canonical node limit times room for one mutation such as layout/paint per node. Payload byte cap is stricter in practice. |
| Creations | 200 | Existing Universal task-wide adopted-native-node ceiling. |
| Serialized payload | `CHAT_TASK_MAX_BYTES` (512 KiB) | Existing task payload/checkpoint limit; byte counting uses the shared UTF-8 helper, not browser APIs. |
| Program depth | `DESIGN_PROGRAM_LIMITS.depth` (8) | Existing canonical DesignProgram bound. The serialized op list is flat. |
| Timeout | 60,000 ms | Existing UI render bridge timeout; future writer must not exceed the owner’s request lifetime. Not enforced by this planner. |
| In-flight writes | 1 | Existing serial screen mutation owner. Planner does not write. |

## Existing owner and stages

The UI Universal task checkpoint is canonical. It stores each screen's program/fingerprint, status, attempt, root ID/ref and receipt fields; the storage bridge uses its existing hash/byte revision for optimistic save/read-after-write confirmation. Figma main and `renderDesignProgramLocal` own native creation and root identity checks. `figma-tool-executor` adopts verified nodes into its existing page/task-scoped operation state. UI then issues native inspection and only sets the screen `verified` after `verifyNativeReadback`; the task is complete only after every screen is verified. FW-3 adds no storage key or ledger.

For a future executor, acknowledgements mean distinct things: **accepted** = request/schema/scope admitted, no claim of mutation; **applied** = listed operations ran and actual creation IDs were captured, no postcondition claim; **readback-confirmed** = bounded native inspection observed root, parent/type and required geometry/layout/text/paint; **checkpoint-confirmed** = the existing task owner persisted that readback result. Only the final stage may use status `verified`. The receipt schema enforces that invariant. Current production renderer already observes geometry and adoption internally, but there is no FW-3 receipt path.

## Explicit fallback and exclusions

This planner returns an explicit unsupported/fallback result for images, vectors, instances, component/style/token references and programs with FW-2 references. Those continue through their original renderer and revalidation path. Fonts are returned as explicit family/style requirements; only the existing renderer currently loads them safely. The planner does not claim that sending sizing properties proves computed geometry. Native QA and actual readback remain necessary.

No deletes, clones, arbitrary moves/reparenting, variable collection changes, remote imports, plugin JavaScript, arbitrary strings as code, cross-page references or writes to foreign roots are represented in V1. There is no compensation policy in executable FW-3 code because there is no batch executor. If one is later added, attached task-owned roots and their recorded IDs are durable recovery evidence and must never be removed because verification failed.
