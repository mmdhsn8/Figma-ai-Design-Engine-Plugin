# FW-5B contract and consent

## Version-1 request

The shared strict contract is in `src/shared/fw5-provider-visual-review.ts`. A request contains: `version`, correlated `requestId`, `taskId`, `taskGeneration`, `screenId`, `documentId`, `pageId`, original `rootId`, `programFingerprint`, `readbackRevision`, capture `receiptId`, `imageRevision` (1 or 2), provider/model/session/account scope, consent authorization ID, exactly one image, PNG content type/dimensions/byte length/base64, fixed rubric, and bounded native/program context. Unknown fields are rejected. Native and design-program node context are typed and capped at 80 nodes each.

The existing capture bounds remain: one PNG, at most 4 MiB, 2048 pixels per dimension and 4 megapixels. The Companion has a 6 MiB JSON body cap to contain base64 overhead, checks canonical base64 and PNG signature/actual dimensions, rejects content/metadata mismatch, permits one in-flight image review, and uses the existing bounded request timeout. The UI validates again before serialization; the Companion treats its input as untrusted regardless of prior UI checks.

Provider results have a strict verdict/confidence/reason envelope and at most 10 typed issues. Each issue includes category, confidence, normalized image location, optional matched native node/path, observable evidence, allowlisted action (`none` or `fw4-sizing`), optional single-axis property/value transition, and whether a recheck is required. Raw code, arbitrary RPC, arbitrary target nodes, and destructive actions are not represented. The UI client drops a matched node reference unless it occurs in the supplied native node set; the task owner validates task/screen/receipt, image evidence, confidence and current readback before repair.

## Consent and identity lifecycle

The adapter checks that the task ID, generation, document, screen, current native root, page, fingerprint, and rendered/verified screen state still match. It verifies the current Companion session and account scope against the one used at consent time, requires plan-use authorization, and requires the chosen model still to be on the authenticated account's model list. The plugin root inspection must confirm the original root ID, page, parent and readback receipt before and after review. Stale or changed identity rejects the response.

Consent is a fresh affirmative action for each image. It names the exact task/screen/root/page/model/provider, initial versus recheck image, private screenshot content, one-image scope, capability uncertainty, and possible ChatGPT plan usage. A decline returns no grant. Grants are memory-only, randomized, tied to one image and the request identity; there is no standing consent persistence. The second review requires new consent, which is stricter than reusing the first consent grant.

## Outcome and checkpoint semantics

`CAPTURED` means the plugin returned bounded PNG bytes with a matching capture receipt. `REVIEWED` means a provider/human reviewer returned a strict correlated response; it does not mean the review passed. `VISUAL_QA_PASSED` requires a provider pass and passing native geometry/program consistency. `REPAIR_APPLIED` requires the existing executor to apply the single allowed size correction and return fresh native readback. `RECHECKED` is represented by the final second receipt/review and final outcome. Missing consent, unsupported route, missing scope/model, timeout, malformed result and request errors retain their specific unavailable/failed diagnostics; they cannot turn into a visual pass.

The Universal task owner remains the single checkpoint authority. It records receipt metadata and QA diagnostics, not PNG bytes. Existing failure behavior retains already attached task-owned roots and progress; this feature does not create replacement roots or delete attached roots to simulate rollback. A final verified checkpoint follows the normal task-save path only after the same task's readback/recheck conditions are satisfied.
