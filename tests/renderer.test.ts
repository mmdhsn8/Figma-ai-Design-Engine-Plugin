import { beforeEach, describe, expect, it, vi } from "vitest";
import phase1Sample from "../src/samples/sample-design.json";
import storefront from "../src/samples/phase-2-storefront.json";
import phase3Sample from "../src/samples/phase-3-design-system.json";
import {
  mapLayoutSpec,
  mapSizingMode,
  renderDesign,
  type RendererFigmaApi,
} from "../src/plugin/renderer";
import { parseDesignValue, type DesignSpec } from "../src/shared/schema";

interface MockNode {
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
});
