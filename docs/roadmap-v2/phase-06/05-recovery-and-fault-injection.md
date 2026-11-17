# Recovery and fault injection

| Failure point | Local evidence | Result |
|---|---|---|
| Planning provider interruption | `restarts a lost Companion planning turn...` | Saved attempt retained; resume re-requests a bounded plan; no native node exists before a plan is saved. |
| Screen provider interruption | `recovers a lost per-screen provider response...` | In-flight state is recoverable; attempt count is consumed; resume retries within the per-screen limit. |
| Old Phase 5 pending compose | `reuses a compatible Phase 5 pending screen response...` | Compatible pending response is reused without a duplicate provider call. |
| Cancellation with two active screens | `cancels concurrent screen calls...` | Abort reaches active requests; late responses are ignored; no native render occurs; same task resumes from saved IDs. |
| Capacity response | `reduces persisted concurrency after a provider capacity signal...` | Concurrency becomes one in the checkpoint; bounded calls resume without an unbounded retry loop. |
| Durable save before native call | `reuses a persisted program when interrupted before any native creation` | Saved program is reused; any response that had not reached the durable checkpoint may be regenerated, once per screen attempt. |
| Native commit before adoption acknowledgement | `revalidates a built pending root after a simulated plugin restart...` | Existing built root is reconciled/adopted in place with its native ID. |
| After adoption, during readback | `resumes a checkpoint after interrupted post-adoption verification...` | Existing root and component master are reused; readback continues; no duplicate component. |
| Corrupted saved program/fingerprint | `rejects a schema-valid but changed saved program before replay` | Resume fails closed before mutation. |
| Partial/ambiguous render or readback | Native recovery, ownership and geometry tests | Missing acknowledgement or incomplete QA does not become `verified`; saved evidence remains inspectable. |
| Provider streams | Companion duplicate ID, third-request cap, cancellation, timeout and stream EOF tests | Duplicate request IDs fail; no more than two Phase 6 streams run; old generic chat remains exclusive; stream cancellation reaches upstream. |

Native renderer regressions also cover duplicate roots, partial adoption, missing font fallback, mixed Persian/English text, text bounds, painted overflow, vertical scroll, clipping, component/instance master identity and fresh geometry readback. The dedicated `qa:native-repair` suite passes 16 tests.

These are deterministic mock/fault-injection tests. They do not simulate process-kill timing inside the actual Figma Desktop host; the Desktop restart/reload and scoped-edit checks remain in the live acceptance script.
