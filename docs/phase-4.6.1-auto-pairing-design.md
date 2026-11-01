# Phase 4.6.1 — Local pairing design and threat model

## Current implementation observed

- `src/plugin/main.ts` owns document access and shows the bundled React UI. The UI makes direct `fetch` requests to the companion; companion traffic does not pass through the Figma controller.
- The UI is an opaque-origin iframe (`Origin: null`). Figma documents that the plugin UI is an iframe and that plugin iframe requests use a `null` origin. The companion currently allows that origin for API requests and returns wildcard CORS headers; this is browser transport configuration, not client authentication.
- `npm run companion` listens on IPv4 and IPv6 loopback and prints no pairing secret. The UI polls an unauthenticated health endpoint, then creates a one-use pairing attempt using a Web Crypto verifier. A system-browser page asks the user to approve local access. The companion returns a short-lived bearer only to a poll that proves possession of the verifier after approval; that bearer stays in React state only. All account-sensitive routes require it.
- The companion launches the system browser for the separate OpenAI OAuth flow. OAuth state, nonce, PKCE, host ID, callback, scopes, and token handling are separate from local pairing. Tokens remain in companion memory.
- The UI polls authenticated OAuth status while browser sign-in is pending. The unauthenticated health response reveals only whether the companion is running, not account or authorization state.

## Trust boundaries

```text
User click in Figma UI
        │  Figma postMessage is available, but is not a local-network identity proof
        ▼
Figma plugin UI iframe (opaque origin / Origin: null)
        │  health + random verifier-bound attempt over loopback
        ▼
Local companion (127.0.0.1 and ::1 only; pairing/OAuth state in memory)
        ├── system browser → explicit same-origin local approval form
        │                    │  approve/deny + CSRF token
        ├── session bearer ──┘  returned only to verifier-bound plugin poll
        └── system browser → official OpenAI authorization and callback

Other localhost clients and opaque-origin frames can reach loopback. A client that
creates its own attempt can receive a bearer if a user approves that attempt and it
proves the verifier it chose. A malicious process running as the same Windows user is
outside the protection boundary of this local application.
```

The Figma Plugin API does not provide this local companion with a documented, verifiable assertion that an HTTP request came from this particular plugin/controller. A plugin ID sent as JSON or a fixed secret embedded in a public bundle would not prove that identity. Therefore silent cryptographic zero-interaction pairing is not achievable with the current architecture.

## Threats and limits

| Threat                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                      | Remaining limit                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hostile website probes localhost                             | Loopback-only bind, host validation, no-store responses, a minimal unauthenticated health response, pairing-attempt limits, and browser approval with exact same-origin/CSRF checks. A non-null website origin is rejected by API CORS checks.                                                                                                                                                                                  | Browser behavior around local-network permission can differ by Figma/Desktop version; manual verification remains required.                                                                                                                      |
| Another opaque-origin iframe sends `Origin: null`            | `Origin: null` is accepted only as the Figma transport origin, never as proof of identity. Each attempt has a high-entropy in-memory verifier. The user must approve on a loopback page; the companion returns the bearer only to a poll that proves possession of the verifier. The approval page says it cannot identify the requesting plugin and tells the user to approve only immediately after their own click in Figma. | Another opaque-origin client can create its own approval request and imitate the timing or wording. The page cannot cryptographically tell it apart. User intent is the security boundary for that case.                                         |
| Malicious process running as the same Windows user           | No network listener outside loopback; pairing and OAuth state are short-lived/in-memory; tokens are not written to disk or logs; approval and verifier are one-use and expire.                                                                                                                                                                                                                                                  | A same-user process can connect to localhost, automate the browser, inspect or interfere with the user's processes, or race local requests. This design does not claim protection from malware or hostile code already running as the user.      |
| Cross-site request forgery against the browser approval page | The approval form requires an unguessable per-attempt CSRF value; if browser `Origin` or Fetch Metadata headers are present, mismatches are rejected. The page disallows framing/external resources and approval is one-use and short-lived. Only `localhost`, `127.0.0.1`, and `[::1]` on the companion's exact port are accepted.                                                                                             | Browsers may omit optional Fetch Metadata headers for a user-opened local page; those headers are not required because the CSRF proof remains mandatory. A user can still be socially engineered into approving a request they did not initiate. |

## Selected design: browser-mediated local approval

The terminal code is removed from the normal pairing flow. After the user presses **Continue with ChatGPT**, the plugin UI creates a random 256-bit verifier with Web Crypto and asks the companion to create a short-lived attempt. The companion stores only the verifier hash, returns an unguessable attempt ID, and opens a local approval page in the system browser. The approval URL contains no session bearer. The user approves or denies with an explicit button.

The plugin polls with both the attempt ID and the original verifier. An attempt ID alone is not authorization. Only after an explicit browser approval and a valid verifier does the companion return a separate random session bearer. The bearer is held in UI memory, expires after 15 minutes without an authenticated request or when the companion exits, and is never placed in a URL, the Figma document, persistent browser storage, or logs. The approval POST requires the CSRF value and exact loopback host/port. `Origin`, `Sec-Fetch-Site`, and `Sec-Fetch-Mode` are checked when sent, but the latter two are optional browser metadata; missing metadata does not reject a valid same-origin form. Attempt IDs expire after 90 seconds; pairing starts are limited to five per minute, one incomplete attempt is allowed, and the approval page can be reopened at most three times for an attempt. Attempt IDs, CSRF values, verifier hashes, and session bearers are one-use or short-lived and kept only in companion memory.

The browser page does not claim that it verified a specific Figma plugin. It explains that the user should approve only if they just initiated connection inside the intended Figma plugin. This is the practical no-copy/paste alternative: it removes manual transcription while preserving an explicit local consent step. It is weaker than the old code's proof that the user could transfer a value from the companion terminal into the intended plugin UI; users must accept that tradeoff.

## Approval POST browser compatibility

The earlier POST handler required exact `Origin: http://localhost:<port>`, `Sec-Fetch-Site: same-origin`, and `Sec-Fetch-Mode: navigate`. The first repair made Fetch Metadata optional, but still passed every present Origin to `new URL(origin)`. An opaque `Origin: null` throws there and produces “The browser origin could not be verified.” The GET handler in that revision did not call this parser; the reported string came from the POST after the browser submitted the form, while polling stayed pending. The exact Windows request headers were not captured, so the failure identifies the parser's URL-construction catch but not the raw header value; local HTTP regression tests reproduce the likely opaque-Origin case as well as the earlier missing-metadata rejection.

The approval GET and POST now validate Host against the exact port and one of `localhost`, `127.0.0.1`, or `[::1]`. A matching loopback Origin is accepted. A missing Origin is tolerated because the POST still needs the one-use CSRF proof. `Origin: null` is accepted only with top-level navigation metadata (`Sec-Fetch-Site` of `none` or `same-origin`, `Sec-Fetch-Mode: navigate`, and `Sec-Fetch-Dest: document`); a present `Sec-Fetch-User` must indicate user activation. Other origins, cross-site metadata, non-navigation requests, and non-document destinations are rejected. The GET page uses the same navigation allowlist but never makes a pairing decision. Rejected pages show only safe classifications of Host/Origin/Fetch Metadata values—never the approval URL, attempt ID, CSRF value, or credentials. Rejected POSTs do not consume or approve the pending attempt, so the plugin can reopen and retry it. Denial, expiration, cancellation, replay, malformed form, and invalid CSRF responses are distinct.

## Separate authorization gates

1. **Local pairing:** browser approval grants only a local companion session bearer.
2. **OpenAI sign-in:** the companion separately opens the documented system-browser OAuth flow.
3. **Plan-use authorization:** the companion checks the granted scope in the token response.
4. **Inference:** model discovery and the fixed smoke test remain gated by actual authorization and explicit user action.

If either local approval or the official OpenAI browser launch fails, the UI provides a user-triggered retry. The OpenAI authorization URL stays in companion memory and is never returned to the UI; retry opens the same bounded, short-lived OAuth transaction. Browser retries are capped, and the user must still complete the official system-browser consent flow.

A successful local pairing is not evidence of OpenAI account identity, plan eligibility, a granted inference scope, or a successful live request. No OAuth parameters, scopes, callback, or provider behavior are changed by this UX work.

## Official references

- [Figma: How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/) — the main plugin sandbox and UI iframe have different capabilities.
- [Figma: Creating a User Interface](https://developers.figma.com/docs/plugins/creating-ui/) — `figma.showUI`, UI/controller messaging, and opaque-origin behavior.
- [Figma: Making Network Requests](https://developers.figma.com/docs/plugins/making-network-requests/) — plugin iframe CORS and manifest network access.
- [Figma: Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/) — development-only localhost allowlists.
- [OpenAI: Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) — official OAuth flow remains a separate gate.

## Verification boundary

Automated tests can verify attempt binding, one-use approval, CSRF rejection, expiration, replay behavior, loopback integration, and preservation of the offline renderer. They cannot prove that Figma Desktop's iframe will successfully access the local approval/health endpoints or that the external browser opens as expected. Those checks remain pending until run on the user's Windows Figma Desktop installation.
