# Root cause

| Boundary | Evidence | Finding |
|---|---|---|
| Chat and provider | Prior incident screenshot and sanitized diagnostic | Structured route selected. The reported stage was identity. Actual provider section JSON is unavailable. |
| Normalization | `src/shared/design-generation.ts`, `parseGeneratedDesignResponse` and `repairTouchTargets` | The existing candidate expanded controls and could stack a crowded row. The candidate was discarded if the section exceeded its available height, exposing the original undersized controls to validation. A seven-control synthetic Persian toolbar reproduces this mechanism. Whether the exact live response had these dimensions remains unknown. |
| Pre-save and rendering | `src/ui/App.tsx`, `generateDesignFromBrief`; `src/shared/generation-draft.ts`, `validateDraftSection`; `src/plugin/renderer.ts`, `verifyNativeTouchTargets` | Local normalization precedes composition, bounded provider repair, durable save, and native apply. Native readback still verifies geometry. Prior horizontal clipping was a separate post-render incident. |
