# Phase 6 delivery

**CODE COMPLETE / LIVE PENDING**

Universal Chat can compose up to ten screens with a bounded model scheduler. Independent screens may compose two at a time; declared dependencies block downstream composition until the dependency's program is saved. Programs, native writes, readback, and final placement remain checkpointed and ordered. A provider-capacity response reduces the saved concurrency to one. Existing Phase 5 pending screen responses are consumed in place.

The existing Chat layout was not redesigned. New tasks still use Universal Engine by default; tasks retain their pinned route, model, project plan, Brand Kit, Skills, and native screen checkpoints. Legacy inference remains single-stream. No Figma document was changed.

The scripted local comparison showed lower median total time for three and ten screens; it is mock-only and is not evidence of provider or Desktop speed. Live acceptance is pending because no disposable file and account-visible model were authorized for writes.

Implementation changes are limited to:

- `src/ui/universal-design-task.ts` — bounded composition scheduling, per-request fencing, recovery and trace metrics.
- `src/ui/chat-task.ts`, `src/ui/App.tsx` — propagate the saved request identity, cancellation signal, current-task fence and configurable concurrency cap.
- `src/shared/universal-design.ts`, `src/shared/chat-task.ts` — versioned job manifest, trace/metrics contracts, checkpoint compatibility, sanitized diagnostics.
- `src/companion/server.ts` — up to two concurrent Phase 6 screen streams with duplicate-ID rejection; legacy chat requests remain exclusive.
- `tests/universal-design-chat.test.ts`, `tests/companion-server.test.ts` — timing, scheduler, cancellation, compatibility and failure regressions.

Evidence and the manual Desktop script are in [07-test-build-evidence.md](07-test-build-evidence.md) and [08-live-desktop-acceptance.md](08-live-desktop-acceptance.md).
