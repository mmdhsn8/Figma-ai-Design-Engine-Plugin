import { describe, expect, it, vi } from "vitest";
import {
  ChatTaskSchema,
  chatTaskCommittedOperationCount,
  chatTaskProgress,
  chatTaskSafeDiagnostic,
  chatTaskRetryLabel,
  isCanvasMutationTool,
  type ChatTask,
} from "../src/shared/chat-task";
import {
  ChatFunctionCallSchema,
  parseResponsesFunctionCalls,
  type ChatInputItem,
} from "../src/shared/chat-tools";
import { chatTaskInput, runChatTask, waitForChatCapacity } from "../src/ui/chat-task";
import { handleChatTaskStorage } from "../src/plugin/chat-task-storage";
import { ChatTaskBridgeError } from "../src/ui/chat-task-bridge";
import { CompanionClientError, type AuthorizedChatTurn } from "../src/ui/companion-client";
import type { FigmaToolOperation } from "../src/shared/figma-tools";
import type { PluginToUIMessage } from "../src/shared/messages";
import { MAX_NATIVE_QUALITY_SCAN_NODES } from "../src/shared/native-visual-quality";

type Result = Extract<PluginToUIMessage, { type: "tool-result" }>;
let callNumber = 0;
function turn(name: string, args: unknown): AuthorizedChatTurn {
  const calls = parseResponsesFunctionCalls([
    {
      type: "function_call",
      call_id: `task_call_${++callNumber}`,
      name,
      arguments: JSON.stringify(args),
    },
  ]);
  return {
    kind: "tool_calls",
    calls,
    functionCallItems: calls.map((call) => call.functionCall),
    text: "",
  };
}
function creates(count: number, prefix = "product"): AuthorizedChatTurn {
  const calls = Array.from(
    { length: count },
    (_, index) =>
      (
        turn("create_frame", {
          ref: `${prefix}-${index}`,
          name: `کارت ${index}`,
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }) as Extract<AuthorizedChatTurn, { kind: "tool_calls" }>
      ).calls[0]!,
  );
  return {
    kind: "tool_calls",
    calls,
    functionCallItems: calls.map((call) => call.functionCall),
    text: "",
  };
}
function task(): ChatTask {
  return ChatTaskSchema.parse({
    version: 1,
    id: "chat-task-0001",
    intent: "create",
    referenceScope: "task-v1",
    documentId: "file-test-page_1",
    prompt:
      "یک صفحه موبایل برای فروشگاه لباس طراحی کن؛ شامل هدر، جست‌وجو، دسته‌بندی‌ها، کارت محصولات و دکمه‌های خرید.",
    context: [],
    stages: [],
    ledger: [],
    pending: [],
    recent: [],
    starts: [],
    rounds: 0,
    status: "ready",
    text: "",
  });
}
function success(ops: FigmaToolOperation[]): Result {
  return {
    type: "tool-result",
    protocolVersion: 1,
    batchId: "task-test-batch",
    success: true,
    cancelled: false,
    committedOperationIds: ops
      .filter((op) => isCanvasMutationTool(op.action.tool))
      .map((op) => op.operationId),
    partialOperationIds: [],
    results: ops.map((op) => ({
      operationId: op.operationId,
      success: true,
      replayed: false,
      acknowledgementStatus: isCanvasMutationTool(op.action.tool)
        ? "confirmed_mutation"
        : "read_only",
      ...("ref" in op.action ? { logicalRef: op.action.ref } : {}),
      summary: "Confirmed",
      ...(op.action.tool === "inspect_nodes"
        ? {
            data: {
              nodes: op.action.refs.map((ref) => ({
                ref,
                type: "FRAME",
                name: ref === "charm-home" ? "Charm Home" : ref,
                x: 0,
                y: 0,
                width: 390,
                height: 844,
                visible: true,
                bounds: { x: 0, y: 0, width: 390, height: 844 },
              })),
              pageId: op.action.pageId ?? "page:charm",
            },
          }
        : {}),
      ...(op.action.tool === "get_document_context"
        ? {
            data: {
              page: { id: "page:current", name: "Current" },
              pages: [{ id: "page:current", name: "Current", current: true }, { id: "page:charm", name: "Charm", current: false }],
              discovery: {
                matchStatus: op.action.query ? "unique" : "not_queried",
                matchCount: op.action.query ? 1 : 0,
                complete: true,
                truncated: false,
                paused: false,
                pagesVisited: 2,
                pagesAvailable: 2,
                pagesRemaining: 0,
              },
              frames: op.action.query
                ? [{ ref: "charm-home", nodeId: "node-charm-home", pageId: "page:charm", pageName: "Charm", type: "FRAME", name: "Charm Home", x: 0, y: 0, width: 390, height: 844, editable: true }]
                : [],
            },
          }
        : {}),
    })),
  };
}
function markVerifiedStructure(data: Record<string, unknown>, nodeCount: number): void {
  Object.assign(data, {
    repairPipelineVersion: "native-quality-repair-v1",
    qualityFindings: [],
    nativeRepairPlan: [],
    qualityCoverage: { complete: true, nodeCount, findingCount: 0 },
  });
}
function harness(turns: Array<AuthorizedChatTurn | Error>, autoReadContext = true) {
  let clock = 100_000;
  const checkpoints: ChatTask[] = [];
  const batches: FigmaToolOperation[][] = [];
  const inputs: ChatInputItem[][] = [];
  const lifecycles: string[] = [];
  const controller = new AbortController();
  const nativeProperties = new Map<string, Record<string, unknown>>();
  let readContext = false;
  const deps = {
    signal: controller.signal,
    model: vi.fn(async (input: ChatInputItem[], lifecycle: string) => {
      inputs.push(input);
      lifecycles.push(lifecycle);
      const next = turns.shift();
      if (!next) throw new Error("No scripted turn left");
      if (next instanceof Error) throw next;
      if (
        next.kind === "tool_calls" &&
        next.calls.some((call) => call.action.tool === "get_document_context")
      )
        readContext = true;
      else if (
        autoReadContext &&
        !readContext &&
        next.kind === "tool_calls" &&
        next.calls.some((call) => call.action.tool === "plan_canvas_task")
      ) {
        turns.unshift(next);
        readContext = true;
        return turn("get_document_context", {}) as Extract<
          AuthorizedChatTurn,
          { kind: "tool_calls" }
        >;
      }
      return next;
    }),
    execute: vi.fn(async (operations: FigmaToolOperation[]) => {
      batches.push(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "set_properties") continue;
        const values = nativeProperties.get(operation.action.ref) ?? {};
        for (const [key, value] of Object.entries(operation.action.properties)) {
          const evidenceKey = key === "color" ? "textColor" : key === "align" ? "textAlignHorizontal" : key;
          values[evidenceKey] = value;
        }
        nativeProperties.set(operation.action.ref, values);
      }
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes") continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId);
        const nodes = item?.data?.nodes;
        if (!Array.isArray(nodes)) continue;
        for (const value of nodes) {
          if (!value || typeof value !== "object" || !("ref" in value)) continue;
          const native = nativeProperties.get(String(value.ref));
          if (native) Object.assign(value, native);
        }
      }
      return result;
    }),
    save: vi.fn(async (checkpoint: ChatTask) => {
      checkpoints.push(structuredClone(ChatTaskSchema.parse(checkpoint)));
    }),
    progress: vi.fn(),
    now: () => clock,
    wait: vi.fn(async (ms: number) => {
      clock += ms;
    }),
  };
  return { deps, controller, checkpoints, batches, inputs, lifecycles };
}
const defaultBrief = {
  platform: "mobile",
  viewport: { width: 390, height: 844 },
  brandDirection: "Modern fashion",
  audience: "Everyday shoppers",
  content: ["Header", "Products"],
  hierarchy: "Clear display and body hierarchy",
  typography: { family: "Arial", style: "Regular", headingSize: 28, bodySize: 14 },
  spacingScale: [8, 12, 16, 24],
  radiusScale: [12, 16, 20],
  palette: {
    source: "curated-default",
    background: "#FBF7F4",
    surface: "#FFFFFF",
    primary: "#9B3F62",
    accent: "#D4A373",
    text: "#241B20",
    muted: "#675D63",
  },
  imagePolicy: "labeled-native-fallback",
  interactionPriorities: ["Purchase"],
  readingDirection: "RTL",
} as const;
const plan = (
  stages = [
    "Page frame",
    "Header and navigation",
    "Search and categories",
    "Editable product cards",
    "Purchase buttons",
  ],
  refs: string[] = stages.map(() => "product-0"),
) =>
  turn("plan_canvas_task", {
    brief: defaultBrief,
    stages: stages.map((title, index) => ({
      title,
      goal: `Complete ${title}`,
      logicalRefs: [refs[index] ?? "product-0"],
      completionCriteria: [`${title} exists as editable native layers`],
    })),
  });
const finish = (resolvedOperationIds: string[] = []) =>
  turn("complete_canvas_stage", { summary: "Confirmed stage", resolvedOperationIds });
const done: AuthorizedChatTurn = {
  kind: "done",
  text: "همه بخش‌ها با لایه‌های قابل ویرایش ساخته شدند.",
};

function reportedPartialEditTask() {
  const current = task();
  const rootRef = "task-caba0d5eb320fddc43748146a97ca144";
  const backgroundRef = "task-71c74e09c3a188e7a94c9eb1b1e6550f";
  const textRef = "task-3aafa4981a685bdaefd93890f2053992";
  const nativeNodes = [
    {
      ref: rootRef,
      type: "FRAME",
      name: "خانه | Charm",
      x: 2040,
      y: 5925,
      width: 390,
      height: 844,
      visible: true,
      fill: "#FFF9F4",
      children: [
        {
          ref: backgroundRef,
          type: "RECTANGLE",
          name: "خانه - زمینه",
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          fill: "#FFF9F4",
        },
        {
          ref: textRef,
          type: "TEXT",
          name: "خانه - معرفی",
          x: 20,
          y: 40,
          width: 350,
          height: 96,
          visible: true,
          fill: "#29231F",
          text: "معرفی Charm",
        },
      ],
    },
  ];
  const discoveryCall = turn("get_document_context", { query: "خانه | Charm", pageId: "0:1" });
  const targetInspectionCall = turn("inspect_nodes", {
    pageId: "0:1",
    refs: [rootRef],
    selection: false,
    depth: 4,
    maxNodes: 25,
  });
  const mutationCall = turn("set_properties", {
    pageId: "0:1",
    ref: rootRef,
    properties: { fill: "#FFF0F5" },
  });
  const priorQualityCall = turn("inspect_nodes", {
    pageId: "0:1",
    refs: [rootRef, backgroundRef],
    selection: false,
    depth: 1,
    maxNodes: 5,
    purpose: "structural_verification",
  });
  const priorInspectionCall = turn("inspect_nodes", {
    pageId: "0:1",
    refs: [rootRef, backgroundRef],
    selection: false,
    depth: 1,
    maxNodes: 5,
  });
  if (
    discoveryCall.kind !== "tool_calls" ||
    targetInspectionCall.kind !== "tool_calls" ||
    mutationCall.kind !== "tool_calls" ||
    priorQualityCall.kind !== "tool_calls" ||
    priorInspectionCall.kind !== "tool_calls"
  )
    throw new Error("Expected saved live-task tool calls.");
  const callAt = (turnValue: AuthorizedChatTurn) => {
    if (turnValue.kind !== "tool_calls") throw new Error("Expected a tool call.");
    return turnValue.calls[0]!;
  };
  current.id = "chat-1794304545560-ythoff";
  current.chatId = "chat-1794304485267-qarld7";
  current.documentId = "doc-mw1xggge-dwqwh8bw2b-0_1";
  current.prompt = "فقط پس‌زمینه فریم موجود خانه | Charm را به #FFF0F5 تغییر بده و سایر لایه‌ها را حفظ کن.";
  current.intent = "edit";
  current.targetName = "خانه | Charm";
  current.lifecycle = "EXECUTING_STAGE";
  current.status = "failed";
  current.failure = {
    category: "verification",
    phase: "verification",
    code: "no_progress_repeated_error",
    committedOperations: 1,
  };
  current.rounds = 7;
  current.editTarget = {
    query: "خانه | Charm",
    ref: rootRef,
    pageId: "0:1",
    pageName: "Phase 1 — Storefront",
    nodeId: "68:133",
    type: "FRAME",
    name: "خانه | Charm",
    x: 2040,
    y: 5925,
    width: 390,
    height: 844,
    verifiedRefs: [rootRef, backgroundRef, textRef],
    plannedRefs: [rootRef, backgroundRef],
    nativeEvidence: JSON.stringify(nativeNodes),
    discoveryOperationId: "chat-discovery-0001",
    inspectionOperationId: "chat-inspection-0001",
  };
  current.stages = [
    {
      title: "تغییر پس‌زمینه فریم موجود",
      goal: "فقط fill فریم خانه | Charm را به #FFF0F5 تغییر بده و شناسه، ابعاد، موقعیت و سایر لایه‌ها را دست‌نخورده نگه دار.",
      pageId: "0:1",
      logicalRefs: [rootRef, backgroundRef],
      completionCriteria: [
        "root fill is #FFF0F5",
        "root size and location are unchanged",
        "all other layers and positions are unchanged",
      ],
      estimatedMutations: 6,
      completed: false,
      operations: 1,
      readOnlyOperations: 0,
      segments: [],
      rounds: 4,
      qaAttempts: 0,
      verificationOperations: 0,
      verified: false,
      verificationHistory: [],
      qualityFindings: [],
      repairOperationsExecuted: 0,
      repairOperationsAttempted: 0,
      awaitingQualityRepair: false,
      completionReason: "missing_required_refs",
    },
  ];
  current.ledger = [
    {
      call: callAt(discoveryCall),
      operationId: `${current.id}-op-1`,
      stage: 0,
      status: "completed",
      category: "read_only",
      acknowledgementStatus: "read_only",
      output: JSON.stringify({ success: true, data: { page: { id: "0:1", name: "Phase 1 — Storefront" } } }),
    },
    {
      call: callAt(targetInspectionCall),
      operationId: `${current.id}-op-2`,
      stage: 0,
      status: "completed",
      category: "read_only",
      acknowledgementStatus: "read_only",
      output: JSON.stringify({ success: true, data: { pageId: "0:1", nodes: nativeNodes } }),
    },
    {
      call: callAt(mutationCall),
      operationId: `${current.id}-op-3`,
      stage: 0,
      status: "completed",
      category: "mutation",
      acknowledgementStatus: "confirmed_mutation",
      output: JSON.stringify({ success: true, logicalRef: rootRef, summary: "Updated only the requested properties on the existing frame." }),
    },
    {
      call: callAt(priorQualityCall),
      operationId: `${current.id}-op-4`,
      stage: 0,
      status: "completed",
      category: "read_only",
      acknowledgementStatus: "read_only",
      output: JSON.stringify({ success: true, summary: "Verified 3 native layers; 0 structural finding(s).", data: { pageId: "0:1", nodes: [] } }),
    },
    {
      call: callAt(priorInspectionCall),
      operationId: `${current.id}-op-5`,
      stage: 0,
      status: "completed",
      category: "read_only",
      acknowledgementStatus: "read_only",
      output: JSON.stringify({ success: true, data: { pageId: "0:1", nodes: nativeNodes } }),
    },
  ];
  return ChatTaskSchema.parse(current);
}

describe("progressive conversational canvas tasks", () => {
  it("accepts legacy task checkpoints and preserves a pinned model in new snapshots", () => {
    const legacy = task();
    expect(legacy.model).toBeUndefined();
    const pinned = ChatTaskSchema.parse({ ...legacy, model: "provider/model-exact" });
    expect(pinned.model).toBe("provider/model-exact");
    expect(ChatTaskSchema.safeParse({ ...legacy, model: "provider/model with spaces" }).success).toBe(
      false,
    );
  });

  it("closes the reported 11-round repeated-context failure with one model request and bounded inspection", async () => {
    const classification = () => turn("classify_canvas_intent", { intent: "inspect", targetName: "Charm" });
    const reportedCallSequence = [
      classification(),
      ...Array.from({ length: 5 }, (_, index) =>
        turn("get_document_context", { query: "Charm", offset: index * 8 }),
      ),
      turn("inspect_nodes", { pageId: "page:charm", refs: ["charm-home"], selection: false }),
      ...Array.from({ length: 4 }, (_, index) =>
        turn("get_document_context", { query: "Charm", offset: (index + 5) * 8 }),
      ),
    ];
    expect(reportedCallSequence).toHaveLength(11);
    // The supplied live trace included tool names but not arguments; distinct offsets here avoid
    // assuming the real calls were identical while retaining the 11-round tool-name signature.
    const h = harness(reportedCallSequence, false);
    const current = task();
    current.id = "chat-1794288205407-wiwkb8";
    current.prompt = "Find and inspect all existing Charm frames without selecting any frame or changing the canvas.";
    delete current.intent;

    await runChatTask(current, h.deps);

    expect(current.rounds).toBe(1);
    expect(h.deps.model).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ status: "completed", lifecycle: "TASK_COMPLETED", stages: [] });
    expect(chatTaskCommittedOperationCount(current)).toBe(0);
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual(["get_document_context", "inspect_nodes"]);
    expect(h.inputs).toHaveLength(1);
    // Discovery and verified geometry must survive the intervening classifier and reload.
    const restored = ChatTaskSchema.parse(structuredClone(current));
    const input = JSON.stringify(chatTaskInput({ ...restored, recent: [] }));
    expect(input).toContain("charm-home");
    expect(input).toContain("page:charm");
    expect(input).toContain("844");
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      intent: "inspect", inspectionOutcome: "COMPLETED",
      inspectionSummary: {
        nativeOperations: 2,
        canvasMutations: 0,
        nativePerformance: { modelRequests: 1, modelInputBytes: expect.any(Number) },
      },
      completionReason: "read_only_inspection_confirmed", modelRequests: 1,
      modelRoundTrace: [
        { round: 1, tools: ["classify_canvas_intent"], outcome: "tool_calls", validationCodes: [] },
      ],
    });
  });

  it("resumes the saved live fourth-round classifier without changing intent or replaying native calls", async () => {
    const h = harness([
      turn("get_document_context", {}),
      turn("inspect_nodes", { pageId: "page:charm", refs: ["charm-home"] }),
      new Error("controlled interruption"),
    ], false);
    const current = task();
    current.intent = "inspect";
    current.targetName = "Charm";
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    const repeated = turn("classify_canvas_intent", { intent: "inspect", targetName: "Charm" });
    if (repeated.kind !== "tool_calls") throw new Error("Expected classification");
    current.lifecycle = "UNPLANNED";
    current.rounds = 4;
    current.pending = repeated.calls;
    current.recent = repeated.functionCallItems;
    current.error = "Canvas intent is already checkpointed and cannot be changed.";
    const restored = ChatTaskSchema.parse(structuredClone(current));
    const retry = harness([{ kind: "done", text: "Charm Home verified on page:charm." }], false);
    await runChatTask(restored, retry.deps);
    expect(restored.status).toBe("completed");
    expect(restored.intent).toBe("inspect");
    expect(retry.batches).toHaveLength(0);
  });

  it("still rejects a changed checkpointed intent before any mutation", async () => {
    const h = harness([turn("classify_canvas_intent", { intent: "create" })], false);
    const current = task();
    current.intent = "inspect";
    const changed = turn("classify_canvas_intent", { intent: "create" });
    if (changed.kind !== "tool_calls") throw new Error("Expected a classification call.");
    current.pending = changed.calls;
    await expect(runChatTask(current, h.deps)).rejects.toThrow("cannot be changed");
    expect(current.intent).toBe("inspect");
    expect(h.batches).toHaveLength(0);
  });

  it("requires verified discovery evidence instead of trusting read-only completion prose", async () => {
    const h = harness([{ kind: "done", text: "I inspected Charm." }], false);
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      result.results[0]!.data = {
        page: { id: "page:current", name: "Current" },
        pages: [{ id: "page:current", name: "Current", current: true }],
        frames: [],
        discovery: {
          query: "Charm", matchStatus: "no_match", matchCount: 0,
          pagesVisited: 1, pagesAvailable: 1, pagesRemaining: 0,
          complete: true, truncated: false,
          nativeInspection: { complete: true, framesInspected: 0, framesExpected: 0 },
        },
      };
      return result;
    });
    const current = task();
    current.intent = "inspect";
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    expect(current.inspectionOutcome).toBe("NO_MATCH");
    expect(current.text).toContain("Canvas mutations: 0.");
  });

  it.each(["inspect", "explain"] as const)("keeps %s read-only even if a model returns a plan or mutation", async (intent) => {
    for (const response of [plan(), creates(1)]) {
      const h = harness([response], false);
      const current = task();
      current.intent = intent;
      current.targetName = "Charm";
      await runChatTask(current, h.deps);
      expect(current.stages).toEqual([]);
      expect(h.deps.model).not.toHaveBeenCalled();
      expect(h.batches.flat().every((operation) =>
        operation.action.tool === "get_document_context" ||
        operation.action.tool === "inspect_nodes",
      )).toBe(true);
      expect(current.inspectionOutcome).toBe("COMPLETED");
      expect(chatTaskCommittedOperationCount(current)).toBe(0);
    }
  });

  it.each([
    { matchStatus: "no_match", truncated: false, outcome: "NO_MATCH", status: "completed" },
    { matchStatus: "no_match_truncated", truncated: true, outcome: "BLOCKED", status: "failed" },
  ] as const)("records the bounded $matchStatus result without a mutation plan", async ({ matchStatus, truncated, outcome, status }) => {
    const h = harness([], false);
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      result.results[0]!.data = {
        page: { id: "page:current", name: "Current" },
        pages: [{ id: "page:current", name: "Current", current: true }],
        frames: [],
        discovery: {
          matchStatus, matchCount: 0, truncated, pagesVisited: 1, pagesAvailable: 1,
          complete: !truncated, pagesRemaining: 0,
          nativeInspection: { complete: !truncated, framesInspected: 0, framesExpected: 0 },
        },
      };
      return result;
    });
    const current = task();
    current.intent = "inspect";
    current.targetName = "Charm";
    await runChatTask(current, h.deps);
    expect(current.status).toBe(status);
    expect(current.inspectionOutcome).toBe(outcome);
    expect(chatTaskCommittedOperationCount(current)).toBe(0);
    expect(current.text).toContain(matchStatus === "no_match" ? "no matching frames" : "Blocked");
    expect(current.text).toContain("Canvas mutations: 0.");
  });

  it("replaces stale model inspection requests with the exact discovered page and ref", async () => {
    for (const wrongPage of [false, true]) {
      const h = harness([], false);
      const current = task();
      current.intent = "inspect";
      current.targetName = "Charm";
      const staleCall = turn("inspect_nodes", {
        pageId: wrongPage ? "page:unrelated" : "page:charm",
        refs: ["charm-home"],
      });
      if (staleCall.kind !== "tool_calls") throw new Error("Expected an inspection call.");
      current.pending = staleCall.calls;

      await runChatTask(current, h.deps);

      expect(current.status).toBe("completed");
      expect(current.inspectionOutcome).toBe("COMPLETED");
      expect(h.batches.flat().map(({ action }) => action.tool)).toEqual([
        "get_document_context",
        "inspect_nodes",
      ]);
      expect(h.batches.flat().find(({ action }) => action.tool === "inspect_nodes")?.action).toMatchObject({
        pageId: "page:charm",
        refs: ["charm-home"],
        selection: false,
      });
    }
  });

  it("advances a real discovery cursor and inspects every returned page window", async () => {
    const h = harness([], false);
    const allFrames = Array.from({ length: 12 }, (_, index) => ({
      ref: "charm-" + index,
      pageId: index % 2 ? "page:two" : "page:one",
      pageName: index % 2 ? "Second" : "First",
      type: "FRAME",
      name: "Charm screen " + index,
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      editable: true,
    }));
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      const action = operations[0]!.action;
      if (action.tool === "get_document_context") {
        const offset = action.offset ?? 0;
        const frames = allFrames.slice(offset, offset + 8);
        result.results[0]!.data = {
          page: { id: "page:current", name: "Current" },
          pages: [
            { id: "page:one", name: "First", current: false },
            { id: "page:two", name: "Second", current: false },
          ],
          frames,
          discovery: {
            query: "Charm",
            matchStatus: "ambiguous",
            matchCount: allFrames.length,
            framesDiscovered: allFrames.length,
            pagesVisited: 2,
            pagesAvailable: 2,
            nodesVisited: 30,
            truncated: false,
            offset,
            returnedFrameCount: frames.length,
            ...(offset === 0 ? { matchesTruncated: true, nextOffset: 8 } : {}),
          },
        };
      } else if (action.tool === "inspect_nodes") {
        result.results[0]!.data = {
          pageId: action.pageId,
          nodes: action.refs.map((ref) => ({
            ref,
            type: "FRAME",
            name: ref,
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            visible: true,
          })),
        };
      }
      return result;
    });
    const current = task();
    current.intent = "inspect";
    current.targetName = "Charm";
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    expect(current.inspectionOutcome).toBe("COMPLETED");
    expect(current.inspectionSummary).toMatchObject({
      pagesScanned: 2,
      pagesAvailable: 2,
      framesDiscovered: 12,
      matchingFrames: 12,
      framesInspected: 12,
      uninspectedFrames: 0,
      nativePerformance: { modelRequests: 0, framesReturned: 12, pagesLoaded: 4, nodesVisited: 60 },
      canvasMutations: 0,
    });
    expect(
      h.batches
        .flat()
        .filter(({ action }) => action.tool === "get_document_context")
        .map(({ action }) => (action.tool === "get_document_context" ? action.offset ?? 0 : -1)),
    ).toEqual([0, 8]);
    expect(
      h.batches
        .flat()
        .filter(({ action }) => action.tool === "inspect_nodes")
        .flatMap(({ action }) => (action.tool === "inspect_nodes" ? action.refs : [])),
    ).toHaveLength(12);
    expect(chatTaskCommittedOperationCount(current)).toBe(0);
  });

  it("stops scheduling native work when cancellation arrives during inspection", async () => {
    const h = harness([], false);
    const current = task();
    current.intent = "inspect";
    current.targetName = "Charm";
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      h.controller.abort();
      const result = success(operations);
      result.success = false;
      result.cancelled = true;
      result.results[0]!.success = false;
      result.results[0]!.error = "Cancelled during read-only inspection.";
      return result;
    });

    await expect(runChatTask(current, h.deps)).rejects.toThrow("Stopped");

    expect(h.batches).toHaveLength(1);
    expect(current.status).toBe("stopped");
    expect(current.inspectionOutcome).toBe("CANCELLED");
    expect(current.failure).toMatchObject({
      category: "cancelled",
      code: "request_cancelled",
      cancellationSource: "ui_abort",
    });
    expect(current.text).toContain("Inspection status: Cancelled.");
    expect(current.text).toContain("Canvas mutations: 0.");
  });

  it("reports an unrecoverable native inspection failure without claiming completion", async () => {
    const h = harness([], false);
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      const action = operations[0]!.action;
      if (action.tool === "get_document_context")
        result.results[0]!.data = {
          page: { id: "page:current", name: "Current" },
          pages: [{ id: "page:current", name: "Current", current: true }],
          frames: [{ ref: "charm-home", pageId: "page:charm", pageName: "Charm", name: "Charm Home", type: "FRAME", x: 0, y: 0, width: 390, height: 844 }],
          discovery: { query: "Charm", matchStatus: "unique", matchCount: 1, pagesVisited: 1, pagesAvailable: 1, framesDiscovered: 1, truncated: false },
        };
      else {
        result.success = false;
        result.results[0]!.success = false;
        result.results[0]!.error = "Native node inspection failed.";
      }
      return result;
    });
    const current = task();
    current.intent = "inspect";
    current.targetName = "Charm";

    await runChatTask(current, h.deps);

    expect(current.status).toBe("failed");
    expect(current.inspectionOutcome).toBe("FAILED");
    expect(current.inspectionSummary).toMatchObject({ framesDiscovered: 1, framesInspected: 0, uninspectedFrames: 1 });
    expect(current.text).toContain("Failed; native inspection could not be completed");
    expect(chatTaskCommittedOperationCount(current)).toBe(0);
  });

  it("keeps structured discovery evidence below the task checkpoint payload budget", async () => {
    const h = harness([], false);
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      result.results[0]!.data = {
        page: { id: "page:current", name: "Current" },
        pages: [{ id: "page:current", name: "Current", current: true }],
        frames: Array.from({ length: 8 }, (_, index) => ({
          ref: "charm-" + index,
          pageId: "page:current",
          pageName: "Current",
          name: "Charm " + index,
          type: "FRAME",
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          textHints: ["x".repeat(2_000), "y".repeat(2_000)],
        })),
        discovery: {
          query: "Charm",
          matchStatus: "ambiguous",
          matchCount: 8,
          framesDiscovered: 8,
          pagesVisited: 1,
          pagesAvailable: 1,
          nodesVisited: 32,
          truncated: false,
        },
      };
      return result;
    });
    const current = task();
    current.intent = "inspect";
    current.targetName = "Charm";

    await runChatTask(current, h.deps);

    const contextEntry = current.ledger.find(
      (entry) => entry.call.action.tool === "get_document_context",
    )!;
    expect(contextEntry.output!.length).toBeLessThanOrEqual(7_500);
    expect(JSON.parse(contextEntry.output!).data).toMatchObject({
      discovery: { matchCount: 8, truncated: false },
      frames: expect.any(Array),
    });
    expect(current.status).toBe("completed");
    expect(current.inspectionSummary?.framesInspected).toBe(8);
  });

  it("deterministically discovers and inspects an edit target before refusing a replacement root", async () => {
    const h = harness([
      turn("classify_canvas_intent", { intent: "edit", targetName: "Charm Home" }),
      turn("plan_canvas_task", {
        designName: "Charm",
        targetRefs: ["charm-home"],
        brief: defaultBrief,
        stages: [{
          title: "Improve Charm Home",
          goal: "Improve the verified existing Home frame.",
          logicalRefs: ["charm-home"],
          completionCriteria: ["The existing Home frame has the requested visual improvements."],
        }],
      }),
      turn("create_frame", {
        ref: "replacement-home",
        name: "Replacement Home",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
    ], false);
    const current = task();
    delete current.intent;

    await runChatTask(current, h.deps);
    expect(current.intent).toBe("edit");
    expect(current.designName).toBe("Charm");
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual([
      "get_document_context",
      "inspect_nodes",
    ]);
    expect(current.editTarget).toMatchObject({ ref: "charm-home", pageId: "page:charm", nodeId: "node-charm-home" });
    expect(h.lifecycles).toEqual(["UNPLANNED", "EDIT_PLANNING", "PLAN_SAVED"]);
    expect(current.failure?.code).toBe("native_execution_blocked");
    expect(current.ledger.some(({ call }) => call.action.tool === "create_frame")).toBe(false);
  });

  it("does not complete create intent when the model only returns prose", async () => {
    const h = harness([turn("classify_canvas_intent", { intent: "create" }), done], false);
    const current = task();
    delete current.intent;

    await expect(runChatTask(current, h.deps)).rejects.toThrow(
      "create request has no saved canvas plan",
    );
    expect(current.status).toBe("failed");
    expect(current.stages).toHaveLength(0);
    expect(h.batches).toHaveLength(0);
  });

  it("plans and verifies a cross-page edit against the inspected existing frame", async () => {
    const h = harness([
      turn("classify_canvas_intent", { intent: "edit", targetName: "Charm" }),
      turn("plan_canvas_task", {
        designName: "Charm",
        targetRefs: ["charm-home"],
        brief: defaultBrief,
        stages: [{
          title: "Improve Home",
          goal: "Improve the inspected existing Home frame.",
          pageId: "page:charm",
          logicalRefs: ["charm-home"],
          completionCriteria: ["Home remains native and meets the requested visual changes."],
        }],
      }),
      turn("set_properties", {
        pageId: "page:charm",
        ref: "charm-home",
        properties: { fill: "#9B3F62" },
      }),
      finish(),
      done,
    ], false);
    const current = task();
    delete current.intent;

    await runChatTask(current, h.deps);
    const verification = h.batches.flat().find(
      ({ action }) =>
        action.tool === "inspect_nodes" && action.purpose === "structural_verification",
    );
    expect(current.status).toBe("completed");
    expect(current.targetName).toBe("Charm");
    expect(current.stages[0]?.pageId).toBe("page:charm");
    expect(h.batches.flat().find(({ action }) => action.tool === "get_document_context")?.action)
      .toMatchObject({ query: "Charm" });
    expect(verification?.action).toMatchObject({ pageId: "page:charm" });
    expect(verification?.action).toMatchObject({ refs: ["charm-home"] });
    expect(current.text).toContain("Confirmed canvas mutations: 1");
    expect(current.text).toContain("root reference charm-home was preserved");
  });

  it.each([
    ["legacy", "#FFF0F5", false],
    ["structured", "#FFF0F5", false],
    ["structured", "#FFF9F4", true],
    ["covered", "#FFF9F4", true],
    ["covered", "#FFF0F5", false],
    ["blocked", "#FFF9F4", false],
    ["resumed", "#FFF0F5", false],
  ] as const)("reconciles the 11-round saved edit (%s, %s)", async (kind, initialFill, writes) => {
    const current = reportedPartialEditTask();
    current.id = "chat-1794466383934-p2wwgq";
    current.lifecycle = "PLAN_SAVED";
    current.failure!.phase = "native_execution";
    current.rounds = 11;
    const target = current.editTarget!;
    const stage = current.stages[0]!;
    target.plannedRefs = [target.ref];
    stage.logicalRefs = [target.ref];
    stage.goal = "Confirm native root fill exactly equals #FFF0F5 without mutations.";
    stage.completionCriteria = ["Native fill of existing root frame is #FFF0F5; no mutation performed."];
    stage.completionReason = "native_verification_pending";
    stage.estimatedMutations = 1;
    if (kind !== "legacy") {
      stage.goal = "Set the existing root fill";
      stage.propertyEdit = { tool: "set_properties", ref: target.ref, properties: { fill: "#FFF0F5" } };
    }
    const priorMutation = current.ledger.find((entry) => entry.category === "mutation")!;
    current.ledger = current.ledger.filter((entry) => entry.category !== "mutation");
    if (kind === "resumed") current.ledger.push(priorMutation);
    const historical = ["classify_canvas_intent", "plan_canvas_task", "inspect_nodes", "done",
      "inspect_nodes", "done", "inspect_nodes", "done", "inspect_nodes", "get_operation_status", "done"] as const;
    current.modelRoundTrace = historical.map((tool, index) => ({
      round: index + 1, lifecycle: index === 0 ? "UNPLANNED" : index === 1 ? "EDIT_PLANNING" : "PLAN_SAVED",
      outcome: tool === "done" ? "done" : "tool_calls", tools: tool === "done" ? [] : [tool],
      validationCodes: [], durationMs: 0, inputBytes: 0,
    }));
    const h = harness([done, done], false);
    let fill: string = initialFill;
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const op of operations) {
        if (op.action.tool === "set_properties") fill = op.action.properties.fill!;
        if (op.action.tool !== "inspect_nodes") continue;
        const data = result.results.find((item) => item.operationId === op.operationId)!.data!;
        data.nodes = [{ ref: target.ref, type: "FRAME", name: target.name, visible: true,
          x: target.x, y: target.y, width: target.width, height: target.height, fill: kind === "covered" ? "#FFF0F5" : fill }];
        const ref = kind === "covered" ? "visible-background" : target.ref;
        if (kind === "covered") (data.nodes as object[]).push({ ...(data.nodes as object[])[0], ref, type: "RECTANGLE", fill });
        if (kind !== "blocked") data.visualBackground = { rootRef: target.ref, rootNodeId: target.nodeId, ref,
          nodeId: kind === "covered" ? "68:134" : target.nodeId, fill };
      }
      return result;
    });
    if (kind === "blocked") {
      await expect(runChatTask(current, h.deps)).rejects.toThrow("visible background");
      expect(current.status).toBe("failed");
      return;
    }
    await runChatTask(current, h.deps);
    expect(h.deps.model).not.toHaveBeenCalled();
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual(
      writes ? ["inspect_nodes", "set_properties", "inspect_nodes"] : ["inspect_nodes"],
    );
    expect(current.status).toBe("completed");
    if (kind === "covered" && writes) expect(h.batches[1]?.[0]?.action).toMatchObject({ ref: "visible-background" });
    expect(stage.completionReason).toBe(writes || kind === "resumed" ? "required_refs_and_native_verification_confirmed" : "verified_no_op");
    expect(chatTaskCommittedOperationCount(current)).toBe(writes || kind === "resumed" ? 1 : 0);
    expect(target.nodeId).toBe("68:133");
  });

  it("reconciles three reused refs and preserves four off-plan creations on legacy continue resume", async () => {
    const current = reportedPartialEditTask();
    current.id = "chat-1794468051454-jjhs2d";
    current.intent = "continue";
    delete current.editTarget;
    const stage = current.stages[0]!;
    const [root, background] = stage.logicalRefs;
    const intro = "task-3aafa4981a685bdaefd93890f2053992";
    stage.logicalRefs.push(intro);
    stage.completionReason = "missing_creation_operation";
    current.ledger = [];
    const add = (tool: string, args: unknown, data: unknown, mutation = false) => {
      const response = turn(tool, args);
      if (response.kind !== "tool_calls") throw new Error("Expected call");
      current.ledger.push({ call: response.calls[0]!, operationId: `${current.id}-op-${current.ledger.length + 1}`,
        status: "completed", stage: 0, category: mutation ? "mutation" : "read_only",
        acknowledgementStatus: mutation ? "confirmed_mutation" : "read_only",
        output: JSON.stringify({ success: true, data }) });
    };
    add("get_document_context", {}, { discovery: { matchStatus: "unique" },
      frames: [{ ref: root, pageId: "0:1", type: "FRAME" }] });
    add("inspect_nodes", { pageId: "0:1", refs: [root] }, { pageId: "0:1",
      nodes: [{ ref: root, children: [{ ref: background }, { ref: intro }] }] });
    for (const [tool, ref] of [["create_frame", "polishHero"], ["create_text", "heroCopy"],
      ["create_rectangle", "heroBand"], ["create_text", "heroSubcopy"]]) {
      add(tool!, { ref, pageId: "0:1", name: ref, parent: { kind: "node", ref: ref === "polishHero" ? root : "polishHero" },
        size: { width: 100, height: 40 }, ...(tool === "create_text" ? { text: "Charm" } : {}) }, {}, true);
    }
    const h = harness([], false);
    await expect(runChatTask(current, h.deps)).rejects.toThrow("outside the saved enhancement specification");
    expect(h.deps.model).not.toHaveBeenCalled();
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual(["inspect_nodes"]);
    expect(chatTaskCommittedOperationCount(current)).toBe(4);
    expect(stage.completed).toBe(false);
    expect(stage.verificationOperations).toBe(1);
  });

  it("reserves nested aliases in the 10 and 6 call Charm batches after atomically rejecting a ref collision", async () => {
    const current = reportedPartialEditTask();
    current.id = "chat-1794469538757-ejm4jz";
    current.lifecycle = "PLAN_SAVED";
    const target = current.editTarget!;
    const stage = current.stages[0]!;
    const existing = [...target.verifiedRefs, "task-d12ddc8f99ff0679add2b5179a612d21",
      "task-d0baefe3ceaf3bc57cfa598b4e5dd7ed", "task-074450a5446e70e7cbc3817d6211027f",
      "task-63d52d619508b0474b9dce59716c115f"];
    target.plannedRefs = [...existing];
    target.verifiedRefs = [...existing];
    stage.logicalRefs = [...existing];
    current.ledger = current.ledger.filter((entry) => entry.category !== "mutation");
    const calls = (...turns: AuthorizedChatTurn[]): AuthorizedChatTurn => {
      const items = turns.flatMap((item) => item.kind === "tool_calls" ? item.calls : []);
      return { kind: "tool_calls", calls: items, functionCallItems: items.map((item) => item.functionCall), text: "" };
    };
    const create = (tool: string, ref: string, parentRef = target.ref) => turn(tool, {
      ref, name: ref, pageId: target.pageId, size: { width: 160, height: 40 },
      parent: { kind: "node", ref: parentRef }, ...(tool === "create_text" ? { text: "Charm" } : {}),
    });
    const set = (ref: string) => turn("set_properties", { ref, pageId: target.pageId, properties: { visible: true } });
    const first = (header: string) => calls(set(existing[1]!), set(existing[2]!),
      create("create_frame", header), create("create_frame", "banner"),
      create("create_frame", "categories"), create("create_frame", "products"),
      create("create_rectangle", "bannerSurface", "banner"),
      create("create_text", "logo", header), create("create_text", "bannerTitle", "banner"),
      create("create_text", "categoryLabel", "categories"));
    const second = calls(set(existing[3]!), set(existing[4]!), set(existing[5]!),
      create("create_frame", "productCard", "products"),
      create("create_text", "productName", "productCard"), create("create_text", "price", "productCard"));
    const h = harness([first(existing[3]!), first("header"), second, finish()], false);
    await runChatTask(current, h.deps);
    expect(h.inputs[1]?.some((item) => "content" in item && JSON.stringify(item).includes(existing[3]!))).toBe(true);
    expect(current.editReferenceDiagnostic).toContain(existing[3]);
    expect(h.batches.flat().filter(({ action }) => isCanvasMutationTool(action.tool))).toHaveLength(16);
    const creations = h.batches.flat().filter(({ action }) => action.tool.startsWith("create_"));
    expect(creations).toHaveLength(11);
    expect(new Set(stage.logicalRefs).size).toBe(18);
    expect(h.checkpoints.some((checkpoint) => checkpoint.pending.length === 10 &&
      checkpoint.stages[0]?.logicalRefs.includes("header"))).toBe(true);
    expect(h.batches.at(-1)?.[0]?.action).toMatchObject({ tool: "inspect_nodes", refs: stage.logicalRefs });
    expect(target.nodeId).toBe("68:133");
    expect(current.status).toBe("completed");
  });

  it("resumes the reported live edit, reuses the verified background ref, and verifies the confirmed fill once", async () => {
    const current = reportedPartialEditTask();
    const h = harness(
      [
        finish(),
        turn("inspect_nodes", {
          pageId: "0:1",
          refs: ["task-caba0d5eb320fddc43748146a97ca144"],
          selection: false,
          depth: 1,
          maxNodes: 5,
        }),
        finish(),
      ],
      false,
    );
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes" || operation.action.purpose !== "structural_verification")
          continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId)!;
        item.data!.nodes = operation.action.refs.map((ref) => ({
          ref,
          type: ref.endsWith("144") ? "FRAME" : "RECTANGLE",
          name: ref.endsWith("144") ? "خانه | Charm" : "خانه - زمینه",
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          fill: "#FFF0F5",
        }));
        markVerifiedStructure(item.data!, operation.action.refs.length);
      }
      return result;
    });

    await runChatTask(current, h.deps);

    expect(current).toMatchObject({ status: "completed", lifecycle: "TASK_COMPLETED" });
    expect(current.stages[0]).toMatchObject({
      completed: true,
      verified: true,
      operations: 1,
      estimatedMutations: 6,
      verificationOperations: 1,
      completionReason: "required_refs_and_native_verification_confirmed",
    });
    expect(current.stages[0]?.logicalRefs).toEqual([
      "task-caba0d5eb320fddc43748146a97ca144",
      "task-71c74e09c3a188e7a94c9eb1b1e6550f",
    ]);
    expect(current.ledger.filter((entry) => entry.category === "mutation")).toHaveLength(1);
    expect(current.ledger.filter((entry) => entry.category === "verification")).toHaveLength(1);
    expect(
      h.batches.flat().filter((operation) => isCanvasMutationTool(operation.action.tool)),
    ).toHaveLength(0);
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual(["inspect_nodes"]);
    expect(h.deps.model).toHaveBeenCalledTimes(1);
    expect(current.text).toContain("fill #FFF0F5");
    expect(current.text).toContain("Confirmed canvas mutations: 1");
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      committedOperations: 1,
      stageCapacity: [
        expect.objectContaining({
          remainingRequirements: 0,
          confirmedMutations: 1,
          verificationOperations: 1,
        }),
      ],
    });
    expect(
      JSON.parse(current.ledger.find((entry) => entry.category === "verification")!.output!),
    ).toMatchObject({ propertyVerificationConfirmed: true, verifiedPropertyCount: 1 });
  });

  it("blocks saved-task completion when native QA reaches its scan limit", async () => {
    const current = reportedPartialEditTask();
    const h = harness([finish()], false);
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes") continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId)!;
        item.data!.nodes = operation.action.refs.map((ref) => ({
          ref,
          type: ref === current.editTarget!.ref ? "FRAME" : "RECTANGLE",
          name: ref,
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          ...(ref === current.editTarget!.ref ? { fill: "#FFF0F5" } : {}),
        }));
        Object.assign(item.data!, {
          repairPipelineVersion: "native-quality-repair-v1",
          qualityFindings: [],
          nativeRepairPlan: [],
          qualityCoverage: {
            complete: false,
            truncated: true,
            nodeCount: MAX_NATIVE_QUALITY_SCAN_NODES,
            findingCount: 0,
          },
        });
      }
      return result;
    });

    await expect(runChatTask(current, h.deps)).rejects.toThrow(
      "native_verification_capacity_exceeded",
    );

    expect(current.status).toBe("failed");
    expect(current.failure).toMatchObject({
      category: "verification",
      code: "native_verification_capacity_exceeded",
      committedOperations: 1,
    });
    expect(current.stages[0]?.completed).toBe(false);
    expect(current.stages[0]?.nativeQualityCoverage).toMatchObject({
      complete: false,
      truncated: true,
      nodeCount: MAX_NATIVE_QUALITY_SCAN_NODES,
    });
    expect(h.deps.model).not.toHaveBeenCalled();
    expect(h.batches.flat().filter(({ action }) => isCanvasMutationTool(action.tool))).toHaveLength(0);
  });

  it("reconciles a resumed edit before rejecting a model replay of the confirmed property update", async () => {
    const current = reportedPartialEditTask();
    const h = harness(
      [
        turn("set_properties", {
          pageId: "0:1",
          ref: "task-caba0d5eb320fddc43748146a97ca144",
          properties: { fill: "#FFF0F5" },
        }),
        finish(),
      ],
      false,
    );
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes" || operation.action.purpose !== "structural_verification")
          continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId)!;
        item.data!.nodes = operation.action.refs.map((ref) => ({
          ref,
          type: "FRAME",
          name: "verified existing target",
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          fill: "#FFF0F5",
        }));
        markVerifiedStructure(item.data!, operation.action.refs.length);
      }
      return result;
    });

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(h.deps.model).toHaveBeenCalledTimes(2);
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual(["inspect_nodes"]);
    expect(current.ledger.filter((entry) => entry.category === "mutation")).toHaveLength(1);
    expect(current.stages[0]).toMatchObject({ completed: true, verificationOperations: 1 });
  });

  it("rejects an impossible saved edit ref without replaying its confirmed mutation", async () => {
    const current = reportedPartialEditTask();
    current.editTarget!.plannedRefs = ["task-caba0d5eb320fddc43748146a97ca144"];
    const h = harness([finish()], false);

    await expect(runChatTask(current, h.deps)).rejects.toThrow("invalid_required_reference");

    expect(current.status).toBe("failed");
    expect(current.failure).toMatchObject({
      category: "verification",
      code: "invalid_required_reference",
      committedOperations: 1,
    });
    expect(current.stages[0]?.completed).toBe(false);
    expect(current.ledger.filter((entry) => entry.category === "mutation")).toHaveLength(1);
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it("routes a genuinely new missing ref to creation instead of repeating completion", async () => {
    const current = reportedPartialEditTask();
    const newRef = "new-charm-label";
    current.stages[0]!.logicalRefs.push(newRef);
    const h = harness(
      [
        finish(),
        turn("create_text", {
          pageId: "0:1",
          ref: newRef,
          name: "Charm label",
          parent: { kind: "node", ref: "task-caba0d5eb320fddc43748146a97ca144" },
          text: "Charm",
          size: { width: 120, height: 32 },
        }),
        finish(),
      ],
      false,
    );
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes" || operation.action.purpose !== "structural_verification")
          continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId)!;
        item.data!.nodes = operation.action.refs.map((ref) => ({
          ref,
          type: ref === "new-charm-label" ? "TEXT" : "FRAME",
          name: ref,
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          ...(ref === "task-caba0d5eb320fddc43748146a97ca144" ? { fill: "#FFF0F5" } : {}),
          ...(ref === "new-charm-label" ? { text: "Charm" } : {}),
        }));
        markVerifiedStructure(item.data!, operation.action.refs.length);
      }
      return result;
    });

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(h.deps.model).toHaveBeenCalledTimes(3);
    expect(
      h.batches.flat().filter((operation) => operation.action.tool === "create_text"),
    ).toHaveLength(1);
    expect(
      h.batches.flat().filter((operation) => operation.action.tool === "set_properties"),
    ).toHaveLength(0);
    expect(current.stages[0]).toMatchObject({ completed: true, operations: 2, verificationOperations: 1 });
  });

  it("uses bounded native verification to fill a missing inspection checkpoint for a planned target ref", async () => {
    const current = reportedPartialEditTask();
    current.editTarget!.verifiedRefs = ["task-caba0d5eb320fddc43748146a97ca144"];
    const h = harness([finish()], false);
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes" || operation.action.purpose !== "structural_verification")
          continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId)!;
        item.data!.nodes = operation.action.refs.map((ref) => ({
          ref,
          type: ref.endsWith("144") ? "FRAME" : "RECTANGLE",
          name: ref,
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          fill: "#FFF0F5",
        }));
        markVerifiedStructure(item.data!, operation.action.refs.length);
      }
      return result;
    });

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(current.editTarget?.verifiedRefs).toContain("task-71c74e09c3a188e7a94c9eb1b1e6550f");
    expect(h.batches.flat().filter((operation) => isCanvasMutationTool(operation.action.tool))).toHaveLength(0);
    expect(current.stages[0]?.verificationOperations).toBe(1);
  });

  it("does not complete an edit when native fill evidence disagrees with the confirmed operation", async () => {
    const current = reportedPartialEditTask();
    const h = harness([finish()], false);
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      for (const operation of operations) {
        if (operation.action.tool !== "inspect_nodes" || operation.action.purpose !== "structural_verification")
          continue;
        const item = result.results.find(({ operationId }) => operationId === operation.operationId)!;
        item.data!.nodes = operation.action.refs.map((ref) => ({
          ref,
          type: "FRAME",
          name: "native target",
          x: 0,
          y: 0,
          width: 390,
          height: 844,
          visible: true,
          fill: "#FFF9F4",
        }));
        markVerifiedStructure(item.data!, operation.action.refs.length);
      }
      return result;
    });

    await expect(runChatTask(current, h.deps)).rejects.toThrow(
      "native_property_verification_failed",
    );

    expect(current.status).toBe("failed");
    expect(current.failure).toMatchObject({ category: "verification", code: "native_property_verification_failed" });
    expect(current.stages[0]?.completed).toBe(false);
    expect(current.ledger.filter((entry) => entry.category === "mutation")).toHaveLength(1);
    expect(current.ledger.filter((entry) => entry.category === "verification")).toHaveLength(1);
    expect(h.batches.flat().filter((operation) => isCanvasMutationTool(operation.action.tool))).toHaveLength(0);
  });

  it("recovers the reported three-round edit failure when the model returns done after discovery", async () => {
    const h = harness([
      turn("classify_canvas_intent", { intent: "edit" }),
      done,
      turn("plan_canvas_task", {
        targetRefs: ["charm-home"],
        brief: defaultBrief,
        stages: [{
          title: "Improve Charm Home",
          goal: "Improve the verified existing Charm Home frame.",
          logicalRefs: ["charm-home"],
          completionCriteria: ["The native Home frame receives the requested edit."],
        }],
      }),
      turn("set_properties", {
        pageId: "page:charm",
        ref: "charm-home",
        properties: { fill: "#9B3F62" },
      }),
      finish(),
      done,
    ], false);
    const current = task();
    current.prompt = "design safhe home charm ro behtar kon";
    delete current.intent;

    await runChatTask(current, h.deps);

    expect(h.deps.model).toHaveBeenCalledTimes(5);
    expect(h.lifecycles.slice(0, 3)).toEqual(["UNPLANNED", "EDIT_PLANNING", "EDIT_PLANNING"]);
    expect(current.modelRoundTrace.slice(0, 3).map(({ outcome, tools }) => ({ outcome, tools }))).toEqual([
      { outcome: "tool_calls", tools: ["classify_canvas_intent"] },
      { outcome: "done", tools: [] },
      { outcome: "tool_calls", tools: ["plan_canvas_task"] },
    ]);
    expect(current.status).toBe("completed");
    expect(current.failure).toBeUndefined();
    expect(current.stages).toHaveLength(1);
    expect(current.editTarget?.query).toBe("home charm");
    expect(current.ledger.filter((entry) => isCanvasMutationTool(entry.call.action.tool))).toHaveLength(1);
    expect(chatTaskCommittedOperationCount(current)).toBe(1);
    expect(current.text).toContain("Charm Home");
  });

  it("blocks a named edit when discovery is ambiguous", async () => {
    const h = harness([
      turn("classify_canvas_intent", { intent: "edit", targetName: "Charm" }),
      done,
    ], false);
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      const result = success(operations);
      result.results[0]!.data = {
        page: { id: "page:current", name: "Current" },
        discovery: { matchStatus: "ambiguous", matchCount: 2, complete: true, truncated: false, paused: false, pagesRemaining: 0 },
        frames: [
          { ref: "charm-home", pageId: "page:one", name: "Charm Home" },
          { ref: "charm-home-copy", pageId: "page:two", name: "Charm Home" },
        ],
      };
      return result;
    });
    const current = task();
    delete current.intent;

    await runChatTask(current, h.deps);
    expect(h.batches.flat().map(({ action }) => action.tool)).toEqual([
      "get_document_context",
    ]);
    expect(current.stages).toHaveLength(0);
    expect(current.failure).toMatchObject({ code: "target_ambiguous", committedOperations: 0 });
    expect(h.deps.model).toHaveBeenCalledTimes(1);
    expect(current.text).toContain("matches multiple existing frames");
  });

  it("exports a sanitized correlated diagnostic without prompt, node content, or raw arguments", () => {
    const current = task();
    const callTurn = turn("set_properties", {
      ref: "private-ref",
      properties: { text: "PRIVATE CANVAS CONTENT" },
    });
    if (callTurn.kind !== "tool_calls") throw new Error("Expected a tool call.");
    const call = callTurn.calls[0]!;
    current.stages = [
      {
        title: "Product details",
        goal: "Keep private",
        logicalRefs: ["private-ref"],
        completionCriteria: ["Keep private"],
        completed: false,
        estimatedMutations: 3,
        operations: 1,
        readOnlyOperations: 0,
        segments: [],
        rounds: 7,
        qaAttempts: 0,
        verificationOperations: 0,
        verified: false,
        verificationHistory: [],
        qualityFindings: [],
        repairOperationsExecuted: 0,
        repairOperationsAttempted: 0,
        awaitingQualityRepair: false,
      },
    ];
    current.ledger = [
      {
        call,
        operationId: "chat-task-0001-op-1",
        stage: 0,
        status: "failed",
        output: JSON.stringify({
          success: false,
          error: "PRIVATE CANVAS CONTENT and raw operation arguments",
          data: {
            referenceResolution: {
              code: "ambiguous",
              candidateCount: 4,
              candidates: [{ canonicalRef: "PRIVATE CANVAS CONTENT" }],
            },
          },
        }),
      },
    ];
    current.failure = {
      category: "ambiguous_recovery",
      code: "inspection_required",
      committedOperations: 1,
      operationId: "chat-task-0001-op-1",
    };
    current.rounds = 7;
    current.batches = 6;
    const diagnostic = chatTaskSafeDiagnostic(current);
    expect(diagnostic).toMatchObject({
      taskId: current.id,
      stageId: "stage-1",
      callId: call.callId,
      tool: "set_properties",
      failureCategory: "ambiguous_recovery",
      errorCode: "inspection_required",
      referenceResolution: { code: "ambiguous", candidateCount: 4 },
      committedOperations: 1,
      capacity: {
        mutationCapacity: 240,
        mutations: 1,
        confirmedMutations: 0,
        readOnlyOperations: 0,
        verificationOperations: 0,
        confirmedNodes: 0,
      },
      completionReason: "pending_or_failed_mutations",
      stageCapacity: [
        {
          stageId: "stage-1",
          mutationUsage: 1,
          remainingRequirements: 1,
          completionReason: "pending_or_failed_mutations",
        },
      ],
      modelRounds: 7,
      nativeBatches: 6,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
    expect(JSON.stringify(diagnostic)).not.toContain(current.prompt);
    current.failure!.code = "private_canvas_text";
    current.ledger[0]!.output = JSON.stringify({
      data: { referenceResolution: { code: "private_canvas_text", candidateCount: 4 } },
    });
    const tamperedDiagnostic = JSON.stringify(chatTaskSafeDiagnostic(current));
    expect(tamperedDiagnostic).not.toContain("private_canvas_text");
    expect(tamperedDiagnostic).toContain('"errorCode":"task_paused"');
  });

  it("reports a missing plan separately from missing stage refs and labels recovery by phase", () => {
    const current = task();
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      completionReason: "plan_not_saved",
      failureCategory: "none",
      errorCode: "none",
    });
    expect(chatTaskSafeDiagnostic(current)).not.toHaveProperty("stageId");

    current.status = "failed";
    current.failure = {
      category: "inspection",
      code: "inspection_failed",
      phase: "inspection",
      committedOperations: 0,
    };
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      completionReason: "plan_not_saved",
      failureCategory: "inspection",
      errorCode: "inspection_failed",
      failurePhase: "inspection",
    });
    expect(chatTaskRetryLabel(current)).toBe("Retry inspection");
  });

  it("continues fresh-design planning after a failed pre-plan inspection", async () => {
    const current = task();
    const inspection = turn("inspect_nodes", {
      refs: ["existing-selection"],
      selection: false,
      depth: 0,
      maxNodes: 1,
    });
    const h = harness([
      inspection,
      plan(["New design"], ["product-0"]),
      creates(1),
      finish(),
      done,
    ]);
    h.deps.execute.mockImplementationOnce(async (operations) => {
      const result = success(operations);
      return {
        ...result,
        success: false,
        results: result.results.map((item) => ({
          ...item,
          success: false,
          acknowledgementStatus: "rejected" as const,
          error: "The current selection could not be inspected.",
        })),
      };
    });

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(current.stages[0]?.title).toBe("New design");
    expect(current.failure).toBeUndefined();
    expect(h.deps.execute).toHaveBeenCalled();
  });

  it("continues a fresh two-screen plan after failed context and more than four read-only turns", async () => {
    const current = task();
    const twoScreenPlan = turn("plan_canvas_task", {
      brief: {
        ...defaultBrief,
        content: ["Home screen", "Product screen"],
        hierarchy: "Two ordered storefront screens: home, then product details.",
      },
      stages: [
        {
          title: "Home and product screens",
          goal: "Create both requested storefront screens as editable native layers.",
          logicalRefs: ["screen-0", "screen-1"],
          completionCriteria: ["Both screen frames exist as editable native layers."],
        },
      ],
    });
    const prePlanReadOnlyTurns = [
      turn("get_document_context", {}),
      ...Array.from({ length: 4 }, (_, index) =>
        turn("inspect_nodes", {
          refs: [`unavailable-target-${index}`],
          selection: false,
          depth: 0,
          maxNodes: 1,
        }),
      ),
    ];
    const h = harness(
      [...prePlanReadOnlyTurns, twoScreenPlan, creates(2, "screen"), finish(), done],
      false,
    );
    for (let index = 0; index < prePlanReadOnlyTurns.length; index++)
      h.deps.execute.mockImplementationOnce(async (operations) => {
        const result = success(operations);
        return {
          ...result,
          success: false,
          results: result.results.map((item) => ({
            ...item,
            success: false,
            acknowledgementStatus: "rejected" as const,
            error: `Optional pre-plan read-only call ${index + 1} failed.`,
          })),
        };
      });

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(current.lifecycle).toBe("TASK_COMPLETED");
    expect(current.roundBreakdown.prePlan).toBe(6);
    expect(current.stages[0]?.logicalRefs).toEqual(["screen-0", "screen-1"]);
    expect(
      current.ledger
        .filter(
          (entry) =>
            entry.category === "read_only" &&
            (entry.call.action.tool === "get_document_context" ||
              entry.call.action.tool === "inspect_nodes"),
        )
        .every((entry) => entry.status === "failed"),
    ).toBe(true);
    expect(
      h.checkpoints.some(
        (checkpoint) => checkpoint.lifecycle === "PLAN_SAVED" && checkpoint.stages.length === 1,
      ),
    ).toBe(true);
    expect(chatTaskCommittedOperationCount(current)).toBe(2);
    expect(current.failure).toBeUndefined();
  });

  it("reports the original planning phase instead of generic task_paused", async () => {
    const current = task();
    const h = harness([new Error("The model request failed before returning a plan.")], false);

    await expect(runChatTask(current, h.deps)).rejects.toThrow(
      "The model request failed before returning a plan.",
    );

    expect(current.failure).toMatchObject({
      category: "planning",
      code: "planning_failed",
      phase: "planning",
    });
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      errorCode: "planning_failed",
      completionReason: "plan_not_saved",
    });
  });

  it("preserves structured tool-state failure details in the task checkpoint", async () => {
    const current = task();
    const h = harness([turn("get_document_context", {})]);
    const diagnostic = {
      category: "storage_unavailable" as const,
      location: "save" as const,
      schemaVersion: 3,
      serializedBytes: null,
    };
    h.deps.execute.mockImplementationOnce(async (operations) => ({
      type: "tool-result",
      protocolVersion: 1,
      batchId: "task-test-batch",
      success: false,
      cancelled: false,
      committedOperationIds: [],
      partialOperationIds: [],
      results: [
        {
          operationId: operations[0]!.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "not_attempted",
          error: "Figma clientStorage write failed.",
          data: { toolStateDiagnostic: diagnostic },
        },
      ],
    }));

    await expect(runChatTask(current, h.deps)).rejects.toThrow("Figma clientStorage write failed");
    expect(current.failure).toMatchObject({
      category: "tool_state",
      code: "tool_state_storage_unavailable",
      phase: "state_persistence",
      toolStateDiagnostic: diagnostic,
    });
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      failureCategory: "tool_state",
      errorCode: "tool_state_storage_unavailable",
      failurePhase: "state_persistence",
      toolStateDiagnostic: diagnostic,
    });
  });

  it("labels checkpoint storage failures distinctly and avoids a blind checkpoint retry", async () => {
    const current = task();
    const h = harness([done]);
    h.deps.save.mockRejectedValue(
      new ChatTaskBridgeError("Task checkpoint could not be saved.", "checkpoint_save_failed"),
    );

    await expect(runChatTask(current, h.deps)).rejects.toThrow(
      "Task checkpoint could not be saved",
    );
    expect(h.deps.save).toHaveBeenCalledTimes(1);
    expect(current.failure).toMatchObject({
      category: "checkpoint_storage",
      code: "checkpoint_save_failed",
      phase: "checkpoint",
    });
    expect(chatTaskRetryLabel(current)).toBe("Retry storage recovery");
  });

  it("keeps model-authored stages separate from checkpoint execution fields", async () => {
    const current = task();
    const h = harness([plan(["Frame"]), creates(1), finish(), done]);
    await runChatTask(current, h.deps);
    const input = chatTaskInput(current);
    const checkpoint = input.find(
      (item) => "role" in item && item.content.startsWith("Confirmed task checkpoint"),
    );
    const checkpointContent = checkpoint && "role" in checkpoint ? checkpoint.content : "";
    const modelCheckpoint = JSON.parse(
      checkpointContent.slice(checkpointContent.indexOf(": ") + 2),
    );
    expect(Object.keys(modelCheckpoint.stages[0]).sort()).toEqual(
      ["completionCriteria", "estimatedMutations", "goal", "logicalRefs", "title"].sort(),
    );
    expect(current.stages[0]).toHaveProperty("completed", true);
  });

  it("normalizes exactly the reported runtime stage contamination but still rejects unsupported design fields", () => {
    const planned = plan(["Frame"]) as Extract<AuthorizedChatTurn, { kind: "tool_calls" }>;
    const item = planned.functionCallItems[0]!;
    const args = JSON.parse(item.arguments);
    Object.assign(args.stages[0], {
      completed: true,
      operations: 99,
      rounds: 99,
      verification: { success: true },
    });
    const [call] = parseResponsesFunctionCalls([{ ...item, arguments: JSON.stringify(args) }]);
    expect(call?.normalizedPlanningMetadata).toBe(true);
    expect(call?.action).toMatchObject({ planVersion: 1, stages: [{ title: "Frame" }] });
    expect(call?.action).not.toHaveProperty("stages.0.completed");
    args.stages[0].unsupportedStyling = "must not disappear";
    expect(() =>
      parseResponsesFunctionCalls([{ ...item, arguments: JSON.stringify(args) }]),
    ).toThrow();
  });

  it("reuses the canonical saved plan when the model requests planning again", async () => {
    const current = task();
    const h = harness([plan(["Original"]), plan(["Replacement"]), creates(1), finish(), done]);
    await runChatTask(current, h.deps);
    expect(current.stages[0]?.title).toBe("Original");
    expect(current.status).toBe("completed");
    expect(current.validationCorrections).toBe(0);
    expect(current.roundBreakdown.planning).toBe(2);
    expect(
      h.inputs
        .flat()
        .some(
          (item) =>
            "type" in item &&
            item.type === "function_call_output" &&
            JSON.parse(item.output).canonicalPlanReused === true,
        ),
    ).toBe(true);
  });

  it("does not spend the planning budget on four confirmed mutations and four inspections", async () => {
    const requiredRefs = ["home-screen", "home-header", "home-search", "home-hero"];
    const current = task();
    const h = harness([
      turn("plan_canvas_task", {
        brief: defaultBrief,
        stages: [
          {
            title: "Home",
            goal: "Build the Persian clothing storefront home screen",
            logicalRefs: requiredRefs,
            completionCriteria: [
              "Header, search, categories, hero, product cards, toman prices, and purchase buttons are editable RTL layers in Auto Layout",
            ],
          },
          {
            title: "Product",
            goal: "Build the Persian product screen",
            logicalRefs: ["product-0"],
            completionCriteria: [
              "Gallery placeholder, title, price, variants, details, and add-to-cart are editable RTL layers in Auto Layout",
            ],
          },
        ],
      }),
      ...requiredRefs.flatMap((ref, index) => [
        turn("create_frame", {
          ref,
          name: `Home requirement ${index + 1}`,
          parent: { kind: "page" },
          size: { width: 390, height: index ? 120 : 844 },
          autoLayout: { direction: "vertical", gap: 8 },
        }),
        turn("inspect_nodes", {
          refs: requiredRefs.slice(0, index + 1),
          selection: false,
          depth: 2,
          maxNodes: 25,
        }),
      ]),
      finish(),
      creates(4, "product"),
      finish(),
      done,
    ]);

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(current.stages.map(({ completed }) => completed)).toEqual([true, true]);
    expect(current.stages[0]).toMatchObject({
      operations: 4,
      rounds: 9,
      roundBreakdown: {
        execution: 4,
        inspection: 4,
        completion: 1,
      },
    });
    expect(current.roundBreakdown).toMatchObject({
      prePlan: 2,
      planning: 1,
      execution: 5,
      inspection: 5,
      completion: 2,
      correction: 0,
    });
    expect(chatTaskCommittedOperationCount(current)).toBe(8);
    expect(current.failure?.code).not.toBe("planning_budget_exhausted");
    const savedPlan = h.checkpoints.find(
      (checkpoint) =>
        checkpoint.stages.length === 2 &&
        !checkpoint.ledger.some(
          (entry) =>
            entry.status === "completed" && entry.call.action.tool !== "get_document_context",
        ),
    );
    expect(savedPlan?.stages.map(({ title }) => title)).toEqual(["Home", "Product"]);
    expect(savedPlan?.lifecycle).toBe("PLAN_SAVED");
    expect(h.checkpoints.some(({ lifecycle }) => lifecycle === "VERIFYING_STAGE")).toBe(true);
    expect(h.checkpoints.some(({ lifecycle }) => lifecycle === "STAGE_COMPLETED")).toBe(true);
    expect(current.lifecycle).toBe("TASK_COMPLETED");
  });

  it("keeps task and segment mutation counts equal when a failed operation was repaired", async () => {
    const current = task();
    current.lifecycle = "PLAN_SAVED";
    current.stages = [
      {
        title: "Product cards",
        goal: "Build cards",
        logicalRefs: ["product-0"],
        completionCriteria: ["Native card exists"],
        completed: false,
        estimatedMutations: 14,
        operations: 14,
        readOnlyOperations: 0,
        segments: [],
        rounds: 0,
        qaAttempts: 0,
        verificationOperations: 0,
        verified: false,
        verificationHistory: [],
        qualityFindings: [],
        repairOperationsExecuted: 0,
        repairOperationsAttempted: 0,
        awaitingQualityRepair: false,
      },
    ];
    current.ledger = Array.from({ length: 14 }, (_, index) => {
      const call = turn("create_frame", {
        ref: `product-${index}`,
        name: `Card ${index}`,
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      });
      if (call.kind !== "tool_calls") throw new Error("Expected a canvas mutation.");
      const repaired = index === 13;
      return {
        call: call.calls[0]!,
        operationId: `chat-task-0001-op-${String(index + 1).padStart(2, "0")}`,
        stage: 0,
        status: repaired ? ("repaired" as const) : ("completed" as const),
        category: "mutation" as const,
        acknowledgementStatus: repaired ? ("rejected" as const) : ("confirmed_mutation" as const),
        segment: 0,
      };
    });
    const h = harness([new Error("Stop after accounting sync")], false);
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Stop after accounting sync");
    const diagnostic = chatTaskSafeDiagnostic(current);
    expect(chatTaskCommittedOperationCount(current)).toBe(13);
    expect(current.stages[0]!.segments[0]).toMatchObject({
      mutationCount: 14,
      confirmedMutations: 13,
      rejectedMutations: 1,
    });
    expect(diagnostic.taskSegmentCountConsistency).toEqual({
      taskConfirmedMutations: 13,
      segmentConfirmedMutations: 13,
      consistent: true,
    });
  });

  it("exports allowlisted parenting and reconciliation diagnostics without canvas text", () => {
    const current = task();
    const parsed = turn("append_child", { childRef: "source-ref", parentRef: "target-ref" });
    if (parsed.kind !== "tool_calls") throw new Error("Expected a parenting call.");
    const call = parsed.calls[0]!;
    current.stages = [
      {
        title: "Move layer",
        goal: "Keep identity",
        logicalRefs: ["source-ref"],
        completionCriteria: ["The native parent is correct"],
        completed: false,
        estimatedMutations: 1,
        operations: 1,
        readOnlyOperations: 0,
        segments: [],
        rounds: 0,
        qaAttempts: 0,
        verificationOperations: 0,
        verified: false,
        verificationHistory: [],
        qualityFindings: [],
        repairOperationsExecuted: 0,
        repairOperationsAttempted: 0,
        awaitingQualityRepair: false,
      },
    ];
    current.ledger = [
      {
        call,
        operationId: "chat-task-0001-op-1",
        stage: 0,
        status: "failed",
        category: "mutation",
        acknowledgementStatus: "ambiguous",
        output: JSON.stringify({
          success: false,
          error: "PRIVATE CANVAS TEXT must not escape",
          data: {
            parenting: {
              operationId: "chat-task-0001-op-1",
              toolName: "append_child",
              sourceLogicalRef: "source-ref",
              targetLogicalRef: "target-ref",
              sourceParentCategory: "frame",
              expectedParentCategory: "frame",
              actualParentCategory: "frame",
              decision: "native_error",
              acknowledgementStatus: "ambiguous",
            },
          },
        }),
      },
    ];
    current.failure = {
      category: "ambiguous_recovery",
      code: "inspection_required",
      committedOperations: 0,
      operationId: "chat-task-0001-op-1",
    };
    const diagnostic = chatTaskSafeDiagnostic(current);
    expect(diagnostic).toMatchObject({
      parenting: {
        operationId: "chat-task-0001-op-1",
        toolName: "append_child",
        sourceLogicalRef: "source-ref",
        targetLogicalRef: "target-ref",
        sourceParentCategory: "frame",
        expectedParentCategory: "frame",
        actualParentCategory: "frame",
        acknowledgementStatus: "ambiguous",
      },
      partialCommitReconciliation: {
        operationId: "chat-task-0001-op-1",
        acknowledgementStatus: "ambiguous",
        result: "inspection_required",
      },
      taskSegmentCountConsistency: {
        taskConfirmedMutations: 0,
        segmentConfirmedMutations: 0,
        consistent: true,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE CANVAS TEXT");
  });

  it("reuses an identical inspection locally until canvas state changes", async () => {
    const inspection = () =>
      turn("inspect_nodes", {
        refs: ["product-0"],
        selection: false,
        depth: 2,
        maxNodes: 25,
      });
    const current = task();
    const h = harness([plan(["Frame"]), creates(1), inspection(), inspection(), finish(), done]);

    await runChatTask(current, h.deps);

    const modelInspections = current.ledger.filter(
      (entry) => entry.call.action.tool === "inspect_nodes" && !entry.operationId.includes("-qa-"),
    );
    expect(modelInspections).toHaveLength(2);
    expect(modelInspections[1]).toMatchObject({ status: "completed", reused: true });
    expect(
      h.batches.flat().filter((operation) => operation.action.tool === "inspect_nodes"),
    ).toHaveLength(2);
  });

  it.each([
    ["Local tool rate limit reached", "rate_limit"],
    ["Font loading timed out", "timeout"],
    ["This node does not support a fill color", "executor_validation"],
    ["Figma API write failed", "figma_runtime"],
    ["The operation was interrupted", "ambiguous_recovery"],
  ])("classifies %s without claiming success", async (message, category) => {
    const current = task();
    const h = harness([plan(["Frame"]), creates(1)]);
    h.deps.execute.mockImplementation(async (operations) => {
      if (operations.every((operation) => operation.action.tool === "get_document_context"))
        return success(operations);
      const acknowledgementStatus = message.includes("rate limit")
        ? ("not_attempted" as const)
        : message.includes("does not support")
          ? ("rejected" as const)
          : ("ambiguous" as const);
      return {
        ...success([]),
        success: false,
        partialOperationIds:
          acknowledgementStatus === "ambiguous" ? [operations[0]!.operationId] : [],
        results: [
          {
            operationId: operations[0]!.operationId,
            success: false,
            replayed: false,
            acknowledgementStatus,
            error: message,
          },
        ],
      };
    });
    await expect(runChatTask(current, h.deps)).rejects.toThrow();
    expect(current.status).toBe("failed");
    expect(current.failure).toMatchObject({ category, committedOperations: 0 });
    expect(current.failure?.operationId).toBeDefined();
  });

  it("persists timeout correlation after seven commits and resumes the same stage without replay", async () => {
    const requiredRefs = Array.from({ length: 9 }, (_, index) => `home-${index}`);
    const planTurn = turn("plan_canvas_task", {
      brief: defaultBrief,
      stages: [
        {
          title: "Home",
          goal: "Finish the saved Home layout",
          logicalRefs: requiredRefs,
          completionCriteria: ["All nine Home refs are native and editable"],
        },
      ],
    });
    const diagnostic = {
      model: "account-model",
      requestId: "chat-timeout-live-01",
      requestStartedAtMs: 1_800_000_000_000,
      requestPhase: "upstream_stream",
      stage: "stream",
      outcome: "timed_out",
      timeoutKind: "idle",
      timeoutSource: "upstream_inactivity",
      terminationReason: "upstream_inactivity",
      elapsedMs: 62_000,
      idleMs: 60_000,
      lastEvent: "response.output_item.done",
      lastEventAtMs: 1_800_000_002_000,
      lastEventAgeMs: 60_000,
    } as const;
    const h = harness([
      planTurn,
      creates(7, "home"),
      new CompanionClientError("request_timed_out", diagnostic),
    ]);
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toMatchObject({
      category: "request_timed_out",
    });
    expect(chatTaskCommittedOperationCount(current)).toBe(7);
    expect(current.stages[0]?.logicalRefs).toEqual(requiredRefs);
    expect(current.lastRequestDiagnostic).toMatchObject({
      requestId: "chat-timeout-live-01",
      requestPhase: "upstream_stream",
      timeoutKind: "idle",
      timeoutSource: "upstream_inactivity",
      terminationReason: "upstream_inactivity",
      elapsedMs: 62_000,
      lastEventAtMs: 1_800_000_002_000,
    });
    expect(h.checkpoints.at(-1)?.lastRequestDiagnostic).toEqual(current.lastRequestDiagnostic);
    const confirmedIds = current.ledger
      .filter((entry) => entry.status === "completed" && entry.category === "mutation")
      .map((entry) => entry.operationId);

    const tail = [
      turn("create_frame", {
        ref: "home-7",
        name: "Home footer",
        parent: { kind: "page" },
        size: { width: 342, height: 48 },
      }),
      turn("create_frame", {
        ref: "home-8",
        name: "Home footer content",
        parent: { kind: "page" },
        size: { width: 342, height: 48 },
      }),
    ].flatMap((turnValue) => (turnValue.kind === "tool_calls" ? turnValue.calls : []));
    const tailTurn: AuthorizedChatTurn = {
      kind: "tool_calls",
      calls: tail,
      functionCallItems: tail.map((call) => call.functionCall),
      text: "",
    };
    const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    const resumed = harness([tailTurn, finish(), done]);
    await runChatTask(restored, resumed.deps);

    expect(restored.status).toBe("completed");
    expect(chatTaskCommittedOperationCount(restored)).toBe(9);
    expect(
      restored.ledger.filter((entry) => confirmedIds.includes(entry.operationId)),
    ).toHaveLength(7);
    expect(
      resumed.batches
        .flat()
        .filter((operation) => operation.action.tool !== "inspect_nodes")
        .map(({ operationId }) => operationId),
    ).toHaveLength(2);
    expect(restored.stages[0]?.completed).toBe(true);
    expect(restored.lastRequestDiagnostic?.requestId).toBe("chat-timeout-live-01");
  });

  it("completes 50 operations across five planned stages using bounded ten-operation batches", async () => {
    const turns = [
      plan(
        [
          "Page frame",
          "Header and navigation",
          "Search and categories",
          "Editable product cards",
          "Purchase buttons",
        ],
        ["section-0-0", "section-1-0", "section-2-0", "section-3-0", "section-4-0"],
      ),
      ...Array.from({ length: 5 }, (_, index) => [
        creates(10, `section-${index}`),
        finish(),
      ]).flat(),
      done,
    ];
    const h = harness(turns);
    const current = task();
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    expect(
      current.ledger.filter((entry) => entry.call.action.tool !== "inspect_nodes"),
    ).toHaveLength(51);
    expect(
      current.ledger.filter((entry) => entry.call.action.tool === "inspect_nodes"),
    ).toHaveLength(5);
    expect(current.stages.every((stage) => stage.completed)).toBe(true);
    expect(h.batches).toHaveLength(11);
    expect(h.batches.every((batch) => batch.length <= 10)).toBe(true);
    expect(h.deps.wait).toHaveBeenCalled();
    expect(new Set(h.batches.flat().map((op) => op.operationId)).size).toBe(56);
    expect(chatTaskProgress(current)).toContain("5/5 stages completed");
    expect(chatTaskProgress(current)).toContain("50 mutations confirmed");
    for (const input of h.inputs) {
      const calls = input.filter((item) => "type" in item && item.type === "function_call");
      const outputs = input.filter(
        (item) => "type" in item && item.type === "function_call_output",
      );
      expect(calls.length).toBe(outputs.length);
      expect(input.length).toBeLessThanOrEqual(40);
    }
    expect(
      h.checkpoints.some((checkpoint) =>
        checkpoint.ledger.some((entry) => entry.status === "running"),
      ),
    ).toBe(true);
  });

  it("stops after a confirmed stage, reloads the checkpoint, and resumes without replaying mutations", async () => {
    const h = harness([plan(["Products"], ["product-0"]), creates(8), finish(), done]);
    const current = task();
    h.deps.execute.mockImplementationOnce(async (operations) => success(operations));
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      h.controller.abort();
      return success(operations);
    });
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Stopped");
    expect(
      current.ledger.filter(
        (entry) =>
          entry.status === "completed" && entry.call.action.tool !== "get_document_context",
      ),
    ).toHaveLength(8);
    const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    const resume = harness([finish(), done]);
    await runChatTask(restored, resume.deps);
    expect(resume.batches.flat().every((op) => op.action.tool === "inspect_nodes")).toBe(true);
    expect(
      resume.batches
        .flat()
        .some((op) =>
          current.ledger
            .filter(
              (entry) =>
                entry.status === "completed" && entry.call.action.tool !== "get_document_context",
            )
            .some((entry) => entry.operationId === op.operationId),
        ),
    ).toBe(false);
    expect(restored.ledger.every((entry) => entry.status === "completed")).toBe(true);
  });

  it("replays identical operation IDs after a lost result without asking the model to regenerate", async () => {
    const h = harness([plan(["Frame"]), creates(2)]);
    h.deps.execute.mockImplementationOnce(async (operations) => success(operations));
    h.deps.execute.mockRejectedValueOnce(new Error("Lost Figma result"));
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Lost Figma result");
    const dispatched = h.deps.execute.mock.calls[1]![0];
    const resume = harness([finish(), done]);
    await runChatTask(ChatTaskSchema.parse(h.checkpoints.at(-1)), resume.deps);
    expect(resume.batches[0]).toEqual(dispatched);
  });

  it("waits on executor rate limits and reuses the rejected operation IDs", async () => {
    const h = harness([plan(["Frame"]), creates(3), finish(), done]);
    h.deps.execute.mockImplementationOnce(async (ops) => success(ops));
    h.deps.execute.mockImplementationOnce(async (ops) => ({
      ...success([]),
      success: false,
      results: ops.map((operation, index) => ({
        operationId: operation.operationId,
        success: false,
        replayed: false,
        acknowledgementStatus: "not_attempted" as const,
        error:
          index === 0
            ? "Local tool rate limit reached; wait one minute before retrying with the same IDs."
            : "Not attempted because executor capacity was exhausted.",
      })),
    }));
    await runChatTask(task(), h.deps);
    expect(h.deps.wait).toHaveBeenCalledWith(60_100, expect.any(AbortSignal));
    expect(h.deps.execute.mock.calls[2]![0]).toEqual(h.deps.execute.mock.calls[1]![0]);
  });

  it("waits on provider capacity and Stop interrupts capacity waits", async () => {
    const h = harness([done]);
    h.deps.model.mockRejectedValueOnce(new CompanionClientError("quota_or_rate_limit"));
    const conversationalTask = task();
    delete conversationalTask.intent;
    await runChatTask(conversationalTask, h.deps);
    expect(h.deps.wait).toHaveBeenCalledWith(60_100, expect.any(AbortSignal));
    const stop = new AbortController();
    const waiting = waitForChatCapacity(60_000, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow("Stopped");
  });

  it("retains commits on failure and requires a confirmed same-ref repair before completion", async () => {
    const current = task();
    const h = harness([plan(["Products"]), creates(3)]);
    h.deps.execute.mockImplementationOnce(async (ops) => success(ops));
    h.deps.execute.mockImplementationOnce(async (ops) => ({
      ...success(ops.slice(0, 1)),
      success: false,
      partialOperationIds: [],
      results: [
        ...success(ops.slice(0, 1)).results,
        {
          operationId: ops[1]!.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "rejected",
          error: "Invalid parent",
        },
        {
          operationId: ops[2]!.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "not_attempted",
          error: "Not attempted after earlier failure.",
        },
      ],
    }));
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Invalid parent");
    expect(
      current.ledger
        .filter(
          (entry) =>
            entry.call.action.tool !== "inspect_nodes" &&
            entry.call.action.tool !== "get_document_context",
        )
        .map((entry) => entry.status),
    ).toEqual(["completed", "failed", "failed"]);
    const resume = harness([creates(1, "product-1-repair"), finish(), done]);
    // A different ref cannot be used to hide a missing product.
    resume.deps.model.mockImplementationOnce(async () => creates(1, "product-1-repair"));
    await expect(runChatTask(current, resume.deps)).rejects.toThrow();
    expect(current.status).toBe("failed");
    expect(current.stages[0]!.completed).toBe(false);
    expect(current.ledger[0]!.status).toBe("completed");
  });

  it("retries a failed stage with explicit same-ref repairs without repeating successful work", async () => {
    const current = task();
    const h = harness([plan(["Products"]), creates(2)]);
    h.deps.execute.mockImplementationOnce(async (ops) => success(ops));
    h.deps.execute.mockImplementationOnce(async (ops) => ({
      ...success(ops.slice(0, 1)),
      success: false,
      results: [
        ...success(ops.slice(0, 1)).results,
        {
          operationId: ops[1]!.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "rejected",
          error: "Missing parent",
        },
      ],
    }));
    await expect(runChatTask(current, h.deps)).rejects.toThrow();
    const failedId = current.ledger.find((entry) => entry.status === "failed")!.operationId;
    const resume = harness([
      turn("create_frame", {
        ref: "product-1",
        name: "کارت ۱",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
      finish([failedId]),
      done,
    ]);
    await runChatTask(current, resume.deps);
    expect(current.status).toBe("completed");
    expect(current.ledger.find((entry) => entry.status === "repaired")!.call.action.tool).toBe(
      "create_frame",
    );
    expect(resume.batches.flat().filter((op) => op.action.tool !== "inspect_nodes")).toHaveLength(
      1,
    );
    expect(resume.batches[0]![0]!.operationId).not.toBe(failedId);
  });

  it("continues unfinished stages instead of accepting an early completion claim", async () => {
    const h = harness([plan(["Frame"]), done, creates(1), finish(), done]);
    const current = task();
    await runChatTask(current, h.deps);
    expect(h.batches).toHaveLength(3);
    expect(current.status).toBe("completed");
  });

  it("does not treat an unrelated successful property edit as repair of a failed fill change", async () => {
    const current = task();
    const h = harness([
      plan(["Recolor button"], ["existing-button"]),
      turn("set_properties", { ref: "existing-button", properties: { fill: "#0F766E" } }),
    ]);
    h.deps.execute.mockImplementationOnce(async (ops) => success(ops));
    h.deps.execute.mockImplementationOnce(async (ops) => ({
      ...success([]),
      success: false,
      partialOperationIds: [ops[0]!.operationId],
      results: [
        {
          operationId: ops[0]!.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "ambiguous",
          error: "Property write failed",
        },
      ],
    }));
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Property write failed");
    const failedId = current.ledger.find((entry) => entry.status === "failed")!.operationId;
    const retry = harness([
      turn("set_properties", { ref: "existing-button", properties: { fontSize: 18 } }),
      finish([failedId]),
      done,
    ]);
    await expect(runChatTask(current, retry.deps)).rejects.toThrow();
    expect(current.stages[0]!.completed).toBe(false);
    expect(current.ledger[1]!.status).toBe("failed");
  });

  it("blocks unplanned operations and obtains a bounded plan autonomously", async () => {
    const h = harness([creates(1), plan(["Frame"]), creates(1), finish(), done]);
    await runChatTask(task(), h.deps);
    expect(h.batches).toHaveLength(3);
  });

  it("retains a logical-ref inventory for a follow-up edit rather than rebuilding", async () => {
    const first = task();
    await runChatTask(first, harness([plan(["Frame"]), creates(1), finish(), done]).deps);
    const followup = task();
    followup.id = "chat-followup-0001";
    followup.context = chatTaskInput(first).filter((item) => "role" in item);
    followup.prompt = "فقط رنگ دکمه را عوض کن";
    const h = harness([
      plan(["Change existing fill"]),
      turn("set_properties", { ref: "product-0", properties: { fill: "#0F766E" } }),
      finish(),
      done,
    ]);
    await runChatTask(followup, h.deps);
    expect(JSON.stringify(h.inputs[0])).toContain("product-0");
    expect(
      h.batches
        .flat()
        .map((op) => op.action.tool)
        .filter((tool) => tool !== "inspect_nodes" && tool !== "get_document_context"),
    ).toEqual(["set_properties"]);
  });

  it("rejects incomplete confirmations and preserves running IDs for reconciliation", async () => {
    const h = harness([plan(["Frame"]), creates(1)]);
    h.deps.execute.mockImplementationOnce(async (ops) => success(ops));
    h.deps.execute.mockResolvedValueOnce(success([]));
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("incomplete or duplicate");
    expect(current.ledger[1]!.status).toBe("running");
  });

  it("refuses canvas execution when write-ahead checkpoint persistence fails", async () => {
    const h = harness([plan(["Frame"]), creates(1)]);
    h.deps.save.mockImplementation(async (checkpoint) => {
      if (
        checkpoint.ledger.some(
          (entry) =>
            entry.status === "running" && entry.call.action.tool !== "get_document_context",
        )
      )
        throw new Error("Storage unavailable");
    });
    await expect(runChatTask(task(), h.deps)).rejects.toThrow("Storage unavailable");
    expect(
      h.deps.execute.mock.calls
        .flat()
        .flat()
        .some((op) => op.action.tool === "create_frame"),
    ).toBe(false);
  });

  it("continues a stage above 32 mutations in deterministic persisted segments", async () => {
    const h = harness([
      turn("plan_canvas_task", {
        brief: defaultBrief,
        stages: [
          {
            title: "Oversized stage",
            goal: "Create a detailed native screen",
            logicalRefs: ["budget-a-0"],
            completionCriteria: ["The detailed screen is editable"],
            estimatedMutations: 40,
          },
        ],
      }),
      creates(10, "budget-a"),
      creates(10, "budget-b"),
      creates(10, "budget-c"),
      creates(10, "budget-d"),
      finish(),
      done,
    ]);
    const current = task();
    await runChatTask(current, h.deps);
    expect(h.batches.flat().filter((op) => op.action.tool !== "get_document_context")).toHaveLength(
      41,
    );
    expect(current.stages[0]).toMatchObject({
      completed: true,
      operations: 40,
      segments: [
        { index: 0, mutationCount: 32, confirmedMutations: 32, status: "confirmed" },
        { index: 1, mutationCount: 8, confirmedMutations: 8, status: "confirmed" },
      ],
    });
    expect(current.status).toBe("completed");
    expect(
      h.checkpoints.find(({ lifecycle }) => lifecycle === "PLAN_SAVED")?.stages[0]?.segments,
    ).toEqual([
      {
        index: 0,
        mutationCount: 0,
        confirmedMutations: 0,
        attemptedMutations: 0,
        rejectedMutations: 0,
        ambiguousMutations: 0,
        verifiedIdempotentReplays: 0,
        status: "active",
      },
      {
        index: 1,
        mutationCount: 0,
        confirmedMutations: 0,
        attemptedMutations: 0,
        rejectedMutations: 0,
        ambiguousMutations: 0,
        verifiedIdempotentReplays: 0,
        status: "pending",
      },
    ]);
  });

  it("does not reproduce the old stage 31/32 failure after 25 mutations and six inspections", async () => {
    const inspections = Array.from({ length: 6 }, (_, index) =>
      turn("inspect_nodes", {
        refs: ["exact-0"],
        selection: false,
        depth: index % 5,
        maxNodes: index + 1,
      }),
    );
    const h = harness([
      plan(["Reported capacity boundary"], ["exact-0"]),
      creates(10, "exact"),
      creates(10, "exact-b"),
      creates(5, "exact-c"),
      ...inspections,
      creates(1, "exact-tail"),
      finish(),
      done,
    ]);
    const current = task();

    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(current.error).toBeUndefined();
    expect(current.stages[0]).toMatchObject({
      operations: 26,
      readOnlyOperations: 7,
      verificationOperations: 1,
      completed: true,
    });
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      lifecycle: "TASK_COMPLETED",
      capacity: {
        mutationCapacity: 240,
        mutations: 26,
        confirmedMutations: 26,
        readOnlyOperations: 7,
        verificationOperations: 1,
      },
      completionReason: "required_refs_and_native_verification_confirmed",
    });
  });

  it("stops when identical structural findings recur without a confirmed repair", async () => {
    const h = harness([
      plan(["Frame"], ["product-0"]),
      creates(1),
      finish(),
      finish(),
      finish(),
      finish(),
      finish(),
    ]);
    h.deps.execute.mockImplementation(async (operations) => {
      const result = success(operations);
      for (const item of result.results)
        if (item.data?.nodes)
          item.data.nodes = (item.data.nodes as Array<Record<string, unknown>>).map((node) => ({
            ...node,
            visible: false,
          }));
      return result;
    });
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("no_progress_repeated_error");
    expect(current.stages[0]?.verificationHistory).toHaveLength(2);

    const stage = current.stages[0]!;
    expect(stage.verificationHistory).toHaveLength(2);
    expect(stage.verificationHistory.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(stage.qualityFindings).toEqual([
      {
        code: "hidden-node",
        refs: ["product-0"],
        expected: "visible=true",
        actual: "visible=false",
      },
    ]);
    expect(stage.repairOperationsExecuted).toBe(0);
    expect(stage.repairOperationsAttempted).toBe(0);
    const diagnostic = chatTaskSafeDiagnostic(current);
    expect(diagnostic).toMatchObject({
      activeStageProgress: {
        structuralQuality: {
          verificationAttempts: 2,
          repairsExecuted: false,
          repairOperationsExecuted: 0,
          failedRules: stage.qualityFindings,
        },
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(current.prompt);
  });

  it("records confirmed repair operations between failed and successful structural checks", async () => {
    let repaired = false;
    const h = harness([
      plan(["Frame"], ["product-0"]),
      creates(1),
      finish(),
      turn("set_properties", { ref: "product-0", properties: { visible: true } }),
      finish(),
      done,
    ]);
    h.deps.execute.mockImplementation(async (operations) => {
      const result = success(operations);
      if (operations.some((operation) => operation.action.tool === "set_properties"))
        repaired = true;
      for (const item of result.results)
        if (item.data?.nodes)
          item.data.nodes = (item.data.nodes as Array<Record<string, unknown>>).map((node) => ({
            ...node,
            visible: repaired,
          }));
      return result;
    });
    const current = task();
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    expect(current.stages[0]).toMatchObject({
      repairOperationsExecuted: 1,
      repairOperationsAttempted: 1,
      awaitingQualityRepair: false,
      verificationHistory: [
        { attempt: 1, findings: [{ code: "hidden-node", refs: ["product-0"] }] },
        { attempt: 2, findings: [] },
      ],
    });
  });

  it("stops immediately when a confirmed repair leaves every native finding unchanged", async () => {
    const h = harness([
      plan(["Frame"], ["product-0"]),
      creates(1),
      finish(),
      turn("set_properties", { ref: "product-0", properties: { fill: "#FFFFFF" } }),
    ]);
    let inspections = 0;
    let manuallyFixed = false;
    h.deps.execute.mockImplementation(async (operations) => {
      const result = success(operations);
      for (const item of result.results) {
        const action = operations.find(
          ({ operationId }) => operationId === item.operationId,
        )?.action;
        if (action?.tool === "inspect_nodes") {
          inspections++;
          item.data!.nodes = (item.data!.nodes as Array<Record<string, unknown>>).map((node) => ({
            ...node,
            visible: manuallyFixed,
          }));
        }
      }
      return result;
    });
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("structural_repair_no_progress");
    expect(inspections).toBe(2);
    expect(h.deps.model).toHaveBeenCalledTimes(5);
    expect(current.stages[0]).toMatchObject({
      repairOperationsAttempted: 1,
      repairOperationsExecuted: 1,
      repairFindingsResolved: 0,
      repairVerificationPending: false,
      verificationHistory: [
        { findings: [{ code: "hidden-node", refs: ["product-0"], actual: "visible=false" }] },
        { findings: [{ code: "hidden-node", refs: ["product-0"], actual: "visible=false" }] },
      ],
    });
    manuallyFixed = true;
    const resume = harness([finish(), done]);
    resume.deps.execute.mockImplementation(h.deps.execute.getMockImplementation()!);
    await runChatTask(current, resume.deps);
    expect(current.status).toBe("completed");
    expect(resume.deps.model).toHaveBeenCalledTimes(2);
    expect(current.stages[0]).toMatchObject({
      qualityRepairBlocked: false,
      qualityFindings: [],
      completed: true,
      verified: true,
    });
  });

  it("re-inspects native contrast after a localized text-color mutation and records resolution", async () => {
    const h = harness([
      plan(["Store"], ["store"]),
      turn("create_frame", {
        ref: "store",
        name: "Store",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
      finish(),
      finish(),
      done,
    ]);
    let color = "#91875A";
    const inspectedColors: string[] = [];
    const inspectionAfterMutation: boolean[] = [];
    let mutationConfirmed = false;
    h.deps.execute.mockImplementation(async (operations) => {
      const result = success(operations);
      if (operations.some(({ action }) => action.tool === "set_properties")) {
        color = "#000000";
        mutationConfirmed = true;
      }
      for (const item of result.results) {
        const action = operations.find(
          ({ operationId }) => operationId === item.operationId,
        )?.action;
        if (action?.tool !== "inspect_nodes") continue;
        inspectedColors.push(color);
        inspectionAfterMutation.push(mutationConfirmed);
        item.data!.nodes = [
          {
            ref: "store",
            type: "FRAME",
            name: "Store",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            visible: true,
            fill: "#FFFFFF",
            bounds: { x: 0, y: 0, width: 390, height: 844 },
            children: [
              {
                ref: "store-label",
                type: "TEXT",
                name: "Label",
                text: "Store",
                x: 8,
                y: 8,
                width: 100,
                height: 24,
                visible: true,
                textColor: color,
                fontSize: 14,
                bounds: { x: 8, y: 8, width: 100, height: 24 },
              },
            ],
          },
        ];
      }
      return result;
    });
    const current = task();
    await runChatTask(current, h.deps);
    expect(inspectedColors).toEqual(["#91875A", "#000000"]);
    expect(inspectionAfterMutation).toEqual([false, true]);
    expect(current.stages[0]).toMatchObject({
      completed: true,
      verified: true,
      repairOperationsAttempted: 1,
      repairOperationsExecuted: 1,
      repairFindingsResolved: 1,
      verificationHistory: [
        { findings: [{ code: "low-contrast", refs: ["store-label"] }] },
        { findings: [] },
      ],
    });
  });

  it("splits Unicode-heavy operations by byte budget without dropping any calls", async () => {
    const large = Array.from(
      { length: 3 },
      (_, index) =>
        turn("create_text", {
          ref: `large-${index}`,
          name: "عنوان",
          parent: { kind: "page" },
          text: "ف".repeat(12_000),
          size: { width: 350, height: 48 },
        }) as Extract<AuthorizedChatTurn, { kind: "tool_calls" }>,
    );
    const calls = large.flatMap((item) => item.calls);
    const h = harness([
      plan(["Unicode text"], ["large-0"]),
      {
        kind: "tool_calls",
        calls,
        functionCallItems: calls.map((call) => call.functionCall),
        text: "",
      },
      finish(),
      done,
    ]);
    await runChatTask(task(), h.deps);
    expect(h.batches.flat()).toHaveLength(5);
    expect(h.batches).toHaveLength(4);
  });

  it("rejects arbitrary functions, oversized plans, and mismatched action identities", () => {
    expect(() => turn("execute_javascript", { code: "figma.createFrame()" })).toThrow();
    expect(() => plan(Array.from({ length: 13 }, (_, index) => `Stage ${index}`))).toThrow();
    const good = (creates(1) as Extract<AuthorizedChatTurn, { kind: "tool_calls" }>).calls[0]!;
    expect(
      ChatFunctionCallSchema.safeParse({
        ...good,
        action: { tool: "delete_node", ref: "product-0", consentToken: "x".repeat(40) },
      }).success,
    ).toBe(false);
  });

  it("accepts a new-design plan when document context is unavailable", async () => {
    const h = harness([plan(["Frame"]), creates(1), finish(), done], false);
    const current = task();
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    expect(current.stages).toHaveLength(1);
    expect(chatTaskCommittedOperationCount(current)).toBe(1);
  });

  it("corrects rejected calls without replaying committed work and reports native mutation counts", async () => {
    const validation: AuthorizedChatTurn = {
      kind: "tool_validation",
      issues: [
        {
          toolName: "create_rectangle",
          callId: "call_badargs_123",
          stage: "arguments_schema",
          errorCode: "invalid_format",
          fieldPaths: ["arguments.fill"],
        },
      ],
    };
    const h = harness([
      plan(["Product card"], ["product-0"]),
      creates(1),
      validation,
      creates(1, "repair"),
      finish(),
      done,
    ]);
    const current = task();
    await runChatTask(current, h.deps);

    expect(current.status).toBe("completed");
    expect(current.validationCorrections).toBe(1);
    expect(chatTaskProgress(current)).toContain("2 mutations confirmed");
    expect(h.inputs.some((input) => JSON.stringify(input).includes("arguments.fill"))).toBe(true);
    const executed = h.batches.flat();
    expect(executed.filter((operation) => operation.action.tool === "create_frame")).toHaveLength(
      2,
    );
    expect(executed.some((operation) => operation.action.tool === "create_rectangle")).toBe(false);
    expect(new Set(executed.map((operation) => operation.operationId)).size).toBe(executed.length);
  });

  it("explains call_set/too_many_calls as an oversized batch, not an unknown tool", async () => {
    const validation: AuthorizedChatTurn = {
      kind: "tool_validation",
      issues: [
        {
          stage: "call_set",
          errorCode: "too_many_calls",
          fieldPaths: ["calls"],
        },
      ],
    };
    const h = harness([plan(["Store"], ["product-0"]), creates(1), validation, finish(), done]);
    const current = task();
    await runChatTask(current, h.deps);
    const correction = h.inputs
      .map((input) => JSON.stringify(input))
      .find((input) => input.includes("tool-call set"));
    expect(correction).toBeDefined();
    expect(correction).toContain("tool-call set");
    expect(correction).toContain("more than 10 function calls");
    expect(correction).not.toContain("unknown tool: call_set");
    expect(current.validationCorrections).toBe(1);
  });

  it("gives precise inspect_nodes range feedback and preserves 31 committed operations", async () => {
    const current = task();
    current.rounds = 17;
    current.batches = 19;
    current.stages = [
      {
        title: "Completed shell",
        goal: "Preserve the committed shell",
        logicalRefs: ["shell"],
        completionCriteria: ["The shell is present"],
        completed: true,
        estimatedMutations: 31,
        operations: 31,
        readOnlyOperations: 0,
        segments: [],
        rounds: 8,
        qaAttempts: 1,
        verificationOperations: 1,
        verified: true,
        verificationHistory: [],
        qualityFindings: [],
        repairOperationsExecuted: 0,
        repairOperationsAttempted: 0,
        awaitingQualityRepair: false,
      },
      {
        title: "Current details",
        goal: "Continue the unfinished stage",
        logicalRefs: ["shell"],
        completionCriteria: ["Details are present"],
        completed: false,
        estimatedMutations: 3,
        operations: 0,
        readOnlyOperations: 0,
        segments: [],
        rounds: 0,
        qaAttempts: 0,
        verificationOperations: 0,
        verified: false,
        verificationHistory: [],
        qualityFindings: [],
        repairOperationsExecuted: 0,
        repairOperationsAttempted: 0,
        awaitingQualityRepair: false,
      },
    ];
    current.ledger = Array.from({ length: 31 }, (_, index) => {
      const call = (
        turn("create_frame", {
          ref: `shell-${index}`,
          name: `Shell layer ${index}`,
          parent: { kind: "page" },
          size: { width: 100, height: 80 },
        }) as Extract<AuthorizedChatTurn, { kind: "tool_calls" }>
      ).calls[0]!;
      return {
        call,
        operationId: `chat-task-0001-op-${index + 1}`,
        stage: 0,
        status: "completed" as const,
        output: JSON.stringify({ success: true, logicalRef: `shell-${index}` }),
      };
    });
    const invalid: AuthorizedChatTurn = {
      kind: "tool_validation",
      issues: [
        {
          toolName: "inspect_nodes",
          callId: "inspect_rejected_01",
          stage: "arguments_schema",
          errorCode: "invalid_type",
          fieldPaths: ["arguments.maxNodes"],
          receivedType: "string",
        },
      ],
    };
    const h = harness([invalid, invalid]);
    await expect(runChatTask(current, h.deps)).rejects.toThrow("no_progress_repeated_error");
    expect(current.validationCorrections).toBe(1);
    expect(chatTaskCommittedOperationCount(current)).toBe(31);
    expect(current.stages.map((stage) => stage.completed)).toEqual([true, false]);
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(h.inputs[1])).toContain(
      "must be an integer from 1–25 (omitted defaults to 25)",
    );
    expect(JSON.stringify(h.inputs[1])).toContain("Received type string");
    expect(chatTaskSafeDiagnostic(current)).toMatchObject({
      committedOperations: 31,
      modelRounds: 19,
      nativeBatches: 19,
      inspectionIssues: [
        {
          callId: "inspect_rejected_01",
          field: "maxNodes",
          errorCode: "invalid_type",
          receivedType: "string",
        },
      ],
    });
    expect(JSON.stringify(chatTaskSafeDiagnostic(current))).not.toContain("500");
  });

  it("does not count document-context reads as committed canvas operations", () => {
    const current = task();
    current.ledger.push({
      call: (
        turn("get_document_context", {}) as Extract<AuthorizedChatTurn, { kind: "tool_calls" }>
      ).calls[0]!,
      operationId: "chat-task-0001-op-1",
      stage: 0,
      status: "completed",
      output: JSON.stringify({ success: true }),
    });
    expect(chatTaskProgress(current)).toContain("0 mutations confirmed");
  });

  it("stops after the bounded validation-correction budget and retains earlier commits", async () => {
    const invalid: AuthorizedChatTurn = {
      kind: "tool_validation",
      issues: [
        {
          toolName: "create_rectangle",
          callId: "call_badargs_123",
          stage: "arguments_schema",
          errorCode: "invalid_format",
          fieldPaths: ["arguments.fill"],
        },
      ],
    };
    const h = harness([plan(["Frame"], ["product-0"]), creates(1), invalid, invalid, invalid]);
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("no_progress_repeated_error");
    expect(current.status).toBe("failed");
    expect(current.validationCorrections).toBe(1);
    expect(chatTaskProgress(current)).toContain("1 mutations confirmed");
    expect(
      h.batches.flat().filter((operation) => operation.action.tool === "create_frame"),
    ).toHaveLength(1);
  });

  it("feeds reference-resolution failures back to the model and keeps the namespace through retry", async () => {
    const current = task();
    const h = harness([plan(["Header"], ["product-0"]), creates(1), finish(), done]);
    let rejected = false;
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      if (!rejected && operations.some((operation) => operation.action.tool === "create_frame")) {
        rejected = true;
        return {
          ...success([]),
          success: false,
          results: [
            {
              operationId: operations[0]!.operationId,
              success: false,
              replayed: false,
              acknowledgementStatus: "rejected",
              error: "Reference inspection required",
              data: {
                referenceResolution: {
                  code: "inspection_required",
                  ref: "header",
                  stage: "reference_resolution",
                  alternatives: ["inspect_nodes"],
                },
              },
            },
          ],
        };
      }
      return success(operations);
    });
    await expect(runChatTask(current, h.deps)).rejects.toThrow();
    expect(current.referenceCorrections).toBe(1);
    expect(
      h.checkpoints.some(
        (saved) =>
          saved.failure?.category === "inspection" &&
          saved.failure.code === "inspection_required" &&
          saved.failure.phase === "inspection",
      ),
    ).toBe(true);
    expect(h.inputs.some((input) => JSON.stringify(input).includes("referenceResolution"))).toBe(
      true,
    );
    expect(h.batches.flat().every((operation) => operation.taskId === current.id)).toBe(true);
    const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    expect(restored.referenceScope).toBe("task-v1");
    expect(restored.referenceCorrections).toBe(1);
    const failedId = restored.ledger.find((entry) => entry.status === "failed")!.operationId;
    const retry = harness([creates(1), finish([failedId]), done]);
    await runChatTask(restored, retry.deps);
    expect(restored.status).toBe("completed");
    expect(retry.batches.flat().every((operation) => operation.taskId === current.id)).toBe(true);
  });

  it("keeps a failed read-only reference distinct, then records a later upstream transport failure", async () => {
    const current = task();
    const stageOneRefs = Array.from({ length: 14 }, (_, index) => `stage-one-${index}`);
    const stageTwoRefs = Array.from({ length: 7 }, (_, index) => `stage-two-${index}`);
    const stage = (
      title: string,
      logicalRefs: string[],
      completed: boolean,
      operations: number,
    ) => ({
      title,
      goal: `Complete ${title}`,
      logicalRefs,
      completionCriteria: [`${title} is confirmed`],
      completed,
      estimatedMutations: Math.max(1, logicalRefs.length),
      operations,
      readOnlyOperations: 0,
      segments: [],
      rounds: 0,
      qaAttempts: 0,
      verificationOperations: 0,
      verified: completed,
      verificationHistory: [],
      qualityFindings: [],
      repairOperationsExecuted: 0,
      repairOperationsAttempted: 0,
      awaitingQualityRepair: false,
      ...(completed
        ? { completionReason: "required_refs_and_native_verification_confirmed" as const }
        : {}),
    });
    current.stages = [
      stage("Stage 1", stageOneRefs, true, stageOneRefs.length),
      stage("Stage 2", stageTwoRefs, false, 0),
    ];
    current.ledger = stageOneRefs.map((ref, index) => {
      const created = turn("create_frame", {
        ref,
        name: ref,
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      });
      if (created.kind !== "tool_calls") throw new Error("Expected a confirmed Stage 1 call.");
      return {
        call: created.calls[0]!,
        operationId: `${current.id}-op-${index + 1}`,
        stage: 0,
        status: "completed" as const,
        category: "mutation" as const,
        acknowledgementStatus: "confirmed_mutation" as const,
        output: JSON.stringify({ success: true, logicalRef: ref }),
      };
    });
    current.lifecycle = "STAGE_COMPLETED";
    const checkpoint = ChatTaskSchema.parse(current);
    const missingReference = turn("inspect_nodes", {
      refs: [stageTwoRefs[0]],
      selection: false,
      depth: 2,
      maxNodes: 25,
    });
    const transportError = new CompanionClientError("responses_transport_error", {
      requestId: "upstream-headers-01",
      model: "account-model",
      stage: "http",
      outcome: "transport_error",
      requestPhase: "upstream_headers",
      terminationReason: "upstream_transport_interruption",
    });
    const h = harness([missingReference, transportError], false);
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const base = success(operations);
      return {
        ...base,
        success: false,
        results: base.results.map((result) => ({
          ...result,
          success: false,
          acknowledgementStatus: "rejected" as const,
          error: "The task alias is missing from the saved reference registry.",
          data: {
            referenceResolution: {
              code: "missing_or_uninspected",
              ref: stageTwoRefs[0]!,
              stage: "reference_resolution",
              alternatives: ["inspect_nodes with selection:true"],
              candidateCount: 0,
            },
          },
        })),
      };
    });

    await expect(runChatTask(checkpoint, h.deps)).rejects.toBe(transportError);

    expect(
      h.checkpoints.some(
        (saved) =>
          saved.failure?.category === "inspection" &&
          saved.failure.code === "missing_or_uninspected" &&
          saved.failure.phase === "inspection",
      ),
    ).toBe(true);
    expect(checkpoint.failure).toMatchObject({
      category: "transport",
      phase: "transport",
      code: "responses_transport_error",
      committedOperations: 14,
    });
    expect(checkpoint.lastRequestDiagnostic).toMatchObject({
      requestPhase: "upstream_headers",
      outcome: "transport_error",
      terminationReason: "upstream_transport_interruption",
    });
    expect(chatTaskCommittedOperationCount(checkpoint)).toBe(14);
    expect(
      checkpoint.ledger.filter((entry) => entry.stage === 0 && entry.status === "completed"),
    ).toHaveLength(14);
    expect(chatTaskRetryLabel(checkpoint)).toBe("Retry request");
    expect(chatTaskSafeDiagnostic(checkpoint)).toMatchObject({
      failureCategory: "transport",
      errorCode: "responses_transport_error",
      lastRequestDiagnostic: {
        requestPhase: "upstream_headers",
        terminationReason: "upstream_transport_interruption",
      },
    });
  });

  it("retries a rate-limited native inspection with the same ID and completes after evidence is returned", async () => {
    const h = harness([
      plan(["Product card"], ["product-0"]),
      creates(1),
      finish(),
      turn("set_properties", { ref: "product-0", properties: { fill: "#FFFFFF" } }),
      finish(),
      done,
    ]);
    let inspections = 0;
    h.deps.execute.mockImplementation(async (operations) => {
      h.batches.push(operations);
      const base = success(operations);
      const results = base.results.map((result) => {
        if (
          operations.find((operation) => operation.operationId === result.operationId)?.action
            .tool !== "inspect_nodes"
        )
          return result;
        inspections++;
        if (inspections === 1)
          return {
            ...result,
            success: false,
            acknowledgementStatus: "not_attempted" as const,
            error: "Local tool rate limit reached; wait one minute and retry with the same ID.",
          };
        return {
          ...result,
          data: {
              nodes: [
                {
                  ref: "product-0",
                  type: "FRAME",
                  name: "product-0",
                  x: 0,
                  y: 0,
                  width: 390,
                  height: 844,
                  visible: true,
                  bounds: { x: 0, y: 0, width: 390, height: 844 },
                },
              ],
          },
        };
      });
      return {
        ...base,
        success: inspections !== 1,
        results,
      };
    });
    const current = task();
    await runChatTask(current, h.deps);
    expect(current.status).toBe("completed");
    expect(current.stages[0]).toMatchObject({ completed: true, verified: true, qaAttempts: 1 });
    expect(inspections).toBe(2);
    expect(h.deps.wait).toHaveBeenCalledWith(60_100, expect.any(AbortSignal));
    const inspectionOperations = h.batches
      .flat()
      .filter((operation) => operation.action.tool === "inspect_nodes");
    expect(inspectionOperations[0]!.operationId).toBe(inspectionOperations[1]!.operationId);
    expect(
      current.ledger.filter((entry) => entry.call.action.tool === "inspect_nodes"),
    ).toHaveLength(1);
    expect(JSON.stringify(h.inputs)).not.toContain("missing-ref");
    expect(
      current.ledger
        .filter((entry) => entry.call.action.tool === "inspect_nodes")
        .every((entry) => (entry.output?.length ?? 0) < 8_000),
    ).toBe(true);
  });
});

describe("document-scoped canvas task checkpoints", () => {
  it("migrates a legacy checkpoint only for its matching chat ID", async () => {
    const data = new Map<string, unknown>();
    const legacy = task();
    data.set("fad.chat-task.v1:file-test-page_1", legacy);
    const api = {
      fileKey: "file-test",
      currentPage: { id: "page:1" },
      root: { getPluginData: () => "local", setPluginData: () => {} },
      clientStorage: {
        getAsync: async (key: string) => data.get(key),
        setAsync: async (key: string, value: unknown) => data.set(key, structuredClone(value)),
        deleteAsync: async (key: string) => data.delete(key),
      },
    } as unknown as PluginAPI;

    expect(
      (
        await handleChatTaskStorage(api, {
          type: "chat-task-load",
          requestId: "load-matching-legacy",
          chatId: legacy.id,
        })
      ).task,
    ).toEqual(legacy);
    expect(
      (
        await handleChatTaskStorage(api, {
          type: "chat-task-load",
          requestId: "do-not-borrow-legacy",
          chatId: "chat-other-0001",
        })
      ).task,
    ).toBeNull();
    expect(data.has("fad.chat-task.v1:file-test-page_1")).toBe(true);
    const wrongPage = await handleChatTaskStorage(api, {
      type: "chat-task-load",
      requestId: "reject-wrong-page",
      chatId: legacy.id,
      documentId: "file-test-page_other",
    });
    expect(wrongPage.success).toBe(false);
    expect(wrongPage.error).toContain("Document/page changed");
  });

  it("persists and reloads strict checkpoints and rejects cross-page saves without deleting work", async () => {
    const data = new Map<string, unknown>();
    const api = {
      fileKey: "file-test",
      currentPage: { id: "page:1" },
      root: { getPluginData: () => "local", setPluginData: () => {} },
      clientStorage: {
        getAsync: async (key: string) => data.get(key),
        setAsync: async (key: string, value: unknown) => {
          data.set(key, structuredClone(value));
        },
      },
    } as unknown as PluginAPI;
    const saved = await handleChatTaskStorage(api, {
      type: "chat-task-save",
      requestId: "save-task-001",
      documentId: task().documentId,
      task: task(),
    });
    expect(saved.success).toBe(true);
    const loaded = await handleChatTaskStorage(api, {
      type: "chat-task-load",
      requestId: "load-task-001",
    });
    expect(loaded.task).toEqual(task());
    (api.currentPage as unknown as { id: string }).id = "page:2";
    expect(
      (
        await handleChatTaskStorage(api, {
          type: "chat-task-save",
          requestId: "save-task-002",
          documentId: task().documentId,
          task: task(),
        })
      ).success,
    ).toBe(false);
    expect(data.size).toBe(1);
    data.set("fad.chat-task.v1:file-test-page_2", {
      ...task(),
      documentId: "file-test-page_2",
      executeJavaScript: "bad",
    });
    expect(
      (await handleChatTaskStorage(api, { type: "chat-task-load", requestId: "load-task-002" }))
        .success,
    ).toBe(false);
  });
});
