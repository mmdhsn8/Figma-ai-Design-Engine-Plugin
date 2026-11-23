# FW-6 — Reliability and orchestration

**Status: PARTIAL / LIVE PENDING.** The identified completion/Stop race is fixed in the Universal task path, stale completion text is corrected, and the previously flaky export-slot test now uses fake timers. Existing Phase 6 orchestration was reused. Offline code and test work is complete for these identified seams; FW-6 is not declared fully complete because the integrated harness does not observe serialized UI↔plugin bridge traffic or count all native API calls/checkpoint readbacks together, and Desktop acceptance is still unrun.

## Implemented

- `src/ui/universal-design-task.ts`: checks cancellation after all screen jobs settle and again after the final task checkpoint save. A Stop received while that final acknowledgement is outstanding now reaches the existing failure handler instead of returning successful completion.
- `src/ui/chat-task.ts`: Universal cancellation/failure now replaces stale success text with a truthful paused/failed message and a safe Resume instruction. The compatible multi-screen handoff also fences late progress and late provider outcomes after Stop.
- `tests/universal-design-chat.test.ts`: final-checkpoint Stop race with an attached root, an end-to-end local F10 Persian RTL residential-building task, and expanded scheduler benchmark counters.
- `tests/chat-task.test.ts`: late multi-screen progress/outcome cannot make a stopped handoff complete.
- `tests/fw5-visual-qa.test.ts`: replaced a real 260 ms sleep with Vitest fake timers for the non-cancellable export-slot regression.

No new global state machine, storage format, renderer, executor, OAuth transport, or feature gate was added. The only always-on runtime behavior change is cancellation/error-state hardening. FW-2/3/4/5 remain off by default; FW-3 remains planner-only. Gate-on and gate-off builds both passed, with the final build gate-off.

## Evidence and limits

- Fresh local suite: 47 files, 823 tests passed (deterministic local fakes; see [04-fault-injection-and-test-evidence.md](04-fault-injection-and-test-evidence.md)).
- The focused Stop, refresh and export-slot race suite passed 10/10 separate Vitest invocations.
- The F10 Persian RTL Universal fake task verified 10 screens in order, stable unique root IDs, 10 renderer-adapter calls and 10 native readbacks. Its measured task-harness time is recorded as simulated in [05-local-benchmark.json](05-local-benchmark.json).
- No provider, OAuth account, Figma document, Figma Desktop mutation, screenshot transmission, or real image reviewer was used. Provider image capability and Desktop rendering, typography, restart, and Stop/Resume remain **LIVE PENDING**.
- A dispatched final checkpoint write cannot be physically cancelled by the UI. If Stop overlaps it, the owner checks after its acknowledgement and writes the stopped checkpoint; a crash between those operations remains an explicit distributed-write ambiguity. No exactly-once claim is made.
- The local task benchmark measures mock adapter calls and checkpoint-save invocations. It does not observe actual serialized bridge messages, checkpoint storage readback count, or Figma API method counts in the same run. Existing plugin-only gate metrics remain separately identified and linked in the JSON artifact.

## Gate and repository state

The safety fixes are not feature experiments, so no `VITE_FW6_ORCHESTRATION` flag was added. The existing FW feature flags stay at their source defaults; all-off and all-on builds were verified, then all-off was rebuilt. `manifest.json`, plugin ID, default Universal route, Legacy option, styles, OAuth flow, and protected document data were not intentionally modified. Nothing was committed or pushed.

See [01-runtime-state-and-ownership.md](01-runtime-state-and-ownership.md), [02-concurrency-cancel-refresh.md](02-concurrency-cancel-refresh.md), and [03-checkpoint-recovery-and-idempotency.md](03-checkpoint-recovery-and-idempotency.md) for the source map and operational semantics.
