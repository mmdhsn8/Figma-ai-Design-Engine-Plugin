import type {
  DesignNode,
  FrameNodeSpec,
} from "./schema";
import {
  parseMultiScreenValue,
  type MultiScreenSpec,
} from "./multi-screen-schema";
import { auditVisualQuality } from "./visual-quality";
import { auditDesignProgramComposition, auditDesignProgramContrast, programColor, programPageColor } from "./design-program-quality";
import type { VisualAsset } from "./visual-schema";
import { programTextAutoResize } from "./program-text-layout";
import {
  designProgramTokens,
  parseDesignProgram,
  type DesignProgramFinding,
  type DesignProgramNode,
  type DesignProgramV1,
} from "./design-program";

export type DesignProgramCompileResult =
  | { success: true; batch: MultiScreenSpec; fingerprint: string; nodeCount: number; findings: DesignProgramFinding[]; semanticRoles: Array<{ logicalRef: string; role: string }> }
  | { success: false; findings: DesignProgramFinding[] };

function semanticRadius(semanticRole: string, program: DesignProgramV1): number | undefined {
  const radii = program.visualLanguageV1?.radii;
  if (!radii) return undefined;
  const role = semanticRole.toLocaleLowerCase();
  if (/^(?:screen|page|root|layout)(?:[-_ ]|$)/u.test(role)) return 0;
  if (/(?:button|action|input|control|tab|navigation)/u.test(role)) return radii.control;
  if (/(?:card|surface|summary|panel|section|region|content|sheet)/u.test(role)) return radii.surface;
  return radii.compact;
}

function reverseInlineAlignment<T extends string>(alignment: T): T | "start" | "end" {
  return alignment === "start" ? "end" : alignment === "end" ? "start" : alignment;
}

function safeCounterAlign(
  declared: "start" | "center" | "end" | "stretch" | "baseline",
  children: DesignProgramNode[],
  axis: "row" | "column",
): "start" | "center" | "end" | "stretch" | "baseline" {
  const crossAxis = axis === "row" ? "height" : "width";
  if (children.length > 0 && children.every((child) => child[crossAxis].mode === "fill")) return "stretch";
  return declared === "stretch" ? "start" : declared;
}

function nodeToNative(node: DesignProgramNode, program: DesignProgramV1, screenId: string, direction: "ltr" | "rtl", availableAssetIds: ReadonlySet<string>): DesignNode {
  const common = {
    name: node.name,
    width: node.width.value,
    height: node.height.value,
    sizing: {
      width: node.width.mode, height: node.height.mode,
      ...(node.width.min === undefined ? {} : { minWidth: node.width.min }),
      ...(node.width.max === undefined ? {} : { maxWidth: node.width.max }),
      ...(node.height.min === undefined ? {} : { minHeight: node.height.min }),
      ...(node.height.max === undefined ? {} : { maxHeight: node.height.max }),
    },
    logicalRef: `${program.id}.${screenId}.${node.id}`.slice(0, 120),
    ...(node.interaction === "button" || node.interaction === "navigation" ? { qualityRole: "button" as const } : node.interaction === "input" ? { qualityRole: "input" as const } : {}),
  };
  if (node.type === "container") {
    const children = node.children.map((child) => nodeToNative(child, program, screenId, direction, availableAssetIds));
    const rtlRow = direction === "rtl" && node.layout.axis === "row";
    if (rtlRow) children.reverse();
    const primaryAxisAlign = rtlRow ? reverseInlineAlignment(node.layout.align) : node.layout.align;
    const crossAlign = direction === "rtl" && node.layout.axis === "column"
      ? reverseInlineAlignment(node.layout.crossAlign) : node.layout.crossAlign;
    return {
      ...common,
      type: "frame",
      background: node.background ? programColor(program, node.background) : undefined,
      ...(node.background ? { cornerRadius: semanticRadius(node.semanticRole, program) } : {}),
      children,
      layout: {
        mode: node.layout.axis === "row" ? "horizontal" : "vertical",
        ...(node.layout.wrap ? { wrap: true } : {}),
        gap: node.layout.gap,
        padding: node.layout.padding,
        primaryAxisAlign,
        counterAxisAlign: safeCounterAlign(crossAlign, node.children, node.layout.axis),
      },
    };
  }
  if (node.type === "text") {
    const language = program.visualLanguageV1?.typography;
    const roleSize = node.textRole === "display" ? language?.displaySize
      : node.textRole === "title" || node.textRole === "heading" ? language?.titleSize
        : node.textRole === "caption" || node.textRole === "label" ? language?.captionSize
          : node.textRole === "body" || node.textRole === "action" ? language?.bodySize : undefined;
    const headingRole = node.textRole === "display" || node.textRole === "title" || node.textRole === "heading";
    const textAutoResize = programTextAutoResize(node.width.mode, node.height.mode);
    if (!textAutoResize) throw new Error(`Unsupported Universal text sizing for ${node.id}.`);
    return {
      ...common, type: "text", text: node.text, fontSize: roleSize ?? node.fontSize, color: programColor(program, node.color),
      fontFamily: headingRole || node.weight === "bold" || node.weight === "semibold" ? program.tokens.headingFont : program.tokens.bodyFont,
      fontStyle: node.weight === "bold" ? "Bold" : node.weight === "semibold" ? "Semi Bold" : node.weight === "medium" ? "Medium" : "Regular",
      textAlign: node.align ?? (direction === "rtl" ? "right" : "left"),
      textAutoResize: textAutoResize === "width-and-height" ? "width-and-height" : "height",
    };
  }
  if (node.type === "rectangle") return { ...common, type: "rectangle", fill: programColor(program, node.fill), cornerRadius: node.cornerRadius ?? semanticRadius(node.semanticRole, program) ?? 0 };
  if (node.type === "ellipse") return { ...common, type: "ellipse", fill: programColor(program, node.fill) };
  if (node.type === "vector") return { ...common, type: "vector", pathData: node.pathData, fill: programColor(program, node.fill) };
  if (node.type === "instance") return { type: "instance", name: common.name, sizing: common.sizing, logicalRef: common.logicalRef, componentId: node.componentId };
  if (node.asset.source === "user-approved-brand-kit" && node.asset.assetRef && availableAssetIds.has(node.asset.assetRef))
    return { ...common, type: "image", assetId: node.asset.assetRef, fit: "crop", alt: node.asset.label, qualityRole: "image" };
  const placeholderLabel = node.asset.source === "user-approved-brand-kit"
    ? `Pinned asset · ${node.asset.label}`
    : `Placeholder · ${node.asset.label}`;
  return {
    ...common, type: "frame", background: "#EEF1F5", layout: { mode: "vertical", primaryAxisAlign: "center", counterAxisAlign: "center" },
    children: [{ type: "text", name: "Placeholder disclosure", text: placeholderLabel, width: Math.min(node.width.value, 300), height: 32, sizing: { width: "fixed", height: "hug", minHeight: 32 }, fontSize: 14, color: "#475569", textAlign: "center", textAutoResize: "height", logicalRef: `${program.id}.${screenId}.${node.id}.label`.slice(0, 120) }],
  };
}

function nativeDisplayName(value: string): boolean {
  return !/[\\/]/u.test(value) && !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

export function compileDesignProgram(value: unknown, options: { assets?: VisualAsset[]; allowedBrandAssetIds?: ReadonlySet<string> } = {}): DesignProgramCompileResult {
  const assets = options.assets ?? [];
  const allowedBrandAssetIds = options.allowedBrandAssetIds ?? new Set(assets.map(({ id }) => id));
  const parsed = parseDesignProgram(value, { allowedBrandAssetIds });
  if (!parsed.success) return { success: false, findings: parsed.findings };
  const program = parsed.data;
  const findings: DesignProgramFinding[] = [];
  for (const screen of program.screens) {
    const visit = (node: DesignProgramNode) => {
      if (!nativeDisplayName(node.name)) findings.push({ code: "unsupported_display_name", path: `screens.${screen.id}.${node.id}.name`, message: "Names containing slashes or control characters cannot be represented by the current renderer.", severity: "error" });
      if (node.type === "container") node.children.forEach(visit);
    };
    visit(screen.root);
    if (!nativeDisplayName(screen.title)) findings.push({ code: "unsupported_display_name", path: `screens.${screen.id}.title`, message: "Screen title contains a slash or control character.", severity: "error" });
  }
  if (findings.length) return { success: false, findings };
  const pageColor = programPageColor(program);
  const screens = [...program.screens].sort((a, b) => a.order - b.order).map((screen) => {
    const contentHeight = screen.scroll === "vertical"
      ? Math.max(screen.viewport.height, screen.root.height.value + 48)
      : screen.viewport.height;
    const root: FrameNodeSpec = {
      type: "frame", name: `${screen.id} content`, width: screen.viewport.width, height: contentHeight,
      sizing: { width: "fixed", height: "fixed" },
      background: pageColor,
      layout: { mode: "vertical", padding: { top: 24, right: 24, bottom: 24, left: 24 }, counterAxisAlign: program.locale.direction === "rtl" ? "end" : "start" },
      children: [nodeToNative(screen.root, program, screen.id, program.locale.direction, new Set(assets.map(({ id }) => id)))],
      logicalRef: `${program.id}.${screen.id}.content`.slice(0, 120),
    };
    return {
      id: screen.id,
      name: screen.title,
      order: screen.order,
      devicePreset: screen.viewport.preset,
      width: screen.viewport.width,
      height: screen.viewport.height,
      background: pageColor,
      layout: { mode: "vertical", counterAxisAlign: "start" },
      children: [root],
      metadata: {
        programVersion: program.programVersion,
        programId: program.id,
        purpose: screen.purpose,
        language: program.locale.language,
        direction: program.locale.direction,
        ...(program.visualLanguageV1 ? { visualLanguage: program.visualLanguageV1.identity } : {}),
        ...(screen.compositionV1 ? { compositionArchetype: screen.compositionV1.archetype, compositionReason: screen.compositionV1.decisionTrace } : {}),
        scroll: screen.scroll,
        ...(screen.dependsOn.length ? { dependsOn: screen.dependsOn.join(",") } : {}),
      },
    };
  });
  const batchValue = {
    schemaVersion: "1.0.0",
    id: program.id,
    name: program.id,
    ...(assets.length ? { assets } : {}),
    designSystem: {
      ...designProgramTokens(program),
      ...(program.componentsV1?.length ? { components: program.componentsV1.map(({ id, root }) => {
        const frame = nodeToNative(root, program, `component-${id}`, program.locale.direction, new Set());
        if (frame.type !== "frame") throw new Error("A local component must lower to a frame.");
        return { type: "component" as const, id, key: id, name: frame.name, width: frame.width, height: frame.height,
          background: frame.background, cornerRadius: frame.cornerRadius, children: frame.children, layout: frame.layout };
      }) } : {}),
    },
    screens,
  };
  const checked = parseMultiScreenValue(batchValue);
  if (!checked.success) return { success: false, findings: checked.errors.map((message) => ({ code: "native_schema_rejected", path: "batch", message, severity: "error" })) };
  findings.push(...auditDesignProgramContrast(program));
  for (const diagnostic of auditVisualQuality(checked.data).diagnostics) {
    if (diagnostic.code !== "low-contrast")
      findings.push({ code: `quality_${diagnostic.code}`, path: diagnostic.path, message: diagnostic.message, severity: "warning" });
  }
  findings.push(...auditDesignProgramComposition(program));
  const semanticRoles: Array<{ logicalRef: string; role: string }> = [];
  for (const screen of program.screens) {
    const visit = (node: DesignProgramNode) => {
      semanticRoles.push({ logicalRef: `${program.id}.${screen.id}.${node.id}`.slice(0, 120), role: node.semanticRole });
      if (node.type === "container") node.children.forEach(visit);
    };
    visit(screen.root);
  }
  return { success: true, batch: checked.data, fingerprint: parsed.fingerprint, nodeCount: parsed.nodeCount, findings, semanticRoles };
}
