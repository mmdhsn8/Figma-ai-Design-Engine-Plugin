# FW-5B tests and local evidence

## Commands run

| Command | Result |
|---|---|
| `npm run typecheck` | Passed (`tsc --noEmit`). |
| `npm run lint` | Passed (`eslint . --max-warnings=0`). |
| `npm test -- --silent=passed-only` | Passed: 47 files, 820 tests. Its `pretest` built UI and plugin with the default gate-off settings. |
| `npx tsc -p tsconfig.companion.json` | Passed; emitted current Companion TypeScript output. |
| `npx vitest run tests/plugin-runtime-compatibility.test.ts --silent=passed-only` | Passed: 1 file, 2 tests. The full test suite also includes these tests. |
| Gate-on `npm run build` with `VITE_FW5_VISUAL_QA=fw5-visual-qa-v1` and `VITE_FW5_VISUAL_QA_MODE=review+bounded-repair` | Passed: UI and plugin bundles built. |
| Gate-off/default `npm run build` with those variables unset | Passed: UI and plugin bundles built. Build output sizes are recorded by the build command; no Figma operation was performed. |
| `npm run verify:phase5` | Passed: manifest registration and current UI/plugin/Companion entrypoints verified; Companion booted on ephemeral loopback. Script reported no OAuth or Desktop acceptance. |
| `node scripts/benchmark-fw5-visual-qa.mjs` | Passed: local fake-runtime F0/F1/F3/F10 gate comparison; machine-readable result is [`../fw-05/04-gate-off-on-metrics.json`](../fw-05/04-gate-off-on-metrics.json). |
| `git diff --check` | Passed with no whitespace errors; Git reported existing LF-to-CRLF normalization warnings for Windows working-tree files. |

The focused contract/integration run before the final added owner-to-adapter regression passed 138 tests across three files. The final repository run above is the authoritative total. A targeted gate-on owner/adapter/repair/recheck/checkpoint test also passed in `tests/fw5-visual-qa.test.ts` before the full run.

## Tested seams and limits

- The Companion route test uses a fake OAuth/OIDC and fake Responses transport. It asserts `input_text`/`input_image`, strict structured output, no tools, `store:false`, exactly one provider invocation, unsupported-capability mapping without retry/route change, scope/model/session enforcement, same-account refresh, malformed PNG rejection and Stop cancellation.
- The client and App adapter tests use injected local fake fetch, explicit affirmative/declined consent, account-visible model checks, root/session revalidation, and correlated response parsing. Greeting tests assert F0 does not request canvas context, capture, consent or reviewer access.
- The strengthened task-owner regression connects the production FW-5B adapter/client to the existing task owner and fake local Companion response. It follows image revision 1, typed sizing issue, one repair, fresh readback, image revision 2 with a second consent, final review and checkpoint. It asserts one repair, two captures, stable root ID, final checkpoint, and no PNG bytes in saved task data. This is a **stubbed local integration test, not a provider request**.
- Native mutation/capture uses the repository's fake Figma API. No real document, protected Test Shop file, provider endpoint, or Figma Desktop was used. The synthetic provider pass cannot establish real model capability or visual accuracy.

## Local capture benchmark interpretation

The deterministic FW-5 harness executes the same fake Figma fixture with capture gate off/on; it measures existing capture behavior, not this provider review request. Root/tree equivalence was true for F1/F3/F10. The additional PNG capture adds one plugin executor dispatch and three Figma API operations on F1, three dispatches/nine API operations on F3, and ten dispatches/thirty API operations on F10. Local harness times varied by scenario and are not comparable Desktop rendering or user latency. Checkpoint counts are `null` in this plugin-side benchmark; checkpoint behavior is verified by task-owner tests. Full counters and raw root IDs are in the linked JSON.

| Scenario | Dispatches off/on | Figma API ops off/on | Local harness ms off/on | Tree/root equivalent |
|---|---:|---:|---:|---|
| F1 | 1 / 2 | 54 / 57 | 57.06 / 58.36 | Yes |
| F3 | 3 / 6 | 162 / 171 | 73.29 / 50.79 | Yes |
| F10 | 10 / 20 | 459 / 489 | 141.40 / 170.70 | Yes |

These counters provide no dispatch reduction hypothesis or speed claim. In this harness gate-on intentionally adds capture work; the new Companion image review has no live timing measurement.
