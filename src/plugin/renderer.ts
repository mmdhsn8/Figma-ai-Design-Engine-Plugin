import type {
  AxisSizing,
  ComponentDefinitionSpec,
  DesignCounts,
  DesignNode,
  DesignSpec,
  FrameNodeSpec,
  LayoutSpec,
  RectangleNodeSpec,
  SizingMode,
  TextNodeSpec,
} from "../shared/schema";
import { orderComponentDefinitions, parseDesignValue } from "../shared/schema";
import type { FontSelection } from "../shared/messages";
import { hexToRgb } from "./figma-utils";

export type RendererFigmaApi = Pick<
  PluginAPI,
  | "createFrame"
  | "createText"
  | "createRectangle"
  | "createComponentFromNode"
  | "listAvailableFontsAsync"
  | "loadFontAsync"
> & {
  currentPage: Pick<PluginAPI["currentPage"], "selection" | "findAll">;
  viewport: Pick<PluginAPI["viewport"], "center" | "scrollAndZoomIntoView">;
};

export interface RenderResult {
  frameName: string;
  counts: DesignCounts;
  warnings: string[];
  fontSelections: FontSelection[];
}

export class DesignRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesignRenderError";
  }
}

interface LayoutMapping {
  mode: "HORIZONTAL" | "VERTICAL";
  primaryAxisAlignItems: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems: "MIN" | "CENTER" | "MAX" | "BASELINE";
  stretchChildren: boolean;
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
}

type LayoutChildNode = TextNode | RectangleNode | FrameNode | InstanceNode | ComponentNode;

interface FontResolution {
  fonts: Map<string, FontName>;
  selections: FontSelection[];
  warnings: string[];
}

interface Tracker {
  nodes: SceneNode[];
  counts: DesignCounts;
  track(node: SceneNode, kind: keyof DesignCounts): void;
  replace(
    oldNode: SceneNode,
    newNode: SceneNode,
    oldKind: keyof DesignCounts,
    newKind: keyof DesignCounts,
  ): void;
  cleanup(): void;
}

function createTracker(): Tracker {
  const nodes: SceneNode[] = [];
  const counts: DesignCounts = { frames: 0, texts: 0, rectangles: 0, components: 0, instances: 0 };
  return {
    nodes,
    counts,
    track(node, kind) {
      nodes.push(node);
      counts[kind]++;
    },
    replace(oldNode, newNode, oldKind, newKind) {
      if (!nodes.includes(oldNode)) nodes.push(oldNode);
      nodes.push(newNode);
      counts[oldKind]--;
      counts[newKind]++;
    },
    cleanup() {
      for (const node of [...nodes].reverse()) {
        try {
          node.remove();
        } catch {
          // A parent may already have removed this tracked child.
        }
      }
    },
  };
}

function fontKey(family: string, style: string): string {
  return `${family}\u0000${style}`;
}

function collectTextNodes(spec: DesignSpec): TextNodeSpec[] {
  const texts: TextNodeSpec[] = [];
  const visit = (nodes: DesignNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") texts.push(node);
      else if (node.type === "frame") visit(node.children);
    }
  };
  visit(spec.document.children);
  for (const component of spec.document.components ?? []) visit(component.children);
  return texts;
}

async function resolveFonts(api: RendererFigmaApi, spec: DesignSpec): Promise<FontResolution> {
  const available = await api.listAvailableFontsAsync();
  const availableByKey = new Map(
    available.map((font) => [fontKey(font.fontName.family, font.fontName.style), font.fontName]),
  );
  const requested = new Map<string, { family: string; style: string }>();
  for (const node of collectTextNodes(spec)) {
    const family = node.fontFamily ?? "Inter";
    const style = node.fontStyle ?? "Regular";
    requested.set(fontKey(family, style), { family, style });
  }

  const fonts = new Map<string, FontName>();
  const selections: FontSelection[] = [];
  const warnings: string[] = [];
  const fallback = availableByKey.get(fontKey("Inter", "Regular")) ?? {
    family: "Inter",
    style: "Regular",
  };

  for (const [key, request] of requested) {
    const exact = availableByKey.get(key);
    let chosen = exact ?? fallback;
    let fellBack = !exact;
    try {
      await api.loadFontAsync(chosen);
    } catch (error) {
      if (fellBack) {
        throw new DesignRenderError(
          `Figma could not load the requested font “${request.family} ${request.style}” or the Inter Regular fallback. Make Inter available in Figma Desktop and try again.`,
          { cause: error },
        );
      }
      try {
        await api.loadFontAsync(fallback);
        chosen = fallback;
        fellBack = true;
      } catch (fallbackError) {
        throw new DesignRenderError(
          `Figma could not load “${request.family} ${request.style}” or the Inter Regular fallback. Make Inter available in Figma Desktop and try again.`,
          { cause: fallbackError },
        );
      }
    }
    fonts.set(key, chosen);
    selections.push({
      requestedFamily: request.family,
      requestedStyle: request.style,
      usedFamily: chosen.family,
      usedStyle: chosen.style,
      fellBack,
    });
    if (fellBack) {
      warnings.push(
        `Font “${request.family} ${request.style}” is unavailable; used “${chosen.family} ${chosen.style}”.`,
      );
    }
  }
  return { fonts, selections, warnings };
}

export function mapSizingMode(mode: SizingMode): "FIXED" | "HUG" | "FILL" {
  return mode.toUpperCase() as "FIXED" | "HUG" | "FILL";
}

export function mapLayoutSpec(layout: LayoutSpec): LayoutMapping {
  const primary: Record<
    NonNullable<LayoutSpec["primaryAxisAlign"]>,
    LayoutMapping["primaryAxisAlignItems"]
  > = {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    "space-between": "SPACE_BETWEEN",
  };
  const counter: Record<
    Exclude<NonNullable<LayoutSpec["counterAxisAlign"]>, "stretch">,
    LayoutMapping["counterAxisAlignItems"]
  > = {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    baseline: "BASELINE",
  };
  const counterAxisAlign = layout.counterAxisAlign ?? "start";
  return {
    mode: layout.mode === "vertical" ? "VERTICAL" : "HORIZONTAL",
    primaryAxisAlignItems: primary[layout.primaryAxisAlign ?? "start"],
    counterAxisAlignItems: counterAxisAlign === "stretch" ? "MIN" : counter[counterAxisAlign],
    stretchChildren: counterAxisAlign === "stretch",
    itemSpacing: layout.gap ?? 0,
    paddingTop: layout.padding?.top ?? 0,
    paddingRight: layout.padding?.right ?? 0,
    paddingBottom: layout.padding?.bottom ?? 0,
    paddingLeft: layout.padding?.left ?? 0,
  };
}

function setSolidFill(node: { fills: readonly Paint[] | PluginAPI["mixed"] }, hex: string): void {
  node.fills = [{ type: "SOLID", color: hexToRgb(hex) }];
}

function setOptionalFill(
  node: { fills: readonly Paint[] | PluginAPI["mixed"] },
  hex?: string,
): void {
  node.fills = hex ? [{ type: "SOLID", color: hexToRgb(hex) }] : [];
}

function applyLayout(
  frame: FrameNode | ComponentNode,
  layout: LayoutSpec,
  width: number,
  height: number,
): LayoutMapping {
  const mapping = mapLayoutSpec(layout);
  frame.resize(width, height);
  frame.layoutMode = mapping.mode;
  frame.resize(width, height);
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  frame.primaryAxisAlignItems = mapping.primaryAxisAlignItems;
  frame.counterAxisAlignItems = mapping.counterAxisAlignItems;
  frame.itemSpacing = mapping.itemSpacing;
  frame.paddingTop = mapping.paddingTop;
  frame.paddingRight = mapping.paddingRight;
  frame.paddingBottom = mapping.paddingBottom;
  frame.paddingLeft = mapping.paddingLeft;
  return mapping;
}

function effectiveSizing(node: DesignNode, parentLayout: LayoutSpec): AxisSizing {
  if (node.sizing) return node.sizing;
  const isText = node.type === "text";
  const width: SizingMode = isText && node.width === undefined ? "hug" : "fixed";
  const height: SizingMode = isText && node.height === undefined ? "hug" : "fixed";
  if (parentLayout.counterAxisAlign !== "stretch") return { width, height };
  return parentLayout.mode === "vertical" ? { width: "fill", height } : { width, height: "fill" };
}

function applyChildSizing(node: LayoutChildNode, sizing: AxisSizing, layout: LayoutSpec): void {
  node.layoutSizingHorizontal = mapSizingMode(sizing.width);
  node.layoutSizingVertical = mapSizingMode(sizing.height);
  if (layout.counterAxisAlign === "stretch") node.layoutAlign = "STRETCH";
}

function setTextTypography(
  node: TextNodeSpec,
  text: TextNode,
  fonts: Map<string, FontName>,
  parentLayout?: LayoutSpec,
): void {
  const family = node.fontFamily ?? "Inter";
  const style = node.fontStyle ?? "Regular";
  const font = fonts.get(fontKey(family, style));
  if (!font) throw new DesignRenderError(`No resolved font for “${family} ${style}”.`);

  text.fontName = font;
  text.fontSize = node.fontSize;
  text.characters = node.text;
  if (node.lineHeight !== undefined) text.lineHeight = { unit: "PIXELS", value: node.lineHeight };
  if (node.textAlign)
    text.textAlignHorizontal = node.textAlign.toUpperCase() as TextNode["textAlignHorizontal"];

  const widthMode = node.sizing?.width ?? (node.width === undefined ? undefined : "fixed");
  const autoResize =
    node.textAutoResize ??
    (widthMode === "fill" ||
    (parentLayout?.mode === "vertical" && parentLayout.counterAxisAlign === "stretch")
      ? "height"
      : node.width !== undefined && node.height !== undefined
        ? "truncate"
        : node.width !== undefined
          ? "height"
          : "width-and-height");
  const resizeModes = {
    "width-and-height": "WIDTH_AND_HEIGHT",
    height: "HEIGHT",
    truncate: "TRUNCATE",
  } as const;
  text.textAutoResize = resizeModes[autoResize];
  if (node.width !== undefined || node.height !== undefined) {
    text.resize(node.width ?? text.width, node.height ?? text.height);
  }
  setSolidFill(text, node.color);
}

function setRectangleProperties(rectangle: RectangleNode, node: RectangleNodeSpec): void {
  rectangle.resize(node.width, node.height);
  setSolidFill(rectangle, node.fill);
  if (node.stroke) {
    rectangle.strokes = [{ type: "SOLID", color: hexToRgb(node.stroke.color) }];
    rectangle.strokeWeight = node.stroke.width ?? 1;
  } else {
    rectangle.strokes = [];
  }
  if (node.cornerRadii) {
    rectangle.topLeftRadius = node.cornerRadii.topLeft;
    rectangle.topRightRadius = node.cornerRadii.topRight;
    rectangle.bottomRightRadius = node.cornerRadii.bottomRight;
    rectangle.bottomLeftRadius = node.cornerRadii.bottomLeft;
  } else if (node.cornerRadius !== undefined) {
    rectangle.cornerRadius = node.cornerRadius;
  }
}

function setFrameProperties(
  frame: FrameNode | ComponentNode,
  properties: Pick<FrameNodeSpec, "background" | "stroke" | "cornerRadius" | "cornerRadii">,
): void {
  setOptionalFill(frame, properties.background);
  if (properties.stroke) {
    frame.strokes = [{ type: "SOLID", color: hexToRgb(properties.stroke.color) }];
    frame.strokeWeight = properties.stroke.width ?? 1;
  } else {
    frame.strokes = [];
  }
  if (properties.cornerRadii) {
    frame.topLeftRadius = properties.cornerRadii.topLeft;
    frame.topRightRadius = properties.cornerRadii.topRight;
    frame.bottomRightRadius = properties.cornerRadii.bottomRight;
    frame.bottomLeftRadius = properties.cornerRadii.bottomLeft;
  } else if (properties.cornerRadius !== undefined) {
    frame.cornerRadius = properties.cornerRadius;
  }
}

interface BuildContext {
  api: RendererFigmaApi;
  tracker: Tracker;
  fonts: Map<string, FontName>;
  components: Map<string, ComponentNode>;
}

function buildFrameChildren(frame: FrameNode, spec: FrameNodeSpec, context: BuildContext): void {
  for (const child of spec.children) appendDesignNode(frame, child, spec.layout, context);
}

function appendDesignNode(
  parent: FrameNode | ComponentNode,
  spec: DesignNode,
  parentLayout: LayoutSpec | undefined,
  context: BuildContext,
): LayoutChildNode {
  const { api, tracker } = context;
  let node: LayoutChildNode;
  let frameToPopulate: FrameNode | undefined;

  if (spec.type === "text") {
    const text = api.createText();
    tracker.track(text, "texts");
    text.name = spec.name;
    setTextTypography(spec, text, context.fonts, parentLayout);
    node = text;
  } else if (spec.type === "rectangle") {
    const rectangle = api.createRectangle();
    tracker.track(rectangle, "rectangles");
    rectangle.name = spec.name;
    setRectangleProperties(rectangle, spec);
    node = rectangle;
  } else if (spec.type === "frame") {
    const frame = api.createFrame();
    tracker.track(frame, "frames");
    frame.name = spec.name;
    frame.resize(spec.width, spec.height);
    setFrameProperties(frame, spec);
    if (spec.layout) applyLayout(frame, spec.layout, spec.width, spec.height);
    frameToPopulate = frame;
    node = frame;
  } else {
    const component = context.components.get(spec.componentId);
    if (!component)
      throw new DesignRenderError(
        `Component “${spec.componentId}” was not built before its instance.`,
      );
    const instance = component.createInstance();
    tracker.track(instance, "instances");
    if (spec.name) instance.name = spec.name;
    node = instance;
  }

  parent.appendChild(node);
  if (parentLayout) {
    applyChildSizing(node, effectiveSizing(spec, parentLayout), parentLayout);
  } else {
    node.x = spec.x as number;
    node.y = spec.y as number;
  }
  if (frameToPopulate) buildFrameChildren(frameToPopulate, spec as FrameNodeSpec, context);
  return node;
}

function createComponentDefinition(
  area: FrameNode,
  definition: ComponentDefinitionSpec,
  name: string,
  context: BuildContext,
): ComponentNode {
  const frame = context.api.createFrame();
  context.tracker.track(frame, "frames");
  frame.name = name;
  frame.resize(definition.width, definition.height);
  setFrameProperties(frame, definition);
  if (definition.layout) applyLayout(frame, definition.layout, definition.width, definition.height);
  area.appendChild(frame);
  for (const child of definition.children)
    appendDesignNode(frame, child, definition.layout, context);

  const component = context.api.createComponentFromNode(frame);
  context.tracker.replace(frame, component, "frames", "components");
  applyChildSizing(component, definition.sizing ?? { width: "fixed", height: "fixed" }, {
    mode: "vertical",
    counterAxisAlign: "center",
  });
  context.components.set(definition.id, component);
  return component;
}

function uniqueName(api: RendererFigmaApi, base: string, reserved: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (
    reserved.has(candidate) ||
    api.currentPage.findAll((node) => node.name === candidate).length > 0
  ) {
    candidate = `${base} (${suffix++})`;
  }
  reserved.add(candidate);
  return candidate;
}

function createDocumentFrame(
  api: RendererFigmaApi,
  spec: DesignSpec,
  name: string,
  context: BuildContext,
  parent?: FrameNode,
): FrameNode {
  const frame = api.createFrame();
  context.tracker.track(frame, "frames");
  frame.name = name;
  frame.resize(spec.document.width, spec.document.height);
  setSolidFill(frame, spec.document.background);
  if (spec.document.layout)
    applyLayout(frame, spec.document.layout, spec.document.width, spec.document.height);
  parent?.appendChild(frame);
  for (const child of spec.document.children) {
    appendDesignNode(frame, child, spec.document.layout, context);
  }
  return frame;
}

function createComponentArea(api: RendererFigmaApi, tracker: Tracker, name: string): FrameNode {
  const area = api.createFrame();
  tracker.track(area, "frames");
  area.name = name;
  area.resize(390, 160);
  setSolidFill(area, "#EFF6FF");
  applyLayout(
    area,
    {
      mode: "vertical",
      gap: 18,
      padding: { top: 18, right: 16, bottom: 18, left: 16 },
      primaryAxisAlign: "start",
      counterAxisAlign: "center",
    },
    390,
    160,
  );
  area.primaryAxisSizingMode = "AUTO";
  return area;
}

function createWrapper(api: RendererFigmaApi, tracker: Tracker, name: string): FrameNode {
  const wrapper = api.createFrame();
  tracker.track(wrapper, "frames");
  wrapper.name = name;
  wrapper.resize(600, 844);
  wrapper.fills = [];
  return wrapper;
}

export async function renderDesign(api: RendererFigmaApi, input: unknown): Promise<RenderResult> {
  const parsed = parseDesignValue(input);
  if (!parsed.success) throw new DesignRenderError(parsed.errors.join(" "));
  const spec = parsed.data;
  const fontResolution = await resolveFonts(api, spec);
  const tracker = createTracker();
  const previousSelection = [...api.currentPage.selection];
  const context: BuildContext = {
    api,
    tracker,
    fonts: fontResolution.fonts,
    components: new Map(),
  };
  const reservedNames = new Set<string>();
  const components = spec.document.components ?? [];

  try {
    let root: FrameNode;
    let documentFrameName: string;
    if (components.length === 0) {
      documentFrameName = uniqueName(api, spec.document.name, reservedNames);
      root = createDocumentFrame(api, spec, documentFrameName, context);
    } else {
      const wrapper = createWrapper(
        api,
        tracker,
        uniqueName(api, `Generated — ${spec.document.name}`, reservedNames),
      );
      const componentArea = createComponentArea(
        api,
        tracker,
        uniqueName(api, `Components — ${spec.document.name}`, reservedNames),
      );
      wrapper.appendChild(componentArea);
      componentArea.x = spec.document.width + 56;
      componentArea.y = 0;

      for (const definition of orderComponentDefinitions(components)) {
        createComponentDefinition(
          componentArea,
          definition,
          uniqueName(api, `${definition.name} — Generated`, reservedNames),
          context,
        );
      }

      documentFrameName = uniqueName(api, spec.document.name, reservedNames);
      root = createDocumentFrame(api, spec, documentFrameName, context, wrapper);
      root.x = 0;
      root.y = 0;
      wrapper.resize(
        spec.document.width + 56 + componentArea.width,
        Math.max(spec.document.height, componentArea.height),
      );
      root = wrapper;
    }

    root.x = Math.round(api.viewport.center.x - root.width / 2);
    root.y = Math.round(api.viewport.center.y - root.height / 2);
    api.currentPage.selection = [root];
    api.viewport.scrollAndZoomIntoView([root]);
    return {
      frameName: documentFrameName,
      counts: tracker.counts,
      warnings: fontResolution.warnings,
      fontSelections: fontResolution.selections,
    };
  } catch (error) {
    tracker.cleanup();
    try {
      api.currentPage.selection = previousSelection;
    } catch {
      // Preserve the original rendering error if the page is no longer writable.
    }
    throw new DesignRenderError(
      `Figma could not finish creating the design. ${error instanceof Error ? error.message : "Check the document and try again."}`,
      { cause: error },
    );
  }
}
