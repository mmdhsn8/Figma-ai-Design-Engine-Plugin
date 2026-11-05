# Phase 5.6 · Direct Figma Tool Engine

## Feasibility and current boundaries

- `src/shared/messages.ts` is the strict Zod-validated UI/plugin boundary. `src/plugin/main.ts` is the only UI message entrypoint; legacy JSON validation, rendering, and Design System routes remain in place.
- `src/plugin/figma-tool-executor.ts` is the new trusted canvas boundary. It receives only the versioned allowlisted actions in `src/shared/figma-tools.ts`; model/UI input never supplies Figma API method names, node paths, or executable code.
- `src/plugin/renderer.ts`, `src/plugin/figma-canvas-adapter.ts`, and `src/plugin/canvas-placement.ts` remain the reusable native renderer and non-overlap placement path. `src/plugin/generation-controller.ts` remains independent and unchanged as the Phase 5.5 generation workflow.
- The companion `/v1/chat` route requires the existing paired session, plan-use scope, and a model that passed the function-calling smoke test. The smoke test forces the harmless `get_document_context` function; chat streams text, validates completed Responses `function_call` output against `src/shared/chat-tools.ts`, and accepts the original call items plus `function_call_output` items for continuation. `store:false` is used; delete is not exposed.
- The UI exposes a Persian/English multiline chat, streaming/progress, Stop/Retry, and a separate collapsed developer harness. Tool calls are revalidated by the plugin executor and use stable call IDs as operation IDs so an in-session retry can replay the same operation without creating it twice.
- A code-level path that could strand the harness was fixed: executor promise rejections now produce terminal errors, invalid protocol responses can carry correlation IDs, Figma/storage awaits are bounded, and the UI watchdog reports missing replies. The exact Desktop trigger for the reported hang is still **unconfirmed**.
- Mocked tests cover tool-call parsing and function-output continuation. No authorized live tool-call run was available. Figma Desktop acceptance and the selected model's live Responses function-calling support remain **UNVERIFIED**; the environment has no Desktop UI automation/control path.
- Each chat response writes a `[FAD_CHAT_DIAGNOSTIC]` record containing only the correlated request ID, sanitized model/status, output item types/count, function-call count, continuation direction, and outcome. Prompts, response text, OAuth credentials, and tool arguments are never logged.

## Operation boundary

Every request uses protocol version 1, a batch ID, per-operation IDs and idempotency keys. The executor validates again at the message boundary, resolves logical refs only inside the current Figma page, checks native node types/parents, and commits each operation separately. Newly created nodes store their logical ref, operation ID and action fingerprint in plugin data; a bounded page-scoped record in `figma.clientStorage` stores the mapping and result status. Inspecting a selection assigns local logical refs to those native nodes so later edits never need raw Figma node IDs. Reloaded or stale IDs are re-resolved and checked; a missing/moved ref fails closed. A ref is tombstoned after deletion and cannot be reused.

Example internal request (not shown or required in AI Chat):

```ts
{
  type: "tool-execute",
  protocolVersion: 1,
  batchId: "phase56-batch-0001",
  operations: [{
    operationId: "phase56-frame-0001",
    idempotencyKey: "phase56:phase56-frame-0001",
    action: {
      tool: "create_frame",
      ref: "mobile-screen",
      name: "Persian mobile",
      parent: { kind: "page" },
      size: { width: 390, height: 844 },
      autoLayout: {
        direction: "vertical",
        gap: 16,
        padding: { top: 24, right: 20, bottom: 24, left: 20 }
      }
    }
  }]
}
```

The minimum tools are `get_document_context`, `inspect_nodes`, `create_frame`, `create_text`, `create_rectangle`, `set_auto_layout`, `set_properties`, `append_child`, `reparent_node`, `get_operation_status`, and consent-gated `delete_node`. Existing local paint/text styles are listed in bounded context and may be applied by verified local style ID. Text uses loaded fonts with a deterministic Inter/available-font fallback; Persian/RTL is represented by Unicode text and right alignment (the current plugin typings expose no separate text-direction setter). FILL/stretch sizing is normalized on the cross axis before Figma setters run. Root creation uses the existing row-fill obstacle planner; explicit x/y is accepted only as a pair.

## Safety limits and failure semantics

- 10 operations and 64 KiB per batch; maximum 4 queued batches; 40 new operations/minute; 10-second async Figma/storage/font boundaries; a 45-second UI response watchdog; inspection depth 4 / 50 nodes; 500 retained refs and 400 recent operation records per page.
- A cancellation is checked between operations. Earlier successful operations remain visible. The first failed operation stops the batch. There is no transaction-level atomicity: the result distinguishes committed operations from operations that may have partially mutated native properties. A persisted `running` operation is not blindly replayed after interruption; ambiguous operations fail closed for inspection. Newly created nodes are best-effort removed only if their own creation setup fails.
- Each successful mutation calls Figma's `commitUndo()` so the user can undo plugin changes. This does not promise multi-operation atomic rollback.
- `delete_node` requires a separate scoped confirmation request with the exact phrase `DELETE <logical-ref>`. The plugin issues a one-use, two-minute token bound to that ref; delete also removes its descendants. Chat does not expose delete or forward model-generated consent. Any future delete flow must show the target and obtain a separate human UI confirmation; a model-provided phrase is not user consent.
- The developer harness has no LLM dependency. Existing OAuth, pairing, JSON, Assets, Design System, Quality, and legacy renderer paths remain available.

## Tests and verification

`tests/figma-tool-executor.test.ts` covers native frame/text/rectangle creation, Persian fallback and RTL alignment, model-call-to-native-frame/text execution, local style tokens, targeted fill updates, mixed nested Auto Layout, stretch normalization, stale/cross-page refs, invalid parents, cycles, replay after executor reload, non-overlap with existing user content, cancellation, partial failure, storage timeout, scoped delete consent, and strict action rejection. `tests/chat-tools.test.ts`, `tests/companion-client.test.ts`, and `tests/companion-server.test.ts` cover allowlist validation, safe diagnostics, completed text/refusal/empty/incomplete responses, multi-call and multi-round continuation, malformed arguments, and function-call-output correlation. These are mock/unit checks, not live acceptance.

Build the plugin/UI and companion before running `npm run verify:phase5`; the compiled check asserts the current executor/protocol and UI outputs are not stale and boots the compiled companion on loopback. The check intentionally does not perform OAuth or claim Desktop acceptance.

## Manual Figma Desktop acceptance (pending)

1. Run `npm run build`, reload the development plugin from this repository's `manifest.json`, and confirm AI Chat is the default view with a multiline composer.
2. Expand **Developer only → Native operation harness** and click **1 · Create 390 × 844 frame**. Confirm a native frame with that size appears without editing/pasting JSON.
3. Click **2 · Add Persian title**; confirm the editable text layer reads `فروشگاه شما` and is right aligned.
4. Click **3 · Add editable input**; confirm the input frame and editable placeholder `جست‌وجوی محصول` appear as separate layers/operations.
5. Click **4 · Add button**; confirm the native Auto Layout button and editable Persian label appear.
6. Change the layer selection or add a harmless marker outside the fixture. Click **5 · Change button color only**; verify only the button fill changes and the title/input/marker are unchanged.
7. Click **Replay last operation**; confirm status says replayed/committed without an extra button or other duplicate layer. Reload the plugin and use the harness to inspect page context; logical refs are reloaded from the page-scoped store. To exercise replay after reload, repeat the same fixed fixture operation by clicking the corresponding numbered button; it should not duplicate its node.
8. Click **Safe invalid-layout check**. It tries `set_auto_layout` against the Persian text node, must report that Auto Layout requires a frame/component, and must leave the page intact. Do not invoke deletion for this check.
9. In Settings, pair the companion, complete ChatGPT sign-in/plan-use approval, choose an account-visible model, and run its function-calling smoke test. Send `salam, yek safhe baraye home shop tarahi kon`; verify a native 390 × 844 frame and editable Persian heading appear. Ask to change that heading's color; verify the existing text node changes without a duplicate. Reload the plugin and confirm the nodes remain.

For a safe chat diagnosis, find the matching `[FAD_CHAT_DIAGNOSTIC]` entries in the companion terminal using the request ID. Check `httpStatus`, `responseStatus`, `outputItemTypes`, `functionCallCount`, `continuationState`, and `chatState`. A completed response with `functionCallCount: 0` did not request a Figma action; `chatState: "tool_calls"` confirms validated calls were returned to the plugin. Never share OAuth tokens, prompts, response text, or raw tool arguments. If a native action may have partially committed, inspect the canvas before retrying; retries reuse operation IDs.

After the run, verify each layer in Figma's Layers panel and inspect text/editability, Auto Layout, RTL shaping, plugin reload, and Undo. Steps 1–8 require actual Desktop testing; step 9 also requires the authenticated account/model. None of these live acceptance steps has been verified in this environment.
