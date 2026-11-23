# FW-6 — Fault injection and verification evidence

## Fresh command results

| Command | Result | Scope / note |
|---|---|---|
| `npm run typecheck` | Passed | `tsc --noEmit` after final source/test changes |
| `npm run lint` | Passed | `eslint . --max-warnings=0` |
| `npm test -- --silent=passed-only` | Passed: 47 files, 823 tests | The first attempt's pretest build hit OS `Access is denied` on `dist/ui-bundle.js` outside the writable repo root. The same command was retried with scoped repository-output write authorization and passed; build output remained gate-off. |
| `npx --no-install tsc -p tsconfig.companion.json` | Passed | Companion emitted local `dist-companion` TypeScript output |
| Gate-on `npm run build` | Passed | `VITE_FW2_CONTEXT=fw2-context-v1`, `VITE_FW3_NATIVE_BATCH=fw3-native-batch-v1`, `VITE_FW4_GEOMETRY=fw4-geometry-v1`, `VITE_FW5_VISUAL_QA=fw5-visual-qa-v1`, `VITE_FW5_VISUAL_QA_MODE=review+bounded-repair`; UI 1,611.11 kB, plugin 2,309.88 kB |
| Gate-off `npm run build` | Passed | All FW flags unset; UI 1,582.80 kB, plugin 2,265.24 kB; this was the final generated build |
| `npm run verify:phase5` | Passed | Registered manifest and current entrypoints verified; compiled Companion booted on ephemeral loopback; script explicitly reports no OAuth or Desktop acceptance |
| `npm exec --offline -- vitest run tests/plugin-runtime-compatibility.test.ts --silent=passed-only` | Passed: 1 file, 2 tests | Offline sandbox compatibility suite |
| `git diff --check` | Passed | Git printed CRLF normalization notices for modified Windows files; no whitespace error |

## Repeated race evidence

The focused command was run in 10 separate Vitest processes. Every iteration passed all five selected cases (50 individual case executions total):

```powershell
npx --no-install vitest run tests/universal-design-chat.test.ts tests/chat-task.test.ts tests/fw5-visual-qa.test.ts tests/companion-server.test.ts -t "fences task completion when Stop arrives during the final checkpoint write|keeps an explicit Stop authoritative when a valid multi-screen outcome arrives late|keeps the single-export slot occupied while a timed-out native export is still resolving|keeps the first screen alive during .* while its sibling refreshes the same OAuth session" --silent=passed-only
```

The last expression is parameterized for both `headers` and `stream`, so each iteration covers same-session token refresh at both timings. `fw5-visual-qa.test.ts` uses fake timers (advance 40 ms then 210 ms) rather than a real sleep. This is repeatability evidence for those selected local regressions, not a statistical reliability claim.

## State assertions, not only return values

- Greetings (`hi`, `hello`, `سلام`) assert no model planning, context read, legacy execution, native render, checkpoint save, or node change.
- The new final-checkpoint Stop test pauses the completed-snapshot save, asserts the live task is still `running` and has no success text, presses Stop, then resolves the pending save. It asserts the final in-memory and durable task states are `stopped`, the previously verified root remains attached under the same page with its ID, and the task text no longer claims completion.
- The legacy handoff Stop test preserves two previously verified screen roots/IDs, rejects post-Stop progress and a valid late provider outcome, and asserts no completed task/checkpoint.
- Existing Universal fault tests retain attached roots on geometry/readback failure, refuse missing/moved roots, reconcile lost ACKs by stable ID, Resume without duplicate roots, preserve valid dispatched siblings after preparation failure, and keep root IDs stable after simulated plugin restart.
- Companion fake HTTP/SSE tests cover same-account OAuth refresh before headers and mid-stream, explicit Stop, revoked refresh, disconnect and restart. No live session is exercised.
- The new F10 Persian RTL task runs through the Universal owner and fake native renderer; asserts all ten planned screen IDs/order, RTL program locale/text alignment, ten unique attached roots, ten renderer/readback calls, 116 mock native nodes, 58 save-adapter calls and zero duplicates. The measured mock time and IDs are in the local benchmark JSON.

## Limits of evidence

Tests use Vitest fakes and the repository mock Figma API. No provider/model request, OAuth account, screenshot transmission or Figma document was used. The Universal scheduler benchmark measures mock adapter calls and save-adapter invocations; actual serialized UI↔plugin message counts, plugin API method totals and checkpoint storage readback counts are `null` there. Existing plugin-only API/gate measurements are in [FW-4 local metrics](../fw-04/04-local-before-after-metrics.json) and [FW-5 gate metrics](../fw-05/04-gate-off-on-metrics.json), and must not be combined as same-run end-to-end counters.

`manifest.json` and its plugin ID/entrypoints had no diff. Git branch remained `main` at `8378cc4`; modifications are uncommitted and no commit/push was performed. No Figma file, protected document, History, checkpoint storage, OAuth credential, user data, or remote was modified.
