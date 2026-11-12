import { z } from "zod";
import { MAX_GENERATED_NODES } from "./generation-limits.js";
import { DESIGN_ICON_PATHS, type DesignIconName } from "./design-icons.js";
import {
  DESIGN_PATTERN_IDS,
  inferPatternsForScreen,
  inferRequestedDesignPatterns,
  type DesignPatternId,
} from "./design-patterns.js";

export const DESIGN_BRIEF_VERSION = 1 as const;
export const VISUAL_DESIGN_SPEC_VERSION = 1 as const;

export const DesignFidelitySchema = z.enum(["wireframe", "standard", "high_fidelity"]);
export type DesignFidelity = z.infer<typeof DesignFidelitySchema>;
export const DesignDomainSchema = z.enum([
  "commerce",
  "dashboard",
  "saas",
  "education",
  "onboarding",
  "productivity",
  "finance",
  "health",
  "social",
  "portfolio",
  "travel",
  "media",
  "content",
  "product",
]);
export type DesignDomain = z.infer<typeof DesignDomainSchema>;

export const DesignBriefSchema = z
  .object({
    version: z.literal(DESIGN_BRIEF_VERSION),
    prompt: z.string().trim().min(10).max(8_000),
    fidelity: DesignFidelitySchema,
    domain: DesignDomainSchema,
    audience: z.string().trim().min(1).max(160),
    platform: z.enum(["mobile", "desktop", "responsive", "web"]),
    locale: z.enum(["fa", "en"]),
    direction: z.enum(["rtl", "ltr"]),
    brandDirection: z.string().trim().max(240),
    requestedPatterns: z.array(z.enum(DESIGN_PATTERN_IDS)).max(18),
    assetPolicy: z.literal("provided-or-document-assets; otherwise-labeled-native-placeholder"),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(240)).min(3).max(10),
  })
  .strict();
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

const logicalRef = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u);
const VisualNodeSchema = z
  .object({
    logicalRef,
    parentRef: logicalRef.optional(),
    sourcePath: z.string().max(240),
    nodeType: z.enum(["frame", "rectangle", "ellipse", "text", "icon", "image"]),
    nativeType: z.enum(["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "VECTOR"]),
    name: z.string().trim().min(1).max(200),
    qualityRole: z.enum(["button", "input", "image", "heading", "body", "decorative"]),
    pattern: z.enum(DESIGN_PATTERN_IDS).optional(),
    width: z.number().finite().positive().max(10_000),
    height: z.number().finite().positive().max(10_000),
    layout: z.enum(["none", "vertical", "horizontal"]),
    padding: z.number().finite().min(0).max(100),
    gap: z.number().finite().min(0).max(100),
    paletteRole: z.enum(["brand", "accent", "page", "surface", "text", "muted", "border", "none"]),
    text: z.string().max(5_000).optional(),
    typography: z
      .object({
        family: z.string().trim().min(1).max(100).optional(),
        style: z.enum(["Regular", "Medium", "Bold"]),
        size: z.number().finite().min(8).max(96),
        lineHeight: z.number().finite().positive().optional(),
        letterSpacing: z.number().finite().optional(),
        alignment: z.enum(["left", "center", "right"]),
      })
      .strict()
      .optional(),
    iconName: z.string().max(30).optional(),
    placeholder: z.boolean().optional(),
  })
  .strict();
export type VisualDesignNodeSpec = z.infer<typeof VisualNodeSchema>;

export const VisualDesignSpecSchema = z
  .object({
    version: z.literal(VISUAL_DESIGN_SPEC_VERSION),
    brief: DesignBriefSchema,
    screen: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
        name: z.string().trim().min(1).max(120),
        width: z.number().int().min(320).max(5_000),
        height: z.number().int().min(320).max(5_000),
        backgroundRole: z.enum(["page", "surface", "brand", "accent", "custom"]),
        safeArea: z
          .object({
            top: z.number().min(0),
            right: z.number().min(0),
            bottom: z.number().min(0),
            left: z.number().min(0),
          })
          .strict(),
        grid: z
          .object({
            columns: z.number().int().min(1).max(24),
            gutter: z.number().min(0).max(128),
            margin: z.number().min(0).max(256),
          })
          .strict(),
      })
      .strict(),
    tokens: z
      .object({
        brand: z.string().regex(/^#[\da-f]{6}$/iu),
        accent: z.string().regex(/^#[\da-f]{6}$/iu),
        page: z.string().regex(/^#[\da-f]{6}$/iu),
        surface: z.string().regex(/^#[\da-f]{6}$/iu),
        text: z.string().regex(/^#[\da-f]{6}$/iu),
        muted: z.string().regex(/^#[\da-f]{6}$/iu),
        border: z.string().regex(/^#[\da-f]{6}$/iu),
        spacing: z.array(z.number().min(0).max(128)).min(3).max(8),
        radii: z.array(z.number().min(0).max(128)).min(2).max(6),
      })
      .strict(),
    nodes: z.array(VisualNodeSchema).max(MAX_GENERATED_NODES),
    requiredPatterns: z.array(z.enum(DESIGN_PATTERN_IDS)).max(18),
    usedPatterns: z.array(z.enum(DESIGN_PATTERN_IDS)).max(18),
    imagePlaceholders: z
      .array(
        z
          .object({ ref: logicalRef, name: z.string().max(200), disclosure: z.string().max(120) })
          .strict(),
      )
      .max(500),
    nativeAssertions: z.array(z.string().trim().min(1).max(240)).min(2).max(12),
  })
  .strict();
export type VisualDesignSpec = z.infer<typeof VisualDesignSpecSchema>;

export interface VisualSpecSourceNode {
  type: "frame" | "rectangle" | "ellipse" | "text" | "icon" | "image";
  name: string;
  text: string | null;
  width: number;
  height: number;
  fontSize: number;
  fontStyle: "Regular" | "Medium" | "Bold";
  textAlign: "left" | "center" | "right";
  fontFamily?: string;
  lineHeight?: number;
  letterSpacing?: number;
  palette: "brand" | "accent" | "page" | "surface" | "text" | "muted" | "border" | "none";
  layout: "none" | "vertical" | "horizontal";
  padding: number;
  gap: number;
  qualityRole: "button" | "input" | "image" | "heading" | "body" | "decorative";
  pattern?: DesignPatternId;
  iconName?: string;
  placeholder?: true;
  sectionId?: "identity" | "primary" | "supporting";
  children: VisualSpecSourceNode[];
}

export interface VisualDesignPalette {
  brand: string;
  accent: string;
  page: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
}

export function createVisualDesignSpec(input: {
  brief: DesignBrief;
  screen: {
    id: string;
    name: string;
    familyName: string;
    width: number;
    height: number;
    devicePreset: "mobile" | "desktop";
  };
  projectScreenCount: number;
  requiredPatterns?: readonly DesignPatternId[];
  requireHighFidelityStructure?: boolean;
  palette: VisualDesignPalette;
  children: readonly VisualSpecSourceNode[];
}): { success: true; data: VisualDesignSpec } | { success: false; errors: string[] } {
  const nodes: VisualDesignNodeSpec[] = [];
  const usedPatterns = new Set<DesignPatternId>();
  const imagePlaceholders: VisualDesignSpec["imagePlaceholders"] = [];
  const rootRef = `${input.screen.id}.root`;
  nodes.push({
    logicalRef: rootRef,
    sourcePath: "screen",
    nodeType: "frame",
    nativeType: "FRAME",
    name: input.screen.name,
    qualityRole: "decorative",
    width: input.screen.width,
    height: input.screen.height,
    layout: "vertical",
    padding: 20,
    gap: 16,
    paletteRole: "page",
  });
  const visit = (node: VisualSpecSourceNode, path: string, parentRef: string): void => {
    const ref = `${input.screen.id}.${path.replaceAll("/", ".")}`;
    const interactiveText =
      node.type === "text" && (node.qualityRole === "button" || node.qualityRole === "input");
    const nativeType: VisualDesignNodeSpec["nativeType"] = interactiveText
      ? "FRAME"
      : node.type === "text"
        ? "TEXT"
        : node.type === "rectangle"
          ? "RECTANGLE"
          : node.type === "ellipse"
            ? "ELLIPSE"
            : node.type === "icon"
              ? "VECTOR"
              : "FRAME";
    nodes.push({
      logicalRef: ref,
      parentRef,
      sourcePath: path,
      nodeType: interactiveText ? "frame" : node.type,
      nativeType,
      name: node.name,
      qualityRole: node.qualityRole,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      width: node.width,
      height: node.height,
      layout: node.type === "frame" ? node.layout : node.type === "image" ? "vertical" : "none",
      padding: node.padding,
      gap: node.gap,
      paletteRole: node.palette,
      ...(node.type === "text" && !interactiveText
        ? {
            text: node.text ?? "",
            typography: {
              ...(node.fontFamily ? { family: node.fontFamily } : {}),
              style: node.fontStyle,
              size: node.fontSize,
              ...(node.lineHeight ? { lineHeight: node.lineHeight } : {}),
              ...(node.letterSpacing !== undefined ? { letterSpacing: node.letterSpacing } : {}),
              alignment: node.textAlign,
            },
          }
        : {}),
      ...(node.type === "icon" && node.iconName ? { iconName: node.iconName } : {}),
      ...(node.type === "image" ? { placeholder: true } : {}),
    });
    if (node.pattern) usedPatterns.add(node.pattern);
    if (interactiveText) {
      const labelRef = `${ref}.label`;
      nodes.push({
        logicalRef: labelRef,
        parentRef: ref,
        sourcePath: `${path}.label`,
        nodeType: "text",
        nativeType: "TEXT",
        name: `${node.name} label`,
        qualityRole: "body",
        width: node.width,
        height: node.height,
        layout: "none",
        padding: 0,
        gap: 0,
        paletteRole: node.palette,
        text: node.text ?? "",
        typography: {
          ...(node.fontFamily ? { family: node.fontFamily } : {}),
          style: node.fontStyle,
          size: node.fontSize,
          ...(node.lineHeight ? { lineHeight: node.lineHeight } : {}),
          ...(node.letterSpacing !== undefined ? { letterSpacing: node.letterSpacing } : {}),
          alignment: input.brief.direction === "rtl" ? "right" : node.textAlign,
        },
      });
    }
    if (node.type === "image") {
      const illustrationRef = `${ref}.illustration`;
      const illustrationSize = Math.min(36, Math.max(20, node.width - 16));
      nodes.push({
        logicalRef: illustrationRef,
        parentRef: ref,
        sourcePath: `${path}.placeholder-illustration`,
        nodeType: "ellipse",
        nativeType: "ELLIPSE",
        name: "Editable illustration placeholder",
        qualityRole: "decorative",
        width: illustrationSize,
        height: illustrationSize,
        layout: "none",
        padding: 0,
        gap: 0,
        paletteRole: "accent",
      });
      const disclosure =
        input.brief.locale === "fa"
          ? "جایگاه تصویر · عکس واقعی نیست"
          : "Image placeholder · not a real photo";
      const disclosureRef = `${ref}.disclosure`;
      nodes.push({
        logicalRef: disclosureRef,
        parentRef: ref,
        sourcePath: `${path}.placeholder-disclosure`,
        nodeType: "text",
        nativeType: "TEXT",
        name: "Image placeholder disclosure",
        qualityRole: "body",
        width: Math.max(1, Math.min(node.width - 16, 260)),
        height: 18,
        layout: "none",
        padding: 0,
        gap: 0,
        paletteRole: "muted",
        text: disclosure,
        typography: {
          style: "Regular",
          size: 10,
          alignment: input.brief.direction === "rtl" ? "right" : "left",
        },
      });
      imagePlaceholders.push({ ref, name: node.name, disclosure });
    }
    const canContain = node.type === "frame" || node.type === "image";
    if (node.children.length && !canContain) return;
    node.children.forEach((child, index) => visit(child, `${path}/n${index}`, ref));
  };
  input.children.forEach((node, index) =>
    visit(node, `${node.sectionId ?? "main"}/n${index}`, rootRef),
  );
  const used = [...usedPatterns];
  const spec: VisualDesignSpec = {
    version: VISUAL_DESIGN_SPEC_VERSION,
    brief: input.brief,
    screen: {
      id: input.screen.id,
      name: input.screen.name,
      width: input.screen.width,
      height: input.screen.height,
      backgroundRole: "page",
      safeArea:
        input.screen.devicePreset === "mobile"
          ? { top: 24, right: 20, bottom: 24, left: 20 }
          : { top: 32, right: 32, bottom: 32, left: 32 },
      grid:
        input.screen.devicePreset === "mobile"
          ? { columns: 4, gutter: 12, margin: 20 }
          : { columns: 12, gutter: 24, margin: 32 },
    },
    tokens: { ...input.palette, spacing: [4, 8, 12, 16, 24, 32], radii: [4, 8, 12, 20] },
    nodes,
    requiredPatterns: [
      ...(input.requiredPatterns ??
        inferPatternsForScreen(
          input.brief.prompt,
          input.brief.domain,
          input.screen.familyName,
          input.projectScreenCount,
          input.brief.fidelity === "high_fidelity",
        )),
    ],
    usedPatterns: used,
    imagePlaceholders,
    nativeAssertions: [
      ...input.brief.acceptanceCriteria,
      "Confirm the existing screen identity and every declared logical reference with a fresh native read.",
      "Report zero canvas mutations only for an inspection or an actually verified no-op.",
    ],
  };
  const result = validateVisualDesignSpec(spec);
  if (
    !result.success ||
    input.requireHighFidelityStructure === false ||
    input.brief.fidelity !== "high_fidelity"
  )
    return result;
  const content = result.data.nodes.filter(
    (node) => node.logicalRef !== rootRef && !node.sourcePath.endsWith("placeholder-disclosure"),
  );
  const hasNestedContentFrame = content.some(
    (node) =>
      node.nodeType === "frame" &&
      result.data.nodes.some((child) => child.parentRef === node.logicalRef),
  );
  const hasHeading = content.some(
    (node) => node.nodeType === "text" && node.qualityRole === "heading",
  );
  const hasVisualRegion = content.some(
    (node) =>
      node.nodeType === "image" ||
      node.nodeType === "icon" ||
      node.nodeType === "rectangle" ||
      Boolean(node.pattern),
  );
  const compositionErrors = [
    ...(!hasNestedContentFrame
      ? [
          "High-fidelity layout needs at least one grouped native content region; a flat text list is not sufficient.",
        ]
      : []),
    ...(!hasHeading
      ? [
          "High-fidelity layout needs a text layer identified as the screen's heading so hierarchy can be verified.",
        ]
      : []),
    ...(!hasVisualRegion
      ? [
          "High-fidelity layout needs at least one purposeful visual region or tagged composition pattern; use an editable layer or labeled image placeholder.",
        ]
      : []),
  ];
  return compositionErrors.length ? { success: false, errors: compositionErrors } : result;
}

export function inferDesignDomain(
  prompt: string,
  legacyType: "storefront" | "dashboard" | "product",
): DesignDomain {
  if (legacyType === "storefront") return "commerce";
  const patterns: Array<[DesignDomain, RegExp]> = [
    ["education", /education|learning|course|classroom|آموزش|یادگیری|دوره/iu],
    ["onboarding", /onboarding|welcome flow|شروع به کار|معارفه/iu],
    ["finance", /finance|bank|wallet|budget|مالی|بانک|کیف پول|بودجه/iu],
    ["health", /health|medical|clinic|wellness|سلامت|پزشکی|درمان/iu],
    ["social", /social|community|messaging|chat app|اجتماعی|انجمن|پیام‌رسان/iu],
    ["portfolio", /portfolio|personal site|رزومه|نمونه‌کار/iu],
    ["travel", /travel|booking|hotel|trip|سفر|رزرو|هتل/iu],
    ["media", /media|streaming|music|video|رسانه|موسیقی|ویدئو/iu],
    ["content", /content|blog|news|editorial|محتوا|وبلاگ|خبر/iu],
    ["productivity", /productivity|task manager|project management|بهره‌وری|مدیریت کار|وظایف/iu],
    ["saas", /\bsaas\b|admin|workspace|subscription|مدیریت سازمان/iu],
  ];
  const requestedDomain = patterns.find(([, expression]) => expression.test(prompt))?.[0];
  if (requestedDomain) return requestedDomain;
  return legacyType === "dashboard" ? "dashboard" : "product";
}

export function inferDesignFidelity(prompt: string, requested?: DesignFidelity): DesignFidelity {
  if (requested) return requested;
  return /\b(?:wireframe|lo[- ]?fi(?:delity)?|low fidelity)\b|وایرفریم|سیم‌کشی/iu.test(prompt)
    ? "wireframe"
    : "high_fidelity";
}

export function createDesignBrief(input: {
  prompt: string;
  fidelity: DesignFidelity;
  domain: DesignDomain;
  platform: "mobile" | "desktop" | "responsive" | "web";
  locale: "fa" | "en";
  direction: "rtl" | "ltr";
  brandDirection?: string;
}): DesignBrief {
  return DesignBriefSchema.parse({
    version: DESIGN_BRIEF_VERSION,
    prompt: input.prompt,
    fidelity: input.fidelity,
    domain: input.domain,
    audience: "Not specified in the user's brief; preserve this as an open design assumption.",
    platform: input.platform,
    locale: input.locale,
    direction: input.direction,
    brandDirection:
      input.brandDirection ??
      "Use the user's explicit brand constraints; otherwise choose a coherent restrained visual direction.",
    requestedPatterns: inferRequestedDesignPatterns(input.prompt),
    assetPolicy: "provided-or-document-assets; otherwise-labeled-native-placeholder",
    acceptanceCriteria: [
      "Preserve the user's exact requested content and restrictions; do not invent real product or customer facts.",
      "Represent the requested hierarchy as nested, editable native layers with stable parent relationships.",
      "Verify the rendered native geometry, text presence, visibility, and requested content before reporting completion.",
      ...(input.fidelity === "high_fidelity"
        ? [
            "Use a deliberate visual hierarchy, coherent tokens, and screen-appropriate pattern composition.",
          ]
        : []),
    ],
  });
}

export function validateVisualDesignSpec(
  input: unknown,
): { success: true; data: VisualDesignSpec } | { success: false; errors: string[] } {
  const parsed = VisualDesignSpecSchema.safeParse(input);
  if (!parsed.success)
    return {
      success: false,
      errors: parsed.error.issues
        .slice(0, 16)
        .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`),
    };
  const spec = parsed.data;
  const errors: string[] = [];
  const refs = new Set<string>();
  const containers = new Set<string>();
  const childrenByParent = new Map<string, VisualDesignNodeSpec[]>();
  let previousParentOrderValid = true;
  for (const [index, node] of spec.nodes.entries()) {
    if (refs.has(node.logicalRef))
      errors.push(`nodes[${index}] duplicates logicalRef “${node.logicalRef}”.`);
    if (node.parentRef && !containers.has(node.parentRef)) {
      previousParentOrderValid = false;
      errors.push(
        `nodes[${index}] parentRef “${node.parentRef}” is missing or declared after its child.`,
      );
    }
    if (node.nodeType === "text" && (!node.text?.trim() || !node.typography))
      errors.push(`nodes[${index}] text requires non-empty copy and typography evidence.`);
    if (node.nodeType === "icon" && (!node.iconName || !(node.iconName in DESIGN_ICON_PATHS)))
      errors.push(`nodes[${index}] icon must use a bundled, allowlisted vector name.`);
    if (node.nodeType === "image" && (!node.placeholder || node.qualityRole !== "image"))
      errors.push(
        `nodes[${index}] image without a resolved asset must be an image-role native placeholder.`,
      );
    refs.add(node.logicalRef);
    if (["frame", "image"].includes(node.nodeType)) containers.add(node.logicalRef);
    if (node.parentRef) {
      const siblings = childrenByParent.get(node.parentRef) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentRef, siblings);
    }
  }
  const hasImageInSubtree = new Map<string, boolean>();
  for (const node of [...spec.nodes].reverse()) {
    hasImageInSubtree.set(
      node.logicalRef,
      node.nodeType === "image" ||
        (childrenByParent.get(node.logicalRef) ?? []).some(
          (child) => hasImageInSubtree.get(child.logicalRef) === true,
        ),
    );
  }
  for (const pattern of spec.requiredPatterns)
    if (!spec.usedPatterns.includes(pattern))
      errors.push(
        `Required pattern “${pattern}” is absent; add and tag its native root or return an honest partial result.`,
      );
  for (const node of spec.nodes.filter((candidate) => candidate.pattern)) {
    if (node.nativeType !== "FRAME")
      errors.push(
        `Pattern “${node.pattern}” must be attached to a native frame root (${node.logicalRef}).`,
      );
    if (node.pattern === "product-card") {
      if (
        !(childrenByParent.get(node.logicalRef) ?? []).some((child) =>
          hasImageInSubtree.get(child.logicalRef),
        )
      )
        errors.push(
          `Product card “${node.logicalRef}” needs an image layer or a disclosed image placeholder.`,
        );
    }
    if (node.pattern === "image-gallery") {
      if (
        !(childrenByParent.get(node.logicalRef) ?? []).some((child) =>
          hasImageInSubtree.get(child.logicalRef),
        )
      )
        errors.push(
          `Image gallery “${node.logicalRef}” needs a native image or disclosed placeholder.`,
        );
    }
  }
  if (!previousParentOrderValid)
    errors.push("Node order must be parent-first for deterministic native rendering.");
  if (spec.screen.grid.margin * 2 >= spec.screen.width)
    errors.push("Grid margins consume the entire screen width.");
  return errors.length
    ? { success: false, errors: [...new Set(errors)].slice(0, 16) }
    : { success: true, data: spec };
}

export function designIconPath(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DESIGN_ICON_PATHS, name)
    ? DESIGN_ICON_PATHS[name as DesignIconName]
    : undefined;
}
