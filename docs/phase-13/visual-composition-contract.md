# Phase 13 visual composition contract

## Contract shape

Phase 13 adds an optional, versioned `composition` object to the existing transient `VisualDesignSpec` preflight. It is derived from the saved generation request, screen role and section; it is not a new persistence store or a second renderer. New Chat and structured-generation manifests opt in with `visualCompositionVersion: 1`; absence of the optional marker means legacy behavior.

Version 1 carries:

- `screenRole`: `home | listing | detail | cart | checkout | account | other`.
- `visualIntent`: shared mood, compact/balanced/spacious density, semantic type scale, imagery treatment, and role-specific emphasis.
- `layout`: current viewport, available inner width, mobile inset, vertical flow, spacing scale, alignment, and content-driven overflow intent.
- `content.requiredPatternsBySection`: required pattern IDs for identity, primary and supporting sections.
- `assets`: authorized image and disclosed placeholder counts plus an honest status.
- `quality`: minimum pattern counts, minimum image slots, heading/button/price evidence, and no-unintended-overflow policy. Pattern roots also have role-specific child checks: app bars need a visible identity, navigation needs two labels, search needs an input, cards/items need images, multiple text fields and a price, galleries need images, hero/CTA groups need an action, variant selectors need two controls, quantity controls need controls and a current value, price summaries need three text values, and trust rows need a text value. Persian commerce pricing checks for a numeric amount followed by `تومان` or `toman`.

The contract is computed from the existing prompt, domain, family name, current pinned tokens and `sectionId`. It does not require a new model call or change the three sequential section requests. Role recipes use existing generated node types, patterns, brand tokens, Auto Layout, image authorization and native readback.

## Role recipes

The recipe is a minimum composition guide, not a hard-coded layout. Node dimensions, copy, color use, brand, audience, and copy length remain model and brief driven.

| Role     | Identity                                                   | Primary                                                                                        | Supporting                                              | Minimum quality evidence                                                                                        |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Home     | Compact app bar, search/discovery and requested navigation | Distinct campaign hero/CTA, category shortcuts and at least two product cards with image slots | Trust/promotion and bottom navigation where appropriate | Heading, visible CTA, at least two product-card roots and two authorized-image or disclosed-placeholder slots   |
| Listing  | App bar, search, category/filter controls                  | Product grid/list with title and price per card                                                | Navigation or helpful merchandising/trust content       | At least two product cards and image slots; no reuse of one generic card as the whole screen                    |
| Detail   | Compact app bar                                            | Gallery, title/price, size/color choices and prominent add-to-cart CTA                         | Delivery/trust and supporting product information       | Gallery image slot, heading, variant-selector, visible CTA and trust/supporting evidence                        |
| Cart     | Compact app bar                                            | Populated cart item row(s), variant/quantity controls, price summary and checkout CTA          | Delivery/discount/trust information when relevant       | Cart item with image slot, quantity controls, price summary and visible checkout CTA; no accidental empty state |
| Checkout | Compact app bar                                            | Form and transparent order summary with a clear submit action                                  | Delivery/payment guidance                               | Form, summary and primary action                                                                                |
| Account  | App bar                                                    | Account identity and requested account controls                                                | Helpful secondary navigation                            | Heading and requested action/control                                                                            |
| Other    | Preserve user-specific information architecture            | The named task and exact brief                                                                 | Relevant supporting content only                        | Existing high-fidelity structure checks plus requested patterns                                                 |

For a user-requested empty cart, the user must explicitly name that state. The normal cart recipe is populated by default. Product and gallery images may be approved assets or visible editable placeholders only. The contract checks price presence/format for Persian commerce, but not price correctness against a catalog, unique card copy, or visual balance.

## Preflight rules

- Required patterns are distributed to the identity/primary/supporting section that owns them; they are not demanded in every section.
- Each tagged composition root must be an editable native frame. Product cards, gallery and cart items need image coverage; CTA groups need a button; variant selectors need multiple touch-sized choices; cart items need meaningful text and an image slot; price summaries need multiple meaningful text values.
- Role-level minimum counts apply to the individual section before save/apply. Home/listing product density is checked with pattern counts, not raw node count.
- Image completeness is computed from actual authorized assets and placeholder nodes: `complete`, `placeholder-backed`, `not-required`, or `incomplete`. Missing assets never trigger network fetches or generated-photo claims.
- Existing button/input 44×44 checks, strict schema validation, wrapper limits, Auto Layout checks and native overflow QA remain in force. The recipe does not repair aesthetic findings by moving or deleting existing nodes.
- The UI preflights a section before durable save inside the existing one-repair loop. The plugin repeats preparation/verification before native apply. If the repaired section remains incomplete, it is rejected before save/apply. Stable finding IDs begin with `visual_composition.`.

## Backward compatibility

- Saved `GeneratedDesign`, `GenerationTransaction`, Chat task checkpoints, plan fingerprints and native identities remain unchanged. `DraftManifest` has one additive optional literal field, `visualCompositionVersion`; manifests without it remain valid.
- `VisualDesignSpec.composition` is optional in its schema. Old specs without it continue through the existing checks. Unknown optional composition keys are stripped so a newer harmless addition does not break an older reader.
- `screenRole` is derived when `createDesignPlan` is rebuilt from the existing request; no draft migration or rewrite is required. New drafts set the marker to 1. A saved older draft without the marker keeps legacy section preflight when resumed.
- In section scope, `prepareGeneratedDesign` assigns the owning section ID recursively through the generated subtree so nested tagged roots participate in section-local validation. The transient spec root remains unscoped.
- New `cart-item`, `variant-selector`, `quantity-control`, `price-summary` and `trust-row` IDs are additive pattern tags. Existing section JSON remains valid. New requests use them; old sections do not need these IDs to load.
- The Chat outcome's `assetCoverage` is optional so existing tests/adapters/checkpoints still parse. Phase 13's generator supplies it and completion copy reports placeholders honestly.
- If an older partially completed draft resumes, its already committed sections remain untouched and idempotent. New sections use the new preflight. The final complete-screen check reports any incompatibility; it does not remove or rewrite previously committed content.

## Implemented source slice and rollback

Source areas: `src/shared/design-patterns.ts` (role classifier and patterns), `src/shared/design-generation.ts` (role-aware prompts and section budget), `src/shared/visual-composition.ts` / `src/shared/visual-design-spec.ts` (contract and semantic preflight), `src/shared/generation-draft.ts` (optional manifest marker and matching section budget), `src/ui/design-generation.ts` (pre-save section preflight and image coverage), `src/plugin/generation-controller.ts` (pre-apply verification), `src/shared/chat-generation.ts` and `src/ui/chat-task.ts` (optional coverage result), `src/ui/App.tsx` (version marker, save gate and outcome summary), and focused tests.

Rollback is a normal source revert of the additive role/contract/preflight changes. No draft clearing, provider/account change, Figma canvas cleanup, dependency install, or manifest identity change is needed.
