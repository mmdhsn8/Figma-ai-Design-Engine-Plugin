# Current architecture map

## Runtime boundary

The plugin UI runs inside Figma, the plugin controller owns native API access, and the local Companion owns authenticated provider requests and durable generation drafts. The manifest limits production network access to `none` and permits the development Companion at `http://localhost:1455`.

```text
Figma UI (App.tsx)
  ├─ JSON / multi-screen import ─ schema + preview ─ plugin message ─ native renderer
  ├─ structured AI generation ─ local Companion /v1/design ─ section validation + draft
  │                                               └─ generation bridge ─ renderer + native verify
  └─ AI Chat ─ Companion /v1/chat ─ validated Responses tool calls ─ plugin executor
                                                         └─ task checkpoint + native QA
```

These are different product flows, not merely different screens over one request engine.

## Path A — JSON and multi-screen batch

`src/ui/App.tsx` detects multi-screen input and routes it to `parseMultiScreenText`/`MultiScreenSpecSchema`. The parser validates screen identities, layout/design schemas, assets, and shared component counts. The native controller renders the validated batch through `src/plugin/renderer.ts`, with placement and transaction/reconciliation support. This is a deterministic local import/render path; it does not call a model.

The current multi-screen batch action is not a Chat capability. The user must choose the JSON/import workflow. Preserve this as a low-variance, offline path.

## Path B — structured AI design generation

1. `App.tsx:generateDesignFromBrief` pins the selected model, Brand Kit, and selected Skills into a generation manifest.
2. `createDesignPlan` determines screen IDs, device presets, 390×844 mobile / 1440×900 desktop dimensions, domain, direction, and three ordered sections.
3. For every screen, the UI requests `identity`, then `primary`, then `supporting` from `/v1/design`. Each request targets one screen and one bounded section. There is one bounded repair attempt for an invalid section.
4. The Companion streams Responses output to a bounded local spool. The UI normalizes and validates the result, constructs a stable section transaction, and commits it to the durable draft before rendering.
5. The plugin creates a screen skeleton, applies saved section transactions idempotently, and reports native identity/section timing. A final validation/native verification runs for each completed screen.

The ordered per-screen transactions improve partial progress and restart recovery, but require at least three serial model responses for each screen before optional repairs. The draft store/checkpoint protects resumability; it does not make the provider call or native host operation atomic with the filesystem.

## Path C — conversational Chat

1. `src/ui/App.tsx` creates or resumes a `ChatTask` and checkpoints it.
2. `src/ui/chat-task.ts:runChatTask` controls intent, plan/stages, authorized calls, accounting, retries, verification, and lifecycle. Durable operation IDs are saved before dispatch; confirmed results are checkpointed before progress.
3. `src/ui/companion-client.ts` sends the authenticated request to `src/companion/server.ts:/v1/chat`.
4. The Companion validates the whole Responses function-call set against state-specific tool schemas before emitting dispatchable calls.
5. The plugin validates protocol messages and `src/plugin/figma-tool-executor.ts` serializes native operations, checks target identity/ownership/parentage, and reconciles idempotent retries.
6. Fresh native structural QA gates completion. Incomplete native coverage fails closed. Checkpoint storage and native executor records are separate stores.

Chat is interactive and supports existing-node inspection/edit/recovery. Its latency is driven by model rounds, tool batches, native operations, and verification; it cannot be treated as a direct substitute for the structured generator's section stream.

## Shared and independent responsibilities

| Concern          | Shared mechanism                                       | Separate policy/workflow                                                            |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Native creation  | Figma plugin renderer/executor and protocol validation | JSON rendering vs. section generation vs. Chat action tools                         |
| Quality          | Schema validation and measured native properties       | Structured visual/design validation vs. Chat task-native structural QA              |
| Durable progress | Stable identities, idempotency, durable writes         | Companion generation transactions vs. Chat task checkpoints/executor ledger         |
| Model            | Authenticated local Companion                          | `/v1/design` strict JSON output vs. `/v1/chat` function calling                     |
| User interaction | Same Figma plugin shell                                | Batch import, generation preview/progress, and conversation have different controls |

## Safety bounds visible in source

- Chat task: 240 mutations, 32-mutation execution segments, 240 read-only operations, 36 native verification operations, 512 KiB checkpoint, and 100 model turns at task level.
- Native quality scan: at most 5,000 nodes, depth 48, and 50,000 overlap comparisons; incomplete coverage does not pass.
- Structured AI generation: at most 400 native screens (200 screen families for `target: both`), with bounded nodes/section, screen, response, and spool sizes.

These are code contracts, not performance SLAs.
