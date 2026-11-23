# FW-7 — Test evidence

## Commands

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS, zero warnings |
| `npm run build` | PASS, UI and plugin bundles built with diagnostics off by default |
| `npx tsc -p tsconfig.companion.json` | PASS, Companion TypeScript emitted to `dist-companion` |
| `npm run verify:phase5` | PASS, compiled plugin/UI/Companion entrypoints and sandbox assertions verified; it explicitly reports no Figma Desktop acceptance |
| `npm test -- --silent=passed-only` | PASS, final run 50 files / 833 tests; includes the final consent/protected-label collector assertions |
| Focused FW-7 + Companion tests | PASS, 4 files / 96 tests |
| Gate OFF/ON local fake benchmark | PASS, 1 test each process for 1/3/10 screens |
| `npm run fw7:acceptance` | PASS, local collector usage printed |

The final full test run includes the collector assertions for protected page labels and external image-transmission consent. `npm run verify:phase5` passed after the plugin bundle was rebuilt and Companion TypeScript was recompiled; no OAuth request was made by the script.

## Assertions covered

- Strict event payload and snapshot parsing; bounded ring/drop accounting; null versus observed zero; bounded serialized export; and operation with `Intl` missing.
- Collector rejection of contradictory Stop-to-Completed events, unknown/raw-prompt fields, missing live authorization, unauthorized provider requests, visual capture without capture consent, protected page labels, and review transmission without separate consent.
- Fake Figma renderer assertions on success, stable distinct screen root IDs, exact root attachment to the mock page, expected root/node counts, and no diagnostics side effects when off.
- Companion diagnostics endpoint returns 404 with the gate off and emits a sanitized bounded stream with the gate on.
- Existing full-suite FW-6 F10 Persian fake task reported 10 screens, 10 unique task roots, zero duplicate roots, and mock timing. It is existing FW-6 evidence, not FW-7 live evidence.

## Limits

These are local source/runtime tests. They do not prove real Figma rendering, Desktop restart behavior, visual appearance, real OAuth refresh counts, image-provider quality, or actual browser/Companion/plugin cross-process clock alignment. The benchmark fixture is synthetic and does not test FH/FE. Counters only cover the seams listed in [01-live-event-map-and-source-seams.md](01-live-event-map-and-source-seams.md).
