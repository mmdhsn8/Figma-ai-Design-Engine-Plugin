# Phase 12 live acceptance

**Status: NOT RUN — live acceptance remains separately gated.**

The user authorized local Phase 12 implementation only. No authenticated provider request, account/model selection, Figma Desktop mutation, protected document use, screenshot capture or live timing was authorized or performed. The `verify:phase5` script confirms the registered manifest and that compiled plugin/UI/Companion entrypoints are current; it explicitly does not perform OAuth or Desktop acceptance.

## Blockers

- No separate approval for a selected account-visible model and a newly created disposable Figma file/page was provided.
- No verified Figma Desktop GUI/native session or screenshots/native tree evidence was used.
- The live Companion/provider session and selected account/model were not verified for acceptance.

## Manual-assisted protocol after separate authorization

1. Open the registered manifest build in Figma Desktop and verify the visible Companion account/model.
2. Create/open a new disposable Figma file/page. Do not use a protected or production file.
3. Run one Persian two-screen Chat request; verify editable roots, 390×844 dimensions, RTL text, placement, no off-task mutation, no clipping/overlap and no duplicates.
4. Pause/reload/resume an incomplete task and confirm stable screen IDs and no replayed native roots.
5. Only after the smaller case passes and model cost/limits are approved, consider three-screen and ten-screen runs. Capture sanitized per-stage timing distributions, native layer counts, Layers/canvas screenshots and QA findings.
6. Compare to standalone structured generation only in the same disposable file, model and build, and report differences without implying equivalence.

No screenshots, timings, provider results or native pass claims are fabricated in this report.
