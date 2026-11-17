# Phase 7 handoff

Phase 6 implementation, local fault tests, builds and manifest verification are complete. Live provider/Desktop acceptance remains a release gate documented separately in [08-live-desktop-acceptance.md](08-live-desktop-acceptance.md); it is not a missing scheduler feature.

The next roadmap work can focus on intelligent in-place editing across multiple planned screens: infer a user-requested scope from the existing task manifest, update only affected DesignProgram nodes, preserve component masters/overrides and untouched roots, then verify before/after native snapshots. Keep Legacy tasks and route pins intact. Do not reopen the completed Phase 6 scheduling bounds, native transaction protocol, checkpoint schema or Chat appearance without new evidence.
