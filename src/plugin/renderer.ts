import type {
  AxisSizing,
  ComponentDefinitionSpec,
  DesignCounts,
  SizingMode,
} from "../shared/schema";
import { orderComponentDefinitions, parseDesignValue } from "../shared/schema";
import type { FontSelection } from "../shared/messages";
import { planCanvasPlacements, type CanvasBounds, type PlacementItem } from "./canvas-placement";
import {
  getCanvasNodeBounds,
  placeTopLevelNode,
  readTopLevelCanvasObstacles,
} from "./figma-canvas-adapter";
import { hexToRgb } from "./figma-utils";
import {
  resolveDesignSystemTokens,
  type ResolvedComponentDefinition,
  type ResolvedDesignNode,
  type ResolvedDesignSpec,
  type ResolvedFrameNodeSpec,
  type ResolvedLayoutSpec,
  type ResolvedRectangleNodeSpec,
  type ResolvedTextNodeSpec,
} from "./design-system/token-resolver";
import {
  createOrReuseNativeStyles,
  type StyleBindings,
  type StyleRegistryReport,
} from "./design-system/style-registry";
import {
  COMPONENT_FINGERPRINT_KEY,
  componentDefinitionFingerprint,
  markOwnedComponent,
  readOwnedComponents,
} from "./design-system/component-registry";
import { inspectVariableCapability } from "./design-system/variable-adapter";

export type RendererFigmaApi = Pick<
  PluginAPI,
  | "createFrame"
  | "createText"
  | "createRectangle"
  | "createComponentFromNode"
  | "createPaintStyle"
  | "createTextStyle"
  | "getLocalPaintStylesAsync"
  | "getLocalTextStylesAsync"
  | "listAvailableFontsAsync"
  | "loadFontAsync"
> & {
  currentPage: Pick<PluginAPI["currentPage"], "children" | "selection" | "findAll">;
  viewport: Pick<PluginAPI["viewport"], "scrollAndZoomIntoView">;
  variables?: Pick<PluginAPI["variables"], "createVariableCollection">;
};

export interface RenderResult {
  frameName: string;
  counts: DesignCounts;
  warnings: string[];
  fontSelections: FontSelection[];
  designSystem?: {
    namespace: string;
    created: string[];
    reused: string[];
    updated: string[];
    skipped: string[];
    fallbacks: string[];
    warnings: string[];
  };
}

export class DesignRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesignRenderError";
  }
}

const COMPONENT_AREA_WIDTH = 390;
const COMPONENT_AREA_GAP = 18;
const COMPONENT_AREA_VERTICAL_PADDING = 36;
const COMPONENT_AREA_OFFSET = 56;
const TYPOGRAPHY_TOKEN_KEY = "fad.design-system.typography-token";
const TYPOGRAPHY_OVERRIDES_KEY = "fad.design-system.typography-overrides";
const TEXT_COLOR_KEY = "fad.design-system.text-color";

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
  typographyFonts: Map<string, FontName>;
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

function collectTextNodes(spec: ResolvedDesignSpec): ResolvedTextNodeSpec[] {
  const texts: ResolvedTextNodeSpec[] = [];
  const visit = (nodes: ResolvedDesignNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") texts.push(node);
      else if (node.type === "frame") visit(node.children);
    }
  };
  visit(spec.document.children);
  for (const component of [
    ...(spec.document.components ?? []),
    ...(spec.designSystem?.components ?? []),
  ])
    visit(component.children);
  return texts;
}

async function resolveFonts(
  api: RendererFigmaApi,
  spec: ResolvedDesignSpec,
  typography: ReadonlyMap<string, { fontFamily: string; fontStyle: string }>,
): Promise<FontResolution> {
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
  for (const token of typography.values()) {
    requested.set(fontKey(token.fontFamily, token.fontStyle), {
      family: token.fontFamily,
      style: token.fontStyle,
    });
  }

  const fonts = new Map<string, FontName>();
  const typographyFonts = new Map<string, FontName>();
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
    for (const [token, typographyToken] of typography) {
      if (fontKey(typographyToken.fontFamily, typographyToken.fontStyle) === key) {
        typographyFonts.set(token, chosen);
      }
    }
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
  return { fonts, typographyFonts, selections, warnings };
}

export function mapSizingMode(mode: SizingMode): "FIXED" | "HUG" | "FILL" {
  return mode.toUpperCase() as "FIXED" | "HUG" | "FILL";
}

export function mapLayoutSpec(layout: ResolvedLayoutSpec): LayoutMapping {
  const primary: Record<
    NonNullable<ResolvedLayoutSpec["primaryAxisAlign"]>,
    LayoutMapping["primaryAxisAlignItems"]
  > = {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    "space-between": "SPACE_BETWEEN",
  };
  const counter: Record<
    Exclude<NonNullable<ResolvedLayoutSpec["counterAxisAlign"]>, "stretch">,
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
  layout: ResolvedLayoutSpec,
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

function effectiveSizing(node: ResolvedDesignNode, parentLayout: ResolvedLayoutSpec): AxisSizing {
  if (node.sizing) return node.sizing;
  const isText = node.type === "text";
  const width: SizingMode = isText && node.width === undefined ? "hug" : "fixed";
  const height: SizingMode = isText && node.height === undefined ? "hug" : "fixed";
  if (parentLayout.counterAxisAlign !== "stretch") return { width, height };
  return parentLayout.mode === "vertical" ? { width: "fill", height } : { width, height: "fill" };
}

function applyChildSizing(
  node: LayoutChildNode,
  sizing: AxisSizing,
  layout: ResolvedLayoutSpec,
): void {
  node.layoutSizingHorizontal = mapSizingMode(sizing.width);
  node.layoutSizingVertical = mapSizingMode(sizing.height);
  if (layout.counterAxisAlign === "stretch") node.layoutAlign = "STRETCH";
}

function setTextTypography(
  node: ResolvedTextNodeSpec,
  text: TextNode,
  fonts: Map<string, FontName>,
  parentLayout?: ResolvedLayoutSpec,
): void {
  const family = node.fontFamily ?? "Inter";
  const style = node.fontStyle ?? "Regular";
  const font = fonts.get(fontKey(family, style));
  if (!font) throw new DesignRenderError(`No resolved font for “${family} ${style}”.`);

  text.fontName = font;
  text.fontSize = node.fontSize;
  text.characters = node.text;
  if (node.lineHeight !== undefined) text.lineHeight = { unit: "PIXELS", value: node.lineHeight };
  if (node.letterSpacing !== undefined)
    text.letterSpacing = { unit: "PIXELS", value: node.letterSpacing };
  if (node.textDecoration)
    text.textDecoration = node.textDecoration.toUpperCase() as TextNode["textDecoration"];
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
  if (node.textStyle) {
    text.setPluginData(TYPOGRAPHY_TOKEN_KEY, node.textStyle.token);
    text.setPluginData(TEXT_COLOR_KEY, node.color);
    if (
      node.styleOverrides &&
      Object.values(node.styleOverrides).some((value) => value !== undefined)
    ) {
      const styleOverrides = {
        ...node.styleOverrides,
        fontName: node.styleOverrides.fontName
          ? { family: font.family, style: font.style }
          : undefined,
      };
      text.setPluginData(TYPOGRAPHY_OVERRIDES_KEY, JSON.stringify(styleOverrides));
    }
  }
}

function setRectangleProperties(rectangle: RectangleNode, node: ResolvedRectangleNodeSpec): void {
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
  properties: Pick<ResolvedFrameNodeSpec, "background" | "stroke" | "cornerRadius" | "cornerRadii">,
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
  designSystemId?: string;
  designSystemNamespace?: string;
}

function buildFrameChildren(
  frame: FrameNode,
  spec: ResolvedFrameNodeSpec,
  context: BuildContext,
): void {
  for (const child of spec.children) appendDesignNode(frame, child, spec.layout, context);
}

function appendDesignNode(
  parent: FrameNode | ComponentNode,
  spec: ResolvedDesignNode,
  parentLayout: ResolvedLayoutSpec | undefined,
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
  if (frameToPopulate) buildFrameChildren(frameToPopulate, spec as ResolvedFrameNodeSpec, context);
  return node;
}

function createComponentDefinition(
  area: FrameNode,
  definition: ResolvedComponentDefinition,
  name: string,
  context: BuildContext,
  ownedByDesignSystem = false,
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
  if (ownedByDesignSystem && context.designSystemId) {
    markOwnedComponent(component, context.designSystemId, definition);
  }
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
  spec: ResolvedDesignSpec,
  name: string,
  context: BuildContext,
  parent?: FrameNode,
  position?: Pick<CanvasBounds, "x" | "y">,
): FrameNode {
  const frame = api.createFrame();
  context.tracker.track(frame, "frames");
  frame.name = name;
  frame.resize(spec.document.width, spec.document.height);
  frame.x = position?.x ?? 0;
  frame.y = position?.y ?? 0;
  setSolidFill(frame, spec.document.background);
  if (spec.document.layout)
    applyLayout(frame, spec.document.layout, spec.document.width, spec.document.height);
  parent?.appendChild(frame);
  for (const child of spec.document.children) {
    appendDesignNode(frame, child, spec.document.layout, context);
  }
  return frame;
}

function createComponentArea(
  api: RendererFigmaApi,
  tracker: Tracker,
  name: string,
  width: number,
): FrameNode {
  const area = api.createFrame();
  tracker.track(area, "frames");
  area.name = name;
  area.resize(width, 160);
  setSolidFill(area, "#EFF6FF");
  applyLayout(
    area,
    {
      mode: "vertical",
      gap: COMPONENT_AREA_GAP,
      padding: { top: 18, right: 16, bottom: 18, left: 16 },
      primaryAxisAlign: "start",
      counterAxisAlign: "center",
    },
    width,
    160,
  );
  area.primaryAxisSizingMode = "AUTO";
  return area;
}

function createWrapper(
  api: RendererFigmaApi,
  tracker: Tracker,
  name: string,
  width: number,
  height: number,
  position: Pick<CanvasBounds, "x" | "y">,
): FrameNode {
  const wrapper = api.createFrame();
  tracker.track(wrapper, "frames");
  wrapper.name = name;
  wrapper.resize(width, height);
  wrapper.x = position.x;
  wrapper.y = position.y;
  wrapper.fills = [];
  return wrapper;
}

function toHex(color: RGB): string {
  const byte = (channel: number) =>
    Math.round(channel * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`.toUpperCase();
}

async function applyNativeStyleBindings(root: FrameNode, bindings: StyleBindings): Promise<void> {
  const walk = async (node: SceneNode): Promise<void> => {
    if (node.type === "INSTANCE") return;

    const bindFill = async (hex: string, bind: (styleId: string) => Promise<void>) => {
      const styleId = bindings.paintStyleIdByHex.get(hex.toUpperCase());
      if (!styleId) return;
      try {
        await bind(styleId);
      } catch (error) {
        bindings.report.warnings.push(
          `A fill could not bind to its native color style and remains a resolved color: ${error instanceof Error ? error.message : "Figma rejected the style binding."}`,
        );
      }
    };

    if (node.type === "TEXT") {
      const token = node.getPluginData(TYPOGRAPHY_TOKEN_KEY);
      const styleId = bindings.textStyleIdByToken.get(token);
      if (styleId) {
        try {
          await node.setTextStyleIdAsync(styleId);
          const overrideText = node.getPluginData(TYPOGRAPHY_OVERRIDES_KEY);
          if (overrideText) {
            const overrides = JSON.parse(overrideText) as NonNullable<
              ResolvedTextNodeSpec["styleOverrides"]
            >;
            if (overrides.fontName) node.fontName = overrides.fontName;
            if (overrides.fontSize !== undefined) node.fontSize = overrides.fontSize;
            if (overrides.lineHeight !== undefined) {
              node.lineHeight = { unit: "PIXELS", value: overrides.lineHeight };
            }
            if (overrides.letterSpacing !== undefined) {
              node.letterSpacing = { unit: "PIXELS", value: overrides.letterSpacing };
            }
            if (overrides.textDecoration) {
              node.textDecoration =
                overrides.textDecoration.toUpperCase() as TextNode["textDecoration"];
            }
          }
        } catch (error) {
          bindings.report.warnings.push(
            `Text style “${token}” could not be bound and remains resolved text: ${error instanceof Error ? error.message : "Figma rejected the style binding."}`,
          );
        }
      }

      const textColor = node.getPluginData(TEXT_COLOR_KEY);
      if (textColor && node.characters.length > 0) {
        await bindFill(textColor, (id) =>
          node.setRangeFillStyleIdAsync(0, node.characters.length, id),
        );
      }
    } else {
      const fillTarget = node as SceneNode & {
        fills?: readonly Paint[] | PluginAPI["mixed"];
        setFillStyleIdAsync?: (id: string) => Promise<void>;
      };
      if (Array.isArray(fillTarget.fills) && typeof fillTarget.setFillStyleIdAsync === "function") {
        const fill = fillTarget.fills.find((paint) => paint.type === "SOLID");
        if (fill?.type === "SOLID") {
          await bindFill(toHex(fill.color), (id) => fillTarget.setFillStyleIdAsync!(id));
        }
      }
    }

    const strokeTarget = node as SceneNode & {
      strokes?: readonly Paint[] | PluginAPI["mixed"];
      setStrokeStyleIdAsync?: (id: string) => Promise<void>;
    };
    if (
      Array.isArray(strokeTarget.strokes) &&
      typeof strokeTarget.setStrokeStyleIdAsync === "function"
    ) {
      const stroke = strokeTarget.strokes.find((paint) => paint.type === "SOLID");
      if (stroke?.type === "SOLID") {
        const styleId = bindings.paintStyleIdByHex.get(toHex(stroke.color));
        if (styleId) {
          try {
            await strokeTarget.setStrokeStyleIdAsync(styleId);
          } catch (error) {
            bindings.report.warnings.push(
              `A stroke could not bind to its native color style and remains a resolved color: ${error instanceof Error ? error.message : "Figma rejected the style binding."}`,
            );
          }
        }
      }
    }

    if ("children" in node) {
      for (const child of node.children) await walk(child);
    }
  };
  await walk(root);
}

function intendedClusterSize(
  spec: ResolvedDesignSpec,
  definitions: ResolvedComponentDefinition[],
  componentAreaWidth: number,
): Pick<PlacementItem, "width" | "height"> {
  if (definitions.length === 0) {
    return { width: spec.document.width, height: spec.document.height };
  }

  const componentAreaHeight =
    COMPONENT_AREA_VERTICAL_PADDING +
    definitions.reduce((height, definition) => height + definition.height, 0) +
    (definitions.length - 1) * COMPONENT_AREA_GAP;
  return {
    width: spec.document.width + COMPONENT_AREA_OFFSET + componentAreaWidth,
    height: Math.max(spec.document.height, componentAreaHeight),
  };
}

export async function renderDesign(
  api: RendererFigmaApi,
  input: unknown,
  options: { updateOwned?: boolean } = {},
): Promise<RenderResult> {
  const parsed = parseDesignValue(input);
  if (!parsed.success) throw new DesignRenderError(parsed.errors.join(" "));
  const { spec, tables } = resolveDesignSystemTokens(parsed.data);
  const fontResolution = await resolveFonts(api, spec, tables.typography);
  const tracker = createTracker();
  const previousSelection = [...api.currentPage.selection];
  const designSystemId = spec.designSystem?.id;
  const designSystemNamespace = spec.designSystem?.namespace;
  const systemComponents = spec.designSystem?.components ?? [];
  const existingRegistry = designSystemId
    ? readOwnedComponents(api.currentPage, designSystemId, systemComponents)
    : { byComponentId: new Map<string, ComponentNode>(), byStableKey: new Map(), warnings: [] };
  const newDefinitions = [
    ...(spec.document.components ?? []),
    ...systemComponents.filter((definition) => !existingRegistry.byComponentId.has(definition.id)),
  ];
  const dsComponentsById = new Map(systemComponents.map((component) => [component.id, component]));
  const context: BuildContext = {
    api,
    tracker,
    fonts: fontResolution.fonts,
    components: new Map(existingRegistry.byComponentId),
    designSystemId,
    designSystemNamespace,
  };
  const reservedNames = new Set<string>();
  let styleBindings: StyleBindings | undefined;
  const componentCreated: string[] = [];
  const componentReused: string[] = [];
  const componentSkipped: string[] = [];
  const componentWarnings = [...existingRegistry.warnings];

  try {
    const existingCanvasBounds = readTopLevelCanvasObstacles(api.currentPage);
    const documentFrameName = uniqueName(api, spec.document.name, reservedNames);
    const componentAreaWidth = Math.max(
      COMPONENT_AREA_WIDTH,
      ...newDefinitions.map((definition) => definition.width),
    );
    const intendedSize = intendedClusterSize(spec, newDefinitions, componentAreaWidth);
    const [initialPlacement] = planCanvasPlacements(
      [{ id: documentFrameName, ...intendedSize }],
      existingCanvasBounds,
    );
    if (!initialPlacement)
      throw new DesignRenderError(
        "Canvas placement did not return a position for the generated design.",
      );

    if (spec.designSystem && designSystemNamespace) {
      styleBindings = await createOrReuseNativeStyles(
        api,
        designSystemNamespace,
        tables,
        { byToken: fontResolution.typographyFonts },
        options.updateOwned ?? false,
      );
      const variableCapability = inspectVariableCapability(api.variables);
      if ((tables.spacing.size > 0 || tables.radii.size > 0) && variableCapability.fallback) {
        styleBindings.report.fallbacks.push(variableCapability.fallback);
      }
      if ((tables.spacing.size > 0 || tables.radii.size > 0) && !variableCapability.enabled) {
        styleBindings.report.warnings.push(variableCapability.fallback);
      }
    }

    let root: FrameNode;
    if (newDefinitions.length === 0) {
      root = createDocumentFrame(
        api,
        spec,
        documentFrameName,
        context,
        undefined,
        initialPlacement,
      );
    } else {
      const wrapper = createWrapper(
        api,
        tracker,
        uniqueName(api, `Generated — ${spec.document.name}`, reservedNames),
        intendedSize.width,
        intendedSize.height,
        initialPlacement,
      );
      const componentArea = createComponentArea(
        api,
        tracker,
        uniqueName(
          api,
          designSystemNamespace
            ? `Generated Components — ${designSystemNamespace}`
            : `Components — ${spec.document.name}`,
          reservedNames,
        ),
        componentAreaWidth,
      );
      wrapper.appendChild(componentArea);
      componentArea.x = spec.document.width + COMPONENT_AREA_OFFSET;
      componentArea.y = 0;

      for (const definition of orderComponentDefinitions(
        newDefinitions as ComponentDefinitionSpec[],
      ) as ResolvedComponentDefinition[]) {
        const systemDefinition = dsComponentsById.get(definition.id);
        const isSystemOwned = systemDefinition !== undefined;
        const masterName = isSystemOwned
          ? `${designSystemNamespace}/${definition.key ?? definition.id}`
          : `${definition.name} — Generated`;
        createComponentDefinition(
          componentArea,
          definition,
          uniqueName(api, masterName, reservedNames),
          context,
          isSystemOwned,
        );
        if (isSystemOwned) componentCreated.push(definition.key ?? definition.id);
      }

      root = createDocumentFrame(api, spec, documentFrameName, context, wrapper);
      root.x = 0;
      root.y = 0;
      wrapper.resize(
        spec.document.width + COMPONENT_AREA_OFFSET + componentArea.width,
        Math.max(spec.document.height, componentArea.height),
      );
      root = wrapper;
    }

    for (const definition of systemComponents) {
      const existing = existingRegistry.byComponentId.get(definition.id);
      if (existing) {
        const key = definition.key ?? definition.id;
        const stored = existing.getPluginData(COMPONENT_FINGERPRINT_KEY);
        const requested = componentDefinitionFingerprint(definition);
        if (stored === requested) {
          componentReused.push(key);
        } else {
          componentSkipped.push(key);
          componentWarnings.push(
            `Component master “${key}” already exists with a different definition and was reused unchanged to preserve its native instances and manual edits. Create a new component key to add the changed definition.`,
          );
        }
      }
    }

    if (styleBindings) await applyNativeStyleBindings(root, styleBindings);

    const stagedBounds = getCanvasNodeBounds(root);
    const [placement] = planCanvasPlacements(
      [{ id: documentFrameName, width: stagedBounds.width, height: stagedBounds.height }],
      existingCanvasBounds,
    );
    if (!placement)
      throw new DesignRenderError(
        "Canvas placement did not return a position for the generated design.",
      );
    placeTopLevelNode(root, stagedBounds, placement);
    api.currentPage.selection = [root];
    api.viewport.scrollAndZoomIntoView([root]);
    const designSystemReport: StyleRegistryReport | undefined = styleBindings?.report;
    return {
      frameName: documentFrameName,
      counts: tracker.counts,
      warnings: [
        ...fontResolution.warnings,
        ...componentWarnings,
        ...(designSystemReport?.warnings ?? []),
      ],
      fontSelections: fontResolution.selections,
      designSystem:
        spec.designSystem && designSystemReport
          ? {
              namespace: spec.designSystem.namespace,
              created: [
                ...designSystemReport.created.map((key) => `style:${key}`),
                ...componentCreated.map((key) => `component:${key}`),
              ],
              reused: [
                ...designSystemReport.reused.map((key) => `style:${key}`),
                ...componentReused.map((key) => `component:${key}`),
              ],
              updated: designSystemReport.updated.map((key) => `style:${key}`),
              skipped: [
                ...designSystemReport.skipped.map((key) => `style:${key}`),
                ...componentSkipped.map((key) => `component:${key}`),
              ],
              fallbacks: designSystemReport.fallbacks,
              warnings: [...componentWarnings, ...designSystemReport.warnings],
            }
          : undefined,
    };
  } catch (error) {
    tracker.cleanup();
    styleBindings?.rollback();
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
