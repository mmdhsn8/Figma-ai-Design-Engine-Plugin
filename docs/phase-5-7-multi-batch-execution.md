# Phase 5.7 — progressive conversational canvas tasks

## Status

Implementation and automated checks are available. **Authenticated model + Figma Desktop acceptance is unverified.** Tests use scripted model responses and mocked Figma APIs, including integration with the unchanged native executor. They do not prove the live model plans the requested storefront correctly or that the resulting layout is visually acceptable.

## Diagnosis

The reported message came from `sendChatMessage` in `src/ui/App.tsx`, not Figma or the companion. The former condition was `chatToolCallCount.current + turn.calls.length > 5`. That counter accumulated across all model responses in one user turn, including inspection calls. The failure happened after receiving and validating the model response, **before dispatching that response's operations**. An otherwise valid sixth cumulative operation triggered it. An independent eight-iteration loop also counted both model responses and tool-execution passes, effectively allowing fewer than eight model rounds.

The original Desktop turn's exact response-call count and prior cumulative count were not recorded/provided; they cannot be reconstructed from the error text. The task view now shows model rounds, batch attempts, last-response call count, scheduled operations, confirmed operations, and completed/pending stages.

## Execution contract

- The model uses an allowlisted planning function to produce 1–12 ordered stages covering the request, then works only on the current stage. Planning is local orchestration, not executable Figma code.
- Each stage has at most 32 scheduled native operations and eight model rounds. A task has at most 240 native operations, 100 model rounds, and a 512 KiB checkpoint. Hitting a resource boundary preserves work and reports failure; it never marks remaining content complete.
- Each model response still accepts at most ten validated calls. Dispatch is sequential, with at most three operations per executor batch, byte-aware splitting, and one outstanding batch. Existing executor validation, ten-operation/64 KiB batch limits, idempotency fingerprints, queue limits, timeouts, consent rules, and 40-starts/minute enforcement are unchanged.
- The UI schedules at most 36 starts per rolling minute, retains timestamps across task resumes, and backs off if the executor is already busy from other work. Provider capacity errors receive at most two delayed retries; persistent quota exhaustion remains actionable failure.
- Stable task-scoped operation IDs are checkpointed **before** dispatch. Confirmed results are checkpointed before advancing. Lost acknowledgements replay identical IDs through the executor rather than asking the model to regenerate.
- Checkpoints use Figma client storage, scoped to document and page. No OAuth credentials are included. Loading does not automatically resume work. A checkpoint failure prevents the next batch.
- Completed call/output pairs can be compacted into internal checkpoint context; logical refs and confirmed results remain available for follow-up inspection/editing. Internal payloads are not rendered in the transcript.
- Stage completion requires confirmed operations and no unresolved failures. A failed action can be explicitly reconciled only after a successful same-tool, same-ref repair. Ambiguous partial mutations can still require manual inspection; retries do not blindly recreate them.

## Controls

- **Stop:** cancels model work/waits, requests executor cancellation between operations, records confirmations received for the active batch, and retains all committed canvas changes.
- **Resume:** restores the same task and operation IDs; reconciles in-flight work, skips known confirmations, then continues pending stages.
- **Retry Failed Stage:** retains successful work, supplies failed/unattempted results to the model, and requests inspection/repair of only the unfinished stage. It is not a fresh whole-page generation.
- **New chat:** clearing an unfinished checkpoint requires confirmation. It never removes canvas nodes. Follow-ups in the same chat retain the confirmed logical-ref inventory.

## Automated scenarios

Tests cover 50 operations across five stages and 20 sequential batches; a 43-operation Persian storefront fixture through the existing executor; write-ahead persistence failure; Stop/reload/Resume; lost acknowledgements and exact-ID replay; executor/provider rate limits; interruption of capacity waits; partial failure and targeted repair; follow-up edits; stage budgets; Unicode byte splitting; early completion claims; malformed/unauthorized calls; and cross-page/corrupt checkpoint rejection.

## Required live acceptance

1. Restart the rebuilt companion and reload the rebuilt development plugin in Figma Desktop. Authenticate/select a verified account model as usual.
2. Send once: «یک صفحه موبایل برای فروشگاه لباس طراحی کن؛ شامل هدر، جست‌وجو، دسته‌بندی‌ها، کارت محصولات و دکمه‌های خرید.»
3. Check that the stage list covers every requested section, native editable nodes appear progressively, and task counts advance only with actual confirmations. Check layout and Persian text visually; fixture tests are not visual acceptance.
4. Stop mid-task, Resume, then repeat across a plugin reload. Confirm no duplicate frames/cards/buttons and no lost commits.
5. Send a follow-up changing only an existing button's color. Confirm that the same node is edited and the page is not rebuilt.
6. Exercise a failed stage and capacity wait; confirm Retry Failed Stage/Stop retain earlier work and that unfinished content is not reported as complete.

No live authenticated-model or Desktop results are claimed by this report.
