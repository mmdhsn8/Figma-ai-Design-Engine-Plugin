# Phase 6 — Professional Visual Design Engine

## Audit findings

The repository did not contain a saved model response, native layer dump, or screenshot for the reported text-only ten-screen run or the earlier Charm Home edit. Their exact generated layers and per-node failures therefore cannot be reconstructed from source. The prior Phase 5.8 audit records the baseline limitation and explicitly separates its synthetic fixtures from Desktop evidence.

The source path did establish these causes and gaps:

| Area                | Evidence in the prior implementation                                                                                                                                                                                              | Effect                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation contract | `DesignGenerationRequestSchema`, `createDesignSections`, and `createDesignSectionInstructions` divided screens into generic identity, primary, and supporting slices. The output schema described basic frames, shapes, and text. | The model had no per-screen semantic visual spec or enforceable pattern checklist; three individually valid slices could compose into a weak screen. |
| Visual primitives   | The general JSON renderer already supported image fills, vectors, styles, components, and Auto Layout. The progressive generation schema did not expose real image assets; generated image nodes are now disclosed placeholders.  | Renderer capability was wider than the actual generation contract. Real image generation or stock sourcing was not present and is still not claimed. |
| Native completion   | The prior generation controller accepted a successful render acknowledgement; it did not fresh-read the full composed screen after all section commits.                                                                           | A write acknowledgement could be mistaken for a verified design result.                                                                              |
| RTL and fonts       | Renderer loads available fonts with fallback and writes alignment, line height, and tracking. Installed Figma typings do not expose a text-direction setter.                                                                      | RTL alignment can be verified; full bidirectional shaping of mixed Persian/Latin text cannot be guaranteed by this plugin.                           |
| Scale and latency   | UI drives three sequential model section requests per screen and persists each result before native application.                                                                                                                  | Work is resumable and bounded per section, but model latency is multiplied by project size. It is not instant or constant-memory.                    |

These are architecture findings, not proof that every prior live failure had the same cause. Model output and actual Figma document state remain necessary to attribute any specific old run.

## Implemented

- Added versioned `DesignBrief` and `VisualDesignSpec` schemas in `src/shared/visual-design-spec.ts`. They carry fidelity, domain, locale/direction, palette and spacing/radius tokens, viewport, safe-area/grid, ordered native refs, parent refs, node types, typography evidence, placeholders, patterns, and native assertions. Older saved generation manifests remain valid because fidelity is optional and resolves to high fidelity unless wireframe is requested.
- Added a reusable composition catalog and inference in `src/shared/design-patterns.ts`. High-fidelity commerce home/catalog/detail/checkout and dashboard/SaaS screens receive domain-specific required patterns; unrelated domains do not receive product cards. Product cards and galleries require a native image layer or a clearly disclosed placeholder.
- Added a bundled, local editable vector icon allowlist in `src/shared/design-icons.ts`. No arbitrary SVG, URL, or emoji is treated as a professional icon asset.
- Extended progressive generation prompts and node validation in `src/shared/design-generation.ts` and `src/ui/design-generation.ts`. Generated nodes receive deterministic logical refs and semantic pattern metadata. When no authorized image exists, the output contains an editable image slot, simple native illustration, and visible “not a real photo” disclosure.
- Added bounded, yielding, fresh native-tree verification in `src/plugin/native-design-verification.ts`. It checks page/root identity, expected refs, native type and ancestry, viewport, geometry/visibility/clipping/overlap/contrast, required patterns, exact generated text, palette color values, typography size/alignment/line height/tracking, and Auto Layout direction/gap. The scan stops at 5,000 nodes or depth 48 and returns incomplete rather than claiming coverage.
- Wired full-screen verification after all progressive section transactions in `src/ui/App.tsx` and `src/plugin/generation-controller.ts`. A render acknowledgement alone is no longer sufficient to show a ready result. Verification is read-only and preserves screen roots, selection, and committed section transactions.
- Expanded single-platform planning to 400 screens and responsive planning to 200 families (400 native screens); added regression planning coverage. Per-section, per-screen, draft, node, and render limits remain enforced as described below.
- Extended the registered-manifest checker so the `dist/plugin.js`, `dist/ui.html`, and Companion outputs must contain the new verification/spec modules and be at least as fresh as their sources.

## Native and performance evidence

The native verifier yields to Figma every 64 visited nodes and caps a single screen scan at 5,000 nodes/depth 48. The normal generation controller verifies each just-rendered section and then verifies each composed screen. This bounds a verification slice, but actual Figma host timings have not yet been measured in Desktop.

Local Vitest renderer proxy measurements from the focused run were:

| Mock workload               | Rendered nodes | Elapsed | Sampled heap delta |
| --------------------------- | -------------: | ------: | -----------------: |
| 100 visual roots            |            300 | 21.1 ms |       about 7.9 MB |
| 10-screen Phase 4.5 fixture |            325 | 34.1 ms |      about 10.8 MB |

These are mock renderer measurements, not native Figma timings, Companion latency, model latency, UI transfer measurements, or visual acceptance. Generation UI already reports per-section model/validation/persistence/native timings and bytes/events; no secrets or prompts are emitted in those diagnostics.

## Limits and unresolved capabilities

- The section workflow still makes up to three sequential model requests per screen and one bounded repair request on validation failure. A 400-screen run can therefore require up to 1,200 normal model calls; no Desktop timing claim is made.
- Storage remains bounded: a section is at most 1 MiB/250 nodes, a screen 8 MiB, a draft 64 MiB, and a composed project 100,000 nodes. The 400-screen planner test verifies planning only, not a full 400-screen live render. A workload exceeding those guards is stopped with a retained checkpoint; “unlimited scale” is not implemented.
- A document-level draft can contain at most eight retained project directories before an explicit old-project cleanup is required. This retention policy is unchanged.
- No generated/stock image provider or license/provenance resolver was added. The engine does not claim photo generation. User/document asset reuse remains available only where the existing JSON renderer receives authorized embedded assets.
- The spec captures brand direction and audience as an explicit unknown when omitted; audience/content hierarchy are not extracted into a richer independent ontology yet. The user prompt remains the authoritative copy/constraint source.
- Automatic native verification is structural/value based. Figma plugin APIs do not provide a trusted screenshot-based aesthetic judgment here. Optical balance, mixed-direction Persian shaping, and visual polish still require a Desktop visual review.
- A native QA failure retains committed nodes and stops completion. A model-guided design repair is not automatically run after the fresh full-screen QA fails; no unbounded repair loop is introduced.
- Phase 5.9.5 issues listed in the project request remain a separate regression ledger. These Phase 6 changes do not certify visible-background selection, all chat edit-plan refs, or every live Stage 2 recovery scenario; existing tests and operations were preserved.

## Acceptance matrix status

| Case                     | Automated evidence                                                                               | Live Figma evidence                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Persian commerce home    | Planner, pattern, image-placeholder, RTL, hierarchy, and native mock verification tests          | Not yet verified                                             |
| Existing Charm Home edit | No replacement/edit path added to generation; chat executor safety remains separate              | Not yet verified; no assumption about current document state |
| English dashboard        | Domain inference, dashboard pattern and general node-schema tests                                | Not yet verified                                             |
| Ten-screen project       | Existing ten-screen renderer fixture and resumable section tests                                 | Not yet verified                                             |
| 300–400-screen workload  | 400-screen plan and 400 responsive counterpart planning regression; bounded section/draft guards | Full render not tested                                       |
| Safety/recovery          | Existing task, transaction, ref and native QA tests retained; new fresh-value/spec checks added  | Not yet verified                                             |

**Live Desktop acceptance remains UNVERIFIED until the registered plugin and Companion are loaded in the actual Figma document, a real creation/edit is performed, and the native layer tree and visible canvas are inspected.** Passing tests or `verify:phase5` does not satisfy this condition.

## Phase 7 handoff

Next work should address durable paginated draft loading and project-size policy before claiming multi-hundred-screen rendering at production scale; add user/document asset resolution with explicit provenance; add screenshot/manual visual evidence capture; and test actual Charm Home edit/reuse in the registered Figma Desktop document. Keep Phase 5.9.5 recovery and visual-target regressions as explicit acceptance blockers until each is exercised against native evidence.
