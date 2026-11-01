import type { DesignNode, DesignSpec } from "./schema";
import type { MultiScreenSpec } from "./multi-screen-schema";
import { isTokenReference, type TokenReference } from "./design-system-schema";

export type VisualQualityCode =
  | "tiny-text"
  | "low-contrast"
  | "small-touch-target"
  | "overflow-risk"
  | "duplicated-pattern"
  | "missing-alt"
  | "missing-asset-license"
  | "spacing-variety"
  | "style-variety"
  | "weak-hierarchy"
  | "repeated-placeholders";

export interface VisualQualityDiagnostic {
  code: VisualQualityCode;
  severity: "warning" | "info";
  path: string;
  message: string;
  action: string;
}

export interface VisualQualityAudit {
  screenCount: number;
  estimatedNativeNodes: number;
  assetCount: number;
  componentCount: number;
  instanceCount: number;
  diagnostics: VisualQualityDiagnostic[];
}

interface QualityScreen {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string | TokenReference;
  children: DesignNode[];
  document?: boolean;
}

interface QualityInput {
  designSystem?: DesignSpec["designSystem"];
  assets?: DesignSpec["assets"];
  components?: DesignSpec["document"]["components"];
  screens: QualityScreen[];
}

function asQualityInput(input: DesignSpec | MultiScreenSpec): QualityInput {
  if ("screens" in input) {
    return {
      designSystem: input.designSystem,
      assets: input.assets,
      components: [...(input.components ?? []), ...(input.designSystem?.components ?? [])],
      screens: input.screens.map((screen) => ({
        id: screen.id,
        name: screen.name,
        width: screen.width,
        height: screen.height,
        background:
          screen.background ?? input.designSystem?.colors["color.page.background"] ?? "#FFFFFF",
        children: screen.children,
      })),
    };
  }
  return {
    designSystem: input.designSystem,
    assets: input.assets,
    components: [...(input.document.components ?? []), ...(input.designSystem?.components ?? [])],
    screens: [
      {
        id: "document",
        name: input.document.name,
        width: input.document.width,
        height: input.document.height,
        background: input.document.background,
        children: input.document.children,
        document: true,
      },
    ],
  };
}

function resolveColor(
  value: string | TokenReference | undefined,
  input: QualityInput,
): string | undefined {
  if (!value) return undefined;
  if (!isTokenReference(value)) return value;
  const token = input.designSystem?.colors[value.token];
  return typeof token === "string" ? token : undefined;
}

function luminance(hex: string): number | undefined {
  if (!/^#[\da-f]{6}$/i.test(hex)) return undefined;
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number | undefined {
  const first = luminance(foreground);
  const second = luminance(background);
  if (first === undefined || second === undefined) return undefined;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function repeatedFrameStructure(node: DesignNode): string | undefined {
  if (node.type !== "frame" || node.children.length < 2) return undefined;
  const children = node.children.map((child) => {
    if (child.type === "frame")
      return repeatedFrameStructure(child) ?? `frame:${child.children.length}`;
    if (child.type === "text")
      return `text:${child.textStyle?.token ?? child.fontSize ?? "default"}`;
    if (child.type === "instance") return `instance:${child.componentId}`;
    return child.type;
  });
  return JSON.stringify([node.layout?.mode ?? "absolute", node.children.length, children]);
}

function visualColors(node: DesignNode, input: QualityInput): string[] {
  const fills = "visual" in node ? (node.visual?.fills ?? []) : [];
  return fills.flatMap((fill) =>
    fill.type === "solid"
      ? [resolveColor(fill.color, input)].filter((color): color is string => Boolean(color))
      : fill.stops
          .map((stop) => resolveColor(stop.color, input))
          .filter((color): color is string => Boolean(color)),
  );
}

function singleOpaqueVisualColor(node: DesignNode, input: QualityInput): string | undefined {
  if (!("visual" in node) || node.visual?.fills === undefined) return undefined;
  if ((node.visual.opacity ?? 1) !== 1 || node.visual.fills.length !== 1) return undefined;
  const fill = node.visual.fills[0];
  if (fill?.type !== "solid" || (fill.opacity ?? 1) !== 1) return undefined;
  return resolveColor(fill.color, input);
}

function backgroundColors(node: DesignNode, inherited: string[], input: QualityInput): string[] {
  if ("visual" in node && node.visual?.fills !== undefined) {
    const measurableColor = singleOpaqueVisualColor(node, input);
    return measurableColor ? [measurableColor] : [];
  }
  if (node.type === "rectangle" || node.type === "ellipse" || node.type === "vector") {
    const color = resolveColor(node.fill, input);
    return color ? [color] : inherited;
  }
  if (node.type === "frame") {
    const color = resolveColor(node.background, input);
    return color ? [color] : inherited;
  }
  return inherited;
}

function resolvedFontSize(
  node: Extract<DesignNode, { type: "text" }>,
  input: QualityInput,
): number | undefined {
  if (typeof node.fontSize === "number") return node.fontSize;
  if (node.fontSize && isTokenReference(node.fontSize)) {
    const token = input.designSystem?.spacing?.aliases[node.fontSize.token];
    if (typeof token === "number") return token;
    const scaleIndex = /^spacing\.scale\.(\d+)$/.exec(node.fontSize.token)?.[1];
    const scaleValue =
      scaleIndex === undefined ? undefined : input.designSystem?.spacing?.scale[Number(scaleIndex)];
    if (typeof scaleValue === "number") return scaleValue;
  }
  if (node.textStyle && isTokenReference(node.textStyle)) {
    const token = input.designSystem?.typography[node.textStyle.token];
    const size = token?.fontSize;
    if (typeof size === "number") return size;
    if (size && isTokenReference(size)) {
      const alias = input.designSystem?.spacing?.aliases[size.token];
      if (typeof alias === "number") return alias;
      const index = /^spacing\.scale\.(\d+)$/.exec(size.token)?.[1];
      return index === undefined ? undefined : input.designSystem?.spacing?.scale[Number(index)];
    }
  }
  return undefined;
}

export function auditVisualQuality(input: DesignSpec | MultiScreenSpec): VisualQualityAudit {
  const model = asQualityInput(input);
  const diagnostics: VisualQualityDiagnostic[] = [];
  const assets = new Map((model.assets ?? []).map((asset) => [asset.id, asset]));
  let estimatedNativeNodes = 0;
  let instanceCount = 0;
  const uniqueColors = new Set<string>();
  const uniqueSpacing = new Set<number>();

  const add = (
    code: VisualQualityCode,
    path: string,
    message: string,
    action: string,
    severity: "warning" | "info" = "warning",
  ) => diagnostics.push({ code, severity, path, message, action });

  for (const screen of model.screens) {
    const prefix = screen.document ? "document" : `screens["${screen.id}"]`;
    const fontSizes: number[] = [];
    const placeholders = new Map<string, number>();
    const visit = (nodes: DesignNode[], inheritedBackground: string[], path: string) => {
      const repeated = new Map<
        string,
        { firstIndex: number; count: number; firstNode: DesignNode }
      >();
      nodes.forEach((node, index) => {
        const fingerprint = repeatedFrameStructure(node);
        if (!fingerprint) return;
        const group = repeated.get(fingerprint);
        if (group) group.count++;
        else repeated.set(fingerprint, { firstIndex: index, count: 1, firstNode: node });
      });
      for (const group of repeated.values()) {
        if (group.count < 3 || group.firstNode.type !== "frame") continue;
        if (group.firstNode.qualityExceptions?.includes("duplicated-pattern")) continue;
        add(
          "duplicated-pattern",
          `${path}[${group.firstIndex}]`,
          `${group.count} sibling frame trees share the same structure but are not linked instances.`,
          "Consider defining a reusable component and placing linked instances, or add a duplicated-pattern exception when the repetition is intentional.",
          "info",
        );
      }
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const nodePath = `${path}[${index}]`;
        estimatedNativeNodes++;
        if (node.type === "instance") instanceCount++;
        const exceptions = node.type === "instance" ? [] : (node.qualityExceptions ?? []);
        const warn = (code: VisualQualityCode, message: string, action: string) => {
          if (!exceptions.includes(code)) add(code, nodePath, message, action);
        };

        for (const color of visualColors(node, model)) uniqueColors.add(color.toUpperCase());
        if (node.type === "text") {
          const size = resolvedFontSize(node, model);
          if (size !== undefined) fontSizes.push(size);
          if (size !== undefined && size < 12) {
            warn(
              "tiny-text",
              `Text is ${size}px, which is below the 12px preflight threshold.`,
              "Increase type size or add an explicit tiny-text exception for intentional metadata.",
            );
          }
          if (node.textAutoResize === "truncate") {
            warn(
              "overflow-risk",
              "This text layer is configured to truncate, so longer localized copy can be clipped.",
              "Use width-only text resizing, allow more height, or shorten the copy.",
            );
          } else if (
            node.text.length > 120 &&
            node.width !== undefined &&
            node.height !== undefined &&
            node.textAutoResize !== "width-and-height"
          ) {
            warn(
              "overflow-risk",
              `This fixed-size text layer has ${node.text.length} characters; overflow is a content-length heuristic and needs visual inspection.`,
              "Check the layer at the longest localized copy, increase its available size, or use width-and-height text resizing.",
            );
          }
          const visualOverridesForeground = node.visual?.fills !== undefined;
          const measurableVisualForeground = singleOpaqueVisualColor(node, model);
          const fallbackForeground = resolveColor(node.color, model);
          const foreground = visualOverridesForeground
            ? measurableVisualForeground
            : fallbackForeground;
          const foregrounds = foreground ? [foreground] : [];
          if (foreground) uniqueColors.add(foreground.toUpperCase());
          for (const background of inheritedBackground) {
            const ratios = foregrounds
              .map((item) => contrastRatio(item, background))
              .filter((ratio): ratio is number => ratio !== undefined);
            const ratio = ratios.length ? Math.min(...ratios) : undefined;
            if (ratio !== undefined && ratio < 4.5) {
              warn(
                "low-contrast",
                `Text contrast is ${ratio.toFixed(2)}:1 against ${background}; the preflight AA target is 4.5:1 for ordinary text.`,
                "Darken the text, lighten the surface, or document an intentional low-contrast exception.",
              );
              break;
            }
          }
        }
        if (
          "qualityRole" in node &&
          (node.qualityRole === "button" || node.qualityRole === "input") &&
          "width" in node &&
          "height" in node &&
          typeof node.width === "number" &&
          typeof node.height === "number"
        ) {
          if (node.width < 44 || node.height < 44) {
            warn(
              "small-touch-target",
              `Interactive target is ${node.width} × ${node.height}px, below 44 × 44px.`,
              "Increase the native hit area or document why this compact control is intentional.",
            );
          }
        }
        if (node.type === "image") {
          const asset = assets.get(node.assetId);
          if (!node.alt && !asset?.alt) {
            warn(
              "missing-alt",
              "Image has no descriptive alt text in the node or asset record.",
              'Add concise alt text, or use qualityExceptions: ["missing-alt"] when the image is decorative.',
            );
          }
          if (asset && !asset.license.trim()) {
            warn(
              "missing-asset-license",
              "Image asset has no provenance or license note.",
              "Record the source and license in assets[].license before sharing the file.",
            );
          }
          if (node.placeholder)
            placeholders.set(node.assetId, (placeholders.get(node.assetId) ?? 0) + 1);
          if (asset?.kind === "svg-paths") estimatedNativeNodes += asset.paths.length;
        }
        if (
          node.type === "frame" ||
          node.type === "rectangle" ||
          node.type === "ellipse" ||
          node.type === "vector"
        ) {
          const background = backgroundColors(node, inheritedBackground, model);
          if (node.type === "frame") {
            if (node.layout?.gap !== undefined && typeof node.layout.gap === "number")
              uniqueSpacing.add(node.layout.gap);
            for (const value of Object.values(node.layout?.padding ?? {})) {
              if (typeof value === "number") uniqueSpacing.add(value);
            }
            visit(node.children, background, `${nodePath}.children`);
          }
          if (node.type === "rectangle" || node.type === "ellipse" || node.type === "vector") {
            const fill = resolveColor(node.fill, model);
            if (fill) uniqueColors.add(fill.toUpperCase());
          }
        }
      }
    };
    const pageBackground = resolveColor(screen.background, model);
    visit(screen.children, pageBackground ? [pageBackground] : [], `${prefix}.children`);
    if (fontSizes.length >= 4) {
      const minimum = Math.min(...fontSizes);
      const maximum = Math.max(...fontSizes);
      if (maximum < 24 || maximum - minimum < 8) {
        add(
          "weak-hierarchy",
          `${prefix}.children`,
          `Measured text sizes span ${minimum}–${maximum}px; a distinct display or section scale was not detected.`,
          "Review hierarchy manually and consider a 24px+ heading or stronger type scale.",
          "info",
        );
      }
    }
    for (const [assetId, count] of placeholders) {
      if (count >= 3) {
        add(
          "repeated-placeholders",
          `${prefix}.children`,
          `${count} placeholder image layers repeat asset “${assetId}”.`,
          "Replace repeated placeholders with licensed image assets or distinct editable illustrations.",
        );
      }
    }
  }

  if (uniqueSpacing.size > 10) {
    add(
      "spacing-variety",
      "designSystem.spacing",
      `Found ${uniqueSpacing.size} distinct numeric gaps and paddings.`,
      "Use fewer named spacing tokens for repeated layout rhythm.",
    );
  }
  if (uniqueColors.size > 24) {
    add(
      "style-variety",
      "designSystem.colors",
      `Found ${uniqueColors.size} distinct rendered colors.`,
      "Consolidate repeated colors into semantic tokens; intentional illustration colors can be exempted by using distinct assets.",
    );
  }

  estimatedNativeNodes += model.screens.length; // One root frame for each generated screen.
  const countTree = (nodes: DesignNode[]): number =>
    nodes.reduce((count, node) => {
      if (node.type === "frame") return count + 1 + countTree(node.children);
      if (node.type === "image") {
        const asset = assets.get(node.assetId);
        return count + 1 + (asset?.kind === "svg-paths" ? asset.paths.length : 0);
      }
      return count + 1;
    }, 0);
  const definitions = model.components ?? [];
  if (definitions.length) {
    estimatedNativeNodes +=
      1 + definitions.reduce((count, component) => count + 1 + countTree(component.children), 0);
  }

  return {
    screenCount: model.screens.length,
    estimatedNativeNodes,
    assetCount: model.assets?.length ?? 0,
    componentCount: model.components?.length ?? 0,
    instanceCount,
    diagnostics,
  };
}
