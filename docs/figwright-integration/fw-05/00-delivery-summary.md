# FW-5 completion

The Universal task owner can accept a request-scoped image reviewer and run one native sizing correction followed by a fresh readback and a linked second PNG. The App supplies the plugin bridge. The shipping App has no consent UI or image provider configured. Provider execution and Desktop acceptance are pending.

FW-5 stays off by default. Set `VITE_FW5_VISUAL_QA=fw5-visual-qa-v1` for capture. Mode defaults to `capture-only`. A development caller can select `review` or `review+bounded-repair` and supply the reviewer and grant callbacks. Repair also requires `VITE_FW4_GEOMETRY=fw4-geometry-v1`. Rebuild after clearing the FW-5 variables to disable the path. Existing checkpoint metadata remains readable.

| Capability | Local evidence | Live status |
|---|---|---|
| Exact-root PNG export and typed binary receipt | Real plugin executor with fake Figma export | Desktop pending |
| Authorized image review | Task owner with stub reviewer and request grant | Production provider and consent route unavailable |
| One allowlisted sizing mutation and linked recapture | Real bridge repair and executor with fake nodes. Separate task owner scenario verifies checkpoint transitions | Desktop pending |
| Final visual verdict | Stub outcomes exercise pass, findings and unavailable | Real image quality unverified |

See [source map](01-architecture-and-source-map.md), [verification](03-integrated-tests-and-fault-injection.md), [metrics](04-gate-off-on-metrics.json), and [Desktop procedure](05-desktop-live-acceptance.md).
