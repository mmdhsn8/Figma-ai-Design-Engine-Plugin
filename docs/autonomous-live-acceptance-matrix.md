# Autonomous live acceptance matrix

Environment: registered Windows checkout on `main`; production task runner and plugin executor exercised through deterministic Figma API mocks. No live Figma writes, paid provider requests, or user-account changes were made. The screenshot shows Test Shop open, which is protected by the supplied brief.

| Scenario                                                                              | Status                         | Evidence type                                   | Evidence / next action                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 390×201 planned mobile screen root corrected before mutation                          | PASS                           | Production integration harness                  | Invalid root rejected before dispatch; later `set_properties` resize to 201px rejected; corrected root remains 390×844. Other page-level component frames remain allowed. |
| 330px child in a 310px padded content area                                            | PASS                           | Production integration harness                  | FILL readback is 310px; parent HUG readback is 875px; fresh QA reports no findings.                                                                                       |
| Three-stage 390px mobile task reaches stage 3                                         | PASS                           | Production integration harness                  | All three stage checkpoints completed; five unique mock nodes; zero final findings.                                                                                       |
| Intentional vertical scroll vs cross-axis overflow                                    | PASS                           | Deterministic quality test                      | Configured vertical overflow is allowed; a 400px child in a 390px viewport remains a clipping finding.                                                                    |
| Nested vertical Auto Layout HUG/FILL/FIXED                                            | PASS                           | Production integration + existing recovery test | Fixed child is converted to FILL only under a fixed cross-axis parent; safe vertical HUG is remeasured.                                                                   |
| Persian RTL three-page clothing store                                                 | NOT RUN                        | —                                               | Run on an approved disposable document and capture native tree/screenshots.                                                                                               |
| English LTR dashboard                                                                 | NOT RUN                        | —                                               | Requires a full visual fixture and native readback.                                                                                                                       |
| Mobile and desktop pair                                                               | NOT RUN                        | —                                               | Requires paired viewport generation and native readback.                                                                                                                  |
| Existing-frame edit and visible background                                            | NOT RUN in this mission        | Existing repository tests only                  | Re-run as an acceptance scenario without touching protected files.                                                                                                        |
| Partial commit and lost acknowledgement                                               | PASS for regression coverage   | Existing repository unit/integration tests      | Full suite includes the prior partial-commit recovery guards; no live interruption was induced.                                                                           |
| Companion/plugin restart and Resume                                                   | PASS for regression coverage   | Existing saved-checkpoint integration test      | Existing test exercises checkpoint restart and recovery; not a Desktop restart.                                                                                           |
| Brand Kit hex precedence and Design Skills behavior                                   | NOT RUN in this mission        | Existing repository tests only                  | Re-run as part of broader product acceptance.                                                                                                                             |
| Ten-screen layout and no-overlap placement                                            | NOT RUN                        | —                                               | Requires a bounded ten-screen fixture and full native-tree inspection.                                                                                                    |
| Adversarial network, quota, cancellation, corrupt checkpoint, and readback truncation | NOT RUN as one mission fixture | Existing repository tests cover selected cases  | Review individual full-suite results; add scenario-specific evidence before production sign-off.                                                                          |
| Figma Desktop native mutation acceptance                                              | BLOCKED                        | No live evidence                                | Do not use Test Shop or Charm Home. Continue after an explicitly approved disposable document is available.                                                               |
| Automated local verification gates                                                    | PASS                           | Local commands                                  | `npm run qa:native-repair` 13/13; `npm test` 585/585 across 34 files; typecheck, lint, Companion compile, build, `verify:phase5`, and `git diff --check` passed.          |

## Required commands

```powershell
npm run qa:native-repair
npm test
npm run typecheck
npm run lint
npx tsc -p tsconfig.companion.json --noEmit
npm run build
npm run verify:phase5
git diff --check
```

## Decision

Engineering acceptance for the supplied regression passes in the strongest available deterministic integration harness. Live acceptance and broad product acceptance remain incomplete. **Production GO/NO-GO: NO-GO** until the blocked Desktop scenario and the unrun design fixtures pass with captured native evidence.
