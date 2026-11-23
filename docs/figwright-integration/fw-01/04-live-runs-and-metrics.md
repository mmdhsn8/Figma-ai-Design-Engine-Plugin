# 04 — Live runs and metrics

## Run ledger

No benchmark fixture was run live or with a mock design. No run IDs have been issued. The local harness diagnostics are a collector check only; they are not an A/B run.

| Fixture | Variant | Permission/Model | Build SHA | Requested/Confirmed Screens | Native Nodes/Components | Provider Calls/Rounds | Tool/Native Batches | Time to First Screen | Total Time | Geometry/QA | Human Visual Score | Recovery | Evidence Level | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F0 | Ours (Universal) | Model/call scope NOT AUTHORIZED; selection NOT MEASURED | Local plugin hash 169DB7…; Desktop-loaded hash NOT MEASURED | 0 / NOT MEASURED | NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| F1 | Ours (Universal) | File and model NOT AUTHORIZED/MEASURED | Local plugin hash 169DB7…; loaded hash NOT MEASURED | 1 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| F1 | Figwright MCP | File and model NOT AUTHORIZED/MEASURED | Source pin 458e3d…; binary hashes NOT MEASURED | 1 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| F3 | Ours (Universal) | File and model NOT AUTHORIZED/MEASURED | Local plugin hash 169DB7…; loaded hash NOT MEASURED | 3 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| F3 | Figwright MCP | File and model NOT AUTHORIZED/MEASURED | Source pin 458e3d…; binary hashes NOT MEASURED | 3 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| F10 | Ours (Universal) | File and model NOT AUTHORIZED/MEASURED | Local plugin hash 169DB7…; loaded hash NOT MEASURED | 10 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| F10 | Figwright MCP | File and model NOT AUTHORIZED/MEASURED | Source pin 458e3d…; binary hashes NOT MEASURED | 10 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| FH | Ours (Universal) | File and model NOT AUTHORIZED/MEASURED | Local plugin hash 169DB7…; loaded hash NOT MEASURED | 1 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| FH | Figwright MCP | File and model NOT AUTHORIZED/MEASURED | Source pin 458e3d…; binary hashes NOT MEASURED | 1 / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| FE | Ours (Universal) | File and model NOT AUTHORIZED/MEASURED | Local plugin hash 169DB7…; loaded hash NOT MEASURED | 0 new / target NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |
| FE | Figwright MCP | File and model NOT AUTHORIZED/MEASURED | Source pin 458e3d…; binary hashes NOT MEASURED | 0 new / target NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED / NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT REVIEWED | NOT MEASURED | SOURCE setup only | BLOCKED |

F3, F10, FH, and FE were not attempted because F0/F1 gates and the required live permissions were unavailable. Their status is BLOCKED, not a fast failure or a mock pass.

## F0/F1 continuation attempt — 2026-11-22

| Fixture | Variant | Run ID | Evidence observed | Outcome |
|---|---|---|---|---|
| F0 | Ours (Universal) | NOT CREATED | No Figma Desktop window, no authorized disposable file, no selected/approved provider model; no Chat message sent | BLOCKED before run |
| F1 | Ours (Universal) | NOT CREATED | F0 not run; no approved file/model/cost scope | BLOCKED before run |
| F1 | Figwright MCP | NOT CREATED | No approved B file; Figwright plugin not loaded and no MCP client configured | BLOCKED before run |

The only new measurements are environment checks: no Figma Desktop window in the Computer Use app inventory, no localhost listeners on ports 1455 or 3055, Node v24.21.0, npm/npx 11.19.0, and an existing Companion data directory whose file contents were not inspected. No timing, request count, native ID, screenshot, geometry, visual score, or readback was produced. No live result was replaced with mock data.

## Source-only expectations (not measurements)

The existing Universal route documents a normal provider request shape of one intent classification, one project plan, and one complete program per screen: 3, 5, and 12 requests for 1, 3, and 10 screens if each answers once. Bounded correction/repair may add requests. This is a source baseline only and cannot be compared to Figwright tool-call or live model latency counts.

The historical Phase 6 mock timing report in docs/roadmap-v2/phase-06 is excluded from this table. It measures a different local scheduler fixture, not Figwright, Figma Desktop, or user-perceived live latency.

The collector summarizes individual run files and can aggregate only comparable live PASS records. See [the measurement contract](02-measurement-contract.md) and [the run directory](runs/README.md).
