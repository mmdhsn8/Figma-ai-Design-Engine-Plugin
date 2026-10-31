# Figma AI Design Engine — Phase 2 MVP

A local Figma Desktop plugin that validates a versioned JSON design spec and creates editable native Figma frames, text, rectangles, Auto Layout, components, and instances. The React UI only edits and validates JSON; the plugin controller creates document nodes. The manifest disables network access, and the plugin uses no API key, backend, paid service, or runtime network dependency.

## Requirements

- Windows 10 or 11
- Node.js 22.12 or newer and npm
- Figma Desktop

## Install and build

Open PowerShell in this project folder:

```powershell
npm install
npm run typecheck
npm run lint
npm run test
npm run build
npm run format:check
```

The production build writes `dist\plugin.js` and `dist\ui.html`, referenced by `manifest.json`. The UI bundle embeds React; `plugin.js` is the Figma controller. No development server is needed to use the production build.

For local development, run `npm run dev`. After a rebuild, reload or rerun the development plugin in Figma Desktop.

## Import into Figma Desktop

1. Run `npm install` and `npm run build`.
2. Open a Figma Design file in Figma Desktop.
3. Choose **Plugins → Development → Import plugin from manifest…** and select this project's `manifest.json`.
4. Run **Figma AI Design Engine** from **Plugins → Development**.
5. Use **Phase 1 sample** to check the legacy payload, or **Phase 2 demo** for the storefront.

The manifest ID is a local-development placeholder. The plugin is not configured for publishing.

## JSON schema 1.0.0

Phase 2 extends the existing `1.0.0` payload. Legacy documents with positioned root children remain valid. The root `document` has a name, width, height, background, children, and optional `layout` and `components`. Node types are `frame`, `text`, `rectangle`, and `instance`. Component definitions live in `document.components`, keyed by stable `id`; instances refer to those IDs with `componentId`. Objects reject unknown fields.

All colors use six-digit hex such as `#123ABC`; `#RGB` is not supported. Dimensions must be from 1 to 10,000 px. Coordinates may be from −10,000 to 10,000 px. Layout gaps and padding must be from 0 to 1,000 px. Strokes must be from 0.25 to 100 px. Corner radii must be from 0 to 5,000 px. Text is limited to 5,000 characters. A document may contain at most 500 nodes, 50 component definitions, and 8 nested node levels. The JSON editor/import limit is 1 MB.

### Layout and sizing rules

| JSON field                      | Accepted values                                 | Figma mapping                                           |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `layout.mode`                   | `horizontal`, `vertical`                        | `layoutMode: HORIZONTAL`, `VERTICAL`                    |
| `primaryAxisAlign`              | `start`, `center`, `end`, `space-between`       | `MIN`, `CENTER`, `MAX`, `SPACE_BETWEEN`                 |
| `counterAxisAlign`              | `start`, `center`, `end`, `baseline`, `stretch` | `MIN`, `CENTER`, `MAX`, `BASELINE`; see stretch below   |
| `gap`                           | nonnegative number                              | `itemSpacing`                                           |
| `padding.top/right/bottom/left` | nonnegative numbers                             | Matching Figma padding properties                       |
| `sizing.width/height`           | `fixed`, `hug`, `fill`                          | `layoutSizingHorizontal/Vertical: FIXED`, `HUG`, `FILL` |

`counterAxisAlign: "stretch"` uses Figma's supported child `layoutAlign: "STRETCH"` and `FILL` sizing on the counter axis. Figma has no `STRETCH` value for `counterAxisAlignItems`; the container uses `MIN` for that property. FILL requires an Auto Layout parent and cannot fill an axis the parent sizes as HUG. HUG is supported for text, Auto Layout frames, and instances whose master uses Auto Layout. Baseline alignment is limited to horizontal layouts. Optional sizing defaults to HUG/HUG for text and FIXED/FIXED for other children; a parent's `stretch` behavior fills the child's counter axis unless an incompatible explicit sizing is supplied.

If a parent has no `layout`, its children need both `x` and `y`. Children of Auto Layout parents omit `x` and `y`; Figma's Auto Layout controls their placement. Frames and component definitions keep explicit width and height as their initial/fixed dimensions. Text with explicit `fixed` sizing needs the corresponding width or height.

### Fonts and Persian text

The renderer asks Figma for available fonts, loads each requested family/style before creating nodes, and uses the exact font when available. If Figma cannot resolve or load it, the renderer falls back to Inter Regular and reports both the requested and chosen font in its result. The demo requests Arial for Persian text; availability depends on the local Figma/Windows font list.

Persian Unicode, punctuation, and numerals are kept in editable text nodes. Right alignment and child order support practical RTL-oriented layouts. The Figma Plugin API does not expose full bidirectional text-engine controls, so mixed-script shaping and complex RTL behavior depend on Figma and the selected font.

### Components

The demo includes native `Button / Primary` and `Product Card / Basic` components. The product-card master contains a button instance, and the storefront contains a product-card instance. Generated masters appear in a named Components area beside the 390 × 844 screen. Component dependencies are created before their consumers. Repeated runs create separately named results and do not replace existing layers. Instance property overrides and variants are outside this MVP; edit a master to update linked instances.

## Verification

Automated tests use a mocked Figma API. They cover Phase 1 parsing/rendering compatibility, recursive schema and limits, Auto Layout mapping and constraints, font loading/fallback, native component/instance creation, error cleanup, repeated generation names, Persian/mixed-script text, visual properties, and UI/controller message shapes. They do not launch Figma Desktop or verify its actual font rendering and canvas appearance.

### Manual Figma Desktop acceptance steps

1. Rebuild with `npm run build`, then reopen or reload the development plugin in Figma Desktop.
2. Load **Phase 1 sample** and verify the legacy document still generates as a 390 × 844 frame.
3. Load **Phase 2 demo**, choose **Validate JSON**, and generate it.
4. Inspect nested frames in the right sidebar and confirm their native Auto Layout properties are present and editable.
5. Edit the Persian heading, price, and button label in Figma.
6. Inspect the Layers panel and confirm the Components area contains both masters and the screen/card contain linked instances.
7. Edit a master and confirm its instance updates where applicable.
8. Generate again and confirm prior designs remain intact with a new name.
9. Import invalid JSON and confirm validation blocks generation without adding partial layers.

Phase 2 is not accepted until these checks pass in Figma Desktop, including the user's confirmation that Persian content and linked components behave correctly.

## Known limitations

- No full RTL/bidirectional shaping control; font coverage and mixed-script rendering vary with the local Figma font environment.
- Unavailable requested fonts fall back to Inter Regular. If Figma cannot load Inter either, generation stops before document changes.
- Component variants, configurable component properties, and instance overrides are not implemented.
- Responsive breakpoint generation, multiple-screen generation, tokens/variables, prototyping, AI prompts, publishing, and remote services are out of scope.
- Manual Figma Desktop import, generation, and visual verification are still required; mocked API tests do not prove desktop behavior.

## Dependencies

Runtime dependencies are React, React DOM, and Zod. Vite, TypeScript, Vitest, ESLint, Prettier, Figma typings, and their transitive packages are development-only. There are no paid dependencies, external services, or runtime network calls.
