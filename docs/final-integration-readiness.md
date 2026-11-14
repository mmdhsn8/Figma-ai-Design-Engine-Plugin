# Final Integration Readiness

- **Audit date:** 2026-11-14
- **Verdict:** CONDITIONAL ENGINEERING COMPLETE — LIVE ACCEPTANCE PENDING
- **Checkout:** `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated`
- **Baseline revision:** `1da6adac966f8367bd74c20f3926ecf2c5a9c6de` (`feat: add professional design skills manager`)
- **Branch:** `main`, tracking `origin/main`. The checkout was clean before this task; the integration changes were committed and pushed after the user authorized publication.

## Scope and baseline

The registered `manifest.json` resolves to this checkout and names `dist/plugin.js` and `dist/ui.html`; Figma Desktop registration was verified by `npm run verify:phase5` before edits. The manifest uses `api: 1.0.0`, `documentAccess: dynamic-page`, and permits development access only to `http://localhost:1455`. The existing Companion command is `npm run companion` (`tsc -p tsconfig.companion.json` then the compiled local server). The project expects Node 22.12+ for Windows desktop development. The verifier boots the compiled Companion on an ephemeral loopback port; that is not OAuth, inference, or Desktop acceptance.

No Chat JSX or `.chat-*` CSS was changed; the approved Chat markup snapshot/style regressions passed in the full suite. No Figma canvas, selection, document, account, plugin `clientStorage`, chat history, Brand Kit/Skill records, task checkpoint, or Companion draft was opened or mutated. Automated storage tests use in-memory test doubles. No Desktop screenshots or native-tree evidence were captured because no disposable Figma file/session was confirmed.

## Findings fixed in this pass

1. **Shared storage quota.** Brand Kit counted all client storage while Skills checked only its namespace, and their independent write queues could race. A common aggregate budget now measures keys and serialized values across both managers, while Skills keeps its smaller namespace budget. Both managers use one serialized queue per storage adapter. Concurrent quota behavior is regression-tested. Figma documents a total 5 MB `clientStorage` limit in [Version 1 Update 109](https://developers.figma.com/docs/plugins/updates/2025/03/17/version-1-update-109/).
2. **Chat Brand Kit colors were advisory.** The pinned kit was present in model context, but the native action schema accepted only literal colors, so actual token use depended on model compliance. Chat actions may now name a semantic fill, text, or stroke role. Immediately before native dispatch, the local runner resolves that role from the task's immutable pinned revision; parsed explicit user palette colors remain higher priority. The checkpoint retains the role while the dispatched native action contains a concrete hex value. Regression tests assert both behaviors.
3. The Phase 10 storage description was corrected to distinguish the 1.5 MiB Skills namespace budget from the shared 5 MiB Figma quota.

No migration, cleanup, or storage rewrite was performed.

## Traceability

| Feature / risk                                          | Implementation and automated evidence                                                                                                                                | Desktop evidence                                                                      | Status      | Owner / next action                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Registered manifest/build target                        | `manifest.json`; `scripts/verify-phase5-build.mjs`; final `npm run verify:phase5`                                                                                    | Exact registered path and fresh compiled entrypoints verified; no plugin launch       | PASS        | QA: launch this manifest in Figma Desktop and perform the blocked live scenarios                   |
| Companion health / authentication / inference           | Existing local Companion and account-fenced client; `verify:phase5` starts health server                                                                             | No authenticated account or model request                                             | BLOCKED     | User/engineer: authorize session on disposable file; capture sanitized status and request evidence |
| Model, Brand Kit, and Skill revision pinning            | Chat task/draft schemas and existing persistence tests; `tests/chat-task.test.ts`, `tests/brand-kit.test.ts`, `tests/design-skills.test.ts`                          | No live task/reload                                                                   | PARTIAL     | Engineer: perform create/reload/resume and default-change check in disposable file                 |
| Chat Brand Kit native color values                      | Semantic-role resolution in `src/ui/chat-task.ts`; `tests/chat-task.test.ts` checks pinned fill and explicit-color precedence                                        | No native setter/readback                                                             | PARTIAL     | Engineer: verify actual fills/text colors and readback in Desktop                                  |
| Shared aggregate storage quota                          | `src/plugin/client-storage-budget.ts`, both storage managers; concurrent regression in `tests/design-skills.test.ts`                                                 | No user `clientStorage` touched                                                       | PASS (mock) | Engineer: retain automated evidence; optional disposable Desktop confirmation                      |
| Skill safety / selection / influence                    | `src/shared/design-skill*.ts`, bounded JSON projection, allowlisted patterns; `tests/design-skills.test.ts`                                                          | No live task                                                                          | PARTIAL     | Engineer: test one controlled before/after task and inspect resulting native patterns              |
| Visible covering background selection                   | `resolveVisibleBackground`; exact-layer executor/chat regressions in `tests/figma-tool-executor.test.ts` and `tests/chat-task.test.ts`                               | No live canvas evidence                                                               | PARTIAL     | Engineer: edit a covering child on disposable file; screenshot Layers and verify fill              |
| Existing-frame edit / no-op / reference reconciliation  | Saved edit plan and ref checks; mock tests in `tests/chat-task.test.ts` and `tests/figma-tool-executor.test.ts`                                                      | No live edit                                                                          | PARTIAL     | Engineer: edit one uniquely identified frame and verify no duplicate or identity change            |
| Pause/reload/restart/reconcile                          | Durable checkpoints, operation reconciliation, `tests/chat-task.test.ts`, `tests/companion-server.test.ts`, `tests/figma-tool-executor.test.ts`                      | No interrupted live task                                                              | PARTIAL     | Engineer: interrupt after confirmed mutation, reload, resume, and compare native IDs               |
| Native QA fail-closed                                   | 5,000 nodes / depth 48 / 50,000 overlap-pair budgets; incomplete coverage blocks repair/completion; mock tests                                                       | No real native tree                                                                   | PASS (mock) | Engineer: confirm one representative live scan and diagnostic                                      |
| Auto Layout, typography, RTL and responsive behavior    | Native executor/schema mocks and visual fixtures                                                                                                                     | Persian shaping, font availability, clipping, and responsive appearance not inspected | PARTIAL     | Designer/engineer: follow manual checklist with screenshots and Layers visible                     |
| 10/100-screen scale                                     | Renderer and draft persistence fixtures; exact mock run metrics are recorded in regression ledger                                                                    | No Figma render or Desktop performance evidence                                       | PARTIAL     | Engineer: run in disposable file only; record native time and responsiveness                       |
| 300–400-screen scale and streaming                      | Current bounds: 64 MiB draft, 100,000 nodes, 1 MiB/250 nodes per section, 8 MiB/screen, eight retained project directories; full load still reconstructs all records | Not attempted                                                                         | BLOCKED     | Engineering: design/measure paginated load before any staged large render                          |
| Photos and image provenance                             | Authorized assets only; progressive path can use labeled editable native fallback                                                                                    | No asset placement acceptance                                                         | PARTIAL     | Product: provide authorized assets/provider and rights metadata or accept labeled placeholders     |
| UI navigation, history, model management, 440×720 panel | Existing UI and regression suite; Chat markup/styles remain protected                                                                                                | No Desktop resize, accessibility, or pixel review                                     | PARTIAL     | QA: complete checklist and capture screenshots                                                     |
| Security / data integrity                               | Strict tool schemas, local loopback policy, Markdown-as-data, bounded assets/drafts, storage/recovery tests; see automated suite                                     | No live account-switch/network-failure exercise                                       | PARTIAL     | Security/QA: run safe resilience scenarios on disposable account/document                          |

## Automated checks

### Final automated results

| Command                              | Result                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test -- --maxWorkers=1`         | PASS — 33 files, 547 tests passed, 0 failed, 0 skipped; 177.55 s. Run with one worker to limit process contention; see the fixture-timeout note below. |
| `npm run typecheck`                  | PASS                                                                                                                                                   |
| `npm run lint`                       | PASS (`--max-warnings=0`)                                                                                                                              |
| `npm run build`                      | PASS — `dist/ui.html` and `dist/plugin.js` rebuilt from final source                                                                                   |
| `npx tsc -p tsconfig.companion.json` | PASS                                                                                                                                                   |
| `npm run verify:phase5`              | PASS — exact registered manifest path, fresh plugin/UI/Companion entrypoints, ephemeral loopback health check                                          |
| `git diff --check`                   | PASS — no whitespace errors; Git emitted only existing LF→CRLF working-copy notices                                                                    |
| Focused Prettier check               | PASS for new files, final documents, and changed files without known legacy formatting debt                                                            |
| `npm run format:check`               | FAIL — 106 files currently differ from Prettier; no unrelated mass formatting was applied                                                              |

The first repeat of the full suite had one load-sensitive timeout in the 5,000-node QA fixture (546 passed, 1 timed out at the default 20 s). The same case passed in isolation in 9.03 s. Its per-case allowance is now 60 s; the final full run passed all 547 tests. No production timeout or QA budget was changed.

The ten-screen render mock produced 10 screens / 325 nodes in 149.5 ms with a 0-byte observed sampled-heap delta; this does not prove no allocations occurred because the peak is sampled only from progress callbacks. The 100-root render mock produced 100 roots / 300 nodes in 91.2 ms and sampled a 10,948,784-byte heap delta. Both assert no unintended overlap and enforce local limits. A local 100-screen draft persistence/reload test also passed. These are local mocks, not Figma Desktop, provider, or live performance evidence.

Mock tests prove local contracts only; they do not establish Figma setter behavior, OAuth/provider inference, Desktop timing, or visual quality.

### Registered artifact hashes

SHA-256 values after the final build and successful `verify:phase5`:

| Artifact                           | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `manifest.json`                    | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |
| `dist/plugin.js`                   | `2B704F14DFA657E1E0225F51CC2189B51430B6A88CAEC3E343B2F441AB129B59` |
| `dist/ui.html`                     | `DA50157E2A2A02FEB98115835B0BDFF355FD07CABBE245757DD1A80B8EE50DA4` |
| `dist-companion/companion/main.js` | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` |

SHA-256 values for the principal modified source files at this checkout:

| Source file                           | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `src/plugin/client-storage-budget.ts` | `BD0B8CD9534D063FBFC025A54F533550BDA2A6FB41C5788A1CFC1F507EB8EFAF` |
| `src/plugin/brand-kit-storage.ts`     | `A996F7A8BC7DDCE9214454DFD79CCC8A5B2044649968FA50E70122086E76BBE8` |
| `src/plugin/design-skill-storage.ts`  | `5A772B93E3085F192E187FFC048474C083B547789A9DD1A14F9A8C0030CE20A2` |
| `src/plugin/figma-tool-executor.ts`   | `5E6619816F6C935DDDEFB81B9945B38DA10A6EC5EECD33D149C4F9BCA34B1AAB` |
| `src/shared/brand-color-role.ts`      | `FDE5EC957ABBE9673A4203C93A44F4B3B9797AF87E1A89D8926A977FDD842B08` |
| `src/shared/client-storage-limits.ts` | `819757438D8A59482AA1BDB6D6795CEDC24C8238AA5B1F5899B5A1C49E84CD50` |
| `src/shared/brand-kit.ts`             | `24C1BF44DDFDD572A53B6FC82DCD2E01485238491E6D196F04EAA687258943BA` |
| `src/shared/chat-tools.ts`            | `301A539A9F3F9CF3EC14B55B802BE1A0CE9EB94E0377855C7763639B6F262B77` |
| `src/shared/figma-tools.ts`           | `982B9BCEAD6EF1770A02CD2C447F12DEAB370A48FA2C128164CA578AF06CF1C8` |
| `src/ui/chat-task.ts`                 | `F4A941055029C935FC16DB1F58D58984E83351E28A9EC4F8C6AF3A3FA9F05CED` |
| `src/ui/design-skills-manager.tsx`    | `5D8A6AA292A6417EDA56A2E79C6BC5C5CF1D0257BE35C3234011C1063D630526` |

The final build emits approximately 1,327.82 kB UI bundle and 1,823.33 kB plugin bundle before gzip. The local project documents Node 22.12+ for Windows development.

`format:check` has known repository-wide legacy debt. The current check reports 106 files; new deliverables and compatible changed files pass focused Prettier checks. A previous attempt to format whole legacy files created broad unrelated diffs and those formatting-only edits were removed. No mass formatting was retained.

## Open release gates

- Authenticated Figma Desktop/provider acceptance and actual native visual readback.
- Phase 5.9.5 visible-background, existing edit-plan identity, and Stage 2 recovery on a disposable document; the historical separate ledger is not present in `docs/`, so this report carries the requirements forward from the acceptance brief and existing phase audits.
- Phase 6.9 `LIVE-1`, `SCALE-1`, `DESIGN-1`, `DESIGN-2`, `REG-1` and Phase 7–10 live acceptance. Automated source coverage does not close them.
- Native Persian/English visual quality, mixed-script shaping, responsive layouts, optical polish, real authorized image assets, and live multi-screen timings.
- The draft loader still reads/reconstructs all records within its configured project bound. Multi-hundred-screen rendering is not proven; no streaming change was made without evidence that its compatibility/resumability could be safely changed in this bounded pass.

## Release decision

**CONDITIONAL ENGINEERING COMPLETE — LIVE ACCEPTANCE PENDING.** The prioritized aggregate-quota race and advisory-only Chat Brand Kit token path are fixed with focused regressions. Release readiness cannot be claimed without authenticated Desktop/provider evidence, a confirmed disposable document, native visual/readback checks, and the inherited live recovery/scale/design gates.

No commit, push, reset, cleanup, Figma edit, storage reset, or credential-dependent test was performed.
