# FW-6 — Checkpoints, recovery and idempotency

## Existing persistence path

The UI Universal task owner validates the `ChatTask`, enforces its existing 512 KiB limit and serializes saves through its per-task `saveQueue`. The existing plugin `chat-task-storage.ts` serializes operations by document/page/chat/task key, bounds unresolved work, deduplicates identical request IDs, rejects a request ID reused for different data, and confirms a repeated successful save against the current checkpoint revision. `chat-checkpoint-wire.ts` represents revision as both canonical hash and byte count. The persistent schema was not migrated and storage was not cleared.

The task remains the only ledger. Program and native identity are stored in its existing per-screen checkpoint and manifest. The plugin-side render request is correlated to its stable screen/task IDs, saved program fingerprint, existing native root ID, and page/document identity. A renderer receipt may seed the node ID; `inspectProgram` must then read the root and bounded child geometry before the task marks that screen verified.

## Resume and ambiguous writes

On retry, the existing owner reads the saved plan/program before requesting a new model result. A saved program is reused. A `rendering` checkpoint with an existing renderer receipt/root reconciles that root; it does not silently create a replacement. Missing, moved, foreign, incomplete, or stale roots fail closed and leave the user’s attached content in place. A post-adoption readback/geometry exception leaves the root attached and the screen incomplete. Resume checks the original root and parent before continuing; the local regressions assert root ID stability and no duplicates.

Physical exactly-once cannot be promised over a UI/plugin bridge and storage that may lose an acknowledgement. The supported guarantee is at most one accepted task-owned root per stable screen identity, using existing renderer idempotency, stable root receipt, readback and reconciliation. When the outcome is ambiguous, reconcile before any retry. If the original root is gone or user-moved, stop and ask for explicit safe recovery; do not silently reparent or replace it.

## Final completion and Stop

FW-6 adds the missing final fence after `await save()` in `runUniversalDesignTask`. The completed snapshot is prepared separately while the live task remains `running`; only after save acknowledgement and a post-save Stop/current-task check does the owner apply the in-memory `completed` state and success text. A Stop arriving during that unresolved final checkpoint becomes a stopped task in the owning `runChatTask` catch path, not a successful return. The final checkpoint test pauses the save adapter, presses Stop, releases the in-flight save, and asserts: live/final task state is stopped; the final checkpoint is stopped; the single verified native root remains attached under the same page; its node ID is retained; success text is gone.

The in-flight save itself cannot be recalled. If it has already been dispatched, it may be persisted before the stopped compensation; a crash between those writes is an explicit ambiguity. This is why the task checks again after the acknowledgement and why this delivery does not claim atomic Stop/write rollback. There is no delete of an attached root as cleanup.

## Fault-window recovery contract

| Window | Observable checkpoint/native state | Legal next action | Duplicate root protection |
|---|---|---|---|
| Before dispatch | Saved plan/program; no renderer request | Resume saved program or stop | No root exists for this attempt |
| Root created, attachment/receipt uncertain | `rendering`; root may exist with task metadata | Reconcile by stable receipt/ID and parent | Do not dispatch replacement until reconciliation |
| Attached, before child completion/ACK | Incomplete attached task root | Inspect/reconcile same root; preserve it | Expected root ID is passed back to renderer |
| Mutations finished, before readback | Existing root with no verified task state | Read back original root | No replacement until complete readback |
| Readback finished, before checkpoint ACK | Native evidence may be ahead of task checkpoint | Reconcile same root, then checkpoint | Stable root ID/receipt avoids second root |
| Save ACK delayed/lost | Save outcome uncertain | Load/confirm hash+bytes; do not claim completed | Save request identity and revision de-duplicate |
| Stop during final task save | In-flight save plus abort signal | After ACK, checkpoint stopped and retain verified roots | Stop blocks later work; no root cleanup |
| Plugin reload / root moved or deleted | Persisted root ID compared to current page/parent | Stop with diagnosis and ask for recovery | Never silently create/reparent a replacement |

The most demanding bridge crash windows are only simulated by existing storage/native fault tests. No Desktop restart or Figma document was used.
