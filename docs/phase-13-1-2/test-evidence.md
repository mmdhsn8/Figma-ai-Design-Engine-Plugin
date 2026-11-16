# Test evidence

Baseline branch main, HEAD `e86c8d678168a9add1bce0b9f8eee404b175c95f`. Existing dirty Phase 12/13/13.1/13.1.1 source and reports were retained. Registered manifest ID `1574493506249715820`. The verifier matched `manifest.json` in this checkout and booted compiled Companion on an ephemeral loopback port.

| Command | Result |
|---|---|
| `npx vitest run tests/design-generation.test.ts --maxWorkers=1` | 44 passed |
| `npm run qa:native-repair` | 15 passed |
| `npm test -- --silent --maxWorkers=1` | 641 passed across 36 files in 91.18 s |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npx tsc -p tsconfig.companion.json` | Passed |
| `npm run verify:phase5` | Passed |
| `git -c core.safecrlf=false diff --check` | Passed |

| Artifact | SHA-256 |
|---|---|
| manifest.json | 01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A |
| plugin.js | 9328EFB98C03A575C9687F39E62E8F62ED3E14CF2513DC8B57700EC5D8ECA57F |
| ui.html | 8F26364496E8B94E57188F8D426B206D00899173679C521A448226E7621AC4ED |
| design-generation.js | 8C59905F3A8A06E857830B9D40B41B8C2C8058853C608EB635B99A9151A0C530 |

The fixture covers nested editable Persian controls, retained order, idempotence, measured infeasibility and twelve deterministic width/count combinations. Existing regression coverage exercises scroll, clipping, role validation, authorization boundaries, checkpoints and the mocked Chat adapter. Cross-section relocation was not implemented or tested. No live measurements were made.
