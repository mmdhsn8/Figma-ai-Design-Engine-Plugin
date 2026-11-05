import { z } from "zod";

const RefSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u);
const OperationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);
const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u);
const DimensionsSchema = z
  .object({
    width: z.number().finite().min(1).max(20_000),
    height: z.number().finite().min(1).max(20_000),
  })
  .strict();
const ParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page") }).strict(),
  z.object({ kind: z.literal("node"), ref: RefSchema }).strict(),
]);
const PaddingSchema = z
  .object({
    top: z.number().finite().min(0).max(1_000),
    right: z.number().finite().min(0).max(1_000),
    bottom: z.number().finite().min(0).max(1_000),
    left: z.number().finite().min(0).max(1_000),
  })
  .strict();
const LayoutSchema = z
  .object({
    direction: z.enum(["horizontal", "vertical"]),
    gap: z.number().finite().min(0).max(1_000).default(0),
    padding: PaddingSchema.default({ top: 0, right: 0, bottom: 0, left: 0 }),
    primaryAlign: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).default("MIN"),
    counterAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).default("MIN"),
    primarySizing: z.enum(["FIXED", "AUTO"]).default("FIXED"),
    counterSizing: z.enum(["FIXED", "AUTO"]).default("FIXED"),
  })
  .strict();
const SizeRuleSchema = z
  .object({
    ref: RefSchema,
    align: z.enum(["INHERIT", "STRETCH"]).optional(),
    grow: z.number().int().min(0).max(1).optional(),
    horizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    vertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  })
  .strict();
const TextFontSchema = z
  .object({
    family: z.string().min(1).max(80).default("Inter"),
    style: z.string().min(1).max(80).default("Regular"),
  })
  .strict();
export const FigmaToolActionSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("get_document_context") }).strict(),
  z
    .object({
      tool: z.literal("inspect_nodes"),
      refs: z.array(RefSchema).max(20).default([]),
      selection: z.boolean().default(false),
      depth: z.number().int().min(0).max(4).default(2),
      maxNodes: z.number().int().min(1).max(25).default(25),
    })
    .strict()
    .refine(
      (value) => value.refs.length > 0 || value.selection,
      "Choose refs or current selection.",
    ),
  z
    .object({
      tool: z.literal("create_frame"),
      ref: RefSchema,
      name: z.string().min(1).max(100),
      parent: ParentSchema,
      size: DimensionsSchema,
      x: z.number().finite().min(-100_000).max(100_000).optional(),
      y: z.number().finite().min(-100_000).max(100_000).optional(),
      fill: ColorSchema.optional(),
      stroke: ColorSchema.optional(),
      cornerRadius: z.number().finite().min(0).max(500).default(0),
      autoLayout: LayoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("create_text"),
      ref: RefSchema,
      name: z.string().min(1).max(100),
      parent: ParentSchema,
      text: z.string().max(20_000),
      size: DimensionsSchema,
      font: TextFontSchema.default({ family: "Inter", style: "Regular" }),
      fontSize: z.number().finite().min(1).max(300).default(16),
      color: ColorSchema.default("#1F2937"),
      align: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
      direction: z.enum(["LTR", "RTL"]).default("LTR"),
      horizontalSizing: z.enum(["FIXED", "HUG", "FILL"]).default("FIXED"),
      verticalSizing: z.enum(["FIXED", "HUG", "FILL"]).default("HUG"),
    })
    .strict(),
  z
    .object({
      tool: z.literal("create_rectangle"),
      ref: RefSchema,
      name: z.string().min(1).max(100),
      parent: ParentSchema,
      size: DimensionsSchema,
      x: z.number().finite().min(-100_000).max(100_000).optional(),
      y: z.number().finite().min(-100_000).max(100_000).optional(),
      fill: ColorSchema.default("#FFFFFF"),
      stroke: ColorSchema.optional(),
      strokeWeight: z.number().finite().min(0).max(100).default(1),
      cornerRadius: z.number().finite().min(0).max(500).default(0),
    })
    .strict(),
  z
    .object({
      tool: z.literal("set_auto_layout"),
      ref: RefSchema,
      layout: LayoutSchema,
      children: z.array(SizeRuleSchema).max(100).default([]),
    })
    .strict(),
  z
    .object({
      tool: z.literal("set_properties"),
      ref: RefSchema,
      properties: z
        .object({
          name: z.string().min(1).max(100).optional(),
          fill: ColorSchema.optional(),
          paintStyleId: z.string().min(1).max(100).optional(),
          visible: z.boolean().optional(),
          width: z.number().finite().min(1).max(20_000).optional(),
          height: z.number().finite().min(1).max(20_000).optional(),
          text: z.string().max(20_000).optional(),
          fontSize: z.number().finite().min(1).max(300).optional(),
          color: ColorSchema.optional(),
          textStyleId: z.string().min(1).max(100).optional(),
          align: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, "At least one property is required."),
    })
    .strict(),
  z.object({ tool: z.literal("append_child"), childRef: RefSchema, parentRef: RefSchema }).strict(),
  z.object({ tool: z.literal("reparent_node"), ref: RefSchema, parentRef: RefSchema }).strict(),
  z.object({ tool: z.literal("get_operation_status"), operationId: OperationIdSchema }).strict(),
  z
    .object({
      tool: z.literal("delete_node"),
      ref: RefSchema,
      consentToken: z.string().min(32).max(128),
    })
    .strict(),
]);

export const FigmaToolOperationSchema = z
  .object({
    operationId: OperationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,120}$/u),
    action: FigmaToolActionSchema,
  })
  .strict();

export const FigmaToolBatchSchema = z
  .object({
    type: z.literal("tool-execute"),
    protocolVersion: z.literal(1),
    batchId: OperationIdSchema,
    operations: z.array(FigmaToolOperationSchema).min(1).max(10),
  })
  .strict();

export const FigmaToolCancelSchema = z
  .object({
    type: z.literal("tool-cancel"),
    protocolVersion: z.literal(1),
    batchId: OperationIdSchema,
  })
  .strict();

export const FigmaToolDeleteConsentSchema = z
  .object({
    type: z.literal("tool-delete-consent"),
    protocolVersion: z.literal(1),
    requestId: OperationIdSchema,
    ref: RefSchema,
    confirmation: z.string().max(120),
  })
  .strict();

export const FigmaToolRequestSchema = z.union([
  FigmaToolBatchSchema,
  FigmaToolCancelSchema,
  FigmaToolDeleteConsentSchema,
]);

export const FigmaToolProgressSchema = z
  .object({
    type: z.literal("tool-progress"),
    protocolVersion: z.literal(1),
    batchId: OperationIdSchema,
    operationId: OperationIdSchema,
    index: z.number().int().min(0).max(9),
    total: z.number().int().min(1).max(10),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    message: z.string().max(300),
    logicalRef: RefSchema.optional(),
  })
  .strict();

export const FigmaToolBatchResultSchema = z
  .object({
    type: z.literal("tool-result"),
    protocolVersion: z.literal(1),
    batchId: OperationIdSchema,
    success: z.boolean(),
    cancelled: z.boolean(),
    committedOperationIds: z.array(OperationIdSchema).max(10),
    partialOperationIds: z.array(OperationIdSchema).max(10),
    results: z
      .array(
        z
          .object({
            operationId: OperationIdSchema,
            success: z.boolean(),
            replayed: z.boolean(),
            logicalRef: RefSchema.optional(),
            summary: z.string().max(300).optional(),
            data: z.record(z.string(), z.unknown()).optional(),
            error: z.string().max(400).optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const FigmaToolDeleteConsentResultSchema = z
  .object({
    type: z.literal("tool-delete-consent-result"),
    protocolVersion: z.literal(1),
    requestId: OperationIdSchema,
    success: z.boolean(),
    consentToken: z.string().min(32).max(128).optional(),
    message: z.string().max(300),
  })
  .strict();

export const FigmaToolOperationStatusSchema = z
  .object({
    operationId: OperationIdSchema,
    status: z.enum(["running", "completed", "failed"]),
    updatedAt: z.number().int().nonnegative(),
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type FigmaToolAction = z.infer<typeof FigmaToolActionSchema>;
export type FigmaToolOperation = z.infer<typeof FigmaToolOperationSchema>;
export type FigmaToolBatch = z.infer<typeof FigmaToolBatchSchema>;
export type FigmaToolMessage =
  | z.infer<typeof FigmaToolProgressSchema>
  | z.infer<typeof FigmaToolBatchResultSchema>
  | z.infer<typeof FigmaToolDeleteConsentResultSchema>;
