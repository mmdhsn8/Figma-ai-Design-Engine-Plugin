# Figma AI Design Engine

Figma AI Design Engine is a local plugin for Figma Desktop. It reads a structured JSON design and creates editable native Figma layers from it. You can start with one of the included examples or write/import your own JSON, validate it, generate the design, and keep editing it in Figma.

The plugin can render JSON fully offline. A gated Phase 4.6 proof of concept adds an optional local companion for ChatGPT sign-in and a user-triggered authorization smoke test; it does not yet generate designs from natural-language prompts. The companion makes internet requests only after the user initiates sign-in, model discovery, or the smoke test.

## What the plugin can do

- Create frames, text layers, and rectangles, including nested frames.
- Create ellipses, editable vector paths, gradients, strokes, shadows/blur, clipping, opacity and native image fills.
- Place children at explicit `x`/`y` coordinates or arrange them with Figma Auto Layout.
- Set colors, strokes, corner radii, text alignment, font family/style, and text sizing.
- Define reusable components and create linked instances of them.
- Validate the JSON and report errors before adding layers to the Figma document.
- Preserve existing page content and place each new design in a clear canvas area.
- Keep Persian and other Unicode text editable in Figma text layers. Font availability and complex right-to-left shaping depend on the local Figma environment.
- Phase 4.6 proof of concept: optional local browser sign-in and direct plan-use smoke test; natural-language design generation is held behind live acceptance.

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

1. Load **Phase 1 sample** for a small, positioned example, **Phase 2 demo** for the storefront, **Phase 3 demo** for native styles/components, or **Visual demo** for native editorial visuals and the 10-screen Persian storefront.
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

## Phase 4 multi-screen generation

Phase 4 adds an optional batch document shape while keeping `schemaVersion: "1.0.0"` and all earlier single-design JSON unchanged. Use `src/samples/phase-4-multi-screen.json` from the **Phase 4 demo** button, or import/paste a JSON document with this structure:

```json
{
  "schemaVersion": "1.0.0",
  "id": "storefront-app",
  "name": "Storefront App",
  "screens": [
    {
      "id": "home",
      "name": "Home",
      "group": "Shopping",
      "order": 20,
      "devicePreset": "mobile",
      "width": 390,
      "height": 844,
      "background": "#F8FAFC",
      "layout": {
        "mode": "vertical",
        "gap": 16,
        "padding": { "top": 24, "right": 20, "bottom": 24, "left": 20 }
      },
      "children": [
        {
          "type": "text",
          "name": "Title",
          "text": "صفحهٔ خانه",
          "fontSize": 24,
          "color": "#0F172A"
        }
      ]
    }
  ]
}
```

`designSystem` and batch-level `components` are optional and shared across the batch. Each screen is itself the root frame; its `children` and optional `layout` use the existing Phase 1–3 node schema. Screens support a stable `id`, safe display `name`, optional `group`, integer `order`, informational `devicePreset` (`mobile`, `tablet`, `desktop`, or `custom`), 1–10,000 px dimensions, optional background and up to 20 primitive metadata fields. Names and IDs are unique within the batch. Ordering is deterministic: group name, then `order`, then ID; RTL text direction does not affect canvas order. JSON remains schema version 1.0.0.

### Import and generate

1. Load **Phase 4 demo** or click **Import JSON** / paste a batch document.
2. Review validation messages; paths identify the failing screen and field. The preview lists screen IDs, names, groups, device presets and dimensions, plus a dry-run node estimate and the shared Design System reuse policy.
3. Set **Minimum gap** and **Target row width** if needed (defaults: 120 px and 6,000 px; accepted ranges: 0–1,000 px and 390–20,000 px).
4. Click **Generate all screens**. The controller reports per-screen started/generated/failed progress and a final actual node count. Per-screen tree creation is rolled back if that screen fails; already completed screens remain. This is deliberately not presented as an all-or-nothing document transaction. If every screen fails, newly created shared assets are cleaned up when safe.
5. The import always creates new screen frames rather than updating prior generated screens. Shared plugin-owned styles/components are resolved once and reused through Phase 3 ownership metadata. Existing screens, styles, frames, and unrelated content are left in place. The component master area is placed as another member of the planned batch.

The planner preserves Phase 2.2 horizontal-first row packing and expands existing page-level bounds by the configured gap. It plans the full batch before mutation, uses the mixed screen dimensions and master-area bounds, then checks actual created frame bounds. A changed actual screen size causes later screens to be replanned around the canvas as it now exists. New content is placed on the current Figma Page; it does not make a Page per screen or require a paid plan. The viewport focuses the first generated screen in logical batch order. Progress is delivered screen by screen, but an active generation cannot currently be cancelled.

### Limits and re-import behavior

- At most 100 screens and 5,000 estimated native nodes per batch (shared component definitions are counted once). Each screen tree supports the legacy schema's 500-node and 8-level limits.
- Screen dimensions: 1–10,000 px. The JSON file/editor limit remains 1 MB. Screen names are 1–100 characters and reject path separators/control characters.
- Device presets are descriptive metadata; Phase 4 does not apply responsive rules or generate variants for other sizes.
- The node estimate includes roots, shared component trees and the component-area container when definitions are present. Figma creates styles as document assets, and reuse or API-specific node details can make the final count differ; the final report is the actual count from the plugin's node tracker.
- Components remain native linked instances and styles follow the Phase 3 registry and fallback rules. Persian text remains editable; full bidirectional shaping and responsive behavior are not promised.

### Phase 4 Windows / Figma Desktop acceptance

These checks are **pending**; automated tests use a mocked Figma API and do not establish real Figma Desktop behavior. After `npm run build`, close the running development plugin and reload it from this repository's `manifest.json` in Figma Desktop. Then:

1. Load `phase-4-multi-screen.json`, validate, inspect the 10-screen preview and node estimate, then generate all screens. Confirm 10 top-level screen frames and a shared Generated Components area.
2. Inspect each screen and its nested frames/text/rectangles in the Layers panel; edit text and Auto Layout to confirm native editability.
3. Confirm the Button and Product Card instances remain linked to their component masters. Change a master and check Figma's normal instance propagation.
4. Inspect Paint/Text Style bindings and the resolved numeric spacing/radius fallbacks from Phase 3.
5. Confirm horizontal reading order, the configured gap, and wrapping after lowering row width; check mixed mobile/tablet dimensions and taller screens.
6. Place an unrelated frame/component near the available canvas region, generate again, and confirm it is not moved or overlapped.
7. Generate the same batch again; confirm new screens are added and previous screen coordinates/edits remain unchanged while shared owned styles/components are reused.
8. Inspect Persian text rendering, alignment and editability in Figma Desktop.
9. Cause one screen to fail with a valid but unavailable font or document issue where practical; confirm that screen's partial tree is removed and other outcomes are accurately reported.
10. If practical, use a test file with 100+ existing frames and a 100-screen batch; inspect non-overlap and responsiveness.

Phase 2.2 and Phase 3 Desktop checks have also not been confirmed with itemized results in this thread. Phase 4 is implemented, but its manual acceptance and those earlier manual gates remain pending until the user confirms them.

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

## Phase 4.5 visual design and quality preflight

Phase 4.5 adds optional, schema 1.0.0 visual properties and local assets. Existing Phase 1–4 JSON remains valid and keeps the same default rendering. The **Visual Quality / Local Assets** panel shows a dry-run summary, measured JSON diagnostics with paths, embedded asset provenance, and a read-only font availability check from the active Figma editor. It does not produce a numerical quality score. Contrast is measured only for a single fully opaque solid text paint against a single fully opaque solid inherited surface; gradients, alpha, stacked paints and overlays are skipped because a reliable contrast ratio cannot be inferred from the JSON alone. Touch-size thresholds are automated checks; composition, typography, Persian shaping, and platform appearance still require visual review.

The visual palette uses explicit six-digit colors; alpha is set through fill or layer opacity. New visual styling is additive and can be token-bound through the existing Phase 3 color tokens:

```json
{
  "type": "rectangle",
  "name": "Editorial card",
  "x": 16,
  "y": 16,
  "width": 320,
  "height": 180,
  "fill": "#FFFFFF",
  "cornerRadii": { "topLeft": 20, "topRight": 20, "bottomRight": 12, "bottomLeft": 12 },
  "visual": {
    "fills": [
      {
        "type": "linear",
        "angle": -24,
        "opacity": 0.95,
        "stops": [
          { "position": 0, "color": { "token": "color.brand.deepNavy" } },
          { "position": 1, "color": { "token": "color.action.primary" } }
        ]
      }
    ],
    "strokes": [{ "color": { "token": "color.border.default" }, "width": 1, "align": "inside" }],
    "effects": [
      {
        "type": "drop-shadow",
        "color": "#123B5D",
        "opacity": 0.16,
        "offsetX": 0,
        "offsetY": 8,
        "radius": 20,
        "spread": 0
      }
    ],
    "clipsContent": true
  }
}
```

Absolute-positioned nodes can also opt into Figma's native `constraints` on a non-Auto-Layout parent, for example `{"horizontal":"left-right","vertical":"top"}`. These are Figma resize constraints on that frame; they do not create breakpoint variants or guarantee responsive composition. Constraints are rejected inside Auto Layout, where Auto Layout sizing and child order remain authoritative. Child array order controls layer z-order. Multiple native fills support layered backgrounds; frame clipping is explicit.

### Local raster and SVG assets

Use **Import local PNG / JPEG / GIF / safe SVG** in the panel after entering a source/license note. The UI embeds file bytes into JSON and makes no network request. The `assets` list is shared by single-design and multi-screen documents. A raster image node refers to an asset id:

```json
{
  "assets": [
    {
      "id": "product-photo",
      "name": "Product photo",
      "kind": "raster",
      "mimeType": "image/png",
      "width": 800,
      "height": 1000,
      "license": "Owned by me",
      "alt": "Blue linen coat on a neutral background",
      "base64": "<canonical base64 PNG bytes>"
    }
  ],
  "document": {
    "children": [
      {
        "type": "image",
        "name": "Product photo",
        "assetId": "product-photo",
        "x": 16,
        "y": 16,
        "width": 160,
        "height": 200,
        "fit": "crop",
        "alt": "Blue linen coat on a neutral background"
      }
    ]
  }
}
```

The example fragment omits the required document fields for brevity. Import a real file through the UI to populate bytes and dimensions. Figma receives the bytes through `figma.createImage` and renders them as a native, replaceable image fill on an editable rectangle. Identical local bytes are converted once per generation, then reused by their Figma image hash. No external URL is accepted.

Limits: 20 assets per document, 256 KiB per raster file, 4,096 px per dimension, 700 KiB total decoded asset bytes, and the existing 1 MB JSON/editor limit. PNG chunk lengths/checksums and JPEG/GIF container headers are checked locally; Figma's image importer remains the final decoder. Invalid bytes stop before visible nodes are created and the error suggests re-exporting or using an editable vector placeholder. Figma image resources created before a later render error may remain as invisible file resources because the Plugin API has no image-resource delete operation; no image rectangle or unrelated node is left behind by the tested failure path.

SVG imports are intentionally narrow and offline: one root `viewBox` beginning at `0 0`, with 1–32 direct self-closing paths. The parser accepts solid six-digit fills and bounded absolute `M`, `L`, `Q`, `C`, and `Z` path commands. Markup is limited to 50 KB, combined path data to 40 KB, and path coordinates/complexity are bounded. Scripts, entities, images, groups, CSS, transforms, URLs, gradients, relative commands, and other SVG features are rejected with an error. Accepted paths become separate editable Vector nodes inside a clipped frame; raster asset fills remain pixels in a replaceable image fill. SVG tiling is not supported and is fit proportionally with a warning.

### Native feature matrix

| JSON feature                                             | Figma output                                                          | Behavior / fallback                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Solid and linear/radial fills, opacity, layered fills    | Native Paint arrays on text, rectangles, ellipses, vectors and frames | Literal values or resolved Phase 3 color tokens                                             |
| Stroke color, width, alignment and dash pattern          | Native strokes on supported shapes/frames                             | Multiple paints share the node's stroke weight/alignment                                    |
| Per-corner radii, clipping, layer opacity and blend mode | Native frame/shape properties                                         | Bounds and supported values are validated                                                   |
| Drop/inner shadow and normal layer/background blur       | Native Figma effects                                                  | Unsupported effects are rejected; no experimental effect types are emitted                  |
| Safe SVG path art                                        | Native editable Vector nodes                                          | Limited SVG subset; unsupported markup is rejected                                          |
| Local PNG/JPEG/GIF                                       | Native image fill on an editable rectangle                            | Pixels are not vectorized; invalid bytes fail preflight                                     |
| Design-system paint/text styles and component masters    | Phase 3 native styles, components and linked instances                | Existing ownership and safe reuse rules remain in force                                     |
| Spacing/radius numeric tokens                            | Resolved numeric values in layout/radius properties                   | Not a live Figma Variable binding                                                           |
| Figma font availability                                  | Read-only validation warning and runtime load/fallback report         | Text remains editable; Figma's font and bidirectional shaping behavior needs Desktop review |
| Absolute layout constraints                              | Native Figma constraints for non-Auto-Layout parents                  | No generated responsive breakpoints or automatic reflow                                     |

The button **Visual demo** loads `src/samples/phase-4.5-visual-design.json`, which has 10 distinct Persian storefront screens and native vector fashion illustrations; it includes no product photos, external fonts, remote icons or permanent brand logo. The separate `src/samples/visual-ltr-fixture.json` checks that visual styling also works in an LTR document. The included art is authored as editable path/shape geometry, not presented as photography.

### Phase 4.5 Windows / Figma Desktop acceptance

**Pending:** no Figma Desktop run was performed for this implementation. After building, close and reload the development plugin from this repository's `manifest.json`, then:

1. Load the Phase 4.5 demo, validate, inspect the estimated frame/node/component/instance counts and quality diagnostics, then generate all 10 screens.
2. Compare the 10 compositions at 100% zoom. Check hierarchy, whitespace, shadows, gradients, corner radii, row alignment, and overflow.
3. Inspect Persian/Latin mixed text, numerals, punctuation, font fallback, and editability. Do not treat the native text API as a manual RTL shaping control.
4. Edit vector paths, frames, shapes, gradients, strokes, effects, Auto Layout and linked Button/Product Card instances. Edit a master and verify normal Figma instance propagation.
5. Import a licensed local PNG, generate it, replace its native image fill, then import an SVG with several paths and edit the resulting Vector nodes.
6. Try a malformed PNG, unsafe SVG, missing asset id, invalid token and unavailable font. Confirm validation is actionable and no visible partial tree is left.
7. Re-import the visual demo twice; check for duplicate masters/styles and unchanged prior screen positions or manual edits.
8. Run the Phase 1–4 examples, confirm horizontal-first placement with the 120 px gap and 6,000 px default row width, and verify unrelated content stays in place.
9. Confirm the local Starter/Desktop environment can create and edit these native shapes, image fills and effects. Plugin API mocks are not proof of account-specific Figma behavior.

The prior Phase 2.2, Phase 3 and Phase 4 Desktop acceptance gates also remain pending unless the user reports their results. Phase 4.5 is implemented in code; product acceptance is pending this manual review. Phase 5 has not started.

## Phase 4.6 ChatGPT connection proof of concept

Phase 4.6 is currently a **local authorization/inference proof of concept**, not a text-to-design feature. The feasibility decision and documented protocol contract are recorded in [`docs/phase-4.6-feasibility.md`](docs/phase-4.6-feasibility.md). The flow is conditional on the app and account being eligible, the user's region/policy status, consent, quota, and the currently available model. Signing in proves identity only; the UI separately checks whether the token response granted `chatgpt.tokens.use.direct`.

The Phase 4.6 interface adds no natural-language prompt editor and never sends the open JSON document to OpenAI. It offers separate actions for browser sign-in, account-visible model discovery, and a fixed minimal Responses smoke request. The smoke request is sent only after the user clicks **Run fixed Responses smoke test**. It uses the account-visible model selected by the user, `store: false`, and streaming; it has no API-key billing fallback. ChatGPT sign-in does not grant access to conversations, files, or memory. If scope, eligibility, region, or quota blocks the request, the companion reports a sanitized status and offline JSON rendering remains available.

### Windows companion setup

1. Install the project dependencies and build the Figma plugin:

   ```powershell
   npm install
   npm run build
   ```

2. In Figma Desktop, close any running copy of the plugin. Import or reload the development plugin using the repository-root `manifest.json` (the built UI/controller files are under `dist/`).
3. Stop any old companion with Ctrl+C. In a separate PowerShell window at the repository root, check the listener and start the companion:

   ```powershell
   [System.Net.Dns]::GetHostAddresses("localhost") | ForEach-Object IPAddressToString
   Get-NetTCPConnection -LocalPort 1455 -State Listen -ErrorAction SilentlyContinue |
     Select-Object LocalAddress, LocalPort, OwningProcess
   npm run companion
   ```

   The listener should show only `127.0.0.1` and `::1`, both on port `1455`; it binds the two addresses explicitly and does not listen on LAN interfaces. `localhost` may resolve to IPv6 first on Windows, so both loopback families are served. The companion prints no pairing code or OAuth material. In normal use it opens a short-lived local approval page after you click **Continue with ChatGPT** in the plugin.

4. Open the plugin and click **Continue with ChatGPT**. The first local connection opens a separate browser approval page. Approve only if you just initiated the request in the intended plugin; the page explicitly says it cannot cryptographically identify which Figma plugin started the request. No terminal code is copied or pasted. The short-lived session bearer is returned only to the waiting plugin request and remains in UI memory. Reloading the plugin requires a fresh local approval; restarting the companion clears local sessions.
5. After local approval, the official flow opens in the system browser. If Windows does not open it automatically, use **Open sign-in page in system browser again** in the plugin. Complete the official flow and return to the plugin. The OAuth callback stays `http://127.0.0.1:1455/auth/callback` (OpenAI's OSS flow explicitly requires `127.0.0.1`; do not replace this callback host with `localhost`). It is accepted only for the exact URI, one-time state, PKCE transaction, expected nonce, validated ID-token signature/issuer/audience/expiry, and callback's issued public client ID.
6. Check the displayed authorization state. `Signed in; plan use not authorized` is not AI-ready. When ready, click **Load available models**, choose a listed model, then separately click **Run fixed Responses smoke test**. Capture only the sanitized status and success/failure category; never paste credentials or callback URLs into issues/logs.
7. **Disconnect this plugin from the local companion** removes its local pairing session only. **Disconnect ChatGPT account** clears the in-memory OAuth session and attempts token revocation if available. **Forget account registration and switch account** also clears the saved registration metadata. Press Ctrl+C in the companion terminal to clear all process-memory sessions.

The companion stores a stable `ext_agent_host_id` in the documented `urn:uuid:<UUIDv4>` form, the issued public `client_id`, and a SHA-256 hash of the validated `sub` used to bind that one registration to its account under `%LOCALAPPDATA%\Figma AI Design Engine\installation.json`. Existing bare UUIDv4 values from earlier builds are migrated by adding the required `urn:uuid:` prefix while preserving the UUID and other valid metadata. Other invalid persisted IDs are preserved and reported; the app does not silently invent a replacement host identity. It does not store access/refresh/ID tokens; those are held only in companion process memory and are cleared when it exits. Because this gate build does not persist refresh tokens, a new companion process requires a new sign-in. The `dynamic_agent_client` value is used only as the documented first-registration entry point; the issued callback client ID is retained for subsequent sign-in. **Forget account registration and switch account** attempts revocation and clears the saved client ID/account hash while keeping the stable host ID. No password, browser cookie, session credential, ChatGPT API key, custom prompt, or design JSON is collected or stored by this proof of concept.

### Loopback security and current gate limits

- The UI makes companion calls from the Figma UI iframe; the Figma document controller does not make browser/network requests. The UI endpoint is `http://localhost:1455`; the system-browser OAuth callback is separately fixed at `http://127.0.0.1:1455/auth/callback` per OpenAI's documented OSS flow. The companion binds separately to `127.0.0.1:1455` and `[::1]:1455`, and validates the expected Host for each route. Figma's opaque `Origin: null` is accepted for plugin transport and wildcard CORS; it is never treated as authentication. The unauthenticated health endpoint reveals only whether the companion is running. All account, model, OAuth and inference actions require a short-lived in-memory bearer issued after the local approval flow.
- Request bodies and remote response bodies have explicit size limits; OAuth state expires after five minutes and is consumed once. Callback/token/JWKS/HTTP failures are exposed only as sanitized categories. There is no general proxy endpoint.
- **Threat model:** pairing is a separate local user-consent step. A Web Crypto verifier binds the polling response to the initiating request; an unguessable attempt ID alone cannot retrieve the bearer. The local approval form is one-use, short-lived, same-origin, CSRF-checked, unframeable and has no external resources. However, the companion cannot cryptographically identify which plugin created an `Origin: null` request. A different opaque-origin client could create its own approval request and try to mislead the user; approve only after your own click in the intended plugin. A same-user malicious process can access loopback or interfere with browser/process state and is outside this local companion's security boundary. The companion uses loopback-only binding, bearer authorization on privileged routes, exact `Host` checks, PKCE, state replay prevention, nonce/signature/issuer/audience/expiry checks, body/time limits, no cookies, no-store responses, and in-memory-only OAuth/pairing credentials. See [`docs/phase-4.6.1-auto-pairing-design.md`](docs/phase-4.6.1-auto-pairing-design.md) for the diagram, attacks and limitations.
- The manifest keeps production `allowedDomains` at `none` and uses the documented development entry `http://localhost:1455`. It does not allow external OpenAI hosts in the Figma plugin manifest; OAuth and provider traffic originates from the companion process. Figma Desktop validation and Chromium local-network/private-network behavior still need actual Desktop verification.
- Access, refresh and ID tokens are not persisted in this gate build. A single account registration is supported; an explicit switch action clears it. Protected Windows token storage, multi-account session profiles, automatic design planning, schema generation, bounded repair, and design prompt transfer are **not implemented** until the live authorization and inference gate is passed.
- No Figma Desktop connection, ChatGPT account authorization, granted scope, model-list access, or live Responses call has been performed by the coding agent. Automated tests below use mocked OAuth/provider responses and do not pass the live gate.

### Phase 4.6 manual acceptance gates

**All live checks are pending.** After rebuilding and reloading the manifest in Figma Desktop:

1. **Local pairing:** Start the companion and click **Continue with ChatGPT**. Confirm the local approval page opens, deny once and verify no OAuth browser flow starts; retry, approve, and confirm no terminal pairing code is shown or needed. Restart the companion and verify the old UI session is cleared. Test two plugin windows and confirm the second receives a clear busy message rather than silently pairing.
2. **Gate A — live sign-in:** After local approval, complete the official browser flow, use the manual browser retry button if needed, return, and verify the UI says `Ready for AI` only if the actual token response grants the direct plan-use scope. Also verify consent denial and a missing-scope status. Share only sanitized results.
3. **Gate B — live inference:** Click **Load available models**, choose a model actually returned for the signed-in account, then explicitly run the fixed smoke request. Verify a real streamed `response.completed` result. Note any eligibility, region, quota, 401, or 403 block. Do not substitute a paid API key.
4. **Gate C — design generation:** **Blocked / not implemented at this gate.** Do not treat a mock test or the smoke response as design generation. This stage requires a separate implementation after A and B are confirmed.
5. **Gate D — offline regression:** Stop the companion, reload the plugin, and confirm Phase 1–4.5 JSON validation, samples, rendering and placement still work without sign-in or network access.

The earlier Phase 2.2, Phase 3, Phase 4 and Phase 4.5 manual Figma acceptance gates remain pending unless the user has separately reported passing them.

### Phase 4.6 loopback troubleshooting

| Symptom                                                                 | Check / action                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin refuses to open and reports an invalid `devAllowedDomains` value | Confirm Figma imported this repository's root `manifest.json`, which uses the documented `http://localhost:1455` development entry. Rebuild, close the running plugin, then reload/import the local development plugin from this manifest.                                                                                                                                                                  |
| Companion will not start / address is already in use                    | Run `Get-NetTCPConnection -LocalPort 1455 -State Listen` and inspect the owner with `Get-Process -Id <PID>`. Stop only the old companion process you started, then run `npm run companion` again.                                                                                                                                                                                                           |
| Local approval says another attempt is pending                          | Finish or deny the approval in the first plugin window, or wait up to 90 seconds for expiry. The companion permits only one pending local approval at a time.                                                                                                                                                                                                                                               |
| Local approval was denied, expired, or the browser did not open         | Retry **Continue with ChatGPT**. Confirm Windows has a default browser. Approval is not ChatGPT sign-in; the official OAuth flow starts only after the local approval succeeds.                                                                                                                                                                                                                             |
| Browser approval says the request was rejected                          | Rebuild the plugin, stop the old companion, reload the root-manifest development plugin, and restart `npm run companion` so both UI and server use the current code. Valid CSRF is still required, but missing optional Fetch Metadata headers and IPv4/IPv6 loopback resolution are supported. If it persists, report the browser/version and exact sanitized page message; do not share the approval URL. |
| UI cannot reach companion                                               | Check both `127.0.0.1:1455` and `[::1]:1455` are listening. Inspect the Figma plugin console: a refused connection usually means the companion is stopped/busy; a CSP message points to a stale/wrong manifest; CORS or Private Network Access errors indicate the browser blocked the iframe request. Report the sanitized error category and console message, with secrets/query values removed.          |
| Companion restarted or an action says local pairing is required         | The UI bearer and companion sessions are memory-only. Click **Continue with ChatGPT** again and approve a new local request; no OpenAI credentials are written to the Figma document or browser storage.                                                                                                                                                                                                    |
| OAuth or model/inference request fails                                  | Local bridge connectivity is separate from ChatGPT authorization. Use the displayed sanitized sign-in/scope/model/quota category. Do not retry with API keys or browser session data.                                                                                                                                                                                                                       |

For `invalid_authorize_request` naming `ext_agent_host_id`, the old companion build stored a bare UUIDv4. Current code uses the required `urn:uuid:<UUIDv4>` and migrates that legacy value in place, preserving its UUID and any other valid installation metadata. Restart the companion after updating the code so it reloads the migrated file. Do not edit the host ID manually. If the same sanitized error persists, the documented format is already being sent; stop and report the error category, as app/account eligibility cannot be established from local code or a mocked test.

The loopback repair regression tests compare the UI endpoint, both listener addresses, and the manifest development entry, and reject the previously failing IPv4-literal manifest value. They also exercise requests against both loopback families. These tests cannot establish Figma Desktop's own manifest or iframe policy; perform the manual checklist above.

## Limitations

- The plugin creates designs from JSON; it does not create a design from a natural-language prompt.
- Full right-to-left/bidirectional shaping, component variants, configurable component properties, and instance overrides are not implemented. Native absolute constraints do not provide responsive breakpoints or automatic reflow.
- Rotated nodes reserve their full axis-aligned envelope, which may leave extra space. Figma render bounds may omit editor-only effects; geometric bounds are used when render bounds are unavailable.
- The 6,000 px row width is a layout target rather than a hard canvas limit. Existing Phase 2.1 clusters are not rearranged automatically.
- Numeric design-system tokens are resolved values and do not update through Figma Variables. Shadow/effect tokens, native component sets, variant properties, instance text overrides, advanced responsive rules, prototyping links, and publishing workflows are outside the current scope.
- Font appearance and some text shaping depend on fonts installed and available to Figma Desktop.

## Build and development

The production build writes `dist\plugin.js` and `dist\ui.html`, which are referenced by `manifest.json`. No development server is needed to use the production build. To run the local development workflow, use:

```powershell
npm run dev
```

After source changes, close the running development plugin, run `npm run build`, then reopen it from **Plugins → Development** in Figma Desktop. If the UI still shows an older bundle, choose **Plugins → Development → Import plugin from manifest…** and select this repository's `manifest.json` again, then reopen the plugin. Project checks are available with:

```powershell
npm run typecheck
npm run lint
npm run test
npm run format:check
```

Runtime dependencies are React, React DOM, and Zod. Other project dependencies are used for development and building. The Figma main/controller stays offline; the companion uses only official OpenAI OAuth and API endpoints after explicit user actions. No paid dependency, separately billed API key fallback, telemetry, cloud backend, or runtime third-party service was added. The production manifest domain list remains `none`; only the local development companion is allowlisted via Figma's development-only network setting.

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
