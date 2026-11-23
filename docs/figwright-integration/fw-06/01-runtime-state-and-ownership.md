# FW-6 — Runtime path and ownership

## Actual request path

```text
Chat submit (App.tsx)
  → runChatTask (chat-task.ts)
    → tool-free greeting/conversation branch, or explicit create route
      → classify + plan using the pinned task/model/session
      → runUniversalDesignTask (one task/checkpoint owner)
        → bounded screen program preparation (default max concurrency 2)
        → save validated DesignProgramV1 before native work
        → sequential screen render through renderProgram bridge
        → native root receipt + task-scoped readback
        → geometry/native QA, optional separately gated FW-5 capture/review
        → per-screen checkpoint, then final task checkpoint
```

`App.tsx` supplies the current task/session fence, authorization check, abort signal, native render/inspect adapters, checkpoint writer, and optional FW-5 callbacks. New tasks still choose Universal by default; a saved task retains its existing execution route. `runChatTask` handles pure conversation before it enters the Universal create owner. A greeting with no explicit Canvas action performs no context read, planner call, checkpoint save, native render, or visual capture; the greeting regression asserts each boundary.

The additional `generationIntent`/`runMultiScreenHandoff` branch in `chat-task.ts` is a compatibility path for saved structured tasks. It is not the active `universal-design-v1` planner/render owner. FW-6 adds the same Stop fence there without moving its checkpoint or native ownership.

## Authority and commit points

| Concern | Single owner | Evidence before advancing |
|---|---|---|
| Task lifecycle, screen order, retry state | Existing `ChatTask` in `runChatTask` / `runUniversalDesignTask` | Saved task ID, route, plan, generation manifest, stable screen IDs |
| Program acceptance | Universal task owner | Strict `DesignProgramV1`, preflight and persisted program fingerprint |
| Native mutation | Existing Figma plugin renderer (`main.ts` → `generation-controller.ts` → `figma-tool-executor.ts` / `design-program-spike.ts`) | Task/document/page scope, stable render request, expected root ID, renderer receipt |
| Native success | Universal task owner after plugin readback | Same screen/root/fingerprint, complete geometry coverage and passing native QA |
| Visual review | Same task owner, through FW-5B adapter/Companion | Fresh image-specific consent, current session/model/root/readback revision; never implied by PNG capture |
| Persistence | UI task owner plus existing `chat-task-storage.ts` in plugin | Serialized save response; explicit hash+byte revision confirmation where requested |

The task owner sends one render adapter call per screen and commits in plan order. It does not use FW-3's planner contract as a second native executor. `nativeRootNodeId`, logical root reference, program fingerprint, page/document scope and existing renderer receipt remain the identity chain; no alternate ledger was introduced.

## State transition rules

| State/event | Legal action | Completion evidence |
|---|---|---|
| Conversation / greeting | Reply only | No Canvas read, mutation, or design checkpoint |
| Explicit create → planning | Classify and save one plan | Original prompt authorizes design; task/model/route identity pinned |
| Program preparation | Bounded concurrent model requests; validate each response | Screen ID, request/attempt association, normalized strict program |
| Program saved | Native render may be scheduled in saved order | Durable program/fingerprint checkpoint |
| Native dispatch | One existing renderer request for that screen | Plugin receipt alone is not screen success |
| Native readback / geometry QA | Reconcile the exact root and subtree | Complete native evidence matches page/root/program and passes gates |
| Optional visual review | Only if gate, provider and fresh image consent permit | Reviewed image receipt plus native recheck where repair occurred |
| Final checkpoint | Persist completed state through existing owner | Save acknowledgement and post-save Stop/current-task check |
| Stop / stale task / auth loss | Stop new work; reject late commits; retain attached roots | Paused/failed checkpoint with concrete reason; Resume reconciles original IDs |
| Partial native failure | Keep attached task-owned nodes and saved IDs | Incomplete screen, diagnostic retained; no root deletion/replacement |

`response.completed`, a Companion response, a bridge ACK, renderer receipt, or PNG capture is not by itself a completed screen. The screen is marked verified only after fresh native readback and QA; task completion follows the final checkpoint boundary.

## Diagnostic chain

The existing bounded `UniversalDesignMetricsSchema` / `UniversalDesignTraceEventSchema` records task, screen/stage, engine route, opaque request IDs, attempt, outcome, elapsed time, bounded payload sizes, node count and allowlisted QA codes. The task holds at most 128 events and stays under the existing 512 KiB checkpoint cap. `chatTaskSafeDiagnostic` and `traceCheckpoint` avoid prompts, layer text, screenshot bytes and credentials. Figma/plugin console traces use task/request/root IDs for correlation; Companion traces distinguish refresh, disconnect, timeout, authorization loss and stream interruption.

FW-6 does not add a second telemetry store. A practical redacted failure record is: `{ taskId, generationId, screenId, requestId, stage, outcomeCode, checkpointRevisionHash, nativeReceiptId, rootNodeId, readbackRevision, elapsedMs, recoveryAction }`. Do not add prompt, OAuth/account object, PNG, private node text, or raw filename fields.
