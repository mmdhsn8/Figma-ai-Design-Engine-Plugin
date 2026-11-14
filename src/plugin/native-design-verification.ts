import {
  auditNativeSection,
  MAX_NATIVE_QUALITY_SCAN_DEPTH,
  MAX_NATIVE_QUALITY_SCAN_NODES,
  type NativeVisualFinding,
  type NativeVisualNode,
} from "../shared/native-visual-quality";
import type { VisualDesignSpec } from "../shared/visual-design-spec";

export const MAX_NATIVE_DESIGN_QA_NODES = MAX_NATIVE_QUALITY_SCAN_NODES;
export const MAX_NATIVE_DESIGN_QA_DEPTH = MAX_NATIVE_QUALITY_SCAN_DEPTH;

export interface NativeDesignVerification {
  verified: boolean;
  truncated: boolean;
  nodeCount: number;
  findings: NativeVisualFinding[];
  missingPatterns: string[];
  rootNodeId: string;
}

type InspectableNode = SceneNode & {
  fills?: readonly Paint[] | symbol;
  strokes?: readonly Paint[] | symbol;
  characters?: string;
  fontSize?: number | symbol;
  fontName?: FontName | symbol;
  lineHeight?: LineHeight | symbol;
  letterSpacing?: LetterSpacing | symbol;
  textAutoResize?: "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT" | "TRUNCATE";
  textAlignHorizontal?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutPositioning?: string;
  clipsContent?: boolean;
  overflowDirection?: "NONE" | "HORIZONTAL" | "VERTICAL" | "BOTH";
  cornerRadius?: number | symbol;
  opacity?: number;
  strokeWeight?: number;
  effects?: readonly Effect[] | symbol;
};

function solidPaint(paints: readonly Paint[] | symbol | undefined): SolidPaint | undefined {
  return Array.isArray(paints)
    ? paints.find((paint): paint is SolidPaint => paint.type === "SOLID")
    : undefined;
}

function hex(color: RGB): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function snapshotNode(node: InspectableNode): NativeVisualNode {
  const fill = solidPaint(node.fills);
  const textFill = node.type === "TEXT" ? fill : undefined;
  const stroke = solidPaint(node.strokes);
  const dropShadow = Array.isArray(node.effects)
    ? node.effects.find(
        (effect): effect is DropShadowEffect => effect.type === "DROP_SHADOW" && effect.visible,
      )
    : undefined;
  const fontName =
    node.type === "TEXT" && node.fontName && typeof node.fontName === "object"
      ? (node.fontName as FontName)
      : undefined;
  const transform = node.absoluteTransform;
  return {
    ref: node.getPluginData("fad.design.logical-ref") || node.id,
    logicalRef: node.getPluginData("fad.design.logical-ref") || undefined,
    assetId: node.getPluginData("fad.design.asset-id") || undefined,
    pattern: node.getPluginData("fad.design.pattern") || undefined,
    qualityRole: node.getPluginData("fad.design.quality-role") as NativeVisualNode["qualityRole"],
    type: node.type,
    name: node.name.slice(0, 100),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
    ...(node.type === "TEXT" ? { text: (node.characters ?? "").slice(0, 120) } : {}),
    ...(fill ? { fill: hex(fill.color), fillRGB: fill.color, fillOpacity: fill.opacity ?? 1 } : {}),
    ...(textFill
      ? {
          textColor: hex(textFill.color),
          textColorRGB: textFill.color,
          textColorOpacity: textFill.opacity ?? 1,
        }
      : {}),
    ...(stroke ? { stroke: hex(stroke.color), strokeWeight: finiteNumber(node.strokeWeight) } : {}),
    ...(typeof node.cornerRadius === "number" ? { cornerRadius: node.cornerRadius } : {}),
    ...(dropShadow
      ? {
          shadow: {
            color: hex(dropShadow.color),
            opacity: dropShadow.color.a,
            offsetX: dropShadow.offset.x,
            offsetY: dropShadow.offset.y,
            radius: dropShadow.radius,
            spread: dropShadow.spread ?? 0,
          },
        }
      : {}),
    opacity: node.opacity,
    ...(node.type === "TEXT"
      ? {
          ...(typeof node.fontSize === "number" ? { fontSize: node.fontSize } : {}),
          ...(fontName ? { fontFamily: fontName.family, fontStyle: fontName.style } : {}),
          ...(node.lineHeight &&
          typeof node.lineHeight === "object" &&
          node.lineHeight.unit === "PIXELS"
            ? { lineHeight: node.lineHeight.value }
            : {}),
          ...(node.letterSpacing &&
          typeof node.letterSpacing === "object" &&
          node.letterSpacing.unit === "PIXELS"
            ? { letterSpacing: node.letterSpacing.value }
            : {}),
          ...(node.textAutoResize ? { textAutoResize: node.textAutoResize } : {}),
          ...(node.textAlignHorizontal ? { textAlignHorizontal: node.textAlignHorizontal } : {}),
        }
      : {}),
    ...(node.layoutMode ? { layoutMode: node.layoutMode as NativeVisualNode["layoutMode"] } : {}),
    ...(finiteNumber(node.itemSpacing) !== undefined ? { itemSpacing: node.itemSpacing } : {}),
    ...(finiteNumber(node.paddingTop) !== undefined
      ? {
          padding: {
            top: node.paddingTop!,
            right: node.paddingRight ?? 0,
            bottom: node.paddingBottom ?? 0,
            left: node.paddingLeft ?? 0,
          },
        }
      : {}),
    ...(node.primaryAxisSizingMode
      ? {
          primaryAxisSizingMode:
            node.primaryAxisSizingMode as NativeVisualNode["primaryAxisSizingMode"],
        }
      : {}),
    ...(node.counterAxisSizingMode
      ? {
          counterAxisSizingMode:
            node.counterAxisSizingMode as NativeVisualNode["counterAxisSizingMode"],
        }
      : {}),
    ...(node.primaryAxisAlignItems ? { primaryAxisAlignItems: node.primaryAxisAlignItems } : {}),
    ...(node.counterAxisAlignItems ? { counterAxisAlignItems: node.counterAxisAlignItems } : {}),
    ...(node.layoutSizingHorizontal ? { layoutSizingHorizontal: node.layoutSizingHorizontal } : {}),
    ...(node.layoutSizingVertical ? { layoutSizingVertical: node.layoutSizingVertical } : {}),
    ...(node.layoutPositioning ? { layoutPositioning: node.layoutPositioning } : {}),
    ...(node.clipsContent !== undefined ? { clipsContent: node.clipsContent } : {}),
    ...(node.overflowDirection ? { overflowDirection: node.overflowDirection } : {}),
    ...(node.absoluteBoundingBox ? { bounds: node.absoluteBoundingBox } : {}),
    ...(transform
      ? { absoluteTransform: transform as [[number, number, number], [number, number, number]] }
      : {}),
    children: [],
  };
}

/** Freshly reads the committed Figma tree in bounded chunks, then verifies the planned native refs. */
export async function verifyNativeDesign(
  api: Pick<PluginAPI, "getNodeByIdAsync" | "currentPage">,
  rootNodeId: string,
  expectedPageId: string,
  spec: VisualDesignSpec,
): Promise<NativeDesignVerification> {
  const found = await api.getNodeByIdAsync(rootNodeId);
  if (!found || found.type !== "FRAME")
    return {
      verified: false,
      truncated: false,
      nodeCount: 0,
      findings: [
        {
          code: "missing-ref",
          ref: spec.screen.id + ".root",
          message: "Rendered screen root is unavailable for fresh native verification.",
          expected: "existing native FRAME",
          actual: "missing",
        },
      ],
      missingPatterns: spec.requiredPatterns,
      rootNodeId,
    };
  let page: BaseNode | null = found;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page?.id !== expectedPageId || api.currentPage.id !== expectedPageId)
    throw new Error(
      "Figma page changed before native design verification; the saved canvas work was retained.",
    );

  let nodeCount = 0;
  let truncated = false;
  const actualNodes = new Map<string, SceneNode>();
  const actualSnapshots = new Map<string, NativeVisualNode>();
  const root = found as SceneNode;
  const visit = async (node: SceneNode, depth: number): Promise<NativeVisualNode> => {
    nodeCount++;
    const output = snapshotNode(node as InspectableNode);
    const logicalRef = node.getPluginData("fad.design.logical-ref");
    if (logicalRef) {
      actualNodes.set(logicalRef, node);
      actualSnapshots.set(logicalRef, output);
    }
    if (depth >= MAX_NATIVE_DESIGN_QA_DEPTH) {
      if ("children" in node && node.children.length) truncated = true;
      return output;
    }
    if ("children" in node) {
      const children = node.children;
      for (let index = 0; index < children.length; index++) {
        if (nodeCount >= MAX_NATIVE_DESIGN_QA_NODES) {
          truncated = true;
          break;
        }
        const child = children[index] as SceneNode;
        output.children!.push(await visit(child, depth + 1));
        if (nodeCount % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return output;
  };
  const nativeTree = await visit(root, 0);
  const expectedRefs = spec.nodes.map((node) => node.logicalRef);
  const findings = auditNativeSection([nativeTree], expectedRefs);
  const nativeFindings: NativeVisualFinding[] = [...findings];
  const nativeTypeByNodeType: Record<VisualDesignSpec["nodes"][number]["nativeType"], string> = {
    FRAME: "FRAME",
    RECTANGLE: "RECTANGLE",
    ELLIPSE: "ELLIPSE",
    TEXT: "TEXT",
    VECTOR: "VECTOR",
  };
  for (const expected of spec.nodes) {
    const node = actualNodes.get(expected.logicalRef);
    if (!node) continue;
    const actual = actualSnapshots.get(expected.logicalRef);
    const expectedNativeType = nativeTypeByNodeType[expected.nativeType];
    const isImageNode = expected.nodeType === "image" && ["FRAME", "RECTANGLE"].includes(node.type);
    if (node.type !== expectedNativeType && !isImageNode)
      nativeFindings.push({
        code: "type-mismatch",
        ref: expected.logicalRef,
        message: "Native layer kind differs from the validated visual specification.",
        expected: expectedNativeType,
        actual: node.type,
      });
    if (expected.parentRef) {
      const actualParentRef = node.parent?.getPluginData("fad.design.logical-ref") ?? "";
      if (actualParentRef !== expected.parentRef)
        nativeFindings.push({
          code: "parent-mismatch",
          ref: expected.logicalRef,
          message: "Native layer parent differs from the validated visual specification.",
          expected: expected.parentRef,
          actual: actualParentRef || "unmarked parent",
        });
    }
    if (
      node.type === "TEXT" &&
      expected.nodeType === "text" &&
      expected.text !== undefined &&
      node.characters !== expected.text
    )
      nativeFindings.push({
        code: "value-mismatch",
        ref: expected.logicalRef,
        message: "Fresh native text differs from the validated design copy.",
        expected: expected.text.slice(0, 300),
        actual: node.characters.slice(0, 300),
      });
    if (actual && expected.typography) {
      if (
        actual.fontSize === undefined ||
        Math.abs(actual.fontSize - expected.typography.size) > 0.5
      )
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native text size differs from the validated design typography.",
          expected: String(expected.typography.size),
          actual: String(actual.fontSize ?? "unavailable"),
        });
      const expectedAlignment = expected.typography.alignment.toUpperCase();
      if (actual.textAlignHorizontal !== expectedAlignment)
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message:
            "Fresh native text alignment differs from the validated reading direction and alignment.",
          expected: expectedAlignment,
          actual: actual.textAlignHorizontal ?? "unavailable",
        });
      if (
        expected.typography.family &&
        ![expected.typography.family, expected.typography.fallbackFamily, "Inter"].includes(
          actual.fontFamily ?? "",
        )
      )
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native text did not use the requested or declared fallback font family.",
          expected: [expected.typography.family, expected.typography.fallbackFamily, "Inter"]
            .filter(Boolean)
            .join(" / "),
          actual: actual.fontFamily ?? "unavailable",
        });
      if (
        actual.fontStyle !== expected.typography.style &&
        actual.fontStyle !== expected.typography.fallbackStyle
      )
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native text did not use the requested or declared fallback font style.",
          expected: [expected.typography.style, expected.typography.fallbackStyle]
            .filter(Boolean)
            .join(" / "),
          actual: actual.fontStyle ?? "unavailable",
        });
      if (
        expected.typography.lineHeight !== undefined &&
        (actual.lineHeight === undefined ||
          Math.abs(actual.lineHeight - expected.typography.lineHeight) > 0.5)
      )
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native text line height differs from the validated typography.",
          expected: String(expected.typography.lineHeight),
          actual: String(actual.lineHeight ?? "unavailable"),
        });
      if (
        expected.typography.letterSpacing !== undefined &&
        (actual.letterSpacing === undefined ||
          Math.abs(actual.letterSpacing - expected.typography.letterSpacing) > 0.5)
      )
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native text tracking differs from the validated typography.",
          expected: String(expected.typography.letterSpacing),
          actual: String(actual.letterSpacing ?? "unavailable"),
        });
    }
    if (actual && expected.assetId && actual.assetId !== expected.assetId)
      nativeFindings.push({
        code: "value-mismatch",
        ref: expected.logicalRef,
        message: "Fresh native image layer does not reference the pinned Brand Kit asset.",
        expected: expected.assetId,
        actual: actual.assetId ?? "missing asset reference",
      });
    if (actual && expected.paletteRole !== "none" && !expected.assetId) {
      const expectedFill = spec.tokens[expected.paletteRole].toUpperCase();
      const actualFill = (node.type === "TEXT" ? actual.textColor : actual.fill)?.toUpperCase();
      if (actualFill !== expectedFill)
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native color differs from the validated palette token.",
          expected: expectedFill,
          actual: actualFill ?? "unavailable",
        });
    }
    if (
      actual &&
      expected.cornerRadius !== undefined &&
      (actual.cornerRadius === undefined ||
        Math.abs(actual.cornerRadius - expected.cornerRadius) > 0.5)
    )
      nativeFindings.push({
        code: "value-mismatch",
        ref: expected.logicalRef,
        message: "Fresh native corner radius differs from the pinned token scale.",
        expected: String(expected.cornerRadius),
        actual: String(actual.cornerRadius ?? "unavailable"),
      });
    if (
      actual &&
      expected.stroke &&
      (actual.stroke?.toUpperCase() !== expected.stroke.color.toUpperCase() ||
        actual.strokeWeight === undefined ||
        Math.abs(actual.strokeWeight - expected.stroke.width) > 0.5)
    )
      nativeFindings.push({
        code: "value-mismatch",
        ref: expected.logicalRef,
        message: "Fresh native stroke differs from the pinned semantic token.",
        expected: `${expected.stroke.color} / ${expected.stroke.width}`,
        actual: `${actual.stroke ?? "unavailable"} / ${actual.strokeWeight ?? "unavailable"}`,
      });
    if (
      actual &&
      expected.shadow &&
      (!actual.shadow ||
        actual.shadow.color.toUpperCase() !== expected.shadow.color.toUpperCase() ||
        Math.abs(actual.shadow.opacity - expected.shadow.opacity) > 0.05 ||
        Math.abs(actual.shadow.offsetX - expected.shadow.offsetX) > 0.5 ||
        Math.abs(actual.shadow.offsetY - expected.shadow.offsetY) > 0.5 ||
        Math.abs(actual.shadow.radius - expected.shadow.radius) > 0.5)
    )
      nativeFindings.push({
        code: "value-mismatch",
        ref: expected.logicalRef,
        message: "Fresh native shadow differs from the pinned effects token.",
        expected: JSON.stringify(expected.shadow),
        actual: JSON.stringify(actual.shadow ?? "unavailable"),
      });
    if (actual && ["frame", "image"].includes(expected.nodeType) && expected.layout !== "none") {
      const expectedLayout = expected.layout.toUpperCase();
      if (actual.layoutMode !== expectedLayout)
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message:
            "Fresh native Auto Layout direction differs from the validated design specification.",
          expected: expectedLayout,
          actual: actual.layoutMode ?? "unavailable",
        });
      if (actual.itemSpacing === undefined || Math.abs(actual.itemSpacing - expected.gap) > 0.5)
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native Auto Layout gap differs from the validated design specification.",
          expected: String(expected.gap),
          actual: String(actual.itemSpacing ?? "unavailable"),
        });
      if (
        !actual.padding ||
        Math.abs(actual.padding.top - expected.padding) > 0.5 ||
        Math.abs(actual.padding.right - expected.padding) > 0.5 ||
        Math.abs(actual.padding.bottom - expected.padding) > 0.5 ||
        Math.abs(actual.padding.left - expected.padding) > 0.5
      )
        nativeFindings.push({
          code: "value-mismatch",
          ref: expected.logicalRef,
          message: "Fresh native Auto Layout padding differs from the pinned spacing tokens.",
          expected: String(expected.padding),
          actual: actual.padding ? JSON.stringify(actual.padding) : "unavailable",
        });
    }
  }
  const rootSpec = spec.nodes.find((node) => node.logicalRef === `${spec.screen.id}.root`);
  if (
    rootSpec &&
    (Math.abs(root.width - spec.screen.width) > 1 || Math.abs(root.height - spec.screen.height) > 1)
  )
    nativeFindings.push({
      code: "viewport-mismatch",
      ref: rootSpec.logicalRef,
      message: "Native screen viewport differs from the requested frame size.",
      expected: `${spec.screen.width}×${spec.screen.height}`,
      actual: `${root.width}×${root.height}`,
    });
  const nativePatterns = new Set<string>();
  const stack: NativeVisualNode[] = [nativeTree];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.pattern) nativePatterns.add(current.pattern);
    stack.push(...(current.children ?? []));
  }
  const missingPatterns = spec.requiredPatterns.filter((pattern) => !nativePatterns.has(pattern));
  const blockingCodes = new Set([
    "missing-ref",
    "invalid-geometry",
    "hidden-node",
    "empty-text",
    "clipped-child",
    "overlapping-auto-layout",
    "low-contrast",
    "overlap-analysis-limit",
  ]);
  blockingCodes.add("type-mismatch");
  blockingCodes.add("parent-mismatch");
  blockingCodes.add("viewport-mismatch");
  blockingCodes.add("value-mismatch");
  if (nativeFindings.some((finding) => finding.code === "overlap-analysis-limit")) truncated = true;
  const verified =
    !truncated &&
    nativeFindings.every((finding) => !blockingCodes.has(finding.code)) &&
    !missingPatterns.length;
  return {
    verified,
    truncated,
    nodeCount,
    findings: nativeFindings.slice(0, 32),
    missingPatterns,
    rootNodeId,
  };
}
