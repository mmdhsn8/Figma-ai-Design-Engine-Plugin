# Optimization options and decision

## A — Serial control

Retained as an executable rollback through `maxConcurrentModelCalls: 1`. The 1/3/10 scripted baseline completed at 169/239/660 ms median with the same 3/5/12 requests and 1/3/10 serialized native batches.

## B — Bounded independent screens

Selected with a strict maximum of two concurrent screen calls, a default constant of two and a dependency-aware queue. Identical harness runs completed at 100/148/595 ms median. At three screens this cut the scripted median by 38%; at ten it cut it by 10%. One-screen runs do not use concurrency. Native apply/readback stays serialized; project-plan order controls placement.

The scheduler aborts sibling provider calls on failure, fences their late results, stores each accepted program before render and reduces concurrency to one after `inference_busy`, quota/rate limit or a non-admitted plan-use response. The chosen change does not relax preflight, QA or recovery.

## C — Fewer model round trips

Not implemented. The current Universal route already asks once for each full screen program, rather than three section calls per screen. Combining screens into one large response would raise output and partial-loss blast radius without current trace evidence that the protocol needs it. The current one-screen response is easier to checkpoint and resume.

## D — Native batching

Not implemented. Each typed render request owns one screen and its idempotent adoption evidence. Canvas mutations/readback are deliberately serial. Current mock timing does not show enough real Figma bridge latency to justify changing transaction boundaries or recovery semantics.

The experiment preserves the Phase 5 serial path and reports mock timings separately from missing live measurements. More repetitions beyond three are not needed to claim a p95; no p95 is reported.
