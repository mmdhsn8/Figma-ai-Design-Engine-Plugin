# 02 — Measurement contract

## Evidence labels

- LIVE: directly observed in an approved Figma Desktop run with native readback and a screenshot.
- LOCAL/MOCK: a deterministic local simulation. It never counts as a live screen or latency result.
- SOURCE: established by reading a pinned source revision or documentation.
- NOT MEASURED: unavailable or not observed. This string is different from numeric zero.
- NOT REVIEWED: no human visual score exists.

The only run status values are PASS, FAIL, BLOCKED, and PARTIAL. Preserve every failed or partial event in order. Do not remove a failed run from aggregates.

## Sanitized run record

Each run record is one JSON file created under runs/. It includes:

- schema version, runId, fixtureId, variant, status, principal failure category, start date, and evidence level;
- project code revision, local plugin build SHA, Figwright release SHA/version when applicable, plugin/MCP build identity, provider/model slug visible to the operator, and authorized file/page label;
- ordered screens with stable screen IDs, actual native root IDs only when read back, per-screen node and component-instance counts, QA coverage, and human-review state;
- sanitized ordered events with run correlation ID, stage, event name, outcome, bounded error code, optional opaque request IDs, measured duration, event counts, and process correlation ID;
- separate measurements for setup, provider wait, planning, persistence, native execution, verification, time to first confirmed editable screen, total wall clock, provider calls/rounds, MCP calls, native batches, exact native nodes, components/instances, geometry/QA, and recovery.

Do not store raw prompts, model bodies, tool arguments, tokens, cookies, credential data, account IDs, or private canvas text in run JSON. Fixtures contain synthetic benchmark briefs and are stored separately.

## Timer source and boundaries

The collector's span command uses process.hrtime.bigint() inside one Node process and records wall-clock endpoints only for human correlation. It does not subtract idle time or provider stalls. Use one span from task start to the first screen whose editable native root is confirmed by readback, and another from task start through final verification. If separate timer processes are used, they share the runId but remain separate monotonic origins; do not compare their wall-clock values as if they were one clock.

Use the application's own safe trace for internal provider and native stage timings where available. For our Universal Engine, existing traces use performance.now() within the plugin UI process and report separate request/provider/native-readback fields. Figwright's MCP calls and plugin Activity/Debug panel may expose different timing boundaries. Record each source and keep the system-level experience separate from normalized execution-only timing. Mark any unjoinable cross-process timestamps.

Record setup, user interaction, provider wait, planning, validation, persistence, native write, readback, screenshot/review, and manual intervention separately when observable. Never silently subtract a stall. First editable screen means a unique requested screen root with editable native layers confirmed by readback, not a model response, mutation acknowledgement, or mock tree.

## Counts and derived values

- Confirmed root count is the number of distinct native root IDs with live readback evidence. Do not derive it from requested screens, operation count, or mutation acknowledgements.
- Native node count is obtained from a fresh native tree inspection for the approved page/root. Mutation counts are not substitutes.
- Component-instance count is based on node inspection; flattened artwork is not a component instance.
- Tool/request counts come from observed client/plugin/provider logs and must identify their source. Do not equate MCP calls, provider requests, and native batches.
- QA coverage is COMPLETE only when the expected checks were actually executed and recorded. An unmeasured geometry or contrast field is NOT MEASURED, not zero and not passed.
- Unique editable screens, bounds, overflow, scroll, font readiness, touch targets, contrast, native IDs, and component linkage are reported independently.

## Aggregation

The collector summarizes individual run JSON files and groups only matching fixture and variant. Keep each failed run visible. Report raw samples. Publish median/range only when at least three comparable successful runs exist; with fewer than three, report INSUFFICIENT SAMPLE for distribution claims. Do not publish p95/p99 from three runs. Averages cannot excuse safety failures.

The harness supports diagnostics-only validation without network, Figma, model calls, or file writes. The live timer/collector never controls Figma and never issues provider calls.
