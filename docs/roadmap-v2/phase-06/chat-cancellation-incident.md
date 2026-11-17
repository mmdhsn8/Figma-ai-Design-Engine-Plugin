# Universal Engine cancellation incident

## Reproduced cause

The screenshot shows an unsuccessful ten-stage task before any native mutation. It contains no task ID, provider request ID, event timestamp, or abort origin. The historical request therefore remains uncorrelated.

The loopback regression reproduced the exact `request_cancelled` response before the fix. It used task `chat-refresh-0001`, request `chat-refresh-0001_p6_screen-01_c1` and sibling `chat-refresh-0001_p6_screen-02_c1`, both in `UNIVERSAL_COMPOSING`.

1. The scheduler reserves the screen attempt and saves its request ID in the checkpoint before it calls Companion.
2. Screen 01 starts a provider stream. Screen 02 starts while screen 01 is in flight, with the OAuth token inside the refresh window.
3. Companion refreshes the token and replaces its in-memory credentials object, retaining the authorized session ID, account subject, and plan scope.
4. Screen 01 receives `response.completed`. The old object-identity check rejects it with `request_cancelled`, although the stream's own diagnostic says `outcome: completed`. A refresh during the headers wait instead produced `signed_out`.
5. The old scheduler treated a screen failure as a task-wide abort, which could discard another valid sibling's result. With the first screen blocked, native rendering never begins.

The fixed Companion checks stable session identity, subject, and authorized scope instead of object identity. The scheduler stops admitting work after a screen failure and lets already dispatched valid siblings finish and checkpoint. Explicit Stop and confirmed scope loss still stop the task. A late response cannot cross the stopped run's checkpoint boundary. Resume reuses saved screen programs and reconciles already confirmed native roots.

## Diagnostics

| Evidence | Meaning |
| --- | --- |
| UI `[FAD_CHAT_CANCEL]`, `event: abort`, `cancellationOrigin: user_stop` | The Stop control cancelled the task. Join the task ID and active screen request IDs to Companion logs. |
| UI `plugin_closed` | The Chat iframe cleaned up on close or reload. |
| UI or Companion `session_changed` / `authorization_revoked` | A definitive account or authorization change ended the authorized task scope. A failed status observation alone does not do this. |
| Companion `same_session_refresh` | The credentials rotated while the request was active. The existing request stayed authorized. |
| Companion `client_disconnected` | The HTTP connection closed. This event alone cannot identify user intent. Correlate it with the UI cancellation event if present. |
| Companion `companion_shutdown` | The local Companion stopped its active inference requests. |
| `local_network_interruption`, `upstream_transport_interruption`, or `stream_eof` | The connection or stream ended separate from an explicit Stop. |
| `request_timed_out` with a timeout source | A local provider headers, idle, or overall deadline fired. |
| Scheduler `request_failed` with a provider request ID | The screen failed at the recorded lifecycle and attempt. Other in-flight screen requests are eligible to checkpoint valid results. |

These logs contain task, screen and request identifiers, elapsed or wall-clock timing, lifecycle, and allowlisted outcome fields. Share only the filtered diagnostic lines. Do not include prompts, access credentials, or full console output.

## Changed files and regression coverage

- `src/companion/server.ts` checks stable OAuth identity and records Companion-side termination. `tests/companion-server.test.ts` exercises refresh during headers and streaming, actual account disconnect, and an interrupted client connection.
- `src/ui/App.tsx` identifies Stop, plugin close, and authorization changes. `src/ui/companion-client.ts` carries that origin through HTTP and SSE and declines late data after abort. `src/ui/chat-task.ts` saves the diagnostic and preserves Legacy pause semantics. `tests/companion-client.test.ts` verifies Stop propagates without retry.
- `src/ui/universal-design-task.ts` separates screen failures from task-wide cancellation and keeps valid in-flight programs. `tests/universal-design-chat.test.ts` covers network interruption with 1, 3, and 10 screens, a late sibling result, checkpoint reload, and recovery without duplicate native roots.
- `src/shared/chat-cancellation.ts`, `src/shared/chat-task.ts`, and `src/shared/universal-design.ts` define the allowlisted, optional diagnostic fields.

## Desktop verification

1. Build the plugin and Companion, run manifest verification, restart Companion from the rebuilt output, and reload the registered development plugin in an authorized disposable Design file.
2. Open the Figma development console. Filter for `[FAD_CHAT_CANCEL]` and `[FAD_NATIVE_PROGRAM]`. Capture Companion terminal output filtered for `[FAD_CHAT_DIAGNOSTIC]` and `[FAD_CHAT_CANCEL]`.
3. Start an explicit ten-screen Universal task with independent screen briefs. Record its task ID and the first two `_p6_screen-*_c*` request IDs. The exact refresh case is verified only if a `same_session_refresh` event appears for one of those active requests, that request completes, and the task proceeds. Normal completion without that event is a live smoke test.
4. In a separate disposable task, press Stop after two requests are active. Confirm `user_stop` in the UI log and no late render dispatch. Relaunch and Resume the same task. Count the verified roots and compare their Figma IDs with the native trace.
5. For a network-interruption check, interrupt the connection without pressing Stop, then restore it. Confirm the transport or disconnect diagnostic has no corresponding UI `user_stop` event. Resume the same task and confirm saved sibling programs and already adopted roots are reused.
