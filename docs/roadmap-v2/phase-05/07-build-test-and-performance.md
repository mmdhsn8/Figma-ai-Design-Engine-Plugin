# Build, tests and performance

Clean baseline checkout on `main` at `1d0ff6496009d2dbed8342821e0469b2cdcc280a`. Baseline `npm test -- --reporter=dot --maxWorkers=1` passed 703 tests across 41 files in 84.98 s. The registered checkout is `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated`. The installed Plugin API typings are `1.142.0`. The manifest API is `1.0.0` and its ID is `1574493506249715820`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npx vitest run tests/universal-design-chat.test.ts tests/native-geometry.test.ts tests/native-repair-recovery.test.ts --maxWorkers=1 --reporter=dot` | 57 passed across 3 files |
| `npm test -- --reporter=dot --maxWorkers=1` | Final: 723 passed across 42 files in 103.43 s. |
| `npm run build` | Exit 0. Plugin 2,112.29 kB and UI bundle 1,495.77 kB before gzip |
| `npx tsc -p tsconfig.companion.json` | Exit 0 |
| `npm run verify:phase5` | Exit 0. Registered manifest and built entrypoints verified. Companion booted on ephemeral loopback |
| `git diff --check` | Exit 0. Git printed configured LF/CRLF notices |

The first focused integration run caught an overfilled scripted row once fill minimums counted toward preflight. The fixture now fits the row with its intended content. Native checks kept the same thresholds.

The completion pass's initial lint check rejected literal control-character ranges in the Unicode validator. The validator now uses the Unicode control category and preserves tabs and line breaks. The final lint, full suite and rebuilt entrypoint verifier passed.

| Artifact | SHA-256 |
| --- | --- |
| `manifest.json` | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |
| `dist/plugin.js` | `8490D5F8F81FBC0129A4D7EC99F55333A0BA6D33B7217BA0A8EC085F01BE14DA` |
| `dist/ui.html` | `057390BCCF21A88584BA4EFAE863250BBF706BCF28517FB5440CF1B33C0D02F7` |
| `dist-companion/companion/server.js` | `53E2EA7555CF9AC9D0961FEECA800C579EBD28C599107A702DFE504808423029` |
| `dist-companion/companion/main.js` | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` |

Local Phase 2 adapter fixtures measured 15, 18, 28 and 12 native mock nodes for education, booking, analytics and civic scenarios. These are single fixture samples. No matched repeated performance distribution was collected. Live provider rounds, Figma construction, font and asset timing, prototype behavior, first screen latency and actual host geometry are NOT MEASURED.
