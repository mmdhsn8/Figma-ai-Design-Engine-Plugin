# Root cause

The supplied incident reported zero confirmed mutations, a 350×300 identity budget, and nested controls below 44 px after a bounded repair. The raw failing section geometry was not available. Existing frames in the screenshot cannot be attributed to the failed task.

`parseChatGenerationIntent` recognizes Persian screen counts and ignores the editable adjective for edit classification. `generateDesignFromBrief` requests each section through `/v1/design`, runs shared normalization and composition preflight, saves a transaction, and dispatches native rendering and readback. The 350 px budget is the 390 px viewport minus two 20 px insets. The identity content cap is 300 px, separate from the 844 px viewport.

The previous repair tries a smaller gap, then stacks every sibling vertically. A synthetic Persian toolbar reproduces an avoidable expansion: four 100 px controls fit as two horizontal rows but not as one. The actual incident could involve different geometry. The current change addresses the unsupported wrap strategy, while QA still catches actual geometry and renderer mismatches.
