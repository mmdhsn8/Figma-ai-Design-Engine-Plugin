# Incident and repair findings

## Performance incident: attribution is blocked

The exact diagnostic JSON for the Phase 11 performance question is not present in this checkout. Without the original request ID, model, UI timings, Companion request diagnostics, round/batch counts, or native timing, the audit cannot distinguish among:

- time waiting for upstream headers or first output;
- slow/incomplete/large model output;
- repeated sequential section requests or Chat continuation rounds;
- validation/repair/persistence work;
- native Figma operation/Auto Layout settling;
- a stale or mismatched running build.

No one of these is declared the root cause. The code's three sequential model calls per structured screen are a concrete latency multiplier in that workflow, not proof that they caused the missing incident.

## Separate documented native-layout report

[`autonomous-end-to-end-debug-report.md`](../autonomous-end-to-end-debug-report.md) records a different report: a 390×201 root for a mobile task and a nested 350 px frame with 330 px content inside 310 px available width. It describes source-level guards and a deterministic mock integration test. That is relevant context for bounded native QA, but it must not be substituted for the missing performance incident evidence.

## Current concurrent repair diff

When the audit resumed, a pre-existing diff changed the native-repair pipeline marker from v1 to v2, allowed old v1 checkpoint values to remain parseable, and added measured horizontal Auto Layout overflow handling/tests. The diff includes a 350 px row with 504 px required-width fixture and intentional horizontal scroll exclusion. This is a test fixture, not proof that a live user's exact geometry was 350→504 or that the live canvas was corrected.

Current-tree focused tests pass (14/14); the full suite passes (587/587) in the `--maxWorkers=1` rerun. This demonstrates the test contracts against mocks. It does not establish that Figma Desktop reflowed identically or that a live incident is resolved. The changes were concurrent work, later committed as `8088aa0`; they are not attributed to this audit.

## Historical report evidence

Existing Phase 5 stability reports contain other separately identified live and simulated incidents, including planning limits, tool-call boundaries, native QA measurement, and timeout accounting. Each report distinguishes supplied live evidence from code-derived causes and fixture reproduction. They are not combined into one causal narrative here. See [`stability-gate-root-cause.md`](../stability-gate-root-cause.md) and the linked prior phase reports.

## Minimum evidence to reopen a root-cause finding

Provide only a sanitized bundle from the disposable test:

- correlation/request ID; model slug; plugin/Companion build identity;
- start/header/first-delta/terminal/total timing and timeout category;
- Chat stage, rounds, batches, operation categories, confirmation state, and safe failure code;
- structured generation screen/section timings and request count;
- native render/verification time, bounded finding codes and measurement values;
- no prompt, response body, credential, bearer, private canvas text, or raw tool payload.

Then compare the same request against the exact source/built output and current test reproduction before assigning a cause.
