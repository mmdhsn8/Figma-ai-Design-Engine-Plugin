# FW-4 — Optional Desktop acceptance

**State: LIVE PENDING.** No Figma Desktop document was opened or modified in this implementation.

## Build variants

Use only a newly created disposable test file or separately authorized copies. Do not use `Test Shop — Phase 1 Storefront` or any existing user document. Record the source file and copied file IDs before starting.

From the actual project directory, build gate off:

```powershell
Remove-Item Env:VITE_FW4_GEOMETRY -ErrorAction SilentlyContinue
npm run build
```

Build a separate gate-on plugin artifact:

```powershell
$env:VITE_FW4_GEOMETRY = 'fw4-geometry-v1'
npm run build
```

Install/reload the matching build before each experiment. Keep the off and on runs in separate clean disposable files (or restore from separate clean copies). Do not mix the two paths in one already-mutated file.

## Minimum run and evidence

1. Run the same synthetic F1 Persian RTL screen with gate off and on. Record Figma Desktop version, plugin artifact/build hash, flag, task ID, program fingerprint/revision, page ID and exact native root ID.
2. Inspect the same native screen in Layers and with task-native readback. Record actual parent IDs, node types, `layoutSizingHorizontal`, `layoutSizingVertical`, text `textAutoResize`, actual frame/text bounds, scroll/clip values, fonts loaded and the final task checkpoint status.
3. Capture redacted screenshots at 100% for the full screen and any wrapping/scroll area. Check Persian joining, mixed Persian/English ordering, Persian/Arabic digits, long words, multiline copy, clipping, Auto Layout spacing and editability. A screenshot is visual evidence, not a substitute for numeric readback.
4. Repeat with the F3 flow, including a long announcement or form. Only after F1/F3 are clean, repeat F10. Compare root IDs, duplicates, native readback findings, render/readback dispatches and wall-clock durations. Do not claim improvement from a single run.
5. Confirm unrelated preexisting test-file layers are unchanged by comparing the saved baseline/root list and task ownership. Confirm Stop and Resume retain original task-owned IDs and do not create another root.
6. For a controlled readback fault, only if the normal UI can safely leave the task at a `rendered` but not yet `verified` checkpoint: in the disposable file, change one task-owned child sizing mode from its planned value, resume/inspect that same task, and confirm it stays unverified and retains the same root. Restore the one property manually. If the normal UI does not expose this safe checkpoint window, skip this manual fault; do not edit stored checkpoints or inject code into a user document. The deterministic sizing-reset fault remains covered only by the local fake-runtime suite.

Acceptance requires complete readback and checkpoint confirmation, the expected native sizing and parent relationships, correct editable Persian/RTL text, no unrelated edits, and no root deletion/recreation. Record any mismatch as failing evidence; do not suppress the finding to complete a run.

## Not yet observed

Figma Desktop API behavior under sibling reflow, actual glyph shaping, real screenshot geometry, Stop timing, native readback wall time and live A/B comparison are all unverified. The local benchmark in `04-local-before-after-metrics.json` must not be quoted as a Desktop result.
