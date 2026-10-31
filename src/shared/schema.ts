import { z } from "zod";

export const DESIGN_SCHEMA_VERSION = "1.0.0";
export const MAX_JSON_LENGTH = 1_000_000;
export const MAX_NESTING_DEPTH = 8;
export const MAX_NODE_COUNT = 500;
export const MAX_COMPONENT_COUNT = 50;

export type SizingMode = "fixed" | "hug" | "fill";
export type AxisSizing = { width: SizingMode; height: SizingMode };

export interface LayoutSpec {
  mode: "horizontal" | "vertical";
  gap?: number;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  primaryAxisAlign?: "start" | "center" | "end" | "space-between";
  counterAxisAlign?: "start" | "center" | "end" | "baseline" | "stretch";
}

export interface TextNodeSpec {
  type: "text";
  name: string;
  text: string;
  fontSize: number;
  color: string;
  x?: number;
  y?: number;
  fontFamily?: string;
  fontStyle?: string;
  lineHeight?: number;
  textAlign?: "left" | "center" | "right" | "justified";
  textAutoResize?: "width-and-height" | "height" | "truncate";
  width?: number;
  height?: number;
  sizing?: AxisSizing;
}

export interface RectangleNodeSpec {
  type: "rectangle";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  fill: string;
  stroke?: { color: string; width?: number };
  cornerRadius?: number;
  cornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  sizing?: AxisSizing;
}

export interface FrameNodeSpec {
  type: "frame";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  background?: string;
  stroke?: { color: string; width?: number };
  cornerRadius?: number;
  cornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  children: DesignNode[];
  layout?: LayoutSpec;
  sizing?: AxisSizing;
}

export interface InstanceNodeSpec {
  type: "instance";
  componentId: string;
  name?: string;
  x?: number;
  y?: number;
  sizing?: AxisSizing;
}

export type DesignNode = TextNodeSpec | RectangleNodeSpec | FrameNodeSpec | InstanceNodeSpec;

export interface ComponentDefinitionSpec {
  type: "component";
  id: string;
  name: string;
  width: number;
  height: number;
  background?: string;
  stroke?: { color: string; width?: number };
  cornerRadius?: number;
  cornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  children: DesignNode[];
  layout?: LayoutSpec;
  sizing?: AxisSizing;
}

export interface DesignDocumentSpec {
  name: string;
  width: number;
  height: number;
  background: string;
  children: DesignNode[];
  layout?: LayoutSpec;
  components?: ComponentDefinitionSpec[];
}

export interface DesignSpec {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  document: DesignDocumentSpec;
}

const nameSchema = z.string().trim().min(1).max(200);
const coordinateSchema = z.number().finite().min(-10_000).max(10_000);
const dimensionSchema = z.number().finite().min(1).max(10_000);
const radiusSchema = z.number().finite().min(0).max(5_000);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const sizingSchema = z
  .object({
    width: z.enum(["fixed", "hug", "fill"]),
    height: z.enum(["fixed", "hug", "fill"]),
  })
  .strict();
const strokeSchema = z
  .object({ color: colorSchema, width: z.number().finite().min(0.25).max(100).optional() })
  .strict();
const cornerRadiiSchema = z
  .object({
    topLeft: radiusSchema,
    topRight: radiusSchema,
    bottomRight: radiusSchema,
    bottomLeft: radiusSchema,
  })
  .strict();

export const LayoutSchema: z.ZodType<LayoutSpec> = z
  .object({
    mode: z.enum(["horizontal", "vertical"]),
    gap: z.number().finite().min(0).max(1_000).optional(),
    padding: z
      .object({
        top: z.number().finite().min(0).max(1_000).optional(),
        right: z.number().finite().min(0).max(1_000).optional(),
        bottom: z.number().finite().min(0).max(1_000).optional(),
        left: z.number().finite().min(0).max(1_000).optional(),
      })
      .strict()
      .optional(),
    primaryAxisAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
    counterAxisAlign: z.enum(["start", "center", "end", "baseline", "stretch"]).optional(),
  })
  .strict();

const TextNodeSchema = z
  .object({
    type: z.literal("text"),
    name: nameSchema,
    text: z.string().max(5_000),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    fontSize: z.number().finite().min(1).max(512),
    color: colorSchema,
    fontFamily: z.string().trim().min(1).max(100).optional(),
    fontStyle: z.string().trim().min(1).max(100).optional(),
    lineHeight: z.number().finite().min(1).max(1_000).optional(),
    textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
    textAutoResize: z.enum(["width-and-height", "height", "truncate"]).optional(),
    width: dimensionSchema.optional(),
    height: dimensionSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

const RectangleNodeSchema = z
  .object({
    type: z.literal("rectangle"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    fill: colorSchema,
    stroke: strokeSchema.optional(),
    cornerRadius: radiusSchema.optional(),
    cornerRadii: cornerRadiiSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

const InstanceNodeSchema = z
  .object({
    type: z.literal("instance"),
    componentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/),
    name: nameSchema.optional(),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

const DesignNodeSchema: z.ZodType<DesignNode> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      TextNodeSchema,
      RectangleNodeSchema,
      FrameNodeSchema,
      InstanceNodeSchema,
    ]) as z.ZodType<DesignNode>,
);

const FrameNodeSchema = z
  .object({
    type: z.literal("frame"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    background: colorSchema.optional(),
    stroke: strokeSchema.optional(),
    cornerRadius: radiusSchema.optional(),
    cornerRadii: cornerRadiiSchema.optional(),
    children: z.array(DesignNodeSchema).max(250),
    layout: LayoutSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

const ComponentDefinitionSchema: z.ZodType<ComponentDefinitionSpec> = z
  .object({
    type: z.literal("component"),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/),
    name: nameSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    background: colorSchema.optional(),
    stroke: strokeSchema.optional(),
    cornerRadius: radiusSchema.optional(),
    cornerRadii: cornerRadiiSchema.optional(),
    children: z.array(DesignNodeSchema).max(250),
    layout: LayoutSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

export const DesignSchema: z.ZodType<DesignSpec> = z
  .object({
    schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
    document: z
      .object({
        name: nameSchema,
        width: dimensionSchema,
        height: dimensionSchema,
        background: colorSchema,
        children: z.array(DesignNodeSchema).max(250),
        layout: LayoutSchema.optional(),
        components: z.array(ComponentDefinitionSchema).max(MAX_COMPONENT_COUNT).optional(),
      })
      .strict(),
  })
  .strict();

export type DesignParseResult =
  { success: true; data: DesignSpec } | { success: false; errors: string[] };

export interface DesignCounts {
  frames: number;
  texts: number;
  rectangles: number;
  components: number;
  instances: number;
}

function pathLabel(path: PropertyKey[]): string {
  let label = "";
  for (const part of path) {
    if (typeof part === "number") label += `[${part}]`;
    else if (typeof part === "symbol") label += `[${String(part)}]`;
    else label += label ? `.${part}` : part;
  }
  return label || "Input";
}

function issueMessage(issue: z.ZodIssue): string {
  const path = pathLabel(issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => `“${key}”`).join(", ");
    return `${path} has unsupported propert${issue.keys.length === 1 ? "y" : "ies"}: ${keys}. Remove them and use only documented Phase 2 fields.`;
  }
  if (
    (issue.code === "invalid_value" || issue.code === "invalid_union") &&
    issue.path.at(-1) === "type"
  ) {
    return `${path} uses an unsupported node type. Use frame, text, rectangle, or instance.`;
  }
  if (issue.code === "invalid_type" && issue.input === undefined) return `${path} is required.`;
  if (
    issue.code === "invalid_format" &&
    (path.endsWith("color") || path.endsWith("fill") || path.endsWith("background"))
  ) {
    return `${path} must be a 6-digit hex color such as #123ABC.`;
  }
  if (issue.code === "too_small") return `${path} must be at least ${String(issue.minimum)}.`;
  if (issue.code === "too_big") return `${path} must be no more than ${String(issue.maximum)}.`;
  if (issue.code === "invalid_type") return `${path} must be ${issue.expected}.`;
  return `${path}: ${issue.message}`;
}

function checkVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version !== undefined && version !== DESIGN_SCHEMA_VERSION) {
    return `Unsupported schema version “${String(version)}”. This plugin supports ${DESIGN_SCHEMA_VERSION}.`;
  }
  return undefined;
}

function axisModes(node: { sizing?: AxisSizing }): AxisSizing {
  return node.sizing ?? { width: "fixed", height: "fixed" };
}

function collectInstanceRefs(nodes: DesignNode[], refs: string[]): void {
  for (const node of nodes) {
    if (node.type === "instance") refs.push(node.componentId);
    if (node.type === "frame") collectInstanceRefs(node.children, refs);
  }
}

function componentDependencies(component: ComponentDefinitionSpec): string[] {
  const refs: string[] = [];
  collectInstanceRefs(component.children, refs);
  return refs;
}

export function orderComponentDefinitions(
  components: ComponentDefinitionSpec[],
): ComponentDefinitionSpec[] {
  const byId = new Map(components.map((component) => [component.id, component]));
  const visited = new Set<string>();
  const ordered: ComponentDefinitionSpec[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const component = byId.get(id);
    if (!component) return;
    for (const dependency of componentDependencies(component)) visit(dependency);
    ordered.push(component);
  };
  for (const component of components) visit(component.id);
  return ordered;
}

function validateSemantics(spec: DesignSpec): string[] {
  const errors: string[] = [];
  const components = spec.document.components ?? [];
  const componentById = new Map(components.map((component) => [component.id, component]));
  const ids = new Set<string>();
  let nodeCount = 1;

  const checkLayout = (layout: LayoutSpec | undefined, path: string) => {
    if (layout?.counterAxisAlign === "baseline" && layout.mode !== "horizontal") {
      errors.push(`${path}.counterAxisAlign baseline is supported only for horizontal layouts.`);
    }
  };

  const checkNodes = (
    nodes: DesignNode[],
    parentLayout: LayoutSpec | undefined,
    parentSizing: AxisSizing,
    depth: number,
    path: string,
  ) => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const nodePath = `${path}[${index}]`;
      nodeCount++;
      if (depth > MAX_NESTING_DEPTH) {
        errors.push(`${nodePath} exceeds the maximum nesting depth of ${MAX_NESTING_DEPTH}.`);
      }

      if ((node.x === undefined) !== (node.y === undefined)) {
        errors.push(`${nodePath} must provide both x and y, or neither.`);
      }
      if (parentLayout && (node.x !== undefined || node.y !== undefined)) {
        errors.push(
          `${nodePath} uses x/y inside an Auto Layout parent. Remove positions; child order and layout control placement.`,
        );
      }
      if (!parentLayout && (node.x === undefined || node.y === undefined)) {
        errors.push(`${nodePath} requires x and y because its parent does not use Auto Layout.`);
      }

      if (
        (node.type === "rectangle" || node.type === "frame") &&
        node.cornerRadius !== undefined &&
        node.cornerRadii
      ) {
        errors.push(`${nodePath} cannot set both cornerRadius and cornerRadii.`);
      }

      const sizing = node.sizing;
      if (sizing && !parentLayout)
        errors.push(`${nodePath}.sizing requires an Auto Layout parent.`);
      if (sizing) {
        for (const axis of ["width", "height"] as const) {
          const mode = sizing[axis];
          if (mode === "fill" && parentSizing[axis] === "hug") {
            errors.push(
              `${nodePath}.sizing.${axis} cannot be fill because the parent hugs that axis.`,
            );
          }
          if (
            mode === "hug" &&
            (node.type === "rectangle" ||
              (node.type === "instance" && !componentById.get(node.componentId)?.layout) ||
              (node.type === "frame" && !node.layout))
          ) {
            errors.push(
              `${nodePath}.sizing.${axis} hug requires text or an Auto Layout frame/component.`,
            );
          }
        }
        if (node.type === "text") {
          if (sizing.width === "fixed" && node.width === undefined) {
            errors.push(`${nodePath}.width is required when sizing.width is fixed.`);
          }
          if (sizing.height === "fixed" && node.height === undefined) {
            errors.push(`${nodePath}.height is required when sizing.height is fixed.`);
          }
        }
      }

      if (parentLayout?.counterAxisAlign === "stretch") {
        const crossAxis = parentLayout.mode === "vertical" ? "width" : "height";
        if (parentSizing[crossAxis] === "hug") {
          errors.push(`${nodePath} cannot stretch because its parent hugs the counter axis.`);
        }
        if (sizing?.[crossAxis] && sizing[crossAxis] !== "fill") {
          errors.push(
            `${nodePath}.sizing.${crossAxis} conflicts with the parent's counterAxisAlign stretch.`,
          );
        }
      }

      if (node.type === "frame") {
        checkLayout(node.layout, `${nodePath}.layout`);
        checkNodes(node.children, node.layout, axisModes(node), depth + 1, `${nodePath}.children`);
      }
    }
  };

  checkLayout(spec.document.layout, "document.layout");
  checkNodes(
    spec.document.children,
    spec.document.layout,
    { width: "fixed", height: "fixed" },
    1,
    "document.children",
  );

  if (components.length > MAX_COMPONENT_COUNT) {
    errors.push(`document.components may contain at most ${MAX_COMPONENT_COUNT} definitions.`);
  }
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    nodeCount++;
    const path = `document.components[${index}]`;
    if (ids.has(component.id)) errors.push(`${path}.id “${component.id}” is duplicated.`);
    ids.add(component.id);
    checkLayout(component.layout, `${path}.layout`);
    if (component.cornerRadius !== undefined && component.cornerRadii) {
      errors.push(`${path} cannot set both cornerRadius and cornerRadii.`);
    }
    if (
      component.sizing &&
      (component.sizing.width === "hug" || component.sizing.height === "hug") &&
      !component.layout
    ) {
      errors.push(`${path}.sizing hug requires an Auto Layout component.`);
    }
    if (component.sizing?.height === "fill") {
      errors.push(
        `${path}.sizing.height cannot be fill because the generated Components area hugs its height.`,
      );
    }
    checkNodes(
      component.children,
      component.layout,
      component.sizing ?? { width: "fixed", height: "fixed" },
      1,
      `${path}.children`,
    );
  }

  const refs: string[] = [];
  collectInstanceRefs(spec.document.children, refs);
  for (const component of components) refs.push(...componentDependencies(component));
  for (const ref of refs) {
    if (!ids.has(ref)) errors.push(`Instance references missing componentId “${ref}”.`);
  }

  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string, chain: string[]) => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      errors.push(`Component reference cycle detected: ${[...chain, id].join(" → ")}.`);
      return;
    }
    state.set(id, "visiting");
    const component = components.find((item) => item.id === id);
    for (const dependency of component ? componentDependencies(component) : []) {
      if (ids.has(dependency)) visit(dependency, [...chain, id]);
    }
    state.set(id, "visited");
  };
  for (const component of components) visit(component.id, []);

  if (nodeCount > MAX_NODE_COUNT) {
    errors.push(
      `The design contains ${nodeCount} nodes; Phase 2 allows at most ${MAX_NODE_COUNT}.`,
    );
  }
  return [...new Set(errors)].slice(0, 100);
}

export function countDesignNodes(spec: DesignSpec): DesignCounts {
  const counts: DesignCounts = { frames: 1, texts: 0, rectangles: 0, components: 0, instances: 0 };
  const visit = (nodes: DesignNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") counts.texts++;
      else if (node.type === "rectangle") counts.rectangles++;
      else if (node.type === "instance") counts.instances++;
      else if (node.type === "frame") {
        counts.frames++;
        visit(node.children);
      }
    }
  };
  visit(spec.document.children);
  for (const component of spec.document.components ?? []) {
    counts.components++;
    visit(component.children);
  }
  return counts;
}

export function parseDesignValue(value: unknown): DesignParseResult {
  const versionError = checkVersion(value);
  if (versionError) return { success: false, errors: [versionError] };
  const treeLimitErrors = checkRawTreeLimits(value);
  if (treeLimitErrors.length) return { success: false, errors: treeLimitErrors };
  const parsed = DesignSchema.safeParse(value);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.map(issueMessage) };
  const semanticErrors = validateSemantics(parsed.data);
  if (semanticErrors.length) return { success: false, errors: semanticErrors };
  return { success: true, data: parsed.data };
}

function checkRawTreeLimits(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const document = (value as Record<string, unknown>).document;
  if (typeof document !== "object" || document === null || Array.isArray(document)) return [];
  const record = document as Record<string, unknown>;
  const stack: Array<{ node: unknown; depth: number; path: string }> = [];
  const components = Array.isArray(record.components) ? record.components : [];
  let count = 1;
  const seen = new WeakSet<object>();
  const errors: string[] = [];
  const addChildren = (nodes: unknown, depth: number, path: string) => {
    if (!Array.isArray(nodes)) return;
    for (let index = nodes.length - 1; index >= 0; index--) {
      stack.push({ node: nodes[index], depth, path: `${path}[${index}]` });
    }
  };

  addChildren(record.children, 1, "document.children");
  for (let index = components.length - 1; index >= 0; index--) {
    const component = components[index];
    count++;
    if (typeof component === "object" && component !== null && !Array.isArray(component)) {
      const componentRecord = component as Record<string, unknown>;
      addChildren(componentRecord.children, 1, `document.components[${index}].children`);
    }
  }

  while (stack.length && count <= MAX_NODE_COUNT) {
    const item = stack.pop()!;
    if (item.depth > MAX_NESTING_DEPTH) {
      errors.push(`${item.path} exceeds the maximum nesting depth of ${MAX_NESTING_DEPTH}.`);
      continue;
    }
    if (typeof item.node !== "object" || item.node === null || Array.isArray(item.node)) continue;
    if (seen.has(item.node)) {
      errors.push(
        `${item.path} reuses a node object; design trees must not contain cycles or shared node objects.`,
      );
      continue;
    }
    seen.add(item.node);
    count++;
    const node = item.node as Record<string, unknown>;
    if (node.type === "frame") addChildren(node.children, item.depth + 1, `${item.path}.children`);
  }
  if (count > MAX_NODE_COUNT) {
    errors.push(
      `The design contains more than ${MAX_NODE_COUNT} nodes; Phase 2 allows at most ${MAX_NODE_COUNT}.`,
    );
  }
  return [...new Set(errors)].slice(0, 100);
}

export function parseDesignText(source: string): DesignParseResult {
  if (source.length > MAX_JSON_LENGTH) {
    return {
      success: false,
      errors: [
        `JSON is larger than ${MAX_JSON_LENGTH.toLocaleString()} characters. Reduce the document size and try again.`,
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The JSON could not be parsed.";
    return { success: false, errors: [`Invalid JSON syntax: ${message}`] };
  }
  return parseDesignValue(value);
}
