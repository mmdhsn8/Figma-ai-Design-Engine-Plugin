# FW-6 — Optional Desktop acceptance

**Not run.** The offline implementation did not require Figma Desktop. Run only after separately authorizing a new disposable Figma document/page, the selected provider/model and any usage cost, and each screenshot transmission (initial review and recheck require separate consent). Never use Test Shop — Phase 1 Storefront or another existing user document.

## Minimal procedure

1. Build with all FW flags unset and load the registered development manifest in a new disposable file. Record the build identity, page ID and a harmless unrelated sentinel node.
2. Submit `hi`, `hello`, and `سلام` in Chat. Confirm conversational replies and zero canvas additions/reads, provider planning calls, visual captures or design checkpoints.
3. Run an explicit one-screen Persian RTL mobile creation. Record task ID, screen ID, provider request ID, checkpoint revision/hash+bytes, render request/receipt, Figma root node ID/parent, complete native readback revision, geometry result and actual elapsed time. Close/reopen the plugin and Resume; root ID must remain stable and no duplicate root may appear.
4. In a separate disposable task, request three screens and press Stop while two preparations are in flight. Verify no new work starts, late responses do not mark screens complete, valid saved siblings and attached roots remain, and Resume reconciles those exact IDs.
5. For ten screens, use the F10 Persian building-management brief. Verify screen order, parent relationships, editable text/layout nodes, true RTL rendering, zero duplicate root IDs, checkpoint confirmation for all ten, and actual task completion count. Keep Desktop logs/counters separate from local harness values.
6. Exercise a single safe failure only if it is reversible in that disposable file. A geometry/readback error must leave the original attached root and unrelated sentinel untouched. For OAuth refresh, confirm a same-session refresh during an active screen request and accept the same authorized response; test a real session change separately only if it can be done safely.
7. Test FW-5B only with its gate explicitly enabled and a fresh consent dialog for one synthetic screenshot; a post-repair screenshot needs a second consent. Record provider capability as unknown unless the selected account-visible model returns a real result. Do not retry unsupported image capability or switch billing paths.
8. Save a redacted evidence bundle: build ID; task/generation/screen/request IDs; status/outcome codes; hash+bytes revision; native receipt/root/page/parent IDs; readback revision and QA state; elapsed timings; dispatch counts; duplicate/error/recovery counts; and screenshot only if explicitly authorized. Exclude prompts, account identifiers, tokens, layer text and raw image bytes.

Stop a stage after a missing/stale root, foreign mutation, duplicate, false completion, unconsented image request or checkpoint mismatch. Mark unperformed stages **NOT RUN** and failed external prerequisites **LIVE BLOCKED**. Do not infer live rendering speed from local timing tests.
