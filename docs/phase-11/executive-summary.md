# Phase 11 — Executive summary

## Conclusion

The repository has three working but intentionally different paths to native Figma content: deterministic JSON import, structured AI generation, and conversational Chat. They share validation/rendering and safety mechanisms in places, but they do not share one end-to-end execution pipeline. The most visible architecture-level latency exposure is the structured generator's **three sequential model requests per screen** (identity, primary content, supporting content), plus a bounded repair request when needed. Chat has a different cost profile: intent/planning, multiple model rounds, native tool batches, and native verification.

There is not enough live evidence to say which path is slow for the reported user, whether provider latency dominates, or whether Figma Desktop rendering is a bottleneck. Local normalization and mock rendering are fast in these fixtures, but they are not proxies for network inference or the Figma host. Therefore this is **AUDIT PARTIAL**, not a performance certification or a fix report.

## What is established

- **Static/source:** the registered manifest points to this checkout's plugin/UI outputs. The JSON multi-screen importer has a dedicated schema and renderer route. Chat is a stateful tool-calling route through the local Companion and native executor. The structured generator uses durable, ordered section transactions.
- **Local/mock:** typecheck, lint, Companion typecheck, full automated suite (587 tests across 34 files, serial rerun), focused native-repair suite (14 tests), and the current compiled-entrypoint/registration verifier passed. The deterministic Phase 5 fixture accepted 200/200 samples.
- **Measured locally:** the 2,815-byte fixture parsed in 0.0255 ms and normalized/validated in 0.2563 ms average over 200 iterations in the isolated run. The script explicitly does not measure inference or Figma rendering.
- **Not established:** live first-token/total model latency, actual Figma native rendering/settling time, visual quality, and performance on a user's document or machine.

## Recommendation

Do not merge Chat with structured generation or replace JSON batch import. The user has authorized a controlled disposable-file Desktop comparison, but it is blocked until this session has legitimate Desktop control and can verify the active model. If live evidence confirms request fanout dominates structured generation, a later implementation phase may prototype a small concurrency limit across independent screens while preserving section order, durable commit-before-render, cancellation, idempotency, and resource limits.

Keep Phase 12–17 unimplemented until separately approved. The exact approval requested is in [the acceptance gate](acceptance-and-approval.md).
