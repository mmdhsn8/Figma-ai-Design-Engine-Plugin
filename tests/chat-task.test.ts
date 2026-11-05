import { describe, expect, it, vi } from "vitest";
import {
  ChatTaskSchema,
  chatTaskCommittedOperationCount,
  chatTaskProgress,
  chatTaskSafeDiagnostic,
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
    committedOperationIds: ops.map((op) => op.operationId),
    partialOperationIds: [],
    results: ops.map((op) => ({
      operationId: op.operationId,
      success: true,
      replayed: false,
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
function harness(turns: AuthorizedChatTurn[], autoReadContext = true) {
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
        operations: 1,
        rounds: 7,
        qaAttempts: 0,
        verificationOperations: 0,
        verified: false,
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
    expect(checkpoint && "role" in checkpoint ? checkpoint.content : "").not.toMatch(
      /"(?:operations|rounds|verification|verified|completed)":/u,
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

  it("stops repeated valid replanning without replacing the saved plan", async () => {
    const current = task();
    const h = harness([plan(["Original"]), plan(["Replacement"]), plan(["Replacement"])]);
    await expect(runChatTask(current, h.deps)).rejects.toThrow("no_progress_repeated_error");
    expect(current.stages[0]?.title).toBe("Original");
    expect(current.rounds).toBeLessThan(6);
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
      return {
        ...success([]),
        success: false,
        results: [
          {
            operationId: operations[0]!.operationId,
            success: false,
            replayed: false,
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

  it("completes 50 operations across five planned stages using sequential three-operation batches", async () => {
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
    expect(h.batches).toHaveLength(26);
    expect(h.batches.every((batch) => batch.length <= 3)).toBe(true);
    expect(h.deps.wait).toHaveBeenCalled();
    expect(new Set(h.batches.flat().map((op) => op.operationId)).size).toBe(56);
    expect(chatTaskProgress(current)).toContain("5/5 stages completed");
    expect(chatTaskProgress(current)).toContain("50 operations confirmed");
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

  it("stops after a confirmed partial batch, reloads the checkpoint, and resumes only pending IDs", async () => {
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
    ).toHaveLength(3);
    const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    const resume = harness([finish(), done]);
    await runChatTask(restored, resume.deps);
    expect(resume.batches.flat()).toHaveLength(6);
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
      results: [
        {
          operationId: ops[0]!.operationId,
          success: false,
          replayed: false,
          error:
            "Local tool rate limit reached; wait one minute and retry with a new operation ID.",
        },
      ],
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
      partialOperationIds: [ops[1]!.operationId],
      results: [
        ...success(ops.slice(0, 1)).results,
        {
          operationId: ops[1]!.operationId,
          success: false,
          replayed: false,
          error: "Invalid parent",
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
      results: [
        {
          operationId: ops[0]!.operationId,
          success: false,
          replayed: false,
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

  it("enforces the per-stage budget rather than running an unbounded task", async () => {
    const h = harness([
      plan(["Oversized stage"], ["budget-a-0"]),
      creates(10, "budget-a"),
      creates(10, "budget-b"),
      creates(10, "budget-c"),
      creates(10, "budget-d"),
    ]);
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("stage 30/32");
    expect(h.batches.flat().filter((op) => op.action.tool !== "get_document_context")).toHaveLength(
      30,
    );
    expect(current.stages[0]!.completed).toBe(false);
    expect(current.status).toBe("failed");
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
    expect(chatTaskProgress(current)).toContain("2 operations confirmed");
    expect(h.inputs.some((input) => JSON.stringify(input).includes("arguments.fill"))).toBe(true);
    const executed = h.batches.flat();
    expect(executed.filter((operation) => operation.action.tool === "create_frame")).toHaveLength(
      2,
    );
    expect(executed.some((operation) => operation.action.tool === "create_rectangle")).toBe(false);
    expect(new Set(executed.map((operation) => operation.operationId)).size).toBe(executed.length);
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
        operations: 31,
        rounds: 8,
        qaAttempts: 1,
        verificationOperations: 1,
        verified: true,
      },
      {
        title: "Current details",
        goal: "Continue the unfinished stage",
        logicalRefs: ["shell"],
        completionCriteria: ["Details are present"],
        completed: false,
        operations: 0,
        rounds: 0,
        qaAttempts: 0,
        verificationOperations: 0,
        verified: false,
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
    expect(chatTaskProgress(current)).toContain("0 operations confirmed");
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
    expect(chatTaskProgress(current)).toContain("1 operations confirmed");
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
    expect(current.stages[0]).toMatchObject({ completed: true, verified: true, qaAttempts: 2 });
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
