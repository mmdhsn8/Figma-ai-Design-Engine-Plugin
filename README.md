# Figma AI Design Engine

Figma AI Design Engine is a local plugin for Figma Desktop. It reads a structured JSON design and creates editable native Figma layers from it. You can start with one of the included examples or write/import your own JSON, validate it, generate the design, and keep editing it in Figma.

The plugin name includes “AI,” but this version does not generate designs from text prompts. It uses the JSON design you provide and does not need an API key, cloud account, backend, or internet connection at runtime.

## What the plugin can do

- Create frames, text layers, and rectangles, including nested frames.
- Place children at explicit `x`/`y` coordinates or arrange them with Figma Auto Layout.
- Set colors, strokes, corner radii, text alignment, font family/style, and text sizing.
- Define reusable components and create linked instances of them.
- Validate the JSON and report errors before adding layers to the Figma document.
- Preserve existing page content and place each new design in a clear canvas area.
- Keep Persian and other Unicode text editable in Figma text layers. Font availability and complex right-to-left shaping depend on the local Figma environment.

The **Phase 1 sample**, **Phase 2 demo**, and **Phase 3 demo** buttons are examples in the same plugin, not separate programs. Phase 1 demonstrates a coordinate-based design. Phase 2 shows nested Auto Layout and linked components. Phase 3 adds an optional design-system section to schema 1.0.0.

## Requirements

- Windows 10 or 11
- Node.js 22.12 or newer and npm
- Figma Desktop

## Install the plugin in Figma

1. Download or clone this repository.
2. Open PowerShell in the project folder and install the dependencies/build the plugin:

   ```powershell
   npm install
   npm run build
   ```

3. Open a Figma Design file in Figma Desktop.
4. Choose **Plugins → Development → Import plugin from manifest…** and select this project's `manifest.json`.
5. Run **Figma AI Design Engine** from **Plugins → Development**.

The plugin is set up for local development and is not configured for publishing to the Figma Community.

## Use the plugin

1. Load **Phase 1 sample** for a small, positioned example, **Phase 2 demo** for the storefront, or **Phase 3 demo** for native styles, components, and token references.
2. To use your own design, click **Import JSON** to select a `.json` file, or paste/edit JSON in the editor. The import/editor limit is 1 MB.
3. Click **Validate JSON**. Fix any errors shown in the status area before continuing.
4. Click **Generate in Figma** for Phase 1/2 documents. For JSON containing `designSystem`, inspect its dry-run summary and click **Create / Update Design System**. The plugin creates native editable layers on the current page and focuses the new design in the viewport.
5. Edit the generated layers as usual in Figma. Running Generate again adds another design; it does not replace earlier results.

## JSON format

The plugin supports schema version `1.0.0`. A design has a `document` with a name, width, height, background color, and child layers. This example positions a card on the canvas and uses Auto Layout to arrange its contents:

```json
{
  "schemaVersion": "1.0.0",
  "document": {
    "name": "My first design",
    "width": 390,
    "height": 844,
    "background": "#F8FAFC",
    "children": [
      {
        "type": "frame",
        "name": "Content Card",
        "x": 24,
        "y": 40,
        "width": 342,
        "height": 180,
        "background": "#FFFFFF",
        "cornerRadius": 16,
        "layout": {
          "mode": "vertical",
          "gap": 12,
          "padding": { "top": 16, "right": 16, "bottom": 16, "left": 16 }
        },
        "children": [
          {
            "type": "text",
            "name": "Greeting",
            "text": "Hello, Figma!",
            "fontSize": 24,
            "color": "#123B5D"
          },
          {
            "type": "rectangle",
            "name": "Accent",
            "width": 80,
            "height": 8,
            "fill": "#2563EB",
            "cornerRadius": 4
          }
        ]
      }
    ]
  }
}
```

### Layer types and positioning

Supported child layer types are `frame`, `text`, `rectangle`, and `instance`. Frames can contain other layers. A frame or document can use an optional `layout` object to arrange its children horizontally or vertically using Auto Layout. Layout supports gap, padding, alignment, and child sizing (`fixed`, `hug`, or `fill`).

When a parent has no Auto Layout, each child needs both `x` and `y` coordinates. When a parent uses Auto Layout, omit child coordinates; their order and layout settings control placement. Colors use six-digit hex notation, such as `#123ABC`.

Text supports font family/style, font size, color, alignment, line height, resizing, and optional dimensions. The plugin asks Figma for the requested font and falls back to Inter Regular if that font is unavailable; the result reports font choices. Persian Unicode text is preserved, but full bidirectional text shaping is controlled by Figma and the selected font.

### Components and instances

Reusable legacy component definitions go in `document.components`; Phase 3 definitions can go in `designSystem.components` and must include a stable `key`. Add an `instance` layer with the matching `componentId` wherever the design should use that component. Generated component masters appear in a Components area beside the screen. Instances are native Figma instances and remain linked to their masters. Editing a master in Figma uses Figma's normal instance propagation. Component sets/variant properties and instance text overrides are not created by the plugin. The Phase 3 Button states are separate named masters (`primary`, `secondary`, and `disabled`) rather than a native component set.

### Phase 3 design systems

The optional `designSystem` property extends schema 1.0.0; older Phase 1/2 JSON remains valid without migration. The Phase 3 demo is version-controlled at `src/samples/phase-3-design-system.json` and includes the exact requested palette, typography, numeric scales and aliases, two border tokens, three button masters, a Product Card master, nested linked instances, and editable Persian preview text. It does not add a Figma Page.

Tokens use explicit references such as `{ "token": "color.brand.deepNavy" }`. Supported categories are `color.*`, `typography.*`, `spacing.*`, `radius.*`, and `border.*`. Spacing and radius scales expose stable `spacing.scale.N` and `radius.scale.N` references; named aliases can point to another token in the same category. Missing, cross-category, duplicate, cyclic, unsupported, and out-of-range references fail validation before Figma document mutation. Colors accept six-digit `#RRGGBB` only; alpha is not supported. Shadows/effects are intentionally unsupported. Design systems are limited to 200 tokens and the combined legacy plus Phase 3 component/node limits still apply.

The **Design System** panel shows the namespace, token/component counts, validation errors, and an estimated dry-run summary before writes. Creating a design system is a separate, explicit action. On import, the renderer resolves local fonts before creating any assets, creates/reuses owned resources, and rolls back newly created nodes/styles if rendering fails. Native styles and components carry private plugin metadata with stable IDs. Same-name unowned styles are never overwritten; generated style names receive a suffix if necessary. Styles are only updated when the user enables the checkbox and the stored fingerprint confirms the current style still matches the plugin's previous value. Manually changed styles are skipped. Existing component masters are reused and never rebuilt; a changed definition with the same key is reported as skipped. Use a new stable key to add a new version without disturbing instances or manual edits.

| Token/property                | Phase 3 output                                              | Figma binding                                                                                                | Fallback                                        |
| ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Colors                        | Local Paint Styles                                          | Fill and stroke style IDs where supported                                                                    | Resolved hex paint if style binding fails       |
| Typography                    | Local Text Styles                                           | Text style IDs for font fields; alignment stays on the editable text node; color uses a separate Paint Style | Resolved text properties if style binding fails |
| Spacing, radii, border widths | Resolved numeric values in Auto Layout and shape properties | No live variable binding in this release                                                                     | Always a numeric resolved value                 |
| Shadows/effects               | Unsupported                                                 | None                                                                                                         | Rejected by strict schema                       |

Figma's [Variables guide](https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma) lists variables as available on all plans; the [plan comparison](https://help.figma.com/hc/en-us/articles/360040328273-Compare-Figma-plans-and-features) shows Starter has no variable modes, while the Plugin API typings include local collection/variable APIs. This implementation deliberately does not create variable collections or claim live numeric bindings because it has not been exercised in the target Figma Desktop/Starter account. It uses native Paint/Text Styles and resolved numeric values instead. If local variable creation is enabled after Desktop acceptance, use only Starter's single default mode; extended collections and modes are not required.

The sample's primary/secondary/disabled buttons are separate native masters. Component properties and instance text overrides are not exposed, so changing product copy currently means editing the master or adding another keyed component definition.

### Validation limits

- Document, frame, and component dimensions: 1–10,000 px.
- Coordinates: −10,000–10,000 px.
- Maximum 500 total nodes, 50 component definitions, and 8 nested node levels.
- Text: up to 5,000 characters per text layer.
- Layout gap/padding: 0–1,000 px; corner radii: 0–5,000 px; stroke width: 0.25–100 px.
- JSON objects reject unsupported fields; the editor/import limit is 1 MB.

## Canvas organization

Each generation is placed as a cluster. If the design has components, its screen and component masters are kept together. New clusters are placed from left to right and wrap onto another row as needed, with at least 120 px of spacing. The default target row width is 6,000 px. These settings are centralized in `src/plugin/canvas-placement.ts`; an individual cluster wider than the target gets a row of its own. Row height uses the tallest actual cluster in that row, plus the gap.

Before rendering, the plugin reads document-space bounds for all direct children of the current page, including unrelated frames and other scene nodes. Bounds prefer Figma's `absoluteRenderBounds`, then `absoluteBoundingBox`, and use the transformed-corner AABB fallback if needed. Rotated objects reserve their conservative axis-aligned bounds. Descendants are covered by their top-level parent, so they are not counted twice. The planner finds the first row-major slot that clears those obstacles and all previous generated clusters. It plans from intended dimensions before creating nodes, then measures and corrects the full generated cluster if its actual bounds differ. Only the new cluster root can move; existing content and internal child coordinates remain unchanged.

The plugin adds generated screens to the current Figma Page; it does not create a page per screen. Each single-cluster placement uses O(n log n) time and O(n) temporary memory for n top-level obstacles. Batch planning repeats the bounded row query per item. Old vertically stacked Phase 2.1 clusters are left in place; horizontal placement applies to new generations only.

### Windows / Figma Desktop acceptance

Automated tests use a mocked Figma API and do not verify the real canvas. After `npm run build`, reload the development plugin in Figma Desktop and confirm:

1. Generate the Phase 2 demo six times; verify the clusters appear horizontally and wrap at the configured row width.
2. Confirm at least 120 px of clearance between cluster bounds, including component masters.
3. Put a large unrelated frame in the next available slot and generate again; confirm the new cluster avoids it.
4. Generate valid mobile and desktop designs with different heights; check wrapped-row height.
5. Confirm old content is unchanged, Auto Layout remains editable, component instances stay linked, and the viewport focuses the newest design.
6. If practical, repeat with 100+ frames and check responsiveness.

Phase 2.2 remains pending until these checks pass in Figma Desktop and the user confirms them.

## Limitations

- The plugin creates designs from JSON; it does not create a design from a natural-language prompt.
- Full right-to-left/bidirectional shaping, component variants, configurable component properties, and instance overrides are not implemented.
- Rotated nodes reserve their full axis-aligned envelope, which may leave extra space. Figma render bounds may omit editor-only effects; geometric bounds are used when render bounds are unavailable.
- The 6,000 px row width is a layout target rather than a hard canvas limit. Existing Phase 2.1 clusters are not rearranged automatically.
- Numeric design-system tokens are resolved values and do not update through Figma Variables. Shadow/effect tokens, native component sets, variant properties, instance text overrides, multi-screen orchestration, advanced responsive rules, prototyping links, and publishing workflows are outside the current scope.
- Font appearance and some text shaping depend on fonts installed and available to Figma Desktop.

## Build and development

The production build writes `dist\plugin.js` and `dist\ui.html`, which are referenced by `manifest.json`. No development server is needed to use the production build. To run the local development workflow, use:

```powershell
npm run dev
```

After a rebuild, close the running development plugin, rebuild, then rerun it from **Plugins → Development** in Figma Desktop. If the UI still shows an older bundle, use **Plugins → Development → Import plugin from manifest…** again with this repository's `manifest.json`. Project checks are available with:

```powershell
npm run typecheck
npm run lint
npm run test
npm run format:check
```

Runtime dependencies are React, React DOM, and Zod. Other project dependencies are used for development and building. The manifest disables network access, so the plugin has no runtime network calls or paid service dependencies.

### Phase 3 Windows / Figma Desktop acceptance

These manual checks are pending; automated tests use mocked Figma APIs and do not verify real styles, variable access, component propagation, font rendering, or RTL display. After a clean build, close and reopen/reload the development plugin, then:

1. Generate the Phase 1 sample and Phase 2 demo; check existing behavior.
2. Import or load `phase-3-design-system.json`, validate it, and review the dry-run counts before clicking **Create / Update Design System**.
3. Confirm native Paint Styles, Text Styles, Button masters, and Product Card master appear in the current file.
4. Confirm preview and nested component instances stay linked; edit a master and verify Figma updates its instances.
5. Change a bound Paint/Text Style and check linked preview layers. Spacing/radius values should be described as resolved values, not variable bindings.
6. Re-import the demo twice; check that owned styles and component masters do not multiply.
7. Change an unrelated user style and frame, then re-import; confirm both are untouched. Also edit an owned style and confirm the default import skips it; test the explicit update checkbox only on an unmodified owned style.
8. Generate several previews; confirm the Phase 2.2 horizontal-first 120 px placement avoids existing content.
9. Inspect Persian text visually, confirm it is editable, and check alignment with the chosen font.
10. Try an invalid token reference and a missing font; confirm validation/fallback is clear and existing file content remains intact.
11. Verify the target Starter account can access the local Variables view and whether the plugin may create a single-mode local collection before enabling variable writes in a later change.

The user reports that Phase 2.2 manual testing was done, but the individual pass/fail results have not been stated in this thread. Phase 2.2 and Phase 3 remain pending manual acceptance until those results are confirmed.
