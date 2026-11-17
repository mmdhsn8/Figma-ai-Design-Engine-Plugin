# Current pipeline and baseline

## Verified request path

`App.tsx` pins the task's selected engine/model and supplies the authenticated Companion and native bridges. `chat-task.ts` classifies the create intent, then invokes `runUniversalDesignTask` only for the saved Universal create route. `universal-design-task.ts` requests one ordered `ProjectPlanV1`, saves the shared visual language and pinned context, and requests one complete `DesignProgramV1` per screen. Each screen program contains composition regions; those regions are **not** separate model requests.

Normal provider fanout is therefore `1 intent + 1 plan + N screen programs` (`N + 2` requests/rounds when each responds once): 3, 5, and 12 requests for 1, 3, and 10 screens. A bounded plan correction, schema correction, or semantic repair may add a saved, explicitly budgeted request. This audit found no `3N` serial section-call loop on the current Universal route. The Legacy renderer and the existing commerce-specific design path remain separate.

## Operations that stay ordered

- Model composition runs concurrently only across screens whose dependency IDs have already saved a program.
- Each returned program is normalized, validated, fingerprinted, and checkpointed before render dispatch.
- Figma native render and ownership adoption remain one typed, idempotent screen transaction at a time.
- Fresh native readback and verification remain ordered by the saved project plan, not response completion order.
- The Companion permits two in-flight model streams only for recognized Phase 6 screen request IDs; generic/Legacy chat, smoke and design streams retain their previous exclusivity.

## Serial baseline

The fair local A/B fixture uses the same generated marine-archive project, deterministic delays (screen 1: 60 ms; remaining screens: 15 ms), mock renderer, full validation, persistence, native readback and three repetitions. A is the production scheduler capped at one model call; B is the same path capped at two. This isolates scheduling without removing quality work. A historical pre-scheduler run with 15 ms on every model call was also recorded during implementation; it is not pooled with this changed fixture.

The serial 1/3/10 run produced 3/5/12 requests, 3/5/12 completed provider rounds, 1/3/10 native batches and 10/32/116 editable native mock nodes. Before scheduler changes, a preliminary script with a fixed 15 ms provider delay recorded totals `[315,165,138]`, `[375,329,238]`, and `[974,804,827]` ms for 1/3/10 screens (medians 165/329/827 ms). Those early runs include substantial warm-run variance and use a different delay profile; they are retained as pre-change observations but are not compared to B. The matched current A/B results and timing splits are in [02-tracing-and-measurements.md](02-tracing-and-measurements.md).

Source map: [`src/ui/App.tsx`](../../../src/ui/App.tsx), [`src/ui/chat-task.ts`](../../../src/ui/chat-task.ts), [`src/ui/universal-design-task.ts`](../../../src/ui/universal-design-task.ts), [`src/shared/universal-design.ts`](../../../src/shared/universal-design.ts), [`src/companion/server.ts`](../../../src/companion/server.ts), [`src/plugin/design-program-spike.ts`](../../../src/plugin/design-program-spike.ts).
