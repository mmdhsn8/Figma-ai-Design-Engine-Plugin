# Test and build evidence

Baseline HEAD `e86c8d6`, with pre-existing dirty source and untracked Phase 13 reports. The manifest verifier matched this checkout and plugin ID 1574493506249715820. The endpoint on localhost:1455 responded with the generation-v1 draft contract, PID 232 when inspected. That compatibility header does not identify the exact loaded Companion binary. The loaded Desktop bundle also remains unverified.

| Command | Result |
|---|---|
| `npx vitest run tests/native-repair-recovery.test.ts --maxWorkers=1` | Initial mock lacked Frame.findAll. Added the mock surface and reran: 5 passed. |
| `npm run qa:native-repair` | 16 passed after the final type guard. |
| `npm test -- --silent --maxWorkers=1` | 643 passed across 36 files in 82.87 s. |
| `npm run typecheck` | Passed after fixing initial SceneNode union errors by checking layout property availability. |
| `npm run lint` | Passed. |
| `npx tsc -p tsconfig.companion.json --noEmit` | Passed. |
| `npx tsc -p tsconfig.companion.json` | Passed. |
| `npm run build` | Passed. |
| `npm run verify:phase5` | Passed. |
| `git -c core.safecrlf=false diff --check` | Passed. |

| Artifact | SHA-256 |
|---|---|
| manifest.json | 01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A |
| dist/plugin.js | 393D24664CB8522707BFA93205D7E2A783724E9BAA95479969545DEC4EEC2F1A |
| dist/ui.html | 1468E708673497576DE2D4827F8B084F8B62EBEB573BB6C7B75C225DC5910CDC |
| dist-companion/companion/server.js | 1827EE92A103E91813830FEF7B3F756CC2F5B9B40C88AD39EC0F7C6D366B12B7 |

Earlier mock coverage includes structured Chat handoff, interrupted/replayed drafts, native clipping and scrolling, role composition, contrast, and tap-target sizing. The new fixture supplies synthetic transforms and tests local recovery. It does not exercise a real Figma host or reproduce its font settling.

Final write timestamps (UTC) on 2026-11-16: plugin.js 05:22:33, ui.html 05:22:30, Companion server.js 05:21:13.
