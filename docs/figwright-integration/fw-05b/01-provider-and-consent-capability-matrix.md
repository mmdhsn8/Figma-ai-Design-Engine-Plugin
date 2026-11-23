# FW-5B provider and consent capability matrix

## Current evidence

| Question | Status | Evidence and boundary |
|---|---|---|
| Does the public Responses request schema include image input? | Supported by official schema | `input_image` is present in the official [Images and vision guide](https://developers.openai.com/api/docs/guides/images-vision) and [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create). This only proves transport-format support. |
| Is image review allowed on this user's ChatGPT plan-use OAuth session? | Unknown | No real session/provider request was used. Companion checks that the existing session actually has plan-use scope; a ChatGPT sign-in alone is insufficient. See [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source). |
| Does the selected model support image input through that authorized route? | Unknown | The account model list has no modality metadata. The adapter labels capability `unknown` with `unverified_local_assumption`; it does not infer vision support from the model name. |
| What happens if the route rejects image input? | Defined and tested with a fake provider response | `subscription_sharing_unsupported_capability` maps to `unsupported` for that request/session/model, with no retry and no route or billing switch. See official [model/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [error handling](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). |
| Does an accepted provider response prove visual quality? | No | Only a strictly parsed and correlated provider result produces `REVIEWED`. Native checks remain separate; `VISUAL_QA_PASSED` requires an actual reviewer pass plus passing native geometry/program checks. |

## Capability status and provenance

The versioned capability object supports `unsupported`, `supported`, `unknown`, `authorization_required`, `consent_required`, and `temporarily_unavailable`, with provenance `provider_result`, `official_transport_schema`, `account_authorization`, `user_consent`, or `unverified_local_assumption`. Only an actual successful response can mark the exact request as supported; only an observed unsupported-capability response marks it unsupported. No hidden probe runs during model discovery or sign-in.

`/v1/visual-review` requires the normal authenticated Companion session, granted plan-use scope, a model currently listed for that account, and matching session/account hashes. Same-account token refresh is allowed because it retains the same session/account identity. Account changes, scope loss, selected-model mismatch, cancellation, and timeout fail closed. The new route never asks for or stores an API key and never changes to a separately billed route.

## Consent scope

Each browser-native `window.confirm` asks about one exact screenshot and displays screen ID, root ID, Figma page, task and generation, stage (initial or post-repair recheck), recipient, selected model, private-design-data notice, capability uncertainty, and possible plan use. The affirmative grant is scoped to that task/screen/root/page/provider/model/session and one image. No default acceptance or standing grant is stored. A recheck requires a second confirmation. Stop/account/session changes invalidate further use. If consent is absent or revoked, the task keeps its native result and records `VISUAL_REVIEW_CONSENT_REQUIRED`.

The screenshot travels only from the plugin's native exporter through UI memory to the local Companion, then in one Responses request if the authorization checks pass. It is not saved into Chat history, checkpoints, telemetry, logs, or crash reports by this path. The generated PNG is distinct from any later external transmission; external transmission occurs only after the corresponding affirmative confirmation.
