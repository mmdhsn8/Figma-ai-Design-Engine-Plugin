# Automatic model readiness

## Root cause

The registered checkout started `modelDiscovery` as `idle`. Its Companion lifecycle polled local health and `/v1/status`, then marked transport `connected`; neither startup nor reconnect called the account model catalog endpoint. `discoverModels` was reached from the Settings **Load available models** control and the Chat model menu's empty-list action only. The saved model preference could therefore be visible while the fresh in-memory account catalog was still empty.

Chat correctly failed closed. `getInferenceEligibility` requires a connected Companion, direct plan-use authorization, a fresh nonempty catalog containing the exact selected or task-pinned model, and a successful smoke verification for that same model. The saved model ID alone could not satisfy those checks. The Settings smoke button was the only regular route to verification.

Verification was already kept only on the live Companion `LiveSession`; it was not stored with OAuth credentials. After a Companion restart, `liveSessionFromStored` rebuilt the OAuth session with an empty catalog and no verified model. The UI did not have an opaque session identity to detect that the old catalog and verification no longer applied.

The described state reproduces with a saved `gpt-6-luna` preference, a reachable Companion and an authorized account while `modelDiscovery` remains `idle`: the connection chip says Connected, the preference can appear in the model selector, but Chat remains disabled because `companionModels` was never populated. No provider request is needed to reproduce it.

## Readiness flow

Chat and Settings use the same Companion status, account-visible catalog, selected or task-pinned model, and inference eligibility gate. `modelReadinessPhase` names the pending states; it does not grant eligibility itself.

1. Plugin startup restores the existing local model preference and checks the registered Companion session.
2. Once the preference read has completed and the Companion reports an authorized `scope_granted` or `ready` session, the UI automatically requests `/v1/models`. It requires the catalog response to include its matching status and checks that status against the active opaque session ID.
3. A saved or pinned model is retained exactly. If it is absent from the fresh catalog, readiness is `model_unavailable`; no different model is selected. With no preference, the user chooses from the fresh catalog. A model already verified in the same live session may be retained as the existing safe default.
4. A model already reported as verified for the exact active session and model is ready. Otherwise the UI asks once for consent before sending the existing fixed Responses function-call probe: `Call get_document_context with no arguments.` with a forced `get_document_context` tool call. It does not include chat or design content, JSON, Brand Kit, or Skills. Consent is in-memory and scoped to the active Companion session and exact model.
5. A denied prompt sends no request and is not repeated on route changes or rerenders. A later explicit Settings diagnostic remains available. A first retryable smoke failure can offer one explicit retry; rate limits, scope failures, account mismatch, model rejection, and cancellation do not get an automatic retry.
6. A successful result enables Chat only through the existing `getInferenceEligibility` gate. A timeout checks the current Companion status first; if the Companion confirms that exact model succeeded in the same session, the UI reuses that live result rather than sending a duplicate request.

## Freshness, identity, and failure handling

- **Catalog:** held in UI memory only and refreshed on every plugin startup/session restore. Its UI freshness TTL is 15 minutes. Expiration clears the cached models and re-runs discovery; a current exact-model verification can still be reused after that fresh catalog returns.
- **Verification:** held only on the live Companion session, bound to its exact model and an ephemeral random session ID. It expires after 8 hours. It is not written to the OAuth credential store. Companion restart creates a new session ID and removes the old catalog/verification; account switch and sign-out clear UI readiness.
- **Consent:** memory-only, exact session/model scope. It is not saved to Figma clientStorage or disk. Expired or cleared verification requires new consent before another metered-capable request.
- **Concurrency:** catalog and smoke requests are single-flight for the same scope. Replaced, cancelled, account-switched, or model-switched requests are aborted or fenced; stale results cannot set the current Ready state.
- **Recovery:** transient catalog transport failures get at most one automatic retry after two seconds. A later Companion offline/reconnect cycle retries a failed catalog. Smoke requests have the existing bounded request timeout and no automatic retry loop. Manual diagnostics remain available.
- **Errors:** Companion error categories and existing sanitized diagnostics are used. Access tokens, account identifiers, authorization headers, cookies, provider response bodies, and verification payloads are not persisted or logged.
- **Model choice:** no first-item fallback is made when the user has no preference or scoped verified model. Existing task model pins remain authoritative; the verification flow can check the pinned model without rewriting the global selection or checkpoint.

The opaque session ID is generated per live authenticated session and omitted from persisted credential data. The existing preference storage remains version 1; corrupt/future records are preserved by the existing storage handler. No History, task, Brand Kit, Skills, native canvas, or Figma node data migration was added.

## Changed files

- `src/ui/App.tsx` — startup/reconnect discovery, shared status binding, consent and bounded retry flow, catalog TTL, request invalidation.
- `src/ui/model-readiness.ts` — readiness phase policy, scoped request single-flight/fencing, consent ledger and catalog TTL helpers.
- `src/ui/companion-client.ts` — validates the optional opaque session identity in Companion status.
- `src/companion/server.ts` — emits a nonpersistent session identity and expires live model verification after 8 hours.
- `src/ui/inference-eligibility.ts` — preserves explicit/verified selections but no longer chooses an arbitrary first catalog entry.
- `tests/model-readiness.test.ts`, `tests/inference-eligibility.test.ts`, `tests/companion-server.test.ts` — state-machine, concurrency, selection, restart, session identity, verification TTL coverage.

The approved Chat JSX subtree, its snapshot, the `.chat-*` styles, and its existing source hash are unchanged. Only the existing Settings diagnostic explanation was clarified.

## Automated test coverage

Mock/source tests cover the reported connected-but-unloaded regression; automatic startup independent of Settings navigation; unauthorized transport; absent and unavailable models; no silent fallback; exact-model verification; consent scoping; request deduplication, cancellation and stale account/model responses; bounded retry policy; catalog freshness; task pin continuity; Companion restart/session identity; verification expiry; and existing Chat snapshot/style locks. Existing server/client tests continue to use mocked OAuth/provider responses. These tests do not make real OAuth or provider requests.

## Acceptance matrix

| Check                                                                 | Source/mock evidence                                                                                 | Real Figma/provider acceptance                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Startup and Chat-first catalog discovery                              | **PASS** — readiness policy and automatic effect; mock regression test                               | **BLOCKED** — no live authorized Desktop session exercised                        |
| Exact selected model, consent and smoke gating                        | **PASS** — mocked state, client/server tests; no model fallback                                      | **BLOCKED** — no live smoke was sent                                              |
| Session/account/model stale-response fencing                          | **PASS** — scoped coordinator tests and existing server account-switch tests                         | **NOT RUN**                                                                       |
| Companion restart and verification TTL                                | **PASS** — mocked restart/session ID and 8-hour expiry tests                                         | **NOT RUN**                                                                       |
| Chat JSX snapshot and `.chat-*` styling                               | **PASS** — existing snapshot/hash/style test                                                         | **NOT RUN** — no visual Desktop comparison                                        |
| History, task pins, Brand Kit, Skills, and native canvas preservation | **PASS** — no storage/canvas migration or mutation in this change; existing suite covers those flows | **NOT RUN** — valuable `Test Shop — Phase 1 Storefront` was not opened or changed |
| Live Chat message and provider readiness                              | **NOT RUN**                                                                                          | **BLOCKED** — no authenticated live session; no provider request made             |

## Windows/Figma Desktop acceptance checklist

Run this only with an authorized account and a nonvaluable disposable Figma page:

1. In Figma Desktop, load the development plugin from this exact registered checkout and confirm its manifest still points to the freshly built `dist/plugin.js` and `dist/ui.html`.
2. Start the local Companion, open Chat directly, and wait for automatic account model discovery. Do not use Settings as the trigger.
3. Confirm the saved model is retained only if it appears in that account's fresh catalog. If there is no preference, choose a model explicitly.
4. If the exact model has no valid current verification, review the one-time consent dialog. Accept only if the fixed request and possible account usage are acceptable. Confirm the exact model becomes Ready; cancel should send no smoke request.
5. Send a benign Chat message on the disposable page. Confirm the saved task pin remains unchanged.
6. Close/reopen the plugin while keeping Companion running; verify the catalog is refreshed and a valid exact-session result is reused. Restart Companion and verify its new session requires discovery and a new consented smoke test.
7. Switch accounts or change models while a request is pending. Confirm old responses cannot enable Chat for the new session/model. Wait past the documented TTLs to verify revalidation.

## Verification command record

Final local verification on 2026-11-14:

- `npm test -- --maxWorkers=1` — PASS, 34 files and 576 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npx tsc -p tsconfig.companion.json` — PASS.
- `npm run build` — PASS; refreshed `dist/plugin.js` and `dist/ui.html`.
- `npm run verify:phase5` — PASS; confirmed the registered manifest and current plugin/UI/companion entrypoints.
- `npx prettier --check` on changed formatted files and `git diff --check` — PASS.

No commit or push was made. No OAuth, provider smoke, Chat inference, or Figma canvas mutation was performed as part of this implementation.
