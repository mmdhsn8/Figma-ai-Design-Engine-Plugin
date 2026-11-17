# Live Figma Desktop acceptance

## Result

**NOT RUN — live evidence is pending.** Figma Desktop 126.11.9 is installed and registers the current checkout's manifest. The open Desktop document is an existing Test Shop file, which is protected. No disposable file/page and no account-visible model were authorized for provider requests and native writes. The Companion was not running on port 1455. No Figma document was read or mutated in this task.

The following script is ready for a user-authorized disposable file. Select the model explicitly in the existing plugin session; record its exact displayed slug. Use the just-built manifest-loaded bundle and a separate new file/page. Stop on unexpected cost, ambiguous native acknowledgement, incomplete QA, no progress or any visual failure.

## Manual acceptance script

1. Confirm Desktop is version 126.11.9 (or record the actual version), development plugin ID `1574493506249715820`, registered manifest path, and built hash of `dist/plugin.js`/`dist/ui.html`. Confirm the Companion process is the intended current checkout and listens on the expected loopback port.
2. Create/open a new disposable Figma file/page and record its file/page ID. Select an account-visible model explicitly and confirm model-use authorization. Do not use Test Shop or another existing/client document.
3. From one Chat task, generate one unfamiliar-domain desktop screen. Inspect editable Layers, text and geometry; verify the task has one root and one verified screen.
4. In separate fresh tasks on that disposable page, generate three Persian RTL mobile screens and ten mixed-role screens in one project. Confirm 390×844 mobile roots with vertical overflow, 1440×900 desktop roots where applicable, all native roots editable, exact plan order, shared design tokens, complete readback and no duplicate roots.
5. For RTL, inspect mixed Persian/English/numerals at 100% zoom, verify the selected available fonts, reading order and painted bounds; check long text/scroll and no clipping. Test one local component master and its instances if the chosen brief uses them.
6. Cancel one task while two independent screens are generating. Confirm the partial state is truthful, saved siblings are retained, then resume the same task and verify stable IDs/no duplicate roots. Separately pause/reload the plugin at a durable checkpoint and resume. Perform one scoped heading edit; compare unaffected screen/component snapshots.
7. Save redacted overview and 100%-zoom screenshots plus safe task diagnostics. Archive task ID, screen IDs, selected model slug, build hashes, timings, requests, QA coverage/findings and observations without prompts, credentials or private canvas text.

## Result template

```text
Status: NOT MEASURED / PASS / FAIL
Desktop version:
Registered manifest path + plugin ID:
Companion executable/source identity + port:
Disposable file/page ID:
Selected account-visible model slug:
Build hashes (plugin/UI/Companion):
Scenario (1 / 3 RTL / 3 LTR / 10 / cancel-resume / scoped edit):
Task ID and screen IDs:
Provider requests, first verified, total elapsed, retries:
Native batches, roots, editable node counts:
Geometry/QA coverage and finding codes:
Fonts, glyph shaping, RTL/LTR, scroll, clipping:
Component/master and unaffected-edit results:
Screenshots and sanitized diagnostic artifact paths:
Failure/recovery notes:
```

Until this procedure is authorized and recorded against the built code, status remains **CODE COMPLETE / LIVE PENDING**.
