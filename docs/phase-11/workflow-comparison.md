# Workflow comparison

| Path                       | Input and orchestration                                                                                                  | Model requests                                                                                                   | Native path                                                                             | Best fit                                                                                 | Principal tradeoff                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| JSON / multi-screen import | User supplies validated JSON. `MultiScreenSpecSchema` checks screens, shared components/assets, and node totals.         | None                                                                                                             | Existing multi-screen controller and renderer                                           | Reproducible imports, offline work, exact layer structure, demos                         | User authors/provides structure; not natural-language generation                  |
| Structured AI generation   | User supplies brief, target/count, style, language, plus pinned Brand Kit/Skills. Screen plan and IDs are deterministic. | Three ordered requests per screen (`identity`, `primary`, `supporting`); each may use one bounded repair request | Durable section transactions; screen skeleton; append/render; fresh native verification | Multi-screen natural-language generation with incremental saved sections and resume      | Sequential request fanout; a slow section delays following sections in its screen |
| Conversational Chat        | User describes a create/edit/inspect/continue task. Model plans stages and chooses allowlisted tools in bounded rounds.  | Variable: intent/plan/continuation/repair/inspection and final completion                                        | Serialized native executor; per-operation checkpoint/idempotency; native QA             | Interactive edits to existing nodes, incremental creation, Stop/Resume/Retry, inspection | More orchestration and native round trips; not a single structured batch import   |

## Request-count implication for structured generation

For `N` planned screens, the source sequence requires `3N` successful section responses in the no-repair case. Since each section has at most one bounded repair retry, the hard source-path ceiling for these section requests can reach `6N` when every section needs repair. For the supported 400-screen upper bound, this means 1,200 baseline section requests and up to 2,400 including one repair per section. This is a source-derived upper bound, **not a forecast, measured run, or recommendation to run 400 screens**. Other setup/verification requests are additional.

In Chat, counting only model requests is insufficient. A valid timeline also needs model rounds, native batch starts, mutation acknowledgements, read-only inspections, local QA operations, provider waits/retries, and first/last native progress. The task schema already separates several of these categories; the audit found no live correlated trace to compare them.

## Should the paths be merged?

No. The paths have different contracts:

- JSON import is deterministic/offline.
- Structured generation returns a strict design representation and persists independently renderable screen sections.
- Chat uses stateful tool calls that can inspect/edit current canvas content and reconcile partial commits.

Sharing small contracts (job identity, timing vocabulary, quality finding shape, safe error categories) may reduce duplicated reasoning. Forcing both AI workflows through one pipeline would risk losing Chat's editing/recovery semantics or the structured generator's typed section/repair contract. Keep these adapters separate unless a future compatibility study proves that a shared orchestration layer preserves both.

## Ordering and parallelism

The current generator explicitly serializes section work per screen and records dependency order in transaction keys. Parallel model generation across independent screens could be a later experiment, but must not parallelize screen-section mutation order or remove commit-before-render. Apply backpressure for model capacity, local disk, Figma API, and native QA; retain serial fallback and exact cancellation/resume behavior.
