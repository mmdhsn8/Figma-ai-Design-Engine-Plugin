import { describe, expect, it, vi } from "vitest";
import { ChatTaskSchema, chatTaskProgress, type ChatTask } from "../src/shared/chat-task";
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
    })),
  };
}
function harness(turns: AuthorizedChatTurn[]) {
  let clock = 100_000;
  const checkpoints: ChatTask[] = [];
  const batches: FigmaToolOperation[][] = [];
  const inputs: ChatInputItem[][] = [];
  const controller = new AbortController();
  const deps = {
    signal: controller.signal,
    model: vi.fn(async (input: ChatInputItem[]) => {
      inputs.push(input);
      const next = turns.shift();
      if (!next) throw new Error("No scripted turn left");
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
const plan = (
  stages = [
    "Page frame",
    "Header and navigation",
    "Search and categories",
    "Editable product cards",
    "Purchase buttons",
  ],
) => turn("plan_canvas_task", { stages });
const finish = (resolvedOperationIds: string[] = []) =>
  turn("complete_canvas_stage", { summary: "Confirmed stage", resolvedOperationIds });
const done: AuthorizedChatTurn = {
  kind: "done",
  text: "همه بخش‌ها با لایه‌های قابل ویرایش ساخته شدند.",
};

describe("progressive conversational canvas tasks", () => {
  it("completes 50 operations across five planned stages using sequential three-operation batches", async () => {
    const turns = [
      plan(),
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
    expect(current.ledger).toHaveLength(50);
    expect(current.stages.every((stage) => stage.completed)).toBe(true);
    expect(h.batches).toHaveLength(20);
    expect(h.batches.every((batch) => batch.length <= 3)).toBe(true);
    expect(h.deps.wait).toHaveBeenCalled();
    expect(new Set(h.batches.flat().map((op) => op.operationId)).size).toBe(50);
    expect(chatTaskProgress(current)).toContain("5/5 stages completed");
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
    const h = harness([plan(["Products"]), creates(8), finish(), done]);
    const current = task();
    h.deps.execute.mockImplementationOnce(async (operations) => {
      h.batches.push(operations);
      h.controller.abort();
      return success(operations);
    });
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Stopped");
    expect(current.ledger.filter((entry) => entry.status === "completed")).toHaveLength(3);
    const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    const resume = harness([finish(), done]);
    await runChatTask(restored, resume.deps);
    expect(resume.batches.flat()).toHaveLength(5);
    expect(
      resume.batches
        .flat()
        .some((op) =>
          current.ledger.slice(0, 3).some((entry) => entry.operationId === op.operationId),
        ),
    ).toBe(false);
    expect(restored.ledger.every((entry) => entry.status === "completed")).toBe(true);
  });

  it("replays identical operation IDs after a lost result without asking the model to regenerate", async () => {
    const h = harness([plan(["Frame"]), creates(2)]);
    h.deps.execute.mockRejectedValueOnce(new Error("Lost Figma result"));
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("Lost Figma result");
    const dispatched = h.deps.execute.mock.calls[0]![0];
    const resume = harness([finish(), done]);
    await runChatTask(ChatTaskSchema.parse(h.checkpoints.at(-1)), resume.deps);
    expect(resume.batches[0]).toEqual(dispatched);
  });

  it("waits on executor rate limits and reuses the rejected operation IDs", async () => {
    const h = harness([plan(["Frame"]), creates(3), finish(), done]);
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
    expect(h.deps.execute.mock.calls[1]![0]).toEqual(h.deps.execute.mock.calls[0]![0]);
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
    expect(current.ledger.map((entry) => entry.status)).toEqual(["completed", "failed", "failed"]);
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
    const failedId = current.ledger[1]!.operationId;
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
    expect(current.ledger[1]!.status).toBe("repaired");
    expect(resume.batches.flat()).toHaveLength(1);
    expect(resume.batches[0]![0]!.operationId).not.toBe(failedId);
  });

  it("continues unfinished stages instead of accepting an early completion claim", async () => {
    const h = harness([plan(["Frame"]), done, creates(1), finish(), done]);
    const current = task();
    await runChatTask(current, h.deps);
    expect(h.batches).toHaveLength(1);
    expect(current.status).toBe("completed");
  });

  it("does not treat an unrelated successful property edit as repair of a failed fill change", async () => {
    const current = task();
    const h = harness([
      plan(["Recolor button"]),
      turn("set_properties", { ref: "existing-button", properties: { fill: "#0F766E" } }),
    ]);
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
    const failedId = current.ledger[0]!.operationId;
    const retry = harness([
      turn("set_properties", { ref: "existing-button", properties: { fontSize: 18 } }),
      finish([failedId]),
      done,
    ]);
    await expect(runChatTask(current, retry.deps)).rejects.toThrow();
    expect(current.stages[0]!.completed).toBe(false);
    expect(current.ledger[0]!.status).toBe("failed");
  });

  it("blocks unplanned operations and obtains a bounded plan autonomously", async () => {
    const h = harness([creates(1), plan(["Frame"]), creates(1), finish(), done]);
    await runChatTask(task(), h.deps);
    expect(h.batches).toHaveLength(1);
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
    expect(h.batches.flat().map((op) => op.action.tool)).toEqual(["set_properties"]);
  });

  it("rejects incomplete confirmations and preserves running IDs for reconciliation", async () => {
    const h = harness([plan(["Frame"]), creates(1)]);
    h.deps.execute.mockResolvedValueOnce(success([]));
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("incomplete or duplicate");
    expect(current.ledger[0]!.status).toBe("running");
  });

  it("refuses canvas execution when write-ahead checkpoint persistence fails", async () => {
    const h = harness([plan(["Frame"]), creates(1)]);
    h.deps.save.mockImplementation(async (checkpoint) => {
      if (checkpoint.ledger.some((entry) => entry.status === "running"))
        throw new Error("Storage unavailable");
    });
    await expect(runChatTask(task(), h.deps)).rejects.toThrow("Storage unavailable");
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it("enforces the per-stage budget rather than running an unbounded task", async () => {
    const h = harness([
      plan(["Oversized stage"]),
      creates(10, "budget-a"),
      creates(10, "budget-b"),
      creates(10, "budget-c"),
      creates(10, "budget-d"),
    ]);
    const current = task();
    await expect(runChatTask(current, h.deps)).rejects.toThrow("stage 32/32");
    expect(h.batches.flat()).toHaveLength(30);
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
      plan(["Unicode text"]),
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
    expect(h.batches.flat()).toHaveLength(3);
    expect(h.batches).toHaveLength(2);
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
