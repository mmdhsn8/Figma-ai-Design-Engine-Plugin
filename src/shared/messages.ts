import { z } from "zod";

const RequestSchema = z.object({
  requestId: z.string().min(1).max(100),
  json: z.string(),
});

const CountsSchema = z
  .object({
    frames: z.number().int().nonnegative(),
    texts: z.number().int().nonnegative(),
    rectangles: z.number().int().nonnegative(),
    components: z.number().int().nonnegative(),
    instances: z.number().int().nonnegative(),
    ellipses: z.number().int().nonnegative().optional(),
    vectors: z.number().int().nonnegative().optional(),
    images: z.number().int().nonnegative().optional(),
  })
  .strict();

const FontSelectionSchema = z
  .object({
    requestedFamily: z.string(),
    requestedStyle: z.string(),
    usedFamily: z.string(),
    usedStyle: z.string(),
    fellBack: z.boolean(),
  })
  .strict();

const DesignSystemReportSchema = z
  .object({
    namespace: z.string(),
    created: z.array(z.string()),
    reused: z.array(z.string()),
    updated: z.array(z.string()),
    skipped: z.array(z.string()),
    fallbacks: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

const MultiScreenPreviewScreenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    group: z.string().optional(),
    devicePreset: z.enum(["mobile", "tablet", "desktop", "custom"]).optional(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

const MultiScreenCountsSchema = z
  .object({
    totalScreens: z.number().int().nonnegative(),
    nodeCount: z.number().int().nonnegative(),
    screens: z.array(MultiScreenPreviewScreenSchema),
  })
  .strict();

const MultiScreenResultScreenSchema = MultiScreenPreviewScreenSchema.extend({
  status: z.enum(["generated", "failed"]),
  frameName: z.string().optional(),
  counts: CountsSchema,
  error: z.string().optional(),
  warnings: z.array(z.string()),
}).strict();

const MultiScreenProgressSchema = z
  .object({
    type: z.literal("multi-screen-progress"),
    requestId: z.string(),
    index: z.number().int().positive(),
    total: z.number().int().positive(),
    screenId: z.string(),
    screenName: z.string(),
    status: z.enum(["started", "generated", "failed"]),
    message: z.string().optional(),
  })
  .strict();

const MultiScreenRenderResultSchema = z
  .object({
    type: z.literal("multi-screen-result"),
    requestId: z.string(),
    batchId: z.string(),
    batchName: z.string(),
    totalScreens: z.number().int().nonnegative(),
    generatedScreens: z.number().int().nonnegative(),
    failedScreens: z.number().int().nonnegative(),
    estimatedNodeCount: z.number().int().nonnegative(),
    createdNodeCount: z.number().int().nonnegative(),
    gap: z.number().finite().nonnegative(),
    maxRowWidth: z.number().finite().positive(),
    counts: CountsSchema,
    screens: z.array(MultiScreenResultScreenSchema),
    warnings: z.array(z.string()),
    fontSelections: z.array(FontSelectionSchema),
    designSystem: DesignSystemReportSchema.optional(),
  })
  .strict();

export const UIToPluginSchema = z.discriminatedUnion("type", [
  RequestSchema.extend({ type: z.literal("validate") }).strict(),
  RequestSchema.extend({ type: z.literal("generate") }).strict(),
  RequestSchema.extend({
    type: z.literal("generate-multi-screen"),
    gap: z.number().finite().min(0).max(1_000).default(120),
    maxRowWidth: z.number().finite().min(390).max(20_000).default(6_000),
  }).strict(),
  RequestSchema.extend({
    type: z.literal("apply-design-system"),
    updateOwned: z.boolean().default(false),
  }).strict(),
]);

export const PluginToUISchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("validation-result"),
      requestId: z.string(),
      success: z.boolean(),
      counts: CountsSchema.optional(),
      multiScreen: MultiScreenCountsSchema.optional(),
      fontWarnings: z.array(z.string()).max(100).optional(),
      errors: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("render-result"),
      requestId: z.string(),
      success: z.literal(true),
      frameName: z.string(),
      counts: CountsSchema,
      warnings: z.array(z.string()),
      fontSelections: z.array(FontSelectionSchema),
      designSystem: DesignSystemReportSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("render-error"),
      requestId: z.string(),
      message: z.string(),
      errors: z.array(z.string()).optional(),
    })
    .strict(),
  z.object({ type: z.literal("protocol-error"), message: z.string() }).strict(),
  MultiScreenProgressSchema,
  MultiScreenRenderResultSchema,
]);

export type UIToPluginMessage = z.infer<typeof UIToPluginSchema>;
export type PluginToUIMessage = z.infer<typeof PluginToUISchema>;
export type MessageCounts = z.infer<typeof CountsSchema>;
export type FontSelection = z.infer<typeof FontSelectionSchema>;
export type MultiScreenProgressMessage = z.infer<typeof MultiScreenProgressSchema>;
export type MultiScreenRenderResultMessage = z.infer<typeof MultiScreenRenderResultSchema>;
