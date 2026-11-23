# FW-1 delivery summary

## Verdict

**LOCAL COMPLETE / LIVE BLOCKED.**

Completed the read-only source/setup work, pinned Figwright source inspection, fixture set, pre-registered rubric, sanitized measurement contract, runnable no-write diagnostics and run collector, evidence templates, gap matrix, license/security notes, and manual Desktop procedure. No production source or configuration was changed. No Figma document was opened or modified, no model/provider call was made, and no mock design run was used as a substitute for live evidence.

The source checkout is the existing plugin repository at commit 639fdb4f432429ca0dccda3652677a84a4374769 on branch main; its working tree was clean before these FW-1 artifacts were added. Figwright source was audited at the released v0.8.0 tag, commit 458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca. The current upstream main was also observed at e96ab03b9f96ec534c77cb76525fd76e5d892abe, one commit after that release. Neither Figwright runtime nor its plugin was executed.

## Why live testing is blocked

- Figma Desktop itself was not running; only the Figma Agent process was present. Installed Desktop version 126.11.11 is visible from local installation metadata, but active file/page, registered development manifest, loaded plugin version, selected model, and save/connection health were not observable.
- No disposable A/B files were designated or authorized. The protected Storefront file was not opened.
- The Companion had no listener on its configured loopback port 1455. No model selection or provider entitlement/cost scope was visible or authorized.
- Figwright v0.8.0 is a separate development plugin plus MCP server. It is not registered in the current environment. No isolated MCP client configuration, plugin registration, dependency install, or provider request was created.

## Fixture status

| Fixture | Variant | Result | Evidence |
|---|---|---|---|
| F0 safety gate | Ours | BLOCKED before live run | No approved disposable file, loaded plugin, or authorized model request |
| F1 learning dashboard | Ours / Figwright | BLOCKED before live run | Same prerequisites; no mock substituted |
| F3 booking pack | Ours / Figwright | BLOCKED before live run | F1 gates not run |
| F10 building management | Ours / Figwright | BLOCKED before live run | Smaller gates not run |
| FH specimen archive | Ours / Figwright | BLOCKED before live run | No held-out live run |
| FE scoped edit | Ours / Figwright | BLOCKED before live run | No disposable screen or approved write |

Run metrics, native identities, screenshots, geometry/QA findings, recovery results, and human visual scores are NOT MEASURED. The exact Figwright v0.8.0 source/version is pinned and audited; its live tool catalog, runtime behavior, and generated output were not tested.

## Decision

Adopt the screenshot-plus-native-readback evidence rule in this benchmark only. The current Universal Engine already has typed design programs, per-screen checkpoints, bounded preflight, transaction identity, and native readback, so a structural rewrite or second writer is not supported by this evidence. Defer any product port of Figwright batching or screenshot-guided correction until isolated F1/F3 live runs demonstrate a specific quality or dispatch benefit. Do not port arbitrary model-generated JavaScript, destructive RPCs, or a second checkpoint ledger.

See [the baseline](01-baseline-and-fingerprints.md), [run metrics](04-live-runs-and-metrics.md), [gap matrix](06-figwright-vs-ours-gap-matrix.md), and [manual Desktop procedure](09-manual-desktop-acceptance.md).

## Commands and files

Read-only inspection included Git/runtime/build fingerprint collection, Figma install/process metadata, Figwright GitHub source/release inspection, and local source/document searches. The pinned Figwright checkout is in the system temporary directory at C:\Users\rayan-it\AppData\Local\Temp\figwright-fw1-e96ab03b9f96ec534c77cb76525fd76e5d892abe; no dependencies were installed.

The no-write harness check passed: all six fixtures validated, with 0 network requests, provider calls, Figma reads, Figma writes, and files written. The collector syntax check and build-identities.json parse also passed. Commands run: node docs/figwright-integration/fw-01/scripts/fw1-benchmark.mjs diagnostics-only; node --check docs/figwright-integration/fw-01/scripts/fw1-benchmark.mjs; and a Node JSON.parse check for build-identities.json. No full test suite, production build, model call, Figma write, or live GUI automation was run.

All 19 FW-1 artifacts are under this directory. Current Git status is main...origin/main with only docs/figwright-integration/fw-01/ untracked; git diff --name-only is empty. No existing tracked file, production source, or configuration was modified.

## Continuation check — 2026-11-22

The request to resume F0/F1 was handled as a continuation of this report. Read-only Windows app inventory and process/port checks found no Figma Desktop window and no listener on localhost:1455 or 127.0.0.1:3055. The available browser window titled “Figma Design Status — Mozilla Firefox” was not opened because its file identity and disposable status are unknown. The Figma Agent process is present. Therefore F0 and F1 still have no run IDs and remain BLOCKED, not mock.

The project has an existing local Companion credential store. Its filenames only were observed; contents were not read. The canonical npm run companion command compiles to dist-companion and uses the normal %LOCALAPPDATA%\Figma AI Design Engine storage. To honor the no-project-storage-change constraint, this continuation did not start it. [09-manual-desktop-acceptance.md](09-manual-desktop-acceptance.md) gives a verified isolated-temp launch command that compiles outside the checkout and points Companion storage at a separate temp directory. It has not been run; user approval is needed before the temporary store can hold an OAuth session.

The pinned Figwright server command is npx -y @figwright/mcp@0.8.0 in a project-scoped MCP client configuration. The client entry was not installed or started. First launch may download the package; no global Codex MCP settings were changed.

The isolated Companion compilation to TEMP succeeded and produced the same main/server hashes as the recorded dist-companion files; neither project build output nor storage was changed. The server was not started. The minimum remaining user inputs are: authorize two exact disposable file IDs/URLs for writes; confirm the A and B model/provider and the allowed F0/F1 call count or cost cap; approve the isolated temporary Companion credential scope and pinned Figwright package download; then open Desktop on the approved files and complete any sign-in directly. Exact actions are in [the existing operator procedure](09-manual-desktop-acceptance.md).
