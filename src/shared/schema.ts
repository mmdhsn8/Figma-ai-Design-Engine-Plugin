import { z } from "zod";
import {
  DesignSystemTokensSchema,
  TokenColorValueSchema,
  TokenReferenceSchema,
  isTokenReference,
  type DesignSystemTokens,
  type TokenReference,
} from "./design-system-schema";
import {
  VisualAssetSchema,
  VisualStyleSchema,
  type VisualAsset,
  type VisualStyle,
  type QualityRule,
  visualAssetSize,
} from "./visual-schema";
import { isFigmaPathData } from "./visual-assets";
import { DESIGN_PATTERN_IDS, type DesignPatternId } from "./design-patterns.js";

export const DESIGN_SCHEMA_VERSION = "1.0.0";
export const MAX_NESTING_DEPTH = 8;

export type SizingMode = "fixed" | "hug" | "fill";
export type AxisSizing = { width: SizingMode; height: SizingMode };
export interface DesignNodeMetadata {
  logicalRef?: string;
  pattern?: DesignPatternId;
}
export interface LayoutConstraints {
  horizontal: "left" | "right" | "center" | "left-right" | "scale";
  vertical: "top" | "bottom" | "center" | "top-bottom" | "scale";
}

export interface LayoutSpec {
  mode: "horizontal" | "vertical";
  gap?: number | TokenReference;
  padding?: {
    top?: number | TokenReference;
    right?: number | TokenReference;
    bottom?: number | TokenReference;
    left?: number | TokenReference;
  };
  primaryAxisAlign?: "start" | "center" | "end" | "space-between";
  counterAxisAlign?: "start" | "center" | "end" | "baseline" | "stretch";
}

export interface TextNodeSpec extends DesignNodeMetadata {
  type: "text";
  name: string;
  text: string;
  fontSize?: number | TokenReference;
  color: string | TokenReference;
  textStyle?: TokenReference;
  x?: number;
  y?: number;
  fontFamily?: string;
  fontStyle?: string;
  lineHeight?: number | TokenReference;
  letterSpacing?: number | TokenReference;
  textDecoration?: "none" | "underline" | "strikethrough";
  textAlign?: "left" | "center" | "right" | "justified";
  textAutoResize?: "width-and-height" | "height" | "truncate";
  width?: number;
  height?: number;
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
  visual?: VisualStyle;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  qualityExceptions?: QualityRule[];
}

export interface RectangleNodeSpec extends DesignNodeMetadata {
  type: "rectangle";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  fill: string | TokenReference;
  stroke?: { color: string | TokenReference; width?: number | TokenReference } | TokenReference;
  cornerRadius?: number | TokenReference;
  cornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
  visual?: VisualStyle;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  qualityExceptions?: QualityRule[];
}

export interface FrameNodeSpec extends DesignNodeMetadata {
  type: "frame";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  background?: string | TokenReference;
  stroke?: { color: string | TokenReference; width?: number | TokenReference } | TokenReference;
  cornerRadius?: number | TokenReference;
  cornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  children: DesignNode[];
  layout?: LayoutSpec;
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
  visual?: VisualStyle;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  qualityExceptions?: QualityRule[];
}

export interface EllipseNodeSpec extends DesignNodeMetadata {
  type: "ellipse";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  fill: string | TokenReference;
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
  visual?: VisualStyle;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  qualityExceptions?: QualityRule[];
}

export interface VectorNodeSpec extends DesignNodeMetadata {
  type: "vector";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  pathData: string;
  fill: string | TokenReference;
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
  visual?: VisualStyle;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  qualityExceptions?: QualityRule[];
}

export interface ImageNodeSpec extends DesignNodeMetadata {
  type: "image";
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  assetId: string;
  fit?: "fill" | "fit" | "crop" | "tile";
  cornerRadius?: number;
  alt?: string;
  placeholder?: boolean;
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
  visual?: VisualStyle;
  qualityRole?: "button" | "input" | "image" | "heading" | "body" | "decorative";
  qualityExceptions?: QualityRule[];
}

export interface InstanceNodeSpec extends DesignNodeMetadata {
  type: "instance";
  componentId: string;
  name?: string;
  x?: number;
  y?: number;
  sizing?: AxisSizing;
  constraints?: LayoutConstraints;
}

export type DesignNode =
  | TextNodeSpec
  | RectangleNodeSpec
  | EllipseNodeSpec
  | VectorNodeSpec
  | ImageNodeSpec
  | FrameNodeSpec
  | InstanceNodeSpec;

export interface ComponentDefinitionSpec {
  type: "component";
  id: string;
  name: string;
  key?: string;
  variant?: Record<string, string>;
  width: number;
  height: number;
  background?: string | TokenReference;
  stroke?: { color: string | TokenReference; width?: number | TokenReference } | TokenReference;
  cornerRadius?: number | TokenReference;
  cornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  children: DesignNode[];
  layout?: LayoutSpec;
  sizing?: AxisSizing;
  visual?: VisualStyle;
}

export interface DesignDocumentSpec {
  name: string;
  width: number;
  height: number;
  background: string | TokenReference;
  children: DesignNode[];
  layout?: LayoutSpec;
  components?: ComponentDefinitionSpec[];
}

export interface DesignSpec {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  designSystem?: DesignSystemTokens & { components?: ComponentDefinitionSpec[] };
  document: DesignDocumentSpec;
  assets?: VisualAsset[];
}

const nameSchema = z.string().trim().min(1).max(200);
const coordinateSchema = z.number().finite().min(-10_000).max(10_000);
const dimensionSchema = z.number().finite().min(1).max(10_000);
const radiusSchema = z.number().finite().min(0).max(5_000);
const nodeColorSchema = TokenColorValueSchema;
const nodeQualityMeta = {
  logicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u).optional(),
  pattern: z.enum(DESIGN_PATTERN_IDS).optional(),
  visual: VisualStyleSchema.optional(),
  qualityRole: z.enum(["button", "input", "image", "heading", "body", "decorative"]).optional(),
  qualityExceptions: z
    .array(
      z.enum([
        "tiny-text",
        "low-contrast",
        "small-touch-target",
        "overflow-risk",
        "duplicated-pattern",
        "missing-alt",
        "missing-asset-license",
        "spacing-variety",
        "style-variety",
        "weak-hierarchy",
        "repeated-placeholders",
      ]),
    )
    .max(10)
    .optional(),
  constraints: z
    .object({
      horizontal: z.enum(["left", "right", "center", "left-right", "scale"]),
      vertical: z.enum(["top", "bottom", "center", "top-bottom", "scale"]),
    })
    .strict()
    .optional(),
};
const layoutNumberSchema = z.union([z.number().finite().min(0).max(1_000), TokenReferenceSchema]);
const radiusValueSchema = z.union([radiusSchema, TokenReferenceSchema]);
const strokeWidthSchema = z.union([z.number().finite().min(0.25).max(100), TokenReferenceSchema]);
const textSizeSchema = z.union([z.number().finite().min(1).max(512), TokenReferenceSchema]);
const lineHeightSchema = z.union([z.number().finite().min(1).max(1_000), TokenReferenceSchema]);
const letterSpacingSchema = z.union([
  z.number().finite().min(-1_000).max(1_000),
  TokenReferenceSchema,
]);
const sizingSchema = z
  .object({
    width: z.enum(["fixed", "hug", "fill"]),
    height: z.enum(["fixed", "hug", "fill"]),
  })
  .strict();
const strokeSchema = z.union([
  z.object({ color: nodeColorSchema, width: strokeWidthSchema.optional() }).strict(),
  TokenReferenceSchema,
]);
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
    gap: layoutNumberSchema.optional(),
    padding: z
      .object({
        top: layoutNumberSchema.optional(),
        right: layoutNumberSchema.optional(),
        bottom: layoutNumberSchema.optional(),
        left: layoutNumberSchema.optional(),
      })
      .strict()
      .optional(),
    primaryAxisAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
    counterAxisAlign: z.enum(["start", "center", "end", "baseline", "stretch"]).optional(),
  })
  .strict();

const TextNodeSchema = z
  .object({
    ...nodeQualityMeta,
    type: z.literal("text"),
    name: nameSchema,
    text: z.string().max(5_000),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    fontSize: textSizeSchema.optional(),
    color: nodeColorSchema,
    textStyle: TokenReferenceSchema.optional(),
    fontFamily: z.string().trim().min(1).max(100).optional(),
    fontStyle: z.string().trim().min(1).max(100).optional(),
    lineHeight: lineHeightSchema.optional(),
    letterSpacing: letterSpacingSchema.optional(),
    textDecoration: z.enum(["none", "underline", "strikethrough"]).optional(),
    textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
    textAutoResize: z.enum(["width-and-height", "height", "truncate"]).optional(),
    width: dimensionSchema.optional(),
    height: dimensionSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict()
  .superRefine((node, context) => {
    if (node.fontSize === undefined && node.textStyle === undefined) {
      context.addIssue({
        code: "custom",
        message: "fontSize is required unless textStyle references a typography token.",
        path: ["fontSize"],
      });
    }
  });

const RectangleNodeSchema = z
  .object({
    ...nodeQualityMeta,
    type: z.literal("rectangle"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    fill: nodeColorSchema,
    stroke: strokeSchema.optional(),
    cornerRadius: radiusValueSchema.optional(),
    cornerRadii: cornerRadiiSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

const EllipseNodeSchema = z
  .object({
    ...nodeQualityMeta,
    type: z.literal("ellipse"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    fill: nodeColorSchema,
    sizing: sizingSchema.optional(),
  })
  .strict();

const vectorPathDataSchema = z
  .string()
  .min(3)
  .max(8_192)
  .refine(isFigmaPathData, "Use only bounded absolute M/L/Q/C/Z path data supported by Figma.");

const VectorNodeSchema = z
  .object({
    ...nodeQualityMeta,
    type: z.literal("vector"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    pathData: vectorPathDataSchema,
    fill: nodeColorSchema,
    sizing: sizingSchema.optional(),
  })
  .strict();

const ImageNodeSchema = z
  .object({
    ...nodeQualityMeta,
    type: z.literal("image"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    assetId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/),
    fit: z.enum(["fill", "fit", "crop", "tile"]).optional(),
    cornerRadius: radiusSchema.optional(),
    alt: z.string().trim().max(300).optional(),
    placeholder: z.boolean().optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

const InstanceNodeSchema = z
  .object({
    logicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u).optional(),
    pattern: z.enum(DESIGN_PATTERN_IDS).optional(),
    type: z.literal("instance"),
    componentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/),
    name: nameSchema.optional(),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    sizing: sizingSchema.optional(),
    constraints: z
      .object({
        horizontal: z.enum(["left", "right", "center", "left-right", "scale"]),
        vertical: z.enum(["top", "bottom", "center", "top-bottom", "scale"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DesignNodeSchema: z.ZodType<DesignNode> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      TextNodeSchema,
      RectangleNodeSchema,
      EllipseNodeSchema,
      VectorNodeSchema,
      ImageNodeSchema,
      FrameNodeSchema,
      InstanceNodeSchema,
    ]) as z.ZodType<DesignNode>,
);

const FrameNodeSchema = z
  .object({
    ...nodeQualityMeta,
    type: z.literal("frame"),
    name: nameSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    background: nodeColorSchema.optional(),
    stroke: strokeSchema.optional(),
    cornerRadius: radiusValueSchema.optional(),
    cornerRadii: cornerRadiiSchema.optional(),
    children: z.array(DesignNodeSchema),
    layout: LayoutSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

export const ComponentDefinitionSchema: z.ZodType<ComponentDefinitionSpec> = z
  .object({
    visual: VisualStyleSchema.optional(),
    type: z.literal("component"),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/),
    name: nameSchema,
    key: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/)
      .optional(),
    variant: z
      .record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(100))
      .optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    background: nodeColorSchema.optional(),
    stroke: strokeSchema.optional(),
    cornerRadius: radiusValueSchema.optional(),
    cornerRadii: cornerRadiiSchema.optional(),
    children: z.array(DesignNodeSchema),
    layout: LayoutSchema.optional(),
    sizing: sizingSchema.optional(),
  })
  .strict();

export const DesignSystemSchema = DesignSystemTokensSchema.extend({
  components: z.array(ComponentDefinitionSchema).optional(),
});

export const DesignSchema: z.ZodType<DesignSpec> = z
  .object({
    schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
    assets: z.array(VisualAssetSchema).max(20).optional(),
    designSystem: DesignSystemSchema.optional(),
    document: z
      .object({
        name: nameSchema,
        width: dimensionSchema,
        height: dimensionSchema,
        background: nodeColorSchema,
        children: z.array(DesignNodeSchema),
        layout: LayoutSchema.optional(),
        components: z.array(ComponentDefinitionSchema).optional(),
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
  ellipses?: number;
  vectors?: number;
  images?: number;
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
    return `${path} has unsupported node type field(s) or unsupported property/properties: ${keys}. Use a supported node type (frame, text, rectangle, ellipse, vector, image, instance) and documented properties.`;
  }
  if (
    (issue.code === "invalid_value" || issue.code === "invalid_union") &&
    issue.path.at(-1) === "type"
  ) {
    return `${path} uses an unsupported node type. Use frame, text, rectangle, ellipse, vector, image, or instance.`;
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

type TokenCategory = "color" | "typography" | "spacing" | "radius" | "border";

function expectedTokenCategory(key: string): TokenCategory | undefined {
  const prefix = key.split(".")[0];
  if (prefix === "color") return "color";
  if (prefix === "typography") return "typography";
  if (prefix === "spacing") return "spacing";
  if (prefix === "radius") return "radius";
  if (prefix === "border") return "border";
  return undefined;
}

function validateDesignSystemReferences(spec: DesignSpec): string[] {
  const system = spec.designSystem;
  if (!system) return [];

  const errors: string[] = [];
  const categories = new Map<string, TokenCategory>();
  const numericTokenValues = new Map<string, number | TokenReference>();
  const addTokens = (entries: Record<string, unknown>, category: TokenCategory, path: string) => {
    for (const key of Object.keys(entries)) {
      if (expectedTokenCategory(key) !== category) {
        errors.push(`${path}.${key} must use the “${category}.” token prefix.`);
      }
      if (categories.has(key)) {
        errors.push(`Design system token “${key}” is declared more than once.`);
      } else {
        categories.set(key, category);
      }
    }
  };

  addTokens(system.colors, "color", "designSystem.colors");
  addTokens(system.typography, "typography", "designSystem.typography");
  addTokens(system.spacing?.aliases ?? {}, "spacing", "designSystem.spacing.aliases");
  for (const [key, value] of Object.entries(system.spacing?.aliases ?? {})) {
    numericTokenValues.set(key, value);
  }
  system.spacing?.scale.forEach((value, index) => {
    const key = `spacing.scale.${index}`;
    if (categories.has(key))
      errors.push(`Design system token “${key}” is declared more than once.`);
    else categories.set(key, "spacing");
    numericTokenValues.set(key, value);
  });
  addTokens(system.radii?.aliases ?? {}, "radius", "designSystem.radii.aliases");
  for (const [key, value] of Object.entries(system.radii?.aliases ?? {})) {
    numericTokenValues.set(key, value);
  }
  system.radii?.scale.forEach((value, index) => {
    const key = `radius.scale.${index}`;
    if (categories.has(key))
      errors.push(`Design system token “${key}” is declared more than once.`);
    else categories.set(key, "radius");
    numericTokenValues.set(key, value);
  });
  addTokens(system.borders, "border", "designSystem.borders");

  const checkReference = (value: unknown, expected: TokenCategory, path: string) => {
    if (!isTokenReference(value)) return;
    const actual = categories.get(value.token);
    if (!actual) {
      errors.push(`${path} references missing token “${value.token}”.`);
    } else if (actual !== expected) {
      errors.push(
        `${path} expects a ${expected} token, but “${value.token}” is a ${actual} token.`,
      );
    }
  };

  const resolveNumericToken = (
    key: string,
    category: "spacing" | "radius",
    trail: string[] = [],
  ): number | undefined => {
    if (trail.includes(key)) return undefined;
    const value = numericTokenValues.get(key);
    if (typeof value === "number") return value;
    if (!value || !isTokenReference(value) || expectedTokenCategory(value.token) !== category) {
      return undefined;
    }
    return resolveNumericToken(value.token, category, [...trail, key]);
  };
  const checkNumericRange = (
    value: unknown,
    category: "spacing" | "radius",
    min: number,
    max: number,
    path: string,
  ) => {
    if (!isTokenReference(value)) return;
    const resolved = resolveNumericToken(value.token, category);
    if (resolved !== undefined && (resolved < min || resolved > max)) {
      errors.push(
        `${path} token “${value.token}” resolves to ${resolved}, outside the supported range ${min}–${max}.`,
      );
    }
  };

  const aliases = new Map<string, string>();
  for (const [key, value] of Object.entries(system.colors)) {
    if (isTokenReference(value)) aliases.set(key, value.token);
    checkReference(value, "color", `designSystem.colors.${key}`);
  }
  for (const [key, value] of Object.entries(system.spacing?.aliases ?? {})) {
    if (isTokenReference(value)) aliases.set(key, value.token);
    checkReference(value, "spacing", `designSystem.spacing.aliases.${key}`);
  }
  for (const [key, value] of Object.entries(system.radii?.aliases ?? {})) {
    if (isTokenReference(value)) aliases.set(key, value.token);
    checkReference(value, "radius", `designSystem.radii.aliases.${key}`);
  }
  for (const [key, style] of Object.entries(system.typography)) {
    const path = `designSystem.typography.${key}`;
    checkReference(style.fontSize, "spacing", `${path}.fontSize`);
    checkNumericRange(style.fontSize, "spacing", 1, 512, `${path}.fontSize`);
    checkReference(style.lineHeight, "spacing", `${path}.lineHeight`);
    checkNumericRange(style.lineHeight, "spacing", 1, 1_000, `${path}.lineHeight`);
    checkReference(style.letterSpacing, "spacing", `${path}.letterSpacing`);
    checkNumericRange(style.letterSpacing, "spacing", -1_000, 1_000, `${path}.letterSpacing`);
  }
  for (const [key, border] of Object.entries(system.borders)) {
    checkReference(border.color, "color", `designSystem.borders.${key}.color`);
    checkReference(border.width, "spacing", `designSystem.borders.${key}.width`);
    checkNumericRange(border.width, "spacing", 0.25, 100, `designSystem.borders.${key}.width`);
  }

  const state = new Map<string, "visiting" | "visited">();
  const visitAlias = (key: string, trail: string[]) => {
    if (state.get(key) === "visited") return;
    if (state.get(key) === "visiting") {
      errors.push(`Token alias cycle detected: ${[...trail, key].join(" → ")}.`);
      return;
    }
    state.set(key, "visiting");
    const target = aliases.get(key);
    if (target && aliases.has(target)) visitAlias(target, [...trail, key]);
    state.set(key, "visited");
  };
  for (const key of aliases.keys()) visitAlias(key, []);

  const checkColor = (value: unknown, path: string) => checkReference(value, "color", path);
  const checkNumber = (value: unknown, category: "spacing" | "radius", path: string) =>
    checkReference(value, category, path);
  const checkStroke = (value: unknown, path: string) => {
    if (isTokenReference(value)) {
      checkReference(value, "border", path);
    } else if (typeof value === "object" && value !== null) {
      const stroke = value as { color?: unknown; width?: unknown };
      checkColor(stroke.color, `${path}.color`);
      checkNumber(stroke.width, "spacing", `${path}.width`);
      checkNumericRange(stroke.width, "spacing", 0.25, 100, `${path}.width`);
    }
  };
  const checkLayoutRefs = (layout: LayoutSpec | undefined, path: string) => {
    if (!layout) return;
    checkNumber(layout.gap, "spacing", `${path}.gap`);
    for (const [side, value] of Object.entries(layout.padding ?? {})) {
      checkNumber(value, "spacing", `${path}.padding.${side}`);
    }
  };
  const checkVisual = (visual: VisualStyle | undefined, path: string) => {
    if (!visual) return;
    visual.fills?.forEach((fill, index) => {
      const fillPath = `${path}.fills[${index}]`;
      if (fill.type === "solid") checkColor(fill.color, `${fillPath}.color`);
      else
        fill.stops.forEach((stop, stopIndex) =>
          checkColor(stop.color, `${fillPath}.stops[${stopIndex}].color`),
        );
    });
    visual.strokes?.forEach((stroke, index) =>
      checkColor(stroke.color, `${path}.strokes[${index}].color`),
    );
    visual.effects?.forEach((effect, index) => {
      if (effect.type === "drop-shadow" || effect.type === "inner-shadow") {
        checkColor(effect.color, `${path}.effects[${index}].color`);
      }
    });
  };
  const checkNodes = (nodes: DesignNode[], path: string) => {
    nodes.forEach((node, index) => {
      const nodePath = `${path}[${index}]`;
      checkVisual("visual" in node ? node.visual : undefined, `${nodePath}.visual`);
      if (node.type === "text") {
        checkColor(node.color, `${nodePath}.color`);
        checkNumber(node.fontSize, "spacing", `${nodePath}.fontSize`);
        checkNumericRange(node.fontSize, "spacing", 1, 512, `${nodePath}.fontSize`);
        checkNumber(node.lineHeight, "spacing", `${nodePath}.lineHeight`);
        checkNumericRange(node.lineHeight, "spacing", 1, 1_000, `${nodePath}.lineHeight`);
        checkNumber(node.letterSpacing, "spacing", `${nodePath}.letterSpacing`);
        checkReference(node.textStyle, "typography", `${nodePath}.textStyle`);
      } else if (node.type === "rectangle") {
        checkColor(node.fill, `${nodePath}.fill`);
        checkStroke(node.stroke, `${nodePath}.stroke`);
        checkNumber(node.cornerRadius, "radius", `${nodePath}.cornerRadius`);
        checkNumericRange(node.cornerRadius, "radius", 0, 5_000, `${nodePath}.cornerRadius`);
      } else if (node.type === "ellipse" || node.type === "vector") {
        checkColor(node.fill, `${nodePath}.fill`);
      } else if (node.type === "image") {
        // Asset id existence is validated after all trees have been visited.
      } else if (node.type === "frame") {
        checkColor(node.background, `${nodePath}.background`);
        checkStroke(node.stroke, `${nodePath}.stroke`);
        checkNumber(node.cornerRadius, "radius", `${nodePath}.cornerRadius`);
        checkNumericRange(node.cornerRadius, "radius", 0, 5_000, `${nodePath}.cornerRadius`);
        checkLayoutRefs(node.layout, `${nodePath}.layout`);
        checkNodes(node.children, `${nodePath}.children`);
      }
    });
  };

  checkColor(spec.document.background, "document.background");
  checkLayoutRefs(spec.document.layout, "document.layout");
  checkNodes(spec.document.children, "document.children");
  for (const [index, component] of [
    ...(spec.document.components ?? []),
    ...(system.components ?? []),
  ].entries()) {
    checkVisual(component.visual, `components[${index}].visual`);
    checkColor(component.background, `components[${index}].background`);
    checkStroke(component.stroke, `components[${index}].stroke`);
    checkNumber(component.cornerRadius, "radius", `components[${index}].cornerRadius`);
    checkNumericRange(
      component.cornerRadius,
      "radius",
      0,
      5_000,
      `components[${index}].cornerRadius`,
    );
    checkLayoutRefs(component.layout, `components[${index}].layout`);
    checkNodes(component.children, `components[${index}].children`);
  }

  return [...new Set(errors)].slice(0, 100);
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
  const components = [
    ...(spec.document.components ?? []),
    ...(spec.designSystem?.components ?? []),
  ];
  const componentById = new Map(components.map((component) => [component.id, component]));
  const ids = new Set<string>();
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
      const sizing = node.sizing;
      if ("constraints" in node && node.constraints && parentLayout) {
        errors.push(
          `${nodePath}.constraints can only be used with absolute positioning inside a non-auto-layout frame.`,
        );
      }
      if ("constraints" in node && node.constraints && sizing) {
        errors.push(`${nodePath}.constraints cannot be combined with Auto Layout sizing.`);
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
              node.type === "ellipse" ||
              node.type === "vector" ||
              node.type === "image" ||
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

  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    const legacyComponentCount = spec.document.components?.length ?? 0;
    const path =
      index < legacyComponentCount
        ? `document.components[${index}]`
        : `designSystem.components[${index - legacyComponentCount}]`;
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

  const componentKeys = new Set<string>();
  for (const [index, component] of (spec.designSystem?.components ?? []).entries()) {
    if (!component.key) {
      errors.push(`designSystem.components[${index}].key is required for stable ownership.`);
    } else if (componentKeys.has(component.key)) {
      errors.push(`Design system component key “${component.key}” is duplicated.`);
    } else {
      componentKeys.add(component.key);
    }
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

  const assetById = new Map<string, VisualAsset>();
  let assetBytes = 0;
  for (const [index, asset] of (spec.assets ?? []).entries()) {
    const assetPath = `assets[${index}]`;
    if (assetById.has(asset.id)) errors.push(`${assetPath}.id “${asset.id}” is duplicated.`);
    else assetById.set(asset.id, asset);
    assetBytes += visualAssetSize(asset);
    if (
      asset.kind === "svg-paths" &&
      asset.paths.reduce((total, path) => total + path.data.length, 0) > 40_000
    ) {
      errors.push(`${assetPath}.paths exceeds the 40 KB total vector path limit.`);
    }
  }
  if (assetBytes > 700 * 1_024) {
    errors.push(
      "Embedded visual assets exceed the total 700 KiB limit. Import fewer or smaller files.",
    );
  }
  const checkAssetRefs = (nodes: DesignNode[], path: string) => {
    nodes.forEach((node, index) => {
      const nodePath = `${path}[${index}]`;
      if (node.type === "image" && !assetById.has(node.assetId)) {
        errors.push(`${nodePath}.assetId references missing asset “${node.assetId}”.`);
      }
      if (node.type === "frame") checkAssetRefs(node.children, `${nodePath}.children`);
    });
  };
  checkAssetRefs(spec.document.children, "document.children");
  for (const [index, component] of components.entries()) {
    const documentComponentCount = spec.document.components?.length ?? 0;
    const path =
      index < documentComponentCount
        ? `document.components[${index}].children`
        : `designSystem.components[${index - documentComponentCount}].children`;
    checkAssetRefs(component.children, path);
  }

  errors.push(...validateDesignSystemReferences(spec));
  return [...new Set(errors)].slice(0, 100);
}

export function countDesignNodes(spec: DesignSpec): DesignCounts {
  const counts: DesignCounts = { frames: 1, texts: 0, rectangles: 0, components: 0, instances: 0 };
  const increment = (kind: keyof DesignCounts) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  const assets = new Map((spec.assets ?? []).map((asset) => [asset.id, asset]));
  const visit = (nodes: DesignNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") counts.texts++;
      else if (node.type === "rectangle") counts.rectangles++;
      else if (node.type === "ellipse") increment("ellipses");
      else if (node.type === "vector") increment("vectors");
      else if (node.type === "image") {
        const asset = assets.get(node.assetId);
        if (asset?.kind === "svg-paths") {
          counts.frames++;
          increment("vectors");
          for (let index = 1; index < asset.paths.length; index++) increment("vectors");
        } else increment("images");
      } else if (node.type === "instance") counts.instances++;
      else if (node.type === "frame") {
        counts.frames++;
        visit(node.children);
      }
    }
  };
  visit(spec.document.children);
  for (const component of [
    ...(spec.document.components ?? []),
    ...(spec.designSystem?.components ?? []),
  ]) {
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
  const rawDesignSystem = (value as Record<string, unknown>).designSystem;
  const systemComponents =
    typeof rawDesignSystem === "object" && rawDesignSystem !== null
      ? (rawDesignSystem as Record<string, unknown>).components
      : undefined;
  const seen = new WeakSet<object>();
  const errors: string[] = [];
  const visit = (nodes: unknown, depth: number, path: string) => {
    if (!Array.isArray(nodes)) return;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const nodePath = `${path}[${index}]`;
      if (depth > MAX_NESTING_DEPTH) {
        if (errors.length < 100) {
          errors.push(`${nodePath} exceeds the maximum nesting depth of ${MAX_NESTING_DEPTH}.`);
        }
        continue;
      }
      if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
      if (seen.has(node)) {
        if (errors.length < 100) {
          errors.push(
            `${nodePath} reuses a node object; design trees must not contain cycles or shared node objects.`,
          );
        }
        continue;
      }
      seen.add(node);
      if ((node as Record<string, unknown>).type === "frame") {
        visit((node as Record<string, unknown>).children, depth + 1, `${nodePath}.children`);
      }
    }
  };

  visit(record.children, 1, "document.children");
  for (const [source, definitions] of [
    ["document.components", record.components],
    ["designSystem.components", systemComponents],
  ] as const) {
    if (!Array.isArray(definitions)) continue;
    for (let index = 0; index < definitions.length; index++) {
      const component = definitions[index];
      if (typeof component === "object" && component !== null && !Array.isArray(component)) {
        visit((component as Record<string, unknown>).children, 1, `${source}[${index}].children`);
      }
    }
  }
  return [...new Set(errors)];
}

export function parseDesignText(source: string): DesignParseResult {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The JSON could not be parsed.";
    return { success: false, errors: [`Invalid JSON syntax: ${message}`] };
  }
  const duplicateKeyErrors = findDuplicateJsonKeys(source);
  if (duplicateKeyErrors.length) return { success: false, errors: duplicateKeyErrors };
  return parseDesignValue(value);
}

export function findDuplicateJsonKeys(source: string): string[] {
  let cursor = 0;
  const errors: string[] = [];
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] ?? "")) cursor++;
  };
  const readString = (): string => {
    const start = cursor;
    cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
      } else if (source[cursor] === '"') {
        cursor++;
        break;
      } else {
        cursor++;
      }
    }
    return JSON.parse(source.slice(start, cursor)) as string;
  };
  const parseValue = (path: string): void => {
    skipWhitespace();
    const next = source[cursor];
    if (next === "{") {
      cursor++;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        skipWhitespace();
        const key = readString();
        const keyPath = path ? `${path}.${key}` : key;
        if (keys.has(key)) errors.push(`Duplicate JSON key at “${keyPath}”.`);
        else keys.add(key);
        skipWhitespace();
        cursor++;
        parseValue(keyPath);
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor++;
          break;
        }
        cursor++;
      }
      return;
    }
    if (next === "[") {
      cursor++;
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor++;
        return;
      }
      let index = 0;
      while (cursor < source.length) {
        parseValue(`${path}[${index++}]`);
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor++;
          break;
        }
        cursor++;
      }
      return;
    }
    if (next === '"') {
      readString();
      return;
    }
    while (
      cursor < source.length &&
      source[cursor] !== "," &&
      source[cursor] !== "]" &&
      source[cursor] !== "}" &&
      !/\s/.test(source[cursor])
    ) {
      cursor++;
    }
  };

  parseValue("");
  return [...new Set(errors)].slice(0, 100);
}
