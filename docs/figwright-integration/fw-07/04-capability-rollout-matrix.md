# FW-7 — Capability and rollout matrix

| Phase | Current repository status | FW-7 interpretation | Rollout rule |
|---|---|---|---|
| FW-2 context/reuse | Code complete for the documented subset; Desktop/live pending; gate off by default | Continue using its existing reference revalidation and renderer path | No change from this phase |
| FW-3 native batch | Planner-only; no native batch dispatch | No batching improvement is being claimed or measured here | Keep execution disabled |
| FW-4 geometry | Code complete; default off; Desktop acceptance pending | Existing native geometry verification remains in the task owner | Do not turn on broadly from local evidence |
| FW-5 visual QA | Capture gate off by default; capture-only mode default | Capture/review counters observe existing capture and Companion seams | Screenshot capture and external transmission require separate approval |
| FW-5B provider review | Deterministic stub coverage; real provider capability unknown | Request/response counters do not prove model image quality | Require separately authorized provider smoke and visual review |
| FW-6 reliability | Local Stop/Resume and orchestration regressions pass; Desktop pending | FW-7 can help inspect future live runs; it does not change task authority | No change from this phase |
| FW-7 diagnostics | Added, exact-value opt-in; off by default | Local observer only; bounded memory and local export | Manual, approved acceptance only; no automatic rollout |

The default build has no FW-7 diagnostics event collection or Companion diagnostics route. To build the UI/plugin with local diagnostics:

```powershell
$env:VITE_FW7_DIAGNOSTICS = 'fw7-diagnostics-v1'
npm run build
```

To enable Companion export for that acceptance session, set `FW7_DIAGNOSTICS=fw7-diagnostics-v1` before starting its process. Clear both variables and rebuild/restart to return to the default. Build IDs are stamped from the current Git revision and `+dirty` state unless an explicit valid `VITE_FW7_BUILD_ID` is supplied; Companion can receive a matching `FW7_BUILD_ID`.

No auto-promotion, default-ON build, or implicit provider/image permission is added. Promote only after the live gates in [the Desktop procedure](06-windows-desktop-acceptance.md) have evidence recorded for the exact builds and authorized disposable file.
