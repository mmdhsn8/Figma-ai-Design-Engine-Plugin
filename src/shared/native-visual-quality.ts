import { z } from "zod";

export interface NativeVisualNode {
  ref?: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  text?: string;
  fill?: string;
  textColor?: string;
  stroke?: string;
  strokeWeight?: number;
  cornerRadius?: number;
  opacity?: number;
  fontSize?: number;
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  clipsContent?: boolean;
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

export const NativeVisualNodeSchema: z.ZodType<NativeVisualNode> = z.lazy(() =>
  z
    .object({
      ref: z.string().max(80).optional(),
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
      textColor: z
        .string()
        .regex(/^#[\da-f]{6}$/iu)
        .optional(),
      stroke: z
        .string()
        .regex(/^#[\da-f]{6}$/iu)
        .optional(),
      strokeWeight: z.number().finite().min(0).max(100).optional(),
      cornerRadius: z.number().finite().min(0).max(500).optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
      fontSize: z.number().finite().min(0).max(1_000).optional(),
      layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
      itemSpacing: z.number().finite().optional(),
      clipsContent: z.boolean().optional(),
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
    | "low-contrast"
    | "viewport-mismatch"
    | "missing-section"
    | "insufficient-hierarchy"
    | "undersized-target"
    | "inconsistent-cards"
    | "missing-native-fallback"
    | "excessive-whitespace";
  ref?: string;
  message: string;
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

function contains(parent: NativeVisualNode, child: NativeVisualNode): boolean {
  const outer = rect(parent);
  const inner = rect(child);
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

function luminance(hex: string): number | undefined {
  if (!/^#[\da-f]{6}$/iu.test(hex)) return undefined;
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

export function nativeContrastRatio(foreground: string, background: string): number | undefined {
  const first = luminance(foreground);
  const second = luminance(background);
  if (first === undefined || second === undefined) return undefined;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function auditNativeSection(
  roots: NativeVisualNode[],
  expectedRefs: string[],
): NativeVisualFinding[] {
  const findings: NativeVisualFinding[] = [];
  const all = flatten(roots);
  const byRef = new Map(all.flatMap((node) => (node.ref ? [[node.ref, node] as const] : [])));
  for (const ref of expectedRefs)
    if (!byRef.has(ref))
      findings.push({
        code: "missing-ref",
        ref,
        message: `Expected layer “${ref}” was not found in the committed section.`,
      });

  const visit = (
    node: NativeVisualNode,
    parent?: NativeVisualNode,
    inheritedFill?: string,
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
      });
    if (!node.visible)
      findings.push({ code: "hidden-node", ref: node.ref, message: `“${node.name}” is hidden.` });
    if (parent?.clipsContent && !contains(parent, node))
      findings.push({
        code: "clipped-child",
        ref: node.ref,
        message: `“${node.name}” extends outside its clipping parent.`,
      });
    if (node.type === "TEXT" && !node.text?.trim())
      findings.push({
        code: "empty-text",
        ref: node.ref,
        message: `Editable text layer “${node.name}” is empty.`,
      });
    const effectiveOpacity = inheritedOpacity * (node.opacity ?? 1);
    if (node.type === "TEXT" && node.textColor && inheritedFill && effectiveOpacity >= 0.999) {
      const ratio = nativeContrastRatio(node.textColor, inheritedFill);
      const contrastThreshold = (node.fontSize ?? 0) >= 24 ? 3 : 4.5;
      if (ratio !== undefined && ratio < contrastThreshold)
        findings.push({
          code: "low-contrast",
          ref: node.ref,
          message: `“${node.name}” has ${ratio.toFixed(2)}:1 contrast against its measurable surface.`,
        });
    }
    const children = node.children ?? [];
    if (node.layoutMode !== "NONE") {
      for (let first = 0; first < children.length; first++)
        for (let second = first + 1; second < children.length; second++)
          if (overlaps(children[first]!, children[second]!))
            findings.push({
              code: "overlapping-auto-layout",
              ref: children[second]!.ref,
              message: `“${children[first]!.name}” overlaps “${children[second]!.name}” inside Auto Layout “${node.name}”.`,
            });
    }
    const fill = node.fill ?? inheritedFill;
    children.forEach((child) => visit(child, node, fill, effectiveOpacity));
  };
  roots.forEach((node) => visit(node));
  return findings;
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
    });
  for (const ref of input.sectionRefs)
    if (!byRef.has(ref))
      findings.push({
        code: "missing-section",
        ref,
        message: `Required storefront section “${ref}” is missing.`,
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
        message:
          "Product cards need consistent proportions, a visible surface, and a shared rounded shape.",
      });
  }
  for (const ref of [...input.purchaseTargetRefs, ...(input.interactiveTargetRefs ?? [])]) {
    const target = byRef.get(ref);
    if (target && (target.width < 44 || target.height < 44))
      findings.push({
        code: "undersized-target",
        ref,
        message: `Purchase target “${ref}” is below 44×44px.`,
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
        });
        break;
      }
    }
  }
  return findings;
}
