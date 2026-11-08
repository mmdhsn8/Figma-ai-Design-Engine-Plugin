import { describe, expect, it, vi } from "vitest";
import {
  ChatTaskSchema,
  chatTaskCommittedOperationCount,
  chatTaskProgress,
  chatTaskSafeDiagnostic,
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
import { CompanionClientError, type AuthorizedChatTurn } from "../src/ui/companion-client";
import type { FigmaToolOperation } from "../src/shared/figma-tools";
import type { PluginToUIMessage } from "../src/shared/messages";

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
                name: ref,
                x: 0,
                y: 0,
                width: 390,
                height: 844,
                visible: true,
                bounds: { x: 0, y: 0, width: 390, height: 844 },
              })),
            },
          }
        : {}),
    })),
  };
}
function harness(turns: Array<AuthorizedChatTurn | Error>, autoReadContext = true) {
  let clock = 100_000;
  const checkpoints: ChatTask[] = [];
  const batches: FigmaToolOperation[][] = [];
  const inputs: ChatInputItem[][] = [];
  const controller = new AbortController();
  let readContext = false;
  const deps = {
    signal: controller.signal,
    model: vi.fn(async (input: ChatInputItem[]) => {
      inputs.push(input);
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
      return success(operations);
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
  return { deps, controller, checkpoints, batches, inputs };
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

describe("progressive conversational canvas tasks", () => {
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
      completionReason: "missing_required_refs",
      stageCapacity: [
        {
          stageId: "stage-1",
          mutationUsage: 1,
          remainingRequirements: 1,
          completionReason: "missing_required_refs",
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
    await runChatTask(task(), h.deps);
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
      turn("set_properties", { ref: "store-label", properties: { color: "#000000" } }),
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

  it("requires confirmed document context before accepting a plan", async () => {
    const h = harness([plan(["Frame"]), done], false);
    const current = task();
    await runChatTask(current, h.deps);
    expect(current.stages).toHaveLength(0);
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(h.inputs[1])).toContain("Read the current document context");
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

  it("surfaces bounded structural findings, repairs only the planned ref, and reinspects before stage completion", async () => {
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
            nodes:
              inspections === 2
                ? []
                : [
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
    expect(inspections).toBe(3);
    expect(h.deps.wait).toHaveBeenCalledWith(60_100, expect.any(AbortSignal));
    const inspectionOperations = h.batches
      .flat()
      .filter((operation) => operation.action.tool === "inspect_nodes");
    expect(inspectionOperations[0]!.operationId).toBe(inspectionOperations[1]!.operationId);
    expect(inspectionOperations[1]!.operationId).not.toBe(inspectionOperations[2]!.operationId);
    expect(
      current.ledger.filter((entry) => entry.call.action.tool === "inspect_nodes"),
    ).toHaveLength(2);
    expect(JSON.stringify(h.inputs[4])).toContain("missing-ref");
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
