# FW-7 — Live run matrix

FW-1's pre-registered fixtures and rubric are unchanged. This document records only FW-7 evidence; fake-runtime coverage does not replace those live runs.

| Fixture | Intended size / role | Offline result | Figma Desktop status |
|---|---|---|---|
| F0 | Baseline / empty or control case per FW-1 | No FW-7 live-equivalent run | LIVE PENDING |
| F1 | One-screen baseline | Synthetic renderer fake: 1 screen, 1 root, 13 created nodes, stable mock root hash | LIVE PENDING |
| F3 | Three-screen baseline | Synthetic renderer fake: 3 screens, 3 roots, 39 created nodes, stable mock root hashes | LIVE PENDING |
| F10 | Ten-screen baseline | Synthetic renderer fake: 10 screens, 10 roots, 130 created nodes, stable mock root hashes | LIVE PENDING |
| FH | Persian residential building-management flow | Not represented by the cloned learning fixture | LIVE PENDING |
| FE | Existing-design enhancement / edit case | Not represented by the cloned learning fixture | LIVE PENDING |

The fake runtime invokes the production renderer/executor with the repository mock Figma API. OFF and ON preserve the same root IDs, root counts, and node counts. ON reports 72 / 216 / 720 explicit native operation hooks, 15 / 45 / 150 create API hooks, 14 / 42 / 140 append hooks, 22 / 66 / 220 resize hooks, and 1 / 3 / 10 readback units for 1 / 3 / 10 screens. UI dispatch, checkpoint, provider, and screenshot metrics are `null` where that run did not observe the source.

The harness records a single run per size and gate condition. Its `localHarnessMs` includes mock execution and host/JIT noise. No speedup or UI↔plugin dispatch reduction is claimed. See [machine-readable results](local-fake-benchmark.json).
