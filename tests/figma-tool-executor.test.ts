import { describe, expect, it, vi } from "vitest";
import { FigmaToolOperationSchema, FigmaToolBatchSchema, DOCUMENT_DISCOVERY_LIMITS } from "../src/shared/figma-tools";
import {
  UIToPluginSchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../src/shared/messages";
import {
  createFigmaToolExecutor,
  downgradeStoredToolStateForRollback,
} from "../src/plugin/figma-tool-executor";
import { boundsIntersectWithGap, DEFAULT_MIN_CANVAS_GAP } from "../src/plugin/canvas-placement";
import { parseResponsesFunctionCalls } from "../src/shared/chat-tools";
import { utf8Bytes } from "../src/shared/generation-limits";
import { ChatTaskSchema, chatTaskCommittedOperationCount } from "../src/shared/chat-task";
import { handleChatTaskStorage } from "../src/plugin/chat-task-storage";
import { chatTaskInput, runChatTask } from "../src/ui/chat-task";
import { CompanionClientError, type AuthorizedChatTurn } from "../src/ui/companion-client";

import { createMockApi, type MockNode } from "./figma-mock";

function operation(operationId: string, action: unknown, taskId?: string) {
  return FigmaToolOperationSchema.parse({
    operationId,
    idempotencyKey: `idem:${operationId}`,
    ...(taskId ? { taskId } : {}),
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

function legacyToolState(mock: ReturnType<typeof createMockApi>) {
  const entry = [...mock.storage.entries()].find(([key]) => key.includes("fad.figma-tools.v1"));
  if (!entry) throw new Error("Executor did not persist its state.");
  return { key: entry[0], state: downgradeStoredToolStateForRollback(entry[1]) };
}

const TOOL_STATE_STORAGE_KEY = "fad.figma-tools.v1:file-test-56:page_current";

function resultFor(messages: PluginToUIMessage[], batchId: string) {
  return [...messages]
    .reverse()
    .find((message) => message.type === "tool-result" && message.batchId === batchId);
}

function taskNativeRequest(message: unknown) {
  return UIToPluginSchema.parse(message) as Extract<
    UIToPluginMessage,
    { type: "task-native-inspect" | "task-native-focus" }
  >;
}

describe("safe Figma tool executor", () => {
  it("reads only task-owned native hierarchy without changing canvas or plugin data, then validates focus", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const taskId = "chat-task-0001";
    await run(executor, [
      operation(
        "layers-root-create",
        {
          tool: "create_frame",
          ref: "layers-root",
          name: "Task Screen",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
          autoLayout: {
            direction: "vertical",
            gap: 8,
            padding: { top: 16, right: 12, bottom: 16, left: 12 },
          },
        },
        taskId,
      ),
      operation(
        "layers-child-create",
        {
          tool: "create_text",
          ref: "layers-title",
          name: "Screen title",
          parent: { kind: "node", ref: "layers-root" },
          text: "Private generated copy",
          size: { width: 200, height: 32 },
          direction: "LTR",
          horizontalSizing: "FIXED",
          verticalSizing: "FIXED",
        },
        taskId,
      ),
      operation(
        "layers-other-task-create",
        {
          tool: "create_frame",
          ref: "other-task-root",
          name: "Other task screen",
          parent: { kind: "page" },
          size: { width: 400, height: 800 },
        },
        "chat-task-0002",
      ),
    ]);
    const unrelated = mock.api.createRectangle() as unknown as MockNode;
    unrelated.name = "Unrelated document layer";
    const originalSelection = [mock.find("Other task screen")!];
    (mock.api.currentPage as unknown as { selection: MockNode[] }).selection = originalSelection;
    const storageBefore = JSON.stringify([...mock.storage.entries()]);
    const pluginDataBefore = JSON.stringify(
      mock.nodes.map((node) => [node.id, [...node.pluginData.entries()]]),
    );
    await executor(
      taskNativeRequest({
        type: "task-native-inspect",
        requestId: "inspect-task-0001",
        documentId: "file-test-56-page_current",
        taskId,
        refs: ["layers-root", "layers-title", "planned-missing"],
      }),
    );
    const inspected = messages.at(-1);
    expect(inspected).toMatchObject({
      type: "task-native-inspection-result",
      success: true,
      taskId,
      unresolvedRefs: [{ ref: "planned-missing", status: "missing" }],
      truncated: false,
    });
    if (inspected?.type !== "task-native-inspection-result")
      throw new Error("Task native hierarchy response was not sent.");
    expect(inspected.nodes).toHaveLength(2);
    expect(inspected.nodes?.map(({ name }) => name)).toEqual(["Task Screen", "Screen title"]);
    expect(inspected.nodes?.[0]).toMatchObject({
      type: "FRAME",
      width: 390,
      height: 844,
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      padding: { top: 16, right: 12, bottom: 16, left: 12 },
    });
    expect(inspected.nodes?.[1]).toMatchObject({
      parentId: inspected.nodes?.[0]?.id,
      type: "TEXT",
    });
    expect(JSON.stringify(inspected.nodes)).not.toContain("Private generated copy");
    expect(JSON.stringify(inspected.nodes)).not.toContain("Unrelated document layer");
    expect(JSON.stringify(inspected.nodes)).not.toContain("Other task screen");
    expect(JSON.stringify([...mock.storage.entries()])).toBe(storageBefore);
    expect(
      JSON.stringify(mock.nodes.map((node) => [node.id, [...node.pluginData.entries()]])),
    ).toBe(pluginDataBefore);
    expect((mock.api.currentPage as unknown as { selection: MockNode[] }).selection).toEqual(
      originalSelection,
    );

    const taskRoot = mock.find("Task Screen")!;
    await executor(
      taskNativeRequest({
        type: "task-native-focus",
        requestId: "focus-task-0001",
        documentId: "file-test-56-page_current",
        taskId,
        nodeIds: [taskRoot.id],
        mode: "select",
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "task-native-focus-result",
      success: true,
      nodeIds: [taskRoot.id],
    });
    expect((mock.api.currentPage as unknown as { selection: MockNode[] }).selection).toEqual([
      taskRoot,
    ]);
    expect(mock.viewportFocusCalls).toEqual([[taskRoot.id]]);

    await executor(
      taskNativeRequest({
        type: "task-native-focus",
        requestId: "focus-other-task",
        documentId: "file-test-56-page_current",
        taskId,
        nodeIds: [mock.find("Other task screen")!.id],
        mode: "select",
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "task-native-focus-result",
      success: false,
    });
    expect((mock.api.currentPage as unknown as { selection: MockNode[] }).selection).toEqual([
      taskRoot,
    ]);

    await executor(
      taskNativeRequest({
        type: "task-native-focus",
        requestId: "zoom-task-0001",
        documentId: "file-test-56-page_current",
        taskId,
        nodeIds: [taskRoot.id],
        mode: "zoom",
      }),
    );
    expect(mock.viewportFocusCalls).toEqual([[taskRoot.id], [taskRoot.id]]);
    expect((mock.api.currentPage as unknown as { selection: MockNode[] }).selection).toEqual([
      taskRoot,
    ]);
  });

  it.each([12, 100])("progressively discovers and natively inspects %i Charm matches without round trips or mutations", async (frameCount) => {
    const mock = createMockApi();
    const original = mock.api.currentPage;
    const pages = [original, mock.otherPage as unknown as PageNode];
    for (let index = 0; index < frameCount; index++) {
      const frame = mock.api.createFrame() as unknown as MockNode;
      frame.name = "Charm " + pages[index % pages.length]!.id + " screen " + index;
      frame.x = index * 12;
      frame.resize(390, 844);
      if (index % pages.length === 1) mock.otherPage.appendChild(frame);
    }
    mock.page.selection = [mock.nodes[0]!];
    const originalSelection = [...mock.page.selection];
    const snapshot = () => mock.nodes.map((node) => ({
      id: node.id, name: node.name, parent: node.parent?.id,
      x: node.x, y: node.y, width: node.width, height: node.height,
      fills: structuredClone(node.fills), layoutMode: node.layoutMode,
    }));
    const before = snapshot();
    const switchCountBefore = mock.getSetCurrentPageCalls();
    const create = vi.spyOn(mock.api, "createFrame");
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const task = ChatTaskSchema.parse({
      version: 1, id: "readonly-charm-acceptance", documentId: "file-test-56-page_current",
      prompt: "Find and inspect all existing Charm frames without selecting any frame or changing the canvas.",
      context: [], stages: [], ledger: [], pending: [], recent: [], starts: [], rounds: 0,
      status: "ready", text: "",
    });
    let modelRequests = 0;
    await runChatTask(task, {
      signal: new AbortController().signal,
      save: async (checkpoint) => { ChatTaskSchema.parse(checkpoint); },
      progress: () => {},
      model: async () => {
        modelRequests++;
        if (!task.intent)
          return {
            kind: "tool_calls",
            calls: parseResponsesFunctionCalls([{
              type: "function_call", call_id: "readonly_classify_" + frameCount,
              name: "classify_canvas_intent",
              arguments: JSON.stringify({ intent: "inspect", targetName: "Charm" }),
            }]),
            functionCallItems: [], text: "",
          };
        throw new Error("The deterministic native scan must not ask the model for another tool call.");
      },
      execute: async (operations) => {
        expect(operations).toHaveLength(1);
        expect(operations[0]!.action).toMatchObject({ tool: "get_document_context", query: "Charm", readOnlyInspection: true });
        const batchId = await run(executor, operations);
        const result = resultFor(messages, batchId);
        if (result?.type !== "tool-result") throw new Error("Missing native scan result.");
        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(result.committedOperationIds).toEqual([]);
        const data = result.results[0]!.data!;
        expect(data.discovery).toMatchObject({
          matchStatus: "ambiguous",
          matchCount: frameCount,
          framesInspected: frameCount,
          truncated: false,
          complete: true,
          nativeInspection: { complete: true, framesInspected: frameCount, framesExpected: frameCount },
        });
        expect((data.frames as Array<Record<string, unknown>>).length).toBeLessThanOrEqual(8);
        expect(mock.api.currentPage.id).toBe(original.id);
        expect(mock.page.selection).toEqual(originalSelection);
        expect(mock.otherPage.selection).toEqual([]);
        return result;
      },
    });
    expect(task.status).toBe("completed");
    expect(task.rounds).toBe(1);
    expect(modelRequests).toBe(1);
    expect(task.stages).toEqual([]);
    expect(task.inspectionOutcome).toBe("COMPLETED");
    expect(task.inspectionSummary).toMatchObject({
      pagesScanned: 2,
      framesDiscovered: frameCount,
      matchingFrames: frameCount,
      framesInspected: frameCount,
      complete: true,
      canvasMutations: 0,
    });
    expect(chatTaskCommittedOperationCount(task)).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(mock.getSetCurrentPageCalls()).toBe(switchCountBefore);
    expect(task.ledger.filter(({ call }) => call.action.tool === "get_document_context")).toHaveLength(1);
    expect(task.ledger.some(({ call }) => call.action.tool === "inspect_nodes")).toBe(false);
    const savedEvidence = JSON.stringify(chatTaskInput({ ...task, recent: [] }));
    expect(savedEvidence).toContain(before[0]!.name);
    const escapedQuote = String.fromCharCode(92, 34);
    expect(savedEvidence).toContain(escapedQuote + "verified" + escapedQuote + ":true");
    expect(task.text).toContain("Canvas mutations: 0.");
  });

  it("reports an exhaustive progressive no-match scan as complete", async () => {
    const mock = createMockApi();
    for (let index = 0; index < 130; index++) mock.api.createFrame().name = `Unrelated ${index}`;
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batchId = await run(executor, [operation("truncated-readonly-discovery", { tool: "get_document_context", query: "Charm" })]);
    expect(resultFor(messages, batchId)).toMatchObject({
      success: true, committedOperationIds: [],
      results: [{ data: { frames: [], discovery: { matchStatus: "no_match", truncated: false, complete: true, matchCount: 0 } } }],
    });
  });

  it.each([3, 30, 100, 400, 501])("progressively scans all %i pages and finds a match on the last page", async (pageCount) => {
    const mock = createMockApi();
    const pages = [mock.page as unknown as PageNode, mock.otherPage as unknown as PageNode];
    while (pages.length < pageCount) pages.push(mock.addPage("Page " + (pages.length + 1)) as unknown as PageNode);
    const lastPage = pages[pages.length - 1] as unknown as { appendChild(node: MockNode): void };
    const target = mock.api.createFrame() as unknown as MockNode;
    target.name = "Charm Home on the last page";
    target.resize(390, 844);
    lastPage.appendChild(target);
    const selectionNode = mock.api.createRectangle() as unknown as MockNode;
    selectionNode.name = "Keep selection";
    mock.page.selection = [selectionNode];
    const originalSelection = [...mock.page.selection];
    const originalPageId = mock.api.currentPage.id;
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batchId = await run(executor, [operation("scale-pages-" + pageCount, {
      tool: "get_document_context", query: "Charm", readOnlyInspection: true,
    })]);
    const result = resultFor(messages, batchId);
    expect(result?.type).toBe("tool-result");
    if (result?.type !== "tool-result") throw new Error("Missing progressive discovery result.");
    const data = result.results[0]!.data!;
    expect(data.discovery).toMatchObject({
      pagesVisited: pageCount,
      pagesAvailable: pageCount,
      pagesRemaining: 0,
      matchCount: 1,
      framesInspected: 1,
      complete: true,
      truncated: false,
    });
    expect((data.discovery as Record<string, number>).sliceCount).toBeGreaterThanOrEqual(pageCount);
    expect((data.discovery as Record<string, number>).maxNodesPerSliceObserved)
      .toBeLessThanOrEqual(DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice);
    expect(data.frames).toMatchObject([{ nodeId: target.id, pageId: pages[pageCount - 1]!.id, nativeInspected: true }]);
    expect((data.profiling as { transferPayloadBytes: number }).transferPayloadBytes).toBeLessThan(7_500);
    expect(mock.api.currentPage.id).toBe(originalPageId);
    expect(mock.page.selection).toEqual(originalSelection);
    expect(mock.getSetCurrentPageCalls()).toBe(0);
    expect(result.committedOperationIds).toEqual([]);
  }, 30_000);

  it("bounds page listeners and invalidates every cached page through the global fallback", async () => {
    const mock = createMockApi();
    const pages = [mock.page as unknown as PageNode, mock.otherPage as unknown as PageNode];
    while (pages.length < 70) pages.push(mock.addPage("Tracked page " + (pages.length + 1)) as unknown as PageNode);
    const lastPage = pages[69] as unknown as { appendChild(node: MockNode): void };
    const target = mock.api.createFrame() as unknown as MockNode;
    target.name = "Charm last tracked frame";
    lastPage.appendChild(target);
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const read = async (operationId: string) => {
      const batchId = await run(executor, [operation(operationId, {
        tool: "get_document_context", query: "Charm", readOnlyInspection: true,
      })]);
      const result = resultFor(messages, batchId);
      if (result?.type !== "tool-result") throw new Error("Missing bounded-listener discovery result.");
      return result.results[0]!.data!;
    };

    const first = await read("bounded-listener-first");
    expect(first.discovery).toMatchObject({
      pagesVisited: 70,
      complete: true,
      matchCount: 1,
      trackedPageListeners: DOCUMENT_DISCOVERY_LIMITS.pageChangeListeners,
      globalInvalidationFallback: true,
    });
    expect((first.discovery as Record<string, number>).loadedPageCacheEntries)
      .toBeLessThanOrEqual(DOCUMENT_DISCOVERY_LIMITS.pageCacheEntries);

    target.name = "Renamed target";
    mock.emitPageChange(pages[69]!.id);
    const refreshed = await read("bounded-listener-after-change");
    expect(refreshed.discovery).toMatchObject({
      pagesVisited: 70,
      complete: true,
      matchCount: 0,
      invalidatedPages: 70,
      globalInvalidationFallback: true,
    });
    expect(refreshed.frames).toEqual([]);
  }, 30_000);

  it("bounds slices and serialized output on a component-heavy page with thousands of nodes", async () => {
    const mock = createMockApi();
    const frameCount = 1_000;
    for (let index = 0; index < frameCount; index++) {
      const frame = mock.api.createFrame() as unknown as MockNode;
      frame.name = "Charm component " + index;
      for (let childIndex = 0; childIndex < 3; childIndex++) {
        const child = mock.api.createRectangle() as unknown as MockNode;
        child.name = "Layer " + childIndex;
        frame.appendChild(child);
      }
    }
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batchId = await run(executor, [operation("scale-heavy-page", {
      tool: "get_document_context", query: "Charm", readOnlyInspection: true,
    })]);
    const result = resultFor(messages, batchId);
    expect(result?.type).toBe("tool-result");
    if (result?.type !== "tool-result") throw new Error("Missing component-heavy discovery result.");
    const data = result.results[0]!.data!;
    expect(data.discovery).toMatchObject({
      nodesVisited: frameCount * 4,
      framesDiscovered: frameCount,
      matchCount: frameCount,
      framesInspected: frameCount,
      complete: true,
      truncated: false,
      nativeInspection: { complete: true, framesInspected: frameCount, framesExpected: frameCount },
    });
    expect((data.discovery as Record<string, number>).sliceCount).toBeGreaterThan(1);
    expect((data.discovery as Record<string, number>).maxNodesPerSliceObserved)
      .toBeLessThanOrEqual(DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice);
    expect((data.frames as unknown[]).length).toBeLessThanOrEqual(DOCUMENT_DISCOVERY_LIMITS.resultFrames);
    expect((data.profiling as { transferPayloadBytes: number }).transferPayloadBytes).toBeLessThan(7_500);
    expect(result.committedOperationIds).toEqual([]);
  }, 30_000);

  it("pauses at a committed page boundary and resumes from saved discovery evidence", async () => {
    const mock = createMockApi();
    const pages = [mock.page as unknown as PageNode, mock.otherPage as unknown as PageNode];
    while (pages.length < 30) pages.push(mock.addPage("Resume page " + (pages.length + 1)) as unknown as PageNode);
    const target = mock.api.createFrame() as unknown as MockNode;
    target.name = "Charm final screen";
    (pages[29] as unknown as { appendChild(node: MockNode): void }).appendChild(target);
    const messages: PluginToUIMessage[] = [];
    let pauseSent = false;
    const executor = createFigmaToolExecutor(mock.api, (message) => {
      messages.push(message);
      if (message.type === "tool-progress" && !pauseSent && message.message.includes("Progressive discovery")) {
        pauseSent = true;
        void executor({ type: "tool-pause", protocolVersion: 1, batchId: message.batchId });
      }
    });
    const firstBatch = await run(executor, [operation("resume-discovery-pause", {
      tool: "get_document_context", query: "Charm", readOnlyInspection: true,
    })]);
    const paused = resultFor(messages, firstBatch);
    expect(paused?.type).toBe("tool-result");
    if (paused?.type !== "tool-result") throw new Error("Missing paused discovery result.");
    expect(paused.results[0]!.data!.discovery).toMatchObject({
      paused: true,
      complete: false,
      continuationAvailable: true,
      pagesVisited: 10,
      pagesRemaining: 20,
    });

    const resumedBatch = await run(executor, [operation("resume-discovery-continue", {
      tool: "get_document_context", query: "Charm", readOnlyInspection: true,
    })]);
    const resumed = resultFor(messages, resumedBatch);
    expect(resumed?.type).toBe("tool-result");
    if (resumed?.type !== "tool-result") throw new Error("Missing resumed discovery result.");
    expect(resumed.results[0]!.data!.discovery).toMatchObject({
      pagesVisited: 30,
      pagesRemaining: 0,
      matchCount: 1,
      framesInspected: 1,
      complete: true,
      revalidatedAfterRestart: false,
    });
    expect(resumed.committedOperationIds).toEqual([]);
  }, 15_000);

  it("revalidates persisted discovery after executor restart and never reuses a stale match", async () => {
    const mock = createMockApi();
    const frame = mock.api.createFrame() as unknown as MockNode;
    frame.name = "Charm Home";
    const messages: PluginToUIMessage[] = [];
    const read = async (executor: ReturnType<typeof createFigmaToolExecutor>, operationId: string) => {
      const batchId = await run(executor, [operation(operationId, {
        tool: "get_document_context", query: "Charm", readOnlyInspection: true,
      })]);
      const result = resultFor(messages, batchId);
      if (result?.type !== "tool-result") throw new Error("Missing stale-cache validation result.");
      return result.results[0]!.data!;
    };
    const first = await read(createFigmaToolExecutor(mock.api, (message) => messages.push(message)), "stale-cache-before-restart");
    expect(first.discovery).toMatchObject({ complete: true, matchCount: 1, revalidatedAfterRestart: false });
    frame.name = "Renamed Home";

    const afterRestart = await read(
      createFigmaToolExecutor(mock.api, (message) => messages.push(message)),
      "stale-cache-after-restart",
    );
    expect(afterRestart.discovery).toMatchObject({
      complete: true,
      matchCount: 0,
      matchStatus: "no_match",
      revalidatedAfterRestart: true,
    });
    expect(afterRestart.frames).toEqual([]);
  });

  it("evicts only completed discovery cursors within the cache entry budget", async () => {
    const mock = createMockApi();
    mock.storage.set("fad.chat-task.checkpoint.keep", { preserved: true });
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const firstQuery = "absent-cache-query-0";
    let firstCursorKey: string | undefined;
    for (let index = 0; index <= DOCUMENT_DISCOVERY_LIMITS.cacheEntries; index++) {
      const query = index === 0 ? firstQuery : "absent-cache-query-" + index;
      const batchId = await run(executor, [operation("cache-evict-" + index, {
        tool: "get_document_context", query, readOnlyInspection: true,
      })]);
      expect(resultFor(messages, batchId)).toMatchObject({ type: "tool-result", success: true });
      if (index === 0)
        firstCursorKey = [...mock.storage.keys()].find(
          (key) => key.startsWith("fad.document-discovery.v1:") && !key.includes(":index:"),
        );
    }
    const cachedCursorKeys = [...mock.storage.keys()].filter(
      (key) => key.startsWith("fad.document-discovery.v1:") && !key.includes(":index:"),
    );
    expect(cachedCursorKeys).toHaveLength(DOCUMENT_DISCOVERY_LIMITS.cacheEntries);
    expect(firstCursorKey).toBeDefined();
    expect(cachedCursorKeys).not.toContain(firstCursorKey);
    expect(mock.storage.get("fad.chat-task.checkpoint.keep")).toEqual({ preserved: true });
  });

  it("returns honest partial coverage when discovery storage is unavailable", async () => {
    const mock = createMockApi();
    const target = mock.api.createFrame() as unknown as MockNode;
    target.name = "Charm Home";
    const storage = mock.api.clientStorage;
    const originalSetAsync = storage.setAsync.bind(storage);
    storage.setAsync = async (key, value) => {
      if (key.startsWith("fad.document-discovery.v1:")) throw new Error("mock storage quota");
      return originalSetAsync(key, value);
    };
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batchId = await run(executor, [operation("cache-quota-partial", {
      tool: "get_document_context", query: "Charm", readOnlyInspection: true,
    })]);
    const result = resultFor(messages, batchId);
    expect(result).toMatchObject({ type: "tool-result", success: true, committedOperationIds: [] });
    if (result?.type !== "tool-result") throw new Error("Missing quota-limited result.");
    expect(result.results[0]!.data!.discovery).toMatchObject({
      complete: false,
      truncated: true,
      continuationAvailable: false,
      truncationReason: "discovery_checkpoint_unavailable",
      matchCount: 1,
      framesInspected: 1,
    });
  });

  it("reports an inaccessible page as partial and retries it from the saved cursor", async () => {
    const mock = createMockApi();
    const inaccessible = mock.addPage("Temporarily unavailable") as unknown as PageNode & { loadCalls: number };
    let shouldFail = true;
    (inaccessible as unknown as { loadAsync(): Promise<void> }).loadAsync = async () => {
      (inaccessible as unknown as { loadCalls: number }).loadCalls++;
      if (shouldFail) throw new Error("mock access denied");
    };
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const read = async (operationId: string) => {
      const batchId = await run(executor, [operation(operationId, {
        tool: "get_document_context", query: "Charm", readOnlyInspection: true,
      })]);
      const result = resultFor(messages, batchId);
      if (result?.type !== "tool-result") throw new Error("Missing inaccessible-page result.");
      return result.results[0]!.data!;
    };
    const partial = await read("inaccessible-page-first");
    expect(partial.discovery).toMatchObject({
      complete: false,
      truncated: true,
      continuationAvailable: true,
      inaccessiblePages: 1,
      inaccessiblePageSamples: [{ id: inaccessible.id, reason: "page_load_failed" }],
    });
    shouldFail = false;
    const recovered = await read("inaccessible-page-retry");
    expect(recovered.discovery).toMatchObject({
      complete: true,
      truncated: false,
      continuationAvailable: false,
      inaccessiblePages: 0,
      pagesVisited: 3,
      matchStatus: "no_match",
    });
  });

  it("caches bounded discovery across result windows and invalidates on page changes", async () => {
    const mock = createMockApi();
    const frame = mock.api.createFrame() as unknown as MockNode;
    frame.name = "Charm Home";
    frame.resize(390, 844);
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const read = async (operationId: string) => {
      const batchId = await run(executor, [
        operation(operationId, {
          tool: "get_document_context",
          query: "Charm",
          readOnlyInspection: true,
        }),
      ]);
      const result = resultFor(messages, batchId);
      if (result?.type !== "tool-result") throw new Error("Missing tool result.");
      return result.results[0]!.data!;
    };

    const first = await read("cache-first-read");
    const second = await read("cache-second-read");
    expect(first.discovery).toMatchObject({ cacheHit: false, framesDiscovered: 1 });
    expect(second.discovery).toMatchObject({
      cacheHit: true, cacheHits: 1, cacheLookups: 2, cacheHitRate: 0.5, framesDiscovered: 1,
    });
    expect(second.profiling).toMatchObject({
      nativeExecutionMs: expect.any(Number),
      resultSerializationMs: expect.any(Number),
      resultPayloadBytes: expect.any(Number),
      transferPayloadBytes: expect.any(Number),
    });
    expect((second.profiling as { transferPayloadBytes: number }).transferPayloadBytes).toBeLessThan(7_500);

    frame.name = "Charm Home Updated";
    mock.emitPageChange("page:current");
    const refreshed = await read("cache-after-change");
    expect(refreshed.discovery).toMatchObject({ cacheHit: false, framesDiscovered: 1 });
    expect(refreshed.frames).toMatchObject([{ name: "Charm Home Updated" }]);
  });

  it("persists inspection-only refs without tagging canvas nodes or the document root", async () => {
    const mock = createMockApi();
    const originalDocumentId = mock.api.root.getPluginData("fad.document-id");
    const frame = mock.api.createFrame() as unknown as MockNode;
    frame.name = "Charm Home";
    frame.resize(390, 844);
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const discoveryBatch = await run(executor, [
      operation("inspection-only-discovery", {
        tool: "get_document_context",
        query: "Charm",
        readOnlyInspection: true,
      }),
    ]);
    const discovery = resultFor(messages, discoveryBatch);
    if (discovery?.type !== "tool-result") throw new Error("Missing discovery result.");
    const ref = (discovery.results[0]!.data!.frames as Array<{ ref: string }>)[0]!.ref;
    expect(ref).toMatch(/^inspection-/u);
    expect(frame.getPluginData("fad.tool.logical-ref.v1")).toBe("");
    expect(mock.api.root.getPluginData("fad.document-id")).toBe(originalDocumentId);

    const inspect = async (target: ReturnType<typeof createFigmaToolExecutor>, operationId: string) => {
      const batchId = await run(target, [
        operation(operationId, {
          tool: "inspect_nodes",
          pageId: "page:current",
          refs: [ref],
          selection: false,
          readOnlyInspection: true,
        }),
      ]);
      return resultFor(messages, batchId);
    };
    expect(await inspect(executor, "inspection-only-read")).toMatchObject({
      success: true,
      committedOperationIds: [],
      results: [{ data: { pageId: "page:current", nodes: [{ name: "Charm Home" }] } }],
    });
    expect(frame.getPluginData("fad.tool.logical-ref.v1")).toBe("");
    expect(mock.api.root.getPluginData("fad.document-id")).toBe(originalDocumentId);

    const reopened = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    expect(await inspect(reopened, "inspection-only-resume")).toMatchObject({ success: true });
    expect(frame.fills).toEqual([]);
    expect(frame.getPluginData("fad.tool.logical-ref.v1")).toBe("");
    expect(mock.api.root.getPluginData("fad.document-id")).toBe(originalDocumentId);
  });

  it("refuses to use persisted inspection-only refs for mutations", async () => {
    const mock = createMockApi();
    mock.api.root.setPluginData("fad.document-id", "inspection-only-safety-test");
    const frame = mock.api.createFrame() as unknown as MockNode;
    frame.name = "Charm Home";
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const discoveryBatch = await run(executor, [
      operation("inspection-only-safety-discovery", {
        tool: "get_document_context",
        query: "Charm",
        readOnlyInspection: true,
      }),
    ]);
    const discovery = resultFor(messages, discoveryBatch);
    if (discovery?.type !== "tool-result") throw new Error("Missing discovery result.");
    const ref = (discovery.results[0]!.data!.frames as Array<{ ref: string }>)[0]!.ref;
    const editBatch = await run(executor, [
      operation("inspection-only-edit-reject", {
        tool: "set_properties",
        ref,
        properties: { fill: "#000000" },
      }),
    ]);
    expect(resultFor(messages, editBatch)).toMatchObject({
      success: false,
      committedOperationIds: [],
      results: [{ data: { referenceResolution: { code: "inspection_only_reference" } } }],
    });
    expect(frame.fills).toEqual([]);
    expect(frame.getPluginData("fad.tool.logical-ref.v1")).toBe("");
  });

  it("cancels a yielding native discovery and restores the original page", async () => {
    const mock = createMockApi();
    for (let index = 0; index < 250; index++)
      mock.api.createFrame().name = "Frame " + index;
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batchId = "cancel-discovery-test";
    const batch = FigmaToolBatchSchema.parse({
      type: "tool-execute",
      protocolVersion: 1,
      batchId,
      operations: [
        operation("cancel-discovery-op", {
          tool: "get_document_context",
          query: "Frame",
          readOnlyInspection: true,
        }),
      ],
    });
    const running = executor(batch);
    setTimeout(() => {
      void executor({ type: "tool-cancel", protocolVersion: 1, batchId });
    }, 0);
    await running;
    const result = resultFor(messages, batchId);
    expect(result).toMatchObject({ type: "tool-result", success: false, cancelled: true });
    expect(mock.api.currentPage.id).toBe(mock.page.id);
    expect(result?.type === "tool-result" ? result.committedOperationIds : []).toEqual([]);
  });

  it("propagates cancellation during an unresolved page load without loading later pages", async () => {
    const mock = createMockApi();
    const slowPage = mock.addPage("Slow page") as unknown as PageNode & { loadCalls: number };
    const laterPage = mock.addPage("Later page") as unknown as PageNode & { loadCalls: number };
    let loadStartedResolve!: () => void;
    const loadStarted = new Promise<void>((resolve) => { loadStartedResolve = resolve; });
    (slowPage as unknown as { loadAsync(): Promise<void> }).loadAsync = () => {
      loadStartedResolve();
      return new Promise<void>(() => undefined);
    };
    const originalPageId = mock.api.currentPage.id;
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batchId = "cancel-page-load-test";
    const batch = FigmaToolBatchSchema.parse({
      type: "tool-execute", protocolVersion: 1, batchId,
      operations: [operation("cancel-page-load-op", {
        tool: "get_document_context", query: "Charm", readOnlyInspection: true,
      })],
    });
    const running = executor(batch);
    await loadStarted;
    await executor({ type: "tool-cancel", protocolVersion: 1, batchId });
    await running;
    expect(resultFor(messages, batchId)).toMatchObject({ type: "tool-result", success: false, cancelled: true });
    expect((laterPage as unknown as { loadCalls: number }).loadCalls).toBe(0);
    expect(mock.api.currentPage.id).toBe(originalPageId);
  });

  it("discovers an unselected prior-chat frame on another page and edits it after executor reload", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const original = mock.api.currentPage;
    await mock.api.setCurrentPageAsync(mock.otherPage as unknown as PageNode);
    const home = mock.api.createFrame() as unknown as MockNode;
    home.name = "Charm — Home";
    home.resize(390, 844);
    home.setPluginData("fad.tool.task-id.v1", "chat-task-old-0001");
    home.setPluginData("fad.design.task-id.v1", "chat-task-old-0001");
    home.setPluginData("fad.design.chat-id.v1", "chat-history-old-01");
    home.setPluginData("fad.design.name.v1", "Charm");
    const cart = mock.api.createFrame() as unknown as MockNode;
    cart.name = "Charm — Cart";
    cart.resize(390, 844);
    cart.setPluginData("fad.design.task-id.v1", "chat-task-old-0001");
    cart.setPluginData("fad.design.chat-id.v1", "chat-history-old-01");
    cart.setPluginData("fad.design.name.v1", "Charm");
    await mock.api.setCurrentPageAsync(original);
    const originalNodeId = home.id;

    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const discoveryBatch = await run(executor, [
      operation(
        "crosspage-discover-01",
        { tool: "get_document_context", query: "Charm — Home" },
        "chat-task-new-01",
      ),
    ]);
    const discovery = resultFor(messages, discoveryBatch);
    expect(discovery?.type).toBe("tool-result");
    if (discovery?.type !== "tool-result") throw new Error("Document discovery failed.");
    const data = discovery.results[0]?.data;
    expect(data?.discovery).toMatchObject({
      pagesVisited: 2,
      truncated: false,
      query: "Charm — Home",
      matchStatus: "unique",
      matchCount: 1,
    });
    expect(utf8Bytes(JSON.stringify(discovery.results[0]))).toBeLessThan(7_500);
    const target = (data?.frames as Array<Record<string, unknown>>).find(
      (frame) => frame.name === "Charm — Home",
    );
    expect(target).toMatchObject({
      pageId: "page:other",
      pageName: "Other Page",
      projectName: "Charm",
      taskId: "chat-task-old-0001",
      chatId: "chat-history-old-01",
      editable: true,
    });
    expect(typeof target?.ref).toBe("string");
    expect(mock.api.currentPage.id).toBe(original.id);
    expect(mock.page.selection).toEqual([]);

    const ambiguousBatch = await run(executor, [
      operation(
        "crosspage-discover-02",
        { tool: "get_document_context", query: "Charm" },
        "chat-task-new-01",
      ),
    ]);
    expect(resultFor(messages, ambiguousBatch)).toMatchObject({
      type: "tool-result",
      success: true,
      results: [
        {
          data: {
            discovery: { matchStatus: "ambiguous", matchCount: 2 },
            frames: expect.arrayContaining([
              expect.objectContaining({ name: "Charm — Home" }),
              expect.objectContaining({ name: "Charm — Cart" }),
            ]),
          },
        },
      ],
    });
    const missingBatch = await run(executor, [
      operation(
        "crosspage-discover-03",
        { tool: "get_document_context", query: "No Such Design" },
        "chat-task-new-01",
      ),
    ]);
    expect(resultFor(messages, missingBatch)).toMatchObject({
      type: "tool-result",
      success: true,
      results: [{ data: { discovery: { matchStatus: "no_match", matchCount: 0 }, frames: [] } }],
    });

    // A fresh executor has no in-memory ref map; recovery must use persisted plugin/client data.
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const ref = target!.ref as string;
    const taskId = "chat-task-new-01";
    const inspectBatch = await run(executor, [
      operation(
        "crosspage-inspect-01",
        { tool: "inspect_nodes", pageId: "page:other", refs: [ref], depth: 1, maxNodes: 25 },
        taskId,
      ),
    ]);
    expect(resultFor(messages, inspectBatch)).toMatchObject({
      type: "tool-result",
      success: true,
      results: [{ success: true, data: { pageId: "page:other", nodes: [{ ref }] } }],
    });

    const editBatch = await run(executor, [
      operation(
        "crosspage-edit-01",
        { tool: "set_properties", pageId: "page:other", ref, properties: { name: "Charm — Home improved" } },
        taskId,
      ),
    ]);
    expect(resultFor(messages, editBatch)).toMatchObject({
      type: "tool-result",
      success: true,
      committedOperationIds: ["crosspage-edit-01"],
    });
    expect(home.id).toBe(originalNodeId);
    expect(home.name).toBe("Charm — Home improved");
    expect(mock.otherPage.children).toHaveLength(2);
    expect(mock.api.currentPage.id).toBe(original.id);
    expect(mock.page.selection).toEqual([]);
  });

  it("reports stale and deleted task refs and refuses inspection after a page change", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const taskId = "chat-task-0001";
    await run(executor, [
      operation(
        "stale-root-create",
        {
          tool: "create_frame",
          ref: "stale-root",
          name: "Task root",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        },
        taskId,
      ),
      operation(
        "stale-child-create",
        {
          tool: "create_text",
          ref: "stale-child",
          name: "Task child",
          parent: { kind: "node", ref: "stale-root" },
          text: "Layer",
          size: { width: 100, height: 24 },
          direction: "LTR",
          horizontalSizing: "FIXED",
          verticalSizing: "FIXED",
        },
        taskId,
      ),
    ]);
    const child = mock.find("Task child")!;
    const manualParent = mock.api.createFrame() as unknown as MockNode;
    manualParent.name = "Unowned parent";
    manualParent.appendChild(child);
    const missing = mock.find("Task root")!;
    missing.remove();
    await executor(
      taskNativeRequest({
        type: "task-native-inspect",
        requestId: "inspect-stale-refs",
        documentId: "file-test-56-page_current",
        taskId,
        refs: ["stale-root", "stale-child"],
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "task-native-inspection-result",
      success: true,
      unresolvedRefs: [
        { ref: "stale-root", status: "missing" },
        { ref: "stale-child", status: "stale" },
      ],
    });

    mock.switchCurrentPage();
    await executor(
      taskNativeRequest({
        type: "task-native-inspect",
        requestId: "inspect-wrong-page",
        documentId: "file-test-56-page_current",
        taskId,
        refs: [],
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      type: "task-native-inspection-result",
      success: false,
      error: expect.stringContaining("page changed"),
    });
  });

  it("rebuilds a missing task alias only from its unique, confirmed native creation", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const taskId = "chat-recover-0001";
    const created = await run(executor, [
      operation(
        "recover-create-001",
        {
          tool: "create_frame",
          ref: "recover-screen",
          name: "Recovery screen",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
        },
        taskId,
      ),
    ]);
    const createdResult = resultFor(messages, created);
    if (createdResult?.type !== "tool-result") throw new Error("Missing creation result.");
    const canonicalRef = createdResult.results[0]?.logicalRef;
    expect(typeof canonicalRef).toBe("string");
    expect(mock.nodes).toHaveLength(1);

    const saved = mock.storage.get(TOOL_STATE_STORAGE_KEY) as {
      refs: Record<string, unknown>;
      operations: Record<string, unknown>;
      version: number;
    };
    mock.storage.set(TOOL_STATE_STORAGE_KEY, { ...saved, refs: {} });

    const inspected = await run(executor, [
      operation(
        "recover-inspect-001",
        {
          tool: "inspect_nodes",
          refs: ["recover-screen"],
          selection: false,
          depth: 0,
          maxNodes: 1,
        },
        taskId,
      ),
    ]);
    expect(resultFor(messages, inspected)).toMatchObject({
      success: true,
      results: [{ success: true, data: { nodes: [{ ref: canonicalRef }] } }],
    });
    expect(mock.storage.get(TOOL_STATE_STORAGE_KEY)).toMatchObject({
      refs: {
        [canonicalRef as string]: expect.arrayContaining([
          expect.any(String),
          expect.any(String),
          expect.anything(),
          "FRAME",
          expect.any(String),
          taskId,
          "recover-screen",
          "recover-create-001",
        ]),
      },
    });
    expect(mock.nodes).toHaveLength(1);

    const otherTask = await run(executor, [
      operation(
        "recover-other-task",
        {
          tool: "inspect_nodes",
          refs: ["recover-screen"],
          selection: false,
          depth: 0,
          maxNodes: 1,
        },
        "chat-other-0001",
      ),
    ]);
    expect(resultFor(messages, otherTask)).toMatchObject({
      success: false,
      results: [
        {
          success: false,
          data: { referenceResolution: { code: "missing_or_uninspected" } },
        },
      ],
    });
    expect(mock.nodes).toHaveLength(1);
  });

  it.each(["failed", "running"] as const)(
    "re-executes the same read-only inspection ID after a persisted %s state",
    async (priorStatus) => {
      const mock = createMockApi();
      const messages: PluginToUIMessage[] = [];
      const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      const taskId = "chat-inspect-retry-01";
      await run(executor, [
        operation(
          "inspect-retry-create",
          {
            tool: "create_frame",
            ref: "retry-screen",
            name: "Retry screen",
            parent: { kind: "page" },
            size: { width: 390, height: 844 },
          },
          taskId,
        ),
      ]);
      const inspect = operation(
        "inspect-retry-operation",
        {
          tool: "inspect_nodes",
          refs: ["retry-screen"],
          selection: false,
          depth: 0,
          maxNodes: 1,
        },
        taskId,
      );
      vi.spyOn(mock.api, "getNodeByIdAsync").mockRejectedValueOnce(
        new Error("temporary read failure"),
      );
      const failedBatch = await run(executor, [inspect]);
      expect(resultFor(messages, failedBatch)).toMatchObject({
        success: false,
        results: [{ success: false, error: "temporary read failure" }],
      });

      if (priorStatus === "running") {
        const legacy = downgradeStoredToolStateForRollback(
          mock.storage.get(TOOL_STATE_STORAGE_KEY),
        );
        legacy.operations[inspect.operationId]!.status = "running";
        delete legacy.operations[inspect.operationId]!.result;
        mock.storage.set(TOOL_STATE_STORAGE_KEY, legacy);
      }

      const retryBatch = await run(executor, [inspect]);
      expect(resultFor(messages, retryBatch)).toMatchObject({
        success: true,
        results: [{ success: true, acknowledgementStatus: "read_only" }],
      });
      expect(mock.nodes).toHaveLength(1);
    },
  );

  it("re-inspects precise transformed Auto Layout bounds and RTL text through the native mock executor", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("geometry-root-create", {
        tool: "create_frame",
        ref: "geometry-root",
        name: "Geometry root",
        parent: { kind: "page" },
        size: { width: 200.25, height: 100.5 },
        x: 100.25,
        y: 200.5,
        fill: "#FFFFFF",
        clipsContent: true,
        autoLayout: {
          direction: "horizontal",
          gap: 6,
          padding: { top: 10, right: 16, bottom: 10, left: 12 },
        },
      }),
      operation("geometry-rtl-create", {
        tool: "create_text",
        ref: "geometry-rtl-copy",
        name: "Persian copy",
        parent: { kind: "node", ref: "geometry-root" },
        text: "متن فارسی",
        size: { width: 100.5, height: 23.5 },
        direction: "RTL",
        horizontalSizing: "FIXED",
        verticalSizing: "FIXED",
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const textNode = mock.find("Persian copy")!;
    textNode.fills = [
      {
        type: "SOLID",
        color: { r: 0.543138, g: 111 / 255, b: 125 / 255 },
        opacity: 1,
      },
    ];
    const inspected = await run(executor, [
      operation("geometry-rtl-inspect", {
        tool: "inspect_nodes",
        refs: ["geometry-root"],
        selection: false,
        depth: 4,
        maxNodes: 25,
      }),
    ]);
    const result = resultFor(messages, inspected);
    if (result?.type !== "tool-result") throw new Error("Missing native geometry inspection.");
    const roots = result.results[0]?.data?.nodes as Array<Record<string, unknown>>;
    const child = (roots[0]?.children as Array<Record<string, unknown>>)[0];
    expect(roots[0]).toMatchObject({
      x: 100.25,
      y: 200.5,
      width: 200.25,
      height: 100.5,
      bounds: { x: 100.25, y: 200.5, width: 200.25, height: 100.5 },
      layoutMode: "HORIZONTAL",
      padding: { top: 10, right: 16, bottom: 10, left: 12 },
      clipsContent: true,
    });
    expect(child).toMatchObject({
      x: 12,
      y: 10,
      width: 100.5,
      height: 23.5,
      bounds: { x: 112.25, y: 210.5, width: 100.5, height: 23.5 },
      textAlignHorizontal: "RIGHT",
      layoutSizingHorizontal: "FIXED",
      textColor: "#8B6F7D",
      textColorRGB: { r: 0.543138, g: 111 / 255, b: 125 / 255 },
    });
  });

  it("repairs an accidental clipped-child size and verifies the measured native geometry immediately", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let callIndex = 0;
    const turn = (definitions: Array<[string, Record<string, unknown>]>) => {
      const calls = parseResponsesFunctionCalls(
        definitions.map(([name, args]) => ({
          type: "function_call",
          call_id: `clip_repair_call_${String(++callIndex).padStart(4, "0")}`,
          name,
          arguments: JSON.stringify(args),
        })),
      );
      return {
        kind: "tool_calls" as const,
        calls,
        functionCallItems: calls.map((call) => call.functionCall),
        text: "",
      };
    };
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "Minimal",
      audience: "Shoppers",
      content: ["Store"],
      hierarchy: "Clear title and content",
      typography: { family: "Inter", style: "Regular", headingSize: 28, bodySize: 14 },
      spacingScale: [8, 16, 24],
      radiusScale: [12, 16],
      palette: {
        source: "curated-default",
        background: "#FFFFFF",
        surface: "#FFFFFF",
        primary: "#9B3F62",
        accent: "#D4A373",
        text: "#111111",
        muted: "#666666",
      },
      imagePolicy: "labeled-native-fallback",
      interactionPriorities: ["Browse products"],
      readingDirection: "RTL",
    };
    const turns: AuthorizedChatTurn[] = [
      turn([["get_document_context", {}]]),
      turn([
        [
          "plan_canvas_task",
          {
            brief,
            stages: [
              {
                title: "Store shell",
                goal: "Keep the existing clipped layout and verify the correction",
                logicalRefs: ["clip-root", "clip-child"],
                completionCriteria: ["The native child is inside its clipping parent"],
              },
            ],
          },
        ],
      ]),
      turn([
        [
          "create_frame",
          {
            ref: "clip-root",
            name: "Clipping parent",
            parent: { kind: "page" },
            size: { width: 100, height: 100 },
            x: 0,
            y: 0,
            fill: "#FFFFFF",
            clipsContent: true,
          },
        ],
      ]),
      turn([
        [
          "create_rectangle",
          {
            ref: "clip-child",
            name: "Overflowing child",
            parent: { kind: "node", ref: "clip-root" },
            size: { width: 30, height: 20 },
            x: 85,
            y: 10,
            fill: "#9B3F62",
          },
        ],
      ]),
      turn([["complete_canvas_stage", { summary: "Check native clipping" }]]),
      turn([["set_properties", { ref: "clip-child", properties: { width: 15 } }]]),
      turn([["complete_canvas_stage", { summary: "Finish the verified stage" }]]),
      { kind: "done", text: "The child is within the clipping parent." },
    ];
    const nativeActions: string[] = [];
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "clip-repair-task-0001",
      intent: "create",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "Build and verify the clipped shell.",
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
    const dependencies = {
      signal: new AbortController().signal,
      progress: () => {},
      model: async () => {
        const next = turns.shift();
        if (!next) throw new Error("No scripted clipping repair turn remains");
        return next;
      },
      save: async () => {},
      execute: async (operations: ReturnType<typeof operation>[]) => {
        nativeActions.push(...operations.map(({ action }) => action.tool));
        const batchId = `clip-repair-batch-${nativeActions.length}`;
        await executor(
          FigmaToolBatchSchema.parse({
            type: "tool-execute",
            protocolVersion: 1,
            batchId,
            operations,
          }),
        );
        const result = resultFor(messages, batchId);
        if (result?.type !== "tool-result") throw new Error("Missing clipped-child native result");
        return result;
      },
      now: () => Date.now(),
      wait: async () => {},
    };
    await runChatTask(task, dependencies);
    const child = mock.find("Overflowing child")!;
    const childId = child.id;
    const childRef = child.getPluginData("fad.tool.logical-ref.v1");
    expect(task.status).toBe("completed");
    expect(task.stages[0]).toMatchObject({
      verified: true,
      qualityFindings: [],
      repairOperationsAttempted: 1,
      repairOperationsExecuted: 1,
      repairFindingsResolved: 1,
      verificationHistory: [
        { findings: [{ code: "clipped-child", refs: [childRef] }] },
        { findings: [], repairOperationIds: [expect.stringMatching(/op-/u)] },
      ],
    });
    expect(child).toMatchObject({
      id: childId,
      width: 15,
      x: 85,
      parent: mock.find("Clipping parent"),
    });
    expect(mock.nodes).toHaveLength(2);
    const repairIndex = nativeActions.lastIndexOf("set_properties");
    expect(nativeActions[repairIndex + 1]).toBe("inspect_nodes");
  });

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
    const persisted = legacyToolState(mock);
    const secondNode = mock.api.createFrame();
    secondNode.name = "Second candidate";
    secondNode.setPluginData("fad.tool.logical-ref.v1", "task-second-candidate");
    secondNode.setPluginData("fad.tool.task-id.v1", "candidate-task-01");
    secondNode.setPluginData("fad.tool.operation-id.v1", "candidate-store-002");
    secondNode.setPluginData("fad.tool.operation-fingerprint.v1", "a".repeat(32));
    persisted.state.refs["task-second-candidate"] = {
      nodeId: secondNode.id,
      pageId: "page:current",
      parentId: "page:current",
      nodeType: "FRAME",
      creationFingerprint: "a".repeat(32),
      taskId: "candidate-task-01",
      alias: "store",
      creationOperationId: "candidate-store-002",
    };
    persisted.state.operations["candidate-store-002"] = {
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
    mock.storage.set(persisted.key, persisted.state);

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
    const { state } = legacyToolState(mock);
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
    const { state } = legacyToolState(mock);
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
    const { key, state } = legacyToolState(mock);
    state.operations["uncertain-footer1"]!.status = "running";
    const footerRef = Object.keys(state.refs).find((ref) => state.refs[ref]?.alias === "footer")!;
    delete state.refs[footerRef];
    mock.storage.set(key, state);
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
      intent: "create",
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
      expect(batches.every((batch) => batch.length <= 10)).toBe(true);
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

  it("reloads after a seven-mutation timeout and finishes Home and Product without duplicate nodes or touching existing content", async () => {
    const mock = createMockApi();
    const existing = mock.api.createFrame();
    existing.name = "Untouched user content";
    existing.resize(120, 80);
    existing.x = 1_200;
    existing.y = 40;
    const existingBefore = {
      id: existing.id,
      name: existing.name,
      x: existing.x,
      y: existing.y,
      width: existing.width,
      height: existing.height,
    };
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let callNumber = 0;
    const turnFor = (definitions: Array<[string, Record<string, unknown>]>) => {
      const calls = parseResponsesFunctionCalls(
        definitions.map(([name, args]) => ({
          type: "function_call",
          call_id: `timeout_resume_${++callNumber}`,
          name,
          arguments: JSON.stringify(args),
        })),
      );
      return {
        kind: "tool_calls" as const,
        calls,
        functionCallItems: calls.map((call) => call.functionCall),
        text: "",
      };
    };
    const brief = {
      platform: "mobile" as const,
      viewport: { width: 390, height: 844 },
      brandDirection: "فروشگاه مینیمال",
      audience: "خریداران",
      content: ["خانه", "محصولات"],
      hierarchy: "عنوان واضح و محصول قابل ویرایش",
      typography: { family: "Arial", style: "Regular", headingSize: 28, bodySize: 14 },
      spacingScale: [8, 16],
      radiusScale: [8, 16],
      palette: {
        source: "curated-default" as const,
        background: "#FFFFFF",
        surface: "#F8FAFC",
        primary: "#111827",
        accent: "#0F766E",
        text: "#111827",
        muted: "#4B5563",
      },
      imagePolicy: "labeled-native-fallback" as const,
      interactionPriorities: ["خرید"],
      readingDirection: "RTL" as const,
    };
    const homeRefs = [
      "home-screen",
      "home-header",
      "home-title",
      "home-nav",
      "home-card",
      "home-product-name",
      "home-buy-button",
      "home-footer",
      "home-footer-label",
    ];
    const plan = turnFor([
      [
        "plan_canvas_task",
        {
          brief,
          stages: [
            {
              title: "Home",
              goal: "Create an editable Persian RTL Home screen",
              logicalRefs: homeRefs,
              completionCriteria: ["All Home refs are committed and verified"],
            },
            {
              title: "Product",
              goal: "Create an editable Persian RTL Product screen",
              logicalRefs: ["product-screen", "product-title"],
              completionCriteria: ["The Product screen and title are committed"],
            },
          ],
        },
      ],
    ]);
    const firstSeven = turnFor([
      [
        "create_frame",
        {
          ref: "home-screen",
          name: "خانه فروشگاه",
          parent: { kind: "page" },
          size: { width: 390, height: 844 },
          fill: "#FFFFFF",
        },
      ],
      [
        "create_frame",
        {
          ref: "home-header",
          name: "هدر خانه",
          parent: { kind: "node", ref: "home-screen" },
          size: { width: 342, height: 64 },
          fill: "#F8FAFC",
          x: 24,
          y: 24,
          autoLayout: { direction: "horizontal", gap: 8 },
        },
      ],
      [
        "create_text",
        {
          ref: "home-title",
          name: "عنوان خانه",
          parent: { kind: "node", ref: "home-header" },
          text: "خانه فروشگاه",
          size: { width: 180, height: 36 },
          fontSize: 28,
          color: "#111827",
          direction: "RTL",
          align: "RIGHT",
        },
      ],
      [
        "create_text",
        {
          ref: "home-nav",
          name: "ناوبری خانه",
          parent: { kind: "node", ref: "home-screen" },
          text: "محصولات",
          size: { width: 160, height: 32 },
          fontSize: 14,
          color: "#111827",
          direction: "RTL",
          align: "RIGHT",
        },
      ],
      [
        "create_frame",
        {
          ref: "home-card",
          name: "کارت محصول خانه",
          parent: { kind: "node", ref: "home-screen" },
          size: { width: 342, height: 120 },
          fill: "#F8FAFC",
          cornerRadius: 12,
          x: 24,
          y: 120,
          autoLayout: { direction: "vertical", gap: 8 },
        },
      ],
      [
        "create_text",
        {
          ref: "home-product-name",
          name: "نام محصول",
          parent: { kind: "node", ref: "home-card" },
          text: "پیراهن ایرانی",
          size: { width: 320, height: 32 },
          fontSize: 16,
          color: "#111827",
          direction: "RTL",
          align: "RIGHT",
        },
      ],
      [
        "create_frame",
        {
          ref: "home-buy-button",
          name: "دکمه خرید",
          parent: { kind: "node", ref: "home-screen" },
          size: { width: 342, height: 48 },
          fill: "#0F766E",
          cornerRadius: 12,
          x: 24,
          y: 260,
        },
      ],
    ]);
    const timeoutDiagnostic = {
      model: "account-model",
      requestId: "chat-timeout-reload-01",
      requestStartedAtMs: Date.now(),
      requestPhase: "upstream_stream",
      stage: "stream",
      outcome: "timed_out",
      timeoutKind: "idle",
      timeoutSource: "upstream_inactivity",
      terminationReason: "upstream_inactivity",
      elapsedMs: 62_000,
      idleMs: 60_000,
      lastEvent: "response.output_item.done",
      lastEventAtMs: Date.now() - 60_000,
      lastEventAgeMs: 60_000,
    } as const;
    const firstScript: Array<AuthorizedChatTurn | Error> = [
      turnFor([["get_document_context", {}]]),
      plan,
      firstSeven,
      new CompanionClientError("request_timed_out", timeoutDiagnostic),
    ];
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "home-product-timeout-01",
      intent: "create",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "Create a Persian Home and Product experience.",
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
    let saveNumber = 0;
    let modelRequests = 0;
    const batches: ReturnType<typeof operation>[][] = [];
    const dependencies = (script: Array<AuthorizedChatTurn | Error>) => ({
      signal: new AbortController().signal,
      model: async () => {
        modelRequests++;
        const next = script.shift();
        if (!next) throw new Error("No scripted timeout-resume turn remains.");
        if (next instanceof Error) throw next;
        return next;
      },
      save: async (checkpoint: typeof task) => {
        const saved = await handleChatTaskStorage(mock.api, {
          type: "chat-task-save",
          requestId: `timeout-save-${++saveNumber}`,
          documentId: checkpoint.documentId,
          task: checkpoint,
        });
        if (!saved.success) throw new Error(saved.error);
      },
      progress: () => {},
      wait: async () => {},
      execute: async (operations: ReturnType<typeof operation>[]) => {
        batches.push(operations);
        const batchId = await run(executor, operations);
        const result = resultFor(messages, batchId);
        if (!result || result.type !== "tool-result")
          throw new Error("Missing native confirmation.");
        return result;
      },
    });

    await expect(runChatTask(task, dependencies(firstScript))).rejects.toMatchObject({
      category: "request_timed_out",
    });
    expect(modelRequests).toBe(4);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(7);
    expect(chatTaskCommittedOperationCount(task)).toBe(7);
    expect(task.lastRequestDiagnostic).toMatchObject({
      requestId: "chat-timeout-reload-01",
      timeoutSource: "upstream_inactivity",
      terminationReason: "upstream_inactivity",
    });
    const confirmedOperationIds = task.ledger
      .filter((entry) => entry.status === "completed" && entry.category === "mutation")
      .map((entry) => entry.operationId);
    const confirmedNodeIds = mock.nodes.map((node) => node.id);

    const loaded = await handleChatTaskStorage(mock.api, {
      type: "chat-task-load",
      requestId: "timeout-load-01",
    });
    if (!loaded.success || !loaded.task)
      throw new Error("Timed-out task checkpoint was not saved.");
    const restored = ChatTaskSchema.parse(JSON.parse(JSON.stringify(loaded.task)));
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const completion = (summary: string) => turnFor([["complete_canvas_stage", { summary }]]);
    const resumeScript: Array<AuthorizedChatTurn | Error> = [
      turnFor([
        [
          "create_frame",
          {
            ref: "home-footer",
            name: "پاورقی خانه",
            parent: { kind: "node", ref: "home-screen" },
            size: { width: 342, height: 64 },
            fill: "#FFFFFF",
            x: 24,
            y: 330,
          },
        ],
        [
          "create_text",
          {
            ref: "home-footer-label",
            name: "متن پاورقی",
            parent: { kind: "node", ref: "home-footer" },
            text: "درباره فروشگاه",
            size: { width: 320, height: 32 },
            fontSize: 14,
            color: "#111827",
            direction: "RTL",
            align: "RIGHT",
          },
        ],
      ]),
      completion("خانه تأیید شد"),
      turnFor([
        [
          "create_frame",
          {
            ref: "product-screen",
            name: "صفحه محصول",
            parent: { kind: "page" },
            size: { width: 390, height: 844 },
            fill: "#FFFFFF",
            autoLayout: { direction: "vertical", gap: 12 },
          },
        ],
        [
          "create_text",
          {
            ref: "product-title",
            name: "عنوان محصول",
            parent: { kind: "node", ref: "product-screen" },
            text: "جزئیات محصول",
            size: { width: 342, height: 40 },
            fontSize: 24,
            color: "#111827",
            direction: "RTL",
            align: "RIGHT",
          },
        ],
      ]),
      completion("محصول تأیید شد"),
      { kind: "done", text: "خانه و محصول آماده هستند." },
    ];
    await runChatTask(restored, dependencies(resumeScript));

    expect(restored.status).toBe("completed");
    expect(chatTaskCommittedOperationCount(restored)).toBe(11);
    expect(mock.nodes).toHaveLength(12);
    expect(new Set(mock.nodes.map((node) => node.id)).size).toBe(12);
    expect(
      confirmedOperationIds.every((id) =>
        restored.ledger.some((entry) => entry.operationId === id && entry.status === "completed"),
      ),
    ).toBe(true);
    expect(mock.nodes.filter((node) => confirmedNodeIds.includes(node.id))).toHaveLength(8);
    expect(mock.find("خانه فروشگاه")).toMatchObject({ type: "FRAME", width: 390, height: 844 });
    expect(mock.find("عنوان خانه")).toMatchObject({
      type: "TEXT",
      characters: "خانه فروشگاه",
      textAlignHorizontal: "RIGHT",
    });
    expect(mock.find("عنوان محصول")).toMatchObject({
      type: "TEXT",
      characters: "جزئیات محصول",
      textAlignHorizontal: "RIGHT",
    });
    expect(mock.find("هدر خانه")?.layoutMode).toBe("HORIZONTAL");
    expect(mock.find("کارت محصول خانه")?.layoutMode).toBe("VERTICAL");
    expect(mock.find("صفحه محصول")?.layoutMode).toBe("VERTICAL");
    expect({
      id: existing.id,
      name: existing.name,
      x: existing.x,
      y: existing.y,
      width: existing.width,
      height: existing.height,
    }).toEqual(existingBefore);
    expect(mock.nodes.filter((node) => node.name === "خانه فروشگاه")).toHaveLength(1);
    expect(mock.nodes.filter((node) => node.name === "صفحه محصول")).toHaveLength(1);
    expect(confirmedNodeIds).toContain(existing.id);
  });

  it("preserves exactly 22 confirmed native mutations across executor reload and chat Resume", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let callIndex = 0;
    const calls = (definitions: Array<[string, Record<string, unknown>]>) => {
      const parsed = parseResponsesFunctionCalls(
        definitions.map(([name, args]) => ({
          type: "function_call",
          call_id: `twenty_two_call_${String(++callIndex).padStart(4, "0")}`,
          name,
          arguments: JSON.stringify(args),
        })),
      );
      return {
        kind: "tool_calls" as const,
        calls: parsed,
        functionCallItems: parsed.map((call) => call.functionCall),
        text: "",
      };
    };
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "Minimal storefront",
      audience: "Shoppers",
      content: ["Products"],
      hierarchy: "Clear",
      typography: { family: "Inter", style: "Regular", headingSize: 28, bodySize: 14 },
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
    };
    const stageMutations = (start: number, count: number) =>
      Array.from({ length: count }, (_, offset): [string, Record<string, unknown>] => {
        const index = start + offset;
        return [
          "create_frame",
          {
            ref: `item-${String(index).padStart(2, "0")}`,
            name: `Item ${index}`,
            parent: { kind: "page" },
            size: { width: 120, height: 80 },
          },
        ];
      });
    let turns: AuthorizedChatTurn[] = [
      calls([["get_document_context", {}]]),
      calls([
        [
          "plan_canvas_task",
          {
            brief,
            stages: [
              {
                title: "Home",
                goal: "Retain confirmed native layers",
                logicalRefs: ["item-00"],
                completionCriteria: ["The confirmed layer remains editable"],
              },
            ],
          },
        ],
      ]),
      calls(stageMutations(0, 10)),
      calls(stageMutations(10, 10)),
      calls(stageMutations(20, 2)),
    ];
    let controller = new AbortController();
    let confirmedDuringFirstRun = 0;
    let firstRun = true;
    let batchNumber = 0;
    const execute = async (operations: ReturnType<typeof operation>[]) => {
      const batchId = `twenty-two-batch-${++batchNumber}`;
      await executor(
        FigmaToolBatchSchema.parse({
          type: "tool-execute",
          protocolVersion: 1,
          batchId,
          operations,
        }),
      );
      const result = resultFor(messages, batchId);
      if (!result || result.type !== "tool-result") throw new Error("Missing native result");
      if (firstRun && result.committedOperationIds.length)
        confirmedDuringFirstRun += result.committedOperationIds.length;
      if (firstRun && confirmedDuringFirstRun === 22) controller.abort();
      return result;
    };
    const dependencies = () => ({
      signal: controller.signal,
      progress: () => {},
      model: async () => {
        const next = turns.shift();
        if (!next) throw new Error("No scripted 22-mutation continuation remains");
        return next;
      },
      save: async () => {},
      execute,
      now: () => Date.now(),
      wait: async () => {},
    });
    let task = ChatTaskSchema.parse({
      version: 1,
      id: "twenty-two-task-0001",
      intent: "create",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "Create a product list and preserve confirmed layers across Resume.",
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
    await expect(runChatTask(task, dependencies())).rejects.toThrow("Stopped");
    expect(chatTaskCommittedOperationCount(task)).toBe(22);
    expect(mock.nodes).toHaveLength(22);
    const nativeIds = mock.nodes.map(({ id }) => id);
    const operationIds = task.ledger
      .filter(
        ({ status, acknowledgementStatus }) =>
          status === "completed" && acknowledgementStatus === "confirmed_mutation",
      )
      .map(({ operationId }) => operationId);
    task = ChatTaskSchema.parse(JSON.parse(JSON.stringify(task)));
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    controller = new AbortController();
    firstRun = false;
    turns = [
      calls([["complete_canvas_stage", { summary: "Resume the existing Home stage" }]]),
      { kind: "done", text: "Home completed." },
    ];
    await runChatTask(task, dependencies());
    expect(task.status).toBe("completed");
    expect(chatTaskCommittedOperationCount(task)).toBe(22);
    expect(
      task.ledger.filter(({ operationId }) => operationIds.includes(operationId)),
    ).toHaveLength(22);
    expect(nativeIds.every((id) => mock.nodes.some((node) => node.id === id))).toBe(true);
    expect(mock.nodes).toHaveLength(22);
    expect(new Set(mock.nodes.map(({ id }) => id)).size).toBe(22);
  });

  it("resumes 25 committed operations across a 32-mutation segment and completes editable RTL Home and Product screens without duplicates", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let callIndex = 0;
    const callsTurn = (
      definitions: Array<[string, Record<string, unknown>]>,
    ): Extract<AuthorizedChatTurn, { kind: "tool_calls" }> => {
      const calls = parseResponsesFunctionCalls(
        definitions.map(([name, args]) => ({
          type: "function_call",
          call_id: `two_screen_call_${++callIndex}`,
          name,
          arguments: JSON.stringify(args),
        })),
      );
      return {
        kind: "tool_calls",
        calls,
        functionCallItems: calls.map((call) => call.functionCall),
        text: "",
      };
    };
    const frame = (
      ref: string,
      name: string,
      parent: string | undefined,
      width: number,
      height: number,
      direction: "horizontal" | "vertical" = "vertical",
      fill = "#FFFFFF",
    ): [string, Record<string, unknown>] => [
      "create_frame",
      {
        ref,
        name,
        parent: parent ? { kind: "node", ref: parent } : { kind: "page" },
        size: { width, height },
        fill,
        cornerRadius: parent ? 12 : 0,
        autoLayout: { direction, gap: 8 },
      },
    ];
    const text = (
      ref: string,
      name: string,
      parent: string,
      value: string,
      width: number,
      height = 32,
      fontSize = 16,
      color = "#241B20",
    ): [string, Record<string, unknown>] => [
      "create_text",
      {
        ref,
        name,
        parent: { kind: "node", ref: parent },
        text: value,
        size: { width, height },
        color,
        fontSize,
        direction: "RTL",
        align: "RIGHT",
      },
    ];
    const setProperties = (
      ref: string,
      properties: Record<string, unknown>,
    ): [string, Record<string, unknown>] => ["set_properties", { ref, properties }];
    const homeRefs = [
      "home-screen",
      "home-header",
      "home-search",
      "home-categories",
      "home-hero",
      "home-card-a",
      "home-card-b",
      "home-price-a",
      "home-price-b",
      "home-buy-a",
      "home-buy-b",
    ];
    const productRefs = [
      "product-screen",
      "product-gallery",
      "product-title",
      "product-price",
      "product-sizes",
      "product-colors",
      "product-details",
      "product-add",
    ];
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "فروشگاه پوشاک حرفه‌ای و مینیمال",
      audience: "خریداران فارسی‌زبان",
      content: ["خانه", "محصول", "قیمت تومان", "خرید"],
      hierarchy: "عنوان و قیمت برجسته با کنترل‌های واضح",
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
      interactionPriorities: ["خرید", "افزودن به سبد"],
      readingDirection: "RTL",
    };
    const turns: AuthorizedChatTurn[] = [
      callsTurn([["get_document_context", {}]]),
      callsTurn([
        [
          "plan_canvas_task",
          {
            brief,
            stages: [
              {
                title: "Home",
                goal: "ساخت صفحه خانه فروشگاه پوشاک",
                logicalRefs: homeRefs,
                completionCriteria: [
                  "هدر، جست‌وجو، دسته‌بندی، هیرو، دو کارت، قیمت تومان و دکمه خرید به‌صورت RTL و Auto Layout قابل ویرایش باشند",
                ],
              },
              {
                title: "Product",
                goal: "ساخت صفحه جزئیات محصول",
                logicalRefs: productRefs,
                completionCriteria: [
                  "گالری جایگزین، عنوان، قیمت، سایز، رنگ، جزئیات و افزودن به سبد به‌صورت RTL و Auto Layout قابل ویرایش باشند",
                ],
              },
            ],
          },
        ],
      ]),
      callsTurn([
        frame("home-screen", "خانه فروشگاه", undefined, 390, 844, "vertical", "#FBF7F4"),
        frame("home-header", "هدر و ناوبری", "home-screen", 342, 64, "horizontal"),
        text("home-title", "عنوان فروشگاه", "home-header", "پوشاک رایان", 220, 40, 28),
        frame("home-search", "جست‌وجو", "home-screen", 342, 48, "horizontal", "#FFFFFF"),
      ]),
      callsTurn([
        text("home-search-label", "متن جست‌وجو", "home-search", "جست‌وجوی محصول", 300),
        frame("home-categories", "دسته‌بندی‌ها", "home-screen", 342, 56, "horizontal"),
        frame("home-hero", "بنر تبلیغاتی", "home-screen", 342, 128, "vertical", "#D4A373"),
        text("home-hero-title", "عنوان بنر", "home-hero", "استایل تازه پاییز", 310, 40, 24),
        frame("home-card-a", "کارت محصول اول", "home-screen", 342, 104),
        text("home-price-a", "قیمت محصول اول", "home-card-a", "۲٬۴۹۰٬۰۰۰ تومان", 310),
        frame("home-buy-a", "خرید محصول اول", "home-card-a", 310, 48, "horizontal", "#9B3F62"),
        frame("home-card-b", "کارت محصول دوم", "home-screen", 342, 104),
        text("home-price-b", "قیمت محصول دوم", "home-card-b", "۱٬۸۹۰٬۰۰۰ تومان", 310),
        frame("home-buy-b", "خرید محصول دوم", "home-card-b", 310, 48, "horizontal", "#9B3F62"),
      ]),
      callsTurn([
        text("home-nav-label", "ناوبری", "home-header", "خانه | محصولات", 110, 32, 14),
        text("home-category-label", "برچسب دسته‌بندی", "home-categories", "زنانه | مردانه", 300),
        text("home-card-a-title", "نام محصول اول", "home-card-a", "مانتوی لینن", 310),
        text("home-buy-a-label", "متن خرید اول", "home-buy-a", "خرید", 280, 32, 16, "#FFFFFF"),
        text("home-card-b-title", "نام محصول دوم", "home-card-b", "پیراهن نخی", 310),
        text("home-buy-b-label", "متن خرید دوم", "home-buy-b", "خرید", 280, 32, 16, "#FFFFFF"),
      ]),
      callsTurn([
        setProperties("home-screen", { name: "خانه فروشگاه" }),
        setProperties("home-header", { cornerRadius: 12 }),
        setProperties("home-search", { stroke: "#E7D8DF", strokeWeight: 1 }),
        setProperties("home-hero", { cornerRadius: 20 }),
        setProperties("home-categories", { cornerRadius: 12 }),
      ]),
      callsTurn([
        setProperties("home-card-a", { cornerRadius: 16 }),
        setProperties("home-card-b", { cornerRadius: 16 }),
        setProperties("home-price-a", { fontSize: 16 }),
        setProperties("home-price-b", { fontSize: 16 }),
        setProperties("home-buy-a", { cornerRadius: 12 }),
        setProperties("home-buy-b", { cornerRadius: 12 }),
        setProperties("home-title", { fontSize: 28 }),
        setProperties("home-nav-label", { fontSize: 14 }),
        setProperties("home-card-a-title", { fontSize: 16 }),
        setProperties("home-card-b-title", { fontSize: 16 }),
      ]),
      callsTurn([["complete_canvas_stage", { summary: "صفحه خانه کامل است" }]]),
      callsTurn([
        frame("product-screen", "صفحه محصول", undefined, 390, 844, "vertical", "#FBF7F4"),
        frame("product-gallery", "جای تصویر محصول", "product-screen", 342, 260),
        text(
          "product-gallery-label",
          "برچسب جایگزین تصویر",
          "product-gallery",
          "بدون عکس واقعی — جای تصویر قابل ویرایش",
          310,
          48,
        ),
        frame("product-info", "اطلاعات محصول", "product-screen", 342, 152),
        text("product-title", "عنوان محصول", "product-info", "کت لینن زنانه", 310, 40, 28),
        text("product-price", "قیمت محصول", "product-info", "۳٬۲۹۰٬۰۰۰ تومان", 310, 36, 20),
        frame("product-variants", "انتخاب ویژگی", "product-screen", 342, 72, "horizontal"),
        frame("product-sizes", "انتخاب سایز", "product-variants", 150, 48, "horizontal"),
        frame("product-colors", "انتخاب رنگ", "product-variants", 150, 48, "horizontal"),
        text(
          "product-details",
          "جزئیات محصول",
          "product-screen",
          "پارچه لینن سبک، برش آزاد و مناسب استفاده روزمره",
          342,
          72,
        ),
      ]),
      callsTurn([
        frame("product-add", "افزودن به سبد", "product-screen", 342, 52, "horizontal", "#9B3F62"),
        text(
          "product-add-label",
          "متن افزودن",
          "product-add",
          "افزودن به سبد خرید",
          300,
          32,
          16,
          "#FFFFFF",
        ),
        text("product-size-label", "متن سایز", "product-sizes", "سایز: M", 120),
        text("product-color-label", "متن رنگ", "product-colors", "رنگ: کرم", 120),
      ]),
      callsTurn([["complete_canvas_stage", { summary: "صفحه محصول کامل است" }]]),
      { kind: "done", text: "هر دو صفحه کامل شدند." },
    ];
    let task = ChatTaskSchema.parse({
      version: 1,
      id: "two-screen-task-01",
      intent: "create",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "دو صفحه حرفه‌ای فارسی Home و Product برای فروشگاه پوشاک بساز",
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
    let controller = new AbortController();
    let committedBeforeStop = 0;
    let stopAfter25 = true;
    let batch = 0;
    let clock = Date.now();
    const execute = async (operations: ReturnType<typeof operation>[]) => {
      const batchId = `two-screen-batch-${++batch}`;
      await executor(
        FigmaToolBatchSchema.parse({
          type: "tool-execute",
          protocolVersion: 1,
          batchId,
          operations,
        }),
      );
      const result = resultFor(messages, batchId);
      if (!result || result.type !== "tool-result") throw new Error("Missing two-screen result");
      committedBeforeStop += result.committedOperationIds.length;
      if (stopAfter25 && committedBeforeStop === 25) {
        stopAfter25 = false;
        controller.abort();
      }
      return result;
    };
    const dependencies = () => ({
      signal: controller.signal,
      progress: () => {},
      model: async () => {
        const next = turns.shift();
        if (!next) throw new Error("No scripted two-screen turn remains");
        return next;
      },
      save: async () => {},
      execute,
      now: () => clock,
      wait: async (duration: number) => {
        clock += duration;
      },
    });

    await expect(runChatTask(task, dependencies())).rejects.toThrow("Stopped");
    expect(chatTaskCommittedOperationCount(task)).toBe(25);
    expect(task.lifecycle).toBe("EXECUTING_STAGE");
    expect(mock.nodes).toHaveLength(20);
    const firstNodeIds = mock.nodes.map(({ id }) => id);

    task = ChatTaskSchema.parse(JSON.parse(JSON.stringify(task)));
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    controller = new AbortController();
    await runChatTask(task, dependencies());

    expect(task.status).toBe("completed");
    expect(task.lifecycle).toBe("TASK_COMPLETED");
    expect(task.stages.map(({ completed }) => completed)).toEqual([true, true]);
    expect(task.stages[0]).toMatchObject({
      operations: 35,
      segments: [
        { index: 0, mutationCount: 32, confirmedMutations: 32, status: "confirmed" },
        { index: 1, mutationCount: 3, confirmedMutations: 3, status: "confirmed" },
      ],
    });
    expect(firstNodeIds.every((id) => mock.nodes.some((node) => node.id === id))).toBe(true);
    expect(new Set(mock.nodes.map(({ id }) => id)).size).toBe(mock.nodes.length);
    expect(mock.find("خانه فروشگاه")).toMatchObject({
      type: "FRAME",
      width: 390,
      height: 844,
      layoutMode: "VERTICAL",
    });
    expect(mock.find("صفحه محصول")).toMatchObject({
      type: "FRAME",
      width: 390,
      height: 844,
      layoutMode: "VERTICAL",
    });
    expect(mock.find("قیمت محصول اول")).toMatchObject({
      type: "TEXT",
      characters: "۲٬۴۹۰٬۰۰۰ تومان",
      textAlignHorizontal: "RIGHT",
    });
    expect(mock.find("برچسب دسته‌بندی")).toMatchObject({ characters: "زنانه | مردانه" });
    expect(mock.find("متن سایز")).toMatchObject({ characters: "سایز: M" });
    expect(mock.find("متن رنگ")).toMatchObject({ characters: "رنگ: کرم" });
    expect(mock.find("جزئیات محصول")).toBeDefined();
    expect(
      mock.nodes
        .filter((node) => node.type === "TEXT")
        .every((node) => node.textAlignHorizontal === "RIGHT"),
    ).toBe(true);

    const purchaseButton = mock.find("خرید محصول اول")!;
    const purchaseId = purchaseButton.id;
    const purchaseFill = JSON.stringify(purchaseButton.fills);
    const nodeCount = mock.nodes.length;
    const headerFill = JSON.stringify(mock.find("هدر و ناوبری")!.fills);
    const editBatch = await run(executor, [
      {
        ...operation("two-screen-edit-001", {
          tool: "set_properties",
          ref: "home-buy-a",
          properties: { fill: "#EC4899" },
        }),
        taskId: task.id,
      },
    ]);
    expect(resultFor(messages, editBatch)).toMatchObject({ success: true });
    expect(mock.nodes).toHaveLength(nodeCount);
    expect(mock.find("خرید محصول اول")!.id).toBe(purchaseId);
    expect(JSON.stringify(mock.find("خرید محصول اول")!.fills)).not.toBe(purchaseFill);
    expect(JSON.stringify(mock.find("هدر و ناوبری")!.fills)).toBe(headerFill);
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
        results: [
          {
            acknowledgementStatus: "rejected",
            error: expect.stringContaining("64 KiB safety limit"),
          },
          { acknowledgementStatus: "not_attempted" },
        ],
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
    const savedState = legacyToolState(mock).state;
    savedState.operations[uncertainEdit.operationId]!.status = "running";
    delete savedState.operations[uncertainEdit.operationId]!.result;
    mock.storage.set(storageKey, savedState);
    button.name = "Changed after interruption";
    const uncertainReplay = await run(reloaded, [uncertainEdit]);
    expect(resultFor(messages, uncertainReplay)).toMatchObject({
      success: false,
      results: [{ replayed: true, error: expect.stringContaining("interrupted") }],
    });
    expect(button.name).toBe("Changed after interruption");
  });

  it("normalizes text FILL only when the live parent cannot accept native Auto Layout sizing", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const batch = await run(executor, [
      operation("fill-page-text-001", {
        tool: "create_text",
        ref: "fill-page-text",
        name: "Page text",
        parent: { kind: "page" },
        text: "Root content",
        size: { width: 140, height: 28 },
        horizontalSizing: "FILL",
        verticalSizing: "HUG",
      }),
      operation("fill-frame-parent-1", {
        tool: "create_frame",
        ref: "fill-frame-parent",
        name: "Normal frame parent",
        parent: { kind: "page" },
        size: { width: 240, height: 120 },
      }),
      operation("fill-frame-text-01", {
        tool: "create_text",
        ref: "fill-frame-text",
        name: "Text in normal frame",
        parent: { kind: "node", ref: "fill-frame-parent" },
        text: "Stretch to frame width",
        size: { width: 120, height: 28 },
        horizontalSizing: "FILL",
        verticalSizing: "HUG",
      }),
      operation("fill-auto-parent-01", {
        tool: "create_frame",
        ref: "fill-auto-parent",
        name: "Auto Layout parent",
        parent: { kind: "page" },
        size: { width: 240, height: 120 },
        autoLayout: { direction: "vertical" },
      }),
      operation("fill-auto-text-001", {
        tool: "create_text",
        ref: "fill-auto-text",
        name: "Text in Auto Layout",
        parent: { kind: "node", ref: "fill-auto-parent" },
        text: "Native fill is valid",
        size: { width: 120, height: 28 },
        horizontalSizing: "FILL",
        verticalSizing: "HUG",
      }),
    ]);

    expect(resultFor(messages, batch)).toMatchObject({
      success: true,
      results: [
        {
          operationId: "fill-page-text-001",
          data: {
            node: { type: "TEXT" },
            compatibilityNormalizations: [
              {
                toolName: "create_text",
                nodeType: "TEXT",
                fieldPath: "action.horizontalSizing",
                requested: "FILL",
                applied: "FIXED",
                reason: "page_root_uses_explicit_geometry",
                parentType: "PAGE",
                parentLayoutMode: "NONE",
                resolvedDimension: 140,
              },
            ],
          },
        },
        {},
        {
          operationId: "fill-frame-text-01",
          data: {
            compatibilityNormalizations: [
              {
                fieldPath: "action.horizontalSizing",
                reason: "non_auto_layout_parent_uses_content_box",
                parentType: "FRAME",
                parentLayoutMode: "NONE",
                resolvedDimension: 240,
              },
            ],
          },
        },
        {},
        { operationId: "fill-auto-text-001", data: { node: { type: "TEXT" } } },
      ],
    });
    expect(mock.find("Page text")).toMatchObject({
      type: "TEXT",
      width: 140,
      layoutSizingHorizontal: "FIXED",
      parent: mock.page,
    });
    expect(mock.find("Text in normal frame")).toMatchObject({
      type: "TEXT",
      width: 240,
      layoutSizingHorizontal: "FIXED",
      textAutoResize: "HEIGHT",
    });
    expect(mock.find("Text in Auto Layout")).toMatchObject({
      type: "TEXT",
      layoutSizingHorizontal: "FILL",
      parent: mock.find("Auto Layout parent"),
    });
    const statusBatch = await run(executor, [
      operation("fill-frame-text-status", {
        tool: "get_operation_status",
        operationId: "fill-frame-text-01",
      }),
    ]);
    expect(resultFor(messages, statusBatch)).toMatchObject({
      success: true,
      results: [
        {
          data: {
            result: {
              data: {
                compatibilityNormalizations: [
                  {
                    parentType: "FRAME",
                    parentLayoutMode: "NONE",
                    resolvedDimension: 240,
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const component = mock.api.createComponent() as unknown as MockNode;
    component.name = "Component parent";
    component.resize(180, 72);
    mock.page.selection = [component];
    const inspectBatch = await run(executor, [
      operation("fill-component-inspect", {
        tool: "inspect_nodes",
        refs: [],
        selection: true,
        depth: 0,
        maxNodes: 1,
      }),
    ]);
    const inspectResult = resultFor(messages, inspectBatch);
    if (inspectResult?.type !== "tool-result") throw new Error("Missing component inspection.");
    const componentRef = inspectResult.results[0]?.data?.nodes;
    if (!Array.isArray(componentRef) || typeof componentRef[0]?.ref !== "string")
      throw new Error("Component inspection did not return a stable ref.");
    const componentLayout = await run(executor, [
      operation("fill-component-layout", {
        tool: "set_auto_layout",
        ref: componentRef[0].ref,
        layout: { direction: "horizontal" },
      }),
    ]);
    expect(resultFor(messages, componentLayout)).toMatchObject({ success: true });
    const componentTextBatch = await run(executor, [
      operation("fill-component-text", {
        tool: "create_text",
        ref: "fill-component-text",
        name: "Text in component",
        parent: { kind: "node", ref: componentRef[0].ref },
        text: "Component fill",
        size: { width: 100, height: 24 },
        horizontalSizing: "FIXED",
        verticalSizing: "FILL",
      }),
    ]);
    expect(resultFor(messages, componentTextBatch)).toMatchObject({ success: true });
    expect(mock.find("Text in component")).toMatchObject({
      type: "TEXT",
      layoutSizingVertical: "FILL",
      parent: component,
    });

    const detachedParentBatch = await run(executor, [
      operation("fill-detached-parent", {
        tool: "create_frame",
        ref: "fill-detached-parent",
        name: "Detached parent",
        parent: { kind: "page" },
        size: { width: 160, height: 80 },
      }),
    ]);
    expect(resultFor(messages, detachedParentBatch)).toMatchObject({ success: true });
    mock.find("Detached parent")!.remove();
    const activeNodeCount = mock.nodes.filter((node) => !node.removed).length;
    const detachedTextBatch = await run(executor, [
      operation("fill-detached-text", {
        tool: "create_text",
        ref: "fill-detached-text",
        name: "Must not be created",
        parent: { kind: "node", ref: "fill-detached-parent" },
        text: "No stale parent",
        size: { width: 100, height: 24 },
        horizontalSizing: "FILL",
      }),
    ]);
    expect(resultFor(messages, detachedTextBatch)).toMatchObject({
      success: false,
      results: [
        { acknowledgementStatus: "rejected", data: { referenceResolution: { code: "stale" } } },
      ],
    });
    expect(mock.nodes.filter((node) => !node.removed)).toHaveLength(activeNodeCount);
  });

  it("migrates v1 executor state to v3 without losing nodes and supports a reversible v1 export", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("migration-create-001", {
        tool: "create_text",
        ref: "migration-text",
        name: "Migration text",
        parent: { kind: "page" },
        text: "Preserve native node",
        size: { width: 160, height: 28 },
        horizontalSizing: "FILL",
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const nodeId = mock.find("Migration text")?.id;
    expect(nodeId).toBeDefined();

    const entry = [...mock.storage.entries()].find(([key]) => key.includes("fad.figma-tools.v1"));
    if (!entry) throw new Error("Executor did not persist its state.");
    const [storageKey, currentState] = entry;
    expect(currentState).toMatchObject({ version: 3 });
    const legacyState = downgradeStoredToolStateForRollback(currentState);
    expect(legacyState).toMatchObject({ version: 1 });
    expect(legacyState.operations["migration-create-001"]?.result?.data ?? {}).not.toHaveProperty(
      "compatibilityNormalizations",
    );
    mock.storage.set(storageKey, legacyState);

    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const status = await run(executor, [
      operation("migration-status-001", {
        tool: "get_operation_status",
        operationId: "migration-create-001",
      }),
    ]);
    expect(resultFor(messages, status)).toMatchObject({ success: true });
    expect(mock.storage.get(storageKey)).toMatchObject({ version: 3 });
    expect(mock.find("Migration text")?.id).toBe(nodeId);
    expect(mock.nodes.filter((node) => !node.removed)).toHaveLength(1);
  });

  it("migrates a legacy state larger than 256 KiB without losing operation history", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const operations = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => {
        const id = `legacy-migration-${String(index).padStart(4, "0")}`;
        return [
          id,
          {
            operationId: id,
            idempotencyKey: `idem:${id}`,
            fingerprint: "a".repeat(32),
            status: "completed",
            updatedAt: index,
            result: {
              operationId: id,
              success: true,
              replayed: false,
              summary: "s".repeat(280),
              error: "e".repeat(360),
            },
          },
        ];
      }),
    );
    const legacy = { version: 1, refs: {}, operations };
    expect(utf8Bytes(JSON.stringify(legacy))).toBeGreaterThan(256 * 1024);
    mock.storage.set(TOOL_STATE_STORAGE_KEY, legacy);
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));

    const status = await run(executor, [
      operation("legacy-migration-status", {
        tool: "get_operation_status",
        operationId: "legacy-migration-0000",
      }),
    ]);

    expect(resultFor(messages, status)).toMatchObject({ success: true });
    const migrated = mock.storage.get(TOOL_STATE_STORAGE_KEY) as {
      version: number;
      operations: Record<string, unknown>;
    };
    expect(migrated.version).toBe(3);
    expect(migrated.operations["legacy-migration-0000"]).toBeDefined();
    expect(Object.keys(migrated.operations)).toHaveLength(301);
  });

  it("migrates a legacy state over 4 MiB and allows a new design with over 20,000 refs", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const refs = Object.fromEntries(
      Array.from({ length: 20_500 }, (_, index) => [
        `legacy-ref-${index}`,
        {
          nodeId: `node-${index}`,
          pageId: "p".repeat(200),
        },
      ]),
    );
    const legacy = { version: 2, refs, operations: {} };
    expect(utf8Bytes(JSON.stringify(legacy))).toBeGreaterThan(4 * 1024 * 1024);
    mock.storage.set(TOOL_STATE_STORAGE_KEY, legacy);
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));

    const created = await run(executor, [
      operation("legacy-migration-create", {
        tool: "create_frame",
        ref: "new-design-frame",
        name: "New design despite history",
        parent: { kind: "page" },
        size: { width: 240, height: 160 },
      }),
    ]);

    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const migrated = mock.storage.get(TOOL_STATE_STORAGE_KEY) as {
      version: number;
      refs: Record<string, unknown>;
    };
    expect(migrated.version).toBe(3);
    expect(Object.keys(migrated.refs)).toHaveLength(20_501);
    expect(mock.find("New design despite history")).toBeDefined();
  });

  it("loads and saves a v3 state larger than 256 KiB without limiting operation history", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const operations: Record<string, unknown> = {};
    for (let index = 0; index < 400; index++) {
      const id = `reserve-seed-${String(index).padStart(4, "0")}`;
      operations[id] = [
        id,
        `idem:${id}`,
        "a".repeat(32),
        "completed",
        index,
        null,
        null,
        null,
        null,
        [id, true, false, "read_only", null, null, "e".repeat(400), "s".repeat(300)],
      ];
    }
    const saved = { version: 3, refs: {}, operations };
    expect(utf8Bytes(JSON.stringify(saved))).toBeGreaterThan(256 * 1024);
    mock.storage.set(TOOL_STATE_STORAGE_KEY, saved);
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));

    const created = await run(executor, [
      operation("large-state-new-create-01", {
        tool: "create_frame",
        ref: "unlimited-create",
        name: "Created beyond the old state limit",
        parent: { kind: "page" },
        size: { width: 100, height: 80 },
      }),
    ]);

    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const persisted = mock.storage.get(TOOL_STATE_STORAGE_KEY) as {
      version: number;
      refs: Record<string, unknown>;
      operations: Record<string, unknown>;
    };
    expect(persisted.version).toBe(3);
    expect(Object.keys(persisted.refs)).toHaveLength(1);
    expect(Object.keys(persisted.operations)).toHaveLength(401);
    expect(utf8Bytes(JSON.stringify(persisted))).toBeGreaterThan(256 * 1024);
    expect(mock.find("Created beyond the old state limit")).toBeDefined();
  });

  it("preserves the previous state and skips native mutation when Figma rejects a write", async () => {
    const mock = createMockApi();
    const previous = { version: 3, refs: {}, operations: {} };
    const original = JSON.stringify(previous);
    mock.storage.set(TOOL_STATE_STORAGE_KEY, previous);
    (
      mock.api as unknown as {
        clientStorage: { setAsync: (key: string, value: unknown) => Promise<void> };
      }
    ).clientStorage.setAsync = async () => {
      throw new Error("Simulated Figma storage quota failure");
    };
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));

    const failed = await run(executor, [
      operation("storage-reject-create", {
        tool: "create_frame",
        ref: "storage-reject-frame",
        name: "Must not be created",
        parent: { kind: "page" },
        size: { width: 100, height: 80 },
      }),
    ]);

    expect(resultFor(messages, failed)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "not_attempted",
          data: { toolStateDiagnostic: { category: "storage_unavailable", location: "save" } },
        },
      ],
    });
    expect(JSON.stringify(mock.storage.get(TOOL_STATE_STORAGE_KEY))).toBe(original);
    expect(mock.find("Must not be created")).toBeUndefined();
  });

  it("reconciles a failed-ambiguous creation to its original native node without duplicating it", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const api = mock.api as unknown as { commitUndo: () => void };
    const commitUndo = api.commitUndo;
    let loseFirstAcknowledgement = true;
    api.commitUndo = () => {
      if (loseFirstAcknowledgement) {
        loseFirstAcknowledgement = false;
        throw new Error("Simulated post-mutation acknowledgement loss");
      }
      commitUndo();
    };
    const create = operation("ambiguous-create-001", {
      tool: "create_frame",
      ref: "ambiguous-created-frame",
      name: "Original native frame",
      parent: { kind: "page" },
      size: { width: 240, height: 120 },
    });

    const interrupted = await run(executor, [create]);
    const original = mock.find("Original native frame");
    if (!original) throw new Error("The simulated interruption did not leave the native node.");
    expect(resultFor(messages, interrupted)).toMatchObject({
      success: false,
      partialOperationIds: ["ambiguous-create-001"],
      results: [{ acknowledgementStatus: "ambiguous" }],
    });
    const originalId = original.id;

    const resumed = await run(executor, [create]);
    expect(resultFor(messages, resumed)).toMatchObject({
      success: true,
      results: [
        {
          success: true,
          replayed: true,
          acknowledgementStatus: "confirmed_mutation",
          logicalRef: "ambiguous-created-frame",
        },
      ],
    });
    expect(mock.find("Original native frame")?.id).toBe(originalId);
    expect(mock.nodes.filter((node) => !node.removed)).toHaveLength(1);
  });

  it("centralizes incompatible target, parent, property, and local-style rejection before writes", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("compat-target-0001", {
        tool: "create_rectangle",
        ref: "compat-target",
        name: "Compatibility target",
        parent: { kind: "page" },
        size: { width: 100, height: 40 },
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const nodeCount = mock.nodes.filter((node) => !node.removed).length;

    const layoutBatch = await run(executor, [
      operation("compat-layout-bad01", {
        tool: "set_auto_layout",
        ref: "compat-target",
        layout: { direction: "vertical" },
      }),
    ]);
    const propertyBatch = await run(executor, [
      operation("compat-property-bad", {
        tool: "set_properties",
        ref: "compat-target",
        properties: { text: "not editable text" },
      }),
    ]);
    const styleBatch = await run(executor, [
      operation("compat-style-bad-01", {
        tool: "create_rectangle",
        ref: "compat-style-missing",
        name: "Must not be created",
        parent: { kind: "page" },
        size: { width: 20, height: 20 },
        paintStyleId: "missing-local-paint-token",
      }),
    ]);
    const parentBatch = await run(executor, [
      operation("compat-parent-bad01", {
        tool: "create_frame",
        ref: "compat-parented-frame",
        name: "Must not be created",
        parent: { kind: "node", ref: "compat-target" },
        size: { width: 20, height: 20 },
      }),
    ]);
    expect(resultFor(messages, layoutBatch)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "rejected",
          data: { compatibilityFailure: { code: "unsupported_target_type" } },
        },
      ],
    });
    expect(resultFor(messages, propertyBatch)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "rejected",
          data: {
            compatibilityFailure: {
              code: "unsupported_property",
              fieldPath: "action.properties.text",
            },
          },
        },
      ],
    });
    expect(resultFor(messages, styleBatch)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "rejected",
          data: {
            compatibilityFailure: {
              code: "style_not_found",
              fieldPath: "action.paintStyleId",
            },
          },
        },
      ],
    });
    expect(resultFor(messages, parentBatch)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "rejected",
          data: {
            compatibilityFailure: {
              code: "unsupported_parent_type",
              fieldPath: "action.parent",
            },
          },
        },
      ],
    });
    expect(mock.nodes.filter((node) => !node.removed)).toHaveLength(nodeCount);
  });

  it("maps non-layout HUG to editable text auto-resize and rejects incompatible axes without a native mutation", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const hugBatch = await run(executor, [
      operation("text-hug-normalize", {
        tool: "create_text",
        ref: "text-hug",
        name: "Hugging text",
        parent: { kind: "page" },
        text: "Native editable text",
        size: { width: 120, height: 28 },
        horizontalSizing: "HUG",
        verticalSizing: "HUG",
      }),
    ]);
    expect(resultFor(messages, hugBatch)).toMatchObject({
      success: true,
      results: [
        {
          data: {
            compatibilityNormalizations: [
              {
                fieldPath: "action.textAutoResize",
                requested: "HEIGHT",
                applied: "WIDTH_AND_HEIGHT",
                reason: "hug_sizing_uses_native_text_resize",
                parentType: "PAGE",
                parentLayoutMode: "NONE",
              },
            ],
          },
        },
      ],
    });
    expect(mock.find("Hugging text")).toMatchObject({
      type: "TEXT",
      textAutoResize: "WIDTH_AND_HEIGHT",
    });

    const before = mock.nodes.filter((node) => !node.removed).length;
    const incompatible = await run(executor, [
      operation("text-hug-fixed-conflict", {
        tool: "create_text",
        ref: "text-hug-conflict",
        name: "Incompatible sizing",
        parent: { kind: "page" },
        text: "Must not be created",
        size: { width: 120, height: 28 },
        horizontalSizing: "HUG",
        verticalSizing: "FIXED",
      }),
    ]);
    expect(resultFor(messages, incompatible)).toMatchObject({
      success: false,
      committedOperationIds: [],
      results: [
        {
          acknowledgementStatus: "rejected",
          data: {
            compatibilityFailure: {
              code: "text_sizing_requires_auto_layout",
              fieldPath: "action.horizontalSizing",
              nodeType: "TEXT",
              parentType: "PAGE",
              parentLayoutMode: "NONE",
              permittedRemediations: ["establish_auto_layout_before_creation"],
            },
          },
        },
      ],
    });
    expect(mock.nodes.filter((node) => !node.removed)).toHaveLength(before);
  });

  it("runs root-text FILL through the task runner, plugin protocol adapter and native executor", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const turn = (
      name: string,
      args: Record<string, unknown>,
      callId: string,
    ): Extract<AuthorizedChatTurn, { kind: "tool_calls" }> => {
      const calls = parseResponsesFunctionCalls([
        {
          type: "function_call",
          call_id: callId,
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
    const turns: AuthorizedChatTurn[] = [
      turn(
        "create_text",
        {
          ref: "runner-fill-text",
          name: "Runner-created root text",
          parent: { kind: "page" },
          text: "Persian RTL content",
          size: { width: 210, height: 32 },
          direction: "RTL",
          horizontalSizing: "FILL",
          verticalSizing: "HUG",
        },
        "fill_runner_create_0001",
      ),
      turn(
        "complete_canvas_stage",
        { summary: "Required native text is complete." },
        "fill_runner_complete_01",
      ),
      { kind: "done", text: "The requested editable text is ready." },
    ];
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "fill-runner-test-01",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "Create one editable root text node.",
      lifecycle: "EXECUTING_STAGE",
      context: [],
      stages: [
        {
          title: "Editable text",
          goal: "Create the requested native text layer.",
          logicalRefs: ["runner-fill-text"],
          completionCriteria: ["The text layer exists as editable native text."],
          completed: false,
          operations: 0,
          rounds: 0,
        },
      ],
      ledger: [],
      pending: [],
      recent: [],
      starts: [],
      rounds: 0,
      status: "ready",
      text: "",
    });
    let batchNumber = 0;
    await runChatTask(task, {
      signal: new AbortController().signal,
      model: async () => {
        const next = turns.shift();
        if (!next) throw new Error("Missing scripted FILL integration turn.");
        return next;
      },
      save: async () => {},
      progress: () => {},
      execute: async (operations) => {
        const request = UIToPluginSchema.parse({
          type: "tool-execute",
          protocolVersion: 1,
          batchId: `fill-runner-batch-${++batchNumber}`,
          operations,
        });
        if (request.type !== "tool-execute") throw new Error("Invalid adapter request.");
        await executor(request);
        const result = resultFor(messages, request.batchId);
        if (result?.type !== "tool-result") throw new Error("Missing executor acknowledgement.");
        return result;
      },
    });

    expect(task.status).toBe("completed");
    expect(task.lifecycle).toBe("TASK_COMPLETED");
    expect(task.stages[0]?.completed).toBe(true);
    expect(chatTaskCommittedOperationCount(task)).toBe(1);
    expect(mock.find("Runner-created root text")).toMatchObject({
      type: "TEXT",
      width: 210,
      textAlignHorizontal: "RIGHT",
      layoutSizingHorizontal: "FIXED",
      parent: mock.page,
    });
    expect(task.ledger.find((entry) => entry.call.action.tool === "create_text")?.output).toContain(
      "page_root_uses_explicit_geometry",
    );
  });

  it("uses the parent layout mode at native dispatch time after font loading", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const parentBatch = await run(executor, [
      operation("fill-late-parent", {
        tool: "create_frame",
        ref: "fill-late-parent",
        name: "Late Auto Layout parent",
        parent: { kind: "page" },
        size: { width: 220, height: 90 },
      }),
    ]);
    expect(resultFor(messages, parentBatch)).toMatchObject({ success: true });
    const parent = mock.find("Late Auto Layout parent")!;
    const originalLoadFont = mock.api.loadFontAsync.bind(mock.api);
    let changedLayout = false;
    (mock.api as unknown as { loadFontAsync: (font: FontName) => Promise<void> }).loadFontAsync =
      async (font) => {
        if (!changedLayout) {
          changedLayout = true;
          parent.layoutMode = "VERTICAL";
        }
        await originalLoadFont(font);
      };

    const textBatch = await run(executor, [
      operation("fill-late-text", {
        tool: "create_text",
        ref: "fill-late-text",
        name: "Text after parent layout change",
        parent: { kind: "node", ref: "fill-late-parent" },
        text: "Layout changed while font loaded",
        size: { width: 100, height: 24 },
        horizontalSizing: "FILL",
        verticalSizing: "HUG",
      }),
    ]);
    expect(resultFor(messages, textBatch)).toMatchObject({
      success: true,
      results: [
        {
          acknowledgementStatus: "confirmed_mutation",
          data: { node: { type: "TEXT" } },
        },
      ],
    });
    expect(mock.find("Text after parent layout change")).toMatchObject({
      type: "TEXT",
      layoutSizingHorizontal: "FILL",
      parent,
    });
    expect(mock.find("Late Auto Layout parent")?.layoutMode).toBe("VERTICAL");
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

  it("appends a root node, verifies same-parent replays, and preserves native identity", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("parent-root-0001", {
        tool: "create_frame",
        ref: "parent-target",
        name: "Target frame",
        parent: { kind: "page" },
        size: { width: 300, height: 300 },
      }),
      operation("parent-child-0001", {
        tool: "create_text",
        ref: "parent-child",
        name: "Editable label",
        parent: { kind: "page" },
        text: "متن قابل ویرایش",
        size: { width: 180, height: 32 },
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const child = mock.find("Editable label")!;
    const parent = mock.find("Target frame")!;
    const nodeCount = mock.nodes.length;
    const append = operation("append-root-child-01", {
      tool: "append_child",
      childRef: "parent-child",
      parentRef: "parent-target",
    });
    const appended = await run(executor, [append]);
    expect(resultFor(messages, appended)).toMatchObject({
      success: true,
      committedOperationIds: [append.operationId],
      results: [
        {
          acknowledgementStatus: "confirmed_mutation",
          data: {
            parenting: {
              decision: "appended",
              sourceParentCategory: "page_root",
              expectedParentCategory: "frame",
              actualParentCategory: "frame",
            },
          },
        },
      ],
    });
    expect(child.parent).toBe(parent);

    const repeated = await run(executor, [
      operation("append-same-parent-01", {
        tool: "append_child",
        childRef: "parent-child",
        parentRef: "parent-target",
      }),
    ]);
    expect(resultFor(messages, repeated)).toMatchObject({
      success: true,
      committedOperationIds: [],
      results: [
        {
          success: true,
          replayed: true,
          acknowledgementStatus: "verified_idempotent_replay",
          data: { reused: true, parenting: { decision: "already_parented" } },
        },
      ],
    });
    expect(child.parent).toBe(parent);
    expect(child.characters).toBe("متن قابل ویرایش");
    expect(mock.nodes).toHaveLength(nodeCount);
  });

  it("rejects implicit cross-parent appends and requires a fresh explicit reparent after a stale move", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("move-parent-a-001", {
        tool: "create_frame",
        ref: "move-parent-a",
        name: "Parent A",
        parent: { kind: "page" },
        size: { width: 300, height: 300 },
      }),
      operation("move-parent-b-001", {
        tool: "create_frame",
        ref: "move-parent-b",
        name: "Parent B",
        parent: { kind: "page" },
        size: { width: 300, height: 300 },
      }),
      operation("move-child-native1", {
        tool: "create_text",
        ref: "move-child",
        name: "User copy",
        parent: { kind: "node", ref: "move-parent-a" },
        text: "Keep this exact copy",
        size: { width: 180, height: 32 },
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const child = mock.find("User copy")!;
    const parentA = mock.find("Parent A")!;
    const parentB = mock.find("Parent B")!;
    const implicitMove = await run(executor, [
      operation("implicit-move-0001", {
        tool: "append_child",
        childRef: "move-child",
        parentRef: "move-parent-b",
      }),
    ]);
    expect(resultFor(messages, implicitMove)).toMatchObject({
      success: false,
      committedOperationIds: [],
      results: [
        {
          acknowledgementStatus: "rejected",
          data: { parenting: { decision: "rejected_non_root", actualParentCategory: "frame" } },
        },
      ],
    });
    expect(child.parent).toBe(parentA);

    const explicitMove = await run(executor, [
      operation("explicit-move-0001", {
        tool: "reparent_node",
        ref: "move-child",
        parentRef: "move-parent-b",
      }),
    ]);
    expect(resultFor(messages, explicitMove)).toMatchObject({
      success: true,
      committedOperationIds: ["explicit-move-0001"],
      results: [
        {
          acknowledgementStatus: "confirmed_mutation",
          data: { parenting: { decision: "reparented" } },
        },
      ],
    });
    expect(child.parent).toBe(parentB);
    expect(child.characters).toBe("Keep this exact copy");

    parentA.appendChild(child);
    const staleReparent = await run(executor, [
      operation("stale-move-attempt1", {
        tool: "reparent_node",
        ref: "move-child",
        parentRef: "move-parent-b",
      }),
    ]);
    expect(resultFor(messages, staleReparent)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "ambiguous",
          data: { parenting: { decision: "rejected_stale_or_ambiguous" } },
        },
      ],
    });
    expect(child.parent).toBe(parentA);
    const inspected = await run(executor, [
      operation("stale-move-inspect1", {
        tool: "inspect_nodes",
        refs: ["move-child"],
        selection: false,
      }),
    ]);
    expect(resultFor(messages, inspected)).toMatchObject({ success: true });
    const authorizedMove = await run(executor, [
      operation("fresh-move-attempt1", {
        tool: "reparent_node",
        ref: "move-child",
        parentRef: "move-parent-b",
      }),
    ]);
    expect(resultFor(messages, authorizedMove)).toMatchObject({ success: true });
    expect(child.parent).toBe(parentB);
  });

  it("reconciles an append committed before its acknowledgement was saved, after executor reload", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("lost-ack-parent-01", {
        tool: "create_frame",
        ref: "lost-ack-parent",
        name: "Lost acknowledgement parent",
        parent: { kind: "page" },
        size: { width: 300, height: 300 },
      }),
      operation("lost-ack-child-001", {
        tool: "create_rectangle",
        ref: "lost-ack-child",
        name: "Existing native shape",
        parent: { kind: "page" },
        size: { width: 100, height: 80 },
        fill: "#0F766E",
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const child = mock.find("Existing native shape")!;
    const parent = mock.find("Lost acknowledgement parent")!;
    const operationId = "lost-append-ack-01";
    const append = operation(operationId, {
      tool: "append_child",
      childRef: "lost-ack-child",
      parentRef: "lost-ack-parent",
    });
    const clientStorage = mock.api.clientStorage as unknown as {
      setAsync: (key: string, value: unknown) => Promise<void>;
    };
    const save = clientStorage.setAsync.bind(clientStorage);
    let failCompletedSave = true;
    clientStorage.setAsync = async (key, value) => {
      const state = value as { operations?: Record<string, unknown[]> };
      if (
        failCompletedSave &&
        Array.isArray(state.operations?.[operationId]) &&
        state.operations[operationId]![3] === "completed"
      ) {
        failCompletedSave = false;
        throw new Error("Simulated lost acknowledgement checkpoint");
      }
      await save(key, value);
    };
    const interrupted = await run(executor, [append]);
    expect(resultFor(messages, interrupted)).toMatchObject({
      success: false,
      partialOperationIds: [operationId],
      results: [
        {
          acknowledgementStatus: "ambiguous",
          data: { parenting: { decision: "native_error" } },
        },
      ],
    });
    expect(child.parent).toBe(parent);

    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const resumed = await run(executor, [append]);
    expect(resultFor(messages, resumed)).toMatchObject({
      success: true,
      committedOperationIds: [operationId],
      results: [
        {
          replayed: true,
          acknowledgementStatus: "confirmed_mutation",
          data: { parenting: { decision: "reconciled_commit" } },
        },
      ],
    });
    expect(child.parent).toBe(parent);
    expect(mock.nodes).toHaveLength(2);
  });

  it("accounts for mixed partial parenting batches and explicit not-attempted operations", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("mixed-parent-0001", {
        tool: "create_frame",
        ref: "mixed-parent",
        name: "Mixed batch parent",
        parent: { kind: "page" },
        size: { width: 300, height: 300 },
      }),
      operation("mixed-other-00001", {
        tool: "create_frame",
        ref: "mixed-other",
        name: "Other parent",
        parent: { kind: "page" },
        size: { width: 200, height: 200 },
      }),
      operation("mixed-root-child1", {
        tool: "create_rectangle",
        ref: "mixed-root-child",
        name: "Root child",
        parent: { kind: "page" },
        size: { width: 40, height: 40 },
        fill: "#123456",
      }),
      operation("mixed-nested-child1", {
        tool: "create_rectangle",
        ref: "mixed-nested-child",
        name: "Nested child",
        parent: { kind: "node", ref: "mixed-other" },
        size: { width: 40, height: 40 },
        fill: "#654321",
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const rootChild = mock.find("Root child")!;
    const nestedChild = mock.find("Nested child")!;
    const parent = mock.find("Mixed batch parent")!;
    const originalNestedParent = nestedChild.parent;
    const first = operation("mixed-append-root01", {
      tool: "append_child",
      childRef: "mixed-root-child",
      parentRef: "mixed-parent",
    });
    const second = operation("mixed-append-nested1", {
      tool: "append_child",
      childRef: "mixed-nested-child",
      parentRef: "mixed-parent",
    });
    const third = operation("mixed-after-fail01", {
      tool: "set_properties",
      ref: "mixed-parent",
      properties: { name: "Must remain untouched" },
    });
    const batch = await run(executor, [first, second, third]);
    expect(resultFor(messages, batch)).toMatchObject({
      success: false,
      committedOperationIds: [first.operationId],
      partialOperationIds: [],
      results: [
        {
          operationId: first.operationId,
          success: true,
          acknowledgementStatus: "confirmed_mutation",
        },
        { operationId: second.operationId, success: false, acknowledgementStatus: "rejected" },
        { operationId: third.operationId, success: false, acknowledgementStatus: "not_attempted" },
      ],
    });
    expect(rootChild.parent).toBe(parent);
    expect(nestedChild.parent).toBe(originalNestedParent);
    expect(parent.name).toBe("Mixed batch parent");
  });

  it("reports stale and ambiguous logical refs in structured parenting diagnostics", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const created = await run(executor, [
      operation("ambiguous-parent01", {
        tool: "create_frame",
        ref: "ambiguous-parent",
        name: "Parent",
        parent: { kind: "page" },
        size: { width: 200, height: 200 },
      }),
      operation("ambiguous-child001", {
        tool: "create_rectangle",
        ref: "ambiguous-child",
        name: "Child",
        parent: { kind: "page" },
        size: { width: 40, height: 40 },
        fill: "#123456",
      }),
    ]);
    expect(resultFor(messages, created)).toMatchObject({ success: true });
    const child = mock.find("Child")!;
    const duplicate = mock.api.createFrame() as unknown as MockNode;
    duplicate.setPluginData(
      "fad.tool.logical-ref.v1",
      child.getPluginData("fad.tool.logical-ref.v1"),
    );
    const ambiguous = await run(executor, [
      operation("append-ambiguous-01", {
        tool: "append_child",
        childRef: "ambiguous-child",
        parentRef: "ambiguous-parent",
      }),
    ]);
    expect(resultFor(messages, ambiguous)).toMatchObject({
      success: false,
      results: [
        {
          acknowledgementStatus: "rejected",
          data: {
            referenceResolution: { code: "ambiguous" },
            parenting: {
              sourceLogicalRef: "ambiguous-child",
              targetLogicalRef: "ambiguous-parent",
              decision: "rejected_stale_or_ambiguous",
            },
          },
        },
      ],
    });
    expect(child.parent).toBe(mock.page);
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
      results: [
        {
          success: false,
          acknowledgementStatus: "not_attempted",
          data: {
            toolStateDiagnostic: {
              category: "storage_unavailable",
              location: "load",
            },
          },
        },
      ],
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
