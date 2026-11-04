# Phase 5 stabilization report — 2026-11-04

**Release state: pending real Figma Desktop acceptance. Phase 6 has not started.**

## Proven root causes versus hypotheses

- **Reproduced:** the previous normalizer skipped interactive text nodes. Seven new regressions failed before the fix (single text target and nesting depths 1–6). Text controls now get editable hit-area frames; recursive geometry correction and effective stretch checks still run. A wrapper that exceeds depth eight is rejected, not silently flattened.
- **Proven from source:** successful generation ended at JSON preview; the normal Design action never invoked native rendering. It now saves each validated screen, calls the typed document-controller bridge, renders transactionally, records completion, and finally selects/zooms the generation.
- **Proven from source:** the draft lived only in a React ref. It now uses account/document/page-scoped durable per-screen files plus a small Figma storage reference. Reopen/restart, checksums, ignored partial staging files, account isolation, quotas, replay conflicts, missing assets, 100-screen recovery, and canvas reconciliation have automated coverage.
- **Proven avoidable work:** a disk write per output-text delta, full-project stringify/reparse during normalization, and possible second-screen regeneration solely for palette/name disagreement. Spool writes are batched; strict post-normalization checking stays in memory; role-based palette tokens reuse the established design system without another model request.
- **Caught during verification:** the initial durable store rescanned/stat'ed every existing checkpoint on each save; a 100-screen regression exceeded its 30-second test deadline under concurrent disk load. Per-project size accounting now refreshes on recovery and updates after each atomic commit; errors invalidate the cache. The same full suite, including the 100-screen case, subsequently passed in 17.04 seconds total without increasing that test's deadline. This is suite evidence, not a controlled per-project latency comparison.
- **Proven contract:** the current companion script already uses `dist-companion/companion/main.js`; regression and compiled-module/loopback boot checks retain that correction. The root manifest uses `dist/plugin.js` and `dist/ui.html`.
- **Not proven:** the cause of minutes of latency in the user's authorized live request, whether their running binaries were stale, the original full payload, actual first-token/idle history, provider throughput, native font metrics and Figma Desktop placement. No authorized inference or native Desktop interaction was performed here. New timing fields are intended to make the next live result attributable.

## Implementation / files

- Contract/repair/resource limits: `src/shared/design-generation.ts`, `generation-draft.ts`, `generation-limits.ts`, `messages.ts`.
- Durable store and authenticated bounded routes: `src/companion/draft-store.ts`, `server.ts`, `main.ts`.
- Native transaction/reconciliation: `src/plugin/generation-controller.ts`, `main.ts`, `renderer.ts`.
- Workflow, recovery controls and metrics: `src/ui/generation-session.ts`, `App.tsx`, `companion-client.ts`, `design-generation.ts`.
- Regression coverage: `tests/design-generation.test.ts`, `generation-draft.test.ts`, `generation-fixture.ts`, `companion-server.test.ts`, `companion-client.test.ts`, `renderer.test.ts`; existing message/eligibility/build-path tests retained.
- Build/performance tooling: `scripts/verify-phase5-build.mjs`, `scripts/benchmark-phase5.mjs`, `package.json`.
- Architecture, manual acceptance, restart/privacy instructions: `README.md`, `docs/phase-5-design-generation.md`, `docs/phase-5-failure-matrix.md`, this report.

## Measurements

Deterministic local two-screen Persian text-button fixture, **2,815 bytes, 200 iterations**, same Windows workspace. No network. Values vary with local scheduling; these are observations, not SLAs.

| Stage                                      |                    Before |   After (last recorded run) |
| ------------------------------------------ | ------------------------: | --------------------------: |
| JSON parsing                               |                 0.0259 ms |                   0.0169 ms |
| Normalize + strict validation              |                 0.2146 ms |                   0.2782 ms |
| Accepted fixture iterations                |                     0/200 |                     200/200 |
| Disk strategy microbenchmark, 11,491 bytes | 2,299 writes / 162.916 ms | 1 buffered write / 0.793 ms |

The disk comparison executes both strategies against disposable files, not a historical authorized stream. Normalization gained correctness and is slightly slower; no claim of a fixed generation-time speedup is justified. Baseline persistence/direct-render timings do not exist because those workflow stages were absent. Actual UI timings now include inference/setup wait, upstream headers, first text delta, byte/event counts, idle age, validation, persistence, native rendering and total elapsed. Real provider latency and native Desktop rendering remain **not measured**. Run `npm run bench:phase5` after compiling the companion to reproduce the local fixture benchmark.

## Verification

- Full suite: **247 tests passed across 22 files**; typecheck, ESLint, Prettier, production plugin build and companion compilation passed. Final checks/commit hashes are recorded in the delivery response.
- `npm run verify:phase5` checks current source/output timestamps and manifest/script paths, imports actual compiled modules and starts the compiled server on an ephemeral loopback port. It makes no provider requests and does not touch OAuth storage.
- `npm audit --omit=dev --json`: **0 production vulnerabilities** at the time of this run. No new dependency added.
- Stream lifecycle coverage includes explicit completion, split SSE records, EOF, idle/overall/header deadlines, bounded transient retry/backoff, cancellation and spool cleanup. Overall timeout is no longer automatically replayed; EOF/idle gets at most one cancellable transient retry.
- Native API tests cover editable frames/text, real dimension checks at the renderer boundary, rollback on undersized native targets, non-overlap/existing-content preservation, stable generation markers, moved/deleted frames and bridge reload reconciliation. These are mocks: they cannot establish actual Figma shaping, Auto Layout timing or visual quality.

## Durable resume behavior and limitations

Each validated screen is flushed and atomically renamed before its UI saved count increments. Rendering is a separate state, so a render failure does not discard the saved design. A completed generation/screen identity is reused without moving it; a deleted frame is restored from JSON without inference. Explicitly tagged incomplete roots are removed before retry. Multiple complete identities stop with an inspection error rather than destructive deduplication. Completion markers are written after native checks/placement; a crash before the rendered-ID checkpoint is reconciled from the canvas.

Version 1 is the first durable format: there is no migration for vanished memory-only drafts. Unknown versions/corrupt manifests fail safely and require recovery import or explicit deletion. Corrupt screen siblings are retained and independently recoverable. Eight project scopes, 64 MiB per project, 8 MiB per screen, 32 MiB SSE, eight queued disk operations, eight nesting levels, 100,000 generated nodes/project and 10,000 native nodes/AI screen bound work. Drafts contain private briefs/copy and are not encrypted; OAuth credentials remain separate and protected. Recovery exports contain no credentials but must be kept private.

Remaining risks: plugin clientStorage is not the complete backup; companion/account/Windows local storage must be available to resume. A file duplicated without a usable `fileKey` may copy the fallback identity. Figma cannot atomically combine root creation and tagging; an untagged crash orphan may need manual inspection. Cancellation waits for an already-running native screen transaction; it cannot interrupt a synchronous Figma API call. Large projects may cause visible pauses within one 10,000-node screen despite yielding between screens. Whole-screen fixed-bound fitting remains conservative: if safe correction cannot fit, one bounded repair is tried, then the exact remaining issue stops inference. Externally inserted or manually modified frames are never automatically replaced just to pass validation.

## Mandatory live acceptance — all pending

No Figma Desktop input/control or authorized live request was available. Follow the exact PowerShell restart and Persian Home + Detail script in [the Phase 5 guide](phase-5-design-generation.md#live-acceptance-checklist). Verify automatic editable layers, ≥44×44 actual targets, order/no-overlap, selection/zoom, close/reopen and companion restart, interrupt/resume without duplicate inference/frames, and record real stage timings. Do not mark any of these passed based on the automated suite.

Commits are local only. The pre-existing tracked Phase 5 work is preserved separately from this stabilization delta; the user's untracked MP4 is excluded. Commit hashes are reported in the delivery response. No push was authorized or performed.
