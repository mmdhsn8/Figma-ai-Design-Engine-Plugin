# FW-6 — Limitations and FW-7 handoff

## Remaining limitations

- Figma Desktop runtime, actual native geometry/typography/Persian shaping, close/reopen Resume, and authorized F1/F3/F10 workflows are **LIVE PENDING**.
- No live OAuth account, provider request, model, screenshot upload or image capability was used. FW-5B image support for the selected account/model is unknown and requires separate per-image consent.
- The integrated Universal fake harness measures `renderProgram`/`inspectProgram` adapter calls and task save-adapter calls, but does not observe actual serialized UI↔plugin messages, native Figma API method totals, checkpoint readback totals, high-water memory, or real wall time. The existing FW-4/FW-5 plugin-only fake-runtime artifacts provide separate native API counters; they do not fill that same-run integration gap.
- The scheduler timing comparison is serial max-1 versus existing max-2 under deterministic fake provider delays. It is not an FW-6 speedup, gate-on/off A/B, provider latency estimate or Desktop rendering estimate.
- A checkpoint write already sent across the bridge cannot be physically cancelled. The owner rechecks Stop after acknowledgement and writes the stopped state, but a crash before that compensation remains a narrow ambiguous window.
- FW-3 remains planner-only. No native batch executor was activated. The renderer still handles one screen request at a time under the task owner.
- The completion and Stop error messages are corrected in English; broader localization of diagnostic text is not part of this reliability patch.

## FW-7 handoff (not started)

FW-7 may add targeted edit intelligence only by extending the existing `ChatTask`/edit owner, saved target evidence, task-scoped operation IDs, and native readback/reconciliation. Preserve the existing authorization scope, page/selection revalidation, checkpoints, Stop fences, and task-owned root rules. Do not infer permission to edit from a general chat request, broaden FW-5 visual repair, activate FW-3 batching, or create a second write ledger. Begin FW-7 only as a separate task after FW-6's live safety acceptance is authorized and recorded.
