# Phase 13 RTL layout and native QA

## Existing invariants retained

- Mobile screens use native 390×844 roots; each generated section has a 350 px maximum width, a 340 px primary / 210 px identity and supporting height budget, an Auto Layout direction, and bounded descendants. The maximum combined section stack plus existing gaps and outer padding is 832 px.
- Chat handoff preserves the existing `identity -> primary -> supporting` transaction order, stable task/screen/section identity, save-before-render, idempotent apply, checkpoint recovery and fresh native verification.
- Buttons and inputs retain the existing 44×44 px effective target contract. The geometric normalizer rejects/reflows only within the existing supported layout rules.
- Pinned Brand Kit fonts are requested and available-font fallback is recorded. Persian text remains native/editable. Image placeholders keep the “not a real photo” disclosure.
- Canvas placement and the existing 6000 px row-wrap / 120 px gap constants remain in the current renderer. No placement policy changes are planned.

## Phase 13 checks

The UI composition gate runs before each section is durably saved; plugin-side preparation repeats before apply. It checks role-required semantic patterns and meaningful child roles inside the validated section. Stable preflight codes identify missing patterns, image slots, card/item counts, headings, buttons, variant controls, price summaries and Persian Toman amounts. Schema, touch-target and geometry failures remain blocking. A valid image placeholder counts as an honest image slot but not as an authorized photo asset.

After render, existing fresh native readback continues to verify node identity, text, token/style application and measured geometry/visibility. Existing overflow, clipped-child, overlap, contrast and incomplete-scan findings keep their current severity and fail-closed completion semantics. Aesthetic judgment remains a human screenshot-review requirement; pattern counts are evidence of composition coverage, not a universal beauty score.

## Deterministic coverage and remaining checks

- Phase 13 tests cover Persian home/listing/detail/cart role classification, role-specific prompt content, non-empty app-bar/navigation/search semantics, valid home cards/cart rows/detail controls, sparse-section rejection, Toman amount checks, placeholder coverage, section-budget arithmetic and old manifest parsing.
- Existing Brand Kit tests verify pinned color/type/radius/effects application; existing renderer/Brand Kit tests cover approved image mapping and placeholder disclosure. These are deterministic tests, not proof of the reported run's Brand Kit influence.
- Existing native repair tests exercise measured 350 px horizontal parent overflow with 504 px required width and require remeasurement; existing native visual tests distinguish configured vertical scroll overflow from cross-axis clipping.
- Existing design-generation tests cover Persian RTL alignment/wrapping repair and bounded output geometry; native QA tests remain in force for clipping, overlap and incomplete scans.
- Existing draft/Chat tests cover save/reload/resume, idempotent writes, duplicate prevention and checkpoint safety. Screen-count tests cover one-screen and bounded multi-screen plans; large cases are mocks.
- The new semantic gate is run inside the existing one-repair loop before durable section save, then repeated before native section apply. Full failure/repair behavior is covered by existing generation transaction tests; no unrelated Figma mutation is invoked by source tests.
- A long copy run, actual font availability, actual Figma wrapping, full all-sections live scroll behavior, and one integrated live three-screen screenshot remain unmeasured.

Actual Figma font availability, live text wrapping, scroll behavior and screenshot acceptance remain unmeasured until the explicit disposable-file gate is approved.
