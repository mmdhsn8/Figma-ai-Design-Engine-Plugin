# Phase 4.6 feasibility and proof-of-concept gate

**Decision: architecture is conditionally feasible for a local proof of concept. Live authorization and inference are not verified.** The documented OpenAI open-source/local-app flow is the correct path for this Windows development companion. It does not prove this plugin installation or the owner's account is eligible. The companion must stop at **LIVE AUTHORIZATION PENDING** until the owner completes browser consent and a real direct Responses request succeeds.

## Decision matrix

| Gate                          | Finding                                                                                                                                                                                                                                                                                                                                        | Evidence / implementation consequence                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local app eligibility         | The OSS/local-app documentation describes dynamically registered local/open-source agents. It is not blanket approval for every Figma plugin or distribution model.                                                                                                                                                                            | Use the local companion path and follow the published terms. Eligibility still depends on the app, account, region, policy and consent. No claim of approval is made.                                                     |
| Browser OAuth, PKCE, callback | Supported contract uses the system browser, authorization code, PKCE S256, random state and nonce, and a loopback callback. The first authorization uses `dynamic_agent_client` as a registration entry point; the callback's issued `client_id` is the actual public client ID and must be retained for later authorization.                  | Companion binds only to `127.0.0.1`, uses an exact callback URI, a bounded one-time state record and an ephemeral verifier. It never embeds a login form or reads browser storage.                                        |
| Plan-use permission           | Identity scopes and inference permission are separate. The requested direct-use scope is `chatgpt.tokens.use.direct`; access is determined from the token response's **granted** `scope`, not the requested list.                                                                                                                              | UI must distinguish signed-in from Ready for AI. Missing granted scope is a blocked state.                                                                                                                                |
| Direct inference              | The documented route is `POST https://api.openai.com/v1/responses`, with the OAuth access token and documented resource `https://api.openai.com/v1`. Model availability is account-dependent; the documented model-list visibility is used instead of hard-coding a model. Streaming must be requested with `stream: true` and `store: false`. | The smoke test is an explicit user action with a fixed, minimal prompt. There is no API-key or paid-billing fallback.                                                                                                     |
| Figma network boundary        | The plugin manifest currently denies all network access. Figma documents `devAllowedDomains` as a development-only exception for local servers; production `allowedDomains` can remain `none`. The plugin UI iframe has browser APIs; the plugin main/controller does not.                                                                     | Add only a loopback development exception for the UI's companion connection. This has not been verified in Figma Desktop; CORS/private-network behavior remains a manual gate. The renderer stays offline.                |
| Credential handling           | OpenAI's OSS/local guidance and terms require user-controlled local credential handling and only the connected application to consume the user's authorized plan.                                                                                                                                                                              | Proof-of-concept keeps access/refresh tokens in process memory only. Only non-secret host/client identifiers are retained locally. A production protected-token store is deferred until live eligibility is demonstrated. |

## Official contracts reviewed

- [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart)
- [Token sharing for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [Open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Sign in with ChatGPT cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- [Sign in with ChatGPT UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [Figma plugin manifest](https://developers.figma.com/docs/plugins/manifest/), [network requests](https://developers.figma.com/docs/plugins/making-network-requests/), [plugin runtime](https://developers.figma.com/docs/plugins/how-plugins-run/), and [UI](https://developers.figma.com/docs/plugins/creating-ui/)
- OpenID discovery document: <https://auth.openai.com/.well-known/openid-configuration>

The reviewed OpenID discovery document advertises the issuer, authorization/token/revocation endpoints and JWKS URL. The implementation must consume those discovered endpoints and validate the expected issuer rather than infer endpoint paths. The documented authorize host is `auth.openai.com`; the direct inference host is `api.openai.com`.

The current model-list contract is a `models` array with `slug`, `display_name`, and `visibility`; the adapter exposes only `visibility: "list"` choices and sends the selected slug. Responses input is an array of context items, and each inference request uses `store: false` plus `stream: true`. Current preview documentation disallows `max_output_tokens`, so the fixed smoke request omits it and applies local time/response-byte bounds.

## Architecture and threat boundary

```text
Figma UI iframe -- paired bearer + Origin:null --> companion at 127.0.0.1:1455
       |                                           |-- system browser OAuth
       |                                           |-- exact loopback callback
       |                                           |-- direct Responses request on explicit smoke action
       +-- existing JSON messages --> Figma plugin controller --> local native renderer
```

The companion must reject non-loopback binds, non-`null` browser origins, unpaired requests, wrong content types, oversized bodies and unknown paths. A random one-time pairing code printed to the local terminal is exchanged once for an in-memory session bearer; it is not placed in the Figma document or persisted. OAuth state, nonce and PKCE verifier are one-use and short-lived. Tokens are never returned to the UI or written to logs/files. User prompts/design documents are not sent in this proof of concept; only the fixed smoke-test prompt can be sent after the user clicks the smoke-test control.

The host identifier and issued public client ID are installation metadata, not credentials. A SHA-256 digest of the validated `sub` binds that registration to one account; an explicit switch action clears the registration and digest but preserves the stable host ID. The proof of concept does not persist tokens or support multi-account session profiles.

## Baseline and scope

- Branch: `main`; baseline commit: `0507a12 Implement Phase 4.5 visual design engine`; baseline working tree was clean and synchronized with `origin/main`.
- Existing runtime dependencies: React, React DOM and Zod. No companion or network API existed. `manifest.json` had `allowedDomains: ["none"]` and no development host exception.
- Existing renderer, schemas, Phase 1–4.5 samples, validation, visual checks, component/style registries, placement logic and tests are retained. The AI prompt-to-design pipeline is not enabled before live authorization/inference clears this gate.
- Figma main/controller code is isolated from browser networking. Any localhost call is made from the plugin UI. `devAllowedDomains` and Chromium local-network restrictions require a real Figma Desktop check; mocked tests cannot establish that behavior.

## Gate status

| Live check                                 | Status                                    |
| ------------------------------------------ | ----------------------------------------- |
| Owner's interactive system-browser sign-in | **PENDING USER ACTION**                   |
| Granted `chatgpt.tokens.use.direct` scope  | **PENDING TOKEN RESPONSE**                |
| Real model discovery with authorized token | **PENDING USER ACTION**                   |
| Real minimal streamed Responses request    | **PENDING USER ACTION**                   |
| Figma Desktop loopback UI connection       | **PENDING USER ACTION**                   |
| AI design plan / schema generation         | **NOT IMPLEMENTED; BLOCKED ON LIVE GATE** |

Do not label Phase 4.6 complete or start the generation planner until the live authorization, inference and Figma Desktop gates are confirmed. Offline JSON remains the supported workflow regardless of gate outcome.
