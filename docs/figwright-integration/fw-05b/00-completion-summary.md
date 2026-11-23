# FW-5B completion summary

**Verdict: IMPLEMENTATION COMPLETE / PROVIDER CAPABILITY UNVERIFIED / DESKTOP PENDING.** The App now injects a request-scoped visual reviewer into the existing Universal task owner. Its image transport is a dedicated, typed Companion route using the current ChatGPT plan-use session. Consent, account/model checks, root readback, typed findings, bounded FW-4 sizing repair, recheck, and the existing task checkpoint path are connected and covered by deterministic local tests.

No real provider request or Figma Desktop operation was made. The provider route was exercised with fake fetch/Responses fixtures; Figma behavior was exercised with the repository's mock runtime. This is implementation evidence, not live capability or desktop acceptance.

## What changed

- Added [`src/shared/fw5-provider-visual-review.ts`](../../../src/shared/fw5-provider-visual-review.ts) for strict version-1 Companion request/result and provider issue schemas plus capability provenance.
- Added [`src/ui/fw5-visual-review-adapter.ts`](../../../src/ui/fw5-visual-review-adapter.ts) for task/session/root revalidation and fresh, one-image affirmative consent.
- Extended [`src/ui/companion-client.ts`](../../../src/ui/companion-client.ts) and [`src/companion/server.ts`](../../../src/companion/server.ts) with one bounded `/v1/visual-review` path; ordinary text-only Chat validation is unchanged.
- Connected the adapter through [`src/ui/App.tsx`](../../../src/ui/App.tsx) to the existing [`src/ui/universal-design-task.ts`](../../../src/ui/universal-design-task.ts) owner. The owner remains responsible for repair, readback, recheck, completion, and checkpoint acknowledgement.
- Extended [`src/shared/fw5-visual-qa.ts`](../../../src/shared/fw5-visual-qa.ts) with task-generation/image-revision binding and precise unavailable states. Added coverage in `tests/fw5-visual-qa.test.ts`, `tests/companion-client.test.ts`, `tests/companion-server.test.ts`, and `tests/universal-design-chat.test.ts`.

`VITE_FW5_VISUAL_QA` remains **off by default**. The existing `VITE_FW5_VISUAL_QA_MODE` also defaults to `capture-only`. For an explicitly approved local build, set `VITE_FW5_VISUAL_QA=fw5-visual-qa-v1` and choose `VITE_FW5_VISUAL_QA_MODE=review` or `review+bounded-repair`; this does not authorize a live provider request. FW-2, FW-3, FW-4, Legacy, Chat layout, and text-only request behavior were not intentionally changed.

## Safety and remaining proof

Every image request is limited to one PNG and bound to task generation, screen, document, page, root, program fingerprint, readback revision, receipt, selected account-listed model, session/account identity, and a fresh consent authorization. The UI and Companion validate independently. The consent dialog names the screenshot/root/screen/task, provider, selected model, data sensitivity, one-image count, and possible ChatGPT plan usage. Initial and recheck screenshots each require their own affirmative confirmation. Decline records `VISUAL_REVIEW_CONSENT_REQUIRED` and does not invoke the reviewer.

The Companion verifies granted plan-use scope, exact session/account identity, selected model availability, strict request shape and PNG signature/dimensions. It makes a single non-streaming `store:false` Responses request with `input_text` and `input_image`, no tools, and no retry or billing-route fallback. Image buffers are cleared after use; image bytes are not placed in chat history, task checkpoints, or logs. Provider findings remain untrusted: only a single-axis FW-4 sizing suggestion grounded in current native readback can enter the pre-existing repair gate. Attached roots are retained on failed repair/recheck.

Actual image modality support for the user's authenticated account/model/session is **unknown** until an explicitly authorized provider smoke test. Figma Desktop visual behavior, screenshot quality, native layout, and real Stop/Resume acceptance are **pending**. See [`05-live-acceptance.md`](05-live-acceptance.md) for the minimal later procedure.
