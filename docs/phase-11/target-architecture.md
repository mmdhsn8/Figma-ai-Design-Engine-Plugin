# Recommended target architecture (proposal only)

This proposal is a future direction, not an implementation. Keep current behavior until a user approves Phase 12 after the live baseline.

## Preserve three adapters

Keep separate entry adapters for:

1. **Offline JSON/batch import** — schema validation, preview, and deterministic native rendering; no model dependency.
2. **Structured generation** — design plan, section-scoped strict output, bounded repair, durable transaction, native append/render, and screen verification.
3. **Conversational Chat** — intent/stage plan, state-specific tool calls, incremental edits, idempotent executor ledger, and task-native verification.

Do not flatten the section transaction store and Chat operation ledger into one generic payload. Their commit/repair/replay semantics differ.

## Unify the observability contract first

Introduce one correlation envelope (proposal: `taskId`, `screenId`, `sectionId` or `chatStageId`, `requestId`, `operationId`, and build identifier) that can join existing sanitized diagnostics across UI, Companion, and plugin controller. Keep identifiers bounded and omit user content, tokens, raw arguments, and response bodies.

Emit phase events with monotonic timestamps for planning, upstream headers, first delta, stream completion, validation, persistence, native execution, native QA, and final UI completion. Store aggregate counts/histograms only where the existing storage/privacy contract permits. Do not log a second raw copy of generated designs merely to instrument them.

This creates the evidence needed to decide whether a delay is provider, orchestration, disk, Figma-native, or rendering work.

## Performance experiment after baseline

If live measurements show structured request fanout dominates:

- Prototype a **small fixed concurrency limit (start at 2)** for independent screens only.
- Keep each screen's identity → primary → supporting order, stable section idempotency keys, durable save before render, and per-section validation/repair.
- Apply explicit backpressure for upstream model capacity, Companion disk queues, and Figma plugin operation limits.
- Preserve cancellation, pause/resume, partial commits, ordering/placement, and exact reconstruction on restart.
- Keep serial execution as a user-selectable or automatic fallback; do not retry an active slow request merely to appear faster.

Do not combine all sections into one large response as the first optimization. That may cut request count but reduces incremental native progress and increases output size, validation/repair scope, and loss window. Benchmark both only if the baseline supports the experiment.

## Quality contract alignment

Share a stable finding identity/report vocabulary where useful, but retain distinct deterministic checks:

- design-output validation checks requested visual/content composition and schema;
- native QA checks observed Figma geometry, hierarchy, ownership, clipping, contrast, and coverage.

Never turn an intent-sensitive visual heuristic into an automatic native mutation. Keep no-progress detection and fresh reinspection after a confirmed repair.

## Required experiment gates

1. Capture serial structured-generation and Chat baselines with the same disposable file, screen count, model, and build.
2. Add scripted-delay and fault-injection tests that prove concurrency ceilings, out-of-order completion handling, replay safety, partial persistence, cancellation, and capacity wait behavior.
3. Compare wall-clock distribution and time-to-first-native-progress over repeated runs; exclude warm-up and report median/tail spread, not just a best run.
4. Verify actual native IDs, screenshots/layers, visual quality, and no duplicate content in Desktop.
5. Roll back to serial execution if errors, ambiguous commits, rate-limit failures, or tail latency worsen.

No dependency addition is justified by the audit evidence.
