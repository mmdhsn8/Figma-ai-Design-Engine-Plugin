import { z } from "zod";

export const VisualReviewModeSchema = z.enum(["capture-only", "review", "review+bounded-repair"]);
export type VisualReviewMode = z.infer<typeof VisualReviewModeSchema>;

export const FW5_VISUAL_CAPTURE_LIMITS = {
  maxPixelWidth: 2048,
  maxPixelHeight: 2048,
  maxPixels: 4_194_304,
  maxBytes: 4 * 1024 * 1024,
  timeoutMs: 12_000,
  bridgeTimeoutMs: 15_000,
  maxInFlight: 1,
  minExportScale: 0.25,
} as const;

const SafeIdSchema = z.string().min(1).max(100);
const TaskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u);
const ScreenIdSchema = z.string().regex(/^screen-(?:0[1-9]|10)$/u);
const ProgramFingerprintSchema = z.string().regex(/^dpv1-[a-f0-9]{16}$/u);
const ReadbackRevisionSchema = z.string().regex(/^v1-[a-f0-9]{1,8}$/u);
const CaptureNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);
const LayoutModeSchema = z.enum(["FIXED", "HUG", "FILL"]);

export const VisualCaptureScopeSchema = z.object({
  documentId: z.string().min(1).max(300),
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
}).strict();

export const VisualCaptureRequestV1Schema = z.object({
  version: z.literal(1),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  authorizedDocumentScope: VisualCaptureScopeSchema,
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  readbackRevision: ReadbackRevisionSchema,
  captureAttempt: z.union([z.literal(1), z.literal(2)]).default(1),
  previousReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u).optional(),
  maxPixelWidth: z.number().int().min(1).max(FW5_VISUAL_CAPTURE_LIMITS.maxPixelWidth),
  maxPixelHeight: z.number().int().min(1).max(FW5_VISUAL_CAPTURE_LIMITS.maxPixelHeight),
  maxBytes: z.number().int().min(1).max(FW5_VISUAL_CAPTURE_LIMITS.maxBytes),
  deadlineAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  captureNonce: CaptureNonceSchema,
}).strict().superRefine((request, context) => {
  if (request.authorizedDocumentScope.pageId !== request.pageId)
    context.addIssue({ code: "custom", path: ["authorizedDocumentScope", "pageId"], message: "Capture page must match the authorized page scope." });
  if (request.authorizedDocumentScope.rootId !== request.rootId)
    context.addIssue({ code: "custom", path: ["authorizedDocumentScope", "rootId"], message: "Capture root must match the authorized root scope." });
  if ((request.captureAttempt === 1 && request.previousReceiptId !== undefined) ||
      (request.captureAttempt === 2 && request.previousReceiptId === undefined))
    context.addIssue({ code: "custom", path: ["previousReceiptId"], message: "Recheck captures must be explicitly linked to a pre-repair receipt." });
});
export type VisualCaptureRequestV1 = z.infer<typeof VisualCaptureRequestV1Schema>;

export const VisualCaptureStatusSchema = z.enum(["CAPTURED", "CAPTURE_FAILED", "UNVERIFIED"]);
export const VisualCaptureReceiptV1Schema = z.object({
  version: z.literal(1),
  status: VisualCaptureStatusSchema,
  receiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  documentId: z.string().min(1).max(300),
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  readbackRevision: ReadbackRevisionSchema,
  mime: z.literal("image/png"),
  width: z.number().int().nonnegative().max(FW5_VISUAL_CAPTURE_LIMITS.maxPixelWidth),
  height: z.number().int().nonnegative().max(FW5_VISUAL_CAPTURE_LIMITS.maxPixelHeight),
  byteLength: z.number().int().nonnegative().max(FW5_VISUAL_CAPTURE_LIMITS.maxBytes),
  contentDigest: z.string().regex(/^fnv1a64-[a-f0-9]{16}$/u).optional(),
  capturedAtMs: z.number().int().nonnegative(),
  exportScale: z.number().finite().positive().max(1),
  captureAttempt: z.union([z.literal(1), z.literal(2)]),
  previousReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u).optional(),
  frameBounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional(),
  visibleBounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict().optional(),
  clipsContent: z.boolean().optional(),
  overflowDirection: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]).optional(),
  scrollIntent: z.enum(["none", "vertical", "horizontal", "both", "unknown"]).optional(),
  diagnostic: z.enum([
    "none", "gate_disabled", "identity_mismatch", "readback_stale", "root_reused_or_recovered",
    "export_unsupported", "export_failed", "empty_png", "invalid_png", "capture_limit_exceeded",
    "capture_deadline_exceeded", "capture_cancelled", "capture_in_flight_limit", "capture_transport_unavailable", "visual_review_unavailable",
  ]),
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "CAPTURED" && (receipt.byteLength === 0 || receipt.width === 0 || receipt.height === 0 || receipt.diagnostic !== "none"))
    context.addIssue({ code: "custom", path: ["status"], message: "A captured receipt requires valid nonempty PNG evidence." });
  if (receipt.status !== "CAPTURED" && receipt.contentDigest !== undefined)
    context.addIssue({ code: "custom", path: ["contentDigest"], message: "Failed captures cannot carry a PNG content digest." });
});
export type VisualCaptureReceiptV1 = z.infer<typeof VisualCaptureReceiptV1Schema>;

export const VisualCaptureTransportV1Schema = z.object({
  receipt: VisualCaptureReceiptV1Schema,
  pngBytes: z.custom<Uint8Array<ArrayBuffer>>(
    (value): value is Uint8Array<ArrayBuffer> => value instanceof Uint8Array &&
      value.buffer instanceof ArrayBuffer && value.byteLength > 0 && value.byteLength <= FW5_VISUAL_CAPTURE_LIMITS.maxBytes,
  ),
}).strict();
export type VisualCaptureTransportV1 = z.infer<typeof VisualCaptureTransportV1Schema>;

export const VisualQualityFindingV1Schema = z.object({
  findingId: z.string().regex(/^fw5f-[a-f0-9]{8}$/u),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  issueCode: z.enum([
    "native_geometry_finding", "design_program_mismatch", "visual_capture_unavailable",
    "visual_review_unavailable", "visual_claim_unverified", "native_readback_incomplete",
    "native_layout_sizing_mismatch",
    "text_clipped", "unintended_overlap", "spacing_inconsistency", "typography_readability",
    "rtl_shaping_uncertain", "contrast_visual_uncertain", "hierarchy_concern", "asset_mismatch",
  ]),
  source: z.enum(["native-rule", "pixel-review", "human"]),
  evidenceSource: z.enum(["image", "native-readback", "image+native-readback"]),
  severity: z.enum(["info", "warning", "error"]),
  evidenceRef: z.string().min(1).max(140),
  evidence: z.string().min(1).max(300).optional(),
  nodeId: SafeIdSchema.optional(),
  nodePath: z.string().max(140).optional(),
  imageLocation: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict().optional(),
  recheckRequired: z.boolean().optional(),
  bounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict().optional(),
  confidence: z.number().min(0).max(1).optional(),
  uncertain: z.boolean(),
  safeToAutoRepair: z.boolean(),
  resolution: z.enum(["repaired", "confirmed_after_recheck", "unrepaired"]).optional(),
  suggestedRepairCategory: z.enum(["layout-sizing", "contrast-token", "none"]).optional(),
  proposedAction: z.object({
    kind: z.literal("fw4-sizing"),
    targetNodeId: SafeIdSchema,
    property: z.enum(["layoutSizingHorizontal", "layoutSizingVertical"]),
    expectedValue: z.enum(["FIXED", "HUG", "FILL"]),
    proposedValue: z.enum(["FIXED", "HUG", "FILL"]),
  }).strict().optional(),
  unrepairableReason: z.enum(["not_deterministic", "unsupported_property", "user_edit_possible", "reference_reuse", "insufficient_evidence", "fw4_gate_off"]).optional(),
}).strict();
export type VisualQualityFindingV1 = z.infer<typeof VisualQualityFindingV1Schema>;
const VisualReviewFindingV1Schema = VisualQualityFindingV1Schema.omit({ resolution: true });

const ReviewContextNodeV1Schema = z.object({
  nodeId: SafeIdSchema,
  parentId: SafeIdSchema.optional(),
  logicalRef: z.string().min(1).max(120).optional(),
  semanticRole: z.string().min(1).max(60).optional(),
  type: z.enum(["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "COMPONENT", "INSTANCE"]),
  bounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict(),
  visible: z.boolean(),
  clipsContent: z.boolean().optional(),
  overflowDirection: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]).optional(),
  textLength: z.number().int().nonnegative().max(10_000).optional(),
  fontFamily: z.string().min(1).max(100).optional(),
  fontSize: z.number().finite().positive().max(256).optional(),
  layoutSizingHorizontal: LayoutModeSchema.optional(),
  layoutSizingVertical: LayoutModeSchema.optional(),
  textAutoResize: z.enum(["HEIGHT", "WIDTH_AND_HEIGHT"]).optional(),
}).strict();

const ReviewProgramNodeV1Schema = z.object({
  nodeId: SafeIdSchema,
  parentNodeId: SafeIdSchema.optional(),
  type: z.enum(["container", "text", "rectangle", "ellipse", "vector", "instance", "image"]),
  semanticRole: z.string().min(1).max(60),
  width: z.object({ mode: LayoutModeSchema, value: z.number().finite().positive().max(20_000) }).strict(),
  height: z.object({ mode: LayoutModeSchema, value: z.number().finite().positive().max(20_000) }).strict(),
  textLength: z.number().int().nonnegative().max(5_000).optional(),
  fontSize: z.number().finite().positive().max(96).optional(),
}).strict();

const ReviewProgramContextV1Schema = z.object({
  programId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/u),
  programRevision: z.number().int().positive().max(1_000_000),
  screenId: ScreenIdSchema,
  viewport: z.object({ width: z.number().finite().positive().max(4_000), height: z.number().finite().positive().max(4_000) }).strict(),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u),
  direction: z.enum(["ltr", "rtl"]),
  scrollIntent: z.enum(["none", "vertical", "horizontal"]),
  nodes: z.array(ReviewProgramNodeV1Schema).max(80),
}).strict();

export const VisualReviewGrantV1Schema = z.object({
  version: z.literal(1),
  authorized: z.literal(true),
  recipient: z.enum(["authorized-local-human", "authorized-image-provider"]),
  authorizationId: CaptureNonceSchema,
  taskId: TaskIdSchema,
  taskGeneration: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
  screenId: ScreenIdSchema,
  documentId: z.string().min(1).max(300),
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  readbackRevision: ReadbackRevisionSchema,
  receiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  imageRevision: z.union([z.literal(1), z.literal(2)]).optional(),
  provider: z.literal("openai-responses").optional(),
  model: z.string().min(1).max(200).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u).optional(),
  accountScope: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  consentImageCount: z.literal(1).optional(),
}).strict();
export type VisualReviewGrantV1 = z.infer<typeof VisualReviewGrantV1Schema>;

export const VisualReviewCapabilitiesV1Schema = z.object({
  version: z.literal(1),
  kind: z.enum(["vision", "human"]),
  acceptsPng: z.literal(true),
  maxBytes: z.number().int().min(1).max(FW5_VISUAL_CAPTURE_LIMITS.maxBytes),
  maxFindings: z.number().int().min(1).max(20),
}).strict();
export type VisualReviewCapabilitiesV1 = z.infer<typeof VisualReviewCapabilitiesV1Schema>;

export const VisualReviewRequestV1Schema = z.object({
  version: z.literal(1),
  requestId: CaptureNonceSchema,
  taskId: TaskIdSchema,
  taskGeneration: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  screenId: ScreenIdSchema,
  documentId: z.string().min(1).max(300),
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  readbackRevision: ReadbackRevisionSchema,
  receiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  imageRevision: z.union([z.literal(1), z.literal(2)]),
  viewport: z.object({ width: z.number().int().positive().max(10_000), height: z.number().int().positive().max(10_000) }).strict(),
  scrollIntent: z.enum(["none", "vertical", "horizontal", "both", "unknown"]),
  nodes: z.array(ReviewContextNodeV1Schema).max(80),
  program: ReviewProgramContextV1Schema,
  pngBytes: z.custom<Uint8Array<ArrayBuffer>>(
    (value): value is Uint8Array<ArrayBuffer> => value instanceof Uint8Array && value.buffer instanceof ArrayBuffer &&
      value.byteLength > 0 && value.byteLength <= FW5_VISUAL_CAPTURE_LIMITS.maxBytes,
  ),
}).strict();
export type VisualReviewRequestV1 = z.infer<typeof VisualReviewRequestV1Schema>;

export const VisualReviewResponseV1Schema = z.object({
  version: z.literal(1),
  requestId: CaptureNonceSchema,
  receiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  rootId: SafeIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  readbackRevision: ReadbackRevisionSchema,
  kind: z.enum(["vision", "human"]),
  verdict: z.enum(["pass", "findings", "inconclusive"]),
  confidence: z.number().min(0).max(1),
  reason: z.enum(["none", "low_confidence", "image_unclear", "rtl_uncertain", "content_clipped_intentionally", "unsupported_claim"]).optional(),
  findings: z.array(VisualReviewFindingV1Schema).max(20),
}).strict();
export type VisualReviewResponseV1 = z.infer<typeof VisualReviewResponseV1Schema>;

export const VisualRepairProposalV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().regex(/^fw5-repair-[A-Za-z0-9_-]{8,100}$/u),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  readbackRevision: ReadbackRevisionSchema,
  captureReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  findingId: z.string().regex(/^fw5f-[a-f0-9]{8}$/u),
  targetNodeId: SafeIdSchema,
  expectedParentId: SafeIdSchema,
  targetType: z.literal("FRAME"),
  property: z.enum(["layoutSizingHorizontal", "layoutSizingVertical"]),
  expectedValue: z.enum(["FIXED", "HUG", "FILL"]),
  proposedValue: z.enum(["FIXED", "HUG", "FILL"]),
  source: z.literal("fw4-sizing-convergence"),
}).strict().superRefine((proposal, context) => {
  if (proposal.expectedValue === proposal.proposedValue)
    context.addIssue({ code: "custom", path: ["proposedValue"], message: "A repair proposal must change a mismatched value." });
});
export type VisualRepairProposalV1 = z.infer<typeof VisualRepairProposalV1Schema>;

export const VisualNativeRepairRequestV1Schema = z.object({
  version: z.literal(1),
  requestId: CaptureNonceSchema,
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  documentId: z.string().min(1).max(300),
  pageId: z.string().min(1).max(200),
  rootId: SafeIdSchema,
  rootRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u),
  programFingerprint: ProgramFingerprintSchema,
  captureReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  deadlineAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  proposal: VisualRepairProposalV1Schema,
}).strict().superRefine((request, context) => {
  const proposal = request.proposal;
  if (request.taskId !== proposal.taskId || request.screenId !== proposal.screenId || request.pageId !== proposal.pageId ||
      request.rootId !== proposal.rootId || request.programFingerprint !== proposal.programFingerprint ||
      request.captureReceiptId !== proposal.captureReceiptId)
    context.addIssue({ code: "custom", path: ["proposal"], message: "Repair request and proposal identity must match." });
});
export type VisualNativeRepairRequestV1 = z.infer<typeof VisualNativeRepairRequestV1Schema>;

export const VisualNativeRepairResultV1Schema = z.object({
  version: z.literal(1),
  requestId: CaptureNonceSchema,
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  rootId: SafeIdSchema,
  captureReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  status: z.enum(["APPLIED", "REJECTED"]),
  reason: z.enum(["none", "gate_disabled", "mode_disabled", "root_not_fresh", "identity_mismatch", "stale_readback", "unsupported_repair", "repair_already_used", "repair_in_flight_limit", "correction_failed", "readback_failed", "cancelled"]),
  readbackRevision: ReadbackRevisionSchema.optional(),
  targetNodeId: SafeIdSchema.optional(),
  property: z.enum(["layoutSizingHorizontal", "layoutSizingVertical"]).optional(),
}).strict().superRefine((result, context) => {
  if (result.status === "APPLIED" && (!result.readbackRevision || !result.targetNodeId || !result.property || result.reason !== "none"))
    context.addIssue({ code: "custom", path: ["status"], message: "Applied repairs require a target and fresh native readback." });
  if (result.status === "REJECTED" && result.reason === "none")
    context.addIssue({ code: "custom", path: ["reason"], message: "Rejected repairs require a diagnostic reason." });
});
export type VisualNativeRepairResultV1 = z.infer<typeof VisualNativeRepairResultV1Schema>;

/** Caller must possess an explicit, request-scoped grant before calling; no provider is installed by FW-5. */
export interface VisualReviewerV1 {
  capabilities(): unknown | Promise<unknown>;
  review(request: VisualReviewRequestV1, grant: VisualReviewGrantV1, signal: AbortSignal): unknown | Promise<unknown>;
}

/** One non-retrying review boundary with strict identity, node-grounding, and response validation. */
export async function runVisualReviewerV1(
  reviewer: VisualReviewerV1,
  requestInput: unknown,
  grantInput: unknown,
  signal: AbortSignal,
): Promise<VisualReviewResponseV1> {
  const request = VisualReviewRequestV1Schema.parse(requestInput);
  const grant = VisualReviewGrantV1Schema.parse(grantInput);
  if (grant.taskId !== request.taskId || grant.screenId !== request.screenId || grant.documentId !== request.documentId ||
      grant.pageId !== request.pageId || grant.rootId !== request.rootId || grant.programFingerprint !== request.programFingerprint ||
      grant.readbackRevision !== request.readbackRevision || grant.receiptId !== request.receiptId)
    throw new Error("Visual review grant does not match the capture identity.");
  if ((grant.taskGeneration !== undefined && grant.taskGeneration !== request.taskGeneration) ||
      (grant.imageRevision !== undefined && grant.imageRevision !== request.imageRevision) ||
      (grant.consentImageCount !== undefined && grant.consentImageCount !== 1))
    throw new Error("Visual review grant does not match the task generation or one-image scope.");
  if (request.program.screenId !== request.screenId || !request.nodes.some(({ nodeId }) => nodeId === request.rootId))
    throw new Error("Visual review context does not match the captured screen and native root.");
  if (signal.aborted) throw new Error("Visual review was cancelled.");
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 12_000);
  const bounded = async <T>(promise: Promise<T>) => Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Visual review was cancelled or timed out.")), { once: true })),
  ]);
  try {
    const capabilities = VisualReviewCapabilitiesV1Schema.parse(await bounded(Promise.resolve(reviewer.capabilities())));
    if (signal.aborted) throw new Error("Visual review was cancelled.");
    if (request.pngBytes.byteLength > capabilities.maxBytes) throw new Error("Visual review image exceeds the adapter byte budget.");
    const raw = await bounded(Promise.resolve(reviewer.review(request, grant, controller.signal)));
    if (signal.aborted || controller.signal.aborted) throw new Error("Visual review was cancelled or timed out.");
    const response = VisualReviewResponseV1Schema.parse(raw);
    if (response.requestId !== request.requestId || response.receiptId !== request.receiptId || response.taskId !== request.taskId ||
        response.screenId !== request.screenId || response.rootId !== request.rootId || response.programFingerprint !== request.programFingerprint ||
        response.readbackRevision !== request.readbackRevision || response.kind !== capabilities.kind)
      throw new Error("Visual review response does not match the requested evidence.");
    if (response.findings.length > capabilities.maxFindings)
      throw new Error("Visual review response exceeds the adapter finding budget.");
    if ((response.verdict === "pass" && (response.findings.length !== 0 || response.confidence < 0.8)) ||
        (response.verdict === "findings" && response.findings.length === 0) ||
        (response.verdict === "inconclusive" && !response.reason))
      throw new Error("Visual review verdict is inconsistent or does not meet the confidence threshold.");
    const nativeNodeIds = new Set(request.nodes.map(({ nodeId }) => nodeId));
    for (const finding of response.findings) {
      if (finding.taskId !== request.taskId || finding.screenId !== request.screenId)
        throw new Error("Visual review finding does not match the task and screen.");
      if (capabilities.kind === "vision" && finding.source !== "pixel-review") throw new Error("Vision findings must use pixel-review evidence.");
      if (capabilities.kind === "human" && finding.source !== "human") throw new Error("Human findings must use human evidence.");
      if (finding.source === "pixel-review" && finding.evidenceSource === "native-readback")
        throw new Error("Pixel review findings must include image evidence.");
      if (finding.source === "native-rule" && finding.evidenceSource === "image")
        throw new Error("Native-rule findings must include native readback evidence.");
      if (finding.nodeId && !nativeNodeIds.has(finding.nodeId)) throw new Error("Visual review finding references an unknown native node.");
      if (finding.proposedAction && (finding.proposedAction.targetNodeId !== finding.nodeId || !finding.safeToAutoRepair ||
          finding.suggestedRepairCategory !== "layout-sizing"))
        throw new Error("Visual review repair action is not grounded in its finding.");
      if (finding.bounds) {
        const { x, y, width, height } = finding.bounds;
        if (x < 0 || y < 0 || x + width > request.viewport.width || y + height > request.viewport.height)
          throw new Error("Visual review finding bounds exceed the reviewed viewport.");
      }
    }
    return response;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", relayAbort);
  }
}

export const VisualQaOutcomeV1Schema = z.object({
  version: z.literal(1),
  status: z.enum(["PASS", "FINDINGS", "UNVERIFIED", "CAPTURE_FAILED", "REPAIR_BLOCKED", "RECHECK_FAILED", "CAPTURED", "REVIEW_UNAVAILABLE", "REVIEW_INCONCLUSIVE", "REVIEW_FAILED", "ISSUES_DETECTED", "REPAIR_APPLIED", "RECHECK_PENDING", "VISUAL_QA_PASSED"]),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  programFingerprint: ProgramFingerprintSchema,
  rootId: SafeIdSchema,
  pageId: z.string().min(1).max(200),
  readbackRevision: ReadbackRevisionSchema.optional(),
  nativeGeometry: z.enum(["PASS", "FINDINGS", "UNVERIFIED"]),
  designProgramConsistency: z.enum(["PASS", "FINDINGS", "UNVERIFIED"]),
  visualCapture: z.enum(["CAPTURED", "CAPTURE_FAILED", "UNVERIFIED", "NOT_REQUESTED"]),
  visualReview: z.enum(["REVIEWED", "VISUAL_REVIEW_UNAVAILABLE", "VISUAL_REVIEW_INCONCLUSIVE", "VISUAL_REVIEW_FAILED", "VISUAL_REVIEW_CONSENT_REQUIRED", "VISUAL_REVIEW_UNSUPPORTED", "VISUAL_REVIEW_AUTHORIZATION_REQUIRED", "VISUAL_REVIEW_TEMPORARILY_UNAVAILABLE", "NOT_REQUESTED"]),
  reviewMode: VisualReviewModeSchema,
  beforeReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u).optional(),
  afterReceiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u).optional(),
  captureReceipt: VisualCaptureReceiptV1Schema.optional(),
  findingCounts: z.object({ nativeRule: z.number().int().min(0).max(20), pixelReview: z.number().int().min(0).max(20), human: z.number().int().min(0).max(20) }).strict(),
  repair: z.object({
    status: z.enum(["NOT_REQUIRED", "REPAIR_BLOCKED", "APPLIED", "RECHECK_FAILED"]),
    attempts: z.number().int().min(0).max(1),
    reason: z.enum(["none", "capture_only_policy", "reviewer_unavailable", "no_safe_proposal", "fresh_root_required", "fw4_gate_off", "stop_or_stale_task", "correction_failed", "readback_failed", "repair_executor_unavailable", "recheck_unavailable", "stale_readback"]),
    method: z.enum(["none", "fw4-sizing-convergence"]).optional(),
  }).strict(),
  findings: z.array(VisualQualityFindingV1Schema).max(20),
  diagnostics: z.object({
    payloadBytes: z.number().int().nonnegative().max(FW5_VISUAL_CAPTURE_LIMITS.maxBytes).optional(),
    exportMs: z.number().int().nonnegative().max(86_400_000).optional(),
    nativeReadbackMs: z.number().int().nonnegative().max(86_400_000).optional(),
    reviewerCalls: z.number().int().min(0).max(2),
    reviewerDurationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    repairAttempts: z.number().int().min(0).max(1).optional(),
    repairMethods: z.array(z.enum(["layoutSizingHorizontal", "layoutSizingVertical"])).max(2),
    failureReason: z.string().max(100).optional(),
  }).strict(),
}).strict();
export type VisualQaOutcomeV1 = z.infer<typeof VisualQaOutcomeV1Schema>;

export function planVisualCaptureScale(width: number, height: number, limits: { maxPixelWidth: number; maxPixelHeight: number; maxPixels: number; minExportScale: number } = FW5_VISUAL_CAPTURE_LIMITS): number | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) return undefined;
  const scale = Math.min(1, limits.maxPixelWidth / width, limits.maxPixelHeight / height, Math.sqrt(limits.maxPixels / (width * height)));
  const roundedDown = Math.floor(scale * 100) / 100;
  return roundedDown >= limits.minExportScale ? roundedDown : undefined;
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 57 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71 ||
      bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10 ||
      bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return undefined;
  const readU32 = (offset: number) => bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000 + bytes[offset + 2]! * 0x100 + bytes[offset + 3]!;
  if (readU32(8) !== 13) return undefined;
  let hasImageData = false;
  let complete = false;
  for (let offset = 8; offset + 12 <= bytes.byteLength;) {
    const length = readU32(offset);
    const next = offset + 12 + length;
    if (next > bytes.byteLength) return undefined;
    const type = readU32(offset + 4);
    if (type === 0x49444154 && length > 0) hasImageData = true; // IDAT
    if (type === 0x49454e44) { // IEND
      complete = length === 0 && next === bytes.byteLength;
      break;
    }
    if (offset !== 8 && type === 0x49484452) return undefined; // Duplicate IHDR
    offset = next;
  }
  if (!hasImageData || !complete) return undefined;
  const width = readU32(16);
  const height = readU32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Non-cryptographic FNV-1a checksum; identifies the transient PNG without persisting its bytes. */
export function visualContentDigest(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64-${hash.toString(16).padStart(16, "0")}`;
}

export function visualFindingId(issueCode: string, rootId: string, nodeId = ""): string {
  const value = `${issueCode}\u0000${rootId}\u0000${nodeId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  return `fw5f-${hash.toString(16).padStart(8, "0")}`;
}
