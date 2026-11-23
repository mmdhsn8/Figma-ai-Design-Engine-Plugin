# FW-7 — Measurement contract and privacy

## Event contract

`fw7-event-v1` is a strict event record and `fw7-event-stream-v1` contains source snapshots. The Zod contracts live in `src/shared/fw7-observability.ts`; JSON contracts are in `event-stream.schema.json`, `run-manifest.schema.json`, and `collected-artifact.schema.json`.

Each event has a source-local `sequence`, boundary, event kind, stage, outcome, wall-clock timestamp, optional monotonic timestamp, and allowlisted correlation/measurement fields. Unknown event fields fail closed. A missing source measurement is `null`; an observed zero is `0`.

## Bounds

- Up to 8 in-memory run snapshots per runtime and 256 retained events per run; old events/runs are dropped with counts.
- Export is capped at 1 MiB. The event collector also rejects any input or output exceeding 1 MiB and caps counts, strings, and manifest collection sizes.
- Durations use nonnegative bounded numeric values. Median/p95 are emitted only with at least three same-source, same-clock-origin samples.
- No persistent telemetry, new checkpoint field, or second run ledger is introduced.

## Consent and export

- UI and plugin export hooks are added only when the Vite gate is set to the exact value `fw7-diagnostics-v1`.
- Companion uses the separate process environment variable `FW7_DIAGNOSTICS=fw7-diagnostics-v1`. With the gate off, `GET /v1/diagnostics/fw7` returns 404. It is served through the existing loopback Companion and accepts only its existing opaque Figma UI origin (`Origin: null`).
- The manifest requires explicit live-file/provider authorization and separate capture/external-transmission declarations. Collector validation blocks protected Test Shop / Phase 1 Storefront labels, provider activity without provider authorization, captures without capture consent, and review transmission without separate consent.
- The operator supplies the disposable file/page labels and hashed IDs; the collector does not inspect Figma files or call providers.

The local correlation hash is intentionally simple and non-cryptographic. Use generic disposable labels and do not put private content in notes. Plugin events have a null monotonic timestamp to preserve Figma sandbox compatibility; plugin duration fields use explicit `Date.now()` deltas and can be affected by wall-clock changes. Never calculate cross-process latency from these timestamps.

## Local collection

Run `npm run fw7:acceptance` for the CLI syntax. A later authorized capture can be validated with:

```powershell
npm run fw7:acceptance -- validate-events --manifest .\acceptance\manifest.json --events .\acceptance\events.json --out .\acceptance\collected.json
```

The collector does not overwrite an existing output file. Manifests and event exports should be stored only in an operator-chosen disposable acceptance folder.
