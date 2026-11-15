# Scope and evidence ledger

## Scope

This audit examines architecture and performance boundaries relevant to the plugin's JSON import, structured AI generation, Chat, local Companion, native executor, validation, persistence, and build registration. It does not implement product changes, issue provider requests, operate Figma Desktop, or diagnose from a live canvas.

The checkout is the registered development plugin: `manifest.json` uses plugin ID `1574493506249715820`, `dist/plugin.js`, and `dist/ui.html`. The registration path and remote were checked during the audit; `origin` is `https://github.com/mmdhsn8/Figma-ai-Design-Engine-Plugin.git`.

## Evidence inventory

| Claim                                  | Evidence type           | Evidence/result                                                                                                                                                      | Limit                                                                                 |
| -------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Active manifest is this checkout       | Static + local verifier | `manifest.json`; `npm run verify:phase5` confirmed Figma's registered path and current plugin/UI/Companion entrypoints                                               | Does not load or run the plugin in Desktop                                            |
| Three separate design paths exist      | Static                  | `src/ui/App.tsx`, `src/ui/chat-task.ts`, `src/companion/server.ts`, `src/shared/multi-screen-schema.ts`, `src/plugin/renderer.ts`, `src/shared/design-generation.ts` | Does not establish user behavior or product quality                                   |
| TypeScript and lint gates pass         | Local                   | `npm run typecheck`, `npm run lint`, `npx tsc -p tsconfig.companion.json --noEmit` passed on the current snapshot                                                    | No runtime/provider/host proof                                                        |
| Automated regressions pass             | Local/mock              | `npm test -- --reporter=dot --maxWorkers=1`: 587/587 across 34 files; `npm run qa:native-repair -- --reporter=dot`: 14/14                                            | Figma and provider are mocked/scripted                                                |
| Full suite rerun result                | Local                   | Initial default-worker run had one 5-second timeout and Windows `EBUSY` cleanup in `generation-draft.test.ts`; rerun with `--maxWorkers=1` passed all tests          | The first-run timeout is recorded, not hidden; it is not evidence of a product defect |
| Build registration/output checks pass  | Local                   | `npm run verify:phase5` passed after the earlier in-session freshness mismatch; it confirmed registration and booted the compiled Companion on loopback              | No OAuth, provider request, or Desktop acceptance                                     |
| Fixture normalization cost             | Local benchmark         | `npm run bench:phase5`: 2,815 bytes, 200 iterations; parse 0.0255 ms avg; normalization+validation 0.2563 ms avg; 200/200 accepted                                   | Does not measure provider, Figma, or user-visible latency                             |
| Mock Figma renderer throughput         | Local/mock              | Existing renderer test printed 100 screens / 300 nodes in 30.2 ms in this run                                                                                        | Mock API and local runner; not Desktop performance                                    |
| Historical 400-page discovery behavior | Prior local/mock report | `docs/phase-5-9-3-progressive-discovery.md` records 1.49 s for a 400-page mock and 0.91 s for 1,000 matching frames                                                  | Prior mock run, not repeated in this Phase 11 pass and not live Figma                 |
| Live model or Desktop latency          | Live                    | **Not collected**                                                                                                                                                    | Requires user-approved disposable-file test and authorized account/model              |
| Historical Figma MCP capability        | Configuration review    | Current Codex config includes `node_repl` and a read-only Supabase server; no Figma-named MCP server was found                                                       | Historical server/tool/version/permissions and MCP logs were not verified             |

## Concurrent worktree changes

The audit-start baseline was clean at `0e941453f92c359314f5507576f7a87f171dbb9a`. On resumption, these seven tracked files were modified and were treated as concurrent user/other-agent work:

- `scripts/verify-phase5-build.mjs`
- `src/plugin/auto-layout-repair.ts`
- `src/plugin/figma-tool-executor.ts`
- `src/shared/chat-task.ts`
- `src/shared/native-quality-repair.ts`
- `tests/chat-task.test.ts`
- `tests/native-repair-recovery.test.ts`

The diff upgrades the native repair marker to v2, preserves reading v1 checkpoints, adds measured horizontal Auto Layout overflow eligibility/repair behavior, and adds regression coverage. These changes were not authored by this audit. Current test results include them because checks were rerun on the current tree. This audit did not attempt to revert, stage, commit, or overwrite them.

During the audit, the seven-file change was committed concurrently as `8088aa0` (`fix err`, author `mmdhsn8`, 2026-11-14). The commit diff contains those seven files. The audit did not create that commit; at final status, local `main` and its `origin/main` tracking ref both pointed to `8088aa0`, with the audit documents as the only untracked work. The checks were run against the same seven-file source/test content before it was committed. This records local Git state and does not independently establish when or by whom the remote repository was updated.

## Evidence hygiene

The source, scripted fixtures, and prior written incident reports are not interchangeable. This audit labels each explicitly. It makes no claim that the documented 390×201 incident is the cause of a different latency report. The exact incident JSON for the performance question was not found locally. Existing files such as `docs/autonomous-end-to-end-debug-report.md` concern a separate reported QA/layout incident and are cited only for that incident.

No live Figma mutation, provider request, or credential access was performed. The audit created no commit and made no push. The build may update ignored `dist/` artifacts; this audit did not rebuild after the final verifier run.
