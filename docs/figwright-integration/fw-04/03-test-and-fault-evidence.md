# FW-4 — Test and fault evidence

## Commands run

| Command | Result |
|---|---|
| `npx vitest run tests/fw4-geometry-convergence.test.ts tests/messages.test.ts --maxWorkers=1` | Passed; 2 files, 14 tests. Includes strict expected-layout message checks. |
| `npx vitest run tests/fw4-geometry-convergence.test.ts tests/native-geometry.test.ts tests/native-visual-quality.test.ts tests/native-repair-recovery.test.ts tests/universal-design-chat.test.ts tests/design-program.test.ts tests/figma-tool-executor.test.ts tests/plugin-runtime-compatibility.test.ts tests/design-context.test.ts tests/fw3-native-batch.test.ts --maxWorkers=1` | Passed; 10 files, 213 tests. Covers FW-2/FW-3 regressions, geometry/RTL, runtime compatibility and root recovery. |
| `npm run typecheck` | Passed (`tsc --noEmit`). |
| `npm run lint` | Passed (`eslint . --max-warnings=0`). The first lint pass identified one unused error-counter increment in the new harness; it was removed before the passing run. |
| `npm test -- --silent=passed-only` | Passed; 46 files, 793 tests. `pretest` also built the default gate-off plugin/UI bundles. |
| `npx --no-install tsc -p tsconfig.companion.json` | Passed. |
| `npm run build` with FW-4 unset | Passed; default output omitted the `fw4-geometry-v1` gate string from both UI and plugin bundles. |
| `VITE_FW4_GEOMETRY=fw4-geometry-v1 npm run build` | Passed; opted-in output contained the gate string in both UI and plugin bundles. A gate-off build was run again afterward; final `dist` output is gate off. |
| `npm run verify:phase5` | Passed; manifest registration and built plugin/UI/Companion entrypoints verified. No Desktop/OAuth acceptance was run. |
| `node scripts/benchmark-fw4-geometry.mjs` | Passed; generated the 12-row F1/F3/F10 × gate-off/on × clean/injected-fault comparison. |
| `git diff --check` | Passed; Git emitted only its existing LF-to-CRLF working-copy notices. |

The targeted FW-4 suite has five tests: clean gate-off/on tree parity; injected sibling sizing/text-auto-resize reset with gate-on repair and second readback; independent post-adoption task-native readback detecting a changed mode and missing expected reference; retained-root/unrelated-node evidence when a setter fails; and FW-2 component-master preservation while the renderer converges sizing.

## Fault assertions

- With clean input, both feature settings created the same native tree and root identity shape. Gate-on performed no repair when actual properties already matched.
- The injected mock resets earlier sibling sizing to `FIXED` and changes program text from planned `HEIGHT` to the other accepted `WIDTH_AND_HEIGHT` mode after later sibling attachment. Gate off retains that prior behavior and its post-run sizing probe reports discrepancies. Gate on restores the planned modes and confirms them in another geometry readback.
- A failed correction does not clear or recreate the root. The task-owned root remains on the page with its original child, the user-owned sentinel remains byte-for-byte equal in the fake snapshot, and no node is removed.
- After a successful render, changing a title’s actual width sizing to `FIXED` causes the existing task-native readback to return `native_layout_sizing_mismatch`; a planned but absent logical reference changes report coverage to `incomplete`.
- Gate-on resume/replay in the fake host resolves the original root IDs and adds zero nodes. This validates renderer replay, not an actual process restart or ChatTask checkpoint reload.

## Local counters

Observed from the machine-readable harness (not Figma Desktop):

| Fixture | Renderer calls, off/on | Fake API function calls, off/on | Attached nodes, off/on | Clean gate-on repairs | Injected post-run discrepancies, off | Injected repaired nodes, on |
|---|---:|---:|---:|---:|---:|---:|
| F1 / 1 screen | 1 / 1 | 80 / 80 | 15 / 15 | 0 | 5 | 5 |
| F3 / 3 screens | 3 / 3 | 249 / 249 | 54 / 54 | 0 | 27 | 27 |
| F10 / 10 screens | 10 / 10 | 719 / 719 | 150 / 150 | 0 | 50 | 50 |

Renderer calls are direct calls to the production `renderDesignProgramLocal` function. UI bridge dispatches and bridge acknowledgements are `null`/unobserved. Each screen also has one task-native readback request and acknowledgement. Counts of geometry inspections include the renderer pass, task inspection, test probe and stable-root replay, so they are not the same as bridge messages.

Clean off/on runs had identical fake API function counts, layout-property writes, attached/created nodes, tree state and renderer replay outcome. In the injected lane, gate-on added one final renderer verification readback per affected screen. The local input/readback payload byte totals and all native IDs are in the JSON. Expectation payloads are larger: F1 2,841 bytes vs 319 off, F3 10,593 vs 963, and F10 32,354 vs 3,354 across the task’s per-screen readback requests.

The local harness reports one in-flight renderer write at a time. UI ChatTask checkpoint operations are explicitly uninstrumented; the fake plugin clientStorage is not the UI checkpoint store. Local JavaScript timings are one-run fake-host samples and are not used to claim speed or user-perceived latency. The F10 case reuses the synthetic FW-3 ten-screen title fixture; it is scale evidence, not a Desktop building-management visual-quality result.
