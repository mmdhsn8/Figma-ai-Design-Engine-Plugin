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

export const UIToPluginSchema = z.discriminatedUnion("type", [
  RequestSchema.extend({ type: z.literal("validate") }).strict(),
  RequestSchema.extend({ type: z.literal("generate") }).strict(),
  RequestSchema.extend({
    type: z.literal("apply-design-system"),
    updateOwned: z.boolean().default(false),
  }).strict(),
]);

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

export const PluginToUISchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("validation-result"),
      requestId: z.string(),
      success: z.boolean(),
      counts: CountsSchema.optional(),
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
]);

export type UIToPluginMessage = z.infer<typeof UIToPluginSchema>;
export type PluginToUIMessage = z.infer<typeof PluginToUISchema>;
export type MessageCounts = z.infer<typeof CountsSchema>;
export type FontSelection = z.infer<typeof FontSelectionSchema>;
