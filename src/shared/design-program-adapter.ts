import type {
  DesignNode,
  FrameNodeSpec,
  SizingMode,
} from "./schema";
import {
  parseMultiScreenValue,
  type MultiScreenSpec,
} from "./multi-screen-schema";
import { auditVisualQuality } from "./visual-quality";
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

function resolveColor(color: string, program: DesignProgramV1): string {
  if (!color.startsWith("token:")) return color;
  return program.tokens.colors[color.slice(6)] ?? color;
}

function sizing(mode: SizingMode): SizingMode {
  return mode;
}

function safeCounterAlign(
  declared: "start" | "center" | "end" | "stretch" | "baseline",
  children: DesignProgramNode[],
  axis: "row" | "column",
): "start" | "center" | "end" | "stretch" | "baseline" {
  const crossAxis = axis === "row" ? "height" : "width";
  if (children.some((child) => child[crossAxis].mode === "fill")) return "stretch";
  return declared === "stretch" ? "start" : declared;
}

function nodeToNative(node: DesignProgramNode, program: DesignProgramV1, screenId: string, direction: "ltr" | "rtl"): DesignNode {
  const common = {
    name: node.name,
    width: node.width.value,
    height: node.height.value,
    sizing: { width: sizing(node.width.mode), height: sizing(node.height.mode) },
    logicalRef: `${program.id}.${screenId}.${node.id}`.slice(0, 120),
    ...(node.interaction === "button" || node.interaction === "navigation" ? { qualityRole: "button" as const } : node.interaction === "input" ? { qualityRole: "input" as const } : {}),
  };
  if (node.type === "container") {
    const children = node.children.map((child) => nodeToNative(child, program, screenId, direction));
    if (direction === "rtl" && node.layout.axis === "row") children.reverse();
    return {
      ...common,
      type: "frame",
      background: node.background ? resolveColor(node.background, program) : undefined,
      children,
      layout: {
        mode: node.layout.axis === "row" ? "horizontal" : "vertical",
        gap: node.layout.gap,
        padding: node.layout.padding,
        primaryAxisAlign: node.layout.align === "space-between" ? "space-between" : node.layout.align,
        counterAxisAlign: safeCounterAlign(node.layout.crossAlign, node.children, node.layout.axis),
      },
    };
  }
  if (node.type === "text") return {
    ...common, type: "text", text: node.text, fontSize: node.fontSize, color: resolveColor(node.color, program),
    fontFamily: node.weight === "bold" || node.weight === "semibold" ? program.tokens.headingFont : program.tokens.bodyFont,
    fontStyle: node.weight === "bold" ? "Bold" : node.weight === "semibold" ? "Semi Bold" : node.weight === "medium" ? "Medium" : "Regular",
    textAlign: node.align ?? (direction === "rtl" ? "right" : "left"), textAutoResize: "height",
  };
  if (node.type === "rectangle") return { ...common, type: "rectangle", fill: resolveColor(node.fill, program), cornerRadius: node.cornerRadius };
  if (node.type === "ellipse") return { ...common, type: "ellipse", fill: resolveColor(node.fill, program) };
  if (node.type === "vector") return { ...common, type: "vector", pathData: node.pathData, fill: resolveColor(node.fill, program) };
  const placeholderLabel = `Placeholder · ${node.asset.label}`;
  return {
    ...common, type: "frame", background: "#EEF1F5", layout: { mode: "vertical", primaryAxisAlign: "center", counterAxisAlign: "center" },
    children: [{ type: "text", name: "Placeholder disclosure", text: placeholderLabel, width: Math.min(node.width.value, 300), height: 32, sizing: { width: "fixed", height: "fixed" }, fontSize: 14, color: "#475569", textAlign: "center", textAutoResize: "height", logicalRef: `${program.id}.${screenId}.${node.id}.label`.slice(0, 120) }],
  };
}

function nativeDisplayName(value: string): boolean {
  return !/[\\/]/u.test(value) && !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

export function compileDesignProgram(value: unknown): DesignProgramCompileResult {
  const parsed = parseDesignProgram(value);
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
  const screens = [...program.screens].sort((a, b) => a.order - b.order).map((screen) => {
    const contentHeight = screen.scroll === "vertical"
      ? Math.max(screen.viewport.height, screen.root.height.value + 48)
      : screen.viewport.height;
    const root: FrameNodeSpec = {
      type: "frame", name: `${screen.id} content`, width: screen.viewport.width, height: contentHeight,
      sizing: { width: "fixed", height: "fixed" },
      layout: { mode: "vertical", padding: { top: 24, right: 24, bottom: 24, left: 24 }, counterAxisAlign: "start" },
      children: [nodeToNative(screen.root, program, screen.id, program.locale.direction)],
      logicalRef: `${screen.id}.content`,
    };
    return {
      id: screen.id,
      name: screen.title,
      order: screen.order,
      devicePreset: screen.viewport.preset,
      width: screen.viewport.width,
      height: screen.viewport.height,
      background: "#FFFFFF",
      layout: { mode: "vertical", counterAxisAlign: "start" },
      children: [root],
      metadata: {
        programVersion: program.programVersion,
        programId: program.id,
        purpose: screen.purpose,
        language: program.locale.language,
        direction: program.locale.direction,
        scroll: screen.scroll,
        ...(screen.dependsOn.length ? { dependsOn: screen.dependsOn.join(",") } : {}),
      },
    };
  });
  const batchValue = {
    schemaVersion: "1.0.0",
    id: program.id,
    name: program.id,
    designSystem: designProgramTokens(program),
    screens,
  };
  const checked = parseMultiScreenValue(batchValue);
  if (!checked.success) return { success: false, findings: checked.errors.map((message) => ({ code: "native_schema_rejected", path: "batch", message, severity: "error" })) };
  for (const diagnostic of auditVisualQuality(checked.data).diagnostics)
    findings.push({ code: `quality_${diagnostic.code}`, path: diagnostic.path, message: diagnostic.message, severity: "warning" });
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
