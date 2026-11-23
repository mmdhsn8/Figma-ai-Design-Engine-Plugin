import { describe, expect, it } from "vitest";
import { parseDesignProgram } from "../src/shared/design-program";
import {
  NATIVE_BATCH_LIMITS,
  NativeBatchRequestV1Schema,
  NativeBatchReceiptV1Schema,
  parseNativeBatchJson,
  planNativeBatchV1,
  resolveNativeBatchReference,
  serializeNativeBatchRequest,
  validateNativeBatchRequest,
  type NativeBatchAdmissionContext,
  type NativeBatchRequestV1,
  type SafeNativeOp,
  type SafeNodeRef,
} from "../src/shared/native-batch";
import { FW3_NATIVE_BATCH_ENABLED, FW3_NATIVE_BATCH_FEATURE } from "../src/shared/native-batch-feature";
import { designProgramFixtures } from "./fixtures/design-programs";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { renderDesignProgramLocal } from "../src/plugin/design-program-spike";
import { createMockApi } from "./figma-mock";

function copy<T>(value: T): T { return structuredClone(value); }

function programFor(screenId = "screen-01") {
  const program = copy(designProgramFixtures[0] as unknown as Record<string, unknown>);
  program.id = "fw3-persian-learning";
  const screens = program.screens as Array<Record<string, unknown>>;
  screens[0]!.id = screenId;
  return program;
}

function parsedFingerprint(program: unknown): string {
  const parsed = parseDesignProgram(program);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.findings));
  return parsed.fingerprint;
}

function plan(program = programFor()) {
  return planNativeBatchV1(program, {
    taskId: "fw3-task-0001",
    screenId: "screen-01",
    checkpointFingerprint: parsedFingerprint(program),
    batchId: "fw3-task-0001_render_screen-01_1",
    requestedPageId: "page:current",
    authorizedRootId: "mock:authorized-root",
  }, true);
}

function context(request: NativeBatchRequestV1, overrides: Partial<NativeBatchAdmissionContext> = {}): NativeBatchAdmissionContext {
  return {
    taskId: request.taskId,
    screenId: request.screenId,
    checkpointFingerprint: request.checkpointFingerprint,
    batchId: request.batchId,
    taskState: "active",
    currentPageId: request.requestedPageId,
    root: { nodeId: request.authorizedRootId, taskId: request.taskId, pageId: request.requestedPageId, parentId: request.requestedPageId, attached: true },
    ...overrides,
  };
}

function createFrame(opId: string, parent: SafeNodeRef): SafeNativeOp {
  return { kind: "create-frame", opId, parent, spec: { name: "Frame", width: 100, height: 100, widthSizing: "fixed", heightSizing: "fixed" } };
}

describe("FW-3 isolated native batch contract", () => {
  it("keeps the build-time gate off unless the exact opt-in value is supplied", () => {
    expect(FW3_NATIVE_BATCH_FEATURE).toBe("fw3-native-batch-v1");
    expect(FW3_NATIVE_BATCH_ENABLED).toBe(false);
    expect(planNativeBatchV1(programFor(), {
      taskId: "fw3-task-0001", screenId: "screen-01", checkpointFingerprint: parsedFingerprint(programFor()),
      batchId: "fw3-task-0001_render_screen-01_1", requestedPageId: "page:current", authorizedRootId: "mock:authorized-root",
    })).toMatchObject({ success: false, code: "feature_disabled" });
  });

  it("builds deterministic one-screen plans with earlier create references, nested order, RTL and font metadata", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.request.operations[0]).toMatchObject({ kind: "create-frame", parent: { kind: "task-owned", nodeId: "mock:authorized-root" } });
    expect(result.request.operations.some(({ kind }) => kind === "create-text")).toBe(true);
    expect(result.request.operations.some(({ kind }) => kind === "set-layout")).toBe(true);
    expect(result.request.operations.some(({ kind }) => kind === "set-paint")).toBe(true);
    expect(result.fonts).toContainEqual({ family: "Inter", style: "Bold" });
    for (const [index, operation] of result.request.operations.entries()) {
      const refs = operation.kind === "create-frame" || operation.kind === "create-text" || operation.kind === "create-shape"
        ? [operation.parent]
        : operation.kind === "set-layout" ? [operation.target, ...operation.spec.childrenSizing.map(({ target }) => target)]
          : [operation.target];
      for (const ref of refs) {
        if (ref.kind === "within-batch") {
          const target = result.request.operations.findIndex(({ opId }) => opId === ref.opId);
          expect(target).toBeLessThan(index);
          expect(["create-frame", "create-text", "create-shape"]).toContain(result.request.operations[target]?.kind);
        }
      }
    }

    const booking = copy(designProgramFixtures[1] as unknown as Record<string, unknown>);
    booking.id = "fw3-rtl-order";
    const bookingScreens = booking.screens as Array<Record<string, unknown>>;
    bookingScreens[0]!.id = "screen-01";
    const root = bookingScreens[0]!.root as { type: string; children: Array<{ type: string; name: string; children?: Array<{ type: string; name: string }> }> };
    const dates = root.children.find(({ name }) => name === "Date choices");
    expect(dates?.type).toBe("container");
    const sizingChild = dates?.children?.[0];
    if (sizingChild?.type === "text") {
      (sizingChild as unknown as { width: { mode: string } }).width.mode = "fill";
      (sizingChild as unknown as { height: { mode: string } }).height.mode = "hug";
    }
    const bookingPlan = plan(booking);
    expect(bookingPlan.success).toBe(true);
    if (!bookingPlan.success) return;
    const frame = bookingPlan.request.operations.find((op) => op.kind === "create-frame" && op.spec.name === "Date choices");
    if (frame?.kind !== "create-frame") throw new Error("Date choices frame was not planned.");
    const layout = bookingPlan.request.operations.find((op) => op.kind === "set-layout" && op.target.kind === "within-batch" && op.target.opId === frame.opId);
    if (layout?.kind !== "set-layout") throw new Error("Date choices layout was not planned.");
    const orderedNames = layout.spec.childrenSizing.map(({ target }) => bookingPlan.request.operations.find((op) => op.opId === (target.kind === "within-batch" ? target.opId : ""))).map((op) => op?.kind === "create-text" ? op.spec.name : "");
    expect(orderedNames).toEqual(["Date Thursday", "Date Wednesday", "Date Tuesday"]);
    expect(layout.spec.childrenSizing.some(({ width, height }) => width === "fill" || height === "hug")).toBe(true);
  });

  it("strictly serializes and round-trips the request and receipt without Intl", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const serialized = serializeNativeBatchRequest(result.request);
    expect(serialized.success).toBe(true);
    if (!serialized.success) return;
    expect(parseNativeBatchJson(serialized.json)).toMatchObject({ success: true, request: result.request });
    expect(serialized.bytes).toBe(result.serializedBytes);

    const verified = NativeBatchReceiptV1Schema.parse({
      version: 1, batchId: result.request.batchId, status: "verified", stage: "checkpoint-confirmed",
      appliedOpIds: result.request.operations.map(({ opId }) => opId), confirmedNodeIds: { "op-000": "mock:child" },
      rootNodeId: result.request.authorizedRootId, errors: [],
    });
    expect(verified.status).toBe("verified");

    const previousIntl = globalThis.Intl;
    try {
      Object.defineProperty(globalThis, "Intl", { configurable: true, value: undefined });
      expect(parseNativeBatchJson(serialized.json).success).toBe(true);
      expect(plan().success).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "Intl", { configurable: true, value: previousIntl });
    }
  });

  it("rejects unknown fields and operations, unsafe deletes, code strings, and prototype pollution", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const unknownOp = copy(result.request) as unknown as { operations: Array<Record<string, unknown>> };
    unknownOp.operations[0]!.kind = "delete-node";
    expect(NativeBatchRequestV1Schema.safeParse(unknownOp).success).toBe(false);

    const unknownField = copy(result.request) as unknown as { operations: Array<Record<string, unknown>> };
    unknownField.operations[0]!.runJavaScript = "figma.currentPage.children.forEach(node => node.remove())";
    expect(validateNativeBatchRequest(unknownField, context(result.request))).toMatchObject({ success: false, code: "invalid_schema" });

    const polluted = copy(result.request) as unknown as { operations: Array<Record<string, unknown>> };
    Object.defineProperty(polluted.operations[0]!, "__proto__", { enumerable: true, value: { polluted: true } });
    expect(validateNativeBatchRequest(polluted, context(result.request))).toMatchObject({ success: false, code: "invalid_schema" });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects malformed, over-limit and oversized requests before any execution adapter exists", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const tooManyOps = copy(result.request) as { operations: SafeNativeOp[] };
    tooManyOps.operations = Array.from({ length: NATIVE_BATCH_LIMITS.maxOperations + 1 }, (_, index) => ({
      kind: "set-paint" as const, opId: `op-${String(index).padStart(3, "0")}`,
      target: { kind: "task-owned" as const, nodeId: result.request.authorizedRootId }, spec: { fills: [] },
    }));
    expect(validateNativeBatchRequest(tooManyOps, context(result.request))).toMatchObject({ success: false, code: "invalid_schema" });

    const tooManyCreations = copy(result.request) as { operations: SafeNativeOp[] };
    tooManyCreations.operations = Array.from({ length: NATIVE_BATCH_LIMITS.maxCreations + 1 }, (_, index) => createFrame(`op-${String(index).padStart(3, "0")}`, { kind: "task-owned", nodeId: result.request.authorizedRootId }));
    expect(validateNativeBatchRequest(tooManyCreations, context(result.request))).toMatchObject({ success: false, code: "too_many_creations" });

    const oversized = copy(result.request) as { operations: SafeNativeOp[] };
    oversized.operations = Array.from({ length: NATIVE_BATCH_LIMITS.maxOperations }, (_, index) => ({
      kind: "create-text" as const,
      opId: `op-${String(index).padStart(3, "0")}`,
      parent: { kind: "task-owned" as const, nodeId: result.request.authorizedRootId },
      spec: { name: "n".repeat(160), text: "x".repeat(500), width: 100, height: 40, widthSizing: "fixed" as const, heightSizing: "fixed" as const, fontFamily: "f".repeat(100), fontStyle: "s".repeat(80), fontSize: 16, textAlign: "left" as const, textAutoResize: "height" as const },
    }));
    expect(validateNativeBatchRequest(oversized, context(result.request))).toMatchObject({ success: false, code: "payload_too_large" });
    expect(parseNativeBatchJson("{")).toMatchObject({ success: false, code: "invalid_json" });
  });

  it("accepts only backwards references to earlier creation ops and rejects a deleted/cross-batch result", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const base = result.request;
    const first = createFrame("op-900", { kind: "task-owned", nodeId: base.authorizedRootId });
    const nested = createFrame("op-901", { kind: "within-batch", opId: "op-900" });
    const ordered = { ...base, operations: [first, nested] };
    expect(validateNativeBatchRequest(ordered, context(base)).success).toBe(true);
    expect(validateNativeBatchRequest({ ...base, operations: [createFrame("op-902", { kind: "within-batch", opId: "op-903" }), createFrame("op-903", { kind: "task-owned", nodeId: base.authorizedRootId })] }, context(base))).toMatchObject({ success: false, code: "forward_reference" });
    expect(validateNativeBatchRequest({ ...base, operations: [createFrame("op-904", { kind: "within-batch", opId: "op-999" })] }, context(base))).toMatchObject({ success: false, code: "missing_reference" });
    expect(validateNativeBatchRequest({ ...base, operations: [createFrame("op-905", { kind: "within-batch", opId: "op-906" }), createFrame("op-906", { kind: "within-batch", opId: "op-905" })] }, context(base))).toMatchObject({ success: false, code: "forward_reference" });

    const noCrossBatch = new Map<string, string>();
    expect(resolveNativeBatchReference({ kind: "within-batch", opId: "op-900" }, ordered, noCrossBatch, "op-901")).toBeUndefined();
    expect(resolveNativeBatchReference({ kind: "within-batch", opId: "op-900" }, ordered, new Map([["op-900", "mock:created"]]), "op-901")).toBe("mock:created");
    expect(resolveNativeBatchReference({ kind: "task-owned", nodeId: base.authorizedRootId, expectedParentId: "page:other" }, base, new Map(), base.operations[0]!.opId)).toBeUndefined();
  });

  it("does not allow an early acknowledgement to claim verified completion", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(NativeBatchReceiptV1Schema.safeParse({
      version: 1, batchId: result.request.batchId, status: "verified", stage: "applied",
      appliedOpIds: result.request.operations.map(({ opId }) => opId), confirmedNodeIds: {},
      rootNodeId: result.request.authorizedRootId, errors: [],
    }).success).toBe(false);
    expect(NativeBatchReceiptV1Schema.safeParse({
      version: 1, batchId: result.request.batchId, status: "rejected", stage: "accepted",
      appliedOpIds: [result.request.operations[0]!.opId], confirmedNodeIds: {}, errors: [],
    }).success).toBe(false);
  });

  it("fails closed for stale task/page/root/checkpoint/batch and unauthorized existing parents", () => {
    const result = plan();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const validContext = context(result.request);
    expect(validateNativeBatchRequest(result.request, { ...validContext, taskId: "other-task-0001" })).toMatchObject({ success: false, code: "stale_task" });
    expect(validateNativeBatchRequest(result.request, { ...validContext, taskState: "stopped" })).toMatchObject({ success: false, code: "task_stopped" });
    expect(validateNativeBatchRequest(result.request, { ...validContext, currentPageId: "page:other" })).toMatchObject({ success: false, code: "stale_page" });
    expect(validateNativeBatchRequest(result.request, { ...validContext, checkpointFingerprint: "dpv1-0000000000000000" })).toMatchObject({ success: false, code: "stale_checkpoint" });
    expect(validateNativeBatchRequest(result.request, { ...validContext, batchId: "fw3-task-0001_render_screen-02_1" })).toMatchObject({ success: false, code: "stale_batch" });
    expect(validateNativeBatchRequest(result.request, { ...validContext, root: { ...validContext.root!, nodeId: "mock:other-root" } })).toMatchObject({ success: false, code: "stale_root" });
    expect(validateNativeBatchRequest(result.request, { ...validContext, root: { ...validContext.root!, parentId: "page:other" } })).toMatchObject({ success: false, code: "cross_page_reference" });
    const foreign = { ...result.request, operations: [createFrame("op-910", { kind: "task-owned", nodeId: "mock:foreign-root" })] };
    expect(validateNativeBatchRequest(foreign, validContext)).toMatchObject({ success: false, code: "unauthorized_parent" });
    const moved = { ...result.request, operations: [createFrame("op-911", { kind: "task-owned", nodeId: result.request.authorizedRootId, expectedParentId: "page:other" })] };
    expect(validateNativeBatchRequest(moved, validContext)).toMatchObject({ success: false, code: "cross_page_reference" });
  });

  it("routes existing component/reuse references and unsupported primitives to the known renderer", () => {
    const withLocalComponent = copy(programFor()) as Record<string, unknown>;
    const screens = withLocalComponent.screens as Array<{ root: unknown }>;
    withLocalComponent.componentsV1 = [{ id: "local-master", root: copy(screens[0]!.root) }];
    expect(plan(withLocalComponent)).toMatchObject({ success: false, code: "references_require_renderer" });

    const withVector = copy(programFor()) as Record<string, unknown>;
    const root = (withVector.screens as Array<{ root: { type: string; children?: Array<Record<string, unknown>> } }>)[0]!.root;
    if (root.type !== "container") throw new Error("Fixture root must be a container.");
    root.children!.push({ id: "fw3-vector", type: "vector", name: "Unsupported vector", semanticRole: "icon", width: { mode: "fixed", value: 24 }, height: { mode: "fixed", value: 24 }, pathData: "M0 0 L24 24", fill: "#000000" });
    expect(plan(withVector)).toMatchObject({ success: false, code: "unsupported_operation" });
  });

  it("retains the attached 01 — Welcome root after geometry verification fails", async () => {
    const program = copy(designProgramFixtures[0] as unknown as Record<string, unknown>);
    program.id = "fw3-welcome-regression";
    const screens = program.screens as Array<Record<string, unknown>>;
    screens[0]!.id = "screen-01";
    screens[0]!.title = "Welcome";
    const mock = createMockApi();
    const unrelated = mock.api.createFrame();
    unrelated.name = "Existing unrelated frame";
    const unrelatedId = unrelated.id;
    const unrelatedParent = unrelated.parent;
    const originalCreateText = mock.api.createText.bind(mock.api);
    mock.api.createText = () => {
      const text = originalCreateText();
      Object.defineProperty(text, "absoluteRenderBounds", {
        configurable: true,
        get: () => ({ x: -5_000, y: -5_000, width: 10_000, height: 10_000 }),
      });
      return text;
    };
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const failed = await renderDesignProgramLocal(mock.api, program, {
      taskId: "fw3-task-0001", documentId: "file-test-56-page_current", pageId: "page:current", executor,
    });
    expect(failed).toMatchObject({ success: false, code: "native_geometry_failed" });
    if (failed.success) return;
    const root = mock.nodes.find(({ id }) => id === failed.nativeRootNodeId);
    expect(root).toBeDefined();
    expect(root?.name).toBe("01 — Welcome");
    expect(root?.parent?.id).toBe("page:current");
    expect(root?.children.length).toBeGreaterThan(0);
    expect(mock.nodes.find(({ id }) => id === unrelatedId)?.parent).toBe(unrelatedParent);
    expect(mock.nodes.find(({ id }) => id === unrelatedId)?.name).toBe("Existing unrelated frame");
  });
});
