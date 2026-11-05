# Phase 5.5 — Live AI Canvas Generation

**Status: IMPLEMENTED — LIVE DESKTOP ACCEPTANCE PENDING.** The local/offline transaction path and compiled artifacts are verified; no Figma Desktop session or authorized inference has been operated by this agent.

## Audit and architecture decision (before implementation)

Original whole-screen path (replaced for new generations):

```text
Brief/options -> UI deterministic screen plan -> POST /v1/design (whole screen)
  -> companion verifies bearer session, plan-use scope, exact listed/smoke-tested model
  -> one Responses request (stream:true, store:false, strict JSON Schema)
  -> SSE buffered in private spool until response.completed -> complete JSON to UI
  -> UI normalizes/validates whole screen -> companion disk screen checkpoint
  -> request/ack UI-to-plugin bridge -> main/controller validation -> native screen renderer
```

The previous flow could not show validated work until its whole-screen request finished. Phase 5.5 replaces it for new generations with the incremental sequence below. The default 5-minute absolute inference timeout (`src/companion/config.ts`, capped at 10 minutes), stream-idle and header deadlines apply independently to each section request. A model request is accepted only after `response.completed`, never from deltas or HTTP 200 alone.

Current implementation:

```text
Brief/options -> deterministic screen and section plan -> create native working screen frames
  -> one authorized streamed Responses request for identity, primary, or supporting
  -> require response.completed -> validate complete bounded section
  -> atomically checkpoint section -> request/ack plugin bridge -> append editable native section
  -> persist native acknowledgment -> only then request the next section
```

Existing work to extend, not replace: screen planning and strict normalization (`src/shared/design-generation.ts`), request/ack Figma bridge (`src/shared/messages.ts`, `src/plugin/generation-controller.ts`), rollback-capable editable renderer (`src/plugin/renderer.ts`), and checksummed per-screen store (`src/companion/draft-store.ts`). Companion compilation is NodeNext with `rootDir: src`, `outDir: dist-companion`, and `npm run companion` boots `dist-companion/companion/main.js`.

**Decision:** make each bounded section an independent strict Responses request, sequentially per screen. The companion still requires `response.completed` for each request. The UI validates the complete section, creates a deterministic typed transaction, durably checkpoints it, then submits it to the existing plugin bridge. The plugin preflights and applies the section to a stable screen root, acknowledging only after native checks. This gives real canvas work between model requests without accepting arbitrary partial JSON or treating a partial upstream request as success. A failed request never reaches the renderer. Sections already checkpointed remain recoverable; an interrupted request is retried only for the unfinished section.

The protocol's first vertical slice is deliberately append-only: one `append-section` operation to the explicit screen-root semantic ID. Model output remains data under the existing node schema; it never supplies Figma API calls, plugin messages, URLs, or code. Stable node/parent IDs and deterministic idempotency keys are assigned by trusted code. Update/delete/asset operations, parallel inference, richer dependencies, and in-flight Responses record parsing are **not** part of this slice.

## Implemented vertical slice

1. Added a versioned section/transaction contract and deterministic `identity` → `primary` → `supporting` slots.
2. Companion validates section selectors and makes one strictly completed, authorized Responses request per section.
3. Each complete validated section is atomically persisted alongside readable v1 screen checkpoints; recovery composes sections without deleting old records.
4. The plugin appends sections in order with deterministic semantic IDs, idempotency markers, checkpoint reconciliation, partial-append fail-closed behavior, and serialized bridge handling.
5. The UI checkpoints and renders each section before requesting the next, exposes a section timeline plus pause/resume/cancel/follow/jump controls, and resumes committed work without inference.
6. Automated coverage includes protocol/auth, ordering/replay, persistence/corruption/recovery, the offline Persian save/bridge/native path, 500 section records, and compiled entrypoints. Local fixture measurements are kept separate from provider latency and Desktop rendering.

## Nested Auto Layout normalization

The product-screen failure came from a gap in the local normalizer: it repaired undersized mobile controls, but left a generated frame's `layout: "none"` unchanged even when that frame had children. Strict validation correctly rejected each such frame; the bounded model repair could repeat the same invalid direction because the safe local repair path never assigned one. The Figma mapper expects validated frames with children to already have a vertical or horizontal direction.

Normalization now walks nested frames bottom-up before the existing strict checks. It leaves explicit directions and empty frames unchanged. For a non-empty frame with `layout: "none"`, it chooses the only direction that fits the declared dimensions, padding and gap; if both or neither fit, it uses the lower normalized overflow, then the frame aspect ratio as a deterministic tie-break (single-child wrappers default vertical). It changes only the direction: child order, hierarchy, copy, RTL text alignment, dimensions, padding and spacing remain intact. Existing touch-target normalization then runs, followed by the same strict schema/layout/accessibility validation; no invalid nodes are discarded or validation bypassed.

## Test plan / acceptance matrix

| Area                                              | Automated evidence (offline)                                                                                                                                         | Desktop/live evidence                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Persian first section visible before next request | Offline fixture runs the section validator/store/bridge/render transaction path; asserts simulated request N+1 follows N's durable checkpoint and render ack         | Observe native Home section while the next section is still being inferred; record first-node time |
| Protocol/auth/terminal behavior                   | Schema bounds, wrong scope, stale/duplicate/out-of-order transactions; Responses `response.completed`, split SSE/CRLF, EOF, failure, timeout and cancellation        | Exact authorized model smoke and successful live request                                           |
| Atomicity/idempotency/recovery                    | Retry, duplicate, sequence gap, renderer rollback, persisted-before-render, render-before-ack, restart/reload and user-moved/edited nodes                            | Pause/reopen/resume and companion restart without duplicate nodes                                  |
| Layout/accessibility/RTL                          | Nested Auto Layout inference and strict post-normalization validation; product card with Persian text/button, mixed directions, depth-7 containers, section pipeline | Inspect actual Figma sizing, RTL, font shaping, text edit and Auto Layout                          |
| Scale/backpressure                                | 100-screen legacy and 500-section persistence/recovery fixtures; bounded storage and bridge queues                                                                   | Observe plugin responsiveness in Figma Desktop                                                     |
| Existing data/entrypoints                         | v1 screen checkpoint remains readable; corruption/account/page boundaries; compiled plugin/companion output and ephemeral loopback boot                              | Build/restart companion and reload plugin                                                          |

Offline measurements cannot establish provider first-visible latency, live model speed, real Figma rendering, or Desktop acceptance. Final status must remain **IMPLEMENTED — LIVE ACCEPTANCE PENDING** unless actual Desktop evidence is recorded.

## Protocol v1 (implemented contract)

One transaction represents one independently validated section and contains protocol version, generation/document/page scope, screen/section/transaction IDs, per-screen sequence, explicit parent/dependency IDs, deterministic idempotency key, one append operation with stable semantic node IDs and the validated section tree, and explicit `section_completed` / optional `screen_completed` flags. The append parent is only `screen:<screenId>`; the section root is `section:<screenId>:<sectionId>`. Names are semantic labels, not implicit parent selectors.

The protocol is strictly ordered and single-flight. Transaction `n+1` depends on `n`; the companion store rejects gaps/conflicting replays, and plugin metadata makes a replay a no-op only when its idempotency key matches. The durable section record is written before native apply. A crash after save but before render replays that record. A crash after a completed render but before the UI receives its ack is reconciled by the native marker and does not create duplicates. A crash during a partial native append leaves a pending marker; resume fails closed and asks the user to inspect/remove only that incomplete marked section, rather than silently deleting possible user edits. The screen is complete only after the planned final section and its native completion marker.

Each section is limited to 1 MiB and 250 native nodes; legacy screens remain limited to 8 MiB and the project to 64 MiB. Existing explicit project/disk quotas still apply. Checkpoints contain validated private design copy but no OAuth credentials; use the existing local deletion/export/privacy controls.

## Build and live Desktop procedure

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx tsc -p tsconfig.companion.json
npm run verify:phase5
npm audit --omit=dev
# In the companion terminal, stop only the prior agent-started instance with Ctrl+C:
npm run companion
```

Reload the development plugin from `manifest.json` in Figma Desktop after build. Use an account-visible selected model and pass its exact streamed smoke test. Enter a Persian brief, Mobile, names `Home, Product Detail`; click Generate once. Capture the time the first real native node appears, observe it while the next section request is active, inspect Layers/editable text/Auto Layout/≥44×44 targets/RTL, then pause, reopen, resume, interrupt/restart the companion, and verify no duplicate frames or lost edits. Record actual evidence here. Never substitute mocks, a fixture, progress animation, or JSON arrival for live acceptance.

## Changelog

- 2026-11-04: Audited the existing phase-5 pipeline and recorded the incremental protocol decision, timeout location, vertical-slice plan, and acceptance matrix before implementation.
- 2026-11-04: Implemented the incremental section flow, durable checkpoints, ordered/idempotent native append and recovery, Persian offline pipeline coverage, and compiled-entrypoint checks. Final local checks: 252 tests, typecheck, lint, format check, companion compile, plugin build, compiled verification, `git diff --check`, and production audit passed. Fixture benchmark accepted 200/200; it does not measure live inference or Figma rendering. Live authorized inference and Desktop acceptance remain pending.
- 2026-11-04: Reproduced the nested Persian product-card `layout: "none"` failure, added bottom-up deterministic direction inference before strict validation, and covered mixed layouts, depth-7 nesting, responsive button sizing, and the full offline section/recovery pipeline. The updated regression suite passes 257 tests; live Desktop acceptance remains pending.
