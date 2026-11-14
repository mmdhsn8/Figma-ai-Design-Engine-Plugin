import { z } from "zod";

export const MAX_NATIVE_QUALITY_SCAN_NODES = 5_000;
export const MAX_NATIVE_QUALITY_SCAN_DEPTH = 48;
export const MAX_NATIVE_QUALITY_OVERLAP_PAIRS = 50_000;

export interface NativeVisualColor {
  r: number;
  g: number;
  b: number;
}

export interface NativeVisualNode {
  ownedByTask?: boolean;
  ref?: string;
  logicalRef?: string;
  assetId?: string;
  pattern?: string;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  text?: string;
  fill?: string;
  fillRGB?: NativeVisualColor;
  fillOpacity?: number;
  fillStyleId?: string;
  textColor?: string;
  textColorRGB?: NativeVisualColor;
  textColorOpacity?: number;
  stroke?: string;
  strokeWeight?: number;
  cornerRadius?: number;
  opacity?: number;
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;
  textStyleId?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAutoResize?: "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT" | "TRUNCATE";
  shadow?: {
    color: string;
    opacity: number;
    offsetX: number;
    offsetY: number;
    radius: number;
    spread: number;
  };
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  primaryAxisSizingMode?: "AUTO" | "FIXED";
  counterAxisSizingMode?: "AUTO" | "FIXED";
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutPositioning?: string;
  textAlignHorizontal?: string;
  clipsContent?: boolean;
  absoluteTransform?: [[number, number, number], [number, number, number]];
  bounds?: { x: number; y: number; width: number; height: number };
  children?: NativeVisualNode[];
}

const NativeBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
  })
  .strict();
const NativeVisualColorSchema = z
  .object({
    r: z.number().finite().min(0).max(1),
    g: z.number().finite().min(0).max(1),
    b: z.number().finite().min(0).max(1),
  })
  .strict();

export const NativeVisualNodeSchema: z.ZodType<NativeVisualNode> = z.lazy(() =>
  z
    .object({
      ref: z.string().max(80).optional(),
      logicalRef: z.string().max(120).optional(),
      assetId: z.string().max(100).optional(),
      pattern: z.string().max(40).optional(),
      qualityRole: z.enum(["button", "input", "image", "heading", "body", "decorative"]).optional(),
      type: z.string().max(40),
      name: z.string().max(100),
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().min(0),
      height: z.number().finite().min(0),
      visible: z.boolean(),
      text: z.string().max(120).optional(),
      fill: z
        .string()
        .regex(/^#[\da-f]{6}$/iu)
        .optional(),
      fillRGB: NativeVisualColorSchema.optional(),
      fillOpacity: z.number().finite().min(0).max(1).optional(),
      fillStyleId: z.string().max(100).optional(),
      textColor: z
        .string()
        .regex(/^#[\da-f]{6}$/iu)
        .optional(),
      textColorRGB: NativeVisualColorSchema.optional(),
      textColorOpacity: z.number().finite().min(0).max(1).optional(),
      stroke: z
        .string()
        .regex(/^#[\da-f]{6}$/iu)
        .optional(),
      strokeWeight: z.number().finite().min(0).max(100).optional(),
      cornerRadius: z.number().finite().min(0).max(500).optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
      fontSize: z.number().finite().min(0).max(1_000).optional(),
      fontFamily: z.string().max(80).optional(),
      fontStyle: z.string().max(80).optional(),
      textStyleId: z.string().max(100).optional(),
      lineHeight: z.number().finite().positive().optional(),
      letterSpacing: z.number().finite().optional(),
      textAutoResize: z.enum(["NONE", "HEIGHT", "WIDTH_AND_HEIGHT", "TRUNCATE"]).optional(),
      shadow: z
        .object({
          color: z.string().regex(/^#[\da-f]{6}$/iu),
          opacity: z.number().finite().min(0).max(1),
          offsetX: z.number().finite(),
          offsetY: z.number().finite(),
          radius: z.number().finite().min(0),
          spread: z.number().finite(),
        })
        .strict()
        .optional(),
      layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
      itemSpacing: z.number().finite().optional(),
      padding: z
        .object({
          top: z.number().finite(),
          right: z.number().finite(),
          bottom: z.number().finite(),
          left: z.number().finite(),
        })
        .strict()
        .optional(),
      primaryAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
      counterAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
      primaryAxisAlignItems: z.string().max(40).optional(),
      counterAxisAlignItems: z.string().max(40).optional(),
      layoutSizingHorizontal: z.string().max(40).optional(),
      layoutSizingVertical: z.string().max(40).optional(),
      layoutPositioning: z.string().max(40).optional(),
      textAlignHorizontal: z.string().max(40).optional(),
      clipsContent: z.boolean().optional(),
      absoluteTransform: z
        .tuple([
          z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
          z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
        ])
        .optional(),
      bounds: NativeBoundsSchema.optional(),
      children: z.array(NativeVisualNodeSchema).max(25).optional(),
    })
    .passthrough(),
);

export interface NativeVisualFinding {
  code:
    | "missing-ref"
    | "invalid-geometry"
    | "hidden-node"
    | "empty-text"
    | "clipped-child"
    | "overlapping-auto-layout"
    | "overlap-analysis-limit"
    | "low-contrast"
    | "viewport-mismatch"
    | "missing-section"
    | "insufficient-hierarchy"
    | "undersized-target"
    | "inconsistent-cards"
    | "missing-native-fallback"
    | "excessive-whitespace"
    | "type-mismatch"
    | "parent-mismatch"
    | "value-mismatch";
  ref?: string;
  refs?: string[];
  message: string;
  expected: string;
  actual: string;
}

export interface StorefrontQualityInput {
  viewport: { width: number; height: number };
  screenRef: string;
  sectionRefs: string[];
  productCardRefs: string[];
  purchaseTargetRefs: string[];
  interactiveTargetRefs?: string[];
  titleRef: string;
  nativeFallbackRefs: string[];
  nodes: NativeVisualNode[];
}

function flatten(nodes: NativeVisualNode[]): NativeVisualNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function rect(node: NativeVisualNode) {
  return node.bounds ?? { x: node.x, y: node.y, width: node.width, height: node.height };
}

function overlaps(a: NativeVisualNode, b: NativeVisualNode): boolean {
  const first = rect(a);
  const second = rect(b);
  return (
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x) > 1 &&
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y) > 1
  );
}

function childBoundsInParent(
  parent: NativeVisualNode,
  child: NativeVisualNode,
): { x: number; y: number; width: number; height: number } | undefined {
  if (parent.absoluteTransform && child.absoluteTransform) {
    const [[a, c, e], [b, d, f]] = parent.absoluteTransform;
    const determinant = a * d - b * c;
    if (Math.abs(determinant) > Number.EPSILON) {
      const [[childA, childC, childE], [childB, childD, childF]] = child.absoluteTransform;
      const corners = [
        [0, 0],
        [child.width, 0],
        [0, child.height],
        [child.width, child.height],
      ];
      const points = corners.map(([x, y]) => {
        const absoluteX = childA * x + childC * y + childE;
        const absoluteY = childB * x + childD * y + childF;
        const localX = (d * (absoluteX - e) - c * (absoluteY - f)) / determinant;
        const localY = (-b * (absoluteX - e) + a * (absoluteY - f)) / determinant;
        return { x: localX, y: localY };
      });
      const left = Math.min(...points.map(({ x }) => x));
      const top = Math.min(...points.map(({ y }) => y));
      const right = Math.max(...points.map(({ x }) => x));
      const bottom = Math.max(...points.map(({ y }) => y));
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
  }
  return undefined;
}

function contains(parent: NativeVisualNode, child: NativeVisualNode): boolean {
  const relative = childBoundsInParent(parent, child);
  if (relative) {
    const epsilon = 1e-3;
    return (
      relative.x >= -epsilon &&
      relative.y >= -epsilon &&
      relative.x + relative.width <= parent.width + epsilon &&
      relative.y + relative.height <= parent.height + epsilon
    );
  }
  const outer = rect(parent);
  const inner = rect(child);
  const epsilon = 1e-3;
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}

type Color = NativeVisualColor;

function luminanceColor(color: Color): number {
  const linear = [color.r, color.g, color.b].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function luminance(hex: string, rgb?: NativeVisualColor): number | undefined {
  const color = colorChannels(hex, rgb);
  return color ? luminanceColor(color) : undefined;
}

function contrastRatio(foreground: Color, background: Color): number {
  const first = luminanceColor(foreground);
  const second = luminanceColor(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function nativeContrastRatio(foreground: string, background: string): number | undefined {
  const first = luminance(foreground);
  const second = luminance(background);
  if (first === undefined || second === undefined) return undefined;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function colorChannels(hex?: string, rgb?: NativeVisualColor): Color | undefined {
  if (
    rgb &&
    [rgb.r, rgb.g, rgb.b].every(
      (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1,
    )
  )
    return rgb;
  if (!hex) return undefined;
  if (!/^#[\da-f]{6}$/iu.test(hex)) return undefined;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function composite(foreground: Color, background: Color, alpha: number): Color {
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
  };
}

export function nativeTextContrastCorrection(
  roots: NativeVisualNode[],
  ref: string,
  palette: string[],
) {
  let result: { color?: string; reason: string } = { reason: "effective_background_unavailable" };
  const visit = (node: NativeVisualNode, background?: Color, opacity = 1): void => {
    const alpha = opacity * (node.opacity ?? 1);
    if (node.ref === ref && node.type === "TEXT" && background) {
      const foreground = colorChannels(node.textColor, node.textColorRGB);
      if (!foreground) {
        result = { reason: "solid_foreground_unavailable" };
        return;
      }
      const threshold = (node.fontSize ?? 0) >= 24 ? 3 : 4.5;
      const hex = (color: Color) =>
        `#${[color.r, color.g, color.b]
          .map((channel) =>
            Math.round(channel * 255)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`.toUpperCase();
      const passes = (value: string) => {
        const color = colorChannels(value);
        // The native color operation writes an opaque paint, retaining node and ancestor opacity.
        return (
          color && contrastRatio(composite(color, background!, alpha), background!) >= threshold
        );
      };
      const distance = (value: string) => {
        const color = colorChannels(value)!;
        return (
          (color.r - foreground.r) ** 2 +
          (color.g - foreground.g) ** 2 +
          (color.b - foreground.b) ** 2
        );
      };
      const candidates = palette.filter((value) => colorChannels(value) && passes(value));
      if (!candidates.length)
        for (const endpoint of [0, 1]) {
          if (!passes(endpoint === 0 ? "#000000" : "#FFFFFF")) continue;
          let low = 0,
            high = 1;
          const blend = (amount: number) =>
            hex({
              r: foreground.r + (endpoint - foreground.r) * amount,
              g: foreground.g + (endpoint - foreground.g) * amount,
              b: foreground.b + (endpoint - foreground.b) * amount,
            });
          for (let step = 0; step < 16; step++) {
            const middle = (low + high) / 2;
            if (passes(blend(middle))) high = middle;
            else low = middle;
          }
          candidates.push(blend(high));
        }
      const color = candidates.sort((a, b) => distance(a) - distance(b) || a.localeCompare(b))[0];
      result = color
        ? { color, reason: "measured_foreground_contrast" }
        : { reason: "opacity_prevents_required_contrast" };
    }
    const fill = colorChannels(node.fill, node.fillRGB);
    const fillAlpha = (node.fillOpacity ?? 1) * (node.opacity ?? 1);
    const nextBackground = fill
      ? background
        ? composite(fill, background, fillAlpha)
        : fillAlpha >= 0.999
          ? fill
          : undefined
      : background;
    for (const child of node.children ?? []) visit(child, nextBackground, alpha);
  };
  const nested = new Set(
    roots.flatMap((node) => flatten(node.children ?? [])).map((node) => node.ref),
  );
  roots.filter((node) => !node.ref || !nested.has(node.ref)).forEach((node) => visit(node));
  return result;
}

function overflowAmount(parent: NativeVisualNode, child: NativeVisualNode): number {
  const relative = childBoundsInParent(parent, child);
  const outer = relative
    ? { x: 0, y: 0, width: parent.width, height: parent.height }
    : rect(parent);
  const inner = relative ?? rect(child);
  return (
    Math.max(0, outer.x - inner.x) +
    Math.max(0, outer.y - inner.y) +
    Math.max(0, inner.x + inner.width - outer.x - outer.width) +
    Math.max(0, inner.y + inner.height - outer.y - outer.height)
  );
}

export function auditNativeSection(
  roots: NativeVisualNode[],
  expectedRefs: string[],
): NativeVisualFinding[] {
  const findings: NativeVisualFinding[] = [];
  let overlapPairs = 0;
  let overlapAnalysisLimited = false;
  const all = flatten(roots);
  const byRef = new Map(all.flatMap((node) => (node.ref ? [[node.ref, node] as const] : [])));
  for (const ref of expectedRefs)
    if (!byRef.has(ref))
      findings.push({
        code: "missing-ref",
        ref,
        message: `Expected layer “${ref}” was not found in the committed section.`,
        expected: "present",
        actual: "missing",
      });

  const visit = (
    node: NativeVisualNode,
    parent?: NativeVisualNode,
    inheritedBackground?: Color,
    inheritedOpacity = 1,
  ): void => {
    const bounds = rect(node);
    if (
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    )
      findings.push({
        code: "invalid-geometry",
        ref: node.ref,
        message: `“${node.name}” has invalid or empty geometry.`,
        expected: "finite x/y and positive width/height",
        actual: JSON.stringify(bounds),
      });
    if (!node.visible)
      findings.push({
        code: "hidden-node",
        ref: node.ref,
        message: `“${node.name}” is hidden.`,
        expected: "visible=true",
        actual: "visible=false",
      });
    if (parent?.clipsContent && !contains(parent, node)) {
      const flow = (parent.children ?? []).filter(
        (child) => child.visible && child.layoutPositioning !== "ABSOLUTE",
      );
      const gaps = Math.max(0, flow.length - 1) * (parent.itemSpacing ?? 0);
      findings.push({
        code: "clipped-child",
        ref: node.ref,
        message: `“${node.name}” is clipped by a parent with clipsContent enabled; geometry alone cannot determine whether that clip is intentional.`,
        expected: JSON.stringify({
          parentRef: parent.ref,
          parent: rect(parent),
          clipsContent: true,
        }),
        actual: JSON.stringify({
          parentRef: parent.ref,
          child: bounds,
          overflow: overflowAmount(parent, node),
          measurement:
            parent.absoluteTransform && node.absoluteTransform
              ? "parent-local-transform"
              : "absolute-bounds",
          available: {
            width: parent.width - (parent.padding?.left ?? 0) - (parent.padding?.right ?? 0),
            height: parent.height - (parent.padding?.top ?? 0) - (parent.padding?.bottom ?? 0),
          },
          required: {
            width:
              parent.layoutMode === "HORIZONTAL"
                ? flow.reduce((sum, child) => sum + child.width, 0) + gaps
                : Math.max(0, ...flow.map((child) => child.width)),
            height:
              parent.layoutMode === "VERTICAL"
                ? flow.reduce((sum, child) => sum + child.height, 0) + gaps
                : Math.max(0, ...flow.map((child) => child.height)),
          },
          classification:
            parent.layoutMode &&
            parent.layoutMode !== "NONE" &&
            node.layoutPositioning !== "ABSOLUTE"
              ? "auto-layout-overflow"
              : "explicit-clip",
          parentLayout: {
            mode: parent.layoutMode ?? "NONE",
            padding: parent.padding,
            primarySizing: parent.primaryAxisSizingMode,
            counterSizing: parent.counterAxisSizingMode,
            horizontal: parent.layoutSizingHorizontal,
            vertical: parent.layoutSizingVertical,
          },
          childLayoutPositioning: node.layoutPositioning ?? "AUTO",
        }),
      });
    }
    if (node.type === "TEXT" && !node.text?.trim())
      findings.push({
        code: "empty-text",
        ref: node.ref,
        message: `Editable text layer “${node.name}” is empty.`,
        expected: "non-empty editable text",
        actual: "empty",
      });
    const effectiveOpacity = inheritedOpacity * (node.opacity ?? 1);
    const foreground = colorChannels(node.textColor, node.textColorRGB);
    if (node.type === "TEXT" && foreground && inheritedBackground) {
      const visibleForeground = composite(
        foreground,
        inheritedBackground,
        effectiveOpacity * (node.textColorOpacity ?? 1),
      );
      const ratio = contrastRatio(visibleForeground, inheritedBackground);
      const contrastThreshold = (node.fontSize ?? 0) >= 24 ? 3 : 4.5;
      if (ratio !== undefined && ratio < contrastThreshold)
        findings.push({
          code: "low-contrast",
          ref: node.ref,
          message: `“${node.name}” has ${ratio}:1 contrast against its measurable surface.`,
          expected: `at least ${contrastThreshold}:1 contrast`,
          actual: `${ratio}:1 contrast (threshold ${contrastThreshold}:1)`,
        });
    }
    const children = node.children ?? [];
    if (node.layoutMode === "VERTICAL" || node.layoutMode === "HORIZONTAL") {
      const pairCount = (children.length * (children.length - 1)) / 2;
      if (overlapPairs + pairCount > MAX_NATIVE_QUALITY_OVERLAP_PAIRS) {
        if (!overlapAnalysisLimited)
          findings.push({
            code: "overlap-analysis-limit",
            ref: node.ref,
            message: `Auto Layout overlap analysis reached its ${MAX_NATIVE_QUALITY_OVERLAP_PAIRS}-pair safety budget.`,
            expected: `at most ${MAX_NATIVE_QUALITY_OVERLAP_PAIRS} sibling comparisons`,
            actual: `${overlapPairs + pairCount} required comparisons`,
          });
        overlapAnalysisLimited = true;
      } else {
        overlapPairs += pairCount;
        for (let first = 0; first < children.length; first++)
          for (let second = first + 1; second < children.length; second++)
            if (
              children[first]!.layoutPositioning !== "ABSOLUTE" &&
              children[second]!.layoutPositioning !== "ABSOLUTE" &&
              overlaps(children[first]!, children[second]!)
            ) {
              const firstBounds = rect(children[first]!);
              const secondBounds = rect(children[second]!);
              const overlapWidth = Math.max(
                0,
                Math.min(firstBounds.x + firstBounds.width, secondBounds.x + secondBounds.width) -
                  Math.max(firstBounds.x, secondBounds.x),
              );
              const overlapHeight = Math.max(
                0,
                Math.min(firstBounds.y + firstBounds.height, secondBounds.y + secondBounds.height) -
                  Math.max(firstBounds.y, secondBounds.y),
              );
              findings.push({
                code: "overlapping-auto-layout",
                ref: children[second]!.ref,
                refs: [children[first]!.ref, children[second]!.ref].filter((ref): ref is string =>
                  Boolean(ref),
                ),
                message: `“${children[first]!.name}” overlaps “${children[second]!.name}” inside Auto Layout “${node.name}”.`,
                expected: "non-overlapping children",
                actual: JSON.stringify({
                  overlapWidth,
                  overlapHeight,
                  overlapArea: overlapWidth * overlapHeight,
                }),
              });
            }
      }
    }
    const fill = colorChannels(node.fill, node.fillRGB);
    const fillAlpha = (node.fillOpacity ?? 1) * (node.opacity ?? 1);
    const background = fill
      ? inheritedBackground
        ? composite(fill, inheritedBackground, fillAlpha)
        : fillAlpha >= 0.999
          ? fill
          : undefined
      : inheritedBackground;
    children.forEach((child) => visit(child, node, background, effectiveOpacity));
  };
  const nestedRefs = new Set(
    roots
      .flatMap((node) => flatten(node.children ?? []))
      .flatMap((node) => (node.ref ? [node.ref] : [])),
  );
  roots.filter((node) => !node.ref || !nestedRefs.has(node.ref)).forEach((node) => visit(node));
  return [
    ...new Map(
      findings.map((finding) => [
        JSON.stringify([
          finding.code,
          [...(finding.refs ?? (finding.ref ? [finding.ref] : []))].sort(),
          finding.expected,
          finding.actual,
        ]),
        finding,
      ]),
    ).values(),
  ];
}

export function auditStorefrontDesign(input: StorefrontQualityInput): NativeVisualFinding[] {
  const findings = auditNativeSection(input.nodes, [
    input.screenRef,
    ...input.productCardRefs,
    ...input.purchaseTargetRefs,
    ...(input.interactiveTargetRefs ?? []),
    input.titleRef,
    ...input.nativeFallbackRefs,
  ]);
  const all = flatten(input.nodes);
  const byRef = new Map(all.flatMap((node) => (node.ref ? [[node.ref, node] as const] : [])));
  const screen = byRef.get(input.screenRef);
  if (
    screen &&
    (Math.abs(screen.width - input.viewport.width) > 1 ||
      Math.abs(screen.height - input.viewport.height) > 1)
  )
    findings.push({
      code: "viewport-mismatch",
      ref: input.screenRef,
      message: `Screen is ${screen.width}×${screen.height}; expected ${input.viewport.width}×${input.viewport.height}.`,
      expected: `${input.viewport.width}×${input.viewport.height}`,
      actual: `${screen.width}×${screen.height}`,
    });
  for (const ref of input.sectionRefs)
    if (!byRef.has(ref))
      findings.push({
        code: "missing-section",
        ref,
        message: `Required storefront section “${ref}” is missing.`,
        expected: "section present",
        actual: "missing",
      });
  const title = byRef.get(input.titleRef);
  const textSizes = all
    .filter((node) => node.type === "TEXT" && node.fontSize !== undefined)
    .map((node) => node.fontSize!);
  if (
    !title ||
    (title.fontSize ?? 0) < 24 ||
    (textSizes.length && Math.max(...textSizes) - Math.min(...textSizes) < 10)
  )
    findings.push({
      code: "insufficient-hierarchy",
      ref: input.titleRef,
      message: "Use a 24px+ primary heading and a distinct supporting type scale.",
      expected: "title font >=24px and text scale difference >=10px",
      actual: JSON.stringify({
        titleFontSize: title?.fontSize ?? 0,
        textScaleDifference:
          textSizes.length > 0 ? Math.max(...textSizes) - Math.min(...textSizes) : null,
      }),
    });
  const cards = input.productCardRefs
    .map((ref) => byRef.get(ref))
    .filter((node): node is NativeVisualNode => Boolean(node));
  if (cards.length >= 2) {
    const widths = cards.map((card) => card.width);
    const heights = cards.map((card) => card.height);
    if (
      Math.max(...widths) - Math.min(...widths) > 8 ||
      Math.max(...heights) - Math.min(...heights) > 12 ||
      cards.some((card) => !card.fill || (card.cornerRadius ?? 0) < 12)
    )
      findings.push({
        code: "inconsistent-cards",
        refs: cards.flatMap((card) => (card.ref ? [card.ref] : [])),
        message:
          "Product cards need consistent proportions, a visible surface, and a shared rounded shape.",
        expected: "width delta <=8px, height delta <=12px, surface present, radius >=12px",
        actual: JSON.stringify(
          cards.map((card) => ({
            width: card.width,
            height: card.height,
            surfacePresent: Boolean(card.fill),
            cornerRadius: card.cornerRadius ?? 0,
          })),
        ),
      });
  }
  for (const ref of [...input.purchaseTargetRefs, ...(input.interactiveTargetRefs ?? [])]) {
    const target = byRef.get(ref);
    if (target && (target.width < 44 || target.height < 44))
      findings.push({
        code: "undersized-target",
        ref,
        message: `Purchase target “${ref}” is below 44×44px.`,
        expected: "at least 44×44px",
        actual: `${target.width}×${target.height}`,
      });
  }
  for (const ref of input.nativeFallbackRefs) {
    const fallback = byRef.get(ref);
    if (
      fallback &&
      !/بدون تصویر واقعی|بدون عکس واقعی|not a photo|no real image/iu.test(fallback.text ?? "")
    )
      findings.push({
        code: "missing-native-fallback",
        ref,
        message: `“${ref}” must clearly disclose that the native illustration is not a product photo.`,
        expected: "explicit native-placeholder disclosure",
        actual: "disclosure missing",
      });
  }
  const contentBounds = input.nodes.flatMap((node) =>
    node.ref === input.screenRef ? (node.children ?? []) : [],
  );
  if (contentBounds.length) {
    const top = Math.min(...contentBounds.map((node) => rect(node).y));
    const bottom = Math.max(...contentBounds.map((node) => rect(node).y + rect(node).height));
    if ((bottom - top) / input.viewport.height < 0.7)
      findings.push({
        code: "excessive-whitespace",
        ref: input.screenRef,
        message:
          "Main storefront content occupies less than 70% of the viewport; review density and unexplained blank space.",
        expected: "content occupies at least 70% of viewport height",
        actual: `${Math.round(((bottom - top) / input.viewport.height) * 100)}%`,
      });
    const ordered = [...contentBounds].sort((first, second) => rect(first).y - rect(second).y);
    for (let index = 1; index < ordered.length; index++) {
      const previous = rect(ordered[index - 1]!);
      const current = rect(ordered[index]!);
      if (current.y - (previous.y + previous.height) > 80) {
        findings.push({
          code: "excessive-whitespace",
          ref: ordered[index]!.ref,
          message: `There is an unexplained ${Math.round(current.y - previous.y - previous.height)}px gap before “${ordered[index]!.name}”.`,
          expected: "vertical gap <=80px",
          actual: `${Math.round(current.y - previous.y - previous.height)}px`,
        });
        break;
      }
    }
  }
  return findings;
}
