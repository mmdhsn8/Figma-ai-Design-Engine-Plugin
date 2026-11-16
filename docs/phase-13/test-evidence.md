# Phase 13 test evidence

## Baseline

Before Phase 13, checkout was clean at `e86c8d678168a9add1bce0b9f8eee404b175c95f`. `docs/phase-12/test-evidence.md` reports 605 tests across 35 files; these are historical Phase 12 results, not Phase 13 evidence. No artifact from the reported sparse live run was available to reproduce.

## Commands and results

| Command                                                                                                                         | Result                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/visual-composition.test.ts tests/design-generation.test.ts tests/generation-draft.test.ts --maxWorkers=1` | Passed: 54 tests after the final identity-slot regression was added.                                                                                                 |
| `npm run typecheck`                                                                                                             | Passed.                                                                                                                                                              |
| `npx tsc -p tsconfig.companion.json --noEmit`                                                                                   | Passed.                                                                                                                                                              |
| `npm run lint`                                                                                                                  | Passed with `--max-warnings=0`.                                                                                                                                      |
| `npm test -- --reporter=dot --maxWorkers=1`                                                                                     | Passed: 621 tests across 36 files; duration 70.55 s.                                                                                                                 |
| `npm run qa:native-repair`                                                                                                      | Passed: 14 tests across 2 files (native repair recovery and native visual quality).                                                                                  |
| `npm run build`                                                                                                                 | Passed; built registered `dist/ui.html` and `dist/plugin.js`. Vite transformed 166 UI modules and 146 plugin modules.                                                |
| `npx tsc -p tsconfig.companion.json`                                                                                            | Passed; compiled Companion artifacts.                                                                                                                                |
| `npm run verify:phase5`                                                                                                         | Passed; exact Figma Desktop registered manifest path verified and compiled plugin/UI/Companion entrypoints validated. No OAuth or Figma Desktop acceptance occurred. |
| `git diff --check`                                                                                                              | Passed.                                                                                                                                                              |

The visual contract's final focused run, `npx vitest run tests/visual-composition.test.ts --maxWorkers=1`, passed 14 tests. The full 621-test run includes that fixture and is the final aggregate count.

Deterministic Phase 13 coverage includes Persian role classification; distinction between listing/detail/cart patterns; the 832 px section-budget arithmetic; valid and sparse detail composition; complete home product cards and a populated cart; non-empty identity/header/search semantics; Persian Toman price presence; authorized versus placeholder asset status; unknown optional contract keys; versionless draft parsing; and generated role-specific prompt guidance. Existing suites cover pinned Brand Kit mapping, Skill constraints, editable placeholders/approved image paths, RTL text alignment, horizontal native overflow repair, checkpoint/draft recovery and bounded screen planning. All results are local mocks/unit tests, not live screenshot proof.

## Registered artifact identity

Manifest plugin ID: `1574493506249715820`.

SHA-256 after successful final build:

| Artifact                             | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `dist/plugin.js`                     | `9F26EFB7D8B4304EA202D1B06758F4A4FB98B9B7AFF152B10489AF0DCCBA2C22` |
| `dist/ui.html`                       | `F958779CD46D36E2564296E0A319FBFF9E010A8CFF1DF4988AAC80C79835218D` |
| `dist-companion/companion/server.js` | `FEC1D363FBC25A6B36436686729E9CA279F0ABEEF3A2E25CCFF94A9B379BDF8B` |
| `manifest.json`                      | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |

`verify:phase5` reported: `Figma Desktop manifest registration verified: C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated\manifest.json` and `Compiled companion boots on ephemeral loopback; current plugin/UI/companion entrypoints verified. No OAuth or Figma Desktop acceptance performed.`

## Repository status and live evidence

Branch `main`, base revision unchanged. The source tree contains the intended tracked Phase 13 edits plus new `docs/phase-13/`, `src/shared/visual-composition.ts`, and `tests/visual-composition.test.ts`. Built outputs are ignored artifacts. No branch/history reset, commit or push was made.

Provider requests, elapsed time, native screen/node counts, Figma Desktop version, screenshots, Layers evidence, font rendering and human screenshot review are **NOT MEASURED**. See [live-acceptance.md](live-acceptance.md).
