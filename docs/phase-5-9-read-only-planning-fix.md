# Phase 5.9: read-only Charm discovery failure

Task reported: `chat-1794225947896-zifbwq` (2026-11-09).

## Evidence and limits

The supplied diagnostic records four completed model rounds: two classified as
inspection and two as execution, two native read-only operations, no mutations,
no planning rounds, no schema-correction rounds, and no saved stages. The UI
shows `Canvas intent is already checkpointed and cannot be changed.`

That message is thrown locally when a classifier call reaches an already-saved
intent. It is not a transport error or a plan-schema rejection. `UNPLANNED` used
to remain the lifecycle for every task without mutation stages, including
read-only tasks. The generic diagnostic then called this `planning_failed` and
`plan_not_saved`, even though inspection does not require a mutation plan.

The likely four-round sequence is:

| Round | Reconstructed request | Local outcome |
| --- | --- | --- |
| 1 | Classify canvas intent | Intent saved; lifecycle previously stayed UNPLANNED |
| 2 | Read-only discovery/inspection | Native result checkpointed |
| 3 | Read-only discovery/inspection | Native result checkpointed |
| 4 | Classify canvas intent again | Existing-intent guard throws before native work |

This is a reconstruction, not a recovered live transcript. The diagnostic does
not contain the actual four call arguments, the two tool outputs, or the saved
intent value. No raw transcript/checkpoint for this task is available in this
checkout. It cannot establish whether live discovery found Charm, whether the
second read-only call inspected nodes or repeated discovery, or whether the
saved intent was correct. No plan attempt or schema failure is recorded; that
does not justify inventing one. Fresh diagnostics now include saved intent and
a bounded, content-free per-round tool/outcome/schema-code trace.

## Root causes reproduced in code

1. Successful pre-plan tool results unconditionally instructed the model to
   `Continue to plan_canvas_task now`, contradicting inspect/explain intent.
2. The UNPLANNED tool set kept offering both classification and mutation planning
   after read-only intent was saved. An identical classifier replay was fatal.
3. Every next tool-call response replaced the recent transcript. The general
   checkpoint retained operation summaries but not earlier discovery results.
   Discovery reached the immediate next model request, but names, locations,
   refs and geometry could disappear on subsequent turns or Resume.
4. Discovery scanned up to 100 frames but returned at most eight, without a way
   to retrieve the rest. This could not support inspecting all bounded matches.
5. Read-only prose completion had no native-evidence gate.

There is **no four-round pre-planning cutoff in the current source**. The existing
overall 100-round limit, two schema corrections, native operation capacities,
checkpoint limits, and repeated-error guards were not increased.

## Fix

- Inspect/explain enter `INSPECTING`, including restored older UNPLANNED tasks.
  This lifecycle offers only discovery and native inspection over HTTP/SSE.
  Classifier and plan instructions now respect checkpointed read-only intent.
- Identical intent/target replays acknowledge the checkpoint. A changed intent
  or target remains rejected; saved state is never silently reclassified.
- The runner independently rejects planning/mutation calls for read-only intent,
  even if a model bypasses tool availability. The saved-plan replay exception
  does not apply to INSPECTING.
- Compact discovery/native evidence survives subsequent rounds and reloads.
  Native node names and geometry take precedence over older discovery details.
  Completion checks page-scoped refs and all returned inspectable matches.
  A discovery result with no matches can finish as a no-match report.
- `offset`/`nextOffset` expose the remaining results of the same bounded scan.
  Scan truncation, result-window truncation and ambiguity remain explicit.
  Multiple matches do not block inspecting all frames; single-target edit
  ambiguity gates remain intact.
- Read-only progress, failure phase and completion diagnostics no longer require
  a mutation plan. Discovery/inspection errors receive read-only recovery advice.

Discovery still records logical-reference plugin metadata. “Read-only” here
means zero canvas mutations: no visual edits, node creation/deletion/reparenting,
selection changes or viewport focus. Cross-page inspection restores the original
page. Existing chat/task storage is retained; new trace fields default for older
checkpoints.

## Verification

Mock regressions reproduce the exact fourth-round checkpoint error before the
fix, resume a saved fourth-round pending classifier, and complete with zero
mutations and no plan. Additional tests cover wrong-page/uninspected evidence,
no-match/truncated reports, conflicting intent, forbidden plans/mutations,
HTTP/SSE tool availability versus schema failures, and 12/100 real-executor
mock frame inspections across two pages and multiple result windows. Native
IDs, hierarchy, geometry, fills, selection and original page remain unchanged.

These are mock/API/build checks, **not live Figma Desktop acceptance**. After
rebuilding both components, restart the Companion and reopen the registered
plugin to load matching artifacts. Resume the saved task without clearing
history, or run the acceptance request in a new chat. Confirm the visible report,
zero mutations, correct page/frame locations, and any reported scan limits in
Desktop before declaring live acceptance.
