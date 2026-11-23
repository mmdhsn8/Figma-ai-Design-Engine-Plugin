# 01 — Baseline and fingerprints

## Primary checkout

- Repository: C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated
- Branch and revision: main, 639fdb4f432429ca0dccda3652677a84a4374769
- Git state before adding FW-1 artifacts: clean; branch tracked origin/main.
- Local project package: figma-ai-design-engine 0.1.0, private.
- Current manifest: plugin ID 1574493506249715820; main dist/plugin.js; UI dist/ui.html; dynamic-page document access; localhost:1455 is the only dev-allowed domain.
- Universal versus Legacy selection: NOT MEASURED because the plugin UI was not open.
- Registered development manifest path and loaded build identity: NOT MEASURED. The manifest in this checkout is identified, but local file presence does not establish active registration.
- Selected account-visible model/provider: NOT MEASURED. No cached settings were used as a proxy.

Artifact fingerprints and modification timestamps are in [build-identities.json](build-identities.json). The Desktop process was not present. Figma Agent 126.11.9 was present; installed Figma Desktop metadata reported 126.11.11. This identifies an installed app, not a live application session.

The Companion source configures localhost port 1455. No listener on that port was observed. The compiled Companion entrypoints existed and were hashed, but Companion was not running. No current file/page, root count, selection, screenshot, or save health could be captured.

The known protected file was not opened. No disposable file/page has been designated. All before-state fields for the two candidate scopes therefore remain NOT MEASURED.

## Host and build

Observed host: Windows 10 Pro, version/build 10.0.19045. Node v24.21.0, npm 11.19.0, pnpm 11.25.0. The project's package script starts the Companion by compiling with TypeScript and launching dist-companion/companion/main.js; no build or restart was performed.

The plugin manifest points to the hashed compiled plugin/UI artifacts. Hash equality is a local fingerprint only. It does not prove that Desktop loaded those files. The Universal/Legacy selector, plugin version shown in Desktop, Companion status, selected model, Figma save health, and actual Figma file identities remain unverified.

## Figwright pin and compatibility

The source identity for this phase is the released tag v0.8.0 at commit 458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca. The GitHub release page identifies the signed release tag and commit. The pinned package is @figwright/mcp 0.8.0; the plugin manifest ID is figwright-dev, with main dist/code.js and UI dist/index.html.

The repository root lockfile declares pnpm lockfile version 9.0, pnpm 12.21.0, and Node ^24.11.0 or >=26.0.0. The MCP package itself declares Node ^20.19.0 or >=22.12.0. The local Node version satisfies both; the locally installed pnpm 11.25.0 does not match the repository-pinned pnpm, so no source build was attempted. No dependencies or plugin release artifacts were installed.

The release README documents a separate development plugin, local MCP server, Connected state, ping, Debug tab version comparison, list_files, and use_file. The README documents 147 MCP tools; the live client catalog is NOT MEASURED. Source and setup requirements are recorded in [the security/license note](07-security-license-and-compatibility.md).

## Scope and permissions

No Figma mutations, model/provider calls, screenshot captures, screenshots from private files, or plugin-storage reads were made. No user credentials, cookies, private canvas text, or raw model payloads were inspected. No global Codex MCP settings, registered manifest, caches, or plugin dependencies were changed.

Figma Desktop UI identity, active page IDs, empty state, two file assignments, one-writer-per-file state, account-visible model selection, and model/API/Figma cost approval are prerequisites for the live protocol. See [09-manual-desktop-acceptance.md](09-manual-desktop-acceptance.md).

## FW-1 continuation check — 2026-11-22

The read-only Windows application inventory showed no Figma Desktop window. The Figma Agent process was present. A Firefox window titled “Figma Design Status — Mozilla Firefox” was visible but not inspected or used; it is not an explicitly authorized disposable scope. No Figma Desktop UI was launched, because it may restore an unidentified existing file. Desktop automation is available, but there is no selected Figma window to control safely.

The current ports 1455 and 3055 had no listeners. Node is v24.21.0; npm and npx are 11.19.0 and npx.ps1 is available. The pinned Figwright MCP package requires Node ^20.19.0 or >=22.12.0, so the installed Node satisfies it. Its package version is 0.8.0, bin name figwright-mcp, and server entry is npx with args -y and @figwright/mcp@0.8.0. No package download, client configuration, plugin import, or server start occurred.

The default Companion data directory exists. Only filenames and modification times were observed: drafts-v1, credentials.v1.dpapi, and installation.json. Credential or installation file contents were not read. The standard Companion startup restores protected credentials and may persist installation metadata; because project storage must remain unchanged, it was not started against the default directory. The isolated-temp build/store command is documented in [09-manual-desktop-acceptance.md](09-manual-desktop-acceptance.md).

No exact test file IDs/URLs, page IDs, empty before-state, selected model/provider, or cost window were supplied. The local manifest/build hashes in [build-identities.json](build-identities.json) remain local fingerprints only; active plugin registration and Desktop-loaded hash remain NOT MEASURED.

The Companion source was compiled to C:\Users\rayan-it\AppData\Local\Temp\fw1-companion-build-639fdb4 with the local TypeScript compiler and an outDir override. The generated main.js and server.js hashes matched the existing dist-companion entrypoint hashes exactly. This confirms the temporary output path and compile command; it does not prove the server has started. The project dist-companion and all AppData storage files remained unchanged.
