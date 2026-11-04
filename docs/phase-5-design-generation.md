# Phase 5 — AI design generation MVP

## Status

The planner, streamed inference, local normalization, bounded subtree repair, durable per-screen checkpoints, direct native rendering, reconciliation, and optional JSON inspection are implemented. **Phase 5 is not complete: live inference and Figma Desktop acceptance remain unverified.** This agent did not operate Figma Desktop, sign into an account, or make an authorized model request. See [the failure matrix](phase-5-failure-matrix.md) and [stabilization report](phase-5-stabilization-report.md) for proven failures, measurements and limitations.

## User workflow

1. In **Design**, enter a Persian, Finglish, or English brief. Choose Mobile, Desktop, or both; select at least two screen families; optionally name screens, choose copy language, and add a visual direction. Larger batches require explicit screen names.
2. The deterministic planner previews every screen name, stable ID, device preset, and standard frame (Mobile 390×844, Desktop 1440×900). A mismatch blocks generation rather than silently dropping requested screens.
3. Load actual account-visible models in Settings and run the fixed Responses smoke test for the **same selected model**. Sign-in, plan-use scope, or model listing alone does not enable generation. The smoke test verifies inference access, not structured-output support.
4. Click **Generate Design**. The brief and deterministic screen plan go to the local companion; the open JSON document and local assets are not sent. The companion requests one planned screen at a time, in order.
5. Each completed stream is normalized and strictly validated for its exact screen ID. Text-only buttons become editable Auto Layout hit-area frames with their Persian text preserved as a label. Buttons/inputs and effective stretched dimensions must meet 44×44 px. A bounded local correction never disables validation. An irreparable control gets at most one targeted node-replacement request, preserving copy, types, interactive roles and unrelated content. Malformed structural output can get one failed-screen repair; completed screens are never regenerated.
6. Each validated screen is durably committed before its saved count increases, then rendered automatically through the existing native renderer. The current stage, elapsed time, saved/rendered counts, per-screen status and sanitized timings are shown. The completed cluster is selected/zoomed. **Inspect or export generated JSON** remains optional; no JSON copy/paste is needed for normal generation.
7. Reopen the plugin and connect the companion. **Restore saved project** reloads the original options; verify that exact model if necessary and press **Generate Design** to resume. Existing complete frames are reconciled by identity, not recreated or moved. Deleted frames are recreated from validated checkpoints without another model request.

Only the validated plugin-controller bridge can create layers. A failed screen transaction rolls back its new nodes; earlier saved/rendered screens remain. Offline JSON import and sample rendering still work independently of the companion.

## Architecture and resource safety

```text
Brief + target options
  → src/shared/design-generation.ts (normalization, deterministic plan, constrained contract)
  → src/companion/server.ts /v1/design
  → POST https://api.openai.com/v1/responses
  → one streamed strict JSON Schema response per planned screen
  → private companion temporary-file spool until response.completed
  → backpressure-aware stream to Figma UI with verified byte count
  → shared geometry-aware normalization → strict schema / accessibility checks
  → optional one bounded node-only repair → revalidation
  → /v1/draft → account/document-scoped atomic screen checkpoint
  → typed generation-render bridge → plugin-side validation / native JSON adapter
  → existing transactional renderer / design-system registry / placement planner
  → measured native hit-area check → complete identity marker
  → durable rendered node ID → final cluster selection / zoom
```

- Only a bearer-authenticated local companion request is accepted. It requires granted `chatgpt.tokens.use.direct`, a model returned by that account's documented model list, and an exact model match with the successful smoke test.
- The companion uses the documented Responses endpoint and `text.format: { type: "json_schema", strict: true, ... }`, with `store: false` and `stream: true`. It does not send `max_output_tokens`, use undocumented ChatGPT endpoints, or accept API keys.
- The fixed connectivity smoke test also keeps `stream: true`: current Sign in with ChatGPT preview limitations require streamed Responses requests, so a non-streaming request is not a supported workaround in this plan-use flow.
- OAuth tokens stay in the companion. Small inference/control bodies retain the 16 KiB request limit; the separately bounded checkpoint route accepts one screen of at most 8 MiB plus metadata. Only one inference is active. Header wait is bounded to 45 seconds, stream idle defaults to 60 seconds (environment cap 120 seconds), and overall inference defaults to 5 minutes (cap 10 minutes), including headers. Output is bounded to 8 MiB of generated JSON and 32 MiB of SSE bytes per request. A private temporary spool uses 64 KiB buffered writes instead of a disk operation per token; it is removed on success, error or cancellation. No partial response is accepted as complete.
- Smoke/design streams are accepted only after an explicit `response.completed` event. `response.failed`, `response.incomplete`, cancellation, malformed SSE data, and transport interruption remain failures. Clean EOF or stream idle timeout discards partial text and gets one same-screen retry with 250 ms cancellable backoff, per initial/repair request. Overall deadlines are not automatically retried: repeating an actively slow request would waste another full inference window. Header deadlines and cancellation are not automatically retried either. One validation repair plus its optional transient retry is the maximum; no infinite regeneration. The SSE parser handles CR, LF, CRLF, multi-line `data:` fields, arbitrary chunk boundaries, and the final buffered frame.
- The output contract permits only nested frames, text, rectangles, and ellipses with a fixed palette-role enum. No JavaScript, HTML, arbitrary Figma operations, URLs, external image assets, or local files are accepted. Every screen is untrusted and must pass generation validation and the existing multi-screen renderer schema before preview.
- Mobile normalization is recursive and idempotent, preserves ordering/RTL/copy/gaps/padding, and grows ancestors only when the repaired screen fits. Text targets retain native text inside a hit-area frame, never a screenshot or silently truncated label. Strict checks run afterward, including effective stretch dimensions and parent bounds. Adding a hit-area wrapper cannot bypass the eight-level nesting limit. Geometry impossible within fixed bounds is reported with exact paths rather than shrinking controls or looping inference.
- AI projects support at most 200 named screen families (up to 400 Mobile/Desktop screens), 64 MiB of validated project JSON and 100,000 generated nodes. Each AI screen render has a 10,000-node work budget and is a transaction. The existing offline import/renderer and asset safeguards are unchanged. Placement uses the existing horizontal-first no-overlap planner; previous clusters and user-moved complete frames are not rearranged.
- The adapter creates a shared native color-token design system. It does not synthesize or fetch product imagery; any missing photo content needs a deliberate editable placeholder or user-imported licensed asset. Generated component masters are not yet included in this MVP.
- Validated screens are committed to the companion's durable local store before rendering. Temporary stream spools are separate and are not retained. Drafts intentionally contain briefs and design copy, not credentials; see the privacy/storage section below. Neither prompts nor responses are logged. Diagnostics contain categories, counts, timings and bounded validation paths, not raw response bodies or credentials.
- Safe inference diagnostics include the exact selected account model slug, HTTP status when received, sanitized SSE event name/count, stream byte count, timeout kind, elapsed time, time since stream activity, time since the last event/delta, and known upstream error code/parameter. HTTP `503`/transient transport errors, direct-use entitlement failures, account eligibility, unsupported capability, incomplete streams, timeouts, and cancellation have separate recovery text. Upstream messages and response bodies are never echoed.
- The quality panel reports configured checks and warnings, not a visual score. Font availability, Persian shaping, text overflow, composition, touch usability, and native component behavior still need manual Figma Desktop review.
- Figma UI keeps the existing 440×720 surface. AI rendering yields between screens. A running native screen transaction finishes or rolls back before cancellation takes effect; cancellation aborts upstream inference and prevents subsequent screens. Figma's font/layout behavior, local disk, and host responsiveness still require manual acceptance.

## Durable storage, privacy and recovery

- Hybrid storage avoids Figma clientStorage's small quota: clientStorage keeps only a document/page-scoped generation reference; validated JSON lives under `%LOCALAPPDATA%\Figma AI Design Engine\drafts-v1`. A per-screen checksum envelope is written to a private staging file, flushed, closed, and renamed. There is no in-place truncating overwrite fallback; a failed rename leaves the previous checkpoint intact.
- Records are version 1. There was no earlier durable format to migrate: old UI-only drafts cannot be recovered after closing. Unknown versions and checksum failures are rejected, never guessed. Valid siblings remain recoverable. A corrupt screen is preserved as `.corrupt` when regenerated; interrupted `.tmp` files are ignored and count against the storage budget.
- The disk directory is scoped by a hash of the validated account subject hash and document/page identity. No OAuth token, bearer or cookie is stored in the draft. Account changes never reuse in-memory screen content. Figma fileKey is used where available; otherwise a document plugin-data ID is used. **A duplicated file that copies plugin data without exposing fileKey can share the fallback identity: explicitly clear/start a new project in that case.** Pages are separate project scopes.
- One active generation per account/document/page; eight project directories maximum on this Windows installation. No automatic deletion of old user content. Each project has a 64 MiB quota, each screen 8 MiB; eight queued disk operations maximum. Retention saturation requires explicit deletion of an old draft. A staging write can temporarily use one additional screen's disk space. Same-user filesystem access can read drafts; they are not encrypted like OAuth credentials.
- **Delete local draft** removes that scope's checkpoint, not Figma frames. **Export recovery JSON** contains the brief/copy and validated designs, without credentials. **Import recovery JSON** validates and incrementally commits into the same document/page/account scope; exported rendered flags are not trusted. Keep exports private. Reconcile native frames after import.
- Completed frames carry generation ID, screen ID and a completion marker. A retry reuses complete frames, recreates deleted ones, and removes only explicitly tagged incomplete AI roots before retry. Existing moved frames are retained. Duplicate/conflicting identities require user inspection; they are not destructively deduplicated. A crash in the tiny interval between Figma creating a root and tagging it cannot be made atomic by this API; inspect an untagged orphan if observed.
- When the companion is unavailable, existing Figma layers and offline JSON import remain usable; only a recovery reference is available in plugin storage, not complete design JSON. Resume requires the same Windows store and account. Moving to another machine requires a recovery export. AI output currently has no external assets; manual imports keep the existing missing-asset checks.

## Timing and performance evidence

The UI polls `/v1/progress` while inference is active: header wait, stream events, generated bytes, elapsed and idle age are separate from validation, persistence, native rendering and total duration. Success headers include header wait, time to first text delta, SSE bytes and inference duration. First text delta is not necessarily the provider's first reasoning event. Polling failures do not retry inference.

Proven avoidable work: token-sized spool writes are now batched to 64 KiB; normalization no longer serializes/reparses the entire project for its strict second pass; shared palette roles reuse the established first-screen tokens without another inference; accessibility repair returns only replacement nodes (at most eight paths / 4 KiB of context), not a completed screen. Composition instructions request compact JSON and discourage redundant wrappers. No `max_output_tokens` workaround was added.

`node scripts/benchmark-phase5.mjs` benchmarks a deterministic 2,815-byte two-screen Persian text-control fixture over 200 iterations, not model/network/Figma latency. Before stabilization: JSON parse **0.0259 ms**, normalize+validate **0.2146 ms**, accepted **0/200**. After-fix values are recorded in the stabilization report. The sub-millisecond local baseline cannot explain minutes of live inference. A real latency attribution or speedup claim needs authorized request timings; none were collected here.

## Build/restart (PowerShell, repository root)

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
npx tsc -p tsconfig.companion.json
node scripts/benchmark-phase5.mjs
npm audit --omit=dev
# Stop only the old companion you started with Ctrl+C, then:
npm run companion
```

The runtime script compiles and launches **`dist-companion/companion/main.js`**, not `dist-companion/main.js`. The root manifest points at **`dist/plugin.js`** and **`dist/ui.html`**. Reload that freshly built development plugin; old running code does not hot-update. The consistency test checks source script/TS output paths; built-module tests exercise the compiled shared contract.

### Official transport references

- [Sign in with ChatGPT — Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Sign in with ChatGPT — Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Responses API — Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [Sign in with ChatGPT — Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

The model list is account-visible and its returned `slug` is used without hard-coded model IDs. The direct plan-use flow requires streamed Responses requests with `store: false`; the documented preview restrictions include omitting `max_output_tokens`. The current Structured Outputs guide documents `text.format.type: "json_schema"`, `strict: true`, and recursive `$defs` schemas. This is the documented public Responses endpoint only, not a ChatGPT backend endpoint. The actual entitlement and whether the selected account model accepts this schema remain live checks.

## Offline fixtures

These are deterministic local JSON examples, not AI output, and make no companion or network request:

| Design tab action               | Fixture file                                 | Expected screens                                                                                                        |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Persian storefront · 10 screens | `src/samples/phase-4.5-visual-design.json`   | `welcome`, `sign-in`, `home`, `categories`, `search`, `product-detail`, `favorites`, `cart`, `checkout`, `confirmation` |
| English dashboard · 2 screens   | `src/samples/phase-5-english-dashboard.json` | `overview`, `orders`; shared native navigation component                                                                |

## Live acceptance checklist

Not run by the coding agent: no live account entitlement/token, real inference, Figma Desktop session, or screenshot evidence was available. After signing in under the same Windows account as the companion and Figma Desktop:

1. Stop the previous companion, run the build/restart commands above, and reload the root-manifest plugin. Confirm both loopback listeners on port 1455. Do not stop unrelated processes.
2. Authorize, load account-visible models, select the intended exact model, run its smoke test. Expect a real `response.completed`; sign-in or HTTP 200 alone is not acceptance.
3. Mobile, count 2, names `Home, Detail`, Persian language; brief: `یک فروشگاه اینترنتی فارسی با صفحه خانه و جزئیات محصول طراحی کن. متن راست‌چین، قیمت به تومان و دکمه خرید با هدف لمسی حداقل ۴۴ در ۴۴ پیکسل باشد.` Press Generate once. Expect two automatic native screens, editable Persian text, correct order, no overlap, existing objects untouched, final selection/zoom; no JSON-tab step.
4. Inspect every interactive frame's actual dimensions after native Auto Layout: both axes ≥44 px. Inspect RTL, mixed Latin SKUs, fonts, wrapping, palette styles and hierarchy. No repeated whole-screen accessibility regeneration.
5. Close/reopen the plugin, reconnect/restart companion, restore saved project, verify smoke if required, Generate. Expect restored counts, no inference for complete screens, no duplicate roots. Move a complete frame and repeat: it must not move back. Delete one frame and resume: recreate from saved JSON without inference.
6. Start a larger explicitly named plan, cancel during a later screen, close/reopen both processes and resume. Expect partial SSE discarded, completed checkpoints retained, only missing content inferred, no duplicate frames. Exercise corrupt/unsupported checkpoints and recovery import/export on a disposable test file.
7. Record actual wall-clock total and per-screen header/first-delta/upstream/idle/event/byte/validation/persistence/render timings. Share only sanitized metrics, model slug, terminal event, counts and exact validation paths—never tokens, callback URLs, prompts or raw responses. Desktop screenshots should redact private content.
8. Record observed pass/fail evidence here before declaring Phase 5 complete. Until then all Desktop items remain **PENDING**; do not start Phase 6.
