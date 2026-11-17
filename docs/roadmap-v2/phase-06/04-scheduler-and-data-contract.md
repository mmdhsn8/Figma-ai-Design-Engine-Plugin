# Scheduler and data contract

## Bounds

- Project plan: 1–10 contiguous stable screen IDs; plans above ten fail schema/intent validation.
- Active model requests per Universal task: 2 by default, configurable to 1 for serial fallback. Companion admits no more than two recognized Phase 6 screen streams globally and rejects duplicate active request IDs. Generic/Legacy Chat still admits one stream at a time.
- Per-screen composition attempts: 3; semantic repair: one repair pass and at most three bounded repair dispatches; schema corrections: at most 2. Existing task model-round and provider-request budgets still apply.
- Provider input per screen: 56 KiB. Serialized task checkpoint: 512 KiB. Native adopted nodes per task: 200. Recent trace: 128 events. Limits fail closed and retain saved sibling work.

## Dependency and ordering contract

`ProjectPlanV1.screens[].dependencies` is a strict DAG. A screen becomes schedulable only after all declared dependency programs have a durable `program_saved` or later checkpoint. Navigation links do not create a generation dependency unless the planner declares one. Independent screens may finish out of order; response IDs match screen IDs, while render and native readback iterate saved plan order. Native master/component registry and document mutations are never parallelized.

## Durable task manifest

`UniversalJobManifestV1` fingerprints engine route, task/model, plan fingerprint, DesignProgram version, platform, locale/direction, ordered screen IDs/dependencies, Brand Kit token and asset revisions/hashes, Skills revisions and layout capabilities. Existing Phase 5 tasks without this manifest are pinned additively from their already saved plan; mismatches stop before re-planning or native writes. Legacy tasks keep `executionRoute: legacy`.

Provider IDs derive from task and stage/screen/attempt; renderer/readback IDs derive from task and stable screen ID. Programs are stored before render dispatch. Figma acknowledgements require a unique root ref, batch ID, operation IDs, matching program fingerprint and exact node count. Resume reads verified roots rather than creating replacements. The renderer, page-order placement, and ownership protocol are unchanged.

Source contracts: `UniversalJobManifestV1Schema`, `UniversalDesignMetricsSchema`, `MAX_PROVIDER_INPUT_BYTES`, `CHAT_TASK_MAX_BYTES`, `MAX_TASK_NATIVE_NODES`, `UNIVERSAL_DESIGN_MAX_CONCURRENT_MODEL_CALLS`.
