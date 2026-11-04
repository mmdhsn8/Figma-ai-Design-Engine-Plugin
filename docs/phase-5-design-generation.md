# Phase 5 — AI design generation MVP

## Status

The prompt planner, companion inference endpoint, constrained output contract, bounded repair, validation, preview, offline fixtures, and handoff to the existing JSON import UI are implemented. **Live inference and Figma Desktop acceptance are not verified. Do not describe Phase 5 as complete until a real authorized request has rendered editable layers in Figma Desktop.** The coding environment has not signed into a ChatGPT account, confirmed entitlement, or made a live Responses request.

## User workflow

1. In **Design**, enter a Persian, Finglish, or English brief. Choose Mobile, Desktop, or both; select at least two screen families; optionally name screens, choose copy language, and add a visual direction. Larger batches require explicit screen names.
2. The deterministic planner previews every screen name, stable ID, device preset, and standard frame (Mobile 390×844, Desktop 1440×900). A mismatch blocks generation rather than silently dropping requested screens.
3. Load actual account-visible models in Settings and run the fixed Responses smoke test for the **same selected model**. Sign-in, plan-use scope, or model listing alone does not enable generation. The smoke test verifies inference access, not structured-output support.
4. Click **Generate Design**. The brief and deterministic screen plan go to the local companion; the open JSON document and local assets are not sent. The companion requests one planned screen at a time, in order.
5. Each screen is streamed with strict JSON Schema output and validated against its exact ID before being retained in UI memory. A clean SSE EOF gets one same-screen retry with the same request ID; incomplete output is discarded on both attempts. If a later screen fails or is cancelled, rerunning the same plan resumes from the first missing screen. Each screen gets at most one validation-repair request.
6. Review screen inventory, dimensions, node estimate, and deterministic quality warnings. Click **Review JSON before rendering**; confirm replacement of the existing JSON editor contents. Edit or validate through the existing JSON tab, then explicitly click **Generate all screens**. The existing renderer/placement planner creates native editable nodes in a non-overlapping cluster.

No Figma layers are created by the AI response itself. If generation fails validation twice, the request is cancelled, or inference is unavailable, existing JSON import and sample buttons continue to work.

## Architecture and resource safety

```text
Brief + target options
  → src/shared/design-generation.ts (normalization, deterministic plan, constrained contract)
  → src/companion/server.ts /v1/design
  → POST https://api.openai.com/v1/responses
  → one streamed strict JSON Schema response per planned screen
  → private companion temporary-file spool until response.completed
  → backpressure-aware stream to Figma UI with verified byte count
  → src/shared/design-generation.ts (untrusted per-screen output validation)
  → src/ui/design-generation.ts (tokenized multi-screen JSON adapter)
  → existing multi-screen parser, Quality panel, and explicit JSON import/render action
```

- Only a bearer-authenticated local companion request is accepted. It requires granted `chatgpt.tokens.use.direct`, a model returned by that account's documented model list, and an exact model match with the successful smoke test.
- The companion uses the documented Responses endpoint and `text.format: { type: "json_schema", strict: true, ... }`, with `store: false` and `stream: true`. It does not send `max_output_tokens`, use undocumented ChatGPT endpoints, or accept API keys.
- The fixed connectivity smoke test also keeps `stream: true`: current Sign in with ChatGPT preview limitations require streamed Responses requests, so a non-streaming request is not a supported workaround in this plan-use flow.
- OAuth tokens stay in the companion. Small request/control bodies retain the 16 KiB companion request limit, and only one inference is active at a time. Design generation requests one screen at a time. Its overall deadline defaults to 5 minutes (configurable with `FAD_STREAM_OVERALL_TIMEOUT_MS`, capped at 10 minutes); the stream idle deadline defaults to 60 seconds (configurable with `FAD_STREAM_IDLE_TIMEOUT_MS`, capped at 2 minutes). The overall deadline includes waiting for upstream response headers. Diagnostics include elapsed, idle, and last-event/delta ages so a slow-but-active stream can be distinguished from a stall. There is no aggregate application byte cap on Responses output, generated JSON, editor text, or imported JSON. Completed output is written incrementally to a private temporary file and streamed to the UI with backpressure; the file is removed on success, failure, or cancellation. Disk exhaustion and heap pressure while parsing an SSE frame fail safely with sanitized resource diagnostics rather than accepting partial output.
- Smoke/design streams are accepted only after an explicit `response.completed` event. `response.failed`, `response.incomplete`, cancellation, malformed SSE data, and transport interruption remain failures. A clean EOF or stream idle/overall timeout rejects that attempt and discards partial text; design generation retries that condition once per initial/repair request, then fails. Header deadlines and cancellation are not automatically retried. The SSE parser handles CR, LF, CRLF, multi-line `data:` fields, arbitrary chunk boundaries, and the final buffered frame.
- The output contract permits only nested frames, text, rectangles, and ellipses with a fixed palette-role enum. No JavaScript, HTML, arbitrary Figma operations, URLs, external image assets, or local files are accepted. Every screen is untrusted and must pass generation validation and the existing multi-screen renderer schema before preview.
- Mobile output receives a conservative touch-target normalization pass after schema/depth/ID checks. Buttons and inputs are enlarged to at least 44×44 px, with ancestor growth only when needed; padding, gaps, ordering, and RTL copy are preserved. A repair is committed only when the complete screen fits its Auto Layout containers and content bounds. Strict schema and accessibility validation run again afterward, including effective stretched dimensions. Text-only targets and layouts that cannot safely fit are left for the existing single model-repair attempt with exact issue paths. Completed screens remain in the current UI session and only missing screens are retried; closing/reloading the UI loses that in-memory draft. Native editable layer rendering is covered by mocked Figma API tests, not live Desktop acceptance.
- Screen IDs are stable from the planner. Each screen is requested and validated separately; Mobile + Desktop creates both counterparts for each family. There is no fixed batch screen-count, aggregate node-count, component-count, or JSON byte cap. Existing field validation, the eight-level nesting bound, embedded-asset safeguards, official API/model output limits, available memory/disk, and Figma runtime behavior still apply. Canvas placement remains delegated to the existing horizontal-first planner; older clusters are not rearranged.
- The adapter creates a shared native color-token design system. It does not synthesize or fetch product imagery; any missing photo content needs a deliberate editable placeholder or user-imported licensed asset. Generated component masters are not yet included in this MVP.
- Validated screen data remains in UI memory until the user chooses to load the completed design into the JSON editor. Companion temporary files are not retained. Prompts and model responses are not logged. Diagnostics contain safe categories, byte/event counts, and bounded schema issues, never credentials or raw output.
- Safe inference diagnostics include the exact selected account model slug, HTTP status when received, sanitized SSE event name/count, stream byte count, timeout kind, elapsed time, time since stream activity, time since the last event/delta, and known upstream error code/parameter. HTTP `503`/transient transport errors, direct-use entitlement failures, account eligibility, unsupported capability, incomplete streams, timeouts, and cancellation have separate recovery text. Upstream messages and response bodies are never echoed.
- The quality panel reports configured checks and warnings, not a visual score. Font availability, Persian shaping, text overflow, composition, touch usability, and native component behavior still need manual Figma Desktop review.
- Figma UI keeps the existing 440×720 compact surface; long settings/results remain scrollable. JSON text and native screen/node/component/token counts have no fixed application ceiling. The shared renderer still limits nested depth to eight and preserves embedded-asset safeguards; Figma Desktop performance, available memory, and undocumented host/platform constraints remain practical limits.

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

1. Confirm the status says plan-use authorized, load account-visible models, run the fixed smoke test, and verify the model-specific status before generating. Share only sanitized status text.
2. Generate a Persian RTL storefront with several named screens. Check natural Persian copy, تومان price labels where requested, mixed-direction text, font fallback, wrapping, and native editability.
3. Generate a two-screen English dashboard and at least one Mobile + Desktop counterpart. Compare information hierarchy and layout adaptation.
4. Inspect layers, text/Auto Layout, token styles, warning list, placement gap, and old canvas objects. Confirm generation did not add overlap or move prior clusters.
5. Exercise cancel, one validation repair, malformed output, revoked permission, account switch during a request, and companion offline behavior. Verify the JSON fixtures/import continue to work.
6. Only after the MVP passes, use the existing 10-screen Persian fixture for stress/layout review. Capture screenshots without callback URLs, credentials, or session data; record defects and results here.
