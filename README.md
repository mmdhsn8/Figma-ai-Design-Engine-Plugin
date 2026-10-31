# Figma AI Design Engine

Figma AI Design Engine is a local plugin for Figma Desktop that turns a JSON design description into editable Figma layers. It can create frames, text, rectangles, Auto Layout, components, and component instances. Use the built-in examples to see what it can make, or import and edit your own JSON design.

The plugin validates your JSON before creating anything. Generated content stays in your Figma file, where you can continue editing it like any other design. The plugin does not require an AI prompt, API key, cloud account, backend, or internet connection at runtime.

## Quick start

### Requirements

- Windows 10 or 11
- Node.js 22.12 or newer and npm
- Figma Desktop

### Install the plugin in Figma

1. Download or clone this repository, then open PowerShell in the project folder.
2. Install the project dependencies and build the plugin:

   ```powershell
   npm install
   npm run build
   ```

3. Open a Figma Design file in Figma Desktop.
4. In Figma, choose **Plugins → Development → Import plugin from manifest…** and select this project's `manifest.json` file.
5. Run **Figma AI Design Engine** from **Plugins → Development**.

### Generate your first design

1. In the plugin, click **Phase 2 demo** to load a sample storefront. **Phase 1 sample** loads a smaller example.
2. Click **Validate JSON**. If there are errors, read the messages and fix the JSON in the editor.
3. Click **Generate in Figma**. The plugin creates editable layers on the current page and moves the viewport to the new design.
4. Select the generated frames, text, or components on the canvas and edit them in Figma. You can generate again; each run adds a new cluster without replacing earlier results.

### Use your own design JSON

1. Prepare a JSON design that follows [schema version 1.0.0](#json-schema-100).
2. Click **Import JSON** to load a `.json` file, or paste the JSON into the editor. You can also start with a sample and edit its contents.
3. Click **Validate JSON** and correct any reported issues.
4. Click **Generate in Figma** to add the design to the current page.

At a minimum, a design JSON has a `schemaVersion` of `1.0.0` and a `document` containing a name, width, height, and children. For example:

```json
{
  "schemaVersion": "1.0.0",
  "document": {
    "name": "My first design",
    "width": 390,
    "height": 844,
    "children": [
      {
        "type": "text",
        "name": "Greeting",
        "text": "Hello, Figma!",
        "x": 24,
        "y": 40,
        "fontSize": 28,
        "color": "#123B5D"
      }
    ]
  }
}
```

The full list of supported node types, layout fields, sizing rules, limits, and component behavior is described in the [JSON schema](#json-schema-100) section below.

## Build and development

The production build writes `dist\plugin.js` and `dist\ui.html`, which are referenced by `manifest.json`. No development server is needed to use the production build. For local development, run `npm run dev`; after rebuilding, reload or rerun the development plugin in Figma Desktop.

Useful project checks are:

```powershell
npm run typecheck
npm run lint
npm run test
npm run format:check
```

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

The demo includes native `Button / Primary` and `Product Card / Basic` components. The product-card master contains a button instance, and the storefront contains a product-card instance. Generated masters appear in a named Components area in the same generated canvas cluster as the screen. Component dependencies are created before their consumers. Repeated runs create separately named results and do not replace existing layers. Instance property overrides and variants are outside this MVP; edit a master to update linked instances.

## Canvas placement

Each run is rendered as one cluster, including the root screen and its generated component area. The planner places clusters left-to-right, then wraps to the next row when the next cluster would exceed the configured maximum row width. Defaults are a 120 Figma-pixel gap and a 6,000 px row width, centralized in `src/plugin/canvas-placement.ts`. A cluster wider than the row limit is allowed on its own row so valid large designs remain placeable. Row height comes from the tallest actual cluster in that row, plus the configured gap.

Before rendering, the plugin snapshots the current page's direct children and their document-space visual bounds. It finds the first row-major slot that clears all existing bounds, including unrelated top-level objects. The screen and component area are one measured collision region. If that component area needs more width than its default, it expands to contain its widest master. Old vertically stacked Phase 2.1 clusters remain where they are; the horizontal policy applies only to newly generated clusters.

Bounds prefer Figma's `absoluteRenderBounds`, then `absoluteBoundingBox`, with a transformed-corner AABB fallback. Rotated objects use conservative axis-aligned page-space boxes. Only direct page children are obstacles; descendants are covered by their top-level parent's bounds and are not double-counted. Placement is planned from intended dimensions before rendering, then checked against the full measured cluster. Only the new cluster root can move during correction, preserving child coordinates and Auto Layout. Existing content is never repositioned. The viewport focuses the completed cluster. The planner is pure TypeScript and has no Figma document side effects.

The plugin keeps one Figma Page and adds generated screen frames and component masters as ordinary canvas nodes. It does not create a page per screen. Each single-cluster placement expands obstacles once and sorts relevant horizontal intervals, taking O(n log n) time and O(n) temporary memory for n top-level obstacles. Batch planning repeats that bounded row query for each requested cluster. The search advances through at most a number of rows proportional to the blocking bounds and reports an actionable error for invalid, overflowing, or unrepresentable geometry.

## Verification

Automated tests use a mocked Figma API. They cover Phase 1 parsing/rendering compatibility, recursive schema and limits, Auto Layout mapping and constraints, font loading/fallback, native component/instance creation, error cleanup, repeated generation names, Persian/mixed-script text, visual properties, UI/controller message shapes, and canvas placement geometry. Placement coverage includes repeated and batch generations, 500 mixed-size clusters, negative coordinates, irregular and rotated obstacles, boundary spacing, and 100, 250, and 500 page obstacles. They do not launch Figma Desktop or verify its actual font rendering and canvas appearance.

### Manual Figma Desktop acceptance steps

1. In PowerShell at the project folder, run `npm install` and `npm run build`.
2. In Figma Desktop, open **Plugins → Development → Manage plugins**, then reload the imported plugin (or import `manifest.json` again if it is not listed). Run **Figma AI Design Engine** from **Plugins → Development**.
3. Generate the **Phase 2 demo** six times. Confirm new clusters appear side-by-side and wrap when the configured row width is reached.
4. Verify at least 120 px clearance between neighboring cluster bounds, including component masters.
5. Place a large unrelated frame in the next available slot and generate again; confirm collision avoidance.
6. Generate a mix of desktop and mobile JSON and check that wrapped rows use the tallest cluster's height.
7. Confirm old screens and unrelated nodes have not moved or changed, Auto Layout remains editable, instances remain linked, and the viewport focuses the latest generation.
8. If practical, repeat in a test file with 100+ frames and check overlap avoidance and responsiveness.
9. Import invalid JSON and confirm validation blocks generation without adding partial layers.

Phase 2.2 is not accepted until these checks pass in Figma Desktop and the user confirms the manual results. Automated tests do not replace desktop verification.

## Known limitations

- No full RTL/bidirectional shaping control; font coverage and mixed-script rendering vary with the local Figma font environment.
- Unavailable requested fonts fall back to Inter Regular. If Figma cannot load Inter either, generation stops before document changes.
- Component variants, configurable component properties, and instance overrides are not implemented.
- Rotated nodes use conservative axis-aligned bounds, so a rotated object's free corners can reserve extra canvas space. Figma render bounds do not include every possible editor-only effect; geometric bounds are used when render bounds are unavailable.
- The row width is a configurable target, not a hard canvas boundary: a single cluster wider than the configured width occupies a row by itself. Existing Phase 2.1 rows are not automatically rearranged.
- Responsive breakpoint generation, multiple-screen generation, tokens/variables, prototyping, AI prompts, publishing, and remote services are out of scope.
- Manual Figma Desktop import, generation, and visual verification are still required; mocked API tests do not prove desktop behavior.

## Dependencies

Runtime dependencies are React, React DOM, and Zod. Vite, TypeScript, Vitest, ESLint, Prettier, Figma typings, and their transitive packages are development-only. There are no paid dependencies, external services, or runtime network calls.
