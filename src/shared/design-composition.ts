import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const boundedText = (max: number) => z.string().trim().min(1).max(max);

/** Shared, serializable visual decisions for every screen in one planned project. */
export const ProjectVisualLanguageV1Schema = z
  .object({
    version: z.literal(1),
    identity: boundedText(160),
    colorRoles: z
      .object({
        page: color,
        surface: color,
        raisedSurface: color,
        text: color,
        mutedText: color,
        primary: color,
        accent: color,
        border: color,
      })
      .strict(),
    typography: z
      .object({
        headingFont: boundedText(100),
        bodyFont: boundedText(100),
        displaySize: z.number().finite().int().min(24).max(72),
        titleSize: z.number().finite().int().min(20).max(48),
        bodySize: z.number().finite().int().min(12).max(24),
        captionSize: z.number().finite().int().min(10).max(18),
      })
      .strict(),
    spacingScale: z.array(z.number().finite().min(2).max(96)).min(3).max(8),
    radii: z.object({ compact: z.number().finite().min(0).max(32), control: z.number().finite().min(0).max(40), surface: z.number().finite().min(0).max(48) }).strict(),
    colorMode: z.enum(["light", "dark"]),
    density: z.enum(["low", "medium", "high"]),
    navigationModel: z.enum(["none", "top-bar", "bottom-bar", "side-rail", "tabs"]),
    rationale: boundedText(240),
  })
  .strict()
  .superRefine((language, context) => {
    if (language.typography.displaySize < language.typography.titleSize)
      context.addIssue({ code: "custom", path: ["typography", "displaySize"], message: "Display type must not be smaller than title type." });
    if (language.typography.titleSize < language.typography.bodySize)
      context.addIssue({ code: "custom", path: ["typography", "titleSize"], message: "Title type must not be smaller than body type." });
    for (let index = 1; index < language.spacingScale.length; index++)
      if (language.spacingScale[index]! <= language.spacingScale[index - 1]!)
        context.addIssue({ code: "custom", path: ["spacingScale", index], message: "Spacing values must be strictly increasing." });
  });
export type ProjectVisualLanguageV1 = z.infer<typeof ProjectVisualLanguageV1Schema>;

const nodeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/u);

/** Per-screen semantic composition intent. The referenced nodes are the editable implementation. */
export const ScreenCompositionV1Schema = z
  .object({
    version: z.literal(1),
    archetype: z.enum(["editorial", "data-dense", "task-focused", "form-first", "catalog-list", "detail-reading", "multi-panel", "creative-asymmetric", "custom"]),
    decisionTrace: boundedText(240),
    variationSeed: z.string().regex(/^[a-z0-9][a-z0-9._-]{7,59}$/u),
    focusNodeId: nodeId,
    responsiveIntent: boundedText(160),
    regions: z
      .array(z.object({
        nodeId,
        semanticRole: boundedText(60),
        priority: z.number().int().min(1).max(6),
        visualWeight: z.number().int().min(1).max(6),
        contentKind: z.enum(["text", "data", "collection", "media", "form", "action", "summary", "navigation", "feedback", "illustration"]),
      }).strict())
      .min(1)
      .max(6),
    entityRefs: z.array(z.string().trim().min(1).max(80)).max(12),
    approvedAssetsUsed: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u)).max(8),
  })
  .strict()
  .superRefine((composition, context) => {
    if (new Set(composition.regions.map(({ nodeId: id }) => id)).size !== composition.regions.length)
      context.addIssue({ code: "custom", path: ["regions"], message: "Composition region references must be unique." });
    if (new Set(composition.entityRefs).size !== composition.entityRefs.length)
      context.addIssue({ code: "custom", path: ["entityRefs"], message: "Entity references must be unique." });
    if (new Set(composition.approvedAssetsUsed).size !== composition.approvedAssetsUsed.length)
      context.addIssue({ code: "custom", path: ["approvedAssetsUsed"], message: "Asset references must be unique." });
  });
export type ScreenCompositionV1 = z.infer<typeof ScreenCompositionV1Schema>;

export function createDefaultVisualLanguage(input: {
  styleDirection: string;
  density: "low" | "medium" | "high";
  locale?: string;
  palette?: Partial<ProjectVisualLanguageV1["colorRoles"]>;
  fonts?: { headingFont?: string; bodyFont?: string };
}): ProjectVisualLanguageV1 {
  return ProjectVisualLanguageV1Schema.parse({
    version: 1,
    identity: input.styleDirection.slice(0, 160) || "Clear, calm product interface",
    colorRoles: {
      page: input.palette?.page ?? "#F7F8FA",
      surface: input.palette?.surface ?? "#FFFFFF",
      raisedSurface: input.palette?.raisedSurface ?? "#FFFFFF",
      text: input.palette?.text ?? "#17212B",
      mutedText: input.palette?.mutedText ?? "#596675",
      primary: input.palette?.primary ?? "#2457A7",
      accent: input.palette?.accent ?? "#C66A38",
      border: input.palette?.border ?? "#D7DDE4",
    },
    typography: {
      headingFont: input.fonts?.headingFont ?? "Inter",
      bodyFont: input.fonts?.bodyFont ?? "Inter",
      displaySize: 40,
      titleSize: 28,
      bodySize: 16,
      captionSize: 12,
    },
    spacingScale: [4, 8, 12, 16, 24, 32],
    radii: { compact: 6, control: 10, surface: 16 },
    colorMode: "light",
    density: input.density,
    navigationModel: "top-bar",
    rationale: `${input.locale?.toLocaleLowerCase().startsWith("fa") ? "RTL-aware" : "Language-aware"} spacing and contrast with a restrained product hierarchy.`,
  });
}

export function compositionVariationSeed(taskId: string, screenId: string): string {
  const source = `${taskId}:${screenId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193) >>> 0;
  return `seed-${hash.toString(16).padStart(8, "0")}`;
}

