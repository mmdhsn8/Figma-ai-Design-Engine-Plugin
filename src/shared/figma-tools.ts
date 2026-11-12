import { z } from "zod";

const RefSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u);
const PageIdSchema = z.string().min(1).max(200);
const OperationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);
const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u);
const ShadowSchema = z
  .object({
    color: ColorSchema,
    opacity: z.number().finite().min(0).max(1),
    offsetX: z.number().finite().min(-100).max(100),
    offsetY: z.number().finite().min(-100).max(100),
    radius: z.number().finite().min(0).max(100),
    spread: z.number().finite().min(-100).max(100),
  })
  .strict();
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
    primarySizing: z.enum(["FIXED", "AUTO"]).optional(),
    counterSizing: z.enum(["FIXED", "AUTO"]).default("FIXED"),
  })
  .strict();
export const AutoLayoutRepairReportSchema = z.object({
  ref: RefSchema,
  parentRef: RefSchema.optional(),
  strategy: z.enum(["hug-vertical-content", "unsupported-preserve-layout"]),
  required: DimensionsSchema,
  before: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
    primarySizing: z.enum(["AUTO", "FIXED"]),
  }),
  after: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
    primarySizing: z.enum(["AUTO", "FIXED"]),
  }),
  stopReason: z.enum([
    "fixed-viewport-or-fill-boundary",
    "primary-fill-cycle",
    "cross-axis-overflow",
    "unowned-content",
    "native-remeasurement-required",
  ]),
});
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
export const INSPECT_NODES_LIMITS = {
  refs: 20,
  depth: { min: 0, max: 4, default: 2 },
  maxNodes: { min: 1, max: 25, default: 25 },
} as const;
export const DOCUMENT_DISCOVERY_LIMITS = {
  nodesPerSlice: 128,
  targetSliceMs: 35,
  hardSliceMs: 100,
  resultFrames: 8,
  checkpointBytes: 256 * 1024,
  cacheBytes: 1536 * 1024,
  cacheEntries: 12,
  pagesPerCheckpoint: 32,
  pagesPerYield: 4,
  pageCacheEntries: 64,
  pageChangeListeners: 64,
  pageLoadTimeoutMs: 10_000,
  cancellationPollMs: 25,
} as const;
export const FigmaToolActionSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("get_document_context"),
      query: z.string().trim().min(1).max(100).optional(),
      pageId: PageIdSchema.optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      readOnlyInspection: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("inspect_nodes"),
      pageId: PageIdSchema.optional(),
      readOnlyInspection: z.boolean().optional(),
      purpose: z.enum(["structural_verification", "background_verification"]).optional(),
      palette: z.array(ColorSchema).optional(),
      refs: z.array(RefSchema).max(INSPECT_NODES_LIMITS.refs).default([]),
      selection: z.boolean().default(false),
      depth: z
        .number()
        .int()
        .min(INSPECT_NODES_LIMITS.depth.min)
        .max(INSPECT_NODES_LIMITS.depth.max)
        .default(INSPECT_NODES_LIMITS.depth.default),
      maxNodes: z
        .number()
        .int()
        .min(INSPECT_NODES_LIMITS.maxNodes.min)
        .max(INSPECT_NODES_LIMITS.maxNodes.max)
        .default(INSPECT_NODES_LIMITS.maxNodes.default),
    })
    .strict()
    .refine(
      (value) => value.refs.length > 0 || value.selection,
      "Choose refs or current selection.",
    ),
  z
    .object({
      tool: z.literal("create_frame"),
      pageId: PageIdSchema.optional(),
      ref: RefSchema,
      name: z.string().min(1).max(100),
      parent: ParentSchema,
      size: DimensionsSchema,
      x: z.number().finite().min(-100_000).max(100_000).optional(),
      y: z.number().finite().min(-100_000).max(100_000).optional(),
      fill: ColorSchema.optional(),
      stroke: ColorSchema.optional(),
      strokeWeight: z.number().finite().min(0).max(100).optional(),
      cornerRadius: z.number().finite().min(0).max(500).default(0),
      paintStyleId: z.string().min(1).max(100).optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
      shadow: ShadowSchema.optional(),
      clipsContent: z.boolean().optional(),
      autoLayout: LayoutSchema.optional(),
    })
    .strict()
    .refine(
      (value) => !(value.fill && value.paintStyleId),
      "Choose a fill color or a local paint style.",
    ),
  z
    .object({
      tool: z.literal("create_text"),
      pageId: PageIdSchema.optional(),
      ref: RefSchema,
      name: z.string().min(1).max(100),
      parent: ParentSchema,
      text: z.string().max(20_000),
      size: DimensionsSchema,
      font: TextFontSchema.default({ family: "Inter", style: "Regular" }),
      fontSize: z.number().finite().min(1).max(300).default(16),
      color: ColorSchema.default("#1F2937"),
      align: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
      direction: z.enum(["LTR", "RTL"]).default("LTR"),
      horizontalSizing: z.enum(["FIXED", "HUG", "FILL"]).default("FIXED"),
      verticalSizing: z.enum(["FIXED", "HUG", "FILL"]).default("HUG"),
      lineHeight: z.number().finite().min(1).max(1_000).optional(),
      letterSpacing: z.number().finite().min(-1_000).max(1_000).optional(),
      textAutoResize: z.enum(["NONE", "HEIGHT", "WIDTH_AND_HEIGHT", "TRUNCATE"]).default("HEIGHT"),
    })
    .strict(),
  z
    .object({
      tool: z.literal("create_rectangle"),
      pageId: PageIdSchema.optional(),
      ref: RefSchema,
      name: z.string().min(1).max(100),
      parent: ParentSchema,
      size: DimensionsSchema,
      x: z.number().finite().min(-100_000).max(100_000).optional(),
      y: z.number().finite().min(-100_000).max(100_000).optional(),
      fill: ColorSchema.optional(),
      stroke: ColorSchema.optional(),
      strokeWeight: z.number().finite().min(0).max(100).default(1),
      cornerRadius: z.number().finite().min(0).max(500).default(0),
      opacity: z.number().finite().min(0).max(1).optional(),
      paintStyleId: z.string().min(1).max(100).optional(),
      shadow: ShadowSchema.optional(),
    })
    .strict()
    .refine(
      (value) => !(value.fill && value.paintStyleId),
      "Choose a fill color or a local paint style.",
    ),
  z
    .object({
      tool: z.literal("set_auto_layout"),
      pageId: PageIdSchema.optional(),
      ref: RefSchema,
      layout: LayoutSchema,
      repairOverflow: z.boolean().optional(),
      children: z.array(SizeRuleSchema).max(100).default([]),
    })
    .strict(),
  z
    .object({
      tool: z.literal("set_properties"),
      backgroundRootRef: RefSchema.optional(),
      pageId: PageIdSchema.optional(),
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
          align: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
          stroke: ColorSchema.optional(),
          strokeWeight: z.number().finite().min(0).max(100).optional(),
          cornerRadius: z.number().finite().min(0).max(500).optional(),
          opacity: z.number().finite().min(0).max(1).optional(),
          shadow: ShadowSchema.optional(),
          fontFamily: z.string().min(1).max(80).optional(),
          fontStyle: z.string().min(1).max(80).optional(),
          lineHeight: z.number().finite().min(1).max(1_000).optional(),
          letterSpacing: z.number().finite().min(-1_000).max(1_000).optional(),
          textAutoResize: z.enum(["NONE", "HEIGHT", "WIDTH_AND_HEIGHT", "TRUNCATE"]).optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, "At least one property is required.")
        .refine(
          (value) => !(value.fill && value.paintStyleId),
          "Choose a fill color or a local paint style.",
        )
        .refine(
          (value) =>
            !value.textStyleId ||
            ![
              value.fontSize,
              value.color,
              value.fontFamily,
              value.fontStyle,
              value.lineHeight,
              value.letterSpacing,
              value.align,
              value.textAutoResize,
            ].some((entry) => entry !== undefined),
          "Choose a text style or explicit typography changes.",
        ),
    })
    .strict(),
  z
    .object({
      tool: z.literal("append_child"),
      pageId: PageIdSchema.optional(),
      childRef: RefSchema,
      parentRef: RefSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("reparent_node"),
      pageId: PageIdSchema.optional(),
      ref: RefSchema,
      parentRef: RefSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("get_operation_status"),
      pageId: PageIdSchema.optional(),
      operationId: OperationIdSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal("delete_node"),
      pageId: PageIdSchema.optional(),
      ref: RefSchema,
      consentToken: z.string().min(32).max(128),
    })
    .strict(),
]);

export const FigmaToolOperationSchema = z
  .object({
    operationId: OperationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,120}$/u),
    taskId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,60}$/u)
      .optional(),
    chatId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u).optional(),
    designName: z.string().trim().min(1).max(100).optional(),
    expectedCreationOperationId: OperationIdSchema.optional(),
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

export const FigmaToolAcknowledgementSchema = z.enum([
  "confirmed_mutation",
  "verified_idempotent_replay",
  "rejected",
  "ambiguous",
  "read_only",
  "not_attempted",
]);

export const FigmaToolStateDiagnosticSchema = z
  .object({
    category: z.enum([
      "state_too_large",
      "record_limit",
      "invalid_schema",
      "corrupted_state",
      "storage_unavailable",
    ]),
    location: z.enum(["load", "migration", "save"]),
    schemaVersion: z.number().int().min(1).max(3).nullable(),
    serializedBytes: z.number().int().nonnegative().nullable().optional(),
    configuredLimitBytes: z.number().int().positive().optional(),
    sourceBytes: z.number().int().nonnegative().optional(),
    reservedBytes: z.number().int().nonnegative().optional(),
    recordLimit: z.enum(["references_500", "operations_400"]).optional(),
  })
  .strict();
export type FigmaToolStateDiagnostic = z.infer<typeof FigmaToolStateDiagnosticSchema>;

const CompatibilityParentTypeSchema = z.enum(["PAGE", "FRAME", "COMPONENT"]);
const CompatibilityLayoutModeSchema = z.enum(["NONE", "HORIZONTAL", "VERTICAL"]);

export const FigmaToolCompatibilityNormalizationSchema = z
  .object({
    toolName: z.enum(["create_text", "set_auto_layout"]),
    nodeType: z.string().regex(/^[A-Z_]{1,40}$/u),
    fieldPath: z.enum([
      "action.horizontalSizing",
      "action.verticalSizing",
      "action.textAutoResize",
      "action.layout.primarySizing",
      "action.layout.counterSizing",
      "action.children.sizing",
    ]),
    requested: z.enum([
      "FIXED",
      "HUG",
      "FILL",
      "NONE",
      "HEIGHT",
      "WIDTH_AND_HEIGHT",
      "TRUNCATE",
      "AUTO",
    ]),
    applied: z.enum([
      "FIXED",
      "HUG",
      "FILL",
      "NONE",
      "HEIGHT",
      "WIDTH_AND_HEIGHT",
      "TRUNCATE",
      "AUTO",
    ]),
    reason: z.enum([
      "page_root_uses_explicit_geometry",
      "non_auto_layout_parent_uses_content_box",
      "fixed_geometry_requires_native_text_resize",
      "hug_sizing_uses_native_text_resize",
      "fill_child_requires_fixed_parent_axis",
      "stretch_child_uses_fill_sizing",
    ]),
    parentType: CompatibilityParentTypeSchema.optional(),
    parentLayoutMode: CompatibilityLayoutModeSchema.optional(),
    resolvedDimension: z.number().finite().min(1).max(20_000).optional(),
    affectedRefs: z.array(RefSchema).max(100).optional(),
  })
  .strict();

export const FigmaToolCompatibilityFailureSchema = z
  .object({
    toolName: z.enum([
      "create_frame",
      "create_text",
      "create_rectangle",
      "set_auto_layout",
      "set_properties",
      "append_child",
      "reparent_node",
      "delete_node",
    ]),
    nodeType: z.string().regex(/^[A-Z_]{1,40}$/u),
    code: z.enum([
      "fill_parent_bounds_unavailable",
      "text_sizing_requires_auto_layout",
      "unsupported_parent_type",
      "unsupported_target_type",
      "unsupported_property",
      "style_not_found",
      "conflicting_style_properties",
      "invalid_layout_rules",
      "unsupported_hug_target",
      "invalid_parenting",
      "delete_consent_required",
      "invalid_position",
    ]),
    fieldPath: z.enum([
      "action.parent",
      "action.ref",
      "action.paintStyleId",
      "action.horizontalSizing",
      "action.verticalSizing",
      "action.textAutoResize",
      "action.layout",
      "action.layout.direction",
      "action.layout.counterAlign",
      "action.children",
      "action.children.ref",
      "action.properties",
      "action.properties.fill",
      "action.properties.paintStyleId",
      "action.properties.textStyleId",
      "action.properties.text",
      "action.properties.width",
      "action.properties.height",
      "action.properties.stroke",
      "action.properties.cornerRadius",
      "action.properties.opacity",
      "action.properties.shadow",
      "action.consentToken",
      "action.parentRef",
      "action.x",
      "action.y",
    ]),
    parentType: CompatibilityParentTypeSchema.optional(),
    parentLayoutMode: CompatibilityLayoutModeSchema.optional(),
    permittedRemediations: z
      .array(
        z.enum([
          "use_explicit_fixed_size",
          "establish_auto_layout_before_creation",
          "use_compatible_parent",
          "use_supported_property",
          "select_available_local_style",
          "remove_conflicting_property",
          "inspect_current_parent",
          "use_explicit_reparent",
          "request_delete_consent",
        ]),
      )
      .min(1)
      .max(4),
  })
  .strict();

export const FigmaToolParentingDiagnosticSchema = z
  .object({
    operationId: OperationIdSchema,
    toolName: z.enum(["append_child", "reparent_node"]),
    sourceLogicalRef: RefSchema,
    targetLogicalRef: RefSchema,
    sourceParentCategory: z.enum([
      "page_root",
      "frame",
      "component",
      "other",
      "detached",
      "unknown",
    ]),
    expectedParentCategory: z.enum(["frame", "component", "unknown"]),
    actualParentCategory: z.enum([
      "page_root",
      "frame",
      "component",
      "other",
      "detached",
      "unknown",
    ]),
    decision: z.enum([
      "appended",
      "already_parented",
      "reparented",
      "reconciled_commit",
      "reconciled_noop",
      "rejected_non_root",
      "rejected_stale_or_ambiguous",
      "rejected_cycle",
      "rejected_parent",
      "native_error",
    ]),
    acknowledgementStatus: FigmaToolAcknowledgementSchema,
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
export const FigmaToolPauseSchema = z
  .object({
    type: z.literal("tool-pause"),
    protocolVersion: z.literal(1),
    batchId: OperationIdSchema,
  })
  .strict();

export const FigmaToolRequestSchema = z.union([
  FigmaToolBatchSchema,
  FigmaToolCancelSchema,
  FigmaToolPauseSchema,
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
            acknowledgementStatus: FigmaToolAcknowledgementSchema.optional(),
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
    toolStateDiagnostic: FigmaToolStateDiagnosticSchema.optional(),
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
export type FigmaToolParentingDiagnostic = z.infer<typeof FigmaToolParentingDiagnosticSchema>;
export type FigmaToolMessage =
  | z.infer<typeof FigmaToolProgressSchema>
  | z.infer<typeof FigmaToolBatchResultSchema>
  | z.infer<typeof FigmaToolDeleteConsentResultSchema>;
