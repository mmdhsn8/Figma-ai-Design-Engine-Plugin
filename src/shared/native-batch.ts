import { z } from "zod";
import { CHAT_TASK_MAX_BYTES } from "./chat-task";
import { DESIGN_PROGRAM_LIMITS, parseDesignProgram, type DesignProgramNode, type DesignProgramV1 } from "./design-program";
import { programPageColor } from "./design-program-quality";
import { programTextAutoResize } from "./program-text-layout";
import { utf8Bytes } from "./generation-limits";
import { FW3_NATIVE_BATCH_ENABLED } from "./native-batch-feature";

const BatchIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);
const TaskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u);
const ScreenIdSchema = z.string().regex(/^screen-(?:0[1-9]|10)$/u);
const OpIdSchema = z.string().regex(/^op-[0-9]{3,4}$/u);
const NodeIdSchema = z.string().trim().min(1).max(100);
const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const DimensionSchema = z.number().finite().min(1).max(20_000);
const SizingSchema = z.enum(["fixed", "hug", "fill"]);
const PaddingSchema = z.object({
  top: z.number().finite().min(0).max(2_000),
  right: z.number().finite().min(0).max(2_000),
  bottom: z.number().finite().min(0).max(2_000),
  left: z.number().finite().min(0).max(2_000),
}).strict();

export const NATIVE_BATCH_LIMITS = {
  maxOperations: DESIGN_PROGRAM_LIMITS.nodes * 2,
  maxCreations: 200,
  maxPayloadBytes: CHAT_TASK_MAX_BYTES,
  maxDepth: DESIGN_PROGRAM_LIMITS.depth,
  timeoutMs: 60_000,
  maxInFlightWrites: 1,
} as const;

export const SafeNodeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("within-batch"), opId: OpIdSchema }).strict(),
  z.object({ kind: z.literal("task-owned"), nodeId: NodeIdSchema, expectedParentId: NodeIdSchema.optional() }).strict(),
]);
export type SafeNodeRef = z.infer<typeof SafeNodeRefSchema>;

const FrameSpecSchema = z.object({
  name: z.string().trim().min(1).max(160),
  width: DimensionSchema,
  height: DimensionSchema,
  widthSizing: SizingSchema,
  heightSizing: SizingSchema,
}).strict();
const TextSpecSchema = z.object({
  name: z.string().trim().min(1).max(160),
  text: z.string().max(500),
  width: DimensionSchema,
  height: DimensionSchema,
  widthSizing: SizingSchema,
  heightSizing: SizingSchema,
  fontFamily: z.string().trim().min(1).max(100),
  fontStyle: z.string().trim().min(1).max(80),
  fontSize: z.number().finite().min(1).max(256),
  textAlign: z.enum(["left", "center", "right", "justified"]),
  textAutoResize: z.enum(["height", "width-and-height"]),
}).strict();
const ShapeSpecSchema = z.object({
  name: z.string().trim().min(1).max(160),
  shape: z.enum(["rectangle", "ellipse"]),
  width: DimensionSchema,
  height: DimensionSchema,
  widthSizing: SizingSchema,
  heightSizing: SizingSchema,
  cornerRadius: z.number().finite().min(0).max(1_000).optional(),
}).strict();
const LayoutSpecSchema = z.object({
  axis: z.enum(["horizontal", "vertical"]),
  gap: z.number().finite().min(0).max(2_000),
  padding: PaddingSchema,
  primaryAlign: z.enum(["start", "center", "end", "space-between"]),
  counterAlign: z.enum(["start", "center", "end", "stretch", "baseline"]),
  childrenSizing: z.array(z.object({
    target: SafeNodeRefSchema,
    width: SizingSchema,
    height: SizingSchema,
  }).strict()).max(DESIGN_PROGRAM_LIMITS.children),
}).strict();
const PaintSpecSchema = z.object({
  fills: z.array(z.object({ kind: z.literal("solid"), color: ColorSchema, opacity: z.number().finite().min(0).max(1).optional() }).strict()).max(1),
}).strict();

const CreateFrameSchema = z.object({ kind: z.literal("create-frame"), opId: OpIdSchema, parent: SafeNodeRefSchema, spec: FrameSpecSchema }).strict();
const CreateTextSchema = z.object({ kind: z.literal("create-text"), opId: OpIdSchema, parent: SafeNodeRefSchema, spec: TextSpecSchema }).strict();
const CreateShapeSchema = z.object({ kind: z.literal("create-shape"), opId: OpIdSchema, parent: SafeNodeRefSchema, spec: ShapeSpecSchema }).strict();
const SetLayoutSchema = z.object({ kind: z.literal("set-layout"), opId: OpIdSchema, target: SafeNodeRefSchema, spec: LayoutSpecSchema }).strict();
const SetPaintSchema = z.object({ kind: z.literal("set-paint"), opId: OpIdSchema, target: SafeNodeRefSchema, spec: PaintSpecSchema }).strict();

export const SafeNativeOpSchema = z.discriminatedUnion("kind", [
  CreateFrameSchema,
  CreateTextSchema,
  CreateShapeSchema,
  SetLayoutSchema,
  SetPaintSchema,
]);
export type SafeNativeOp = z.infer<typeof SafeNativeOpSchema>;

export const NativeBatchRequestV1Schema = z.object({
  version: z.literal(1),
  taskId: TaskIdSchema,
  screenId: ScreenIdSchema,
  checkpointFingerprint: z.string().regex(/^dpv1-[a-f0-9]{16}$/u),
  batchId: BatchIdSchema,
  requestedPageId: NodeIdSchema,
  authorizedRootId: NodeIdSchema,
  operations: z.array(SafeNativeOpSchema).min(1).max(NATIVE_BATCH_LIMITS.maxOperations),
}).strict();
export type NativeBatchRequestV1 = z.infer<typeof NativeBatchRequestV1Schema>;

export const NativeBatchReceiptV1Schema = z.object({
  version: z.literal(1),
  batchId: BatchIdSchema,
  status: z.enum(["verified", "partial", "unverified", "rejected"]),
  stage: z.enum(["accepted", "applied", "readback-confirmed", "checkpoint-confirmed"]),
  appliedOpIds: z.array(OpIdSchema).max(NATIVE_BATCH_LIMITS.maxOperations),
  confirmedNodeIds: z.record(OpIdSchema, NodeIdSchema),
  rootNodeId: NodeIdSchema.optional(),
  errors: z.array(z.object({
    code: z.enum([
      "invalid_schema", "payload_too_large", "too_many_creations", "duplicate_op_id",
      "forward_reference", "missing_reference", "unauthorized_parent", "cross_page_reference",
      "stale_task", "task_stopped", "stale_page", "stale_root", "stale_checkpoint", "stale_batch",
      "unsupported_operation", "native_apply_failed", "readback_failed", "checkpoint_failed",
    ]),
    opId: OpIdSchema.optional(),
    details: z.string().max(240).optional(),
  }).strict()).max(32),
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "verified" && (receipt.stage !== "checkpoint-confirmed" || !receipt.rootNodeId))
    context.addIssue({ code: "custom", path: ["stage"], message: "Verified requires a checkpoint-confirmed root." });
  if (receipt.status === "rejected" && receipt.appliedOpIds.length > 0)
    context.addIssue({ code: "custom", path: ["appliedOpIds"], message: "A rejected batch cannot claim applied operations." });
});
export type NativeBatchReceiptV1 = z.infer<typeof NativeBatchReceiptV1Schema>;

export type NativeBatchAdmissionContext = {
  taskId: string;
  screenId: string;
  checkpointFingerprint: string;
  batchId: string;
  taskState: "active" | "stopped";
  currentPageId: string;
  root: { nodeId: string; taskId: string; pageId: string; parentId: string; attached: boolean } | null;
};

export type NativeBatchErrorCode =
  | "invalid_schema" | "payload_too_large" | "too_many_creations" | "duplicate_op_id"
  | "forward_reference" | "missing_reference" | "unauthorized_parent" | "cross_page_reference"
  | "stale_task" | "task_stopped" | "stale_page" | "stale_root" | "stale_checkpoint" | "stale_batch"
  | "unsupported_operation";
export type NativeBatchValidation =
  | { success: true; request: NativeBatchRequestV1; serializedBytes: number; creationCount: number }
  | { success: false; code: NativeBatchErrorCode; opId?: string; details: string };

function fail(code: NativeBatchErrorCode, details: string, opId?: string): NativeBatchValidation {
  return { success: false, code, ...(opId ? { opId } : {}), details: details.slice(0, 240) };
}

function refSites(op: SafeNativeOp): SafeNodeRef[] {
  switch (op.kind) {
    case "create-frame":
    case "create-text":
    case "create-shape": return [op.parent];
    case "set-layout": return [op.target, ...op.spec.childrenSizing.map(({ target }) => target)];
    case "set-paint": return [op.target];
  }
}

function isCreate(op: SafeNativeOp): op is Extract<SafeNativeOp, { kind: "create-frame" | "create-text" | "create-shape" }> {
  return op.kind === "create-frame" || op.kind === "create-text" || op.kind === "create-shape";
}

/** Strict validation to run at both an adapter boundary and an untrusted plugin boundary. */
export function validateNativeBatchRequest(input: unknown, context: NativeBatchAdmissionContext): NativeBatchValidation {
  const parsed = NativeBatchRequestV1Schema.safeParse(input);
  if (!parsed.success) return fail("invalid_schema", "The native batch does not match the version 1 allowlist.");
  const request = parsed.data;
  const serialized = JSON.stringify(request);
  const serializedBytes = utf8Bytes(serialized);
  if (serializedBytes > NATIVE_BATCH_LIMITS.maxPayloadBytes)
    return fail("payload_too_large", "The serialized batch exceeds the existing task checkpoint byte budget.");
  if (request.taskId !== context.taskId || request.screenId !== context.screenId)
    return fail("stale_task", "The task or screen identity no longer matches the active checkpoint.");
  if (context.taskState !== "active") return fail("task_stopped", "The owning task is stopped; no batch may be applied.");
  if (request.requestedPageId !== context.currentPageId)
    return fail("stale_page", "The requested Figma page is no longer active.");
  if (request.checkpointFingerprint !== context.checkpointFingerprint)
    return fail("stale_checkpoint", "The saved screen program no longer matches this batch.");
  if (request.batchId !== context.batchId)
    return fail("stale_batch", "The batch id is not the active request for this transaction.");
  const root = context.root;
  if (!root || !root.attached || root.nodeId !== request.authorizedRootId || root.taskId !== request.taskId)
    return fail("stale_root", "The authorized root is missing, detached, or owned by another task.");
  if (root.pageId !== request.requestedPageId || root.parentId !== request.requestedPageId)
    return fail("cross_page_reference", "The authorized root is outside the requested page.");

  const opIndexes = new Map<string, number>();
  const creates = new Set<string>();
  for (const [index, op] of request.operations.entries()) {
    if (opIndexes.has(op.opId))
      return fail("duplicate_op_id", "Operation ids must be unique within a batch.", op.opId);
    opIndexes.set(op.opId, index);
    if (isCreate(op)) creates.add(op.opId);
  }
  let creationCount = 0;
  for (let index = 0; index < request.operations.length; index++) {
    const op = request.operations[index]!;
    if (isCreate(op)) creationCount++;
    for (const ref of refSites(op)) {
      if (ref.kind === "task-owned") {
        if (ref.nodeId !== request.authorizedRootId)
          return fail("unauthorized_parent", "Version 1 may address only this screen's authorized root.", op.opId);
        if (ref.expectedParentId && ref.expectedParentId !== request.requestedPageId)
          return fail("cross_page_reference", "A task-owned reference names a different parent page.", op.opId);
        continue;
      }
      const targetIndex = opIndexes.get(ref.opId);
      if (targetIndex === undefined || !creates.has(ref.opId))
        return fail("missing_reference", "A reference must name an earlier creation in this batch.", op.opId);
      if (targetIndex >= index)
        return fail("forward_reference", "A reference may point only to an earlier successful creation.", op.opId);
    }
  }
  if (creationCount > NATIVE_BATCH_LIMITS.maxCreations)
    return fail("too_many_creations", "The batch exceeds the existing Universal task native node budget.");
  return { success: true, request, serializedBytes, creationCount };
}

export function serializeNativeBatchRequest(input: unknown): { success: true; json: string; bytes: number } | { success: false; code: "invalid_schema" | "payload_too_large" } {
  const parsed = NativeBatchRequestV1Schema.safeParse(input);
  if (!parsed.success) return { success: false, code: "invalid_schema" };
  const json = JSON.stringify(parsed.data);
  const bytes = utf8Bytes(json);
  return bytes > NATIVE_BATCH_LIMITS.maxPayloadBytes
    ? { success: false, code: "payload_too_large" }
    : { success: true, json, bytes };
}

export function parseNativeBatchJson(json: string): { success: true; request: NativeBatchRequestV1 } | { success: false; code: "invalid_json" | "invalid_schema" | "payload_too_large" } {
  if (utf8Bytes(json) > NATIVE_BATCH_LIMITS.maxPayloadBytes)
    return { success: false, code: "payload_too_large" };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { success: false, code: "invalid_json" }; }
  const parsed = NativeBatchRequestV1Schema.safeParse(raw);
  if (!parsed.success) return { success: false, code: "invalid_schema" };
  const canonical = serializeNativeBatchRequest(parsed.data);
  if (!canonical.success) return canonical.code === "payload_too_large"
    ? { success: false, code: "payload_too_large" }
    : { success: false, code: "invalid_schema" };
  return { success: true, request: parsed.data };
}

export function resolveNativeBatchReference(
  ref: SafeNodeRef,
  request: NativeBatchRequestV1,
  createdNodeIds: ReadonlyMap<string, string>,
  currentOpId: string,
): string | undefined {
  if (ref.kind === "task-owned") {
    return ref.nodeId === request.authorizedRootId &&
      (!ref.expectedParentId || ref.expectedParentId === request.requestedPageId)
      ? ref.nodeId
      : undefined;
  }
  const previousIndex = request.operations.findIndex(({ opId }) => opId === ref.opId);
  const currentIndex = request.operations.findIndex(({ opId }) => opId === currentOpId);
  const createdOp = request.operations[previousIndex];
  if (previousIndex < 0 || currentIndex < 0 || previousIndex >= currentIndex || !createdOp || !isCreate(createdOp) || !createdNodeIds.has(ref.opId)) return undefined;
  return createdNodeIds.get(ref.opId);
}

export type NativeBatchPlanResult =
  | { success: true; request: NativeBatchRequestV1; serializedBytes: number; creationCount: number; maxDepth: number; fonts: Array<{ family: string; style: string }> }
  | { success: false; code: "feature_disabled" | "invalid_program" | "screen_scope_mismatch" | "unsupported_operation" | "references_require_renderer" | "batch_validation_failed"; details: string };

function programColor(program: DesignProgramV1, color: string): string | undefined {
  return color.startsWith("token:") ? program.tokens.colors[color.slice(6)] : color;
}

function opId(index: number): string { return `op-${String(index).padStart(3, "0")}`; }

/** Build an isolated, non-mutating plan for the safe v1 subset. */
export function planNativeBatchV1(
  value: unknown,
  scope: { taskId: string; screenId: string; checkpointFingerprint: string; batchId: string; requestedPageId: string; authorizedRootId: string },
  enabled = FW3_NATIVE_BATCH_ENABLED,
): NativeBatchPlanResult {
  if (!enabled) return { success: false, code: "feature_disabled", details: "The FW-3 planning gate is off." };
  const parsed = parseDesignProgram(value);
  if (!parsed.success) return { success: false, code: "invalid_program", details: "The canonical DesignProgramV1 failed validation." };
  const program = parsed.data;
  if (parsed.fingerprint !== scope.checkpointFingerprint)
    return { success: false, code: "screen_scope_mismatch", details: "The plan fingerprint differs from the saved screen checkpoint." };
  const screen = program.screens.find(({ id }) => id === scope.screenId);
  if (!screen || program.screens.length !== 1)
    return { success: false, code: "screen_scope_mismatch", details: "A native batch is limited to one checkpointed screen." };
  if (program.references.length || program.componentsV1?.length)
    return { success: false, code: "references_require_renderer", details: "Existing token, style, component, and FW-2 reference checks stay with the current renderer." };

  const operations: SafeNativeOp[] = [];
  const fonts = new Map<string, { family: string; style: string }>();
  let maxDepth = 0;
  const add = (operation: SafeNativeOp) => operations.push(operation);
  const visit = (node: DesignProgramNode, parent: SafeNodeRef, depth: number): string | undefined => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth > NATIVE_BATCH_LIMITS.maxDepth)
      throw new Error("unsupported_operation:DesignProgram depth exceeds the native batch bound");
    const creationId = opId(operations.length);
    const childRef: SafeNodeRef = { kind: "within-batch", opId: creationId };
    const size = { width: node.width.value, height: node.height.value, widthSizing: node.width.mode, heightSizing: node.height.mode };
    if (node.type === "container") {
      add({ kind: "create-frame", opId: creationId, parent, spec: { name: node.name, ...size } });
      const orderedChildren = program.locale.direction === "rtl" && node.layout.axis === "row"
        ? [...node.children].reverse()
        : node.children;
      const childRefs: Array<{ target: SafeNodeRef; width: "fixed" | "hug" | "fill"; height: "fixed" | "hug" | "fill" }> = [];
      for (const child of orderedChildren) {
        const childId = visit(child, childRef, depth + 1);
        if (!childId) return undefined;
        childRefs.push({ target: { kind: "within-batch", opId: childId }, width: child.width.mode, height: child.height.mode });
      }
      add({ kind: "set-layout", opId: opId(operations.length), target: childRef, spec: {
        axis: node.layout.axis === "row" ? "horizontal" : "vertical",
        gap: node.layout.gap,
        padding: node.layout.padding,
        primaryAlign: program.locale.direction === "rtl" && node.layout.axis === "row"
          ? node.layout.align === "start" ? "end" : node.layout.align === "end" ? "start" : node.layout.align
          : node.layout.align,
        counterAlign: node.layout.crossAlign,
        childrenSizing: childRefs,
      } });
      if (node.background) {
        const color = programColor(program, node.background);
        if (!color) throw new Error("unsupported_operation:unresolved token color");
        add({ kind: "set-paint", opId: opId(operations.length), target: childRef, spec: { fills: [{ kind: "solid", color }] } });
      }
      return creationId;
    }
    if (node.type === "text") {
      const textAutoResize = programTextAutoResize(node.width.mode, node.height.mode);
      if (!textAutoResize) throw new Error("unsupported_operation:text_requires_content_sized_height");
      const style = node.weight === "bold" ? "Bold" : node.weight === "semibold" ? "Semi Bold" : node.weight === "medium" ? "Medium" : "Regular";
      const family = node.weight === "bold" || node.weight === "semibold" ? program.tokens.headingFont : program.tokens.bodyFont;
      fonts.set(`${family}:${style}`, { family, style });
      add({ kind: "create-text", opId: creationId, parent, spec: {
        name: node.name, text: node.text, ...size, fontFamily: family, fontStyle: style, fontSize: node.fontSize,
        textAlign: node.align ?? (program.locale.direction === "rtl" ? "right" : "left"),
        textAutoResize,
      } });
      const color = programColor(program, node.color);
      if (!color) throw new Error("unsupported_operation:unresolved token color");
      add({ kind: "set-paint", opId: opId(operations.length), target: childRef, spec: { fills: [{ kind: "solid", color }] } });
      return creationId;
    }
    if (node.type === "rectangle" || node.type === "ellipse") {
      add({ kind: "create-shape", opId: creationId, parent, spec: {
        name: node.name, shape: node.type, ...size,
        ...(node.type === "rectangle" && node.cornerRadius !== undefined ? { cornerRadius: node.cornerRadius } : {}),
      } });
      const color = programColor(program, node.fill);
      if (!color) throw new Error("unsupported_operation:unresolved token color");
      add({ kind: "set-paint", opId: opId(operations.length), target: childRef, spec: { fills: [{ kind: "solid", color }] } });
      return creationId;
    }
    throw new Error(`unsupported_operation:${node.type}`);
  };
  try {
    const contentFrameId = opId(operations.length);
    const contentRef: SafeNodeRef = { kind: "within-batch", opId: contentFrameId };
    const contentHeight = screen.scroll === "vertical"
      ? Math.max(screen.viewport.height, screen.root.height.value + 48)
      : screen.viewport.height;
    add({ kind: "create-frame", opId: contentFrameId, parent: { kind: "task-owned", nodeId: scope.authorizedRootId, expectedParentId: scope.requestedPageId }, spec: {
      name: `${screen.id} content`, width: screen.viewport.width, height: contentHeight, widthSizing: "fixed", heightSizing: "fixed",
    } });
    const rootId = visit(screen.root, contentRef, 1);
    if (!rootId) return { success: false, code: "unsupported_operation", details: "The safe batch subset cannot represent this program node." };
    add({ kind: "set-layout", opId: opId(operations.length), target: contentRef, spec: {
      axis: "vertical", gap: 0, padding: { top: 24, right: 24, bottom: 24, left: 24 },
      primaryAlign: "start", counterAlign: "start",
      childrenSizing: [{ target: { kind: "within-batch", opId: rootId }, width: screen.root.width.mode, height: screen.root.height.mode }],
    } });
    const background = programPageColor(program);
    add({ kind: "set-paint", opId: opId(operations.length), target: contentRef, spec: { fills: [{ kind: "solid", color: background }] } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unsupported_operation";
    return { success: false, code: "unsupported_operation", details: message.slice(0, 240) };
  }
  if (!operations.length) return { success: false, code: "unsupported_operation", details: "The screen has no supported child operations." };
  const request = {
    version: 1 as const,
    taskId: scope.taskId,
    screenId: scope.screenId,
    checkpointFingerprint: scope.checkpointFingerprint,
    batchId: scope.batchId,
    requestedPageId: scope.requestedPageId,
    authorizedRootId: scope.authorizedRootId,
    operations,
  };
  const context: NativeBatchAdmissionContext = {
    taskId: scope.taskId,
    screenId: scope.screenId,
    checkpointFingerprint: scope.checkpointFingerprint,
    batchId: scope.batchId,
    taskState: "active",
    currentPageId: scope.requestedPageId,
    root: { nodeId: scope.authorizedRootId, taskId: scope.taskId, pageId: scope.requestedPageId, parentId: scope.requestedPageId, attached: true },
  };
  const validation = validateNativeBatchRequest(request, context);
  if (!validation.success)
    return { success: false, code: "batch_validation_failed", details: validation.details };
  return { success: true, request: validation.request, serializedBytes: validation.serializedBytes, creationCount: validation.creationCount, maxDepth, fonts: [...fonts.values()] };
}
