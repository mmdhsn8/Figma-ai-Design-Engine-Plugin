# Test and build evidence

Baseline HEAD `e86c8d678168a9add1bce0b9f8eee404b175c95f`. The checkout already had 25 modified tracked files and untracked Phase 13 and 13.1 reports, the composition module and its test. Plugin ID `1574493506249715820`. The build verifier confirmed registration points to this checkout. The loaded Desktop runtime was not inspected.

| Command | Result |
|---|---|
| `npx vitest run tests/design-generation.test.ts --maxWorkers=1` | 42 passed during implementation |
| `npm run qa:native-repair` | 15 passed |
| `npm test -- --silent --maxWorkers=1` | 639 passed across 36 files in 102.70 s |
| `npm run typecheck` | Passed |
| `npx tsc -p tsconfig.companion.json --noEmit` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npx tsc -p tsconfig.companion.json` | Passed |
| `npm run verify:phase5` | Passed |
| `git -c core.safecrlf=false diff --check` | Passed |

| File | UTC write time | SHA-256 |
|---|---|---|
| `manifest.json` | 2026-11-08T07:39:57Z | 01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A |
| `dist/plugin.js` | 2026-11-15T11:00:38Z | 773E0D8501DFA083966A6A11A54B26A6356E6B1B114F84A6505C3B18B9F1065F |
| `dist/ui.html` | 2026-11-15T11:00:32Z | 2818A4F83F032B44099D31C99E6B80BF68308D1597276B3D8F548431C4B70E3C |
| `dist-companion/shared/design-generation.js` | 2026-11-15T11:01:03Z | 29611FC3432C2C1269CF38D5AB894D08F64C6068797D3C1B799883B1063B25A2 |
| `src/shared/design-generation.ts` | 2026-11-15T11:00:15Z | 04DD9B7A3C163F9A41E72E3AB496A473054CAF3886CF37C0D4DFE8606400BBFE |
| `src/ui/App.tsx` | 2026-11-15T10:59:30Z | 824871738488A7B108D4B029EEBD823627223161EF90C02866C16C1A59282CF0 |

The synthetic regression covers 32, 36, 40, 43.9, 44 and 48 px controls in both axes, an icon control, Persian copy, section budget, legacy behavior and design idempotence. Existing tests cover scroll, draft recovery, structured Chat handoff and native QA. The mocked Chat handoff uses a health domain fixture. A live-equivalent three-screen storefront with the exact failed provider output was unavailable.
