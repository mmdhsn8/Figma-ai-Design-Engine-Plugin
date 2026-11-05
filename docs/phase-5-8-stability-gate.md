# Phase 5.8 stability gate — not production acceptance

This note covers the separate planning-metadata rejection. The persisted reference-alias collision and its evidence boundary are documented in [stability-gate-root-cause.md](stability-gate-root-cause.md).

## Latest failure: root cause

The reported rejection is now reproducible: `plan_canvas_task` received `completed`, `operations`, `rounds`, and `verification` in a stage. The plan input schema was strict, so `unrecognized_keys` was correct.

The application encouraged this mistake: `chatTaskInput` serialized internal runtime stages into assistant checkpoint summaries, and successful planning/stage-completion tool outputs returned those same runtime stages. Those stages looked like reusable planning examples, despite the tool schema accepting only title, goal, logical refs, and completion criteria. `verification` is not part of the current runtime schema either; the exact upstream reasoning/payload is unavailable, so its provenance is not proven.

The old loops fed planning failures back to the model without a repeated-error/no-progress check. A valid plan already existed in some paths but could still be requested again. Counting tests did not cover this production transport/continuation interaction. The reported ten rounds versus the source's four pre-plan/eight per-stage limits also cannot establish which compiled plugin/companion revision ran; reload/rebuild evidence is required.

## Minimal changes

- Canonical planning contract is `ChatPlanActionSchema`, version 1 (`planVersion` defaults to 1 for existing callers). The model-facing tool derives from it. Checkpoint model summaries and tool outputs project stages to planning fields only, with execution position kept separately.
- Only known runtime stage metadata is deterministically removed at the argument boundary. It cannot authorize commits, set completion, or alter verification. The strict plan schema then runs as before; unknown design/styling properties are not dropped. A safe `planning_runtime_metadata_ignored` diagnostic and tool-result notice disclose this handling.
- A saved plan is never replaced by a repeated plan call. The model is directed to the next unfinished stage. A repeated replan without progress stops rather than consuming the whole stage budget.
- Persistent error signatures omit call IDs and compare confirmed canvas commits/completed stages. Repeated identical validation errors stop after one targeted correction; existing total limits still apply to differing errors. Reference failures use the same no-progress protection. Retry does not reset these guards.
- Checkpoints expose failure category, safe code, committed count, and operation ID where available. Categories distinguish model schema, planning, executor validation, native runtime, rate limit, timeout, partial commit and ambiguous recovery. Some legacy executor failures remain classified from bounded error text because they do not yet carry a typed cause; they are not proof that a failed write had no effect.

## Automated integration evidence

`tests/companion-server.test.ts` contains the stability-path regression. It uses the companion HTTP server and authentication/session gates, Responses SSE parser, `streamAuthorizedChat`, `runChatTask`, serialized plugin protocol schemas, native executor, task storage, progress and continuation. It injects exactly the four reported runtime stage properties, executes Persian storefront content, loses a native acknowledgement, recreates the executor, reloads the checkpoint, resumes without duplicates, then edits the two existing purchase-button frames through a second chat task.

**Simulated boundaries:** OAuth/Responses upstream and native Figma API objects. The React UI, actual account/model variability, font shaping, real layout and Desktop plugin messaging are not driven. This is a cross-layer regression, not authenticated live-model or visual acceptance. It checks native text/frame construction and content, not a professional design or actual product-card appearance.

Automated verification on 2026-11-05: 334 tests passed across 26 files; both TypeScript checks, lint, formatting, plugin/UI build, companion emit, and `verify:phase5` passed. The scripted storefront integration completes its saved stage in six model turns with zero schema-correction turns, preserves thirteen native mock nodes across reload/replay, then recolors only the two existing purchase-button frames without increasing the node count or changing the header. These measurements describe the scripted integration only, not live-model latency or reliability.

### Follow-up hotfix: authenticated `inspect_nodes` rejection

The later Desktop screenshot showed `arguments_schema/too_big` at `arguments.maxNodes` after 1/3 stages, 31 confirmed mutations, 17 model rounds, and 19 batches. It proves only that the rejected scalar was numeric and greater than 25; the screenshot and sanitized diagnostic do not retain the exact number, so it remains unknown.

The authenticated Responses request is verified to receive the bounded `inspect_nodes` schema from `CHAT_FUNCTION_TOOLS`. Missing `maxNodes`/`depth` use defaults (25/2); finite out-of-range numbers clamp locally to 1–25 and 0–4. Invalid types and in-range fractions remain rejected, with actionable bounds and safe diagnostics. Ref count stays capped at 20, and executor inspection remains capped at 25 nodes. A storage-backed HTTP/SSE regression now Stops after 31 committed nodes, reloads/resumes, inspects between stages, injects a stage-three failure, and retries without duplicating nodes. Current re-verification: 338 tests / 26 files, typecheck, companion emit, lint, format check, build, and `verify:phase5` pass.

This automated evidence is separate from Desktop acceptance. No authenticated post-hotfix run has been performed; the existing manual gate below remains blocked/pending human execution.

## Live acceptance: BLOCKED

Figma Desktop is running in this environment. The session's browser tab list is empty and the available automation controls Chromium tabs only, not native Figma Desktop. There is no attached authenticated plugin UI/native-control endpoint. Credentials were not read/extracted, no new login was performed, and no live design request was sent.

### Exact manual gate

1. Rebuild/restart the companion (`npm run companion`), reload the development plugin built by `npm run build`, and use the normal authenticated account-visible model. Run its standard smoke test if Settings requires it. Preserve the failing page; use a separate test page for the first clean run. Do not delete checkpoints to manufacture a pass.
2. Open the companion terminal and Figma plugin console. Retain only `[FAD_CHAT_DIAGNOSTIC]` lines and the plugin's safe diagnostic: request ID, tool/call ID, stage, error code, field paths, task/operation ID and committed count. Never collect tokens, prompts, raw tool arguments, network bodies, or stored credentials.
3. Send exactly once:

   > یک صفحه موبایل 390×844 برای فروشگاه لباس فارسی طراحی کن؛ شامل هدر، جست‌وجو، دسته‌بندی‌ها، بنر، دو کارت محصول با قیمت تومان و دکمه خرید. تمام عناصر قابل‌ویرایش باشند.

4. Require all stages completed; inspect the Layers panel and canvas for a 390×844 storefront, header, search, categories, banner, two product cards with toman prices and purchase buttons. Verify editable text/frame/rectangle nodes, no duplicate elements, no schema rejection or reference collision. Save a screenshot showing canvas, Layers and final task status. A prose “completed” message alone is not a pass.
5. Send: `رنگ دکمه‌های خرید را صورتی کن؛ بقیه عناصر تغییر نکنند.` Verify only the two existing purchase-button nodes change and node counts do not increase. Record before/after screenshots without private content.
6. On a second run, Stop after a visible commit, reload the plugin, Resume/Retry Failed Stage. Verify earlier node identities remain and no duplicate storefront/header/cards appear. Then repeat on the preserved previously failing page; uncertain legacy state must request inspection rather than silently recreate it.
7. Record account-visible model slug, build/reload time, elapsed duration, final stages/counts, failure category/code if any, and safe diagnostic lines. Stop on repeated-error termination; do not loop Retry to spend more model quota.

The gate remains blocked until a human supplies those live results or an authenticated Desktop-control connection is available. No Phase 5.9 work or production-readiness claim is included.
