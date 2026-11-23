# FW-2 — Context, components and token grounding

This is FW-2 of the Figwright integration, not Product Roadmap Phase 2. The named standalone `Figwright_Integration_Roadmap_Figma_AI_Design_Engine.md` was not present in the repository/workspace. The checkout's FW-1 handoff and the requested FW-2 contract were used. FW-1's live comparison remains blocked and unperformed.

**Code complete / live pending** for the supported native subset described in the contract.

- The existing Chat routes authorized structure reads through a bounded Figma adapter. Universal create sends one validated projection to planning and screen composition; the existing edit controller can supply one additional read-only projection once the exact selected target is verified.
- Explicit create reuse can substitute a genuinely equivalent native component instance for a fixed decorative rectangle, or link compatible single solid paint fills to local styles/variables, without modifying a master or overriding planned colors.
- The existing renderer, executor adoption, geometry checks, readback and task checkpoint retain authority. No additional provider calls, dependency, runtime, storage or Figma transport was introduced.
- Internal gate: `VITE_FW2_CONTEXT=fw2-context-v1`, off by default. No Figma file was opened or written during implementation. Desktop and live provider acceptance are pending, and neither visual quality nor speed has been measured.

Initial gap: the renderer could use task-built masters/styles, but had no explicit-scope grounding or captured foreign-to-task local resource references. The first failing regression was `captures only the selected subtree without exposing layer names or text` in `tests/design-context.test.ts`: the production adapter did not exist; it passes with the adapter.

Diff scope: 15 modified tracked files, 11 new FW-2 files (5 source, 1 test, 5 docs). The tracked manifest, package/lockfile, Chat CSS, Companion entrypoints, DesignProgram schema, and FW-1 artifacts are unchanged. Manifest SHA-256 matches FW-1: `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A`.
