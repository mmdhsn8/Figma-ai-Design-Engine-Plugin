import { performance } from "node:perf_hooks";
import { createFigmaToolExecutor } from "../../src/plugin/figma-tool-executor";
import { renderDesignProgramLocal } from "../../src/plugin/design-program-spike";
import { parseDesignProgram } from "../../src/shared/design-program";
import { NativeBatchRequestV1Schema, NATIVE_BATCH_LIMITS, planNativeBatchV1, validateNativeBatchRequest } from "../../src/shared/native-batch";
import { utf8Bytes } from "../../src/shared/generation-limits";
import { createMockApi, type MockNode } from "../figma-mock";
import { designProgramFixtures } from "./design-programs";

type Variant = "gate_off" | "gate_on_planning_only";

function makePrograms() {
  const learning = structuredClone(designProgramFixtures[0] as unknown as Record<string, unknown>);
  const appointment = structuredClone(designProgramFixtures[1] as unknown as Record<string, unknown>);
  const base = structuredClone(designProgramFixtures[0] as unknown as Record<string, unknown>);
  const scenarios = [
    {
      id: "F1",
      program: { ...learning, id: "fw3-f1-persian-learning", screens: (learning.screens as Array<Record<string, unknown>>).map((screen) => ({ ...screen, id: "screen-01", title: "Learning dashboard", order: 0 })) },
    },
    {
      id: "F3",
      program: { ...appointment, id: "fw3-f3-persian-booking", screens: ["جست‌وجوی خدمات", "جزئیات خدمت", "تأیید رزرو"].map((title, index) => {
        const original = structuredClone((appointment.screens as Array<Record<string, unknown>>)[0]!);
        original.id = `screen-${String(index + 1).padStart(2, "0")}`;
        original.title = title;
        original.order = index;
        const root = original.root as { type: string; children?: Array<Record<string, unknown>> };
        if (root.type === "container" && root.children?.[0]?.type === "text") {
          root.children[0].name = title;
          root.children[0].text = title;
        }
        return original;
      }) },
    },
    {
      id: "F10",
      program: { ...base, id: "fw3-f10-persian-building-management", goal: "Coordinate building charges, notices, repairs and shared facilities using illustrative records.", audience: "Residents of a managed apartment building", visualIntent: "Clear Persian RTL residential building-management screens with synthetic records.", screens: [
        "داشبورد", "شارژ و بدهی", "جزئیات پرداخت", "اطلاعیه‌ها", "جزئیات اطلاعیه", "درخواست تعمیر", "پیگیری تعمیر", "رزرو امکانات", "نظرسنجی ساکنان", "پروفایل و تنظیمات",
      ].map((title, index) => {
        const original = structuredClone((base.screens as Array<Record<string, unknown>>)[0]!);
        original.id = `screen-${String(index + 1).padStart(2, "0")}`;
        original.title = title;
        original.purpose = `نمایش بخش ${title} با اطلاعات ساختگی و بدون دادهٔ واقعی ساختمان.`;
        original.order = index;
        const root = original.root as { type: string; children?: Array<Record<string, unknown>> };
        if (root.type === "container" && root.children?.[0]?.type === "text") {
          root.children[0].name = title;
          root.children[0].text = title;
        }
        return original;
      }) },
    },
  ];
  return scenarios as Array<{ id: string; program: Record<string, unknown> }>;
}

function oneScreen(program: Record<string, unknown>, screenId: string): Record<string, unknown> {
  return { ...program, screens: (program.screens as Array<Record<string, unknown>>).filter(({ id }) => id === screenId) };
}

function instrument(mock: ReturnType<typeof createMockApi>) {
  const apiCalls: Record<string, number> = Object.create(null) as Record<string, number>;
  let nativeNodeMethodCalls = 0;
  let nativeMutationMethodCalls = 0;
  let storageCalls = 0;
  const storageCallsByName: Record<string, number> = Object.create(null) as Record<string, number>;
  const wrapMethods = (target: Record<string, unknown>, category: "api" | "node" | "storage") => {
    for (const key of Object.keys(target)) {
      const value = target[key];
      if (typeof value !== "function") continue;
      const original = value as (...args: unknown[]) => unknown;
      target[key] = (...args: unknown[]) => {
        if (category === "api") apiCalls[key] = (apiCalls[key] ?? 0) + 1;
        else if (category === "node") {
          nativeNodeMethodCalls++;
          if (["appendChild", "resize", "remove", "setPluginData", "setFillStyleIdAsync", "setTextStyleIdAsync"].includes(key)) nativeMutationMethodCalls++;
        } else {
          storageCalls++;
          storageCallsByName[key] = (storageCallsByName[key] ?? 0) + 1;
        }
        const result = original(...args);
        if (category === "api" && result && typeof result === "object" && "id" in result)
          wrapMethods(result as Record<string, unknown>, "node");
        return result;
      };
    }
  };
  const api = mock.api as unknown as Record<string, unknown>;
  for (const key of Object.keys(api)) {
    const value = api[key];
    if (key === "clientStorage" && value && typeof value === "object") wrapMethods(value as Record<string, unknown>, "storage");
    else if (key === "currentPage" && value && typeof value === "object") wrapMethods(value as Record<string, unknown>, "api");
    else if (key === "variables" && value && typeof value === "object") wrapMethods(value as Record<string, unknown>, "api");
    else if (typeof value === "function") {
      const original = value as (...args: unknown[]) => unknown;
      api[key] = (...args: unknown[]) => {
        apiCalls[key] = (apiCalls[key] ?? 0) + 1;
        const result = original(...args);
        if (result && typeof result === "object" && "id" in result)
          wrapMethods(result as Record<string, unknown>, "node");
        return result;
      };
    }
  }
  return {
    get apiFunctionCalls() { return Object.values(apiCalls).reduce((sum, count) => sum + count, 0); },
    get apiCallsByName() { return { ...apiCalls }; },
    get nativeNodeMethodCalls() { return nativeNodeMethodCalls; },
    get nativeMutationMethodCalls() { return nativeMutationMethodCalls; },
    get storageCalls() { return storageCalls; },
    get storageCallsByName() { return { ...storageCallsByName }; },
  };
}

function countTree(root: MockNode): number {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    count++;
    pending.push(...node.children);
  }
  return count;
}

async function runScenario(scenario: { id: string; program: Record<string, unknown> }, variant: Variant) {
  const screenIds = (scenario.program.screens as Array<{ id: string }>).map(({ id }) => id);
  const taskId = variant === "gate_off" ? "fw3-bench-off-0001" : "fw3-bench-on-0001";
  const mock = createMockApi();
  const documentId = `${mock.api.fileKey ?? mock.api.root.id}-page_current`;
  const counters = instrument(mock);
  const pluginMessages: Array<Record<string, unknown>> = [];
  const executor = createFigmaToolExecutor(mock.api, (message) => pluginMessages.push(message as unknown as Record<string, unknown>));
  const receipt = new Map<string, string>();
  const roots: Array<{ screenId: string; nodeId: string; nodeCount: number }> = [];
  const renderPayloadBytes: number[] = [];
  const readbackPayloadBytes: number[] = [];
  const candidatePayloadBytes: number[] = [];
  const candidateOperationCounts: number[] = [];
  const stages: string[] = [];
  let renderDispatches = 0;
  let readbackDispatches = 0;
  let renderAcknowledgements = 0;
  let readbackAcknowledgements = 0;
  let nativeReadbacks = 0;
  let createdNodes = 0;
  let attachedNodes = 0;
  let plannedCreations = 0;
  let planningMs = 0;
  let renderMs = 0;
  let readbackMs = 0;
  const errors = 0;
  const skippedOperations = 0;
  let recoveryAttempts = 0;
  let peakInFlightWrites = 0;
  let inFlightWrites = 0;
  let replayStable = true;

  for (const screenId of screenIds) {
    const program = oneScreen(scenario.program, screenId);
    const parsed = parseDesignProgram(program);
    if (!parsed.success) throw new Error(`invalid benchmark fixture ${scenario.id}/${screenId}`);
    const beforeNodeIds = new Set(mock.nodes.map(({ id }) => id));
    const requestId = `${taskId}_render_${screenId}_1`;
    const renderWire = { type: "design-program-render", requestId, taskId, documentId, program };
    renderPayloadBytes.push(utf8Bytes(JSON.stringify(renderWire)));
    stages.push("checkpoint-program-saved", "checkpoint-rendering", "render-dispatched");
    renderDispatches++;
    inFlightWrites++;
    peakInFlightWrites = Math.max(peakInFlightWrites, inFlightWrites);
    const renderStarted = performance.now();
    const rendered = await renderDesignProgramLocal(mock.api, program, {
      taskId, documentId, pageId: "page:current", executor, requestId,
      expectedRootNodeId: receipt.get(screenId),
      rootReceipt: { read: () => receipt.get(screenId) ?? "", write: (nodeId) => receipt.set(screenId, nodeId) },
      lookupNode: (nodeId) => mock.api.getNodeByIdAsync(nodeId),
    });
    renderMs += performance.now() - renderStarted;
    inFlightWrites--;
    if (!rendered.success) throw new Error(`renderer failed ${scenario.id}/${screenId}: ${JSON.stringify(rendered)}`);
    renderAcknowledgements++;
    stages.push("root-attached", "children-built", "geometry-readback", "executor-adoption", "render-acknowledged", "checkpoint-rendered");
    const rootResult = rendered.roots[0]!;
    const root = mock.nodes.find(({ id }) => id === rootResult.nodeId);
    if (!root || root.parent?.id !== "page:current") throw new Error(`missing attached native root ${scenario.id}/${screenId}`);
    const createdForScreen = mock.nodes.filter(({ id }) => !beforeNodeIds.has(id));
    createdNodes += createdForScreen.length;
    attachedNodes += countTree(root);
    roots.push({ screenId, nodeId: root.id, nodeCount: countTree(root) });

    if (variant === "gate_on_planning_only") {
      const planningStarted = performance.now();
      const candidate = planNativeBatchV1(program, {
        taskId, screenId, checkpointFingerprint: parsed.fingerprint, batchId: requestId,
        requestedPageId: "page:current", authorizedRootId: root.id,
      }, true);
      planningMs += performance.now() - planningStarted;
      if (!candidate.success) throw new Error(`candidate planner rejected ${scenario.id}/${screenId}: ${candidate.code}`);
      const owner = root.getPluginData("fad.tool.task-id.v1") || root.getPluginData("fad.design.program.task-id.v1");
      const admission = validateNativeBatchRequest(candidate.request, {
        taskId, screenId, checkpointFingerprint: parsed.fingerprint, batchId: requestId, taskState: "active",
        currentPageId: "page:current",
        root: { nodeId: root.id, taskId: owner || taskId, pageId: "page:current", parentId: root.parent.id, attached: true },
      });
      if (!admission.success) throw new Error(`candidate admission failed ${scenario.id}/${screenId}: ${admission.code}`);
      if (!NativeBatchRequestV1Schema.safeParse(candidate.request).success) throw new Error("candidate did not pass strict request schema");
      candidatePayloadBytes.push(admission.serializedBytes);
      candidateOperationCounts.push(candidate.request.operations.length);
      plannedCreations += candidate.creationCount;
      stages.push("candidate-plan-accepted", "existing-renderer-retained");
    }

    const inspectRequest = {
      type: "task-native-inspect" as const,
      requestId: `${taskId}_inspect_${screenId}_1`,
      documentId,
      taskId,
      refs: [rootResult.ref],
      geometry: { programFingerprint: parsed.fingerprint, requireReceipt: true, expectedRootNodeId: root.id },
    };
    readbackPayloadBytes.push(utf8Bytes(JSON.stringify(inspectRequest)));
    readbackDispatches++;
    const readbackStarted = performance.now();
    await executor(inspectRequest);
    readbackMs += performance.now() - readbackStarted;
    nativeReadbacks++;
    const response = pluginMessages.at(-1);
    if (response?.type !== "task-native-inspection-result" || response.success !== true) throw new Error(`native readback failed ${scenario.id}/${screenId}`);
    readbackAcknowledgements++;
    stages.push("task-readback-dispatched", "readback-confirmed", "checkpoint-verified");
  }

  const nodeCountBeforeReplay = mock.nodes.length;
  for (const screenId of screenIds) {
    const program = oneScreen(scenario.program, screenId);
    const rootId = receipt.get(screenId);
    const replay = await renderDesignProgramLocal(mock.api, program, {
      taskId, documentId, pageId: "page:current", executor, expectedRootNodeId: rootId,
      rootReceipt: { read: () => receipt.get(screenId) ?? "", write: (nodeId) => receipt.set(screenId, nodeId) },
      lookupNode: (nodeId) => mock.api.getNodeByIdAsync(nodeId),
    });
    replayStable &&= replay.success && replay.success && replay.roots[0]?.nodeId === rootId;
  }
  const duplicateRoots = mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id")).length !== screenIds.length;
  const treeNodesAddedOnReplay = mock.nodes.length - nodeCountBeforeReplay;
  replayStable &&= treeNodesAddedOnReplay === 0 && !duplicateRoots;
  if (!replayStable) recoveryAttempts++;

  return {
    variant,
    evidence: "LOCAL_FAKE_FIGMA_RUNTIME",
    screenCount: screenIds.length,
    sourceModeledRenderDispatches: renderDispatches,
    sourceModeledReadbackDispatches: readbackDispatches,
    bridgeMessagesObserved: null,
    renderBridgeAcknowledgements: renderAcknowledgements,
    readbackBridgeAcknowledgements: readbackAcknowledgements,
    nativeReadbacks,
    checkpointOperations: null,
    sourceKnownCheckpointWritesAfterSavedProgram: screenIds.length * 3,
    figmaApiFunctionCalls: counters.apiFunctionCalls,
    figmaApiCallsByName: counters.apiCallsByName,
    nativeNodeMethodCalls: counters.nativeNodeMethodCalls,
    nativeMutationMethodCalls: counters.nativeMutationMethodCalls,
    pluginClientStorageCalls: counters.storageCalls,
    pluginClientStorageCallsByMethod: counters.storageCallsByName,
    treeNodesCreated: createdNodes,
    treeNodesAddedOnReplay,
    treeNodesAttached: attachedNodes,
    orderedMutationStages: stages,
    localHarnessMs: Math.round((renderMs + readbackMs + planningMs) * 1000) / 1000,
    renderAdapterMs: Math.round(renderMs * 1000) / 1000,
    readbackAdapterMs: Math.round(readbackMs * 1000) / 1000,
    candidatePlanningMs: Math.round(planningMs * 1000) / 1000,
    renderPayloadBytes: renderPayloadBytes.reduce((sum, value) => sum + value, 0),
    readbackPayloadBytes: readbackPayloadBytes.reduce((sum, value) => sum + value, 0),
    candidatePayloadBytes: candidatePayloadBytes.reduce((sum, value) => sum + value, 0),
    candidateOperationCounts,
    candidateCreationCount: plannedCreations,
    maxInFlightNativeWrites: peakInFlightWrites,
    errors,
    skippedOperations,
    recoveryAttempts,
    rootNodeIds: roots.map(({ nodeId }) => nodeId),
    perScreenNodeCounts: roots.map(({ screenId, nodeCount }) => ({ screenId, nodeCount })),
    replayStableRootIds: replayStable,
    batchTimeoutLimitMs: NATIVE_BATCH_LIMITS.timeoutMs,
  };
}

export async function runFw3NativeBatchBenchmark() {
  const scenarios = makePrograms();
  const results = [];
  for (const scenario of scenarios) {
    const off = await runScenario(scenario, "gate_off");
    const on = await runScenario(scenario, "gate_on_planning_only");
    if (JSON.stringify(off.rootNodeIds) !== JSON.stringify(on.rootNodeIds) ||
      JSON.stringify(off.perScreenNodeCounts) !== JSON.stringify(on.perScreenNodeCounts) ||
      off.treeNodesCreated !== on.treeNodesCreated || off.errors !== on.errors || off.replayStableRootIds !== on.replayStableRootIds)
      throw new Error(`Gate output parity failed for ${scenario.id}.`);
    results.push({ fixtureId: scenario.id, fixtureProgramId: scenario.program.id, gateOff: off, gateOn: on });
  }
  return {
    schemaVersion: 1,
    benchmark: "FW-3 current renderer vs gated planning-only adapter",
    generatedAt: new Date().toISOString(),
    instrumentation: {
      bridgeMessagesObserved: false,
      uiPluginDispatches: "source-modeled call-site counts; the UI window bridge is not instantiated",
      checkpointOperations: "not measured; the UI Universal task owner is not instantiated",
      pluginClientStorage: "counted by getAsync/setAsync; these are executor adoption storage calls, not task checkpoint writes",
      figmaApiFunctions: "top-level API, current-page and variables method calls; direct property assignments are excluded",
      nativeNodeMethods: "own methods on nodes returned by the fake API",
      countedNativeMutationMethods: ["appendChild", "resize", "remove", "setPluginData", "setFillStyleIdAsync", "setTextStyleIdAsync"],
      limitations: ["no Figma Desktop API", "no true bridge postMessage", "no UI task checkpoint owner", "no screenshot or visual perception", "one local in-process sample per variant"],
    },
    runtime: "local fake Figma API; no Desktop, provider, model, network, or document write",
    timingMeaning: "local harness wall time only; not Figma Desktop or user-perceived latency",
    checkpointMeaning: "checkpointOperations is null because this plugin-only harness does not run the UI task owner; sourceKnownCheckpointWritesAfterSavedProgram counts the existing rendering, rendered, and verified saves visible in universal-design-task.ts",
    apiOperationMeaning: "Figma API function calls plus separately counted node methods; direct property assignments are not counted as function calls",
    candidateMeaning: "gate on only serializes and validates a typed plan, then retains the same renderer; no batch mutation is dispatched",
    results,
  };
}
