# FW-6 — Concurrency, cancellation and refresh

## Existing scheduling retained

`universal-design-task.ts` schedules screen preparation with a default maximum of two active model calls; a saved Phase 5 pending response switches the task to serial. Dependencies are a validated DAG and block downstream screens until their programs are saved. Program normalization/preflight and shared task state use the current queues/lock. Native rendering and readback proceed in persisted screen order, so an out-of-order provider response cannot reorder or overlap native commits.

When a preparation fails, the scheduler stops launching new screens and waits for already dispatched work to settle. Valid in-flight sibling programs can still be saved; the original failure is surfaced. Explicit Stop aborts the scheduler, wakes dependent waiters, stops new dispatches, and checks before a provider result mutates task state. Tests cover network interruption with 1/3/10 screens, valid sibling retention, late responses, explicit Stop and Resume.

## Stop fences added in FW-6

- In `runMultiScreenHandoff`, progress is checked before validation/checkpoint changes and after its awaited save. A late `complete` progress event cannot add a post-Stop checkpoint.
- The returned multi-screen outcome is checked after `await generateMultiScreen` and before parsing/marking completion.
- Universal completion checks the signal/current-task fence after scheduler settlement and after the final save acknowledgement. It writes a completed checkpoint candidate while the live task remains `running`; the in-memory completed state and success text are applied only after the save resolves and the post-save fence passes. If Stop wins while the final save is unresolved, the existing `runChatTask` catch path writes a stopped task, leaves verified screens and roots in place, and replaces stale “created” text with a Resume message.
- The task still waits for an in-flight save. The UI cannot cancel a write already dispatched to plugin storage; its late acknowledgement is reconciled by the existing serialized writer and the task owner issues the stopped checkpoint afterward. A crash before that compensating write is a remaining ambiguity, not guaranteed atomicity.

## OAuth/session continuity

`src/companion/server.ts` revalidates a stable authorized session identity, subject and granted scope rather than depending on the credentials object reference. Token rotation in the same session can therefore finish an already-authorized stream. A changed account/session, revocation, or genuine authorization loss invalidates it. `src/ui/companion-client.ts` carries cancellation origin and rejects aborted/stale responses; provider transport and cancellation errors retain their provenance.

`tests/companion-server.test.ts` exercises sibling refresh before response headers and during streaming, with the original response still accepted. The fake transport also covers explicit Stop, revoked refresh credentials, client disconnect and Companion restart/rotated credentials. These are deterministic local tests; no OAuth user or provider was used in FW-6.

## Non-cancellable native export

Figma `exportAsync` may continue after the UI's deadline. The plugin export owner keeps its single capture slot occupied until the actual export settles, declines a second request while the first remains in flight, and does not remove the attached root. Once the first export settles, a retry must reconcile the existing root instead of exporting/recreating blindly. `tests/fw5-visual-qa.test.ts` now advances 40 ms and then 210 ms with fake timers; no wall-clock sleep is used.

## Gate behavior

No FW-6 experiment flag was needed for these cancellation/state corrections. Build validation was performed twice: all existing `VITE_FW2_CONTEXT`, `VITE_FW3_NATIVE_BATCH`, `VITE_FW4_GEOMETRY`, and `VITE_FW5_VISUAL_QA` options on (FW-5 review+bounded-repair mode), then all unset for the final output. This proves compilation only; it does not activate those paths in the delivered build or imply provider capability. FW-3 remains a non-mutating planning experiment.
