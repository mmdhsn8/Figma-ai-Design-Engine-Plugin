# Test, build and repository evidence

## Gates

| Command | Result |
|---|---|
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 (`eslint . --max-warnings=0`) |
| `npx tsc -p tsconfig.companion.json --noEmit` | Exit 0 |
| `npm test -- --reporter=dot --maxWorkers=1` | Exit 0; 732 passed across 42 files |
| `npm run qa:native-repair` | Exit 0; 16 passed across 2 files |
| `npm run build` | Exit 0; generated `dist/plugin.js` and `dist/ui.html` |
| `npx tsc -p tsconfig.companion.json` | Exit 0; refreshed emitted Companion entrypoints for the verifier |
| `npm run verify:phase5` | Exit 0; registered manifest, current bundles and ephemeral compiled Companion health check verified; no OAuth/provider/Figma acceptance performed |
| `git diff --check` | Exit 0; Git printed its configured LF→CRLF notices |

The first manifest verification attempt correctly found a stale emitted Companion server after `npm run build`; the separate Companion emit refreshed it. The final verification then passed. `npm run build` itself does not emit the Companion server.

## Manifest and artifacts

Figma Desktop 126.11.9 registers `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated\manifest.json`, ID `1574493506249715820`, entrypoints `dist/plugin.js` and `dist/ui.html`. The initial read-only Desktop profile inspection and the post-build verifier report this same path. Manifest contents are unchanged.

| Artifact | SHA-256 after build |
|---|---|
| `manifest.json` | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |
| `dist/plugin.js` | `A647E9B7D48C0DEAB1191DBEC2817552EF3BB9540B21967DEE0BC6A7074FBCAA` |
| `dist/ui.html` | `D0BE00E79FB2572C7A087790E2CA98465C2E7046D76ED751358DBC1651927C54` |
| `dist-companion/companion/server.js` | `9D89A74AA8205B5D8D09B0203646C3BE378CBD493C592289985AAB285EA2514F` |
| `dist-companion/companion/main.js` | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` |

## Git and protected surfaces

HEAD before and after: `44061cade520b39dbc707aa0ff2c179573428a4d`. Branch: `main`, no commit or push. The checkout was clean before implementation; the final worktree contains the six implementation files, two test files and ten Phase 6 documents listed in the delivery report. `manifest.json`, `src/ui/styles.css`, the Chat JSX/composer appearance, and protected Figma documents were not changed. `App.tsx` only propagates IDs/signals and task fencing in the coordinator wiring.

Figma Desktop was running; its profile metadata pointed at an existing Test Shop file, which was treated as protected and not touched. No Companion listener was running on port 1455. The verifier's server used and closed an ephemeral loopback port. Therefore artifact/manifest verification is not live Desktop acceptance.
