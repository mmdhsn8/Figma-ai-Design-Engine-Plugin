# FW-5B code path map

## Operational local path

1. **Capture and evidence ownership:** `src/plugin/figma-tool-executor.ts` handles the existing typed visual-capture operation. `src/ui/task-native-bridge.ts` carries capture/readback messages. The PNG remains in memory and is passed to the task owner.
2. **Task owner:** `src/ui/universal-design-task.ts` builds the versioned review request with the existing task ID/generation, screen, document/page/root, program fingerprint, native readback revision, receipt, image revision, bounded native/program context, and PNG bytes. The task owner calls `authorizeVisualReview`, then `VisualReviewerV1.review`, validates the response, owns the single FW-4 sizing repair decision, obtains fresh readback, captures/reviews again, and saves progress through its existing checkpoint callback.
3. **App injection and consent:** `src/ui/App.tsx` constructs `createFW5VisualReviewAdapter` from the existing Companion token, selected account-visible model, session, and task owner. `src/ui/fw5-visual-review-adapter.ts` checks task generation and screen/root/page/fingerprint, validates current plan-use session/model availability, performs bounded root inspection before and after transmission, and asks for explicit per-image consent.
4. **Typed transport:** `src/ui/companion-client.ts::reviewAuthorizedVisual` validates dimensions and the grant, creates strict `CompanionVisualReviewRequestV1`, serializes one base64 PNG to local Companion, validates the correlated result, and maps only typed provider issues grounded in supplied native node IDs.
5. **Provider boundary:** `src/companion/server.ts` handles `POST /v1/visual-review`, independently checks request shape, canonical base64/PNG signature/actual size and dimensions, plan-use scope, session/account identity, model listing, active-request limit and cancellation. It sends one `input_text` plus one `input_image` Responses request with strict JSON schema, `store:false`, `stream:false`, and no tools. The response is parsed, normalized, grounded to allowed native nodes and returned with capability provenance.
6. **Repair and completion:** The response returns to `runVisualReviewerV1` and the Universal task owner. An image finding alone cannot mutate. Only a unique sizing suggestion that matches the known native readback/program mismatch can call the existing `repairVisual` bridge. The existing plugin executor revalidates the task-owned root and repair receipt; the task owner then requires fresh readback and a second, separately consented image review before final QA/checkpoint completion.

## Test boundary

The local suite tests the task owner plus production review adapter/client with an injected fake `fetch`; the fake validates the local Companion route payload and returns a schema-valid response. The Companion server is independently exercised with a fake OAuth/provider transport, including unsupported-capability and cancellation cases. The fake Figma executor runs through existing test mocks. This composes the real application seams offline; no external provider or actual Desktop document was contacted.

## Non-goals preserved

The implementation adds no second task ledger, image cache, provider account, external proxy, arbitrary action format, chat-history image field, or API-key route. `src/shared/chat-tools.ts` and the ordinary text-only `/v1/chat` contract remain separate. Existing task checkpoints and screen/root mappings keep their current meaning.
