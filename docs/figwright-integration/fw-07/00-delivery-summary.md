# FW-7 — Delivery summary

**Status: PARTIAL / LIVE PENDING.** The repository now has opt-in, bounded diagnostic events at the existing UI, task-owner, Figma-plugin, checkpoint, and Companion seams, plus a local acceptance collector. The current renderer, task owner, checkpoint format, and provider behavior remain the owners of their existing work. FW-7 adds measurement and export; it does not turn the local harness into a Figma Desktop benchmark.

## Implemented

- `src/shared/fw7-observability.ts` defines the strict versioned event/snapshot contract, bounded event rings, nullable unobserved counters, correlation hashes, and size-bounded export.
- UI, Figma plugin, and Companion each have an opt-in runtime hub. UI/plugin build diagnostics use `VITE_FW7_DIAGNOSTICS=fw7-diagnostics-v1`; Companion diagnostics use `FW7_DIAGNOSTICS=fw7-diagnostics-v1`. Both default off. `scripts/build.mjs` stamps UI/plugin builds with a Git revision and dirty marker.
- Existing production seams emit dispatch/acknowledgement, render/readback, checkpoint, native API, task Stop/completion, provider, visual capture/review, and observed same-session refresh events. The Companion exposes a local export endpoint only when its separate gate is on.
- `docs/figwright-integration/fw-07/collect-events.mjs` validates bounded exports and consent/authorization declarations, checks task transitions, keeps unknown counters null, and refuses to overwrite an artifact.
- The fake-runtime comparison ran 1/3/10 screens with diagnostics off and on. Root counts, created-node counts, and mock root ID hashes matched. Dispatch reduction is **not measured**, and local timings are not Desktop speed.

## Evidence and limits

- `npm run typecheck`, `npm run lint`, `npm run build`, `npx tsc -p tsconfig.companion.json`, `npm run verify:phase5`, and the final `npm test -- --silent=passed-only` passed. The full suite result is 50 files / 833 tests; the focused FW-7/Companion subset is 4 files / 96 tests.
- The targeted FW-7/Companion subset passed 4 files / 96 tests. A final fake-runtime gate-off/on sample is in [local-fake-benchmark.json](local-fake-benchmark.json).
- No Figma document, model/provider, OAuth account, screenshot transmission, or real Desktop session was used. F0/F1/F3/F10/FH/FE live outcomes remain pending.
- Some counts are intentionally `null`: the corresponding boundary is not instrumented in the local harness. Plugin monotonic timestamps are `null` because the Figma controller bundle must not depend on `performance`; explicit plugin duration measurements use wall-clock deltas.

No commit or push was made. The committed build configuration leaves FW-7 diagnostics off unless explicitly enabled for a later authorized acceptance run.
