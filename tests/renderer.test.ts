import { beforeEach, describe, expect, it, vi } from "vitest";
import phase1Sample from "../src/samples/sample-design.json";
import storefront from "../src/samples/phase-2-storefront.json";
import phase3Sample from "../src/samples/phase-3-design-system.json";
import phase4Sample from "../src/samples/phase-4-multi-screen.json";
import phase45VisualSample from "../src/samples/phase-4.5-visual-design.json";
import { ONE_PIXEL_PNG } from "./visual-fixtures";
import {
  mapLayoutSpec,
  mapSizingMode,
  renderDesign,
  renderMultiScreenDesign,
  type RendererFigmaApi,
} from "../src/plugin/renderer";
import { boundsIntersectWithGap, DEFAULT_MIN_CANVAS_GAP } from "../src/plugin/canvas-placement";
import { parseDesignValue, type DesignSpec } from "../src/shared/schema";
import { createDesignPlan } from "../src/shared/design-generation";
import { prepareGeneratedDesign } from "../src/ui/design-generation";
import { createGenerationController } from "../src/plugin/generation-controller";
import { UIToPluginSchema, PluginToUISchema } from "../src/shared/messages";
import { draftFixture } from "./generation-fixture";

interface MockNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fills: readonly Paint[];
  strokes: readonly Paint[];
  readonly absoluteRenderBounds: Rect | null;
  readonly absoluteBoundingBox: Rect | null;
  readonly absoluteTransform: Transform;
  children: MockNode[];
  parent: MockNode | null;
  removed: boolean;
  pluginData: Map<string, string>;
  resize(width: number, height: number): void;
  appendChild(node: MockNode): void;
  remove(): void;
  createInstance(): MockNode;
  getPluginData(key: string): string;
  setPluginData(key: string, value: string): void;
  setFillStyleIdAsync(id: string): Promise<void>;
  setRangeFillStyleIdAsync(start: number, end: number, id: string): Promise<void>;
  setStrokeStyleIdAsync(id: string): Promise<void>;
  setTextStyleIdAsync(id: string): Promise<void>;
  mainComponent?: MockNode;
}

function createMockFigma(options: { failLoadFamily?: string } = {}) {
  const roots: MockNode[] = [];
  const allCreated: MockNode[] = [];
  const paintStyles: PaintStyle[] = [];
  const textStyles: TextStyle[] = [];
  let nextStyleId = 1;
  const loadedFonts: FontName[] = [];
  const detach = (node: MockNode) => {
    if (node.parent) {
      node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = null;
    } else {
      const index = roots.indexOf(node);
      if (index >= 0) roots.splice(index, 1);
    }
  };
  const makeNode = (type: string): MockNode => {
    const node: MockNode = {
      id: `node:${allCreated.length + 1}`,
      type,
      name: "",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [],
      strokes: [],
      get absoluteRenderBounds() {
        return { x: node.x, y: node.y, width: node.width, height: node.height };
      },
      get absoluteBoundingBox() {
        return { x: node.x, y: node.y, width: node.width, height: node.height };
      },
      get absoluteTransform() {
        return [
          [1, 0, node.x],
          [0, 1, node.y],
        ] as Transform;
      },
      children: [],
      parent: null,
      removed: false,
      pluginData: new Map(),
      getPluginData(key) {
        return node.pluginData.get(key) ?? "";
      },
      setPluginData(key, value) {
        node.pluginData.set(key, value);
      },
      async setFillStyleIdAsync(id) {
        Object.assign(node, { fillStyleId: id });
      },
      async setRangeFillStyleIdAsync(start, end, id) {
        Object.assign(node, { rangeFillStyleId: id, rangeFillStart: start, rangeFillEnd: end });
      },
      async setStrokeStyleIdAsync(id) {
        Object.assign(node, { strokeStyleId: id });
      },
      async setTextStyleIdAsync(id) {
        const style = textStyles.find((candidate) => candidate.id === id);
        Object.assign(node, {
          textStyleId: id,
          ...(style?.type === "TEXT"
            ? {
                fontName: style.fontName,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                letterSpacing: style.letterSpacing,
                textDecoration: style.textDecoration,
              }
            : {}),
        });
      },
      resize(width, height) {
        node.width = width;
        node.height = height;
      },
      appendChild(child) {
        detach(child);
        node.children.push(child);
        child.parent = node;
      },
      remove() {
        for (const child of [...node.children]) child.remove();
        detach(node);
        node.removed = true;
      },
      createInstance() {
        const instance = makeNode("INSTANCE");
        instance.name = node.name;
        instance.width = node.width;
        instance.height = node.height;
        instance.mainComponent = node;
        return instance;
      },
    };
    roots.push(node);
    allCreated.push(node);
    return node;
  };
  const walk = (nodes: MockNode[], predicate: (node: MockNode) => boolean): MockNode[] =>
    nodes.flatMap((node) => [
      ...(predicate(node) ? [node] : []),
      ...walk(node.children, predicate),
    ]);
  const unrelated = makeNode("RECTANGLE");
  unrelated.name = "Unrelated user layer";
  const createStyle = (type: "PAINT" | "TEXT") => {
    const plugins = new Map<string, string>();
    const style = {
      id: `style:${nextStyleId++}`,
      type,
      name: "",
      getPluginData(key: string) {
        return plugins.get(key) ?? "";
      },
      setPluginData(key: string, value: string) {
        plugins.set(key, value);
      },
      remove() {
        if (type === "PAINT") {
          const index = paintStyles.indexOf(style as unknown as PaintStyle);
          if (index >= 0) paintStyles.splice(index, 1);
        } else {
          const index = textStyles.indexOf(style as unknown as TextStyle);
          if (index >= 0) textStyles.splice(index, 1);
        }
      },
      ...(type === "PAINT"
        ? { paints: [] as readonly Paint[] }
        : {
            fontName: { family: "Inter", style: "Regular" },
            fontSize: 12,
            lineHeight: { unit: "AUTO" },
            letterSpacing: { unit: "PIXELS", value: 0 },
            textDecoration: "NONE",
          }),
    } as unknown as PaintStyle | TextStyle;
    return style;
  };
  const raw = {
    createFrame: vi.fn(() => makeNode("FRAME")),
    createText: vi.fn(() => {
      const text = makeNode("TEXT");
      Object.assign(text, {
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 12,
        characters: "",
        textAutoResize: "WIDTH_AND_HEIGHT",
      });
      return text;
    }),
    createRectangle: vi.fn(() => makeNode("RECTANGLE")),
    createEllipse: vi.fn(() => makeNode("ELLIPSE")),
    createVector: vi.fn(() => makeNode("VECTOR")),
    createImage: vi.fn(() => ({ hash: "mock-image-hash" })),
    createComponentFromNode: vi.fn((node: MockNode) => {
      node.type = "COMPONENT";
      return node;
    }),
    createPaintStyle: vi.fn(() => createStyle("PAINT") as PaintStyle),
    createTextStyle: vi.fn(() => createStyle("TEXT") as TextStyle),
    getLocalPaintStylesAsync: vi.fn(async () => paintStyles),
    getLocalTextStylesAsync: vi.fn(async () => textStyles),
    listAvailableFontsAsync: vi.fn(async () =>
      ["Regular", "Bold"].flatMap((style) => [
        { fontName: { family: "Inter", style } },
        { fontName: { family: "Arial", style } },
      ]),
    ),
    loadFontAsync: vi.fn(async (font: FontName) => {
      if (font.family === options.failLoadFamily) throw new Error("Font unavailable");
      loadedFonts.push(font);
    }),
    currentPage: {
      children: roots as unknown as SceneNode[],
      selection: [] as SceneNode[],
      findAll: vi.fn((predicate: (node: MockNode) => boolean) => walk(roots, predicate)),
    },
    viewport: {
      center: { x: 500, y: 500 },
      scrollAndZoomIntoView: vi.fn(),
    },
    variables: { createVariableCollection: vi.fn() },
  };
  return {
    api: raw as unknown as RendererFigmaApi,
    raw,
    roots,
    allCreated,
    loadedFonts,
    paintStyles,
    textStyles,
    unrelated,
    find: (name: string) => walk(roots, (node) => node.name === name)[0],
  };
}

describe("renderer mappings", () => {
  it("maps supported layout alignments, padding, spacing, stretch, and sizing", () => {
    expect(
      mapLayoutSpec({
        mode: "horizontal",
        gap: 12,
        padding: { top: 1, right: 2, bottom: 3, left: 4 },
        primaryAxisAlign: "space-between",
        counterAxisAlign: "stretch",
      }),
    ).toEqual({
      mode: "HORIZONTAL",
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "MIN",
      stretchChildren: true,
      itemSpacing: 12,
      paddingTop: 1,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 4,
    });
    expect(
      mapLayoutSpec({ mode: "vertical", primaryAxisAlign: "end", counterAxisAlign: "baseline" }),
    ).toMatchObject({
      mode: "VERTICAL",
      primaryAxisAlignItems: "MAX",
      counterAxisAlignItems: "BASELINE",
    });
    expect(mapSizingMode("hug")).toBe("HUG");
    expect(mapSizingMode("fill")).toBe("FILL");
  });
});

describe("renderDesign", () => {
  let mock: ReturnType<typeof createMockFigma>;

  beforeEach(() => {
    mock = createMockFigma();
  });

  it("keeps the Phase 1 sample editable and positioned", async () => {
    const result = await renderDesign(mock.api, phase1Sample);
    const frame = mock.find(phase1Sample.document.name)!;
    expect(result).toMatchObject({
      frameName: phase1Sample.document.name,
      counts: { frames: 1, texts: 2, rectangles: 1, components: 0, instances: 0 },
      warnings: [],
    });
    expect(frame.width).toBe(390);
    expect(frame.height).toBe(844);
    expect(frame.x).toBe(220);
    expect(frame.y).toBe(0);
    expect(frame.children[0].x).toBe(24);
    expect(frame.children[0].y).toBe(40);
    expect(frame.fills).toEqual([
      { type: "SOLID", color: { r: 248 / 255, g: 250 / 255, b: 252 / 255 } },
    ]);
    expect(mock.raw.currentPage.selection).toEqual([frame]);
    expect(mock.raw.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([frame]);
  });

  it("creates nested native Auto Layout frames and applies sizing after append", async () => {
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Nested",
        width: 320,
        height: 300,
        background: "#FFFFFF",
        layout: {
          mode: "vertical",
          gap: 12,
          padding: { top: 20, right: 16, bottom: 18, left: 14 },
          counterAxisAlign: "stretch",
        },
        children: [
          {
            type: "frame",
            name: "Nested Layout",
            width: 288,
            height: 100,
            layout: {
              mode: "horizontal",
              gap: 8,
              padding: { top: 4, right: 6, bottom: 8, left: 10 },
              primaryAxisAlign: "center",
              counterAxisAlign: "stretch",
            },
            sizing: { width: "fill", height: "fixed" },
            children: [
              {
                type: "text",
                name: "Filling Text",
                text: "کالا A-17",
                fontSize: 14,
                lineHeight: 22,
                color: "#0F172A",
                textAlign: "right",
                sizing: { width: "fill", height: "fill" },
              },
            ],
          },
        ],
      },
    };
    const parsed = parseDesignValue(design);
    expect(parsed.success).toBe(true);
    const result = await renderDesign(mock.api, design);
    const root = mock.find("Nested")!;
    const nested = mock.find("Nested Layout")!;
    const child = mock.find("Filling Text")!;
    expect(result.counts.frames).toBe(2);
    expect(root).toMatchObject({
      layoutMode: "VERTICAL",
      itemSpacing: 12,
      paddingTop: 20,
      paddingRight: 16,
      paddingBottom: 18,
      paddingLeft: 14,
    });
    expect(nested).toMatchObject({
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      primaryAxisAlignItems: "CENTER",
      paddingTop: 4,
      paddingRight: 6,
      paddingBottom: 8,
      paddingLeft: 10,
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "FIXED",
      layoutAlign: "STRETCH",
    });
    expect(child).toMatchObject({
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "FILL",
      layoutAlign: "STRETCH",
      characters: "کالا A-17",
      lineHeight: { unit: "PIXELS", value: 22 },
      textAlignHorizontal: "RIGHT",
    });
  });

  it("loads exact fonts, falls back visibly, and preserves mixed Persian and Latin text", async () => {
    const design = structuredClone(phase1Sample) as unknown as DesignSpec;
    const heading = design.document.children[0];
    if (heading.type === "text") {
      heading.text = "کالا A-17 — ۱۲۳";
      heading.fontFamily = "Missing Font";
    }
    const result = await renderDesign(mock.api, design);
    expect(result.warnings).toEqual([
      "Font “Missing Font Regular” is unavailable; used “Inter Regular”.",
    ]);
    expect(result.fontSelections[0]).toMatchObject({
      requestedFamily: "Missing Font",
      usedFamily: "Inter",
      usedStyle: "Regular",
      fellBack: true,
    });
    expect(mock.loadedFonts).toContainEqual({ family: "Inter", style: "Regular" });
    expect(mock.find("Persian Heading")).toMatchObject({ characters: "کالا A-17 — ۱۲۳" });
  });

  it("falls back if Figma cannot load an available requested font", async () => {
    mock = createMockFigma({ failLoadFamily: "Arial" });
    const design = structuredClone(phase1Sample) as unknown as DesignSpec;
    const heading = design.document.children[0];
    if (heading.type === "text") heading.fontFamily = "Arial";
    const result = await renderDesign(mock.api, design);
    expect(result.fontSelections[0]).toMatchObject({
      requestedFamily: "Arial",
      usedFamily: "Inter",
      fellBack: true,
    });
    expect(mock.loadedFonts).toContainEqual({ family: "Inter", style: "Regular" });
  });

  it("stops before document changes if neither the requested font nor fallback can load", async () => {
    mock = createMockFigma({ failLoadFamily: "Inter" });
    await expect(renderDesign(mock.api, phase1Sample)).rejects.toThrow(/could not load/);
    expect(mock.raw.createFrame).not.toHaveBeenCalled();
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.unrelated.removed).toBe(false);
  });

  it("builds component dependencies first and creates native linked instances", async () => {
    const result = await renderDesign(mock.api, storefront);
    const button = mock.find("Button / Primary — Generated")!;
    const card = mock.find("Product Card / Basic — Generated")!;
    const buttonInstance = mock.find("افزودن به سبد خرید")!;
    const cardInstance = mock.find("Featured Product Card")!;
    expect(mock.raw.createComponentFromNode).toHaveBeenCalledTimes(2);
    expect(button.type).toBe("COMPONENT");
    expect(card.type).toBe("COMPONENT");
    expect(buttonInstance.type).toBe("INSTANCE");
    expect(buttonInstance.mainComponent).toBe(button);
    expect(cardInstance.type).toBe("INSTANCE");
    expect(cardInstance.mainComponent).toBe(card);
    expect(result.counts).toMatchObject({ components: 2, instances: 2, texts: 15 });
    expect(result.fontSelections.some((font) => font.usedFamily === "Arial")).toBe(true);
    expect(mock.raw.currentPage.selection).toHaveLength(1);
    expect(mock.raw.viewport.scrollAndZoomIntoView).toHaveBeenCalledOnce();
    expect(mock.find("Product Search")).toMatchObject({
      strokes: [{ type: "SOLID", color: { r: 226 / 255, g: 232 / 255, b: 240 / 255 } }],
      cornerRadius: 14,
    });
    expect(mock.find("Garment Shape")).toMatchObject({ cornerRadius: 18 });
    expect(mock.find("Store Heading")).toMatchObject({
      characters: "فروشگاه پوشاک",
      textAlignHorizontal: "RIGHT",
    });
  });

  it("places the screen and component masters as a horizontal, non-overlapping cluster", async () => {
    const firstResult = await renderDesign(mock.api, storefront);
    const firstWrapper = mock.raw.currentPage.selection[0] as unknown as MockNode;
    const firstPosition = { x: firstWrapper.x, y: firstWrapper.y };
    expect(firstWrapper.x).toBe(220);
    expect(firstWrapper.y).toBe(0);
    expect(firstWrapper.children.map((node) => node.name)).toEqual([
      "Components — فروشگاه پوشاک",
      "فروشگاه پوشاک",
    ]);
    expect(firstWrapper.children[0].x).toBe(446);
    expect(firstWrapper.children[1].x).toBe(0);

    const secondResult = await renderDesign(mock.api, storefront);
    const secondWrapper = mock.raw.currentPage.selection[0] as unknown as MockNode;
    expect(secondResult.frameName).toBe(`${firstResult.frameName} (2)`);
    expect(secondWrapper.x - (firstWrapper.x + firstWrapper.width)).toBe(120);
    expect(secondWrapper.y).toBe(firstWrapper.y);
    expect(firstWrapper).toMatchObject(firstPosition);
    expect(mock.unrelated).toMatchObject({ x: 0, y: 0, removed: false });
    expect(mock.roots).toContain(mock.unrelated);
  });

  it("reserves enough cluster width for component masters wider than the screen", async () => {
    const wideComponents = structuredClone(storefront);
    for (const component of wideComponents.document.components ?? []) component.width = 700;

    await renderDesign(mock.api, wideComponents);

    const wrapper = mock.raw.currentPage.selection[0] as unknown as MockNode;
    const componentArea = wrapper.children[0];
    expect(componentArea.width).toBe(700);
    expect(componentArea.x).toBe(390 + 56);
    expect(wrapper.width).toBe(390 + 56 + 700);
  });

  it("validates before creating content and preserves unrelated layers on invalid input", async () => {
    await expect(renderDesign(mock.api, { schemaVersion: "1.0.0" })).rejects.toThrow(
      "document is required",
    );
    expect(mock.raw.createFrame).not.toHaveBeenCalled();
    expect(mock.unrelated.removed).toBe(false);
  });

  it("cleans partial frame output after a node creation error", async () => {
    mock.raw.createRectangle.mockImplementation(() => {
      throw new Error("Mock Figma failure");
    });
    await expect(renderDesign(mock.api, phase1Sample)).rejects.toThrow(/Mock Figma failure/);
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.unrelated.removed).toBe(false);
  });

  it("cleans partial component definitions without touching unrelated layers", async () => {
    mock.raw.createRectangle.mockImplementation(() => {
      throw new Error("Component child failure");
    });
    await expect(renderDesign(mock.api, storefront)).rejects.toThrow(/Component child failure/);
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.unrelated.removed).toBe(false);
    expect(
      mock.allCreated.filter((node) => node.type !== "RECTANGLE").every((node) => node.removed),
    ).toBe(true);
  });

  it("restores selection and removes output if focus fails after generation", async () => {
    mock.raw.currentPage.selection = [mock.unrelated as unknown as SceneNode];
    mock.raw.viewport.scrollAndZoomIntoView.mockImplementation(() => {
      throw new Error("Viewport failure");
    });
    await expect(renderDesign(mock.api, phase1Sample)).rejects.toThrow(/Viewport failure/);
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.raw.currentPage.selection).toEqual([mock.unrelated]);
    expect(mock.unrelated.removed).toBe(false);
  });

  it("uses unique names and keeps prior generations intact", async () => {
    const first = await renderDesign(mock.api, phase1Sample);
    const firstFrame = mock.find(first.frameName)!;
    const second = await renderDesign(mock.api, phase1Sample);
    const secondFrame = mock.find(second.frameName)!;
    expect(first.frameName).toBe(phase1Sample.document.name);
    expect(second.frameName).toBe(`${phase1Sample.document.name} (2)`);
    expect(firstFrame).not.toBe(secondFrame);
    expect(firstFrame.removed).toBe(false);
    expect(secondFrame.removed).toBe(false);
    expect(mock.roots).toContain(mock.unrelated);
  });

  it("creates native style bindings, owned reusable masters, and linked Persian preview instances", async () => {
    const result = await renderDesign(mock.api, phase3Sample);
    const components = mock.allCreated.filter((node) => node.type === "COMPONENT");
    const wrapper = mock.raw.currentPage.selection[0] as unknown as MockNode;
    const primary = components.find((node) => node.name.includes("button.primary"))!;
    const productCard = components.find((node) => node.name.includes("product-card.basic"))!;
    const buttonInstance = mock.find("Purchase Action")!;
    const cardInstance = mock.find("Persian Product Card Preview")!;
    expect(components).toHaveLength(4);
    expect(buttonInstance.type).toBe("INSTANCE");
    expect(buttonInstance.mainComponent).toBe(primary);
    expect(cardInstance.type).toBe("INSTANCE");
    expect(cardInstance.mainComponent).toBe(productCard);
    expect(mock.paintStyles).toHaveLength(11);
    expect(mock.textStyles).toHaveLength(4);
    expect(mock.find("Preview Heading")).toMatchObject({
      characters: "محصولات منتخب",
      textStyleId: expect.any(String),
      rangeFillStyleId: expect.any(String),
      rangeFillStart: 0,
      rangeFillEnd: "محصولات منتخب".length,
      textAlignHorizontal: "RIGHT",
    });
    expect(result.designSystem).toMatchObject({
      namespace: "apparel-core",
      created: expect.arrayContaining(["component:button.primary", "style:color.brand.deepNavy"]),
      fallbacks: expect.arrayContaining([
        expect.stringContaining("Resolved numeric values"),
        expect.stringContaining("Starter variable creation has not been verified"),
      ]),
    });
    expect(wrapper.type).toBe("FRAME");
    expect(mock.raw.currentPage.selection).toEqual([wrapper]);
  });

  it("reuses owned design-system styles and masters on repeated imports", async () => {
    const first = await renderDesign(mock.api, phase3Sample);
    const createdMasters = mock.allCreated.filter((node) => node.type === "COMPONENT");
    const second = await renderDesign(mock.api, phase3Sample);
    expect(mock.raw.createComponentFromNode).toHaveBeenCalledTimes(4);
    expect(mock.allCreated.filter((node) => node.type === "COMPONENT")).toHaveLength(4);
    expect(mock.paintStyles).toHaveLength(11);
    expect(mock.textStyles).toHaveLength(4);
    expect(second.designSystem?.reused).toHaveLength(19);
    expect(second.designSystem?.created).toEqual([]);
    expect(first.frameName).not.toBe(second.frameName);
    expect(createdMasters.every((node) => !node.removed)).toBe(true);
  });

  it("keeps explicit text overrides and binds token colors after native Text Styles", async () => {
    const design = structuredClone(phase3Sample) as unknown as DesignSpec;
    const heading = design.document.children.find(
      (child) => child.type === "text" && child.name === "Preview Heading",
    );
    expect(heading?.type).toBe("text");
    if (heading?.type === "text") {
      heading.fontSize = 19;
      heading.lineHeight = 27;
      heading.textDecoration = "underline";
      heading.fontFamily = "Unavailable Font";
      heading.fontStyle = "Regular";
    }

    await renderDesign(mock.api, design);

    const renderedHeading = mock.find("Preview Heading")!;
    expect(renderedHeading).toMatchObject({
      textStyleId: expect.any(String),
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 19,
      lineHeight: { unit: "PIXELS", value: 27 },
      textDecoration: "UNDERLINE",
      rangeFillStyleId: expect.any(String),
      rangeFillStart: 0,
      rangeFillEnd: "محصولات منتخب".length,
    });
  });

  it("rolls back styles and newly created nodes if design-system rendering fails", async () => {
    mock.raw.createText.mockImplementation(() => {
      throw new Error("Text layer creation failed");
    });
    await expect(renderDesign(mock.api, phase3Sample)).rejects.toThrow(
      /Text layer creation failed/,
    );
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.paintStyles).toEqual([]);
    expect(mock.textStyles).toEqual([]);
    expect(mock.unrelated.removed).toBe(false);
  });

  it("renders a multi-screen batch with shared native styles, masters, and collision-free placement", async () => {
    const result = await renderMultiScreenDesign(mock.api, phase4Sample, { maxRowWidth: 2_000 });
    const screenRoots = mock.roots.filter((node) =>
      node.pluginData.has("fad.multi-screen.screen-id"),
    );
    const componentArea = mock.roots.find((node) =>
      node.pluginData.has("fad.multi-screen.components-batch"),
    );

    expect(result).toMatchObject({
      totalScreens: 10,
      generatedScreens: 10,
      failedScreens: 0,
      gap: DEFAULT_MIN_CANVAS_GAP,
      maxRowWidth: 2_000,
    });
    expect(screenRoots).toHaveLength(10);
    expect(componentArea).toBeDefined();
    expect(mock.raw.createComponentFromNode).toHaveBeenCalledTimes(4);
    expect(mock.paintStyles).toHaveLength(11);
    expect(mock.textStyles).toHaveLength(4);
    expect(result.counts.components).toBe(4);
    expect(result.designSystem?.created).toContain("component:button.primary");
    expect(mock.find("Home featured product")?.mainComponent?.name).toContain("product-card.basic");
    expect(mock.raw.currentPage.selection).toEqual([screenRoots[0]]);
    expect(mock.raw.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([screenRoots[0]]);

    for (let first = 0; first < screenRoots.length; first++) {
      const firstBounds = {
        x: screenRoots[first].x,
        y: screenRoots[first].y,
        width: screenRoots[first].width,
        height: screenRoots[first].height,
      };
      expect(
        boundsIntersectWithGap(
          firstBounds,
          {
            x: mock.unrelated.x,
            y: mock.unrelated.y,
            width: mock.unrelated.width,
            height: mock.unrelated.height,
          },
          DEFAULT_MIN_CANVAS_GAP,
        ),
      ).toBe(false);
      expect(
        boundsIntersectWithGap(
          firstBounds,
          {
            x: componentArea!.x,
            y: componentArea!.y,
            width: componentArea!.width,
            height: componentArea!.height,
          },
          DEFAULT_MIN_CANVAS_GAP,
        ),
      ).toBe(false);
      for (let second = first + 1; second < screenRoots.length; second++) {
        expect(
          boundsIntersectWithGap(
            firstBounds,
            {
              x: screenRoots[second].x,
              y: screenRoots[second].y,
              width: screenRoots[second].width,
              height: screenRoots[second].height,
            },
            DEFAULT_MIN_CANVAS_GAP,
          ),
        ).toBe(false);
      }
    }
    expect(
      boundsIntersectWithGap(
        {
          x: componentArea!.x,
          y: componentArea!.y,
          width: componentArea!.width,
          height: componentArea!.height,
        },
        {
          x: mock.unrelated.x,
          y: mock.unrelated.y,
          width: mock.unrelated.width,
          height: mock.unrelated.height,
        },
        DEFAULT_MIN_CANVAS_GAP,
      ),
    ).toBe(false);
  });

  it("hands generated designs with large screen child lists to the native renderer", async () => {
    const plan = createDesignPlan({
      prompt: "Create a storefront with a home and cart screen.",
      target: "mobile",
      screenCount: 2,
      screenNames: ["Home", "Cart"],
      language: "en",
      style: "",
      projectType: "storefront",
      theme: "auto",
    });
    expect(plan.success).toBe(true);
    if (!plan.success) return;
    const response = {
      projectName: "Large Storefront",
      palette: {
        brand: "#263A36",
        accent: "#B97755",
        page: "#F6F3EE",
        surface: "#FFFFFF",
        text: "#1E2926",
        muted: "#68736F",
        border: "#D9DED9",
      },
      screens: plan.data.screens.map(({ id }) => ({
        id,
        children: Array.from({ length: 300 }, (_, index) => ({
          type: "text",
          name: `Label ${index}`,
          text: `Editable screen content ${index}`,
          palette: "text",
          width: 300,
          height: 48,
          fontSize: 16,
          fontStyle: "Regular",
          textAlign: "left",
          cornerRadius: 0,
          elevation: "none",
          layout: "none",
          gap: 0,
          padding: 0,
          qualityRole: "body",
          children: [],
        })),
      })),
    };
    const prepared = prepareGeneratedDesign(JSON.stringify(response), plan.data);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;

    const result = await renderMultiScreenDesign(mock.api, prepared.data.batch);
    expect(result.failedScreens).toBe(0);
    expect(result.generatedScreens).toBe(2);
    expect(result.createdNodeCount).toBeGreaterThan(600);
  });

  it("renders normalized RTL touch targets as editable native frames and text", async () => {
    const plan = createDesignPlan({
      prompt: "یک برنامه فارسی با صفحه خانه و جزئیات طراحی کن.",
      target: "mobile",
      screenCount: 2,
      screenNames: ["Home", "Detail"],
      language: "fa",
      style: "",
    });
    if (!plan.success) throw new Error(plan.errors.join(" "));
    const label = {
      type: "text",
      name: "Editable Persian label",
      text: "خرید",
      palette: "text",
      width: 40,
      height: 20,
      fontSize: 16,
      fontStyle: "Regular",
      textAlign: "right",
      cornerRadius: 0,
      elevation: "none",
      layout: "none",
      gap: 0,
      padding: 0,
      qualityRole: "body",
      children: [],
    };
    const prepared = prepareGeneratedDesign(
      JSON.stringify({
        projectName: "RTL touch repair",
        palette: {
          brand: "#223344",
          accent: "#CC7744",
          page: "#F7F5F0",
          surface: "#FFFFFF",
          text: "#17212B",
          muted: "#647080",
          border: "#D8DEE6",
        },
        screens: plan.data.screens.map(({ id }) => ({
          id,
          children: [
            {
              ...label,
              type: "frame",
              name: `${id} button`,
              text: null,
              palette: "brand",
              qualityRole: "button",
              width: 40,
              height: 32,
              layout: "vertical",
              padding: 2,
              children: [{ ...label }],
            },
          ],
        })),
      }),
      plan.data,
    );
    if (!prepared.success) throw new Error(prepared.errors.join(" "));
    const result = await renderMultiScreenDesign(mock.api, prepared.data.batch, {
      resume: true,
      verifyTouchTargets: true,
    });
    expect(result).toMatchObject({ generatedScreens: 2, failedScreens: 0 });
    expect(mock.find("detail button")).toMatchObject({
      type: "FRAME",
      width: 44,
      height: 44,
      layoutMode: "VERTICAL",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "FIXED",
      paddingLeft: 2,
    });
    expect(mock.find("Editable Persian label")).toMatchObject({
      type: "TEXT",
      characters: "خرید",
      textAlignHorizontal: "RIGHT",
    });
    const roots = mock.roots.filter(
      (node) => node.getPluginData("fad.multi-screen.batch-id") === prepared.data.batch.id,
    );
    expect(roots).toHaveLength(2);
    const created = mock.allCreated.length;
    roots[0]!.x = 12345;
    const repeated = await renderMultiScreenDesign(mock.api, prepared.data.batch, {
      resume: true,
      verifyTouchTargets: true,
    });
    expect(repeated.generatedScreens).toBe(2);
    expect(mock.allCreated).toHaveLength(created);
    expect(roots[0]!.x).toBe(12345);
    roots[1]!.remove();
    const restored = await renderMultiScreenDesign(mock.api, prepared.data.batch, {
      resume: true,
      verifyTouchTargets: true,
    });
    expect(restored.generatedScreens).toBe(2);
    expect(
      mock.roots.filter(
        (node) => node.getPluginData("fad.multi-screen.batch-id") === prepared.data.batch.id,
      ),
    ).toHaveLength(2);
    const unsafe = structuredClone(prepared.data.batch);
    unsafe.id = "unsafe-native-hit-area";
    for (const screen of unsafe.screens) {
      const button = screen.children[0]!;
      if (button.type === "frame") button.height = 20;
    }
    const failed = await renderMultiScreenDesign(mock.api, unsafe, {
      resume: true,
      verifyTouchTargets: true,
    });
    expect(failed.generatedScreens).toBe(0);
    expect(failed.failedScreens).toBe(2);
    expect(
      mock.roots.some((node) => node.getPluginData("fad.multi-screen.batch-id") === unsafe.id),
    ).toBe(false);
    expect(mock.unrelated.removed).toBe(false);
  });

  it("carries a saved design through the typed bridge, reconciles restarts, and selects the cluster", async () => {
    const storage = new Map<string, unknown>();
    const metadata = new Map<string, string>();
    const api = {
      ...mock.api,
      fileKey: "test-file-key",
      root: {
        getPluginData: (key: string) => metadata.get(key) ?? "",
        setPluginData: (key: string, value: string) => metadata.set(key, value),
      },
      clientStorage: {
        getAsync: async (key: string) => storage.get(key),
        setAsync: async (key: string, value: unknown) => {
          storage.set(key, value);
        },
        deleteAsync: async (key: string) => {
          storage.delete(key);
        },
      },
    } as unknown as PluginAPI;
    Object.assign(api.currentPage, { id: "0:1" });
    let controller = createGenerationController(api);
    const context = await controller({ type: "generation-context", requestId: "context" });
    expect(PluginToUISchema.safeParse(context).success).toBe(true);
    if (context.type !== "generation-result" || !context.documentId)
      throw new Error("context missing");
    const { manifest, design } = draftFixture();
    manifest.documentId = context.documentId;
    const request = { type: "generation-render" as const, requestId: "render", manifest, design };
    expect(UIToPluginSchema.safeParse(request).success).toBe(true);
    expect(await controller(request)).toMatchObject({ success: true });
    const created = mock.allCreated.length;
    await controller({
      type: "generation-remember",
      requestId: "remember",
      generationId: manifest.generationId,
    });
    controller = createGenerationController(api);
    expect(await controller({ type: "generation-context", requestId: "reload" })).toMatchObject({
      generationId: manifest.generationId,
    });
    expect(await controller(request)).toMatchObject({ success: true });
    expect(mock.allCreated).toHaveLength(created);
    expect(
      await controller({
        ...request,
        requestId: "render-detail",
        design: { ...design, screens: [{ id: "detail", children: [] }] },
      }),
    ).toMatchObject({ success: true });
    expect(mock.find("02 — Detail")?.type).toBe("FRAME");
    expect(
      await controller({ ...request, manifest: { ...manifest, documentId: "another-document" } }),
    ).toMatchObject({ success: false });
    await controller({
      type: "generation-select",
      requestId: "select",
      generationId: manifest.generationId,
    });
    expect(mock.api.currentPage.selection).toHaveLength(2);
    expect(mock.raw.viewport.scrollAndZoomIntoView).toHaveBeenCalled();
  });

  it("creates a new named batch on repeat and reuses shared design-system assets", async () => {
    const first = await renderMultiScreenDesign(mock.api, phase4Sample);
    const firstRoots = mock.roots.filter((node) =>
      node.pluginData.has("fad.multi-screen.screen-id"),
    );
    const firstCoordinates = firstRoots.map(({ x, y }) => [x, y]);
    const masters = mock.allCreated.filter((node) => node.type === "COMPONENT");

    const second = await renderMultiScreenDesign(mock.api, phase4Sample);

    expect(second.generatedScreens).toBe(10);
    expect(second.designSystem?.created).toEqual([]);
    expect(second.designSystem?.reused).toHaveLength(19);
    expect(mock.raw.createComponentFromNode).toHaveBeenCalledTimes(4);
    expect(mock.paintStyles).toHaveLength(11);
    expect(mock.textStyles).toHaveLength(4);
    expect(
      mock.roots.filter((node) => node.pluginData.has("fad.multi-screen.screen-id")),
    ).toHaveLength(20);
    expect(firstRoots.map(({ x, y }) => [x, y])).toEqual(firstCoordinates);
    expect(masters.every((node) => !node.removed)).toBe(true);
    expect(first.generatedScreens).toBe(10);
  });

  it("renders 100 visual roots from one batch without overlap", async () => {
    const batch = {
      schemaVersion: "1.0.0",
      id: "stress-batch",
      name: "Stress Batch",
      screens: Array.from({ length: 100 }, (_, index) => ({
        id: `screen-${String(index).padStart(3, "0")}`,
        name: `Screen ${String(index).padStart(3, "0")}`,
        order: index,
        devicePreset: "custom" as const,
        width: index % 2 === 0 ? 390 : 834,
        height: 844 + (index % 3) * 100,
        background: "#FFFFFF",
        children: [
          {
            type: "rectangle" as const,
            name: `Surface ${index}`,
            x: 12,
            y: 12,
            width: Math.min(220, (index % 7) * 18 + 120),
            height: 72,
            fill: "#FFFFFF",
            constraints: { horizontal: "left-right", vertical: "bottom" },
            visual: {
              fills: [
                {
                  type: "linear" as const,
                  angle: -18,
                  stops: [
                    { position: 0, color: "#EFF6FF" },
                    { position: 1, color: "#D7EDFF" },
                  ],
                },
              ],
              effects: [
                {
                  type: "drop-shadow" as const,
                  color: "#123B5D",
                  opacity: 0.12,
                  offsetX: 0,
                  offsetY: 4,
                  radius: 12,
                  spread: 0,
                },
              ],
            },
          },
          {
            type: "vector" as const,
            name: `Icon ${index}`,
            x: 24,
            y: 28,
            width: 24,
            height: 24,
            pathData: "M 2 12 L 9 19 L 22 4 Z",
            fill: "#2563EB",
          },
        ],
      })),
    };
    const heapBefore = process.memoryUsage().heapUsed;
    let sampledHeapPeak = heapBefore;
    const startedAt = performance.now();
    const result = await renderMultiScreenDesign(mock.api, batch, {
      maxRowWidth: 6_000,
      onProgress: () => {
        sampledHeapPeak = Math.max(sampledHeapPeak, process.memoryUsage().heapUsed);
      },
    });
    const elapsedMs = performance.now() - startedAt;
    const sampledHeapPeakDeltaBytes = sampledHeapPeak - heapBefore;
    const sampledHeapPeakBytes = sampledHeapPeak;
    const roots = mock.roots.filter((node) => node.pluginData.has("fad.multi-screen.screen-id"));

    expect(Number.isFinite(elapsedMs)).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(sampledHeapPeakDeltaBytes).toBeLessThan(64 * 1_024 * 1_024);
    console.info(
      `VISUAL_BATCH_METRICS screens=100 generated=${result.generatedScreens} nodes=${result.createdNodeCount} elapsedMs=${elapsedMs.toFixed(1)} heapBeforeBytes=${heapBefore} sampledHeapPeakBytes=${sampledHeapPeakBytes} sampledHeapPeakDeltaBytes=${sampledHeapPeakDeltaBytes}`,
    );
    expect(result.generatedScreens).toBe(100);
    expect(result.screens).toHaveLength(100);
    expect(roots).toHaveLength(100);
    expect(result.counts.vectors).toBe(100);
    expect(result.counts.rectangles).toBe(100);
    for (let first = 0; first < roots.length; first++) {
      expect(
        boundsIntersectWithGap(
          {
            x: roots[first].x,
            y: roots[first].y,
            width: roots[first].width,
            height: roots[first].height,
          },
          {
            x: mock.unrelated.x,
            y: mock.unrelated.y,
            width: mock.unrelated.width,
            height: mock.unrelated.height,
          },
          DEFAULT_MIN_CANVAS_GAP,
        ),
      ).toBe(false);
      for (let second = first + 1; second < roots.length; second++) {
        expect(
          boundsIntersectWithGap(
            {
              x: roots[first].x,
              y: roots[first].y,
              width: roots[first].width,
              height: roots[first].height,
            },
            {
              x: roots[second].x,
              y: roots[second].y,
              width: roots[second].width,
              height: roots[second].height,
            },
            DEFAULT_MIN_CANVAS_GAP,
          ),
        ).toBe(false);
      }
    }
  });

  it("renders the 10-screen Phase 4.5 demo with native editable visuals", async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    let sampledHeapPeak = heapBefore;
    const startedAt = performance.now();
    const result = await renderMultiScreenDesign(mock.api, phase45VisualSample, {
      maxRowWidth: 6_000,
      onProgress: () => {
        sampledHeapPeak = Math.max(sampledHeapPeak, process.memoryUsage().heapUsed);
      },
    });
    const elapsedMs = performance.now() - startedAt;
    const sampledHeapPeakDeltaBytes = sampledHeapPeak - heapBefore;
    const sampledHeapPeakBytes = sampledHeapPeak;
    const screenRoots = mock.roots.filter((node) =>
      node.pluginData.has("fad.multi-screen.screen-id"),
    );
    const gradientSurface = mock.find("Promotional hero — layered editable art");
    const cardMaster = mock.find("apparel-core/product-card.basic");

    expect(result).toMatchObject({
      totalScreens: 10,
      generatedScreens: 10,
      failedScreens: 0,
      counts: {
        vectors: expect.any(Number),
        ellipses: expect.any(Number),
        instances: expect.any(Number),
      },
    });
    expect(screenRoots).toHaveLength(10);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(sampledHeapPeakDeltaBytes).toBeLessThan(64 * 1_024 * 1_024);
    console.info(
      `VISUAL_DEMO_METRICS screens=10 generated=${result.generatedScreens} nodes=${result.createdNodeCount} elapsedMs=${elapsedMs.toFixed(1)} heapBeforeBytes=${heapBefore} sampledHeapPeakBytes=${sampledHeapPeakBytes} sampledHeapPeakDeltaBytes=${sampledHeapPeakDeltaBytes}`,
    );
    expect(mock.raw.createVector).toHaveBeenCalled();
    expect(mock.raw.createEllipse).toHaveBeenCalled();
    expect(mock.raw.createComponentFromNode).toHaveBeenCalled();
    expect(gradientSurface?.fills.some((paint) => paint.type === "GRADIENT_LINEAR")).toBe(true);
    expect(cardMaster?.type).toBe("COMPONENT");
    expect(mock.allCreated.some((node) => node.mainComponent === cardMaster)).toBe(true);
    const firstScreenPositions = screenRoots.map(({ x, y }) => [x, y]);
    const firstComponentCount = mock.raw.createComponentFromNode.mock.calls.length;
    const second = await renderMultiScreenDesign(mock.api, phase45VisualSample, {
      maxRowWidth: 6_000,
    });
    expect(second.generatedScreens).toBe(10);
    expect(second.designSystem?.created).toEqual([]);
    expect(mock.raw.createComponentFromNode).toHaveBeenCalledTimes(firstComponentCount);
    expect(
      mock.roots
        .filter((node) => node.pluginData.has("fad.multi-screen.screen-id"))
        .slice(0, 10)
        .map(({ x, y }) => [x, y]),
    ).toEqual(firstScreenPositions);
  });

  it("deduplicates an embedded image and renders safe SVG as editable vector layers", async () => {
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      assets: [
        {
          id: "local-photo",
          name: "Local photo",
          kind: "raster",
          mimeType: "image/png",
          width: 1,
          height: 1,
          base64: ONE_PIXEL_PNG,
          license: "User supplied, rights confirmed",
          alt: "Test image",
        },
        {
          id: "local-photo-copy",
          name: "Duplicate local photo",
          kind: "raster",
          mimeType: "image/png",
          width: 1,
          height: 1,
          base64: ONE_PIXEL_PNG,
          license: "User supplied, rights confirmed",
          alt: "Duplicate test image",
        },
        {
          id: "local-icon",
          name: "Editable check",
          kind: "svg-paths",
          width: 24,
          height: 24,
          paths: [
            { name: "Check outline", data: "M 3 12 L 9 18 L 21 4 Z", fill: "#2563EB" },
            { name: "Inner mark", data: "M 5 5 L 8 8 L 12 3 Z", fill: "#123B5D" },
          ],
          license: "User supplied, rights confirmed",
        },
      ],
      document: {
        name: "Offline assets",
        width: 320,
        height: 240,
        background: "#FFFFFF",
        children: [
          {
            type: "image",
            name: "Photo one",
            assetId: "local-photo",
            x: 8,
            y: 8,
            width: 80,
            height: 80,
          },
          {
            type: "image",
            name: "Photo two",
            assetId: "local-photo-copy",
            fit: "crop",
            x: 100,
            y: 8,
            width: 80,
            height: 80,
          },
          {
            type: "image",
            name: "Editable icon",
            assetId: "local-icon",
            x: 200,
            y: 8,
            width: 48,
            height: 48,
          },
        ],
      },
    };

    const result = await renderDesign(mock.api, design);
    expect(mock.raw.createImage).toHaveBeenCalledTimes(1);
    expect(result.counts.images).toBe(2);
    expect(result.counts.vectors).toBe(2);
    expect(result.counts.frames).toBe(2);
    expect(mock.find("Photo one")?.fills).toEqual([
      { type: "IMAGE", imageHash: "mock-image-hash", scaleMode: "FILL" },
    ]);
    expect(mock.find("Photo two")?.fills).toEqual([
      { type: "IMAGE", imageHash: "mock-image-hash", scaleMode: "CROP" },
    ]);
    expect(mock.find("Editable icon")?.children.map((child) => child.type)).toEqual([
      "VECTOR",
      "VECTOR",
    ]);
  });

  it("does not create visible layers when Figma rejects an embedded image", async () => {
    mock.raw.createImage.mockImplementation(() => {
      throw new Error("Figma rejected mock image bytes");
    });
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      assets: [
        {
          id: "local-photo",
          name: "Local photo",
          kind: "raster",
          mimeType: "image/png",
          width: 1,
          height: 1,
          base64: ONE_PIXEL_PNG,
          license: "User supplied, rights confirmed",
        },
      ],
      document: {
        name: "Image failure",
        width: 320,
        height: 240,
        background: "#FFFFFF",
        children: [
          {
            type: "image",
            name: "Photo",
            assetId: "local-photo",
            x: 8,
            y: 8,
            width: 80,
            height: 80,
          },
        ],
      },
    };
    await expect(renderDesign(mock.api, design)).rejects.toThrow("Figma rejected mock image bytes");
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.unrelated.removed).toBe(false);
  });

  it("maps gradient paint, alpha, strokes, blend mode and effects to native Figma properties", async () => {
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Paint and effect fixture",
        width: 200,
        height: 160,
        background: "#FFFFFF",
        children: [
          {
            type: "rectangle",
            name: "Styled native surface",
            x: 10,
            y: 10,
            width: 100,
            height: 80,
            fill: "#FFFFFF",
            constraints: { horizontal: "left-right", vertical: "bottom" },
            visual: {
              fills: [
                {
                  type: "linear",
                  angle: 45,
                  opacity: 0.8,
                  stops: [
                    { position: 0, color: "#123B5D" },
                    { position: 1, color: "#2563EB" },
                  ],
                },
              ],
              opacity: 0.9,
              strokes: [{ color: "#E2E8F0", width: 2, align: "inside", dashPattern: [4, 2] }],
              effects: [
                {
                  type: "drop-shadow",
                  color: "#123B5D",
                  opacity: 0.2,
                  offsetX: 1,
                  offsetY: 5,
                  radius: 12,
                  spread: 0,
                },
                {
                  type: "inner-shadow",
                  color: "#0F172A",
                  opacity: 0.1,
                  offsetX: 0,
                  offsetY: 1,
                  radius: 2,
                  spread: 0,
                },
                { type: "layer-blur", radius: 1 },
              ],
              blendMode: "screen",
            },
          },
        ],
      },
    };
    await renderDesign(mock.api, design);
    const surface = mock.find("Styled native surface") as MockNode & {
      opacity: number;
      blendMode: BlendMode;
      strokeWeight: number;
      strokeAlign: string;
      dashPattern: number[];
      effects: Effect[];
      constraints: Constraints;
    };
    expect(surface.fills[0]).toMatchObject({ type: "GRADIENT_LINEAR", opacity: 0.8 });
    expect(surface.opacity).toBe(0.9);
    expect(surface.blendMode).toBe("SCREEN");
    expect(surface.strokeWeight).toBe(2);
    expect(surface.strokeAlign).toBe("INSIDE");
    expect(surface.dashPattern).toEqual([4, 2]);
    expect(surface.effects.map((effect: Effect) => effect.type)).toEqual([
      "DROP_SHADOW",
      "INNER_SHADOW",
      "LAYER_BLUR",
    ]);
    expect(surface.constraints).toEqual({ horizontal: "STRETCH", vertical: "MAX" });
  });

  it("preserves visual text paint after applying the linked native Text Style", async () => {
    const design = structuredClone(phase3Sample) as unknown as DesignSpec;
    const heading = design.document.children.find((node) => node.type === "text");
    if (!heading || heading.type !== "text") throw new Error("Phase 3 preview heading is missing.");
    heading.visual = {
      fills: [
        {
          type: "linear",
          angle: 0,
          stops: [
            { position: 0, color: "#123B5D" },
            { position: 1, color: "#2563EB" },
          ],
        },
      ],
    };
    await renderDesign(mock.api, design);
    const rendered = mock.find("Preview Heading") as MockNode & { textStyleId?: string };
    expect(rendered.textStyleId).toBeTruthy();
    expect(rendered.fills[0]).toMatchObject({ type: "GRADIENT_LINEAR" });
  });

  it("cleans only a failed screen and continues the remaining batch", async () => {
    const originalCreateText = mock.raw.createText.getMockImplementation();
    if (!originalCreateText) throw new Error("Mock text factory is missing.");
    let textCalls = 0;
    let failedOnce = false;
    mock.raw.createText.mockImplementation(() => {
      textCalls++;
      if (textCalls === 7 && !failedOnce) {
        failedOnce = true;
        throw new Error("Mock failure in first screen.");
      }
      return originalCreateText();
    });
    const originalPosition = { x: mock.unrelated.x, y: mock.unrelated.y };

    const result = await renderMultiScreenDesign(mock.api, phase4Sample);

    expect(result.generatedScreens).toBe(9);
    expect(result.failedScreens).toBe(1);
    expect(result.screens[0].status).toBe("failed");
    expect(result.screens[0].error).toContain("Mock failure in first screen");
    expect(mock.unrelated).toMatchObject({ ...originalPosition, removed: false });
    expect(
      mock.roots.filter((node) => node.pluginData.has("fad.multi-screen.screen-id")),
    ).toHaveLength(9);
    expect(mock.textStyles).toHaveLength(4);
    expect(mock.paintStyles).toHaveLength(11);
  });

  it("rolls back shared assets when every screen fails before commit", async () => {
    const originalCreateText = mock.raw.createText.getMockImplementation();
    if (!originalCreateText) throw new Error("Mock text factory is missing.");
    let textCalls = 0;
    mock.raw.createText.mockImplementation(() => {
      textCalls++;
      if (textCalls > 6) throw new Error("Every screen text creation failed.");
      return originalCreateText();
    });

    const result = await renderMultiScreenDesign(mock.api, phase4Sample);

    expect(result.generatedScreens).toBe(0);
    expect(result.failedScreens).toBe(10);
    expect(result.createdNodeCount).toBe(0);
    expect(result.screens).toHaveLength(10);
    expect(result.screens.every((screen) => screen.status === "failed")).toBe(true);
    expect(result.designSystem?.created).toEqual([]);
    expect(result.warnings.join(" ")).toContain("rolled back");
    expect(mock.roots).toEqual([mock.unrelated]);
    expect(mock.unrelated.removed).toBe(false);
    expect(mock.paintStyles).toEqual([]);
    expect(mock.textStyles).toEqual([]);
  });
});
