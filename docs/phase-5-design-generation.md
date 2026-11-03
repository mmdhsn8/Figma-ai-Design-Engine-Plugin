# Phase 5 — AI design generation MVP

## Status

The prompt planner, companion inference endpoint, constrained output contract, bounded repair, validation, preview, offline fixtures, and handoff to the existing JSON import UI are implemented. **Live inference and Figma Desktop acceptance are not verified. Do not describe Phase 5 as complete until a real authorized request has rendered editable layers in Figma Desktop.** The coding environment has not signed into a ChatGPT account, confirmed entitlement, or made a live Responses request.

## User workflow

1. In **Design**, enter a Persian, Finglish, or English brief. Choose Mobile, Desktop, or both; select 2–4 screen families; optionally name the screens, choose copy language, and add a visual direction.
2. The deterministic planner previews screen names, stable IDs, device presets, and standard frames (Mobile 390×844, Desktop 1440×900). If the brief names a different number of screens, generation blocks rather than silently dropping screens. To make an explicit smaller batch, enter the selected screen names and matching count.
3. Load actual account-visible models in Settings and run the fixed Responses smoke test for the **same selected model**. Sign-in, plan-use scope, or model listing alone does not enable generation. The smoke test verifies inference access, not structured-output support.
4. Click **Generate Design**. The brief and deterministic screen plan go to the local companion; the open JSON document and local assets are not sent.
5. The companion returns a streamed Responses result with strict JSON Schema output. The plugin UI checks the bounded response contract, exact planned screen IDs, node depth/count, 44 px button targets, palette references, and existing multi-screen schema. It allows one second generation attempt with bounded validation feedback.
6. Review screen inventory, dimensions, node estimate, and deterministic quality warnings. Click **Review JSON before rendering**; confirm replacement of the existing JSON editor contents. Edit or validate through the existing JSON tab, then explicitly click **Generate all screens**. The existing renderer/placement planner creates native editable nodes in a non-overlapping cluster.

No Figma layers are created by the AI response itself. If generation fails validation twice, the request is cancelled, or inference is unavailable, existing JSON import and sample buttons continue to work.

## Architecture and safety limits

```text
Brief + target options
  → src/shared/design-generation.ts (normalization, deterministic plan, constrained contract)
  → src/companion/server.ts /v1/design
  → POST https://api.openai.com/v1/responses
  → streamed strict JSON Schema text
  → src/shared/design-generation.ts (untrusted output validation)
  → src/ui/design-generation.ts (tokenized multi-screen JSON adapter)
  → existing multi-screen parser, Quality panel, and explicit JSON import/render action
```

- Only a bearer-authenticated local companion request is accepted. It requires granted `chatgpt.tokens.use.direct`, a model returned by that account's documented model list, and an exact model match with the successful smoke test.
- The companion uses the documented Responses endpoint and `text.format: { type: "json_schema", strict: true, ... }`, with `store: false` and `stream: true`. It does not send `max_output_tokens`, use undocumented ChatGPT endpoints, or accept API keys.
- OAuth tokens stay in the companion. Requests are bounded by the existing 16 KiB companion request limit, 45-second timeout, one active design generation, and 768 KiB streamed design-output limit. The UI rejects companion responses above 1.1 MB; prepared JSON must fit the existing 1 MB editor limit.
- The output contract permits only frames, text, rectangles, and ellipses with a fixed palette-role enum. No JavaScript, HTML, arbitrary Figma operations, URLs, external image assets, or local files are accepted. Generated output is untrusted and must pass both generation-contract and existing multi-screen validation.
- Screen IDs are stable from the planner. A request supports 2–4 screen families; **both** creates 4–8 Mobile/Desktop frames. The existing batch parser caps total estimated native nodes at 5,000 and each screen at the existing schema limits. Canvas placement remains delegated to the existing horizontal-first planner; older clusters are not rearranged.
- The adapter creates a shared native color-token design system. It does not synthesize or fetch product imagery; any missing photo content needs a deliberate editable placeholder or user-imported licensed asset. Generated component masters are not yet included in this MVP.
- Output is held in memory until the user chooses to load it into the JSON editor. Prompts and model responses are not logged. A diagnostic error contains only a safe category or bounded schema issue, never credentials or the raw response.
- The quality panel reports configured checks and warnings, not a visual score. Font availability, Persian shaping, text overflow, composition, touch usability, and native component behavior still need manual Figma Desktop review.
- Figma UI keeps the existing 440×720 compact surface; long settings/results remain scrollable. The existing editor accepts up to 1 MB JSON, and the multi-screen parser/renderer keep their existing depth, node, asset, and placement limits. No larger Figma-specific message or inference limit is assumed.

### Official transport references

- [Sign in with ChatGPT — Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Sign in with ChatGPT — Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Responses API — Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)

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
2. Generate a Persian RTL storefront with 2–4 screens. Check natural Persian copy, تومان price labels where requested, mixed-direction text, font fallback, wrapping, and native editability.
3. Generate a two-screen English dashboard and at least one Mobile + Desktop counterpart. Compare information hierarchy and layout adaptation.
4. Inspect layers, text/Auto Layout, token styles, warning list, placement gap, and old canvas objects. Confirm generation did not add overlap or move prior clusters.
5. Exercise cancel, one validation repair, malformed output, revoked permission, account switch during a request, and companion offline behavior. Verify the JSON fixtures/import continue to work.
6. Only after the MVP passes, use the existing 10-screen Persian fixture for stress/layout review. Capture screenshots without callback URLs, credentials, or session data; record defects and results here.
