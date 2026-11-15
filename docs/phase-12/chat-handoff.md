# Phase 12 Chat handoff and recovery

## Task states

1. An explicit Chat create message is parsed locally. Edit, inspect, explain and continue requests do not enter this route; requests over 10 screens and combined mobile/desktop requests stop before a provider call or canvas mutation.
2. The usual Chat planner classifies create intent and saves the selected model, authorized account scope, document/page identity, prompt, pinned Brand Kit/Skills and ordered screen stages in the existing `ChatTask` checkpoint.
3. `runMultiScreenHandoff` builds and validates the versioned request. It creates or checks the generation link, saves `PLAN_SAVED`, and invokes the narrow adapter only for the saved create plan. A changed fingerprint or screen identity under the same task/generation fails closed.
4. The existing structured generation path captures a correlated draft manifest, obtains each section from `/v1/design`, validates it, saves its transaction, then applies it through the native renderer. Section order and one bounded repair are preserved.
5. Progress checkpoints include planning, screen start, section start, durable save, native render and native verification. Resume reconstructs the same task/generation identity and reuses durable transactions rather than requesting the Chat plan again.
6. Chat completion requires all requested screens and sections plus the native verifier's confirmation. Provider prose or a partially rendered screen cannot mark the task completed.

## Native identities

After a root passes full native verification, the generation controller stores:

- `fad.tool.task-id.v1`: the originating Chat task ID.
- `fad.tool.logical-ref.v1`: deterministic `screen-<hash>` reference derived from generation and screen IDs.
- `fad.generation.chat-task-id`: a marker used by task-native inspection to restore this verified generated root into the existing executor's saved logical-ref table.

The Chat generation link stores each verified `{screenId, nodeId, logicalRef}` tuple, and the originating stage is updated to the stable logical reference. Reinspection checks task ownership, page, uniqueness, and native node identity before it returns the ref. Node IDs are scoped to the saved Figma document/page and are not sent to the provider.

## Failure, pause and retry

- A provider timeout, malformed section, persistence error, native error or incomplete QA sets the generation link to failed/paused and propagates a safe error to Chat.
- Saved sections remain in the Companion draft. Retrying reconciles idempotency keys and skips durable transactions; the native timeout-after-commit path is covered by the mock integration test.
- Cancellation is checked between sections and before provider/native steps. An upstream request may finish after local cancellation; completed transactions remain recoverable and are not automatically resubmitted.
- Account, model, document/page, plan fingerprint and native screen identities are checked before continuing. A changed model or plan cannot silently replace the saved task context.
- The existing Chat inspect/edit route remains responsible for native follow-up operations. This phase records stable root identities; it does not add a new editing engine or parallel native store.
