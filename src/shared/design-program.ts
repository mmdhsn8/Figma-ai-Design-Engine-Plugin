import { z } from "zod";
import { DesignSystemTokensSchema } from "./design-system-schema.js";
import { ProjectVisualLanguageV1Schema, ScreenCompositionV1Schema } from "./design-composition.js";
import { GEOMETRY_EPSILON, minimumAxisExtent } from "./native-geometry.js";
import { hasUnrenderableProgramText } from "./program-text.js";

export const DESIGN_PROGRAM_VERSION = 1 as const;
export const DESIGN_PROGRAM_LIMITS = {
  screens: 10,
  nodes: 300,
  depth: 8,
  children: 100,
  labelChars: 500,
} as const;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/u);
const colorSchema = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  z.string().regex(/^token:[a-z][a-zA-Z0-9.-]{0,79}$/u),
]);
const dimensionSchema = z
  .object({
    mode: z.enum(["fixed", "hug", "fill"]),
    value: z.number().finite().min(1).max(20_000),
    min: z.number().finite().min(1).max(20_000).optional(),
    max: z.number().finite().min(1).max(20_000).optional(),
  })
  .strict()
  .superRefine((dimension, context) => {
    if (dimension.min !== undefined && dimension.max !== undefined && dimension.min > dimension.max)
      context.addIssue({ code: "custom", message: "Minimum dimension cannot exceed maximum." });
    if (dimension.min !== undefined && dimension.value < dimension.min)
      context.addIssue({ code: "custom", message: "Value is below its minimum." });
    if (dimension.max !== undefined && dimension.value > dimension.max)
      context.addIssue({ code: "custom", message: "Value exceeds its maximum." });
  });

const nodeBase = {
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  semanticRole: z.string().trim().min(1).max(60),
  interaction: z.enum(["none", "button", "input", "navigation"]).default("none"),
  width: dimensionSchema,
  height: dimensionSchema,
};
const layoutSchema = z
  .object({
    axis: z.enum(["row", "column"]),
    wrap: z.boolean().optional(),
    gap: z.number().finite().min(0).max(1_000).default(0),
    padding: z
      .object({ top: z.number().min(0).max(1_000).default(0), right: z.number().min(0).max(1_000).default(0), bottom: z.number().min(0).max(1_000).default(0), left: z.number().min(0).max(1_000).default(0) })
      .strict()
      .default({ top: 0, right: 0, bottom: 0, left: 0 }),
    align: z.enum(["start", "center", "end", "space-between"]).default("start"),
    crossAlign: z.enum(["start", "center", "end", "stretch", "baseline"]).default("stretch"),
  })
  .strict();

export const DesignProgramNodeSchema: z.ZodType<DesignProgramNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...nodeBase, type: z.literal("container"), layout: layoutSchema, background: colorSchema.optional(), children: z.array(DesignProgramNodeSchema).max(DESIGN_PROGRAM_LIMITS.children) }).strict(),
    z.object({ ...nodeBase, type: z.literal("text"), text: z.string().max(5_000), color: colorSchema, fontSize: z.number().finite().min(8).max(96).default(16), textRole: z.enum(["display", "title", "heading", "body", "caption", "label", "action"]).optional(), weight: z.enum(["regular", "medium", "semibold", "bold"]).default("regular"), align: z.enum(["left", "center", "right", "justified"]).optional() }).strict(),
    z.object({ ...nodeBase, type: z.literal("rectangle"), fill: colorSchema, cornerRadius: z.number().finite().min(0).max(500).optional() }).strict(),
    z.object({ ...nodeBase, type: z.literal("ellipse"), fill: colorSchema }).strict(),
    z.object({ ...nodeBase, type: z.literal("vector"), pathData: z.string().min(3).max(8_192), fill: colorSchema }).strict(),
    z.object({ ...nodeBase, type: z.literal("instance"), componentId: idSchema }).strict(),
    z.object({ ...nodeBase, type: z.literal("image"), asset: z.object({ source: z.enum(["placeholder", "user-approved-brand-kit", "authorized-existing-file"]), label: z.string().trim().min(1).max(200), assetRef: z.string().trim().min(1).max(200).optional(), verified: z.boolean().optional(), authorized: z.boolean().optional() }).strict() }).strict(),
  ]) as z.ZodType<DesignProgramNode>,
);

export interface DesignProgramNodeBase {
  id: string;
  name: string;
  semanticRole: string;
  interaction: "none" | "button" | "input" | "navigation";
  width: z.infer<typeof dimensionSchema>;
  height: z.infer<typeof dimensionSchema>;
}
export type DesignProgramNode =
  | (DesignProgramNodeBase & { type: "container"; layout: z.infer<typeof layoutSchema>; background?: string; children: DesignProgramNode[] })
  | (DesignProgramNodeBase & { type: "text"; text: string; color: string; fontSize: number; textRole?: "display" | "title" | "heading" | "body" | "caption" | "label" | "action"; weight: "regular" | "medium" | "semibold" | "bold"; align?: "left" | "center" | "right" | "justified" })
  | (DesignProgramNodeBase & { type: "rectangle"; fill: string; cornerRadius?: number })
  | (DesignProgramNodeBase & { type: "ellipse"; fill: string })
  | (DesignProgramNodeBase & { type: "vector"; pathData: string; fill: string })
  | (DesignProgramNodeBase & { type: "instance"; componentId: string })
  | (DesignProgramNodeBase & { type: "image"; asset: { source: "placeholder" | "user-approved-brand-kit" | "authorized-existing-file"; label: string; assetRef?: string; verified?: boolean; authorized?: boolean } });

const viewportSchema = z.discriminatedUnion("preset", [
  z.object({ preset: z.literal("mobile"), width: z.literal(390), height: z.literal(844) }).strict(),
  z.object({ preset: z.literal("desktop"), width: z.literal(1440), height: z.literal(900) }).strict(),
  z.object({ preset: z.literal("custom"), width: z.number().finite().min(320).max(4_000), height: z.number().finite().min(320).max(4_000) }).strict(),
]);
const referenceSchema = z.object({ kind: z.enum(["component", "variable", "style"]), ref: z.string().trim().min(1).max(200), verified: z.boolean(), authorized: z.boolean() }).strict();

const DesignProgramScreenV1Schema = z.object({ id: idSchema, title: z.string().trim().min(1).max(100), purpose: z.string().trim().min(1).max(300), order: z.number().int().min(0).max(1_000), viewport: viewportSchema, scroll: z.enum(["none", "vertical", "horizontal"]).default("none"), dependsOn: z.array(idSchema).max(10).default([]), compositionV1: ScreenCompositionV1Schema.optional(), root: DesignProgramNodeSchema }).strict();

export const DesignProgramV1Schema = z.object({
  programVersion: z.literal(DESIGN_PROGRAM_VERSION),
  id: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  goal: z.string().trim().min(1).max(500),
  audience: z.string().trim().min(1).max(200),
  locale: z.object({ language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u), direction: z.enum(["ltr", "rtl"]) }).strict(),
  visualIntent: z.string().trim().min(1).max(500),
  // Additive Phase 4 fields: older version-1 checkpoints remain parseable.
  visualLanguageV1: ProjectVisualLanguageV1Schema.optional(),
  contentProvenance: z.enum(["synthetic-fixture", "synthetic-illustrative", "user-provided", "approved-source"]),
  requiredCapabilities: z.array(z.enum(["native-text", "auto-layout", "rtl", "vertical-scroll", "vector", "image", "component-reference", "variable-reference"])).max(20).default([]),
  tokens: z.object({ colors: z.record(z.string().regex(/^[a-z][a-z0-9.-]{0,39}$/u), z.string().regex(/^#[0-9a-fA-F]{6}$/u)).default({}), spacing: z.array(z.number().finite().min(0).max(1_000)).max(24).default([]), headingFont: z.string().trim().min(1).max(100).default("Inter"), bodyFont: z.string().trim().min(1).max(100).default("Inter") }).strict().default({ colors: {}, spacing: [], headingFont: "Inter", bodyFont: "Inter" }),
  references: z.array(referenceSchema).max(50).default([]),
  componentsV1: z.array(z.object({ id: idSchema, root: DesignProgramNodeSchema }).strict()).max(12).optional(),
  screens: z.array(DesignProgramScreenV1Schema).min(1).max(DESIGN_PROGRAM_LIMITS.screens),
}).strict();
export type DesignProgramV1 = z.infer<typeof DesignProgramV1Schema>;

export const UniversalDesignProgramV1Schema = DesignProgramV1Schema.extend({
  visualLanguageV1: ProjectVisualLanguageV1Schema,
  screens: z.array(DesignProgramScreenV1Schema.extend({ compositionV1: ScreenCompositionV1Schema })).min(1).max(DESIGN_PROGRAM_LIMITS.screens),
});

export type DesignProgramFinding = { code: string; path: string; message: string; severity: "error" | "warning" };
export type DesignProgramParseResult =
  | { success: true; data: DesignProgramV1; fingerprint: string; nodeCount: number; findings: DesignProgramFinding[] }
  | { success: false; findings: DesignProgramFinding[] };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}

export function canonicalDesignProgram(program: DesignProgramV1): string {
  return JSON.stringify(canonicalize(program));
}

export function fingerprintDesignProgram(program: DesignProgramV1): string {
  const source = canonicalDesignProgram(program);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index++) {
    const codePoint = source.codePointAt(index)!;
    if (codePoint > 0xffff) index++;
    const text = String.fromCodePoint(codePoint);
    for (let byteIndex = 0; byteIndex < text.length; byteIndex++) {
      hash ^= BigInt(text.charCodeAt(byteIndex));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  }
  return `dpv1-${hash.toString(16).padStart(16, "0")}`;
}

function walkNodes(root: DesignProgramNode, visit: (node: DesignProgramNode, depth: number) => void, depth = 1): void {
  visit(root, depth);
  if (root.type === "container") root.children.forEach((child) => walkNodes(child, visit, depth + 1));
}

function validateDependencies(program: DesignProgramV1, findings: DesignProgramFinding[]): void {
  const ids = new Set(program.screens.map(({ id }) => id));
  const graph = new Map(program.screens.map(({ id, dependsOn }) => [id, dependsOn]));
  const visited = new Set<string>();
  const active = new Set<string>();
  for (const screen of program.screens) {
    if (new Set(screen.dependsOn).size !== screen.dependsOn.length)
      findings.push({ code: "duplicate_dependency", path: `screens.${screen.id}.dependsOn`, message: "Screen dependencies must be unique.", severity: "error" });
    for (const dependency of screen.dependsOn)
      if (!ids.has(dependency)) findings.push({ code: "missing_dependency", path: `screens.${screen.id}.dependsOn`, message: `Dependency “${dependency}” does not exist.`, severity: "error" });
  }
  const visit = (id: string) => {
    if (active.has(id)) { findings.push({ code: "dependency_cycle", path: `screens.${id}.dependsOn`, message: "Screen dependencies contain a cycle.", severity: "error" }); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of graph.get(id) ?? []) if (ids.has(dependency)) visit(dependency);
    active.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function parseDesignProgram(value: unknown, options: { allowedBrandAssetIds?: ReadonlySet<string> } = {}): DesignProgramParseResult {
  const parsed = DesignProgramV1Schema.safeParse(value);
  if (!parsed.success) return { success: false, findings: parsed.error.issues.slice(0, 100).map((issue) => ({ code: "invalid_schema", path: issue.path.map(String).join(".") || "program", message: issue.message, severity: "error" })) };
  const program = parsed.data;
  const findings: DesignProgramFinding[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();
  let nodeCount = 0;
  const components = new Map<string, { width: number; height: number; descendants: number }>();
  for (const { id, root } of program.componentsV1 ?? []) {
    if (components.has(id) || root.type !== "container" || root.width.mode !== "fixed" || root.height.mode !== "fixed") {
      findings.push({ code: "invalid_local_component", path: `componentsV1.${id}`, message: "Use a unique component ID and a fixed size container master.", severity: "error" });
      continue;
    }
    let descendants = -1;
    const ids = new Set<string>();
    walkNodes(root, (node, depth) => {
      descendants++;
      if (ids.has(node.id) || node.type === "instance" || node.type === "image" || depth > DESIGN_PROGRAM_LIMITS.depth)
        findings.push({ code: "invalid_local_component_node", path: `componentsV1.${id}.${node.id}`, message: "Use unique bounded native nodes without nested instances or image dependencies.", severity: "error" });
      ids.add(node.id);
      if (node.type === "text" && hasUnrenderableProgramText(node.text))
        findings.push({ code: "invalid_native_text", path: `componentsV1.${id}.${node.id}`, message: "Text contains an invalid Unicode character or a directional override.", severity: "error" });
    });
    nodeCount += descendants + 1;
    components.set(id, { width: root.width.value, height: root.height.value, descendants });
  }
  for (const [screenIndex, screen] of program.screens.entries()) {
    if (ids.has(screen.id)) findings.push({ code: "duplicate_id", path: `screens.${screenIndex}.id`, message: `Duplicate id “${screen.id}”.`, severity: "error" });
    ids.add(screen.id);
    if (orders.has(screen.order)) findings.push({ code: "duplicate_order", path: `screens.${screenIndex}.order`, message: `Duplicate screen order ${screen.order}.`, severity: "error" });
    orders.add(screen.order);
    const nodeIds = new Set<string>();
    walkNodes(screen.root, (node, depth) => {
      nodeCount++;
      if (node.type === "text" && hasUnrenderableProgramText(node.text))
        findings.push({ code: "invalid_native_text", path: `screens.${screen.id}.${node.id}`, message: "Text contains an invalid Unicode character or a directional override.", severity: "error" });
      if (node.type === "instance") {
        const component = components.get(node.componentId);
        if (!component || node.width.mode !== "fixed" || node.height.mode !== "fixed" ||
          node.width.value !== component.width || node.height.value !== component.height)
          findings.push({ code: "invalid_local_instance", path: `screens.${screen.id}.root.${node.id}`, message: "Use a declared local component at its fixed master size.", severity: "error" });
        else nodeCount += component.descendants;
      }
      if (nodeIds.has(node.id)) findings.push({ code: "duplicate_id", path: `screens.${screen.id}.root.${node.id}`, message: `Duplicate node id “${node.id}”.`, severity: "error" });
      nodeIds.add(node.id);
      if (depth > DESIGN_PROGRAM_LIMITS.depth) findings.push({ code: "depth_limit", path: `screens.${screen.id}.root.${node.id}`, message: `Maximum tree depth is ${DESIGN_PROGRAM_LIMITS.depth}.`, severity: "error" });
      if (node.interaction !== "none" && (node.width.value < 44 || node.height.value < 44)) findings.push({ code: "touch_target_below_minimum", path: `screens.${screen.id}.root.${node.id}`, message: "Interactive native targets must be at least 44 × 44 px in this spike.", severity: "error" });
      if (node.type === "container" && node.layout.wrap && (node.layout.axis !== "row" || node.width.mode === "hug"))
        findings.push({ code: "unsupported_layout_wrap", path: `screens.${screen.id}.root.${node.id}`, message: "Wrap requires a horizontal row with a bounded width.", severity: "error" });
      if ((screen.compositionV1 || (node.type === "container" && node.layout.wrap)) && node.type === "container") {
        const horizontal = node.layout.axis === "row";
        const dimension = horizontal ? node.width : node.height;
        if (dimension.mode === "fixed" && node.children.length) {
          const padding = horizontal
            ? node.layout.padding.left + node.layout.padding.right
            : node.layout.padding.top + node.layout.padding.bottom;
          const sizes = node.children.map((child) => child[horizontal ? "width" : "height"]);
          const required = node.layout.wrap
            ? Math.max(...sizes.map((size) => minimumAxisExtent([size], 0, padding)))
            : minimumAxisExtent(sizes, node.layout.gap, padding);
          if (required > dimension.value + GEOMETRY_EPSILON)
            findings.push({ code: "layout_axis_overflow", path: `screens.${screen.id}.root.${node.id}`, message: `Children require at least ${required} px but the ${horizontal ? "width" : "height"} is ${dimension.value} px.`, severity: "error" });
        }
      }
      for (const value of node.type === "container" ? [node.background] : node.type === "text" ? [node.color] : node.type === "image" || node.type === "instance" ? [] : [node.fill]) {
        if (typeof value === "string" && value.startsWith("token:") && !(value.slice(6) in program.tokens.colors)) findings.push({ code: "missing_token", path: `screens.${screen.id}.root.${node.id}`, message: `Color token “${value.slice(6)}” is not defined.`, severity: "error" });
      }
      if (node.type === "image") {
        if (/(?:https?:\/\/|www\.)/iu.test(node.asset.label))
          findings.push({ code: "asset_url_forbidden", path: `screens.${screen.id}.root.${node.id}.asset`, message: "Asset labels cannot contain remote URLs.", severity: "error" });
        if (node.asset.source === "placeholder" && node.asset.assetRef)
          findings.push({ code: "placeholder_asset_reference", path: `screens.${screen.id}.root.${node.id}.asset`, message: "Labeled placeholders cannot reference embedded asset bytes.", severity: "error" });
        if (node.asset.source === "user-approved-brand-kit") {
          if (!node.asset.verified || !node.asset.authorized || !node.asset.assetRef)
            findings.push({ code: "asset_provenance_unverified", path: `screens.${screen.id}.root.${node.id}.asset`, message: "Brand Kit assets require a verified and authorized pinned asset reference.", severity: "error" });
          else if (!options.allowedBrandAssetIds?.has(node.asset.assetRef))
            findings.push({ code: "asset_outside_pinned_brand_kit", path: `screens.${screen.id}.root.${node.id}.asset`, message: "The asset is not present in this task's pinned Brand Kit revision.", severity: "error" });
        }
        if (node.asset.source === "authorized-existing-file") {
          if (!node.asset.verified || !node.asset.authorized || !node.asset.assetRef)
            findings.push({ code: "asset_provenance_unverified", path: `screens.${screen.id}.root.${node.id}.asset`, message: "Non-placeholder assets require a verified, authorized asset reference.", severity: "error" });
          findings.push({ code: "unsupported_asset_source", path: `screens.${screen.id}.root.${node.id}.asset`, message: "Existing-file assets are outside the Universal Chat asset scope.", severity: "error" });
        }
      }
    });
    if (screen.scroll === "horizontal") findings.push({ code: "unsupported_horizontal_scroll", path: `screens.${screen.id}.scroll`, message: "Horizontal scrolling is unsupported by this adapter.", severity: "error" });
    if (screen.scroll === "vertical" && screen.viewport.preset === "mobile" && !program.requiredCapabilities.includes("vertical-scroll")) findings.push({ code: "capability_not_declared", path: `screens.${screen.id}.scroll`, message: "Declare vertical-scroll in requiredCapabilities.", severity: "error" });
  }
  if (nodeCount > DESIGN_PROGRAM_LIMITS.nodes) findings.push({ code: "node_limit", path: "screens", message: `Program contains ${nodeCount} nodes; maximum is ${DESIGN_PROGRAM_LIMITS.nodes}.`, severity: "error" });
  if (program.visualLanguageV1) {
    for (const [screenIndex, screen] of program.screens.entries()) {
      const composition = screen.compositionV1;
      if (!composition) continue;
      const nodes = new Map<string, DesignProgramNode>();
      walkNodes(screen.root, (node) => nodes.set(node.id, node));
      const referenced = [...composition.regions.map(({ nodeId }) => nodeId), composition.focusNodeId];
      for (const nodeId of referenced) {
        if (!nodes.has(nodeId)) findings.push({ code: "composition_node_missing", path: `screens.${screenIndex}.compositionV1.${nodeId}`, message: "Composition intent references a node absent from the editable screen tree.", severity: "error" });
      }
      for (const region of composition.regions) {
        const node = nodes.get(region.nodeId);
        if (node && node.type !== "container") findings.push({ code: "composition_region_not_container", path: `screens.${screenIndex}.compositionV1.regions.${region.nodeId}`, message: "Semantic composition regions must map to editable layout containers.", severity: "error" });
        if (node?.type === "container" && node.semanticRole.toLocaleLowerCase() !== region.semanticRole.toLocaleLowerCase())
          findings.push({ code: "composition_region_role_mismatch", path: `screens.${screenIndex}.compositionV1.regions.${region.nodeId}.semanticRole`, message: "Composition region meaning must match its editable container's semantic role.", severity: "error" });
      }
      const assetRefs = new Set<string>();
      walkNodes(screen.root, (node) => { if (node.type === "image" && node.asset.source === "user-approved-brand-kit" && node.asset.assetRef) assetRefs.add(node.asset.assetRef); });
      for (const assetRef of composition.approvedAssetsUsed)
        if (!assetRefs.has(assetRef)) findings.push({ code: "composition_asset_unused", path: `screens.${screenIndex}.compositionV1.approvedAssetsUsed`, message: "Composition claims a Brand Kit asset that no image node uses.", severity: "error" });
      for (const assetRef of assetRefs)
        if (!composition.approvedAssetsUsed.includes(assetRef)) findings.push({ code: "composition_asset_unlisted", path: `screens.${screenIndex}.compositionV1.approvedAssetsUsed`, message: "Every pinned Brand Kit image use must be declared in composition provenance.", severity: "error" });
    }
  } else if (program.screens.some(({ compositionV1 }) => compositionV1)) {
    findings.push({ code: "composition_language_missing", path: "visualLanguageV1", message: "Screen composition requires its shared project visual language.", severity: "error" });
  }
  validateDependencies(program, findings);
  for (const reference of program.references) {
    if (!reference.verified || !reference.authorized) findings.push({ code: "reference_unverified", path: `references.${reference.ref}`, message: "References require verified and authorized scope.", severity: "error" });
    findings.push({ code: `unsupported_${reference.kind}_reference`, path: `references.${reference.ref}`, message: `${reference.kind} bindings are not implemented in this spike.`, severity: "error" });
  }
  const errorFindings = findings.filter(({ severity }) => severity === "error");
  if (errorFindings.length) return { success: false, findings: errorFindings.slice(0, 100) };
  return { success: true, data: program, fingerprint: fingerprintDesignProgram(program), nodeCount, findings };
}

export function designProgramTokens(program: DesignProgramV1) {
  const language = program.visualLanguageV1?.typography;
  return DesignSystemTokensSchema.parse({
    id: `${program.id}-tokens`, namespace: (program.id.replace(/[^a-z0-9-]/gu, "-").slice(0, 40)).padEnd(2, "x"), name: `${program.id} tokens`,
    colors: Object.fromEntries(Object.entries(program.tokens.colors).map(([key, value]) => [`color.${key}`, value])),
    typography: {
      "typography.display": { fontFamily: program.tokens.headingFont, fontWeight: 700, fontSize: language?.displaySize ?? 40 },
      "typography.heading": { fontFamily: program.tokens.headingFont, fontWeight: 700, fontSize: language?.titleSize ?? 28 },
      "typography.body": { fontFamily: program.tokens.bodyFont, fontWeight: 400, fontSize: language?.bodySize ?? 16 },
      "typography.caption": { fontFamily: program.tokens.bodyFont, fontWeight: 400, fontSize: language?.captionSize ?? 12 },
    },
    spacing: { scale: program.tokens.spacing, aliases: {} },
  });
}
