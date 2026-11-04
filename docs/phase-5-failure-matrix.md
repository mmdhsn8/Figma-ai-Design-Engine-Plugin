# Phase 5 stabilization failure matrix

Desktop acceptance is pending. This matrix describes source-level reproductions, not live evidence.

| Failure                                | Proven source behavior before this change                                                          | Regression / action                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Nested text/icon control under 44 px   | Normalizer explicitly skipped text controls; whole-screen fit failure discarded every local repair | Table-driven nested geometry and text targets; retain strict post-repair validation          |
| Minutes of inference / EOF             | Companion waits for `response.completed` before returning JSON; UI sees no streamed stage progress | Record headers/first delta/idle/overall and client stage durations; no fixed latency promise |
| Successful JSON, empty canvas          | Design action ended at preview and required manual JSON action                                     | Persist each validated screen, then invoke native renderer automatically                     |
| Reload loses progress                  | Draft existed only in React ref                                                                    | Versioned disk screen checkpoints and document-scoped plugin metadata                        |
| Retry creates duplicate canvas cluster | Manual multi-screen renderer intentionally always creates new roots                                | Explicit AI resume mode, stable generation/screen IDs, completion markers                    |
| Wrong companion entrypoint             | Previously corrected script; current TS output is `dist-companion/companion/main.js`               | Keep automated entrypoint test and inspect rebuilt artifacts                                 |
| Parent fill changes hit area           | Declared geometry is not necessarily native stretched geometry                                     | Validate effective geometry and verify actual native controls before marking render complete |
| Crash between render and checkpoint    | No reconciliation boundary                                                                         | Reconcile completed canvas markers before retry; preserve user-moved frames                  |

Authentication, Responses `stream:true` / `store:false`, terminal-event validation, eight-level depth, and existing asset validation remain mandatory.
