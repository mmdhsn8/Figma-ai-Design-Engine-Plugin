# Phase 12 test evidence

Evidence is local and mocked unless explicitly labeled otherwise. No live provider call or Figma Desktop write was performed.

## Final local gates

| Command | Result |
|---|---|
| `npx vitest run tests/chat-generation.test.ts tests/chat-task.test.ts tests/figma-tool-executor.test.ts --maxWorkers=1 --reporter=dot` | Passed: 188 tests across 3 files |
| `npm run typecheck` | Passed |
| `npx tsc -p tsconfig.companion.json --noEmit` | Passed |
| `npm test -- --reporter=dot --maxWorkers=1` | Passed: 605 tests across 35 files |
| `npm run lint` | Passed with a component-scoped `react-hooks/purity` suppression. Baseline App lint was clean; the new deferred task callback makes the rule follow event-only helper code as if it were render work. See the comment beside `App` in `src/ui/App.tsx`. |
| `npm run build` | Passed; built `dist/ui.html` and `dist/plugin.js` |
| `npx tsc -p tsconfig.companion.json` | Passed; refreshed the ignored compiled Companion output |
| `npm run verify:phase5` | Passed: registered manifest and current plugin/UI/Companion entrypoints verified; no OAuth or Desktop acceptance performed |
| `git diff --check` | Passed; Git reports only its normal LF-to-CRLF working-copy notices |

## Coverage added or extended

- Persian/English natural-language create parsing; explicit 1, 3 and 10 screen plans; stable order and RTL/mobile viewport; unrelated app domains; edit/multi-device exclusion.
- Invalid count, duplicate identity/name, invalid dimensions, unknown/cyclic dependency, unsupported component references and oversized payload rejection.
- A mocked three-screen Chat task through the actual `createDraftStore`, nine durable section transactions, the existing native controller/renderer, full-screen native verification, task root tagging and cross-workflow checkpoint. It reloads the draft between a durable section save and native render, checks exact model pinning, and verifies no duplicate nodes after a lost native acknowledgement.
- A task-native inspection test restores a verified generated screen's deterministic logical ref after executor state reload.
- Fault paths cover provider timeout, malformed section, persistence failure, cancellation/reload, changed-plan conflict, native acknowledgement loss after possible commit and missing native verification for a planned screen.

The full suite emits synthetic renderer measurements from unrelated offline fixtures. Those values are not provider latency, are not a Chat handoff benchmark, and are not cited as Phase 12 performance evidence. Provider timing, time-to-first-native-screen and live native quality remain **NOT MEASURED**.
