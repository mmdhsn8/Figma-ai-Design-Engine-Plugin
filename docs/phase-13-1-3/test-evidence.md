# Test evidence

Baseline `e86c8d6` with pre-existing modified source and untracked phase reports. The registered development manifest for this checkout has ID `1574493506249715820`. The build verifier confirmed compilation and loopback startup. Loaded Figma Desktop build and real provider metrics remain unverified.

| Command | Result |
|---|---|
| `npx vitest run tests/design-generation.test.ts --maxWorkers=1` | 45 passed |
| `npm run qa:native-repair` | 15 passed |
| `npm test -- --silent --maxWorkers=1` | 642 passed across 36 files in 109.04 s |
| `npm run typecheck` | Passed |
| `npx tsc -p tsconfig.companion.json --noEmit` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npx tsc -p tsconfig.companion.json` | Passed |
| `npm run verify:phase5` | Passed |
| `git -c core.safecrlf=false diff --check` | Passed |

| Artifact | SHA-256 |
|---|---|
| manifest.json | 01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A |
| plugin.js | AF0FE1E8B52DA5E4237A8BFEBA260FD6B31FB61F1CE5CED14EFEC3B07D7E2EE6 |
| ui.html | D3266E3DE286BE295FEB864F541584C0605FE7BD5BEE662AB229772C0E069115 |
| server.js | 1827EE92A103E91813830FEF7B3F756CC2F5B9B40C88AD39EC0F7C6D366B12B7 |

The synthetic opaque sample moves from a reported 4.06:1 to 15.37:1 using the existing text role. The source input remains intact. The low-alpha and unknown-surface cases fail closed.
