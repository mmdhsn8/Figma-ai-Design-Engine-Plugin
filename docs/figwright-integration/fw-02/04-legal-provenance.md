# Legal provenance

Figwright v0.8.0, pinned commit `458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca`, matches FW-1's baseline and source evidence. Inspected at that exact SHA (not `main`):

- [skills/figma-build/SKILL.md](https://github.com/awdr74100/figwright/blob/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/skills/figma-build/SKILL.md): read reusable primitives before constructing and verify via readback.
- [packages/mcp/src/tools/get-design-context.ts](https://github.com/awdr74100/figwright/blob/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/packages/mcp/src/tools/get-design-context.ts): depth limits, bounded shape and explicit truncation. FW-2 intentionally does not expose its raw text or unlimited mode.
- Under [`packages/plugin/src/handlers/`](https://github.com/awdr74100/figwright/tree/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/packages/plugin/src/handlers), inspected `get-design-context.ts` (selection and pre-serialization budget), `get-selection.ts` (current page selection), `get-local-components.ts` (scoped component/set discovery), and `get-styles.ts` / `get-variable-defs.ts` (file-local Plugin API collections). FW-2 uses its own bounded walk and does not copy the full definition responses.
- [packages/plugin/src/handlers/create-instance.ts](https://github.com/awdr74100/figwright/blob/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/packages/plugin/src/handlers/create-instance.ts): actual native `createInstance` from a verified local ID, with a separate upstream import path that FW-2 did not adopt.
- [LICENSE](https://github.com/awdr74100/figwright/blob/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/LICENSE): MIT, copyright 2026-present Roya.

Original local implementation; no upstream code, plugin, npm package or third-party dependencies copied, installed or executed. No new third-party notices apply. If upstream source is ever copied, retain the upstream MIT notice and review the copied material and its dependencies.
