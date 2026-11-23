import { z } from "zod";
import { ChatTaskSchema } from "./chat-task";
import { ContextCancelSchema, ContextReadSchema, ContextResultSchema, ContextTicketSchema } from "./design-context";
import { DraftIdentitySchema, DraftManifestSchema } from "./generation-draft";
import { GenerationTransactionSchema } from "./generation-transaction";
import {
  ChatHistoryChatIdSchema,
  ChatHistoryConversationSchema,
  ChatHistoryIndexSchema,
} from "./chat-history";
import {
  FigmaToolBatchSchema,
  FigmaToolCancelSchema,
  FigmaToolPauseSchema,
  FigmaToolDeleteConsentSchema,
  FigmaToolBatchResultSchema,
  FigmaToolDeleteConsentResultSchema,
  FigmaToolProgressSchema,
  FigmaToolStateDiagnosticSchema,
} from "./figma-tools";
import { ModelIdSchema } from "./model-preference";
import { BrandKitStorageCommandSchema, BrandKitStorageResultSchema, PinnedBrandKitSchema } from "./brand-kit";
import { DesignSkillStorageCommandSchema, DesignSkillStorageResultSchema } from "./design-skill";
import { DesignProgramV1Schema } from "./design-program";
import { DesignEngineSchema } from "./design-engine-preference";
import { NATIVE_GEOMETRY_VERSION } from "./native-geometry";
import { FW4_GEOMETRY_NODE_LIMIT } from "./fw4-geometry";
import { VisualCaptureRequestV1Schema, VisualCaptureReceiptV1Schema, VisualCaptureTransportV1Schema, VisualNativeRepairRequestV1Schema, VisualNativeRepairResultV1Schema } from "./fw5-visual-qa";

const CheckpointRevisionSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{16}$/u),
  bytes: z.number().int().nonnegative(),
}).strict();

const ChatTaskLoadMessageSchema = z
  .object({
    type: z.literal("chat-task-load"),
    requestId: z.string().min(1).max(100),
    chatId: ChatHistoryChatIdSchema.optional(),
    documentId: z.string().min(1).max(300).optional(),
    confirm: CheckpointRevisionSchema.optional(),
  })
  .strict();
const ChatTaskSaveMessageSchema = z
  .object({
    type: z.literal("chat-task-save"),
    requestId: z.string().min(1).max(100),
    documentId: z.string().min(1).max(300),
    chatId: ChatHistoryChatIdSchema.optional(),
    task: ChatTaskSchema.nullable(),
    revision: CheckpointRevisionSchema.optional(),
  })
  .strict();
export const ChatTaskStorageMessageSchema = z.discriminatedUnion("type", [
  ChatTaskLoadMessageSchema,
  ChatTaskSaveMessageSchema,
]);

const GeometryRectSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite(), height: z.number().finite(),
}).strict();
const NativeLayoutSnapshotSchema = z.object({
  horizontalSizing: z.string().max(30),
  verticalSizing: z.string().max(30),
  textAutoResize: z.string().max(30).optional(),
}).strict();
const NativeLayoutExpectationSchema = z.object({
  logicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
  parentLogicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
  horizontalSizing: z.enum(["FIXED", "HUG", "FILL"]),
  verticalSizing: z.enum(["FIXED", "HUG", "FILL"]),
  textAutoResize: z.enum(["HEIGHT", "WIDTH_AND_HEIGHT"]).optional(),
}).strict();
const NativeGeometryReportSchema = z.object({
  version: z.literal(NATIVE_GEOMETRY_VERSION),
  coverage: z.enum(["complete", "incomplete"]),
  measuredNodes: z.number().int().min(0).max(300),
  durationMs: z.number().int().nonnegative(),
  receipt: z.string().regex(/^v1-[a-f0-9]{1,8}$/u).optional(),
  findings: z.array(z.object({
    code: z.string().regex(/^[a-z_]{1,80}$/u),
    nodeId: z.string().min(1).max(100),
    parentId: z.string().min(1).max(100).optional(),
    logicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u).optional(),
    expected: GeometryRectSchema.optional(),
    observed: GeometryRectSchema.optional(),
    expectedLayout: NativeLayoutSnapshotSchema.optional(),
    observedLayout: NativeLayoutSnapshotSchema.optional(),
  }).strict()).max(12),
}).strict();

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
  nodeId: z.string().optional(),
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

const TaskNativeNodeSchema = z
  .object({
    id: z.string().min(1).max(100),
    parentId: z.string().min(1).max(100).optional(),
    ref: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u)
      .optional(),
    logicalRef: z.string().min(1).max(120).optional(),
    semanticRole: z.string().min(1).max(60).optional(),
    name: z.string().max(100),
    type: z.string().min(1).max(40),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    visible: z.boolean(),
    layoutMode: z.string().max(20).optional(),
    clipsContent: z.boolean().optional(),
    overflowDirection: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]).optional(),
    itemSpacing: z.number().finite().optional(),
    padding: z
      .object({
        top: z.number().finite(),
        right: z.number().finite(),
        bottom: z.number().finite(),
        left: z.number().finite(),
      })
      .strict()
      .optional(),
    primaryAxisSizingMode: z.string().max(20).optional(),
    counterAxisSizingMode: z.string().max(20).optional(),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    textAutoResize: z.enum(["HEIGHT", "WIDTH_AND_HEIGHT"]).optional(),
    textLength: z.number().int().nonnegative().max(10_000).optional(),
    fontFamily: z.string().min(1).max(100).optional(),
    fontSize: z.number().finite().positive().max(256).optional(),
  })
  .strict();

const TaskNativeUnresolvedRefSchema = z
  .object({
    ref: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u),
    status: z.enum(["missing", "stale", "ambiguous", "unavailable"]),
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
  ContextReadSchema,
  ContextCancelSchema,
  z
    .object({
      type: z.literal("design-skills-storage"),
      requestId: z.string().min(1).max(100),
      command: DesignSkillStorageCommandSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("brand-kit-storage"),
      requestId: z.string().min(1).max(100),
      command: BrandKitStorageCommandSchema,
    })
    .strict(),
  ChatTaskLoadMessageSchema,
  ChatTaskSaveMessageSchema,
  z
    .object({
      type: z.literal("design-program-render"),
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
      taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
      documentId: z.string().min(1).max(300),
      brandKit: PinnedBrandKitSchema.optional(),
      expectedRootNodeId: z.string().min(1).max(100).optional(),
      contextTicket: ContextTicketSchema.optional(),
      program: DesignProgramV1Schema,
    })
    .strict()
    .superRefine((request, context) => {
      if (request.program.screens.length !== 1)
        context.addIssue({ code: "custom", path: ["program", "screens"], message: "Chat renders one checkpointed screen per native request." });
    }),
  z
    .object({
      type: z.literal("task-native-inspect"),
      requestId: z.string().min(1).max(100),
      documentId: z.string().min(1).max(300),
      taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
      refs: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u)).max(500),
      geometry: z.object({
        programFingerprint: z.string().regex(/^dpv1-[a-f0-9]{16}$/u),
        requireReceipt: z.boolean(),
        expectedRootNodeId: z.string().min(1).max(100).optional(),
        expectedLayout: z.array(NativeLayoutExpectationSchema).max(FW4_GEOMETRY_NODE_LIMIT).optional(),
      }).strict().superRefine((geometry, context) => {
        const refs = geometry.expectedLayout?.map(({ logicalRef }) => logicalRef) ?? [];
        if (new Set(refs).size !== refs.length)
          context.addIssue({ code: "custom", path: ["expectedLayout"], message: "Native layout expectations must have unique logical references." });
      }).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("task-native-focus"),
      requestId: z.string().min(1).max(100),
      documentId: z.string().min(1).max(300),
      taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
      nodeIds: z.array(z.string().min(1).max(100)).min(1).max(20),
      mode: z.enum(["select", "zoom"]),
    })
    .strict(),
  z.object({
    type: z.literal("task-native-visual-capture"),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    rootRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u),
    visualCapture: VisualCaptureRequestV1Schema,
    expectedLayout: z.array(NativeLayoutExpectationSchema).max(FW4_GEOMETRY_NODE_LIMIT).optional(),
  }).strict().superRefine((request, context) => {
    if (request.requestId !== request.visualCapture.captureNonce)
      context.addIssue({ code: "custom", path: ["visualCapture", "captureNonce"], message: "Capture nonce must equal its bridge request identity." });
    const refs = request.expectedLayout?.map(({ logicalRef }) => logicalRef) ?? [];
    if (new Set(refs).size !== refs.length)
      context.addIssue({ code: "custom", path: ["expectedLayout"], message: "Capture layout expectations must have unique logical references." });
  }),
  z.object({
    type: z.literal("task-native-visual-capture-cancel"),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    captureNonce: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  }).strict().superRefine((request, context) => {
    if (request.requestId !== request.captureNonce)
      context.addIssue({ code: "custom", path: ["captureNonce"], message: "Capture cancellation must match the bridge request identity." });
  }),
  z.object({
    type: z.literal("task-native-visual-repair"),
    request: VisualNativeRepairRequestV1Schema,
  }).strict().superRefine((message, context) => {
    if (message.request.requestId !== message.request.proposal.proposalId)
      context.addIssue({ code: "custom", path: ["request", "requestId"], message: "Repair request identity must match its proposal." });
  }),
  z.object({
    type: z.literal("task-native-visual-repair-cancel"),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
  }).strict(),
  z
    .object({ type: z.literal("chat-history-load"), requestId: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      type: z.literal("chat-history-upsert"),
      requestId: z.string().min(1).max(100),
      documentId: z.string().min(1).max(300),
      conversation: ChatHistoryConversationSchema,
      activeChatId: ChatHistoryChatIdSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat-history-delete"),
      requestId: z.string().min(1).max(100),
      documentId: z.string().min(1).max(300),
      chatId: ChatHistoryChatIdSchema,
    })
    .strict(),
  FigmaToolBatchSchema,
  FigmaToolCancelSchema,
  FigmaToolPauseSchema,
  FigmaToolDeleteConsentSchema,
  z
    .object({
      type: z.literal("generation-select"),
      requestId: z.string().max(100),
      generationId: DraftIdentitySchema,
      screenId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u)
        .optional(),
      sectionId: z.enum(["identity", "primary", "supporting"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("generation-context"), requestId: z.string().max(100) }).strict(),
  z
    .object({
      type: z.literal("generation-remember"),
      requestId: z.string().max(100),
      generationId: DraftIdentitySchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("generation-prepare"),
      requestId: z.string().max(100),
      manifest: DraftManifestSchema,
      screenIds: z
        .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u))
        .min(1)
        .max(400),
      focusInitial: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("generation-render"),
      requestId: z.string().max(100),
      manifest: DraftManifestSchema,
      design: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("generation-verify"),
      requestId: z.string().max(100),
      manifest: DraftManifestSchema,
      design: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("generation-apply-section"),
      requestId: z.string().max(100),
      manifest: DraftManifestSchema,
      transaction: GenerationTransactionSchema,
      design: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal("load-companion-restore-ticket") }).strict(),
  z
    .object({
      type: z.literal("save-companion-restore-ticket"),
      requestId: z.string().min(1).max(100),
      ticket: z
        .string()
        .regex(/^FADP1T:[A-Za-z0-9+/]+=*$/u)
        .max(12_000)
        .nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("load-model-preference"), requestId: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      type: z.literal("save-model-preference"),
      requestId: z.string().min(1).max(100),
      selectedModel: ModelIdSchema,
    })
    .strict(),
  z.object({ type: z.literal("load-design-engine-preference"), requestId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal("save-design-engine-preference"),
      requestId: z.string().min(1).max(100),
      selectedEngine: DesignEngineSchema,
    })
    .strict(),
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
  ContextResultSchema,
  DesignSkillStorageResultSchema,
  BrandKitStorageResultSchema,
  z
    .object({
      type: z.literal("model-preference-loaded"),
      requestId: z.string().min(1).max(100),
      state: z.enum(["empty", "valid", "invalid", "unavailable"]),
      selectedModel: ModelIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("model-preference-saved"),
      requestId: z.string().min(1).max(100),
      success: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("design-engine-preference-loaded"),
      requestId: z.string().min(1).max(100),
      state: z.enum(["empty", "valid", "invalid", "unavailable"]),
      selectedEngine: DesignEngineSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("design-engine-preference-saved"),
      requestId: z.string().min(1).max(100),
      success: z.boolean(),
      selectedEngine: DesignEngineSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat-history-result"),
      requestId: z.string().min(1).max(100),
      success: z.boolean(),
      documentId: z.string().max(300),
      history: ChatHistoryIndexSchema.optional(),
      corruptRecordCount: z.number().int().nonnegative().max(10_000).optional(),
      error: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("chat-task-result"),
      requestId: z.string().min(1).max(100),
      success: z.boolean(),
      documentId: z.string().max(300),
      task: ChatTaskSchema.nullable().optional(),
      revision: CheckpointRevisionSchema.optional(),
      errorCategory: z.enum(["checkpoint_storage"]).optional(),
      errorCode: z
        .string()
        .regex(/^[a-z_]{1,80}$/u)
        .optional(),
      error: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("design-program-render-result"),
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
      taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
      success: z.boolean(),
      screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u).optional(),
      rootRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u).optional(),
      nativeRootNodeId: z.string().min(1).max(100).optional(),
      nativeBatchId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
      adoptionOperationIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u)).max(200).optional(),
      programFingerprint: z.string().regex(/^dpv1-[a-f0-9]{16}$/u).optional(),
      nativeNodeCount: z.number().int().nonnegative().max(300).optional(),
      visualCaptureEligible: z.boolean().optional(),
      geometryVersion: z.literal(NATIVE_GEOMETRY_VERSION).optional(),
      geometryRepairs: z.number().int().min(0).max(1).optional(),
      geometryDurationMs: z.number().finite().nonnegative().optional(),
      errorCode: z.string().regex(/^[a-z_]{1,80}$/u).optional(),
      findings: z.array(z.object({ code: z.string().regex(/^[a-z0-9_-]{1,80}$/u), path: z.string().max(200), message: z.string().max(240), severity: z.enum(["error", "warning"]) }).strict()).max(20).optional(),
    })
    .strict()
    .superRefine((result, context) => {
      if (result.success && (!result.screenId || !result.rootRef || !result.nativeBatchId || !result.adoptionOperationIds?.length || !result.programFingerprint || result.nativeNodeCount === undefined))
        context.addIssue({ code: "custom", path: [], message: "A successful render result needs complete native ownership evidence." });
      if (!result.success && !result.errorCode)
        context.addIssue({ code: "custom", path: ["errorCode"], message: "A failed render result needs a safe failure code." });
    }),
  z
    .object({
      type: z.literal("task-native-inspection-result"),
      requestId: z.string().min(1).max(100),
      success: z.boolean(),
      taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
      nodes: z.array(TaskNativeNodeSchema).max(500).optional(),
      geometry: NativeGeometryReportSchema.optional(),
      nativePageId: z.string().min(1).max(200).optional(),
      expectedRootStatus: z.enum(["present", "unexpected_parent", "missing", "removed"]).optional(),
      unresolvedRefs: z.array(TaskNativeUnresolvedRefSchema).max(500).optional(),
      truncated: z.boolean().optional(),
      toolStateDiagnostic: FigmaToolStateDiagnosticSchema.optional(),
      error: z.string().max(500).optional(),
    })
    .strict(),
  z.object({
    type: z.literal("task-native-visual-capture-result"),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    success: z.boolean(),
    visualCapture: VisualCaptureTransportV1Schema.optional(),
    receipt: VisualCaptureReceiptV1Schema.optional(),
    exportDurationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  }).strict().superRefine((result, context) => {
    if (result.success && (!result.visualCapture || result.visualCapture.receipt.status !== "CAPTURED"))
      context.addIssue({ code: "custom", path: ["visualCapture"], message: "Successful capture requires bounded PNG bytes and a captured receipt." });
    if (!result.success && (!result.receipt || result.receipt.status === "CAPTURED" || result.visualCapture))
      context.addIssue({ code: "custom", path: ["receipt"], message: "Failed capture requires a non-captured receipt and no PNG bytes." });
    if (result.visualCapture && result.taskId !== result.visualCapture.receipt.taskId)
      context.addIssue({ code: "custom", path: ["taskId"], message: "Capture result task identity must match its receipt." });
    if (result.receipt && result.taskId !== result.receipt.taskId)
      context.addIssue({ code: "custom", path: ["taskId"], message: "Capture failure task identity must match its receipt." });
  }),
  z.object({
    type: z.literal("task-native-visual-repair-result"),
    result: VisualNativeRepairResultV1Schema,
  }).strict(),
  z
    .object({
      type: z.literal("task-native-focus-result"),
      requestId: z.string().min(1).max(100),
      success: z.boolean(),
      nodeIds: z.array(z.string().min(1).max(100)).max(20).optional(),
      error: z.string().max(500).optional(),
    })
    .strict(),
  FigmaToolProgressSchema,
  FigmaToolBatchResultSchema,
  FigmaToolDeleteConsentResultSchema,
  z
    .object({
      type: z.literal("generation-result"),
      warnings: z.array(z.string().max(500)).max(8).optional(),
      requestId: z.string(),
      success: z.boolean(),
      documentId: z.string().optional(),
      generationId: z.string().nullable().optional(),
      nodeId: z.string().optional(),
      logicalRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u).optional(),
      elapsedMs: z.number().nonnegative().optional(),
      error: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("generation-node-progress"),
      requestId: z.string().max(100),
      transactionId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
      screenId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
      sectionId: z.enum(["identity", "primary", "supporting"]),
      nodeId: z.string().min(1).max(100),
      elapsedMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("companion-restore-ticket"),
      ticket: z
        .string()
        .regex(/^FADP1T:[A-Za-z0-9+/]+=*$/u)
        .max(12_000)
        .nullable(),
      storageAvailable: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("companion-restore-ticket-saved"),
      requestId: z.string(),
      success: z.boolean(),
    })
    .strict(),
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
  z
    .object({
      type: z.literal("protocol-error"),
      requestId: z.string().min(1).max(100).optional(),
      message: z.string(),
    })
    .strict(),
  MultiScreenProgressSchema,
  MultiScreenRenderResultSchema,
]);

export type UIToPluginMessage = z.infer<typeof UIToPluginSchema>;
export type PluginToUIMessage = z.infer<typeof PluginToUISchema>;
export type MessageCounts = z.infer<typeof CountsSchema>;
export type FontSelection = z.infer<typeof FontSelectionSchema>;
export type MultiScreenProgressMessage = z.infer<typeof MultiScreenProgressSchema>;
export type MultiScreenRenderResultMessage = z.infer<typeof MultiScreenRenderResultSchema>;
