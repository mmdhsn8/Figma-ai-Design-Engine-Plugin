# Phase 4.6 feasibility and proof-of-concept gate

**Decision: architecture is conditionally feasible for a local proof of concept. Live authorization and inference are not verified.** The documented OpenAI open-source/local-app flow is the correct path for this Windows development companion. It does not prove this plugin installation or the owner's account is eligible. The companion must stop at **LIVE AUTHORIZATION PENDING** until the owner completes browser consent and a real direct Responses request succeeds.

## Decision matrix

| Gate                          | Finding                                                                                                                                                                                                                                                                                                                                        | Evidence / implementation consequence                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local app eligibility         | The OSS/local-app documentation describes dynamically registered local/open-source agents. It is not blanket approval for every Figma plugin or distribution model.                                                                                                                                                                            | Use the local companion path and follow the published terms. Eligibility still depends on the app, account, region, policy and consent. No claim of approval is made.                                                                 |
| Browser OAuth, PKCE, callback | Supported contract uses the system browser, authorization code, PKCE S256, random state and nonce, and a loopback callback. The first authorization uses `dynamic_agent_client` as a registration entry point; the callback's issued `client_id` is the actual public client ID and must be retained for later authorization.                  | Companion binds only to IPv4 and IPv6 loopback, uses the exact documented `127.0.0.1` callback URI, a bounded one-time state record and an ephemeral verifier. It never embeds a login form or reads browser storage.                 |
| Plan-use permission           | Identity scopes and inference permission are separate. The requested direct-use scope is `chatgpt.tokens.use.direct`; access is determined from the token response's **granted** `scope`, not the requested list.                                                                                                                              | UI must distinguish signed-in from Ready for AI. Missing granted scope is a blocked state.                                                                                                                                            |
| Direct inference              | The documented route is `POST https://api.openai.com/v1/responses`, with the OAuth access token and documented resource `https://api.openai.com/v1`. Model availability is account-dependent; the documented model-list visibility is used instead of hard-coding a model. Streaming must be requested with `stream: true` and `store: false`. | The smoke test is an explicit user action with a fixed, minimal prompt. There is no API-key or paid-billing fallback.                                                                                                                 |
| Figma network boundary        | Production `allowedDomains` remains `none`; the development manifest uses Figma's documented localhost development pattern. The plugin UI iframe has browser APIs; the plugin main/controller does not.                                                                                                                                        | The UI uses the localhost companion. CORS permits only the opaque `null` request origin and uses wildcard ACAO as Figma documents for plugin iframes. Manifest, CORS and private-network behavior still require a Figma Desktop gate. |
| Credential handling           | OpenAI's OSS/local guidance and terms require user-controlled local credential handling and only the connected application to consume the user's authorized plan.                                                                                                                                                                              | Proof-of-concept keeps access/refresh tokens in process memory only. Only non-secret host/client identifiers are retained locally. A production protected-token store is deferred until live eligibility is demonstrated.             |

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
Figma UI iframe -- paired bearer + Origin:null --> companion at localhost:1455
       |                                           |-- system browser OAuth
       |                                           |-- exact 127.0.0.1 OAuth callback
       |                                           |-- direct Responses request on explicit smoke action
       +-- existing JSON messages --> Figma plugin controller --> local native renderer
```

The companion rejects non-loopback binds, non-`null` browser origins, unpaired requests, wrong content types, oversized bodies and unknown paths. A random one-time pairing code printed to the local terminal is exchanged once for an in-memory session bearer; it is not placed in the Figma document or persisted. OAuth state, nonce and PKCE verifier are one-use and short-lived. Tokens are never returned to the UI or written to logs/files. User prompts/design documents are not sent in this proof of concept; only the fixed smoke-test prompt can be sent after the user clicks the smoke-test control.

The host identifier and issued public client ID are installation metadata, not credentials. A SHA-256 digest of the validated `sub` binds that registration to one account; an explicit switch action clears the registration and digest but preserves the stable host ID. The proof of concept does not persist tokens or support multi-account session profiles.

## Baseline and scope

- Branch: `main`; baseline commit: `0507a12 Implement Phase 4.5 visual design engine`; baseline working tree was clean and synchronized with `origin/main`.
- Existing runtime dependencies: React, React DOM and Zod. No companion or network API existed. `manifest.json` had `allowedDomains: ["none"]` and no development host exception.
- Existing renderer, schemas, Phase 1–4.5 samples, validation, visual checks, component/style registries, placement logic and tests are retained. The AI prompt-to-design pipeline is not enabled before live authorization/inference clears this gate.
- Figma main/controller code is isolated from browser networking. UI calls use `http://localhost:1455`; the OAuth callback separately uses `http://127.0.0.1:1455/auth/callback`, as required by the [official OpenAI OSS sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), which says not to substitute `localhost`. The companion binds only to `127.0.0.1` and `::1` so either Windows localhost UI resolution family is covered. `devAllowedDomains` and Chromium local-network restrictions require a real Figma Desktop check; mocked tests cannot establish that behavior.

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

## 2026-11 loopback startup repair record

The reported startup failure is tied to `networkAccess.devAllowedDomains: ["http://127.0.0.1:1455"]`; Figma's console rejected that exact entry as an invalid URL in the user's build. The [official Figma manifest examples](https://developers.figma.com/docs/plugins/manifest/) document local entries such as `http://localhost:3000` and `http://localhost:8081`, so the manifest now uses the narrow `http://localhost:1455` pattern. Production `allowedDomains` remains `none`. A regression test compares the manifest against the companion UI configuration and rejects the prior value; only Figma Desktop can prove its own validator accepts the repaired manifest.

Tracing the full path exposed adjacent mismatches that would remain after fixing the manifest string: the UI requested `127.0.0.1` while the manifest allows `localhost`, and Windows can resolve `localhost` to `::1` while the old server listened only on `127.0.0.1`. The Windows resolver in this development environment returned both `::1` and `127.0.0.1`; the companion now binds exactly those two loopback addresses on the same port, never `0.0.0.0` or a LAN interface. Figma UI calls and corresponding Host validation use `localhost`; OAuth callback validation separately uses the provider-required `127.0.0.1` URI. The two channels share the listener but have distinct exact host checks. OpenAI's current [OSS sign-in specification](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) explicitly requires `127.0.0.1` and says not to substitute `localhost`; the system-browser callback is independent of Figma's manifest allowlist.

The companion previously returned `Access-Control-Allow-Origin: null`. The [Figma network guide](https://developers.figma.com/docs/plugins/making-network-requests/) states plugin UI iframes have a `null` origin and can call APIs only when the response permits `Access-Control-Allow-Origin: *`. CORS now returns `*` only when the incoming Origin is exactly `null`; cookies remain disabled and every privileged route still requires the one-time-paired bearer. It answers the browser's Private Network Access preflight header when present. Local tests exercise both loopback listener families, preflight, origin rejection, single-use pairing, unpaired rejection, and manifest/client config consistency. They do not prove Figma Desktop's CSP, manifest, or private-network behavior.

The plugin UI iframe owns calls to the companion; the Figma controller remains isolated from networking. OpenAI authorization and inference requests originate from the companion and do not expand the Figma plugin's manifest allowlist. The unrelated telemetry/network console messages in the screenshot were not shown to originate from this plugin and were not changed.

## 2026-11 OAuth `ext_agent_host_id` failure diagnosis

The authorization URL code always included `ext_agent_host_id`; it was not missing. The defect was its value. `createInstallationStore()` previously persisted `randomUUID()` directly, and `createAuthorizationUrl()` sent that raw UUID string. OpenAI's current [host ID format requirements](https://developers.openai.com/siwc/token-sharing-open-source) specify UUIDv4 formatted as `urn:uuid:<hyphenated UUID>`. Therefore the old stored value was malformed for this required field and matches the browser's `invalid_authorize_request` parameter name. It was not evidence by itself that this Figma app or account was ineligible.

The repair now creates a documented UUIDv4 URN for new installations, validates the supported app format before constructing the authorization URL, and migrates only a legacy bare UUIDv4 generated by this app by prepending `urn:uuid:`. The UUID itself and any valid issued client ID/account hash are retained. A different invalid persisted value causes a clear error without overwriting metadata or inventing a new host identity.

The authorization parameter audit against [OpenAI's current registration/sign-in contract](https://developers.openai.com/siwc/token-sharing-open-source/sign-in):

| Parameter / behavior             | Implementation finding                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id`                      | Uses `dynamic_agent_client` only when no issued client ID exists; retains and reuses the issued callback client ID for reauthorization. |
| `agent_name_hint`                | Uses the app name only on initial dynamic registration; omitted for a retained client ID.                                               |
| `ext_agent_host_id`              | Always included; prior format was malformed bare UUIDv4. Now persisted as `urn:uuid:<UUIDv4>`.                                          |
| `response_type`, scope, resource | `code`; documented identity and plan-use scope set; `https://api.openai.com/v1`.                                                        |
| Redirect                         | Exact HTTP loopback `http://127.0.0.1:<port>/auth/callback`; same URI is used for the code exchange.                                    |
| `state`, nonce, PKCE             | Fresh cryptographic state, nonce, and verifier per attempt; S256 challenge; callback state and ID-token nonce validation retained.      |
| Optional hints                   | `id_token_hint` and `login_hint` are optional in the spec and are not used by this memory-only proof of concept.                        |

This code/doc comparison supports the malformed host ID as the cause to fix. It does not establish hidden server-side eligibility, successful dynamic registration, granted scopes, or inference access. No live authorization or inference was performed. After restarting the companion, the user must retry the browser flow; if the same parameter error persists with the now-validated URN, stop and capture only the sanitized error category/parameter. Do not try alternate host IDs, cookies, private endpoints, or API-key billing as workarounds.
