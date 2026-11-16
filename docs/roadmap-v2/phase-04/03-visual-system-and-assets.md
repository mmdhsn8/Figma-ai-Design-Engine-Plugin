# Phase 4 — Visual System and Assets

## Shared visual decisions

The project plan now carries one `ProjectVisualLanguageV1` used by every screen. It covers semantic color roles, light/dark mode, density, locale-aware rationale, heading/body fonts, four type sizes, a bounded spacing scale, radii and navigation model. The default is a restrained light product system; fresh plans can supply a different valid language. A deterministic seed is derived from task ID and screen ID so the model has a stable variation input without making screen topology identical.

The native adapter applies semantic page/surface colors, type-role font sizes, heading/body font families and role-based radii to existing editable Figma nodes. It retains the existing token system and maps composition metadata into native screen metadata. The safe counter-axis adapter mapping avoids requesting `stretch` when children do not fill that axis.

## Brand Kit and Skills

The Universal planner/composer receives task-pinned Brand Kit metadata and the existing task-pinned Skills context. Brand colors, fonts, spacing and radii feed the shared language when the user has not supplied an explicit override. Tests exercise a primary-color override while keeping the other pinned brand choices.

The compose path can select only asset IDs available in its pinned Brand Kit capability. Plugin storage verifies that each requested ID belongs to the task’s pinned revision and that its stored content hash still matches. Only requested assets are resolved. The total resolved visual-asset bundle is limited to 700 KiB. Native rendering uses the existing editable image fill route; a renderer-instance cache reuses image hashes within the plugin API lifetime and is capped at 16 entries.

If bytes are unavailable during UI preflight, the adapter produces an honestly labeled “Pinned asset” placeholder. Other unresolved assets are labeled “Placeholder”; neither is described as photography. Safe SVG paths remain bounded by the existing expansion budget (at most 32 paths per asset). Remote URLs and unpinned assets are rejected.

## Limits

Skills are generation context, not a new style compiler. There is no automated judgment that a palette is aesthetically appropriate, that a font is installed or shaped correctly by the host, or that an image crop is suitable. Those require actual Figma Desktop inspection. Native component/instance reuse is not added to the DesignProgram contract in this phase.
