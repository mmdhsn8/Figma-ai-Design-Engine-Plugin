# Performance baseline and measurement limits

## Reproducible local measurements

Run on the local Windows workspace on 2026-11-14. The benchmark reads the already compiled Companion module, processes a deterministic Persian two-screen fixture, and writes only disposable temporary files.

| Measurement                    |                                Result | Interpretation                                                        |
| ------------------------------ | ------------------------------------: | --------------------------------------------------------------------- |
| Fixture size                   |                           2,815 bytes | Small deterministic fixture                                           |
| Parse average                  |            0.0255 ms / 200 iterations | Local JS JSON parse only                                              |
| Normalize + validate average   |            0.2563 ms / 200 iterations | Local normalization/schema path only; 200/200 accepted                |
| Repeated tiny temp-file writes | 2,299 writes; 152.65 ms; 11,491 bytes | Local microbenchmark; not the actual upstream stream                  |
| One buffered temp-file write   |        1 write; 0.66 ms; 11,491 bytes | Same benchmark payload and runner; result is illustrative, not an SLA |
| Mock renderer test             |      100 screens / 300 nodes; 30.2 ms | Figma mock and test runner, not native Figma Desktop                  |

The write strategy comparison is a single local sample and should not be presented as a guaranteed end-user speedup. A concurrent default-worker test run produced a 5-second draft-test timeout, `EBUSY` cleanup, and much slower write numbers; the isolated rerun reduced the write sample to 152.65 ms. This is a warning about runner contention and measurement noise, not evidence of provider latency.

Existing mock discovery results are recorded in [`phase-5-9-3-progressive-discovery.md`](../phase-5-9-3-progressive-discovery.md): one 400-page mock completed in approximately 1.49 s; a separate 1,000-match mock completed in approximately 0.91 s. Those results are also mock-only and were not repeated here.

## What is not measured

This audit collected **no** authenticated model request, provider response timing, Figma Desktop rendering timing, real font/Auto Layout settle timing, real document-size/memory profile, or user-visible end-to-end duration. No latency claim can be made about a user's reported minutes-long operation.

The isolated benchmark itself says `inference: not measured; no authorized live request` and `render: not measured by this microbenchmark`. Local sub-millisecond normalization cannot explain or disprove long provider/host waits.

## Architecture-derived work counts (not timings)

- Structured generation makes three sequential section requests per screen, before bounded repair. `N` screens therefore have `3N` baseline model responses, with a possible repair response per section (`up to 6N`).
- Chat permits up to 100 model turns per task; it also has separate mutation, read-only, verification, executor, and checkpoint budgets. A high round/batch count must be recorded before attributing latency.
- The native QA caps of 5,000 nodes / depth 48 / 50,000 sibling comparisons bound work; reaching a bound causes incomplete coverage rather than a false pass.

These counts describe code limits. They do not predict how many requests a particular model/task will use.

## Required timing vocabulary for the live gate

Collect a correlated, sanitized trace with:

1. UI: total elapsed, time to first visible native node, first saved section, pause/resume periods.
2. Companion: request start, header wait, first delta, upstream completion, idle/wait time, event count, bytes, HTTP/terminal outcome.
3. Section pipeline: normalization/validation, draft persistence, native render/apply, final native verification, per-screen and total times.
4. Chat pipeline: model request/round count, native batches, mutation/read-only/verification counts, confirmed operations, retries/capacity waits, QA findings, and time to first/last confirmed native progress.
5. Host context: Desktop/plugin build identity, selected account-visible model slug, screen count, node count, and disposable document size band.

Do not record credentials, bearer tokens, raw responses, raw tool arguments, private canvas copy, or unrelated document content. Capture screenshots only from the disposable file and redact private material before sharing.
