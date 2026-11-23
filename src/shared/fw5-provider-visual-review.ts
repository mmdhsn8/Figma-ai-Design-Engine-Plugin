import { z } from "zod";

export const FW5_VISUAL_REVIEW_RUBRIC =
  "Review this single Figma screen screenshot for visible clipping, unintended overlap, hierarchy, readability, and RTL issues. Use only the supplied native node IDs. Describe observable evidence and normalized image location. Never infer exact Figma geometry. Only propose fw4-sizing when the supplied native context proves a task-owned frame sizing mismatch; otherwise use none. Return strict JSON.";

export const VisualReviewCapabilityV1Schema = z.object({
  status: z.enum([
    "unsupported",
    "supported",
    "unknown",
    "authorization_required",
    "consent_required",
    "temporarily_unavailable",
  ]),
  provenance: z.enum([
    "provider_result",
    "official_transport_schema",
    "account_authorization",
    "user_consent",
    "unverified_local_assumption",
  ]),
  model: z.string().min(1).max(200).optional(),
  detail: z.string().regex(/^[a-z0-9_]{1,60}$/u).optional(),
}).strict();
export type VisualReviewCapabilityV1 = z.infer<typeof VisualReviewCapabilityV1Schema>;

export function visualReviewCapability(input: {
  authorized: boolean;
  consented: boolean;
  model?: string;
  observed?: "supported" | "unsupported" | "temporarily_unavailable";
}): VisualReviewCapabilityV1 {
  const model = input.model?.slice(0, 200);
  if (!input.authorized)
    return VisualReviewCapabilityV1Schema.parse({ status: "authorization_required", provenance: "account_authorization", ...(model ? { model } : {}) });
  if (!input.consented)
    return VisualReviewCapabilityV1Schema.parse({ status: "consent_required", provenance: "user_consent", ...(model ? { model } : {}) });
  if (input.observed)
    return VisualReviewCapabilityV1Schema.parse({ status: input.observed, provenance: "provider_result", ...(model ? { model } : {}) });
  return VisualReviewCapabilityV1Schema.parse({ status: "unknown", provenance: "unverified_local_assumption", detail: "no_model_modality_metadata", ...(model ? { model } : {}) });
}

const SafeNodeId = z.string().min(1).max(100);
const LayoutMode = z.enum(["FIXED", "HUG", "FILL"]);
const Bounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();

const NativeNode = z.object({
  nodeId: SafeNodeId,
  parentId: SafeNodeId.optional(),
  logicalRef: z.string().min(1).max(120).optional(),
  semanticRole: z.string().min(1).max(60).optional(),
  type: z.enum(["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "COMPONENT", "INSTANCE"]),
  bounds: Bounds,
  visible: z.boolean(),
  clipsContent: z.boolean().optional(),
  overflowDirection: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]).optional(),
  textLength: z.number().int().nonnegative().max(10_000).optional(),
  fontFamily: z.string().min(1).max(100).optional(),
  fontSize: z.number().finite().positive().max(256).optional(),
  layoutSizingHorizontal: LayoutMode.optional(),
  layoutSizingVertical: LayoutMode.optional(),
  textAutoResize: z.enum(["HEIGHT", "WIDTH_AND_HEIGHT"]).optional(),
}).strict();

const ProgramNode = z.object({
  nodeId: SafeNodeId,
  parentNodeId: SafeNodeId.optional(),
  type: z.enum(["container", "text", "rectangle", "ellipse", "vector", "instance", "image"]),
  semanticRole: z.string().min(1).max(60),
  width: z.object({ mode: LayoutMode, value: z.number().finite().positive().max(20_000) }).strict(),
  height: z.object({ mode: LayoutMode, value: z.number().finite().positive().max(20_000) }).strict(),
  textLength: z.number().int().nonnegative().max(5_000).optional(),
  fontSize: z.number().finite().positive().max(96).optional(),
}).strict();

const ReviewContext = z.object({
  viewport: z.object({ width: z.number().int().positive().max(10_000), height: z.number().int().positive().max(10_000) }).strict(),
  scrollIntent: z.enum(["none", "vertical", "horizontal", "both", "unknown"]),
  nodes: z.array(NativeNode).max(80),
  program: z.object({
    programId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/u),
    programRevision: z.number().int().positive().max(1_000_000),
    screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u),
    viewport: z.object({ width: z.number().finite().positive().max(4_000), height: z.number().finite().positive().max(4_000) }).strict(),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u),
    direction: z.enum(["ltr", "rtl"]),
    scrollIntent: z.enum(["none", "vertical", "horizontal"]),
    nodes: z.array(ProgramNode).max(80),
  }).strict(),
}).strict();

const Base64Png = z.string().min(4).max(5_592_408).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const CompanionVisualReviewRequestV1Schema = z.object({
  version: z.literal(1),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
  taskGeneration: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u),
  documentId: z.string().min(1).max(300),
  pageId: z.string().min(1).max(200),
  rootId: SafeNodeId,
  programFingerprint: z.string().regex(/^dpv1-[a-f0-9]{16}$/u),
  readbackRevision: z.string().regex(/^v1-[a-f0-9]{1,8}$/u),
  receiptId: z.string().regex(/^fw5-[A-Za-z0-9_-]{8,100}$/u),
  imageRevision: z.union([z.literal(1), z.literal(2)]),
  provider: z.literal("openai-responses"),
  model: z.string().min(1).max(200),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
  accountScope: z.string().regex(/^[a-f0-9]{64}$/u),
  consentAuthorizationId: z.string().regex(/^fw5_[A-Za-z0-9_-]{8,100}$/u),
  consentImageCount: z.literal(1),
  contentType: z.literal("image/png"),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  byteLength: z.number().int().min(1).max(4 * 1024 * 1024),
  pngBase64: Base64Png,
  rubric: z.literal(FW5_VISUAL_REVIEW_RUBRIC),
  context: ReviewContext,
}).strict().superRefine((value, context) => {
  if (value.width * value.height > 4_194_304)
    context.addIssue({ code: "custom", path: ["width", "height"], message: "Image exceeds the pixel budget." });
  if (!value.context.nodes.some(({ nodeId }) => nodeId === value.rootId))
    context.addIssue({ code: "custom", path: ["context", "nodes"], message: "The authorized root must be present in native context." });
  if (value.context.program.screenId !== value.screenId)
    context.addIssue({ code: "custom", path: ["context", "program", "screenId"], message: "Program screen identity must match." });
});
export type CompanionVisualReviewRequestV1 = z.infer<typeof CompanionVisualReviewRequestV1Schema>;

export const ProviderVisualIssueV1Schema = z.object({
  issueCode: z.enum(["text_clipped", "unintended_overlap", "spacing_inconsistency", "typography_readability", "rtl_shaping_uncertain", "contrast_visual_uncertain", "hierarchy_concern", "asset_mismatch", "native_layout_sizing_mismatch"]),
  severity: z.enum(["info", "warning", "error"]),
  confidence: z.number().min(0).max(1),
  imageLocation: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict(),
  matchedNativeNodeId: SafeNodeId.optional(),
  nodePath: z.string().max(140).optional(),
  evidence: z.string().min(1).max(300),
  proposedAction: z.enum(["none", "fw4-sizing"]),
  property: z.enum(["layoutSizingHorizontal", "layoutSizingVertical"]).optional(),
  expectedValue: LayoutMode.optional(),
  proposedValue: LayoutMode.optional(),
  recheckRequired: z.boolean(),
}).strict().superRefine((issue, context) => {
  if (issue.proposedAction === "fw4-sizing" && (!issue.matchedNativeNodeId || !issue.property || !issue.expectedValue || !issue.proposedValue || !issue.recheckRequired || issue.expectedValue === issue.proposedValue))
    context.addIssue({ code: "custom", path: ["proposedAction"], message: "A sizing suggestion requires a grounded single-axis change and recheck." });
  if (issue.proposedAction === "none" && (issue.property || issue.expectedValue || issue.proposedValue))
    context.addIssue({ code: "custom", path: ["proposedAction"], message: "Non-repair suggestions cannot carry mutation fields." });
});

export const ProviderVisualReviewV1Schema = z.object({
  verdict: z.enum(["pass", "findings", "inconclusive"]),
  confidence: z.number().min(0).max(1),
  reason: z.enum(["none", "low_confidence", "image_unclear", "rtl_uncertain", "content_clipped_intentionally", "unsupported_claim"]).optional(),
  findings: z.array(ProviderVisualIssueV1Schema).max(10),
}).strict().superRefine((result, context) => {
  if (result.verdict === "pass" && (result.findings.length || result.confidence < 0.8))
    context.addIssue({ code: "custom", path: ["verdict"], message: "Pass requires no findings and sufficient confidence." });
  if (result.verdict === "findings" && !result.findings.length)
    context.addIssue({ code: "custom", path: ["findings"], message: "Findings verdict requires at least one issue." });
  if (result.verdict === "inconclusive" && !result.reason)
    context.addIssue({ code: "custom", path: ["reason"], message: "Inconclusive reviews require a reason." });
});
export type ProviderVisualReviewV1 = z.infer<typeof ProviderVisualReviewV1Schema>;

export const CompanionVisualReviewResponseV1Schema = z.object({
  version: z.literal(1),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  model: z.string().min(1).max(200),
  capability: VisualReviewCapabilityV1Schema,
  response: ProviderVisualReviewV1Schema,
}).strict();
