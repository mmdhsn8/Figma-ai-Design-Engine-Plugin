# 09 — Manual Desktop acceptance procedure

This procedure uses the controls and names documented by the pinned Figwright v0.8.0 release. It does not presume a live run is authorized. Do not issue a provider request or write to Figma until the user has approved the exact files, providers/models, run counts, and cost window.

## Required before opening either writer

1. Start/reconnect Figma Desktop. The installed version observed locally is 126.11.11, but the app was not running during this audit.
2. Create two new disposable Figma files with distinct names, for example FW1-A-OurEngine-Disposable and FW1-B-Figwright-Disposable. Assign A only to the existing Figma AI Design Engine registration and B only to the Figwright development plugin. Do not use Test Shop — Phase 1 Storefront or any customer/existing file.
3. In each file, record file and page identity, page ID, layer/root count, existing node IDs, selection, zoom, and save state before any test. Both must be empty and saveable. Stop if either scope has an unexpected node or external mutation.
4. Verify the registered A plugin's manifest ID is 1574493506249715820 and that the development registration points to this checkout and the recorded dist/plugin.js and dist/ui.html hashes. Confirm the loaded plugin version/build in the actual Desktop session. Do not re-register or replace the user's current manifest as part of this procedure.
5. Confirm the current Companion is running and the user selects the actual account-visible model in the plugin Settings. Record only a non-secret provider/model slug. The inspected Companion default port is localhost:1455. The current local Companion process was not running at audit time.
6. Obtain explicit approval for the exact A model/provider, B MCP model/provider, synthetic prompts, number of requests/runs, and possible provider/API/Figma/image costs. If the providers differ, mark latency as system-level rather than model-isolated.
7. For B, use the v0.8.0 release assets so the Figwright plugin and @figwright/mcp package are version matched. In Figma Desktop, use the documented path Menu → Plugins → Development → Import plugin from manifest… and select the v0.8.0 release manifest. Its separate plugin ID is figwright-dev; never replace the A manifest.
8. Configure @figwright/mcp@0.8.0 only in an isolated, project-scoped MCP client configuration supported by the chosen client. Do not edit global Codex MCP settings. The release README documents the npx command and says clients use the same basic server-entry shape, but it does not establish Codex's project-local configuration path; use the chosen client's documented local mechanism or stop. Do not use @latest for this pinned run.
9. Open the Figwright plugin in file B using the documented Plugins → Development → Figwright menu. Confirm its panel says Connected, check the Debug tab for matching server/plugin versions, and call ping. When multiple files are connected, use list_files and claim B with use_file using its exact fileName, or the unambiguous sessionId returned by list_files. Do not guess.
10. Verify one active writer per file, both version identities, and normal save health. Create sanitized run JSON with the provided collector. Never include credentials, account IDs, private canvas text, raw prompts/responses, or payloads in diagnostics.

The current checkout's documented Companion script, npm run companion, compiles TypeScript before it starts and may rewrite dist-companion. Preserve the recorded build hashes. If the test requires a rebuild to match the source, stop and obtain a separate approved build step; do not silently replace the recorded artifact.

## Gate and fixture order

1. Run F0 in A using fresh Chat messages “hi” and “سلام”. Expect conversational replies and zero Canvas task, model-driven design program, native write, or unwanted task checkpoint. Run only the approved read-only inspection and verify unrelated selection/content is unchanged. If the UI's Stop/Cancel controls are not clearly available and safe, do not simulate cancellation. Stop on any unexpected frame, write, duplicate, or external mutation.
2. Only if F0 passes, run F1 once in A and once in B, each in its own clean disposable scope. For B, use the exact Persian learning-dashboard brief in fixtures/F1.json. Confirm one ordered native root per variant, inspect at 100% and fit-to-screen, capture canvas and Layers panel, manually edit text, inspect component/style semantics, Persian shaping, clipping, scroll, and deletion.
3. Only if both F1 runs pass their safety gate, run F3 in isolated clean scopes. Record each of the three roots and progress in order. If a safe checkpoint pause/reload is not documented in the actual controls, mark recovery NOT MEASURED; do not terminate an active paid request to simulate interruption.
4. Run F10 only after the corresponding variant passed F0/F1/F3 and the ten-screen cost window was approved. Require ten unique native roots in requested order from one design request.
5. Run FH as the held-out domain without adding marine-specific templates/composers. Run FE on an approved disposable F1 result only after recording target and unrelated IDs/properties. Change only the selected screen's main CTA label and accent color.
6. Stop on any unsafe write, ambiguous commit, duplicate root, deletion, unbounded retries, incomplete checkpoint, or unexpected scope change. Preserve the document as-is, use read-only inspection to reconcile native IDs, and do not repeat an ambiguous write.

## Evidence return

For every run, retain its original run JSON and include source labels, exact status, native root IDs/counts, node and component instance counts, provider/tool/batch counts with their evidence source, timer spans, geometry/QA results, screenshots, reviewer scores, recovery, and errors. Redact account chrome. Return the sanitized run JSON and test-file screenshots/readbacks; do not send tokens, cookies, account identifiers, credentials, or customer canvas content.

If required Desktop UI control, model authorization, isolated MCP configuration, or an approved disposable scope is unavailable, leave the run BLOCKED. Do not substitute mock timings or screenshots.

## F0/F1 continuation: exact prerequisites and startup

### Companion without using existing project storage

The repository's canonical command is npm run companion. It compiles the current Companion source into dist-companion and starts it; its normal startup uses %LOCALAPPDATA%\Figma AI Design Engine, where existing drafts, DPAPI credentials, and installation metadata are present. Do not run it against that directory while the no-project-storage-change constraint is active.

After approval to use a separate temporary OAuth store, this PowerShell command compiles into TEMP and starts the same current source against that isolated store. It does not edit the repository's dist-companion, renderer, Chat UI, or project storage. Sign-in, if needed, must be completed directly by the user; never paste credentials into chat. The temp store may hold an encrypted OAuth session and should be treated as sensitive until the user decides its retention.

~~~powershell
Set-Location 'C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated'
$fw1Build = Join-Path $env:TEMP 'fw1-companion-build-639fdb4'
$fw1Data = Join-Path $env:TEMP 'fw1-companion-data-639fdb4'
New-Item -ItemType Directory -Force -Path $fw1Data | Out-Null
& '.\node_modules\.bin\tsc.cmd' -p '.\tsconfig.companion.json' --outDir $fw1Build
if ($LASTEXITCODE -ne 0) { throw 'Companion compilation failed; do not continue.' }
$env:LOCALAPPDATA = $fw1Data
node (Join-Path $fw1Build 'companion\main.js')
~~~

The last command stays in the foreground and reports the loopback listener. Press Ctrl+C to stop it after the approved run. Startup alone does not issue a model call. Do not continue if the port is occupied, storage errors appear, or a sign-in/approval page is not expected.

On first plugin connection the Companion may open its local approval page in the system browser. The user must inspect and complete that approval directly. Do not automate credentials or accept an unexpected destination.

### Pinned Figwright MCP server

The audited release is v0.8.0, source commit 458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca. The pinned npm package declares Node ^20.19.0 or >=22.12.0; local Node v24.21.0 satisfies it. Its package binary is figwright-mcp. The verified upstream server entry is:

~~~json
{
  "mcpServers": {
    "figwright": {
      "command": "npx",
      "args": ["-y", "@figwright/mcp@0.8.0"]
    }
  }
}
~~~

Use this entry only in a project-scoped configuration supported by the chosen MCP client. The v0.8.0 README gives this shape for Claude Code and says other clients use the same basic shape; it does not establish a Codex project-local configuration path. Do not modify global Codex settings. The first npx launch may fetch the package from npm, so obtain approval for that download before running it. No dependency installation or MCP configuration was performed during this continuation.

The matching Figma plugin comes from the [v0.8.0 release](https://github.com/awdr74100/figwright/releases/tag/v0.8.0). The user must download/import its separate manifest in Figma Desktop using Menu → Plugins → Development → Import plugin from manifest… and verify that the Figwright panel is Connected, its Debug tab shows matching server/plugin versions, and ping succeeds. Its plugin ID is figwright-dev; do not replace the Engine manifest.

### Minimum direct user actions before F0/F1

1. Start Figma Desktop directly and sign in there if needed. Open only the two new disposable files and provide their exact URLs/file IDs and page IDs. Confirm A is authorized for the Engine and B for Figwright, both are empty/saveable, and both may receive the fixture writes. Do not open the visible but unidentified “Figma Design Status” browser window for this test.
2. Select the account-visible Engine model in plugin Settings and the model/provider used by the separate MCP client. Approve two F0 Chat messages (hi and سلام), one F1 request per engine, and a maximum call/cost window. If providers differ, the result is an experiential comparison, not model-isolated latency.
3. Approve the isolated temp Companion OAuth store and the one-time download/run of @figwright/mcp@0.8.0. Complete OAuth directly in the browser if prompted. Never share credentials.
4. Verify the Engine development registration still points at this checkout/build. Start the Companion command above. Launch the Engine only in A. Import/launch Figwright only in B, connect the MCP client, verify versions, and claim B with list_files/use_file if required.
5. Run F0 in A. Continue only if “hi” and “سلام” produce conversational replies with zero Canvas tasks, programs, writes, and unwanted checkpoints. Then run the identical fixtures/F1.json brief independently in A and B. Use the existing FW-1 collector to create one run record per variant and attach native readbacks, screenshots, timing spans, and QA. Stop if any extra root, deletion, ambiguous commit, or cross-file write occurs.

No F3 or F10 run is authorized by this continuation; those remain behind credible F1 evidence.

The exact server process command, when launched by that configured MCP client, is `npx -y @figwright/mcp@0.8.0`. It communicates over stdio; typing it into a normal terminal does not create a standalone design agent.
