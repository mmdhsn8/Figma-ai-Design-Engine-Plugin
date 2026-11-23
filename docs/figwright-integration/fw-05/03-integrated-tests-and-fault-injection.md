# FW-5 local verification

The FW-5 suite contains 18 tests. It drives the Universal task owner through the actual task-native bridge and fake Figma executor for a PNG review. A separate round trip drives the actual repair bridge into the executor, verifies the target property changed, checks the original root and sentinel, rejects a duplicate, and captures the linked second PNG. The task owner scenarios exercise recheck checkpoint transitions, a remaining unsupported finding, and a failed second capture. Fake PNGs and scripted reviewer responses exercise the plumbing only.

Coverage includes gate OFF, absent consent, unavailable review, response validation, corrupt headers and truncated PNG framing, byte limits, stale or moved roots, export timeout and capacity, cancellation before export, replay, and metadata-only checkpoint writes. Tests cover FW-2/FW-4 gates together and include synthetic RTL with Latin and numbers. Provider refresh, real image quality, on-host cancellation races and the complete Desktop Stop/Resume sequence remain live items.

Run `node scripts/benchmark-fw5-visual-qa.mjs` to regenerate [the metrics](04-gate-off-on-metrics.json).

| Fake scenario | Executor dispatches OFF → ON | Exports OFF → ON | PNG bytes ON |
|---|---:|---:|---:|
| F1 | 1 → 2 | 0 → 1 | 70 |
| F3 | 3 → 6 | 0 → 3 | 210 |
| F10 | 10 → 20 | 0 → 10 | 700 |

The capture-only benchmark uses the same programs and fake runtime. Tree shape and exact root IDs match. Peak in-flight count is one. There are no reviewer calls or repairs in this benchmark. Direct executor dispatches and native inspection counts are recorded separately. Checkpoint I/O counts and browser heap high-water are unknown in this harness. The JSON records local elapsed time and fake API calls.

## Commands and observed results

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test -- --silent=passed-only` | 811 passed in 47 files on the final run. The gate-OFF pretest build passed |
| `npm run build` with FW-5 review+bounded-repair and FW-4 ON | Passed. The subsequent OFF build left `dist` default OFF |
| `npx --no-install tsc -p tsconfig.companion.json` | Passed |
| `npm run verify:phase5` | Passed using the local loopback verifier |
| `npx --no-install vitest run --silent=passed-only tests/plugin-runtime-compatibility.test.ts` | 2 passed, including the built-plugin sandbox without Intl |
| `npx --no-install vitest run --silent=passed-only tests/fw5-visual-qa.test.ts` | 18 passed |
| `git diff --check` | Passed |

An earlier run caught the failure-state mismatch in the second-capture test and one timing-sensitive scheduler assertion. The failure-state mapping was fixed. The scheduler was not changed and that assertion passed on later runs.
