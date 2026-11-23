# Local evidence (not a live comparison)

The tests exercise production extraction, controller, bridge, request validation, existing Universal scheduler and native adoption/geometry with a Figma host mock. `tests/design-context.test.ts` tests scope, cancellation/late responses, deterministic digest, privacy, malformed input, remote/variant ambiguity, depth/width/serialization and stale/deleted refs. `tests/chat-task.test.ts` covers read-only edit projection only under Universal, and prevents treating that projection as authorization to replace an existing frame.

`tests/universal-design-chat.test.ts` runs the same generic source path for:

| Screens | Fixture | Local assertion |
| --- | --- | --- |
| 1 | Persian RTL learning, clean context | No fabricated resources; editable layout completes. |
| 3 | Persian RTL service booking | One scope capture; each role has a real mock native instance of the selected local master plus an actual style ID and variable alias; no master removal. |
| 10 | Held-out ceramic-kiln calibration | One context capture, ten scheduled programs and verified roots, no kiln-specific engine template. |

All three assert request validation with the actual Companion input validator and 56 KiB input envelope; mock provider rounds are 3/5/12 (intent + plan + each screen). Service-booking source master/style/variable are synthetic. Figma does not infer reuse from a similar name or color alone: host identity and the actual instance/master, style ID or variable alias are checked. Full native candidate UX and real provider behavior are not evaluated by these tests.

FW-1 cross-check: `fixtures/F0.json` requires no Canvas tasks/writes/checkpoints for greetings; the opt-in route checks all three without touching History. Its 1/3/10 screen-count and task-ownership expectations are reflected in local assertions, but the briefs differ from FW-1 and no F1/F3/F10 live benchmark was performed. The FE expectation to preserve the verified edit root is retained.

Local results (2026-11-22):

- `npm test -- --silent=passed-only`: 778 tests passed in 44 files, including the default plugin/UI build and sandbox runtime check.
- With `$env:VITE_FW2_CONTEXT = 'fw2-context-v1'`, `npm run build` and `npm exec --offline -- vitest run tests/plugin-runtime-compatibility.test.ts --silent=passed-only`: 2 tests passed; the compiled plugin accepted an authorized empty scope with `Intl` absent. Default artifacts were then rebuilt with the gate removed.
- `npm run typecheck`, `npm run lint`, and `npx --no-install tsc -p tsconfig.companion.json`: passed.
- `npm run verify:phase5`: registered development manifest matched this repo, main/UI artifacts passed, and compiled Companion answered its ephemeral loopback health check without provider/OAuth calls.

Live model calls, screenshots, timing and visual scores: **NOT MEASURED**.
