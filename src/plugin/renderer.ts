import type {
  AxisSizing,
  ComponentDefinitionSpec,
  DesignNode,
  DesignCounts,
  SizingMode,
} from "../shared/schema";
import { orderComponentDefinitions, parseDesignValue } from "../shared/schema";
import type { FontSelection } from "../shared/messages";
import type { GenerationTransaction } from "../shared/generation-transaction";
import type { DesignPlan } from "../shared/design-generation";
import {
  DEFAULT_MAX_ROW_WIDTH,
  DEFAULT_MIN_CANVAS_GAP,
  normalizePlacementSettings,
  planCanvasPlacements,
  type CanvasBounds,
  type PlacementItem,
} from "./canvas-placement";
import {
  getCanvasNodeBounds,
  placeTopLevelNode,
  readTopLevelCanvasObstacles,
} from "./figma-canvas-adapter";
import { hexToRgb } from "./figma-utils";
import { applyFigmaVisualStyle, normalizeImageFit, resolvedFillPaints } from "./visual-rendering";
import { embeddedImageBytes, scaleFigmaPathData } from "../shared/visual-assets";
import type { VisualAsset } from "../shared/visual-schema";
import {
  resolveDesignSystemTokens,
  resolveDesignSpecWithTables,
  type ResolvedComponentDefinition,
  type ResolvedDesignNode,
  type ResolvedDesignSpec,
  type ResolvedFrameNodeSpec,
  type ResolvedLayoutSpec,
  type ResolvedRectangleNodeSpec,
  type ResolvedTextNodeSpec,
  type ResolvedVisualStyle,
} from "./design-system/token-resolver";
import {
  designSpecForScreen,
  parseMultiScreenValue,
  type MultiScreenItem,
  type MultiScreenSpec,
} from "../shared/multi-screen-schema";
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
  | "createEllipse"
  | "createVector"
  | "createImage"
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

export interface MultiScreenProgress {
  index: number;
  total: number;
  screenId: string;
  screenName: string;
  status: "started" | "generated" | "failed";
  message?: string;
}

export interface MultiScreenResult {
  nodeId?: string;
  id: string;
  name: string;
  width: number;
  height: number;
  group?: string;
  devicePreset?: MultiScreenItem["devicePreset"];
  status: "generated" | "failed";
  frameName?: string;
  counts: DesignCounts;
  error?: string;
  warnings: string[];
}

export interface MultiScreenRenderResult {
  batchId: string;
  batchName: string;
  totalScreens: number;
  generatedScreens: number;
  failedScreens: number;
  estimatedNodeCount: number;
  createdNodeCount: number;
  gap: number;
  maxRowWidth: number;
  counts: DesignCounts;
  screens: MultiScreenResult[];
  warnings: string[];
  fontSelections: FontSelection[];
  designSystem?: RenderResult["designSystem"];
}

export interface MultiScreenRenderOptions {
  beforeScreen?: () => void;
  transaction?: GenerationTransaction;
  onSectionVisible?: (nodeId: string) => void;
  resume?: boolean;
  verifyTouchTargets?: boolean;
  gap?: number;
  maxRowWidth?: number;
  onProgress?: (progress: MultiScreenProgress) => void;
}

function verifyNativeTouchTargets(root: FrameNode): void {
  const targets: SceneNode[] = [...root.children];
  while (targets.length) {
    const target = targets.pop()!;
    if (target.getPluginData("fad.touch-target") && (target.width < 43.99 || target.height < 43.99))
      throw new DesignRenderError(
        `Rendered interactive layer “${target.name}” is below 44×44 px after native Auto Layout. Saved JSON retained; fix the edited frame or delete it and resume.`,
      );
    if ("children" in target) for (const child of target.children) targets.push(child);
  }
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
const VISUAL_OVERRIDE_KEY = "fad.visual.style";
const VISUAL_FILL_EXPLICIT_KEY = "fad.visual.fills-explicit";
const MULTI_SCREEN_BATCH_KEY = "fad.multi-screen.batch-id";
const MULTI_SCREEN_ID_KEY = "fad.multi-screen.screen-id";
const MULTI_SCREEN_META_KEY = "fad.multi-screen.metadata";
const COMPONENT_AREA_BATCH_KEY = "fad.multi-screen.components-batch";
const SECTION_TRANSACTION_KEY = "fad.generation.transaction.key";
const SECTION_TRANSACTION_PENDING_KEY = "fad.generation.transaction.pending";
const SECTION_SEQUENCE_KEY = "fad.generation.transaction.sequence";
const TRANSACTION_LEDGER_KEY = "fad.generation.transaction-ledger";
const SEMANTIC_NODE_ID_KEY = "fad.generation.semantic-id";

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

type LayoutChildNode =
  TextNode | RectangleNode | EllipseNode | VectorNode | FrameNode | InstanceNode | ComponentNode;

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
      counts[kind] = (counts[kind] ?? 0) + 1;
    },
    replace(oldNode, newNode, oldKind, newKind) {
      if (!nodes.includes(oldNode)) nodes.push(oldNode);
      nodes.push(newNode);
      counts[oldKind] = (counts[oldKind] ?? 0) - 1;
      counts[newKind] = (counts[newKind] ?? 0) + 1;
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

export function createGenerationSkeletons(
  api: RendererFigmaApi,
  generationId: string,
  plan: DesignPlan,
  screenIds: string[],
  focusInitial = false,
): string[] {
  const selected = plan.screens.filter(({ id }) => screenIds.includes(id));
  if (selected.length !== screenIds.length || new Set(screenIds).size !== screenIds.length)
    throw new DesignRenderError("Generation skeleton scope does not match the planned screens.");
  const roots = selected.map((screen) => {
    const matches = api.currentPage.findAll(
      (node) =>
        node.getPluginData(MULTI_SCREEN_BATCH_KEY) === generationId &&
        node.getPluginData(MULTI_SCREEN_ID_KEY) === screen.id,
    );
    if (matches.length > 1)
      throw new DesignRenderError(
        "Duplicate generation screen identity; inspect the existing frames.",
      );
    const existing = matches[0];
    if (existing) {
      if (
        existing.type !== "FRAME" ||
        !["streaming", "complete"].includes(existing.getPluginData("fad.generation.commit"))
      )
        throw new DesignRenderError(
          "Existing generation frame is incomplete; inspect it before resuming.",
        );
      return existing as FrameNode;
    }
    return undefined;
  });
  const missing = selected.filter((_, index) => !roots[index]);
  if (!missing.length) return roots.map((root) => root!.id);

  const placements = planCanvasPlacements(
    missing.map((screen) => ({ id: screen.id, width: screen.width, height: screen.height })),
    readTopLevelCanvasObstacles(api.currentPage),
  );
  const placementById = new Map(placements.map((placement) => [placement.id, placement]));
  const tracker = createTracker();
  const created: FrameNode[] = [];
  try {
    for (const screen of missing) {
      const position = placementById.get(screen.id);
      if (!position)
        throw new DesignRenderError(`No skeleton placement was planned for ${screen.id}.`);
      const frame = api.createFrame();
      tracker.track(frame, "frames");
      created.push(frame);
      frame.name = uniqueName(api, `Generating — ${screen.name}`, new Set());
      frame.resize(screen.width, screen.height);
      frame.x = position.x;
      frame.y = position.y;
      frame.fills = [{ type: "SOLID", color: hexToRgb("#F7F5F0") }];
      frame.strokes = [{ type: "SOLID", color: hexToRgb("#D8DEE6") }];
      frame.strokeWeight = 1;
      applyLayout(
        frame,
        {
          mode: "vertical",
          gap: screen.devicePreset === "mobile" ? 16 : 24,
          padding:
            screen.devicePreset === "mobile"
              ? { top: 20, right: 20, bottom: 20, left: 20 }
              : { top: 32, right: 32, bottom: 32, left: 32 },
          counterAxisAlign: "stretch",
        },
        screen.width,
        screen.height,
      );
      frame.primaryAxisSizingMode = "FIXED";
      frame.counterAxisSizingMode = "FIXED";
      frame.setPluginData(MULTI_SCREEN_BATCH_KEY, generationId);
      frame.setPluginData(MULTI_SCREEN_ID_KEY, screen.id);
      frame.setPluginData(SEMANTIC_NODE_ID_KEY, `screen:${screen.id}`);
      frame.setPluginData("fad.generation.commit", "streaming");
      frame.setPluginData("fad.generation.sequence", "-1");
      frame.setPluginData("fad.generation.last-idempotency-key", "");
      frame.setPluginData(TRANSACTION_LEDGER_KEY, "[]");
      frame.setPluginData("fad.generation.skeleton", "1");
      frame.setPluginData(
        MULTI_SCREEN_META_KEY,
        JSON.stringify({ devicePreset: screen.devicePreset, order: screen.order }),
      );
    }
    if (focusInitial && created[0]) {
      api.currentPage.selection = [created[0]];
      api.viewport.scrollAndZoomIntoView([created[0]]);
    }
    return selected.map((_, index) => roots[index]?.id ?? created.shift()!.id);
  } catch (error) {
    tracker.cleanup();
    throw error instanceof DesignRenderError
      ? error
      : new DesignRenderError("Figma could not create the working screen frames.", {
          cause: error,
        });
  }
}

function collectImageReferences(nodes: DesignNode[], references: Set<string>): void {
  for (const node of nodes) {
    if (node.type === "image") references.add(node.assetId);
    else if (node.type === "frame") collectImageReferences(node.children, references);
  }
}

function prepareVisualAssets(
  api: RendererFigmaApi,
  assets: VisualAsset[] | undefined,
  nodeTrees: DesignNode[][],
): { assets: Map<string, VisualAsset>; imageHashes: Map<string, string> } {
  const assetMap = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  const references = new Set<string>();
  nodeTrees.forEach((nodes) => collectImageReferences(nodes, references));
  const hashesByBytes = new Map<string, string>();
  const imageHashes = new Map<string, string>();
  for (const assetId of references) {
    const asset = assetMap.get(assetId);
    if (!asset || asset.kind !== "raster") continue;
    let hash = hashesByBytes.get(asset.base64);
    if (!hash) {
      try {
        hash = api.createImage(embeddedImageBytes(asset.base64)).hash;
      } catch (error) {
        throw new DesignRenderError(
          `Image asset “${asset.name}” could not be imported locally. ${error instanceof Error ? error.message : "Check the file bytes and format."}`,
          { cause: error },
        );
      }
      hashesByBytes.set(asset.base64, hash);
    }
    imageHashes.set(assetId, hash);
  }
  return { assets: assetMap, imageHashes };
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
  const preferredFallbacks = new Map<string, { family: string; style: string }>();
  for (const node of collectTextNodes(spec)) {
    const family = node.fontFamily ?? "Inter";
    const style = node.fontStyle ?? "Regular";
    requested.set(fontKey(family, style), { family, style });
    if (node.fontFallback) {
      const key = fontKey(family, style);
      const existing = preferredFallbacks.get(key);
      if (!existing || node.fontFallback.family === "Inter")
        preferredFallbacks.set(key, {
          family: node.fontFallback.family,
          style: node.fontFallback.style,
        });
    }
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
    const preferredFallback = preferredFallbacks.get(key);
    const preferred = preferredFallback
      ? availableByKey.get(fontKey(preferredFallback.family, preferredFallback.style))
      : undefined;
    const candidates = [exact, preferred, fallback].filter(
      (candidate, index, all): candidate is FontName =>
        Boolean(candidate) &&
        all.findIndex(
          (item) =>
            item &&
            fontKey(item.family, item.style) === fontKey(candidate!.family, candidate!.style),
        ) === index,
    );
    let chosen: FontName | undefined;
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await api.loadFontAsync(candidate);
        chosen = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!chosen)
      throw new DesignRenderError(
        `Figma could not load “${request.family} ${request.style}” or the configured Brand Kit/Inter fallback.`,
        { cause: lastError },
      );
    const fellBack = fontKey(chosen.family, chosen.style) !== key;
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

const horizontalConstraint: Record<
  NonNullable<Extract<DesignNode, { constraints?: unknown }>["constraints"]>["horizontal"],
  ConstraintType
> = {
  left: "MIN",
  right: "MAX",
  center: "CENTER",
  "left-right": "STRETCH",
  scale: "SCALE",
};
const verticalConstraint: Record<
  NonNullable<Extract<DesignNode, { constraints?: unknown }>["constraints"]>["vertical"],
  ConstraintType
> = {
  top: "MIN",
  bottom: "MAX",
  center: "CENTER",
  "top-bottom": "STRETCH",
  scale: "SCALE",
};

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
  if (node.visual) {
    text.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(node.visual));
    if (node.visual.fills !== undefined) text.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
    applyFigmaVisualStyle(text, node.visual);
  }
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
  if (node.visual) {
    rectangle.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(node.visual));
    if (node.visual.fills !== undefined) rectangle.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
    applyFigmaVisualStyle(rectangle, node.visual);
  }
}

function setFrameProperties(
  frame: FrameNode | ComponentNode,
  properties: Pick<
    ResolvedFrameNodeSpec,
    "background" | "stroke" | "cornerRadius" | "cornerRadii" | "visual"
  >,
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
  if (properties.visual) {
    frame.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(properties.visual));
    if (properties.visual.fills !== undefined) frame.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
    applyFigmaVisualStyle(frame, properties.visual);
  }
}

interface BuildContext {
  api: RendererFigmaApi;
  tracker: Tracker;
  fonts: Map<string, FontName>;
  components: Map<string, ComponentNode>;
  designSystemId?: string;
  designSystemNamespace?: string;
  assets: Map<string, VisualAsset>;
  imageHashes: Map<string, string>;
  warnings: string[];
}

function buildFrameChildren(
  frame: FrameNode,
  spec: ResolvedFrameNodeSpec,
  context: BuildContext,
): void {
  for (const child of spec.children) appendDesignNode(frame, child, spec.layout, context);
}

function populateSvgAsset(
  frame: FrameNode,
  asset: Extract<VisualAsset, { kind: "svg-paths" }>,
  width: number,
  height: number,
  fit: "fill" | "fit" | "crop" | "tile" | undefined,
  context: BuildContext,
): void {
  const mode = fit ?? "fit";
  if (mode === "tile") {
    context.warnings.push(
      `SVG asset “${asset.name}” does not support tiled vectors; it was fit proportionally.`,
    );
  }
  const scale =
    mode === "fit" || mode === "tile"
      ? Math.min(width / asset.width, height / asset.height)
      : Math.max(width / asset.width, height / asset.height);
  const scaledWidth = asset.width * scale;
  const scaledHeight = asset.height * scale;
  const offsetX = (width - scaledWidth) / 2;
  const offsetY = (height - scaledHeight) / 2;
  for (let index = 0; index < asset.paths.length; index++) {
    const path = asset.paths[index];
    const vector = context.api.createVector();
    context.tracker.track(vector, "vectors");
    vector.name = path.name ?? `${asset.name} path ${index + 1}`;
    vector.vectorPaths = [
      { windingRule: "NONZERO", data: scaleFigmaPathData(path.data, scale, scale) },
    ];
    vector.resize(scaledWidth, scaledHeight);
    vector.fills = [{ type: "SOLID", color: hexToRgb(path.fill) }];
    frame.appendChild(vector);
    vector.x = offsetX;
    vector.y = offsetY;
  }
}

function appendDesignNode(
  parent: FrameNode | ComponentNode,
  spec: ResolvedDesignNode,
  parentLayout: ResolvedLayoutSpec | undefined,
  context: BuildContext,
  beforeAppend?: (node: LayoutChildNode) => void,
): LayoutChildNode {
  const { api, tracker } = context;
  let node: LayoutChildNode;
  let frameToPopulate: FrameNode | undefined;
  let svgToPopulate: Extract<VisualAsset, { kind: "svg-paths" }> | undefined;
  let svgFit: "fill" | "fit" | "crop" | "tile" | undefined;

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
  } else if (spec.type === "ellipse") {
    const ellipse = api.createEllipse();
    tracker.track(ellipse, "ellipses");
    ellipse.name = spec.name;
    ellipse.resize(spec.width, spec.height);
    setSolidFill(ellipse, spec.fill);
    if (spec.visual) {
      ellipse.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(spec.visual));
      if (spec.visual.fills !== undefined) ellipse.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
      applyFigmaVisualStyle(ellipse, spec.visual);
    }
    node = ellipse;
  } else if (spec.type === "vector") {
    const vector = api.createVector();
    tracker.track(vector, "vectors");
    vector.name = spec.name;
    vector.vectorPaths = [{ windingRule: "NONZERO", data: spec.pathData }];
    vector.resize(spec.width, spec.height);
    setSolidFill(vector, spec.fill);
    if (spec.visual) {
      vector.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(spec.visual));
      if (spec.visual.fills !== undefined) vector.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
      applyFigmaVisualStyle(vector, spec.visual);
    }
    node = vector;
  } else if (spec.type === "image") {
    const asset = context.assets.get(spec.assetId);
    if (!asset)
      throw new DesignRenderError(
        `Image node “${spec.name}” references missing asset “${spec.assetId}”.`,
      );
    if (asset.kind === "raster") {
      const rectangle = api.createRectangle();
      tracker.track(rectangle, "images");
      rectangle.name = spec.name;
      rectangle.resize(spec.width, spec.height);
      const imageHash = context.imageHashes.get(spec.assetId);
      if (!imageHash)
        throw new DesignRenderError(`Image asset “${spec.assetId}” could not be prepared.`);
      rectangle.fills = [{ type: "IMAGE", imageHash, scaleMode: normalizeImageFit(spec.fit) }];
      if (spec.cornerRadius !== undefined) rectangle.cornerRadius = spec.cornerRadius;
      if (spec.visual) {
        rectangle.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(spec.visual));
        if (spec.visual.fills !== undefined) rectangle.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
        applyFigmaVisualStyle(rectangle, spec.visual, imageHash, normalizeImageFit(spec.fit));
      }
      node = rectangle;
    } else {
      const frame = api.createFrame();
      tracker.track(frame, "frames");
      frame.name = spec.name;
      frame.resize(spec.width, spec.height);
      frame.fills = [];
      frame.clipsContent = true;
      if (spec.cornerRadius !== undefined) frame.cornerRadius = spec.cornerRadius;
      if (spec.visual) {
        frame.setPluginData(VISUAL_OVERRIDE_KEY, JSON.stringify(spec.visual));
        if (spec.visual.fills !== undefined) frame.setPluginData(VISUAL_FILL_EXPLICIT_KEY, "1");
        applyFigmaVisualStyle(frame, spec.visual);
      }
      svgToPopulate = asset;
      svgFit = spec.fit;
      frameToPopulate = frame;
      node = frame;
    }
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

  beforeAppend?.(node);
  parent.appendChild(node);
  if ("logicalRef" in spec && spec.logicalRef)
    node.setPluginData("fad.design.logical-ref", spec.logicalRef);
  if ("assetId" in spec && typeof spec.assetId === "string")
    node.setPluginData("fad.design.asset-id", spec.assetId);
  if ("pattern" in spec && spec.pattern) node.setPluginData("fad.design.pattern", spec.pattern);
  if ("qualityRole" in spec && spec.qualityRole)
    node.setPluginData("fad.design.quality-role", spec.qualityRole);
  if ("qualityRole" in spec && (spec.qualityRole === "button" || spec.qualityRole === "input"))
    node.setPluginData("fad.touch-target", spec.qualityRole);
  if (parentLayout) {
    applyChildSizing(node, effectiveSizing(spec, parentLayout), parentLayout);
  } else {
    node.x = spec.x as number;
    node.y = spec.y as number;
  }
  if ("constraints" in spec && spec.constraints) {
    node.constraints = {
      horizontal: horizontalConstraint[spec.constraints.horizontal],
      vertical: verticalConstraint[spec.constraints.vertical],
    };
  }
  if (frameToPopulate && spec.type === "frame") {
    buildFrameChildren(frameToPopulate, spec as ResolvedFrameNodeSpec, context);
  }
  if (svgToPopulate && frameToPopulate && spec.type === "image") {
    populateSvgAsset(frameToPopulate, svgToPopulate, spec.width, spec.height, svgFit, context);
  }
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

function uniqueName(
  api: RendererFigmaApi,
  base: string,
  reserved: Set<string>,
  existingNames?: ReadonlySet<string>,
): string {
  let candidate = base;
  let suffix = 2;
  while (
    reserved.has(candidate) ||
    (existingNames
      ? existingNames.has(candidate)
      : api.currentPage.findAll((node) => node.name === candidate).length > 0)
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
  onCreated?: (frame: FrameNode) => void,
  onChildCreated?: (node: LayoutChildNode, index: number) => void,
): FrameNode {
  const frame = api.createFrame();
  context.tracker.track(frame, "frames");
  onCreated?.(frame);
  frame.name = name;
  frame.resize(spec.document.width, spec.document.height);
  frame.x = position?.x ?? 0;
  frame.y = position?.y ?? 0;
  setSolidFill(frame, spec.document.background);
  if (spec.document.layout)
    applyLayout(frame, spec.document.layout, spec.document.width, spec.document.height);
  parent?.appendChild(frame);
  for (const [index, child] of spec.document.children.entries()) {
    appendDesignNode(frame, child, spec.document.layout, context, (node) =>
      onChildCreated?.(node, index),
    );
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
      const hasExplicitVisualFills = node.getPluginData(VISUAL_FILL_EXPLICIT_KEY) === "1";
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
      if (!hasExplicitVisualFills && textColor && node.characters.length > 0) {
        await bindFill(textColor, (id) =>
          node.setRangeFillStyleIdAsync(0, node.characters.length, id),
        );
      }
      if (hasExplicitVisualFills) {
        const encodedVisual = node.getPluginData(VISUAL_OVERRIDE_KEY);
        if (encodedVisual) {
          const visual = JSON.parse(encodedVisual) as ResolvedVisualStyle;
          const paints = resolvedFillPaints(visual);
          if (paints) node.fills = paints;
        }
      }
    } else {
      const fillTarget = node as SceneNode & {
        fills?: readonly Paint[] | PluginAPI["mixed"];
        setFillStyleIdAsync?: (id: string) => Promise<void>;
      };
      if (
        node.getPluginData(VISUAL_FILL_EXPLICIT_KEY) !== "1" &&
        Array.isArray(fillTarget.fills) &&
        typeof fillTarget.setFillStyleIdAsync === "function"
      ) {
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
    assets: new Map(),
    imageHashes: new Map(),
    warnings: [],
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

    const assetPreparation = prepareVisualAssets(api, spec.assets, [
      spec.document.children,
      ...(spec.document.components ?? []).map((component) => component.children),
      ...(spec.designSystem?.components ?? []).map((component) => component.children),
    ]);
    context.assets = assetPreparation.assets;
    context.imageHashes = assetPreparation.imageHashes;

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
        ...context.warnings,
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

function emptyDesignCounts(): DesignCounts {
  return { frames: 0, texts: 0, rectangles: 0, components: 0, instances: 0 };
}

function addDesignCounts(target: DesignCounts, source: DesignCounts): void {
  target.frames += source.frames;
  target.texts += source.texts;
  target.rectangles += source.rectangles;
  target.components += source.components;
  target.instances += source.instances;
  for (const key of ["ellipses", "vectors", "images"] as const) {
    const total = (target[key] ?? 0) + (source[key] ?? 0);
    if (total > 0) target[key] = total;
  }
}

function sumDesignCounts(counts: DesignCounts): number {
  return (
    counts.frames +
    counts.texts +
    counts.rectangles +
    counts.components +
    counts.instances +
    (counts.ellipses ?? 0) +
    (counts.vectors ?? 0) +
    (counts.images ?? 0)
  );
}

function screenPlacementId(screenId: string): string {
  return `screen:${screenId}`;
}

function safeProgress(
  callback: MultiScreenRenderOptions["onProgress"],
  progress: MultiScreenProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // UI progress delivery must not affect document generation.
  }
}

function safeSectionVisible(
  callback: MultiScreenRenderOptions["onSectionVisible"],
  nodeId: string,
): void {
  try {
    callback?.(nodeId);
  } catch {
    // The UI diagnostic channel must not change native transaction outcome.
  }
}

function readTransactionLedger(root: FrameNode): Array<{ sequence: number; key: string }> {
  try {
    const value: unknown = JSON.parse(root.getPluginData(TRANSACTION_LEDGER_KEY) || "[]");
    if (
      !Array.isArray(value) ||
      value.some(
        (item) =>
          !item ||
          !Number.isInteger(item.sequence) ||
          typeof item.key !== "string" ||
          item.key.length > 300,
      ) ||
      value.some(
        (item, index) =>
          item.sequence !== index ||
          value.findIndex((candidate) => candidate.key === item.key) !== index,
      )
    )
      throw new Error();
    return value as Array<{ sequence: number; key: string }>;
  } catch {
    throw new DesignRenderError(
      "The generation transaction ledger is corrupt; inspect this frame before resume.",
    );
  }
}

function markSectionNodeIds(
  actual: SceneNode,
  spec: ResolvedDesignNode,
  ids: string[],
  cursor: { value: number },
): void {
  const id = ids[cursor.value++];
  if (!id)
    throw new DesignRenderError("Section semantic node IDs do not match its validated tree.");
  actual.setPluginData(SEMANTIC_NODE_ID_KEY, id);
  if (spec.type === "frame" && actual.type === "FRAME") {
    for (let index = 0; index < spec.children.length; index++) {
      const child = actual.children[index];
      if (!child) throw new DesignRenderError("A rendered section child is missing.");
      markSectionNodeIds(child, spec.children[index]!, ids, cursor);
    }
  }
}

function commitSectionNode(
  root: FrameNode,
  node: SceneNode,
  spec: ResolvedDesignNode,
  transaction: GenerationTransaction,
  restoring: boolean,
): void {
  if (node.type !== "FRAME")
    throw new DesignRenderError("A generated section root must be an editable native frame.");
  if (node.getPluginData(SECTION_TRANSACTION_PENDING_KEY) !== transaction.idempotency_key)
    throw new DesignRenderError(
      "The native section root is missing its pending transaction marker.",
    );
  const cursor = { value: 0 };
  markSectionNodeIds(node, spec, transaction.operation.node_ids, cursor);
  if (cursor.value !== transaction.operation.node_ids.length)
    throw new DesignRenderError("Section semantic node ID count did not match the rendered tree.");
  node.setPluginData(SECTION_TRANSACTION_KEY, transaction.idempotency_key);
  node.setPluginData(SECTION_TRANSACTION_PENDING_KEY, "");
  node.setPluginData(SECTION_SEQUENCE_KEY, String(transaction.sequence));
  node.setPluginData("fad.generation.transaction-id", transaction.transaction_id);
  if (restoring) root.insertChild(Math.min(transaction.sequence, root.children.length), node);
}

function failedMultiScreenResult(
  batch: MultiScreenSpec,
  message: string,
  options: Required<Pick<MultiScreenRenderOptions, "gap" | "maxRowWidth">>,
  fontSelections: FontSelection[] = [],
): MultiScreenRenderResult {
  return {
    batchId: batch.id,
    batchName: batch.name,
    totalScreens: batch.screens.length,
    generatedScreens: 0,
    failedScreens: batch.screens.length,
    estimatedNodeCount: 0,
    createdNodeCount: 0,
    gap: options.gap,
    maxRowWidth: options.maxRowWidth,
    counts: emptyDesignCounts(),
    screens: batch.screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      width: screen.width,
      height: screen.height,
      group: screen.group,
      devicePreset: screen.devicePreset,
      status: "failed",
      counts: emptyDesignCounts(),
      error: message,
      warnings: [],
    })),
    warnings: [message],
    fontSelections,
  };
}

/**
 * Generates all screens as independent page-level frames. Shared tokens, fonts,
 * styles, and component masters are prepared once for the batch. Each screen has
 * its own rollback boundary; the default import always creates new screen roots.
 */
export async function renderMultiScreenDesign(
  api: RendererFigmaApi,
  input: unknown,
  options: MultiScreenRenderOptions = {},
): Promise<MultiScreenRenderResult> {
  const parsed = parseMultiScreenValue(input);
  if (!parsed.success) throw new DesignRenderError(parsed.errors.join("\n"));
  const batch = parsed.data;
  const transaction = options.transaction;
  if (
    transaction &&
    (batch.screens.length !== 1 ||
      transaction.screen_id !== batch.screens[0]!.id ||
      transaction.parent_node_id !== `screen:${transaction.screen_id}` ||
      transaction.operation.node_id !==
        `section:${transaction.screen_id}:${transaction.section_id}` ||
      batch.screens[0]!.children.length !== 1)
  )
    throw new DesignRenderError(
      "Section transaction does not match its single validated screen root.",
    );
  const defaults = { gap: DEFAULT_MIN_CANVAS_GAP, maxRowWidth: DEFAULT_MAX_ROW_WIDTH };
  const normalized = normalizePlacementSettings({
    gap: options.gap ?? defaults.gap,
    maxRowWidth: options.maxRowWidth ?? defaults.maxRowWidth,
  });
  if (normalized.gap > 1_000) {
    throw new DesignRenderError("Canvas gap must be between 0 and 1,000 px.");
  }
  if (normalized.maxRowWidth < 390 || normalized.maxRowWidth > 20_000) {
    throw new DesignRenderError("Canvas row width must be between 390 and 20,000 px.");
  }
  const placementSettings = normalized;
  const orderedScreens = batch.screens;
  const screenResults: MultiScreenResult[] = [];
  const warnings: string[] = [];
  const counts = emptyDesignCounts();
  const previousSelection = [...api.currentPage.selection];
  const sharedTracker = createTracker();
  const successfulRoots: FrameNode[] = [];
  let styleBindings: StyleBindings | undefined;
  let fontResolution: FontResolution | undefined;
  let componentArea: FrameNode | undefined;
  const estimatedNodeCount = parsed.nodeCount;
  const frameNames = new Set<string>();
  // Snapshot page names once; repeated full-page scans are costly on large batches.
  const existingNames = new Set(api.currentPage.findAll(() => true).map((node) => node.name));
  const componentCreated: string[] = [];
  const componentReused: string[] = [];
  const componentSkipped: string[] = [];
  const componentWarnings: string[] = [];
  const visualWarnings: string[] = [];

  const markRemainingScreensFailed = (startIndex: number, error: string) => {
    for (let index = startIndex; index < orderedScreens.length; index++) {
      const screen = orderedScreens[index];
      const message = `Not attempted because the remaining canvas layout could not be planned: ${error}`;
      screenResults.push({
        id: screen.id,
        name: screen.name,
        width: screen.width,
        height: screen.height,
        group: screen.group,
        devicePreset: screen.devicePreset,
        status: "failed",
        counts: emptyDesignCounts(),
        error: message,
        warnings: [],
      });
      safeProgress(options.onProgress, {
        index: index + 1,
        total: orderedScreens.length,
        screenId: screen.id,
        screenName: screen.name,
        status: "failed",
        message,
      });
    }
  };

  try {
    const sourceSpecs = orderedScreens.map((screen) => designSpecForScreen(batch, screen));
    const baseResolved = resolveDesignSystemTokens(sourceSpecs[0]);
    const resolvedSpecs = sourceSpecs.map((spec) =>
      resolveDesignSpecWithTables(spec, baseResolved.spec, baseResolved.tables),
    );
    const fontSpec: ResolvedDesignSpec = {
      ...baseResolved.spec,
      document: {
        ...baseResolved.spec.document,
        children: resolvedSpecs.flatMap((spec) => spec.document.children),
      },
    };
    fontResolution = await resolveFonts(api, fontSpec, baseResolved.tables.typography);

    const designSystemId = batch.designSystem?.id ?? batch.id;
    const designSystemNamespace = batch.designSystem?.namespace;
    const definitions = [
      ...(baseResolved.spec.document.components ?? []),
      ...(baseResolved.spec.designSystem?.components ?? []),
    ] as ResolvedComponentDefinition[];
    const existingRegistry = readOwnedComponents(api.currentPage, designSystemId, definitions);
    componentWarnings.push(...existingRegistry.warnings);
    const components = new Map(existingRegistry.byComponentId);
    const systemComponentIds = new Set(
      (baseResolved.spec.designSystem?.components ?? []).map((component) => component.id),
    );
    for (const definition of definitions) {
      const existing = existingRegistry.byComponentId.get(definition.id);
      if (!existing) continue;
      const key = definition.key ?? definition.id;
      if (
        existing.getPluginData(COMPONENT_FINGERPRINT_KEY) ===
        componentDefinitionFingerprint(definition)
      ) {
        componentReused.push(key);
      } else {
        componentSkipped.push(key);
        componentWarnings.push(
          `Component master “${key}” already exists with a different definition and was reused unchanged. Add a new stable key to preserve existing instances and manual edits.`,
        );
      }
    }
    const newDefinitions = orderComponentDefinitions(
      definitions.filter(
        (definition) => !components.has(definition.id),
      ) as ComponentDefinitionSpec[],
    ) as ResolvedComponentDefinition[];
    const componentAreaWidth = Math.max(
      COMPONENT_AREA_WIDTH,
      ...newDefinitions.map((definition) => definition.width + 32),
    );
    const componentAreaHeight =
      COMPONENT_AREA_VERTICAL_PADDING +
      newDefinitions.reduce((height, definition) => height + definition.height, 0) +
      Math.max(0, newDefinitions.length - 1) * COMPONENT_AREA_GAP;
    const componentAreaItem: PlacementItem | undefined = newDefinitions.length
      ? {
          id: "shared-components",
          width: componentAreaWidth,
          height: componentAreaHeight,
        }
      : undefined;
    const screenItems: PlacementItem[] = orderedScreens.map((screen) => ({
      id: screenPlacementId(screen.id),
      width: screen.width,
      height: screen.height,
    }));
    const placementItems = componentAreaItem ? [...screenItems, componentAreaItem] : screenItems;
    const existingBounds = readTopLevelCanvasObstacles(api.currentPage);
    let planned = planCanvasPlacements(placementItems, existingBounds, placementSettings);
    const placementById = new Map(planned.map((placement) => [placement.id, placement]));
    const assetPreparation = prepareVisualAssets(api, batch.assets, [
      ...orderedScreens.map((screen) => screen.children),
      ...definitions.map((definition) => definition.children),
    ]);

    if (batch.designSystem) {
      styleBindings = await createOrReuseNativeStyles(
        api,
        batch.designSystem.namespace,
        baseResolved.tables,
        { byToken: fontResolution.typographyFonts },
        false,
      );
      const variableCapability = inspectVariableCapability(api.variables);
      if (
        (baseResolved.tables.spacing.size > 0 || baseResolved.tables.radii.size > 0) &&
        variableCapability.fallback
      ) {
        styleBindings.report.fallbacks.push(variableCapability.fallback);
        styleBindings.report.warnings.push(variableCapability.fallback);
      }
    }

    const componentContext: BuildContext = {
      api,
      tracker: sharedTracker,
      fonts: fontResolution.fonts,
      components,
      designSystemId,
      designSystemNamespace,
      ...assetPreparation,
      warnings: visualWarnings,
    };
    if (newDefinitions.length && componentAreaItem) {
      componentArea = createComponentArea(
        api,
        sharedTracker,
        uniqueName(
          api,
          `Generated Components — ${designSystemNamespace ?? batch.name}`,
          frameNames,
          existingNames,
        ),
        componentAreaWidth,
      );
      componentArea.setPluginData(COMPONENT_AREA_BATCH_KEY, batch.id);
      for (const definition of newDefinitions) {
        const key = definition.key ?? definition.id;
        const masterName = systemComponentIds.has(definition.id)
          ? `${designSystemNamespace}/${key}`
          : `${batch.name}/${key}`;
        createComponentDefinition(
          componentArea,
          definition,
          uniqueName(api, masterName, frameNames, existingNames),
          componentContext,
          true,
        );
        componentCreated.push(key);
      }
      if (styleBindings) await applyNativeStyleBindings(componentArea, styleBindings);

      const measuredAreaBounds = getCanvasNodeBounds(componentArea);
      const actualAreaItem = {
        ...componentAreaItem,
        width: measuredAreaBounds.width,
        height: measuredAreaBounds.height,
      };
      if (
        Math.abs(actualAreaItem.width - componentAreaItem.width) > 0.5 ||
        Math.abs(actualAreaItem.height - componentAreaItem.height) > 0.5
      ) {
        planned = planCanvasPlacements(
          [...screenItems, actualAreaItem],
          existingBounds,
          placementSettings,
        );
        placementById.clear();
        for (const placement of planned) placementById.set(placement.id, placement);
      }
      const areaPlacement = placementById.get("shared-components");
      if (!areaPlacement) throw new DesignRenderError("Component placement was not planned.");
      placeTopLevelNode(componentArea, measuredAreaBounds, areaPlacement);
    }

    const refreshRemainingPlacements = (startIndex: number) => {
      if (startIndex >= orderedScreens.length) return;
      const remaining = orderedScreens.slice(startIndex).map((screen) => ({
        id: screenPlacementId(screen.id),
        width: screen.width,
        height: screen.height,
      }));
      const replanned = planCanvasPlacements(
        remaining,
        readTopLevelCanvasObstacles(api.currentPage),
        placementSettings,
      );
      for (const placement of replanned) placementById.set(placement.id, placement);
    };

    for (let index = 0; index < orderedScreens.length; index++) {
      options.beforeScreen?.();
      const screen = orderedScreens[index];
      let existingRoot: FrameNode | undefined;
      if (options.resume) {
        const existing = api.currentPage.findAll(
          (node) =>
            node.getPluginData(MULTI_SCREEN_BATCH_KEY) === batch.id &&
            node.getPluginData(MULTI_SCREEN_ID_KEY) === screen.id,
        );
        if (existing.length > 1)
          throw new DesignRenderError(
            "Duplicate generation identity found; inspect the existing frames before resuming.",
          );
        const root = existing[0];
        if (root?.type === "FRAME" && transaction) {
          if (
            !(["streaming", "complete"] as string[]).includes(
              root.getPluginData("fad.generation.commit"),
            )
          )
            throw new DesignRenderError(
              "Existing generation frame is not a committed working root; inspect it before resuming.",
            );
          if (root.getPluginData(SEMANTIC_NODE_ID_KEY) !== transaction.parent_node_id)
            throw new DesignRenderError(
              "Section transaction parent does not match the native screen identity.",
            );
          existingRoot = root;
          existingRoot.setPluginData("fad.design.logical-ref", `${screen.id}.root`);
        } else if (
          root?.type === "FRAME" &&
          root.getPluginData("fad.generation.commit") === "complete"
        ) {
          if (options.verifyTouchTargets) verifyNativeTouchTargets(root);
          successfulRoots.push(root);
          screenResults.push({
            id: screen.id,
            name: screen.name,
            width: screen.width,
            height: screen.height,
            status: "generated",
            counts: emptyDesignCounts(),
            warnings: ["Reused existing rendered screen without moving it."],
            frameName: root.name,
            nodeId: root.id,
          });
          continue;
        }
        if (root?.getPluginData("fad.generation.commit") === "pending") root.remove();
        else if (root && !existingRoot)
          throw new DesignRenderError(
            "Existing generation frame has no completion marker; inspect it before resuming.",
          );
      }
      const screenSpec = resolvedSpecs[index];
      const placementId = screenPlacementId(screen.id);
      let plannedScreen = placementById.get(placementId);
      if (!plannedScreen) {
        refreshRemainingPlacements(index);
        plannedScreen = placementById.get(placementId);
      }
      if (!plannedScreen)
        throw new DesignRenderError(`No placement was planned for “${screen.id}”.`);

      const displayName = `${String((options.resume ? (screen.order ?? index) : index) + 1).padStart(2, "0")} — ${screen.name}`;
      safeProgress(options.onProgress, {
        index: index + 1,
        total: orderedScreens.length,
        screenId: screen.id,
        screenName: screen.name,
        status: "started",
      });
      const screenTracker = createTracker();
      const context: BuildContext = {
        ...componentContext,
        tracker: screenTracker,
        components,
      };
      const warningsBeforeScreen = styleBindings?.report.warnings.length ?? 0;
      let requiresReplan = false;
      try {
        if (transaction && existingRoot) {
          const ledger = readTransactionLedger(existingRoot);
          for (const node of existingRoot.children) {
            const pendingKey = node.getPluginData(SECTION_TRANSACTION_PENDING_KEY);
            if (!pendingKey) continue;
            if (node.getPluginData(SECTION_TRANSACTION_KEY) === pendingKey) {
              node.setPluginData(SECTION_TRANSACTION_PENDING_KEY, "");
              continue;
            }
            throw new DesignRenderError(
              "An interrupted native section is present. Its saved checkpoint is retained; inspect and remove only the incomplete marked section before resuming.",
            );
          }
          const matchingNodes = existingRoot.children.filter(
            (node) => node.getPluginData(SECTION_TRANSACTION_KEY) === transaction.idempotency_key,
          );
          if (matchingNodes.length > 1)
            throw new DesignRenderError(
              "Duplicate native section markers found; inspect this screen before resuming.",
            );
          const applied = matchingNodes[0];
          const ledgerEntry = ledger.find(({ key }) => key === transaction.idempotency_key);
          if (ledgerEntry && !applied)
            throw new DesignRenderError(
              "The native transaction ledger is committed but its section marker is missing; inspect this screen before resuming.",
            );
          if (ledgerEntry && ledgerEntry.sequence !== transaction.sequence)
            throw new DesignRenderError(
              "Native transaction ledger conflicts with the saved section sequence.",
            );
          const lastCommitted = ledger.at(-1);
          const metadataSequence = Number(
            existingRoot.getPluginData("fad.generation.sequence") || -1,
          );
          if (
            !Number.isInteger(metadataSequence) ||
            metadataSequence < -1 ||
            metadataSequence > (lastCommitted?.sequence ?? -1) ||
            (metadataSequence >= 0 &&
              existingRoot.getPluginData("fad.generation.last-idempotency-key") !==
                ledger[metadataSequence]?.key)
          )
            throw new DesignRenderError(
              "Native transaction metadata is ahead of or conflicts with its ledger.",
            );
          if (lastCommitted) {
            existingRoot.setPluginData("fad.generation.sequence", String(lastCommitted.sequence));
            existingRoot.setPluginData("fad.generation.last-idempotency-key", lastCommitted.key);
          }
          if (applied) {
            if (!ledgerEntry) {
              if (
                transaction.sequence !== (lastCommitted?.sequence ?? -1) + 1 ||
                (lastCommitted && transaction.dependencies[0] !== lastCommitted.key)
              )
                throw new DesignRenderError(
                  "Applied section marker cannot be reconciled with its transaction dependency.",
                );
              ledger.push({ sequence: transaction.sequence, key: transaction.idempotency_key });
              existingRoot.setPluginData(TRANSACTION_LEDGER_KEY, JSON.stringify(ledger));
              existingRoot.setPluginData("fad.generation.sequence", String(transaction.sequence));
              existingRoot.setPluginData(
                "fad.generation.last-idempotency-key",
                transaction.idempotency_key,
              );
            }
            existingRoot.setPluginData(
              "fad.generation.commit",
              transaction.screen_completed ||
                existingRoot.getPluginData("fad.generation.commit") === "complete"
                ? "complete"
                : "streaming",
            );
            successfulRoots.push(existingRoot);
            screenResults.push({
              id: screen.id,
              name: screen.name,
              width: screen.width,
              height: screen.height,
              status: "generated",
              counts: emptyDesignCounts(),
              warnings: [
                "Reconciled an already-applied section transaction without modifying its nodes.",
              ],
              frameName: existingRoot.name,
              nodeId: existingRoot.id,
            });
            safeProgress(options.onProgress, {
              index: index + 1,
              total: orderedScreens.length,
              screenId: screen.id,
              screenName: screen.name,
              status: "generated",
            });
            continue;
          }
          const wasCommitted = Boolean(ledgerEntry);
          const lastSequence = lastCommitted?.sequence ?? -1;
          if (
            !wasCommitted &&
            (transaction.sequence !== lastSequence + 1 ||
              (lastCommitted && transaction.dependencies[0] !== lastCommitted.key))
          )
            throw new DesignRenderError(
              "Section transaction is stale, out of order, or missing its dependency.",
            );
          if (existingRoot.getPluginData("fad.generation.commit") === "complete" && !wasCommitted)
            throw new DesignRenderError(
              "The screen is already complete; a new section was rejected.",
            );

          const created: SceneNode[] = [];
          for (const [nodeIndex, childSpec] of screenSpec.document.children.entries()) {
            const node = appendDesignNode(
              existingRoot,
              childSpec,
              screenSpec.document.layout,
              context,
              (node) => {
                node.setPluginData(SECTION_TRANSACTION_PENDING_KEY, transaction.idempotency_key);
                node.setPluginData(SECTION_SEQUENCE_KEY, String(transaction.sequence));
                node.setPluginData("fad.generation.transaction-id", transaction.transaction_id);
              },
            );
            commitSectionNode(existingRoot, node, childSpec, transaction, wasCommitted);
            if (nodeIndex !== 0)
              throw new DesignRenderError(
                "A section transaction may create exactly one root node.",
              );
            created.push(node);
          }
          const sectionRoot = created[0];
          if (!sectionRoot || sectionRoot.type !== "FRAME")
            throw new DesignRenderError(
              "Section transaction did not create its native root frame.",
            );
          if (options.verifyTouchTargets) verifyNativeTouchTargets(sectionRoot);
          if (!wasCommitted) {
            ledger.push({ sequence: transaction.sequence, key: transaction.idempotency_key });
            existingRoot.setPluginData(TRANSACTION_LEDGER_KEY, JSON.stringify(ledger));
            existingRoot.setPluginData("fad.generation.sequence", String(transaction.sequence));
            existingRoot.setPluginData(
              "fad.generation.last-idempotency-key",
              transaction.idempotency_key,
            );
          }
          existingRoot.setPluginData(
            "fad.generation.commit",
            transaction.screen_completed ||
              existingRoot.getPluginData("fad.generation.commit") === "complete"
              ? "complete"
              : "streaming",
          );
          safeSectionVisible(options.onSectionVisible, sectionRoot.id);
          successfulRoots.push(existingRoot);
          screenResults.push({
            id: screen.id,
            name: screen.name,
            width: screen.width,
            height: screen.height,
            status: "generated",
            counts: screenTracker.counts,
            warnings: [],
            frameName: existingRoot.name,
            nodeId: existingRoot.id,
          });
          addDesignCounts(counts, screenTracker.counts);
          safeProgress(options.onProgress, {
            index: index + 1,
            total: orderedScreens.length,
            screenId: screen.id,
            screenName: screen.name,
            status: "generated",
          });
          continue;
        }
        if (transaction && transaction.sequence !== 0)
          throw new DesignRenderError("The first section must create the generation screen root.");
        const frameName = uniqueName(api, displayName, frameNames, existingNames);
        const root = createDocumentFrame(
          api,
          screenSpec,
          frameName,
          context,
          undefined,
          plannedScreen,
          options.resume
            ? (frame) => {
                frame.setPluginData(MULTI_SCREEN_BATCH_KEY, batch.id);
                frame.setPluginData(MULTI_SCREEN_ID_KEY, screen.id);
                frame.setPluginData("fad.generation.commit", "pending");
              }
            : undefined,
          transaction
            ? (node) => {
                node.setPluginData(SECTION_TRANSACTION_PENDING_KEY, transaction.idempotency_key);
                node.setPluginData(SECTION_SEQUENCE_KEY, String(transaction.sequence));
                node.setPluginData("fad.generation.transaction-id", transaction.transaction_id);
              }
            : undefined,
        );
        root.setPluginData(MULTI_SCREEN_BATCH_KEY, batch.id);
        root.setPluginData(MULTI_SCREEN_ID_KEY, screen.id);
        root.setPluginData(SEMANTIC_NODE_ID_KEY, `screen:${screen.id}`);
        root.setPluginData("fad.design.logical-ref", `${screen.id}.root`);
        if (options.resume) root.setPluginData("fad.generation.commit", "pending");
        root.setPluginData(
          MULTI_SCREEN_META_KEY,
          JSON.stringify({
            batchName: batch.name,
            group: screen.group,
            devicePreset: screen.devicePreset,
            order: screen.order,
            metadata: screen.metadata,
          }),
        );
        if (styleBindings) await applyNativeStyleBindings(root, styleBindings);
        if (options.verifyTouchTargets) verifyNativeTouchTargets(root);
        const measuredBounds = getCanvasNodeBounds(root);
        let actualPlacement = plannedScreen;
        if (
          Math.abs(measuredBounds.width - screen.width) > 0.5 ||
          Math.abs(measuredBounds.height - screen.height) > 0.5
        ) {
          const actualAndRemaining: PlacementItem[] = [
            { id: placementId, width: measuredBounds.width, height: measuredBounds.height },
            ...orderedScreens.slice(index + 1).map((remainingScreen) => ({
              id: screenPlacementId(remainingScreen.id),
              width: remainingScreen.width,
              height: remainingScreen.height,
            })),
          ];
          const replanned = planCanvasPlacements(
            actualAndRemaining,
            readTopLevelCanvasObstacles(api.currentPage, new Set([root.id])),
            placementSettings,
          );
          for (const placement of replanned) placementById.set(placement.id, placement);
          actualPlacement = placementById.get(placementId) ?? plannedScreen;
        }
        placeTopLevelNode(root, measuredBounds, actualPlacement);
        if (transaction) {
          const sectionRoot = root.children[0];
          if (!sectionRoot || sectionRoot.type !== "FRAME")
            throw new DesignRenderError(
              "Section transaction did not create its native root frame.",
            );
          const ledger: Array<{ sequence: number; key: string }> = [];
          commitSectionNode(
            root,
            sectionRoot,
            screenSpec.document.children[0]!,
            transaction,
            false,
          );
          ledger.push({ sequence: transaction.sequence, key: transaction.idempotency_key });
          root.setPluginData(TRANSACTION_LEDGER_KEY, JSON.stringify(ledger));
          root.setPluginData("fad.generation.sequence", String(transaction.sequence));
          root.setPluginData("fad.generation.last-idempotency-key", transaction.idempotency_key);
          root.setPluginData(
            "fad.generation.commit",
            transaction.screen_completed ? "complete" : "streaming",
          );
          safeSectionVisible(options.onSectionVisible, sectionRoot.id);
        } else if (options.resume) root.setPluginData("fad.generation.commit", "complete");
        successfulRoots.push(root);
        const screenWarnings = styleBindings?.report.warnings.slice(warningsBeforeScreen) ?? [];
        screenResults.push({
          id: screen.id,
          name: screen.name,
          width: screen.width,
          height: screen.height,
          group: screen.group,
          devicePreset: screen.devicePreset,
          status: "generated",
          frameName,
          nodeId: root.id,
          counts: screenTracker.counts,
          warnings: screenWarnings,
        });
        addDesignCounts(counts, screenTracker.counts);
        safeProgress(options.onProgress, {
          index: index + 1,
          total: orderedScreens.length,
          screenId: screen.id,
          screenName: screen.name,
          status: "generated",
        });
      } catch (error) {
        screenTracker.cleanup();
        requiresReplan = true;
        const message =
          error instanceof Error ? error.message : "Figma could not create this screen.";
        warnings.push(`Screen “${screen.id}” failed: ${message}`);
        screenResults.push({
          id: screen.id,
          name: screen.name,
          width: screen.width,
          height: screen.height,
          group: screen.group,
          devicePreset: screen.devicePreset,
          status: "failed",
          counts: emptyDesignCounts(),
          error: message,
          warnings: [],
        });
        safeProgress(options.onProgress, {
          index: index + 1,
          total: orderedScreens.length,
          screenId: screen.id,
          screenName: screen.name,
          status: "failed",
          message,
        });
      }

      if (requiresReplan && index + 1 < orderedScreens.length) {
        try {
          // A failed screen left no page-level obstacle; fill that slot with the remaining batch.
          refreshRemainingPlacements(index + 1);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Canvas placement failed.";
          warnings.push(`The remaining screens could not be placed: ${message}`);
          markRemainingScreensFailed(index + 1, message);
          break;
        }
      }
      if (options.resume) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const generatedScreens = screenResults.filter((screen) => screen.status === "generated").length;
    if (generatedScreens === 0) {
      sharedTracker.cleanup();
      styleBindings?.rollback();
      const rolledBackAssets =
        componentCreated.length > 0 || (styleBindings?.report.created.length ?? 0) > 0;
      componentCreated.length = 0;
      if (styleBindings) styleBindings.report.created.length = 0;
      if (rolledBackAssets) {
        warnings.push(
          "New shared design-system assets were rolled back because no screen succeeded.",
        );
      }
      try {
        api.currentPage.selection = previousSelection;
      } catch {
        // Preserve the batch report if the original selection is no longer writable.
      }
    } else if (!transaction) {
      addDesignCounts(counts, sharedTracker.counts);
      try {
        api.currentPage.selection = [successfulRoots[0]];
        api.viewport.scrollAndZoomIntoView([successfulRoots[0]]);
      } catch {
        warnings.push(
          "The screens were created, but Figma could not focus the first generated screen.",
        );
      }
    }

    warnings.push(...componentWarnings, ...(styleBindings?.report.warnings ?? []));
    const createdNodeCount = sumDesignCounts(counts);
    const styleReport = styleBindings?.report;
    return {
      batchId: batch.id,
      batchName: batch.name,
      totalScreens: orderedScreens.length,
      generatedScreens,
      failedScreens: orderedScreens.length - generatedScreens,
      estimatedNodeCount,
      createdNodeCount,
      gap: placementSettings.gap,
      maxRowWidth: placementSettings.maxRowWidth,
      counts,
      screens: screenResults,
      warnings: [...fontResolution.warnings, ...visualWarnings, ...warnings],
      fontSelections: fontResolution.selections,
      designSystem:
        batch.designSystem && styleReport
          ? {
              namespace: batch.designSystem.namespace,
              created: [
                ...styleReport.created.map((key) => `style:${key}`),
                ...componentCreated.map((key) => `component:${key}`),
              ],
              reused: [
                ...styleReport.reused.map((key) => `style:${key}`),
                ...componentReused.map((key) => `component:${key}`),
              ],
              updated: styleReport.updated.map((key) => `style:${key}`),
              skipped: [
                ...styleReport.skipped.map((key) => `style:${key}`),
                ...componentSkipped.map((key) => `component:${key}`),
              ],
              fallbacks: styleReport.fallbacks,
              warnings: [...componentWarnings, ...styleReport.warnings],
            }
          : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Figma could not generate the batch.";
    if (successfulRoots.length === 0) {
      sharedTracker.cleanup();
      styleBindings?.rollback();
      try {
        api.currentPage.selection = previousSelection;
      } catch {
        // Keep the original failure as the actionable result.
      }
      const result = failedMultiScreenResult(
        batch,
        message,
        { gap: placementSettings.gap, maxRowWidth: placementSettings.maxRowWidth },
        fontResolution?.selections,
      );
      result.estimatedNodeCount = estimatedNodeCount;
      return result;
    }
    warnings.push(`Batch stopped after an unexpected error: ${message}`);
    warnings.push(...componentWarnings, ...(styleBindings?.report.warnings ?? []));
    const attemptedCount = screenResults.length;
    if (attemptedCount < orderedScreens.length) markRemainingScreensFailed(attemptedCount, message);
    addDesignCounts(counts, sharedTracker.counts);
    try {
      if (successfulRoots.length > 0) {
        api.currentPage.selection = [successfulRoots[0]];
        api.viewport.scrollAndZoomIntoView([successfulRoots[0]]);
      }
    } catch {
      warnings.push(
        "The partial batch was created, but Figma could not focus its first generated screen.",
      );
    }
    return {
      batchId: batch.id,
      batchName: batch.name,
      totalScreens: orderedScreens.length,
      generatedScreens: successfulRoots.length,
      failedScreens: orderedScreens.length - successfulRoots.length,
      estimatedNodeCount,
      createdNodeCount: sumDesignCounts(counts),
      gap: placementSettings.gap,
      maxRowWidth: placementSettings.maxRowWidth,
      counts,
      screens: screenResults,
      warnings: [...(fontResolution?.warnings ?? []), ...visualWarnings, ...warnings],
      fontSelections: fontResolution?.selections ?? [],
      designSystem:
        batch.designSystem && styleBindings
          ? {
              namespace: batch.designSystem.namespace,
              created: [
                ...styleBindings.report.created.map((key) => `style:${key}`),
                ...componentCreated.map((key) => `component:${key}`),
              ],
              reused: [
                ...styleBindings.report.reused.map((key) => `style:${key}`),
                ...componentReused.map((key) => `component:${key}`),
              ],
              updated: styleBindings.report.updated.map((key) => `style:${key}`),
              skipped: [
                ...styleBindings.report.skipped.map((key) => `style:${key}`),
                ...componentSkipped.map((key) => `component:${key}`),
              ],
              fallbacks: styleBindings.report.fallbacks,
              warnings: [...componentWarnings, ...styleBindings.report.warnings],
            }
          : undefined,
    };
  }
}
