# Phase 4 — Cross-Domain Evidence

**Evidence class: local scripted provider responses + Figma host mock. No live provider or Desktop evidence.**

## Same Universal path

`tests/universal-design-chat.test.ts` exercises `runChatTask`, provider tool-call parsing, the Phase 2 adapter, local renderer and mock native readback for these independent briefs:

| Brief | Locale / viewport | Planned screens |
| --- | --- | --- |
| Student learning | Persian RTL, mobile 390×844 | Learning home, lesson detail, progress/quiz |
| Appointment booking | Persian RTL, mobile 390×844 | Service search, provider detail, booking confirmation |
| SaaS analytics | English LTR, desktop 1440×900 | Workspace overview, report and team settings |
| Marine specimen archive (held out) | English LTR, desktop 1440×900 | Accession intake, provenance review, conservation record, loan readiness |

The marine brief is authored as a separate evaluation case after implementation. Its assertions cover the saved domain tags, key entities, distinct screen purposes, four completed/verified task-owned roots and relevant rendered content; it also rejects commerce terms. It uses the same harness and Universal route, with no production-domain template or special-case branch.

Tests assert a single shared visual language across a project, a valid deterministic seed, composition decisions and actual region-to-editable-node structure. The fixture builder now returns different editable topologies for different first-three screen roles. The suite also exercises a one-region sparse confirmation to ensure the earlier node-count floor is gone.

## DesignProgram adapter evidence

`tests/design-program.test.ts` separately validates, compiles and renders the shared DesignProgram contract for education, booking, analytics and civic-service fixtures. It inspects editable mock roots, RTL order, vertical scroll clipping, geometry, task-scoped native inspection, a scoped heading edit, replay without duplicate roots and unaffected screen snapshots. This is adapter evidence, not a second Universal production compositor.

## Comparison to the recorded baseline

The pre-change audit recorded that Universal tests used the same fixed three-region fixture tree for every domain and the prompt did not ask for a traceable layout choice or shared visual language. The new evidence adds semantic composition metadata, shared project tokens, different role-based fixture topologies, explicit held-out marine content, Brand Kit asset forwarding and structure/readback assertions. This proves that the code path and test cases are no longer commerce-specific or fixed to one fixture topology. It does **not** prove that a real model will make good choices or that Figma Desktop renders them professionally.

No before/after screenshots, real provider timings, or human ratings are available.
