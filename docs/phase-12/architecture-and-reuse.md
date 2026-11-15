# Phase 12 architecture and reuse

## Status and source identity

- Checkout: `Figma Plugin Updated`, branch `main`.
- Source revision at discovery: `8088aa08c61cef750c843394ddaf0bab94eb75ed` (the historical Phase 11 baseline named by the specification was verified as the current HEAD).
- Implementation approval: received for Phase 12 source implementation. Live provider and Desktop acceptance remain separately gated and were not authorized.
- `manifest.json` continues to point at `dist/plugin.js` and `dist/ui.html`; no manifest edit was needed.

## Call path

```text
Existing Chat composer
  -> parseChatGenerationIntent (explicit create-only request, 1–10)
  -> persisted ChatTask with pinned model, Brand Kit, Skills, document and intent
  -> existing /v1/chat planning tools produce the ordered stages and shared brief
  -> createMultiScreenDesignRequest validates and translates to the existing design plan
  -> Chat generation link persists fingerprint, screen IDs, progress and verified roots
  -> App's existing structured generator uses /v1/design per section
  -> validated section transaction is saved before native apply
  -> existing generation-prepare / generation-apply-section / generation-verify
  -> existing renderer, placement and native visual verifier
  -> verified native root references return to the Chat checkpoint
```

The main implementation points are [App.tsx](../../src/ui/App.tsx) (Chat dispatch near line 1902, callback near 2090, generation reuse near 2920), [chat-task.ts](../../src/ui/chat-task.ts) (`runMultiScreenHandoff` near line 2628), [chat-generation.ts](../../src/shared/chat-generation.ts) (typed bridge and parser), and [generation-controller.ts](../../src/plugin/generation-controller.ts) (existing native operations).

## Reuse versus change

| Area | Reused | Phase 12 change |
|---|---|---|
| Chat | Existing composer, task router, `/v1/chat` planner, task save/load, execution model choice and edit/inspect tools in `src/ui/App.tsx`, `src/ui/chat-task.ts`, `src/shared/chat-task.ts`, and `src/shared/chat-tools.ts` | Explicit create-only natural-language routing, bounded stage metadata, one typed handoff callback, checkpoint correlation and progress. No JSX or `.chat-*` styling redesign. |
| Plan and generation | `createDesignPlan`, `DesignGenerationRequestSchema`, `createDesignSections`, `generateAuthorizedDesign` and existing `/v1/design` in `src/shared/design-generation.ts`, `src/ui/App.tsx`, and `src/companion/server.ts` | `src/shared/chat-generation.ts` translates Chat stages to renderer-valid screens, pins selected model and captured Brand Kit/Skills, and fingerprints the plan. |
| Persistence | Existing Companion draft store and `GenerationTransaction` commit-before-render path | Draft manifest correlates `chatTaskId` and plan fingerprint; Chat checkpoint stores cross-workflow status and screen-to-native-root mapping. No store merge. |
| Native output | Existing `generation-prepare`, `generation-apply-section`, `generation-verify`, `renderMultiScreenDesign`, canvas placement and native visual verification | Verified roots receive deterministic task logical refs. Existing task-native inspection can restore the ref registry after reload. |
| Offline JSON and standalone generation | Existing import, preview, renderer and standalone controls | Kept on their original routes. No clone of `/v1/design`, new renderer, or MCP server. |

The bridge is deliberately narrow because the structured path already has durable section transactions and native verification, while the Chat ledger has distinct edit and operation-replay semantics. The only native change outside that path is the generation-root metadata needed to make the verified screen addressable by Chat.

## Evidence boundaries

The three-screen integration fixture exercises the actual Companion draft store and production native controller/renderer/verification code with a mocked provider and mocked Figma API. It proves the local handoff path and replay behavior; it is not a live provider call, a Figma Desktop acceptance run, or a visual-quality claim.
