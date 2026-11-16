# Test evidence

SOURCE. Branch `main`, HEAD `e86c8d678168a9add1bce0b9f8eee404b175c95f`. Phase 13 changes were already dirty on entry. Package version 0.1.0. Plugin ID 1574493506249715820. The verifier confirmed the workspace's registered development manifest.

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx tsc -p tsconfig.companion.json --noEmit` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npx tsc -p tsconfig.companion.json` | Passed |
| `npm run verify:phase5` | Passed |
| `npm run qa:native-repair` | 15 passed |
| `npm test -- --silent --maxWorkers=1` | 623 passed across 36 files in 82.57 s after the scroll changes |
| `npx vitest run tests/chat-generation.test.ts tests/chat-task.test.ts tests/native-visual-quality.test.ts tests/figma-tool-executor.test.ts --maxWorkers=1` | 200 passed |
| `git diff --check` | Passed |

MOCK. The initial focused run found one regression in the legacy Skill fixture. Versionless drafts now retain legacy plugin-side Skill validation.

MOCK. The long-detail fixture initially failed on an undersized action container and a missing navigation region. The fixture now includes both and passes full composition preflight. The three-screen Chat mock asserts a 1000 px section survives save, replay and renderer readback inside a 390×844 vertical-scroll root. This does not capture real storefront appearance or model latency.

| Artifact | SHA-256 |
|---|---|
| manifest.json | 01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A |
| dist/plugin.js | 8BAF409B60945E46624E183884E3D973166D653BCAEFFA3FEE59A74829453EBF |
| dist/ui.html | E50E185E75665757F0D4640E82B90E135BB9C6DF79CD8CE42B6DB33EFACE83EC |
| dist-companion/companion/server.js | FEC1D363FBC25A6B36436686729E9CA279F0ABEEF3A2E25CCFF94A9B379BDF8B |
| dist-companion/shared/design-generation.js | 050CDCD2CEEE21195C1FC7305C3B516C1E1918C3C5C44724EF7B5360A7E69CC7 |
| src/shared/chat-generation.ts | 72C4E6871EF0123E850D1DF67862201D28DAB2EC1F8D4647E92A5BD7B213B6CD |
| src/plugin/figma-tool-executor.ts | 94394684B56817F6C34C031898718B8D7330260FA7D0E9DCBC1650635662FEE5 |
