# FW-3 — tests and regression evidence

## Added source tests

`tests/fw3-native-batch.test.ts` covers the default-off feature gate; deterministic one-screen plan ordering and tagged backward references; RTL ordering and mixed fixed/hug/fill metadata; text/font metadata; strict request serialization, parsing and receipt round-trip without `Intl`; unknown fields/ops, delete, code strings and prototype pollution; operation/creation/payload limits; missing/forward/cyclic/cross-batch references; stale task/page/root/checkpoint/batch and unauthorized parents; explicit fallback for references and unsupported vectors; receipt status/stage truthfulness; and the `01 — Welcome` attached-root retention regression with an unrelated existing node.

The tests assert native mock tree and ownership state for the retained-root case. They do not claim batch execution, crash consistency, stop fencing or native readback receipts for the planner: those components have not been wired.

## Commands and results

All commands below completed successfully in this checkout:

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | Passed (`tsc --noEmit`). |
| `npm.cmd run lint` | Passed (`eslint . --max-warnings=0`). |
| `npm.cmd test -- --silent=passed-only` | Passed: 45 test files, 788 tests. The `pretest` build also passed. Phase 6 log lines are mock harness output; no provider request was made. |
| `npm.cmd run build` | Passed; UI and plugin bundles built (184 and 168 modules transformed). |
| `node_modules/.bin/tsc -p tsconfig.companion.json --noEmit` | Passed Companion TypeScript compile-only check. |
| `npm.cmd run verify:phase5` | Passed manifest/entrypoint verification and ephemeral loopback Companion boot; no OAuth or Desktop acceptance. |
| `node_modules/.bin/vitest run tests/plugin-runtime-compatibility.test.ts --maxWorkers=1` | Passed: 1 file, 2 tests. |
| `node_modules/.bin/vitest run tests/fw3-native-batch.test.ts --maxWorkers=1` | Passed: 1 file, 10 tests. |
| `node scripts/benchmark-fw3-native-batch.mjs` | Passed F1/F3/F10 parity and replay checks; generated `03-local-benchmark.json`. |

The build can update generated `dist/` outputs. These are generated local artifacts only; the protected Test Shop file, user Figma documents, credentials, OAuth state and user storage were not touched. No provider calls, dependency downloads or commits were made. The workspace already contained uncommitted FW-2 changes before FW-3 work; they were preserved.
