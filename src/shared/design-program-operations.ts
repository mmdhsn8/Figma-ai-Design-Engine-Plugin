import { FigmaToolOperationSchema, type FigmaToolOperation } from "./figma-tools";
import { parseDesignProgram, type DesignProgramFinding, type DesignProgramNode } from "./design-program";

export type DesignProgramToolCompileResult =
  | { success: true; operations: FigmaToolOperation[]; batches: FigmaToolOperation[][]; fingerprint: string; nodeCount: number }
  | { success: false; findings: DesignProgramFinding[] };

function color(value: string, colors: Record<string, string>): string {
  return value.startsWith("token:") ? colors[value.slice(6)] ?? "#000000" : value;
}

function safeRef(...parts: string[]): string {
  const ref = `dp-${parts.join("-")}`.replace(/[^A-Za-z0-9._-]/gu, "-");
  if (ref.length > 80) throw new Error("Stable operation ref exceeds 80 characters.");
  return ref;
}

function safeName(name: string): boolean {
  return !/[\\/]/u.test(name) && !Array.from(name).some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

export function compileDesignProgramOperations(
  value: unknown,
  scope: { documentId: string; pageId: string; taskId: string },
): DesignProgramToolCompileResult {
  const parsed = parseDesignProgram(value);
  if (!parsed.success) return { success: false, findings: parsed.findings };
  if (!/^[A-Za-z0-9_-]{8,60}$/u.test(scope.taskId) || !scope.documentId.trim() || !scope.pageId.trim())
    return { success: false, findings: [{ code: "invalid_tool_scope", path: "scope", message: "Candidate B requires explicit document, page, and task ids.", severity: "error" }] };
  const program = parsed.data;
  const findings: DesignProgramFinding[] = [];
  const raw: Array<Record<string, unknown>> = [];
  const refs = new Set<string>();
  const add = (ref: string, name: string, action: Record<string, unknown>) => {
    if (refs.has(ref)) { findings.push({ code: "duplicate_tool_ref", path: ref, message: "The bounded operation plan contains a duplicate ref.", severity: "error" }); return; }
    refs.add(ref);
    const index = raw.length + 1;
    raw.push({
      operationId: `dpop${String(index).padStart(6, "0")}`,
      idempotencyKey: `dp:${parsed.fingerprint}:${index}`,
      taskId: scope.taskId,
      documentId: scope.documentId,
      designName: program.id.slice(0, 100),
      action: { ...action, pageId: scope.pageId },
    });
    void name;
  };
  const emitNode = (node: DesignProgramNode, parentRef: string, screenId: string): string => {
    const ref = safeRef(program.id, screenId, node.id);
    if (!safeName(node.name)) findings.push({ code: "unsupported_display_name", path: `screens.${screenId}.${node.id}.name`, message: "Tool names cannot contain slashes or control characters.", severity: "error" });
    const size = { width: node.width.value, height: node.height.value };
    if (node.type === "container") {
      add(ref, node.name, { tool: "create_frame", ref, name: node.name, parent: { kind: "node", ref: parentRef }, size, autoLayout: { direction: node.layout.axis === "row" ? "horizontal" : "vertical", gap: node.layout.gap, padding: node.layout.padding, primaryAlign: node.layout.align === "space-between" ? "SPACE_BETWEEN" : node.layout.align === "center" ? "CENTER" : node.layout.align === "end" ? "MAX" : "MIN", counterAlign: node.layout.crossAlign === "center" ? "CENTER" : node.layout.crossAlign === "end" ? "MAX" : node.layout.crossAlign === "baseline" ? "BASELINE" : node.layout.crossAlign === "stretch" ? "MAX" : "MIN" } });
      const children = node.children.map((child) => ({ ref: emitNode(child, ref, screenId), width: child.width.mode, height: child.height.mode }));
      if (children.length) add(safeRef("layout", program.id, screenId, node.id), node.name, { tool: "set_auto_layout", ref, layout: { direction: node.layout.axis === "row" ? "horizontal" : "vertical", gap: node.layout.gap, padding: node.layout.padding, primaryAlign: node.layout.align === "space-between" ? "SPACE_BETWEEN" : node.layout.align === "center" ? "CENTER" : node.layout.align === "end" ? "MAX" : "MIN", counterAlign: node.layout.crossAlign === "center" ? "CENTER" : node.layout.crossAlign === "end" ? "MAX" : node.layout.crossAlign === "baseline" ? "BASELINE" : "MIN" }, children: children.map(({ ref: childRef, width, height }) => ({ ref: childRef, horizontal: width.toUpperCase(), vertical: height.toUpperCase(), ...(width === "fill" ? { align: "STRETCH" } : {}) })) });
      return ref;
    }
    if (node.type === "text") {
      add(ref, node.name, { tool: "create_text", ref, name: node.name, parent: { kind: "node", ref: parentRef }, text: node.text, size, font: { family: node.weight === "bold" || node.weight === "semibold" ? program.tokens.headingFont : program.tokens.bodyFont, style: node.weight === "bold" ? "Bold" : node.weight === "semibold" ? "Semi Bold" : node.weight === "medium" ? "Medium" : "Regular" }, fontSize: node.fontSize, color: color(node.color, program.tokens.colors), align: (node.align ?? (program.locale.direction === "rtl" ? "right" : "left")).toUpperCase(), direction: program.locale.direction.toUpperCase(), horizontalSizing: node.width.mode.toUpperCase(), verticalSizing: node.height.mode.toUpperCase() });
      return ref;
    }
    if (node.type === "rectangle") {
      add(ref, node.name, { tool: "create_rectangle", ref, name: node.name, parent: { kind: "node", ref: parentRef }, size, fill: color(node.fill, program.tokens.colors), cornerRadius: node.cornerRadius });
      return ref;
    }
    if (node.type === "image" && node.asset.source === "placeholder") {
      add(ref, node.name, { tool: "create_frame", ref, name: node.name, parent: { kind: "node", ref: parentRef }, size, fill: "#EEF1F5", autoLayout: { direction: "vertical", gap: 0, padding: { top: 8, right: 8, bottom: 8, left: 8 }, primaryAlign: "CENTER", counterAlign: "CENTER" } });
      const labelRef = safeRef(program.id, screenId, node.id, "label");
      add(labelRef, "Placeholder disclosure", { tool: "create_text", ref: labelRef, name: "Placeholder disclosure", parent: { kind: "node", ref }, text: `Placeholder · ${node.asset.label}`, size: { width: Math.min(node.width.value, 300), height: 32 }, fontSize: 14, color: "#475569", align: "CENTER", horizontalSizing: "HUG", verticalSizing: "HUG" });
      return ref;
    }
    findings.push({ code: "unsupported_tool_primitive", path: `screens.${screenId}.${node.id}`, message: `Candidate B does not implement ${node.type}; no domain-specific substitute was added.`, severity: "error" });
    return ref;
  };
  for (const screen of [...program.screens].sort((a, b) => a.order - b.order)) {
    const rootRef = safeRef(program.id, screen.id, "screen");
    if (!safeName(screen.title)) findings.push({ code: "unsupported_display_name", path: `screens.${screen.id}.title`, message: "Tool names cannot contain slashes or control characters.", severity: "error" });
    add(rootRef, screen.title, { tool: "create_frame", ref: rootRef, name: screen.title, parent: { kind: "page" }, size: { width: screen.viewport.width, height: screen.viewport.height }, fill: "#FFFFFF", ...(screen.scroll === "vertical" ? { clipsContent: true, overflowDirection: "VERTICAL" } : {}), autoLayout: { direction: "vertical", gap: 0, padding: { top: 24, right: 24, bottom: 24, left: 24 }, counterAlign: "MAX" } });
    const contentRef = safeRef(program.id, screen.id, "content");
    add(contentRef, "Screen content", { tool: "create_frame", ref: contentRef, name: "Screen content", parent: { kind: "node", ref: rootRef }, size: { width: screen.viewport.width - 48, height: Math.max(screen.viewport.height - 48, screen.root.height.value) }, autoLayout: { direction: "vertical", gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, counterAlign: "MAX" } });
    emitNode(screen.root, contentRef, screen.id);
  }
  if (findings.length) return { success: false, findings };
  try {
    const operations = raw.map((operation) => FigmaToolOperationSchema.parse(operation));
    return { success: true, operations, batches: Array.from({ length: Math.ceil(operations.length / 10) }, (_, index) => operations.slice(index * 10, index * 10 + 10)), fingerprint: parsed.fingerprint, nodeCount: parsed.nodeCount };
  } catch (error) {
    return { success: false, findings: [{ code: "tool_schema_rejected", path: "operations", message: error instanceof Error ? error.message : "Candidate B operations did not pass the current tool schema.", severity: "error" }] };
  }
}
