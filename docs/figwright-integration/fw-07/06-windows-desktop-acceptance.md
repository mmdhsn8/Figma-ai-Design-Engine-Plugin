# FW-7 — Optional Windows Desktop acceptance

This procedure is optional and requires a separately authorized disposable Figma file/page, plus explicit provider-cost and image-transmission consent when those capabilities are exercised. Do not use the protected Test Shop — Phase 1 Storefront file or other user documents.

## Prepare an identifiable build

In PowerShell, from the repository root:

```powershell
$env:VITE_FW7_DIAGNOSTICS = 'fw7-diagnostics-v1'
$env:VITE_FW7_BUILD_ID = 'fw7-acceptance-YYYYMMDD-HHMM'
npm run build
npx tsc -p tsconfig.companion.json
```

Set the exact same diagnostic gate for Companion before starting it. Use the generated plugin build from this repository's existing development registration; verify its UI/plugin and Companion build IDs before starting the fixture. Record every other FW gate explicitly as off or as separately approved for the run. After collecting events, clear the gate variables and rebuild/restart with diagnostics off.

## Run and collect

1. Create a disposable file and page with no unrelated user content. Record generic file/page labels and locally hash the Figma IDs for the manifest.
2. Keep each fixture run isolated: F0, F1, F3, F10, FH Persian building-management, then FE existing-design enhancement. Run gate-off and gate-on separately on clean disposable copies so one run cannot contaminate the other.
3. For each run, record the feature flags, build IDs, expected screen count, root IDs (hashed in the artifact), attached root/tree state, readback outcome, checkpoint confirmation, Stop/Resume outcomes, and screenshot evidence if explicitly permitted.
4. If testing provider review, record provider authorization and separate consent to transmit the screenshot. If testing capture without transmission, keep the PNG local and do not send it to a provider.
5. Export each source using its existing local diagnostic hook. Companion export is `GET http://127.0.0.1:1455/v1/diagnostics/fw7` with `Origin: null`; UI/plugin export uses `__FW7_EXPORT_DIAGNOSTICS__()` in that runtime's local developer console. Do not put exports in chat history or checkpoints.
6. Fill a fresh copy of `run-manifest.template.json`, validate and collect with `npm run fw7:acceptance -- validate-events ...`, then retain the manifest, raw exports, collected artifact, screenshots/receipts, and exact build IDs together in the authorized acceptance folder.

## Pass criteria

- Only authorized task roots change; page and parent IDs match the manifest; no duplicate or silently recreated roots appear.
- The owner reports native success only after readback and existing checkpoint confirmation. Stop fences late outcomes and Resume reconciles the same original root.
- Gate-off/on tree and root identity are equivalent. Record dispatch count, Figma call hooks, checkpoint operations, readbacks, request counts, retries, failures, and actual elapsed Desktop wall time separately.
- Do not call local harness duration “Desktop latency.” Do not promote a feature gate unless dispatch/recovery evidence is useful and no safety regression is observed.

Any injected failure must use only a disposable file and a documented reversible step. Preserve attached task-owned roots for inspection; never use deletion as an acceptance cleanup shortcut.
