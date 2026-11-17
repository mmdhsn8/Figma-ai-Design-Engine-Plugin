# Phase 5 delivery

**CODE COMPLETE / LIVE PENDING**

Universal Chat renders through the existing adapter and renderer. It now checks native subtree geometry, checks ownership before adopting, compares a saved receipt on fresh readback, and can grow an undersized inner scroll body without changing the viewport. The renderer applies explicit Auto Layout size bounds and horizontal wrap, retains the user's selection on this route, and checks proposed placement against current canvas occupancy.

Universal Chat supports fixed-size local component declarations and validates each new instance against its actual native master. The text path preserves mixed Persian and English characters and selects script-aware fallback through Figma's font APIs. Native readback checks the text box, truncation, missing font and measurable paint bounds. The plugin API exposes no per-glyph shaping result. Visual glyph, bidi and scroll acceptance remain pending in Desktop.

Planning attempts are durable before provider dispatch. Resume validates program fingerprints before model or canvas work, revalidates fully built pending roots in place, and uses the existing task ledger for committed roots. Unknown or visibly incomplete native work is retained and reported as a conflict. Native and provider retry budgets remain bounded.

Changed implementation files:

- Shared: `native-geometry.ts`, `program-text.ts`, `schema.ts`, `design-program.ts`, `design-program-adapter.ts`, `messages.ts`, `universal-design.ts`, `chat-tools.ts`.
- Plugin: `design-program-geometry.ts`, `design-program-spike.ts`, `renderer.ts`, `figma-tool-executor.ts`, `main.ts`.
- UI coordinator: `src/ui/universal-design-task.ts`.
- Tests: `tests/native-geometry.test.ts`, `tests/figma-mock.ts`, `tests/universal-design-chat.test.ts`.

The Phase 6 gate is described in [09-phase-06-handoff.md](09-phase-06-handoff.md).
