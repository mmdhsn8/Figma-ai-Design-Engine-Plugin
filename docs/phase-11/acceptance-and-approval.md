# Live acceptance and approval gate

## Status

**User authorization: granted for one two-path comparison confined to a new disposable Figma file and the visibly selected account model. Execution: blocked.** This agent has no tool for controlling/observing the Figma Desktop window, so it cannot verify the selected model/account or create and confirm the new file. The Companion is also not listening at `localhost:1455`. No live provider or Desktop action has been taken. This gate must not use a protected, customer, or existing production document.

## Approval requested next

The user has already approved one controlled comparison in a **new, disposable Figma file/page** using the explicitly selected account-visible model: run one representative two-screen Persian mobile brief through structured generation and an equivalent two-stage Chat request, recording sanitized timings and editable-layer evidence. This authorizes native mutations only inside that disposable file and the required provider calls. No account switching, new credentials, or changes to protected files are included. The remaining prerequisite is technical: attach a legitimate Figma Desktop control tool to this session so the active model and disposable file can be verified; do not substitute manual guesses or an existing file.

After the evidence is reviewed, request a **separate** approval before implementing Phase 12. This document alone does not authorize that implementation.

## Preconditions

1. User confirms the exact new disposable Figma file/page and selected account-visible model; do not infer either from cached state.
2. Build from the current source and verify that Figma's registered `manifest.json` is this checkout. Record source revision, dirty status, artifact hashes/timestamps, plugin build time, Companion build/restart time, and Desktop version.
3. Record commit `8088aa0` as the source baseline and disclose that its native-repair changes were concurrent with this audit. At the final audit status, only the Phase 11 documents were untracked; verify the source/manifest/artifact identity again immediately before launch. Do not silently amend/rebase the concurrent commit or load a stale binary.
4. Use the same brief, screen dimensions, language, model, Desktop session, and empty test page for both paths where their contracts permit. Record exact screen/node count. Do not run a 400-screen stress case in the first gate.
5. Verify the user selected the model and understands the provider requests and test-file-only native writes. Do not export prompts, private canvas copy, raw provider responses, tool arguments, tokens, or credentials.

## Run protocol

1. Save before-state evidence for the disposable page: current page, selection, layer count, and screenshot.
2. Run the two-screen brief through structured AI generation. Record each section's request ID, headers/first-delta/completion, validation, durable save, native render, and per-screen verification timing. Verify exactly the planned screens and editable native layers.
3. In a clean second area of the same disposable page, run the equivalent Chat task. Record model rounds, native batches, mutations/read-only/verification counts, first confirmed native progress, checkpoint/recovery status, and total completion time. Do not force identical node structure where the workflow contract differs.
4. Visually inspect screenshots and Layers for Persian copy, text editability, 390×844 root dimensions, clipping/overlap, hierarchy, duplicate layers, and unrelated-content preservation.
5. If safe, pause/reload/resume one incomplete test task once. Verify stable native identities and no duplicate creations. Stop immediately on repeated-error/no-progress, incomplete QA, or uncertain partial mutation; retain the evidence and do not retry-loop.
6. Export only sanitized diagnostics and aggregate timing fields. Redact user/private content from screenshots.

## Pass criteria

- The registered current build is proven and the model/account are user-approved.
- All requested stages/sections complete or return a precise bounded failure; no prose-only success is accepted.
- The task-owned native layers have stable identities, are editable, and match the intended viewport; no duplicate or unrelated layer mutation occurs.
- Pause/reload/resume preserves confirmed work and does not re-run completed generation or create duplicates.
- Native QA coverage is complete for the tested scope; remaining findings are disclosed rather than suppressed.
- Timings separately identify provider, validation/persistence, plugin/native execution, and final verification. Missing fields remain `NOT MEASURED`.

## Evidence to return

Return the selected model slug, build identity, screen and node counts, request/round/batch counts, stage timings and total distributions, bounded QA finding codes/metrics, sanitized failure diagnostic if any, and redacted screenshots showing canvas plus Layers. Never return tokens, credential material, raw model bodies, raw tool payloads, or unrelated document text.

Until this gate is completed with live evidence, the correct status remains **AUDIT PARTIAL**. Phase 12 implementation is a second explicit decision.
