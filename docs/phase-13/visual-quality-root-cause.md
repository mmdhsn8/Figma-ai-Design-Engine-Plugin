# Phase 13 visual-quality root cause

## Evidence boundary

The Phase 13 request describes a sparse three-screen Persian storefront screenshot. The attachment available in this checkout contains the written directive only; no screenshot or sanitized provider/native run trace is present in the repository or supplied attachment. The screenshot appearance is therefore **user-reported, not inspected evidence**. Source findings below explain how sparse output could pass; they do not prove the exact screenshot cause.

Checkout at diagnosis: branch `main`, HEAD `e86c8d678168a9add1bce0b9f8eee404b175c95f`, clean tracked and untracked state. This differs from the Phase 12 report's historical source hash. The current manifest is `manifest.json`, ID `1574493506249715820`, with `dist/plugin.js` and `dist/ui.html` entrypoints. The Phase 12 report labels its implementation CODE COMPLETE / LIVE NOT RUN; its mocked tests do not establish visual acceptance.

## End-to-end quality map

```text
Persian Chat request
  -> typed Chat intent / planned names, purposes and shared brief
  -> createDesignPlan (domain, fidelity, IDs, Brand Kit, selected Skills)
  -> 3 sequential identity / primary / supporting section prompts per screen
  -> strict GeneratedDesign schema and geometry / touch-target validation
  -> UI section composition preflight -> durable section draft
  -> plugin-side preparation and verification before native apply
  -> existing transaction renderer and fresh native readback
  -> Chat task root/section verification
  -> human screenshot review (not available for this handoff)
```

The Chat adapter, typed planner, durable section store, transaction ledger, and native renderer are reused. `src/ui/design-generation.ts` creates a visual spec before a section is saved. `src/plugin/generation-controller.ts` prepares/verifies it again before native mutation. There was no absence of section preflight; the confirmed gap was that the preflight checked schema, geometry, renderer support, and tagged pattern presence without role-specific semantic density requirements.

## Ranked hypotheses

1. **Semantic gaps passed section preflight — confirmed source gap; exact screenshot cause not verified.** For section scope, `src/ui/design-generation.ts` disables only the whole-screen high-fidelity nested-frame/heading/visual-region checks. Tagged required patterns, geometry, and schema validation still run, and plugin-side preparation repeats before apply. Neither path required two useful product cards, multiple variant choices, populated cart content, or price-summary fields. A structurally valid shallow section could therefore pass. `src/shared/visual-composition.ts` now adds those deterministic role-specific checks; regression tests verify a sparse detail section is rejected before saving. This is a mechanism, not attribution to the unavailable screenshot.

2. **Persian product-detail names could receive listing defaults — confirmed defect, now corrected.** The old `catalog` and `detail` regexes both matched `محصول`; the high-fidelity branch tested catalog first. `inferDesignScreenRole` now checks cart, checkout, detail, home, account, then listing. New commerce defaults are role-specific and section-local. Persian classifier and detail/cart distinction tests cover the regression.

3. **Primary content had an unnecessarily low cap and generic prompt — confirmed constraint; visual contribution not verified.** Each mobile section was capped at 210 px. With three sections, two 16 px gaps, and 40 px outer padding, the maximum stack was 702 px of an 844 px screen. Commerce section prompts were generic. The primary cap is now 340 px, while identity/supporting remain 210 px, yielding a theoretical 832 px maximum. Role-specific prompts describe task content. This capacity calculation is not a live geometry measurement, and the source does not add scroll/clip intent.

4. **Missing authorized merchandising images may reduce visual richness — policy confirmed; occurrence not verified.** The strict generated schema requires authorized image IDs or explicit placeholder nodes; pinned Brand Kit assets are checked against the resolved set. Native image placeholders visibly disclose that they are not real photos. Version 1 now returns an aggregate authorized-image/placeholder coverage status. No asset inventory or generated output from the reported run exists to determine what it used.

5. **Generated Chat schema constrains visual range — capability limit confirmed; contribution not verified.** `GeneratedDesignNode` supports native frames, rectangles, ellipses, text, allowlisted icons and images, semantic palette roles, basic layout, radius, stroke, opacity, and soft elevation. It has no gradient, arbitrary vector path, clipping/scroll intent, or component-reference field. This phase stays on existing supported primitives; the broader importer renderer supports richer specs.

## Implemented fix and limits

- Persian screen roles and commerce recipes are shared by planning, section prompts, and preflight. Home asks for a campaign, categories, and at least two cards; detail asks for gallery, variants and purchase CTA; cart asks for a populated row, quantity, price summary and checkout CTA.
- Contract v1 validates required role patterns by section, minimum card/item/variant/price/action/image/heading evidence, Persian Toman amount presence, and aggregate image coverage. It uses existing editable nodes and the existing bounded section repair path; it does not invent assets or layouts.
- New structured drafts opt in with optional `visualCompositionVersion: 1`. Old manifests without the marker retain legacy preparation. The section-scoping regression is covered by a full generated-detail fixture.
- Tests establish semantic presence/counts and Toman-formatted amounts, not catalog price correctness, unique product copy, subjective design quality, actual Brand Kit/Skill influence in a screenshot, real font availability, or Figma rendering.
- No local screenshot or sanitized response was available. Actual Phase 12 screenshot causality, provider request count, elapsed time, native screen/node count, and human screenshot acceptance remain **NOT VERIFIED / NOT MEASURED**.

## Evidence still needed for exact screenshot attribution

Attribution requires a sanitized three-screen artifact or, on a separately approved disposable Figma file, the exact brief, model slug, pinned Brand Kit/Skill revision IDs, saved section trees, pattern tags and redacted screenshot. Private copy, raw provider bodies, credentials and unrelated document content are not needed and must not be included.
