# FW-5B optional live acceptance

Offline implementation and test work is complete. Live validation remains a separate, explicitly authorized step; Figma Desktop access was not needed for this implementation.

## Minimal safe procedure

1. Obtain explicit approval for one provider request and an agreed usage limit. Use a generated, non-user-data PNG for the first modality smoke test if testing the provider capability separately.
2. Use a new disposable Figma document, never the protected Test Shop — Phase 1 Storefront file or another user document. Enable only the local test build: `VITE_FW5_VISUAL_QA=fw5-visual-qa-v1`; set mode to `review` for no repair or `review+bounded-repair` only when the FW-4 gate is already explicitly enabled and the test is reversible.
3. Sign in through the existing ChatGPT OAuth flow, confirm plan-use scope is granted and the selected model is currently account-listed. Do not enter an API key or switch billing routes.
4. Run a one-screen synthetic F1 task. Inspect the consent text and either decline (expect `VISUAL_REVIEW_CONSENT_REQUIRED`, no image request) or approve one image. If the provider rejects image modality, retain `unsupported` for that request context; do not retry or switch routes.
5. If a repair is intentionally tested, approve the separately prompted post-repair screenshot. Confirm the same root ID and parent before/after, at most one sizing correction, fresh native readback, no unrelated node changes, and checkpoint completion only after recheck. Stop during one disposable request to verify cancellation and retained attached nodes.
6. Save redacted evidence only: status/diagnostic codes, root/page identity, before/after readback, screenshots with user data removed, request counts and actual wall-clock timing. Do not collect tokens, image payloads, private layer text, raw OAuth objects, or protected-document data.

## Acceptance criteria

- Real provider capability is reported only from an actual authorized response/error for the selected model/session. Unsupported capability, no-scope, no-consent, cancellation and timeout remain distinct.
- No image or native mutation occurs after decline, task/session/root mismatch, Stop, or stale generation.
- Original task-owned root ID and unrelated nodes remain unchanged through review/repair/recheck; no replacement root or duplicate child is created.
- Only one allowed, native-readback-confirmed FW-4 sizing repair can run. Failed verification/recheck preserves attached task-owned nodes and incomplete checkpoint state.
- Final visual pass requires a real reviewed image and passing native checks. Mock tests or captured PNGs alone cannot satisfy live acceptance.

Until these steps are separately authorized and observed, provider capability remains **unverified** and Desktop acceptance remains **pending**.
