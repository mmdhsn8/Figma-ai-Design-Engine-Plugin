import { describe, expect, it, vi } from "vitest";
import { FigmaToolOperationSchema, FigmaToolBatchSchema } from "../src/shared/figma-tools";
import { UIToPluginSchema, type PluginToUIMessage } from "../src/shared/messages";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { boundsIntersectWithGap, DEFAULT_MIN_CANVAS_GAP } from "../src/plugin/canvas-placement";
import { parseResponsesFunctionCalls } from "../src/shared/chat-tools";
import { utf8Bytes } from "../src/shared/generation-limits";
import { ChatTaskSchema } from "../src/shared/chat-task";
import { runChatTask } from "../src/ui/chat-task";
import type { AuthorizedChatTurn } from "../src/ui/companion-client";

import { createMockApi, type MockNode } from "./figma-mock";

function operation(operationId: string, action: unknown) {
  return FigmaToolOperationSchema.parse({
    operationId,
    idempotencyKey: `idem:${operationId}`,
    action,
  });
}

let batchNumber = 0;
async function run(
  executor: ReturnType<typeof createFigmaToolExecutor>,
  operations: ReturnType<typeof operation>[],
) {
  const batch = FigmaToolBatchSchema.parse({
    type: "tool-execute",
    protocolVersion: 1,
    batchId: `test-batch-${++batchNumber}`,
    operations,
  });
  await executor(batch);
  return batch.batchId;
}

function resultFor(messages: PluginToUIMessage[], batchId: string) {
  return [...messages]
    .reverse()
    .find((message) => message.type === "tool-result" && message.batchId === batchId);
}

describe("safe Figma tool executor", () => {
  it("isolates store/header across tasks, reuses confirmed nodes after reload, and edits only inspected foreign refs", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const create = (taskId: string, id: string, ref: string, parent?: string) => ({
      ...operation(id, {
        tool: "create_frame",
        ref,
        name: `${taskId}-${ref}`,
        parent: parent ? { kind: "node", ref: parent } : { kind: "page" },
        size: { width: 390, height: 844 },
      }),
      taskId,
    });
    const first = await run(executor, [
      create("task-first-0001", "first-store-0001", "store"),
      create("task-first-0001", "first-header-001", "header", "store"),
    ]);
    expect(resultFor(messages, first)).toMatchObject({ success: true });
    const firstHeader = mock.find("task-first-0001-header")!;
    const originalRef = firstHeader.getPluginData("fad.tool.logical-ref.v1");
    expect(originalRef).toMatch(/^task-/u);
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const repeated = await run(executor, [
      create("task-first-0001", "repeat-header-001", "header", "store"),
    ]);
    expect(resultFor(messages, repeated)).toMatchObject({
      success: true,
      committedOperationIds: [],
      results: [{ replayed: true, logicalRef: originalRef, data: { reused: true } }],
    });
    expect(mock.nodes).toHaveLength(2);
    expect(firstHeader.name).toBe("task-first-0001-header");
    expect(firstHeader.width).toBe(390);
    const second = await run(executor, [
      create("task-second-001", "second-store-001", "store"),
      create("task-second-001", "second-header-01", "header", "store"),
    ]);
    expect(resultFor(messages, second)).toMatchObject({ success: true });
    expect(mock.nodes).toHaveLength(4);
    expect(mock.find("task-second-001-header")!.getPluginData("fad.tool.logical-ref.v1")).not.toBe(
      originalRef,
    );

    const edit = {
      ...operation("followup-edit-001", {
        tool: "set_properties",
        ref: originalRef,
        properties: { name: "Edited original header" },
      }),
      taskId: "task-followup-01",
    };
    const blocked = await run(executor, [edit]);
    expect(resultFor(messages, blocked)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "inspection_required" } } }],
    });
    const inspected = await run(executor, [
      {
        ...operation("followup-inspect1", {
          tool: "inspect_nodes",
          refs: [originalRef],
          selection: false,
        }),
        taskId: "task-followup-01",
      },
    ]);
    expect(resultFor(messages, inspected)).toMatchObject({ success: true });
    const edited = await run(executor, [edit]);
    expect(resultFor(messages, edited)).toMatchObject({ success: true });
    expect(firstHeader.name).toBe("Edited original header");
    expect(mock.find("task-second-001-header")!.name).toBe("task-second-001-header");
    expect(mock.nodes).toHaveLength(4);
  });

  it("returns bounded canonical candidates when persisted current-task aliases are ambiguous", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      {
        ...operation("candidate-store-001", {
          tool: "create_frame",
          ref: "store",
          name: "Store",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        taskId: "candidate-task-01",
      },
    ]);
    const creation = resultFor(messages, created);
    expect(creation?.type).toBe("tool-result");
    if (creation?.type !== "tool-result") throw new Error("Missing create result");
    const canonicalRef = creation.results[0]?.logicalRef;
    expect(canonicalRef).toBeDefined();
    const persisted = [...mock.storage.values()].find(
      (value) => typeof value === "object" && value !== null && "refs" in value,
    ) as {
      refs: Record<
        string,
        {
          nodeId: string;
          pageId: string;
          parentId?: string;
          nodeType?: string;
          creationFingerprint?: string;
          taskId?: string;
          alias?: string;
          creationOperationId?: string;
        }
      >;
      operations: Record<string, unknown>;
    };
    const secondNode = mock.api.createFrame();
    secondNode.name = "Second candidate";
    secondNode.setPluginData("fad.tool.logical-ref.v1", "task-second-candidate");
    secondNode.setPluginData("fad.tool.task-id.v1", "candidate-task-01");
    secondNode.setPluginData("fad.tool.operation-id.v1", "candidate-store-002");
    secondNode.setPluginData("fad.tool.operation-fingerprint.v1", "a".repeat(32));
    persisted.refs["task-second-candidate"] = {
      nodeId: secondNode.id,
      pageId: "page:current",
      parentId: "page:current",
      nodeType: "FRAME",
      creationFingerprint: "a".repeat(32),
      taskId: "candidate-task-01",
      alias: "store",
      creationOperationId: "candidate-store-002",
    };
    persisted.operations["candidate-store-002"] = {
      operationId: "candidate-store-002",
      taskId: "candidate-task-01",
      creationRef: "task-second-candidate",
      idempotencyKey: "idem:candidate-store-002",
      fingerprint: "a".repeat(32),
      status: "completed",
      updatedAt: Date.now(),
      result: {
        operationId: "candidate-store-002",
        success: true,
        replayed: false,
        logicalRef: "task-second-candidate",
      },
    };

    const ambiguous = await run(executor, [
      {
        ...operation("candidate-edit-001", {
          tool: "set_properties",
          ref: "store",
          properties: { name: "Must not guess" },
        }),
        taskId: "candidate-task-01",
      },
    ]);
    expect(resultFor(messages, ambiguous)).toMatchObject({
      success: false,
      results: [
        {
          data: {
            referenceResolution: {
              code: "ambiguous",
              candidateCount: 2,
              candidates: [
                { canonicalRef, provenance: "current_task_alias" },
                { canonicalRef: "task-second-candidate", provenance: "current_task_alias" },
              ],
              alternatives: expect.arrayContaining([
                "inspect_nodes one listed canonical ref at a time",
              ]),
            },
          },
        },
      ],
    });
    const inspectCandidate = await run(executor, [
      {
        ...operation("candidate-inspect-001", {
          tool: "inspect_nodes",
          refs: ["task-second-candidate"],
          selection: false,
        }),
        taskId: "candidate-task-01",
      },
    ]);
    expect(resultFor(messages, inspectCandidate)).toMatchObject({ success: true });
    expect(mock.nodes[0]?.name).toBe("Store");
  });

  it("fails closed when a persisted node was moved outside an authorized reparent operation", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      {
        ...operation("move-root-a-001", {
          tool: "create_frame",
          ref: "root-a",
          name: "Root A",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        taskId: "moved-task-0001",
      },
      {
        ...operation("move-root-b-001", {
          tool: "create_frame",
          ref: "root-b",
          name: "Root B",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        taskId: "moved-task-0001",
      },
      {
        ...operation("move-child-001", {
          tool: "create_text",
          ref: "child",
          name: "Child",
          parent: { kind: "node", ref: "root-a" },
          text: "Keep me",
          size: { width: 100, height: 32 },
        }),
        taskId: "moved-task-0001",
      },
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const canonicalRef = resultFor(messages, created);
    if (canonicalRef?.type !== "tool-result") throw new Error("Missing creation result");
    const childRef = canonicalRef.results[2]?.logicalRef;
    const child = mock.find("Child")!;
    const state = [...mock.storage.values()].find(
      (value) => typeof value === "object" && value !== null && "refs" in value,
    ) as {
      refs: Record<string, { creationFingerprint?: string }>;
    };
    const fingerprint = state.refs[childRef!]?.creationFingerprint;
    expect(fingerprint).toBeDefined();
    child.setPluginData("fad.tool.operation-fingerprint.v1", "f".repeat(32));
    const tampered = await run(executor, [
      {
        ...operation("move-child-tamper-001", {
          tool: "set_properties",
          ref: childRef,
          properties: { text: "Must not change" },
        }),
        taskId: "moved-task-0001",
      },
    ]);
    expect(resultFor(messages, tampered)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "stale" } } }],
    });
    child.setPluginData("fad.tool.operation-fingerprint.v1", fingerprint!);
    mock.find("Root B")!.appendChild(child);

    const edited = await run(executor, [
      {
        ...operation("move-child-edit-001", {
          tool: "set_properties",
          ref: childRef,
          properties: { text: "Must not change" },
        }),
        taskId: "moved-task-0001",
      },
    ]);
    expect(resultFor(messages, edited)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "stale" } } }],
    });
    expect(child.characters).toBe("Keep me");
    expect(child.parent?.id).toBe(mock.find("Root B")?.id);
  });

  it("updates the persisted parent identity after an authorized reparent commits", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const taskId = "reparent-task-01";
    const created = await run(executor, [
      {
        ...operation("reparent-root-a-01", {
          tool: "create_frame",
          ref: "root-a",
          name: "Root A",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        taskId,
      },
      {
        ...operation("reparent-root-b-01", {
          tool: "create_frame",
          ref: "root-b",
          name: "Root B",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        taskId,
      },
      {
        ...operation("reparent-child-01", {
          tool: "create_text",
          ref: "child",
          name: "Movable child",
          parent: { kind: "node", ref: "root-a" },
          text: "Original content",
          size: { width: 180, height: 32 },
        }),
        taskId,
      },
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const child = mock.find("Movable child")!;
    const rootB = mock.find("Root B")!;
    const moved = await run(executor, [
      {
        ...operation("reparent-child-02", {
          tool: "reparent_node",
          ref: "child",
          parentRef: "root-b",
        }),
        taskId,
      },
    ]);
    expect(resultFor(messages, moved)).toMatchObject({ success: true });
    expect(child.parent?.id).toBe(rootB.id);
    const state = [...mock.storage.values()].find(
      (value) => typeof value === "object" && value !== null && "refs" in value,
    ) as {
      refs: Record<string, { taskId?: string; alias?: string; nodeId: string; parentId?: string }>;
    };
    const childEntry = Object.values(state.refs).find(
      (entry) => entry.taskId === taskId && entry.alias === "child",
    );
    const rootBEntry = Object.values(state.refs).find(
      (entry) => entry.taskId === taskId && entry.alias === "root-b",
    );
    expect(childEntry?.parentId).toBe(rootBEntry?.nodeId);

    const edited = await run(executor, [
      {
        ...operation("reparent-child-edit-01", {
          tool: "set_properties",
          ref: "child",
          properties: { text: "Edited after authorized move" },
        }),
        taskId,
      },
    ]);
    expect(resultFor(messages, edited)).toMatchObject({ success: true });
    expect(child.characters).toBe("Edited after authorized move");
  });

  it("fails closed for deleted, ambiguous and unconfirmed task refs instead of recreating them", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const create = (id: string, ref: string) => ({
      ...operation(id, {
        tool: "create_frame",
        ref,
        name: ref,
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
      taskId: "task-uncertain-01",
    });
    await run(executor, [create("uncertain-store1", "store")]);
    const node = mock.find("store")!;
    node.remove();
    const stale = await run(executor, [create("uncertain-store2", "store")]);
    expect(resultFor(messages, stale)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "stale" } } }],
    });
    expect(mock.nodes).toHaveLength(1);

    await run(executor, [create("uncertain-headr1", "header")]);
    const header = mock.find("header")!;
    const copied = mock.api.createFrame();
    copied.setPluginData(
      "fad.tool.logical-ref.v1",
      header.getPluginData("fad.tool.logical-ref.v1"),
    );
    const ambiguous = await run(executor, [create("uncertain-headr2", "header")]);
    expect(resultFor(messages, ambiguous)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "ambiguous" } } }],
    });

    await run(executor, [create("uncertain-footer1", "footer")]);
    const key = [...mock.storage.keys()][0]!;
    const state = mock.storage.get(key) as {
      operations: Record<string, { status: string }>;
      refs: Record<string, { alias?: string }>;
    };
    state.operations["uncertain-footer1"]!.status = "running";
    const footerRef = Object.keys(state.refs).find((ref) => state.refs[ref]?.alias === "footer")!;
    delete state.refs[footerRef];
    const interrupted = await run(executor, [create("uncertain-footer2", "footer")]);
    expect(resultFor(messages, interrupted)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "unconfirmed_creation" } } }],
    });
    const recovered = await run(executor, [create("uncertain-footer1", "footer")]);
    expect(resultFor(messages, recovered)).toMatchObject({
      success: true,
      results: [{ replayed: true }],
    });
  });

  it("retains legacy reservations but namespaces a new task using the same generic store ref", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const action = {
      tool: "create_frame",
      ref: "store",
      name: "Legacy store",
      parent: { kind: "page" },
      size: { width: 390, height: 844 },
    };
    await run(executor, [operation("legacy-store-001", action)]);
    const collision = await run(executor, [operation("legacy-store-002", action)]);
    expect(resultFor(messages, collision)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "reserved_by_other_or_legacy_task" } } }],
    });
    const scoped = await run(executor, [
      { ...operation("scoped-store-001", action), taskId: "task-scoped-001" },
    ]);
    expect(resultFor(messages, scoped)).toMatchObject({ success: true });
    expect(mock.nodes).toHaveLength(2);
    expect(mock.nodes[0]!.getPluginData("fad.tool.logical-ref.v1")).toBe("store");
  });

  it("does not recreate a checkpointed creation when the executor registry is missing", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batch = await run(executor, [
      {
        ...operation("checkpoint-store-02", {
          tool: "create_frame",
          ref: "store",
          name: "Store",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        taskId: "task-checkpoint1",
        expectedCreationOperationId: "checkpoint-store-01",
      },
    ]);
    expect(resultFor(messages, batch)).toMatchObject({
      success: false,
      results: [{ data: { referenceResolution: { code: "checkpoint_registry_conflict" } } }],
    });
    expect(mock.nodes).toHaveLength(0);
  });

  it("reuses a legacy task node only with a matching confirmed same-task creation ID", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const action = {
      tool: "create_frame",
      ref: "store",
      name: "Store",
      parent: { kind: "page" },
      size: { width: 390, height: 844 },
    };
    await run(executor, [operation("chat-legacy-001-op-1", action)]);
    const reused = await run(executor, [
      {
        ...operation("chat-legacy-001-op-2", action),
        expectedCreationOperationId: "chat-legacy-001-op-1",
      },
    ]);
    expect(resultFor(messages, reused)).toMatchObject({
      success: true,
      results: [{ replayed: true, data: { reused: true } }],
    });
    const foreign = await run(executor, [
      {
        ...operation("chat-foreign-01-op-1", action),
        expectedCreationOperationId: "chat-legacy-001-op-1",
      },
    ]);
    expect(resultFor(messages, foreign)).toMatchObject({ success: false });
    expect(mock.nodes).toHaveLength(1);
  });

  it("progressively executes a planned Persian storefront through the real executor, waits for capacity, and reconciles a lost result", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let callIndex = 0;
    const toolTurn = (
      name: string,
      args: unknown,
    ): Extract<AuthorizedChatTurn, { kind: "tool_calls" }> => {
      const calls = parseResponsesFunctionCalls([
        {
          type: "function_call",
          call_id: `storefront_call_${++callIndex}`,
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
    };
    const createTurn = (count: number, prefix: string) => {
      const turns = Array.from({ length: count }, (_, index) => {
        const container = prefix.startsWith("product") || prefix === "purchase";
        if (container && index % 2 === 0)
          return toolTurn("create_frame", {
            ref: `${prefix}-${index}`,
            name: `${prefix} ${index}`,
            parent: { kind: "node", ref: "storefront-page" },
            size: { width: 342, height: prefix === "purchase" ? 48 : 96 },
            fill: prefix === "purchase" ? "#0F766E" : "#FFFFFF",
            autoLayout: { direction: "vertical", gap: 4 },
          });
        return toolTurn("create_text", {
          ref: `${prefix}-${index}`,
          name: `${prefix} ${index}`,
          parent: { kind: "node", ref: container ? `${prefix}-${index - 1}` : "storefront-page" },
          text: `فروشگاه لباس ${index}`,
          size: { width: 340, height: 44 },
          color: prefix === "purchase" ? "#FFFFFF" : "#1F2937",
          direction: "RTL",
          align: "RIGHT",
        });
      });
      return {
        kind: "tool_calls" as const,
        calls: turns.flatMap((turn) => turn.calls),
        functionCallItems: turns.flatMap((turn) => turn.functionCallItems),
        text: "",
      };
    };
    const finishStage = () =>
      toolTurn("complete_canvas_stage", { summary: "Confirmed native section" });
    const turns: AuthorizedChatTurn[] = [
      toolTurn("get_document_context", {}),
      toolTurn("plan_canvas_task", {
        brief: {
          platform: "mobile",
          viewport: { width: 390, height: 844 },
          brandDirection: "مدرن و مینیمال",
          audience: "خریداران پوشاک",
          content: ["هدر", "جست‌وجو", "دسته‌بندی", "محصولات", "خرید"],
          hierarchy: "عنوان برجسته و قیمت خوانا",
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
          interactionPriorities: ["خرید محصول"],
          readingDirection: "RTL",
        },
        stages: [
          ["صفحه", "storefront-page"],
          ["هدر و ناوبری", "header-0"],
          ["جست‌وجو", "search-0"],
          ["دسته‌بندی‌ها", "category-0"],
          ["کارت محصولات", "product-a-0", "product-b-0"],
          ["دکمه‌های خرید", "purchase-0"],
        ].map(([title, ...logicalRefs]) => ({
          title: title!,
          goal: `ساخت ${title}`,
          logicalRefs: logicalRefs!,
          completionCriteria: [`${title} در فیگما قابل ویرایش باشد`],
        })),
      }),
      toolTurn("create_frame", {
        ref: "storefront-page",
        name: "فروشگاه لباس",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
        autoLayout: { direction: "vertical", gap: 8 },
      }),
      finishStage(),
      createTurn(6, "header"),
      finishStage(),
      createTurn(6, "search"),
      finishStage(),
      createTurn(6, "category"),
      finishStage(),
      createTurn(8, "product-a"),
      createTurn(8, "product-b"),
      finishStage(),
      createTurn(8, "purchase"),
      finishStage(),
      { kind: "done", text: "تمام بخش‌های فروشگاه تأیید شدند." },
    ];
    const current = ChatTaskSchema.parse({
      version: 1,
      id: "storefront-task-0001",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt:
        "یک صفحه موبایل فروشگاه لباس با هدر، جست‌وجو، دسته‌بندی‌ها، کارت محصولات و دکمه‌های خرید بساز",
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
    const batches: ReturnType<typeof operation>[][] = [];
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    let lostOperationIds: string[] | undefined;
    let activeTask = current;
    const waits: number[] = [];
    const deps = {
      signal: new AbortController().signal,
      model: async () => {
        const turn = turns.shift();
        if (!turn)
          throw new Error(
            `No scripted storefront turn at round ${activeTask.rounds}; remaining turns ${turns.length}; pending ${JSON.stringify(activeTask.pending.map(({ action }) => action.tool))}; recent ${JSON.stringify(activeTask.recent.slice(-2))}; stages ${JSON.stringify(activeTask.stages.map(({ title, completed, verified, operations, qaAttempts }) => ({ title, completed, verified, operations, qaAttempts })))}; QA ${JSON.stringify(activeTask.ledger.filter(({ call }) => call.action.tool === "inspect_nodes").map(({ stage, output }) => ({ stage, output })))}; ledger ${activeTask.ledger.length}`,
          );
        return turn;
      },
      save: async () => {},
      progress: () => {},
      wait: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
      execute: async (operations: ReturnType<typeof operation>[]) => {
        batches.push(operations);
        const batchId = await run(executor, operations);
        const result = resultFor(messages, batchId);
        if (result?.type !== "tool-result") throw new Error("Missing confirmation");
        if (!lostOperationIds && operations.some((item) => item.action.tool === "create_frame")) {
          lostOperationIds = operations.map((item) => item.operationId);
          throw new Error("Simulated lost UI acknowledgement");
        }
        return result;
      },
    };
    try {
      await expect(runChatTask(current, deps)).rejects.toThrow("Simulated lost UI acknowledgement");
      expect(current.pending.map(({ action }) => action.tool)).toEqual(["create_frame"]);
      expect(turns).toHaveLength(13);
      expect(mock.nodes).toHaveLength(1);
      executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(current)));
      activeTask = restored;
      expect(restored.pending.map(({ action }) => action.tool)).toEqual(["create_frame"]);
      await runChatTask(restored, deps);
      expect(mock.nodes).toHaveLength(43);
      expect(mock.find("فروشگاه لباس")).toMatchObject({ type: "FRAME", width: 390, height: 844 });
      expect(mock.find("product-a 0")).toMatchObject({ type: "FRAME" });
      expect(mock.find("purchase 0")).toMatchObject({ type: "FRAME", height: 48 });
      expect(mock.find("product-a 1")).toMatchObject({
        type: "TEXT",
        characters: "فروشگاه لباس 1",
      });
      const replay = batches.findIndex(
        (batch, index) => index > 0 && batch[0]?.operationId === lostOperationIds?.[0],
      );
      expect(batches[replay]).toEqual(
        batches.find((batch) => batch.some((item) => item.operationId === lostOperationIds?.[0])),
      );
      expect(batches.every((batch) => batch.length <= 3)).toBe(true);
      expect(waits.length).toBeGreaterThan(0);
      expect(
        messages
          .filter((message) => message.type === "tool-result")
          .every((message) => message.type === "tool-result" && message.success),
      ).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("executes the native harness sequence without browser encoders or Web Crypto", async () => {
    const globalObject = globalThis as unknown as Record<string, unknown>;
    const globalNames = ["TextEncoder", "TextDecoder", "crypto"];
    const descriptors = new Map(
      globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const unicode = "فارسی العربية 😀 𝄞";
    expect(utf8Bytes(unicode)).toBe(35);
    expect(utf8Bytes("\ud800")).toBe(3);

    try {
      for (const name of globalNames)
        Object.defineProperty(globalObject, name, {
          configurable: true,
          writable: true,
          value: undefined,
        });

      const mock = createMockApi();
      const messages: PluginToUIMessage[] = [];
      const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      const createOperations = [
        operation("runtime-frame-0001", {
          tool: "create_frame",
          ref: "runtime-frame",
          name: "Mobile 390 × 844",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
        operation("runtime-title-001", {
          tool: "create_text",
          ref: "runtime-title",
          name: "عنوان فارسی",
          parent: { kind: "node", ref: "runtime-frame" },
          text: "خوش آمدید",
          size: { width: 350, height: 40 },
          direction: "RTL",
          align: "RIGHT",
          fontSize: 24,
        }),
        operation("runtime-input-01", {
          tool: "create_text",
          ref: "runtime-input",
          name: "Editable input",
          parent: { kind: "node", ref: "runtime-frame" },
          text: "ایمیل خود را وارد کنید",
          size: { width: 350, height: 48 },
          direction: "RTL",
          align: "RIGHT",
        }),
        operation("runtime-button-01", {
          tool: "create_rectangle",
          ref: "runtime-button",
          name: "Button",
          parent: { kind: "node", ref: "runtime-frame" },
          size: { width: 200, height: 48 },
          fill: "#6841D8",
          cornerRadius: 10,
        }),
      ];
      const createBatch = await run(executor, createOperations);
      expect(resultFor(messages, createBatch)).toMatchObject({ success: true });

      const frame = mock.find("Mobile 390 × 844")!;
      const title = mock.find("عنوان فارسی")!;
      const input = mock.find("Editable input")!;
      const button = mock.find("Button")!;
      expect(frame).toMatchObject({ type: "FRAME", width: 390, height: 844 });
      expect(title).toMatchObject({ type: "TEXT", characters: "خوش آمدید" });
      expect(input).toMatchObject({ type: "TEXT", characters: "ایمیل خود را وارد کنید" });

      const unchangedButtonProperties = {
        name: button.name,
        x: button.x,
        y: button.y,
        width: button.width,
        height: button.height,
        cornerRadius: button.cornerRadius,
      };
      const recolor = operation("runtime-color-001", {
        tool: "set_properties",
        ref: "runtime-button",
        properties: { fill: "#0F766E" },
      });
      const colorBatch = await run(executor, [recolor]);
      expect(resultFor(messages, colorBatch)).toMatchObject({ success: true });
      expect(button.fills).toEqual([
        { type: "SOLID", color: { r: 15 / 255, g: 118 / 255, b: 110 / 255 } },
      ]);
      expect({
        name: button.name,
        x: button.x,
        y: button.y,
        width: button.width,
        height: button.height,
        cornerRadius: button.cornerRadius,
      }).toEqual(unchangedButtonProperties);

      const nodeCount = mock.nodes.length;
      const colorReplay = await run(executor, [recolor]);
      expect(resultFor(messages, colorReplay)).toMatchObject({
        success: true,
        results: [{ operationId: recolor.operationId, replayed: true }],
      });
      const createReplay = await run(executor, createOperations);
      expect(resultFor(messages, createReplay)).toMatchObject({
        success: true,
        results: createOperations.map(({ operationId }) => ({ operationId, replayed: true })),
      });
      expect(mock.nodes).toHaveLength(nodeCount);

      const untracked = mock.api.createRectangle() as unknown as MockNode;
      untracked.name = "Untracked selected node";
      mock.page.selection = [untracked];
      const nodeCountWithUntrackedSelection = mock.nodes.length;
      const inspectBatch = await run(executor, [
        operation("runtime-inspect-01", {
          tool: "inspect_nodes",
          selection: true,
          depth: 0,
          maxNodes: 5,
        }),
      ]);
      expect(resultFor(messages, inspectBatch)).toMatchObject({
        success: true,
        results: [{ data: { nodes: [{ ref: expect.stringMatching(/^inspected-/u) }] } }],
      });

      const oversizedBatch = await run(executor, [
        operation("runtime-large-001", {
          tool: "create_text",
          ref: "runtime-large-a",
          name: "Large Persian text A",
          parent: { kind: "page" },
          text: "ف".repeat(20_000),
          size: { width: 100, height: 20 },
        }),
        operation("runtime-large-002", {
          tool: "create_text",
          ref: "runtime-large-b",
          name: "Large Persian text B",
          parent: { kind: "page" },
          text: "ف".repeat(20_000),
          size: { width: 100, height: 20 },
        }),
      ]);
      expect(resultFor(messages, oversizedBatch)).toMatchObject({
        success: false,
        results: [{ error: expect.stringContaining("64 KiB safety limit") }],
      });
      expect(mock.nodes).toHaveLength(nodeCountWithUntrackedSelection);

      await executor({
        type: "tool-delete-consent",
        protocolVersion: 1,
        requestId: "runtime-consent-01",
        ref: "runtime-button",
        confirmation: "DELETE runtime-button",
      });
      expect(messages.at(-1)).toMatchObject({
        type: "tool-delete-consent-result",
        success: false,
        message: expect.stringContaining("Secure random values are unavailable"),
      });
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalObject, name, descriptor);
        else delete globalObject[name];
      }
    }
  });

  it("turns validated Persian Responses calls into a native 390×844 frame and editable RTL text", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const calls = parseResponsesFunctionCalls([
      {
        type: "function_call",
        call_id: "call_frame_persian1",
        name: "create_frame",
        arguments: JSON.stringify({
          ref: "shop-home",
          name: "خانه فروشگاه",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        }),
      },
      {
        type: "function_call",
        call_id: "call_text_persian1",
        name: "create_text",
        arguments: JSON.stringify({
          ref: "shop-heading",
          name: "عنوان فارسی",
          parent: { kind: "node", ref: "shop-home" },
          text: "فروشگاه شما",
          size: { width: 342, height: 40 },
          direction: "RTL",
          align: "RIGHT",
          fontSize: 24,
        }),
      },
    ]);
    const batchId = await run(
      executor,
      calls.map(({ callId, action }) => operation(callId, action)),
    );
    expect(resultFor(messages, batchId)).toMatchObject({ success: true });
    expect(mock.find("خانه فروشگاه")).toMatchObject({ type: "FRAME", width: 390, height: 844 });
    expect(mock.find("عنوان فارسی")).toMatchObject({
      type: "TEXT",
      characters: "فروشگاه شما",
      textAlignHorizontal: "RIGHT",
    });
  });

  it("creates editable native frame, Persian text and rectangle; targeted fill updates preserve unrelated properties and survive reload", async () => {
    const mock = createMockApi();
    const original =
      mock.find("Original user layer") ?? (mock.api.createRectangle() as unknown as MockNode);
    original.name = "Original user layer";
    original.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const ops = [
      operation("test-frame-0001", {
        tool: "create_frame",
        ref: "mobile-frame",
        name: "Persian mobile",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
        fill: "#F8FAFC",
        stroke: "#D1D5DB",
        strokeWeight: 1,
        opacity: 0.98,
        shadow: {
          color: "#111827",
          opacity: 0.12,
          offsetX: 0,
          offsetY: 6,
          radius: 16,
          spread: 0,
        },
        clipsContent: true,
        autoLayout: {
          direction: "vertical",
          gap: 16,
          counterSizing: "AUTO",
          padding: { top: 24, right: 20, bottom: 24, left: 20 },
        },
      }),
      operation("test-title-0001", {
        tool: "create_text",
        ref: "persian-title",
        name: "عنوان فارسی",
        parent: { kind: "node", ref: "mobile-frame" },
        text: "سلام فروشگاه",
        size: { width: 350, height: 40 },
        font: { family: "Unavailable Persian Font", style: "Regular" },
        direction: "RTL",
        fontSize: 24,
        lineHeight: 32,
        letterSpacing: 0.2,
        textAutoResize: "HEIGHT",
        horizontalSizing: "FILL",
        verticalSizing: "HUG",
      }),
      operation("test-rect-0001", {
        tool: "create_rectangle",
        ref: "action-button",
        name: "Button surface",
        parent: { kind: "node", ref: "mobile-frame" },
        size: { width: 200, height: 48 },
        fill: "#6841D8",
        stroke: "#4C2AB0",
        strokeWeight: 2,
        cornerRadius: 10,
        opacity: 0.9,
        shadow: {
          color: "#111827",
          opacity: 0.16,
          offsetX: 0,
          offsetY: 3,
          radius: 8,
          spread: 0,
        },
      }),
      operation("test-color-0001", {
        tool: "set_properties",
        ref: "action-button",
        properties: { fill: "#0F766E" },
      }),
      operation("test-paint-token", {
        tool: "set_properties",
        ref: "action-button",
        properties: { paintStyleId: "paint-token-brand" },
      }),
      operation("test-text-token", {
        tool: "set_properties",
        ref: "persian-title",
        properties: { textStyleId: "text-token-heading" },
      }),
      operation("test-typography-01", {
        tool: "set_properties",
        ref: "persian-title",
        properties: {
          fontFamily: "Arial",
          fontStyle: "Regular",
          fontSize: 20,
          lineHeight: 28,
          letterSpacing: 0.25,
          align: "RIGHT",
          textAutoResize: "TRUNCATE",
        },
      }),
    ];
    const firstBatch = await run(executor, ops);
    expect(resultFor(messages, firstBatch)).toMatchObject({
      success: true,
      committedOperationIds: ops.map(({ operationId }) => operationId),
    });
    const frame = mock.find("Persian mobile")!;
    const title = mock.find("عنوان فارسی")!;
    const button = mock.find("Button surface")!;
    expect(frame.type).toBe("FRAME");
    expect(frame.width).toBe(390);
    expect(frame.counterAxisSizingMode).toBe("FIXED");
    expect(
      boundsIntersectWithGap(
        { x: original.x, y: original.y, width: original.width, height: original.height },
        { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
        DEFAULT_MIN_CANVAS_GAP,
      ),
    ).toBe(false);
    expect(title.type).toBe("TEXT");
    expect(title.characters).toBe("سلام فروشگاه");
    expect(JSON.stringify([...mock.storage.values()])).not.toContain("سلام فروشگاه");
    expect(JSON.stringify([...title.pluginData.entries()])).not.toContain("سلام فروشگاه");
    expect(title.textAlignHorizontal).toBe("RIGHT");
    expect(title.fontName).toEqual({ family: "Arial", style: "Regular" });
    expect(title).toMatchObject({
      fontSize: 20,
      lineHeight: { unit: "PIXELS", value: 28 },
      letterSpacing: { unit: "PIXELS", value: 0.25 },
      textAutoResize: "TRUNCATE",
    });
    expect(button.fillStyleId).toBe("paint-token-brand");
    expect(title.textStyleId).toBe("text-token-heading");
    expect(frame).toMatchObject({
      opacity: 0.98,
      strokeWeight: 1,
      clipsContent: true,
      effects: [{ type: "DROP_SHADOW", radius: 16, spread: 0 }],
    });
    expect(button).toMatchObject({
      opacity: 0.9,
      strokeWeight: 2,
      effects: [{ type: "DROP_SHADOW", radius: 8, spread: 0 }],
    });
    expect(mock.find("Original user layer")?.fills).toEqual([
      { type: "SOLID", color: { r: 1, g: 0, b: 0 } },
    ]);

    const countBeforeReplay = mock.nodes.length;
    const reloaded = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const replayBatch = await run(reloaded, ops);
    expect(resultFor(messages, replayBatch)).toMatchObject({
      success: true,
      results: ops.map((op) => ({ operationId: op.operationId, success: true, replayed: true })),
    });
    expect(mock.nodes).toHaveLength(countBeforeReplay);
    const edit = operation("test-edit-0001", {
      tool: "set_properties",
      ref: "action-button",
      properties: { fill: "#1D4ED8" },
    });
    const editBatch = await run(reloaded, [edit]);
    expect(resultFor(messages, editBatch)).toMatchObject({ success: true });
    expect(button.fills).toEqual([
      { type: "SOLID", color: { r: 29 / 255, g: 78 / 255, b: 216 / 255 } },
    ]);
    expect(title.characters).toBe("سلام فروشگاه");

    const uncertainEdit = operation("test-uncertain-01", {
      tool: "set_properties",
      ref: "action-button",
      properties: { name: "Known applied operation" },
    });
    const uncertainBatch = await run(reloaded, [uncertainEdit]);
    expect(resultFor(messages, uncertainBatch)).toMatchObject({ success: true });
    const storageKey = [...mock.storage.keys()][0]!;
    const savedState = mock.storage.get(storageKey) as {
      operations: Record<string, { status: string; result?: unknown }>;
    };
    savedState.operations[uncertainEdit.operationId]!.status = "running";
    delete savedState.operations[uncertainEdit.operationId]!.result;
    button.name = "Changed after interruption";
    const uncertainReplay = await run(reloaded, [uncertainEdit]);
    expect(resultFor(messages, uncertainReplay)).toMatchObject({
      success: false,
      results: [{ replayed: true, error: expect.stringContaining("interrupted") }],
    });
    expect(button.name).toBe("Changed after interruption");
  });

  it("normalizes nested mixed Auto Layout sizing and rejects stretch conflicts only after deterministic local repair", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const ops = [
      operation("layout-root-0001", {
        tool: "create_frame",
        ref: "layout-root",
        name: "Vertical root",
        parent: { kind: "page" },
        size: { width: 360, height: 700 },
        autoLayout: { direction: "vertical", gap: 12 },
      }),
      operation("layout-row-0001", {
        tool: "create_frame",
        ref: "layout-row",
        name: "Horizontal row",
        parent: { kind: "node", ref: "layout-root" },
        size: { width: 320, height: 80 },
        autoLayout: { direction: "horizontal", gap: 8 },
      }),
      operation("layout-child-01", {
        tool: "create_rectangle",
        ref: "layout-child",
        name: "Stretch child",
        parent: { kind: "node", ref: "layout-row" },
        size: { width: 100, height: 60 },
      }),
      operation("layout-set-root", {
        tool: "set_auto_layout",
        ref: "layout-root",
        layout: { direction: "vertical", gap: 12, counterSizing: "AUTO" },
        children: [{ ref: "layout-row", align: "STRETCH", horizontal: "FIXED" }],
      }),
      operation("layout-set-row", {
        tool: "set_auto_layout",
        ref: "layout-row",
        layout: { direction: "horizontal", gap: 8, counterSizing: "AUTO" },
        children: [
          {
            ref: "layout-child",
            align: "STRETCH",
            vertical: "FIXED",
            grow: 1,
            horizontal: "FILL",
          },
        ],
      }),
    ];
    const batch = await run(executor, ops);
    expect(resultFor(messages, batch)).toMatchObject({ success: true });
    const root = mock.find("Vertical root")!;
    const row = mock.find("Horizontal row")!;
    const child = mock.find("Stretch child")!;
    expect(root.layoutMode).toBe("VERTICAL");
    expect(row.layoutMode).toBe("HORIZONTAL");
    expect(root.counterAxisSizingMode).toBe("FIXED");
    expect(row.counterAxisSizingMode).toBe("FIXED");
    expect(row.primaryAxisSizingMode).toBe("FIXED");
    expect(child.layoutSizingHorizontal).toBe("FILL");
    expect(row.layoutAlign).toBe("STRETCH");
    expect(row.layoutSizingHorizontal).toBe("FILL");
    expect(child.layoutSizingVertical).toBe("FILL");
    expect(child.layoutAlign).toBe("STRETCH");
    const statusOperation = operation("layout-status-01", {
      tool: "get_operation_status",
      operationId: "layout-set-row",
    });
    const statusBatch = await run(executor, [statusOperation]);
    expect(resultFor(messages, statusBatch)).toMatchObject({ success: true });
  });

  it("returns bounded document context, local tokens and depth-limited selected-node inspection", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const createBatch = await run(executor, [
      operation("context-root-001", {
        tool: "create_frame",
        ref: "context-root",
        name: "Context root",
        parent: { kind: "page" },
        size: { width: 250, height: 250 },
      }),
    ]);
    expect(resultFor(messages, createBatch)).toMatchObject({ success: true });
    mock.page.selection = [mock.find("Context root")!];
    const contextBatch = await run(executor, [
      operation("context-read-0001", { tool: "get_document_context" }),
    ]);
    const context = resultFor(messages, contextBatch);
    expect(context).toMatchObject({
      success: true,
      results: [
        {
          data: {
            page: { name: "Current Page" },
            tokens: {
              paintStyles: [{ name: "Color/Brand" }],
              textStyles: [{ name: "Typography/Heading" }],
              variables: [],
            },
          },
        },
      ],
    });
    const inspectBatch = await run(executor, [
      operation("context-inspect01", {
        tool: "inspect_nodes",
        selection: true,
        depth: 0,
        maxNodes: 5,
      }),
    ]);
    expect(resultFor(messages, inspectBatch)).toMatchObject({
      success: true,
      results: [{ data: { nodes: [{ name: "Context root", childCount: 0 }] } }],
    });
  });

  it("assigns local logical refs while inspecting existing selection so later edits never need Figma node IDs", async () => {
    const mock = createMockApi();
    const existing = mock.api.createRectangle() as unknown as MockNode;
    existing.name = "User-owned card";
    mock.page.selection = [existing];
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const inspectBatch = await run(executor, [
      operation("bind-selection-01", {
        tool: "inspect_nodes",
        selection: true,
        depth: 0,
        maxNodes: 5,
      }),
    ]);
    const inspect = resultFor(messages, inspectBatch);
    expect(inspect).toMatchObject({ success: true });
    if (inspect?.type !== "tool-result") throw new Error("Expected an inspection result.");
    const nodes = inspect.results[0]?.data?.nodes as Array<Record<string, unknown>>;
    const ref = nodes[0]?.ref;
    expect(ref).toEqual(expect.stringMatching(/^inspected-/u));
    expect(JSON.stringify(nodes)).not.toContain(existing.id);

    const editBatch = await run(executor, [
      operation("edit-selection-01", {
        tool: "set_properties",
        ref: ref as string,
        properties: { name: "Updated user-owned card", fill: "#0F766E" },
      }),
    ]);
    expect(resultFor(messages, editBatch)).toMatchObject({ success: true });
    expect(existing.name).toBe("Updated user-owned card");
    expect(existing.fills).toEqual([
      { type: "SOLID", color: { r: 15 / 255, g: 118 / 255, b: 110 / 255 } },
    ]);
  });

  it("rejects stale refs, invalid parents and reparent cycles without moving unrelated content", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const createBatch = await run(executor, [
      operation("safety-root-0001", {
        tool: "create_frame",
        ref: "safe-root",
        name: "Safe root",
        parent: { kind: "page" },
        size: { width: 300, height: 300 },
      }),
      operation("safety-child-001", {
        tool: "create_frame",
        ref: "safe-child",
        name: "Safe child",
        parent: { kind: "node", ref: "safe-root" },
        size: { width: 200, height: 100 },
      }),
      operation("safety-text-001", {
        tool: "create_text",
        ref: "safe-text",
        name: "Not a parent",
        parent: { kind: "node", ref: "safe-root" },
        text: "Editable",
        size: { width: 120, height: 24 },
      }),
    ]);
    expect(resultFor(messages, createBatch)).toMatchObject({ success: true });
    const root = mock.find("Safe root")!;
    const child = mock.find("Safe child")!;
    const invalidParent = await run(executor, [
      operation("invalid-parent-01", {
        tool: "create_frame",
        ref: "never-created",
        name: "Invalid parent child",
        parent: { kind: "node", ref: "safe-text" },
        size: { width: 100, height: 100 },
      }),
    ]);
    expect(resultFor(messages, invalidParent)).toMatchObject({ success: false });
    const cycle = await run(executor, [
      operation("cycle-test-0001", {
        tool: "reparent_node",
        ref: "safe-root",
        parentRef: "safe-child",
      }),
    ]);
    expect(resultFor(messages, cycle)).toMatchObject({ success: false });
    expect(child.parent).toBe(root);
    expect(root.parent).toBe(mock.page);

    mock.page.id = "page:other";
    const crossPage = await run(executor, [
      operation("cross-page-0001", {
        tool: "set_properties",
        ref: "safe-root",
        properties: { name: "Must stay safe" },
      }),
    ]);
    expect(resultFor(messages, crossPage)).toMatchObject({ success: false });
    expect(root.name).toBe("Safe root");
    mock.page.id = "page:current";

    child.remove();
    const stale = await run(executor, [
      operation("stale-test-0001", {
        tool: "set_properties",
        ref: "safe-child",
        properties: { fill: "#000000" },
      }),
    ]);
    expect(resultFor(messages, stale)).toMatchObject({
      success: false,
      results: [{ error: expect.stringContaining("stale") }],
    });
  });

  it("stops before creating on a newly selected page when font loading crosses the page boundary", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const frameBatch = await run(executor, [
      operation("page-guard-root", {
        tool: "create_frame",
        ref: "page-guard-frame",
        name: "Original page frame",
        parent: { kind: "page" },
        size: { width: 300, height: 400 },
      }),
    ]);
    expect(resultFor(messages, frameBatch)).toMatchObject({ success: true });
    const count = mock.nodes.length;
    (mock.api as unknown as { loadFontAsync: () => Promise<void> }).loadFontAsync = async () => {
      mock.switchCurrentPage();
    };
    const textBatch = await run(executor, [
      operation("page-guard-text", {
        tool: "create_text",
        ref: "page-guard-title",
        name: "Must not cross pages",
        parent: { kind: "node", ref: "page-guard-frame" },
        text: "No cross-page edits",
        size: { width: 200, height: 30 },
      }),
    ]);
    expect(resultFor(messages, textBatch)).toMatchObject({ success: false });
    expect(mock.nodes).toHaveLength(count);
    expect(mock.find("Original page frame")).toBeDefined();
    expect(mock.find("Must not cross pages")).toBeUndefined();
  });

  it("stops a batch after partial failure, reports earlier commits, and cancels only between operations", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const first = operation("partial-first-01", {
      tool: "create_frame",
      ref: "partial-frame",
      name: "Committed before failure",
      parent: { kind: "page" },
      size: { width: 240, height: 240 },
    });
    const second = operation("partial-second1", {
      tool: "create_frame",
      ref: "partial-second",
      name: "Must not be created",
      parent: { kind: "node", ref: "missing-parent" },
      size: { width: 100, height: 100 },
    });
    const partialBatch = await run(executor, [first, second]);
    expect(resultFor(messages, partialBatch)).toMatchObject({
      success: false,
      committedOperationIds: [first.operationId],
      results: [{ success: true }, { success: false }],
    });
    expect(mock.find("Committed before failure")).toBeDefined();
    expect(mock.find("Must not be created")).toBeUndefined();
    const count = mock.nodes.length;
    const replayBatch = await run(executor, [first]);
    expect(resultFor(messages, replayBatch)).toMatchObject({
      success: true,
      results: [{ replayed: true }],
    });
    expect(mock.nodes).toHaveLength(count);

    const cancelMessages: PluginToUIMessage[] = [];
    const cancelExecutor = createFigmaToolExecutor(mock.api, (message) => {
      cancelMessages.push(message);
      if (message.type === "tool-progress" && message.status === "running")
        void cancelExecutor({ type: "tool-cancel", protocolVersion: 1, batchId: message.batchId });
    });
    const cancelledBatchId = "cancel-batch-0001";
    await cancelExecutor(
      FigmaToolBatchSchema.parse({
        type: "tool-execute",
        protocolVersion: 1,
        batchId: cancelledBatchId,
        operations: [
          operation("cancel-one-0001", {
            tool: "create_frame",
            ref: "cancel-one",
            name: "Committed before cancel",
            parent: { kind: "page" },
            size: { width: 220, height: 220 },
          }),
          operation("cancel-two-0001", {
            tool: "create_frame",
            ref: "cancel-two",
            name: "Not created after cancel",
            parent: { kind: "page" },
            size: { width: 220, height: 220 },
          }),
        ],
      }),
    );
    expect(resultFor(cancelMessages, cancelledBatchId)).toMatchObject({
      success: false,
      cancelled: true,
      committedOperationIds: ["cancel-one-0001"],
    });
    expect(mock.find("Committed before cancel")).toBeDefined();
    expect(mock.find("Not created after cancel")).toBeUndefined();
  });

  it("returns a bounded terminal failure when plugin storage never responds", async () => {
    const mock = createMockApi();
    (
      mock.api as unknown as {
        clientStorage: { getAsync: () => Promise<unknown> };
      }
    ).clientStorage.getAsync = () => new Promise(() => undefined);
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message), {
      operationTimeoutMs: 10,
    });
    const request = operation("storage-timeout-01", {
      tool: "create_frame",
      ref: "never-started-frame",
      name: "Must not be created",
      parent: { kind: "page" },
      size: { width: 240, height: 240 },
    });
    const batchId = await run(executor, [request]);
    expect(resultFor(messages, batchId)).toMatchObject({
      success: false,
      results: [{ success: false, error: expect.stringContaining("Tool state read timed out") }],
    });
    expect(mock.find("Must not be created")).toBeUndefined();
  });

  it("requires ref-scoped typed consent for deletion and keeps strict request validation", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const createBatch = await run(executor, [
      operation("delete-root-0001", {
        tool: "create_frame",
        ref: "delete-target",
        name: "Confirmed target",
        parent: { kind: "page" },
        size: { width: 200, height: 200 },
      }),
      operation("delete-other-001", {
        tool: "create_frame",
        ref: "delete-other",
        name: "Different target",
        parent: { kind: "page" },
        size: { width: 100, height: 100 },
      }),
    ]);
    expect(resultFor(messages, createBatch)).toMatchObject({ success: true });
    const unauthorized = await run(executor, [
      operation("delete-denied-001", {
        tool: "delete_node",
        ref: "delete-target",
        consentToken: "x".repeat(40),
      }),
    ]);
    expect(resultFor(messages, unauthorized)).toMatchObject({ success: false });
    expect(mock.find("Confirmed target")).toBeDefined();

    await executor({
      type: "tool-delete-consent",
      protocolVersion: 1,
      requestId: "consent-bad-0001",
      ref: "delete-target",
      confirmation: "delete it",
    });
    expect(messages.at(-1)).toMatchObject({ type: "tool-delete-consent-result", success: false });
    await executor({
      type: "tool-delete-consent",
      protocolVersion: 1,
      requestId: "consent-ok-0001",
      ref: "delete-target",
      confirmation: "DELETE delete-target",
    });
    const consent = messages.at(-1);
    expect(consent).toMatchObject({ type: "tool-delete-consent-result", success: true });
    if (consent?.type !== "tool-delete-consent-result" || !consent.consentToken) return;
    const wrongScope = await run(executor, [
      operation("delete-wrong-001", {
        tool: "delete_node",
        ref: "delete-other",
        consentToken: consent.consentToken,
      }),
    ]);
    expect(resultFor(messages, wrongScope)).toMatchObject({ success: false });
    const remove = await run(executor, [
      operation("delete-allowed-01", {
        tool: "delete_node",
        ref: "delete-target",
        consentToken: consent.consentToken,
      }),
    ]);
    expect(resultFor(messages, remove)).toMatchObject({ success: true });
    expect(mock.find("Confirmed target")).toBeUndefined();
    expect(mock.find("Different target")).toBeDefined();

    expect(
      UIToPluginSchema.safeParse({
        type: "tool-execute",
        protocolVersion: 1,
        batchId: "strict-batch-0001",
        operations: [
          {
            operationId: "strict-op-0001",
            idempotencyKey: "strict-idem-0001",
            action: { tool: "create_frame", frame: { arbitrary: true } },
          },
        ],
        executeJavaScript: "figma.notify('bad')",
      }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({
        type: "tool-execute",
        protocolVersion: 1,
        batchId: "strict-batch-0001",
        operations: [
          {
            operationId: "strict-op-0001",
            idempotencyKey: "strict-idem-0001",
            action: { tool: "delete_node", ref: "delete-target" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
