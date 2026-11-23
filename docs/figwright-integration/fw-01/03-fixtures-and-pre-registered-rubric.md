# 03 — Fixtures and pre-registered rubric

Fixture JSON files are the canonical synthetic briefs. Both paths receive the same exact brief, language, viewport, role order, and asset policy for each fixture. Each fixture is run in a fresh approved disposable scope. No current file/page is assigned.

## Fixture matrix

| ID | Locale | Viewport | Domain | Requested screens | Roles |
|---|---|---|---|---:|---|
| F0 | Persian and English greeting inputs | Existing plugin chat | Safety/intent routing | 0 | None |
| F1 | Persian RTL | 390×844 | Independent learning | 1 | learning-dashboard |
| F3 | Persian RTL | 390×844 | Service booking | 3 | browse-filter, service-details, booking-confirmation |
| F10 | Persian RTL | 390×844 | Residential building management | 10 | dashboard, charges-debts, payment-details, announcements, announcement-details, maintenance-request, maintenance-tracking, facility-booking, resident-survey, profile-settings |
| FH | English LTR | 1440×900 | Ocean specimen archive | 1 | accession-overview |
| FE | Persian RTL | Existing disposable F1 screen | Scoped edit | 0 new roots | Existing learning-dashboard target |

F0 is a strict gate before generation. In our plugin, “hi” and “سلام” must return conversational replies with zero Canvas tasks, design programs, native writes, or unwanted task checkpoints. Read-only inspection must leave unrelated selection/content unchanged. Test Stop/Cancel only if the actual UI provides a known safe control. Do not proceed after any unexpected root or external mutation.

Run F1 first for each variant after F0 passes. F3 and later fixtures require that variant to pass its smaller safety gates. Do not force F10 after a smaller gate fails. FH stays held out from learning, booking, building-management, and commerce-specific composition. FE records a baseline and verifies that only the selected screen's authorized CTA label/accent nodes change; all unrelated root IDs and component masters remain stable.

## Run order and repeat policy

Controlled order: F0, F1, F3, F10, FH, FE. Alternate A/B order across repeated F1 and F3 pairs where possible. Aim for three valid comparable live runs per variant for F1 and F3. Report the exact smaller sample if cost or availability limits repetitions. Run F10 once per variant only after earlier gates pass and the cost window is approved. Do not issue hidden retries or repeat paid model calls. Preserve failures, retries, cancellation, and partial screens.

Compare the same model/provider and exposed settings when possible. If the in-plugin account and the separate MCP client use different providers/models or permissions, report a system-level experience comparison and a separate normalized execution-only comparison where genuinely observable. Do not claim model-isolated latency in that case.

## Visual rubric — score each completed screen

Score each category from 0 to 5 at actual 100% zoom and full-page/fit-to-screen zoom. A screenshot does not prove editability; a native tree does not prove visual quality.

| Criterion | 0 | 3 | 5 |
|---|---|---|---|
| Brief/domain correctness and semantic completeness | Wrong or absent purpose | Main purpose present with notable omissions | Complete and specific to the brief |
| Layout hierarchy, balance, density, scan path | Unreadable or chaotic | Usable with uneven density | Clear, balanced, intentional scan path |
| Typography and script readability | Broken or unreadable | Readable with hierarchy issues | Strong hierarchy; Persian shaping/RTL or English LTR reads naturally |
| Component and token consistency | No reusable system | Some consistent styles | Coherent reusable components and tokens |
| Imagery/illustration and provenance | Missing or misleading | Adequate labeled placeholders | Appropriate, high-quality authorized assets with provenance |
| Usability and accessibility | Controls unusable | Main actions work visually; some target/contrast issues | Clear navigation, meaningful CTAs, adequate targets and contrast |
| Visual distinctiveness | Plain wireframe or generic | Some design character | Deliberate, polished composition |
| Actual native editability | Flattened/uneditable | Mostly native with limited reuse | Text/layers/components verified directly in Figma |

Scores 1, 2, and 4 are intermediate judgments. Report human reviewer count and blind status. If no human reviewer scores a screen, record NOT REVIEWED; do not substitute an AI-generated score. Record severe safety defects separately; a high average cannot offset one.

## Objective native/visual checks

For every run, record exact requested and confirmed roots, unique native IDs, task-owned root order, node counts from readback, component instances versus flattened artwork, missing elements, actual width/height/bounds, horizontal clipping, intentional vertical scrolling, font readiness, minimum touch target, contrast findings, QA checks executed, screenshot paths, and editability proof. Mark inaccessible measurements NOT MEASURED.

The source rubric is frozen before any live run. If a criterion must change later, version the rubric and do not pool scores across versions.
