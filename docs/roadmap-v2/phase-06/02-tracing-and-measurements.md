# Tracing and measurements

## Safe task trace

`UniversalDesignMetricsSchema` and `UniversalDesignTraceEventSchema` add a bounded `phase6-universal-orchestrator-v1` trace to the existing task diagnostic surface. Events correlate task, screen/stage, engine, opaque provider/native IDs, request attempt, timings, byte counts, node counts, QA codes and QA coverage. A task retains at most 128 recent trace events and caps the full checkpoint at 512 KiB. Traces store no prompt, model output, tool arguments, credentials, screenshot or canvas text. The existing diagnostic aggregator exposes sanitized totals.

Durations use `performance.now()` within the UI process. `providerQueueWaitMs` sums time from scheduler enqueue (including dependency wait) to dispatch; across screens the sum may exceed wall time. `providerLatencyMs` and `programCompositionMs` are summed call durations, so concurrent calls can overlap. `firstNativeProgressMs` means the first native-render acknowledgement; `firstVerifiedScreenMs` means the first completed readback. Native geometry timing comes from the host response where available. Missing host/browser measurements are not inferred.

Intent classifier rounds are imported from the existing model-round trace once when Universal metrics are initialized. Provider request counts are `intentRequests + planRequests + programRequests + repairRequests`; failed requests consume their bounded request count even if they do not produce a completed provider round. Task totals after a plugin restart measure that process's resumed segment; timestamps are not subtracted across processes.

## Matched deterministic local timing

Values below are medians of three runs, rounded to whole milliseconds. Each run makes all requested screens pass the same mock native render/readback gate. They are not live model, Figma Desktop or user-latency benchmarks.

| Screens | A serial total | B max-2 total | Total change | A first verified | B first verified | Requests / rounds | Native batches / mock nodes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 169 ms | 100 ms | Not comparable: B has no parallel work and the run was warmed | 163 ms | 95 ms | 3 / 3 | 1 / 10 |
| 3 | 239 ms | 148 ms | 38% lower | 126 ms | 95 ms | 5 / 5 | 3 / 32 |
| 10 | 660 ms | 595 ms | 10% lower | 124 ms | 116 ms | 12 / 12 | 10 / 116 |

For 10 screens the provider-delay fixture contributes 195 ms of scripted waiting on the serial critical path before model/host and JavaScript overhead. The B total improves modestly; its first verified screen is only 8 ms lower by median. This supports a bounded low-risk scheduler in the harness, not a claim of “fast 10-screen generation” with a real provider.

The 3-screen A/B queue-wait sums were 229/238/219 ms and 25/33/37 ms; 10-screen sums were 2884/2573/2519 ms and 972/918/1041 ms. Queue-wait totals are sums over screens, not wall duration. Full per-run traces are printed by the benchmark tests in [`tests/universal-design-chat.test.ts`](../../../tests/universal-design-chat.test.ts).
