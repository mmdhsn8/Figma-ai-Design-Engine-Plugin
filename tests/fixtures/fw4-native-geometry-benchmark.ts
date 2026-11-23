import { performance } from "node:perf_hooks";
import { createFigmaToolExecutor } from "../../src/plugin/figma-tool-executor";
import { inspectProgramGeometry } from "../../src/plugin/design-program-geometry";
import { parseDesignProgram, type DesignProgramV1 } from "../../src/shared/design-program";
import { projectNativeLayoutExpectations } from "../../src/shared/fw4-geometry";
import { utf8Bytes } from "../../src/shared/generation-limits";
import { PluginToUISchema, UIToPluginSchema, type UIToPluginMessage } from "../../src/shared/messages";
import { createMockApi, type MockNode } from "../figma-mock";
import { designProgramFixtures } from "./design-programs";
import { renderDesignProgramLocal } from "../../src/plugin/design-program-spike";

type Scenario = { id: "F1" | "F3" | "F10"; program: DesignProgramV1 };

function makeScenarios(): Scenario[] {
  const learning = structuredClone(designProgramFixtures[0] as unknown as DesignProgramV1);
  const booking = structuredClone(designProgramFixtures[1] as unknown as DesignProgramV1);
  const buildingTitles = ["داشبورد", "شارژ و بدهی", "جزئیات پرداخت", "اطلاعیه‌ها", "جزئیات اطلاعیه", "درخواست تعمیر", "پیگیری تعمیر", "رزرو امکانات", "نظرسنجی ساکنان", "پروفایل و تنظیمات"];
  const buildScreens = (source: DesignProgramV1, titles: string[]): DesignProgramV1 => ({
    ...structuredClone(source),
    screens: titles.map((title, index) => {
      const original = structuredClone(source.screens[0]!);
      original.id = `screen-${String(index + 1).padStart(2, "0")}`;
      original.title = title;
      original.order = index;
      if (original.root.type === "container") {
        const firstText = original.root.children.find((node) => node.type === "text");
        if (firstText?.type === "text") {
          firstText.name = title;
          firstText.text = title;
          firstText.width.mode = "fill";
        }
      }
      return original;
    }),
  });
  return [
    { id: "F1", program: buildScreens(learning, ["Learning dashboard"]) },
    { id: "F3", program: buildScreens(booking, ["جست‌وجوی خدمات", "جزئیات خدمت", "تأیید رزرو"]) },
    { id: "F10", program: { ...buildScreens(learning, buildingTitles), id: "fw4-persian-building-management" } },
  ];
}

function instrument(mock: ReturnType<typeof createMockApi>) {
  const apiCalls: Record<string, number> = Object.create(null) as Record<string, number>;
  let nodeMethodCalls = 0;
  let mutationMethodCalls = 0;
  let layoutPropertyWrites = 0;
  const seen = new WeakSet<object>();
  const wrapNode = (node: Record<string, unknown>) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") {
        const original = value as (...args: unknown[]) => unknown;
        node[key] = function (this: unknown, ...args: unknown[]) {
          nodeMethodCalls++;
          if (["appendChild", "resize", "remove", "setPluginData", "setFillStyleIdAsync", "setTextStyleIdAsync"].includes(key))
            mutationMethodCalls++;
          return original.apply(this, args);
        };
      }
    }
    for (const key of ["layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow", "primaryAxisSizingMode", "counterAxisSizingMode", "textAutoResize"]) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor?.configurable) continue;
      let value = descriptor.get ? descriptor.get.call(node) : node[key];
      Object.defineProperty(node, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => descriptor.get ? descriptor.get.call(node) : value,
        set: (next: unknown) => {
          layoutPropertyWrites++;
          if (descriptor.set) descriptor.set.call(node, next);
          else value = next;
        },
      });
    }
  };
  const wrap = (target: Record<string, unknown>, category: "api" | "storage") => {
    for (const key of Object.keys(target)) {
      const value = target[key];
      if (typeof value !== "function") continue;
      const original = value as (...args: unknown[]) => unknown;
      target[key] = function (this: unknown, ...args: unknown[]) {
        if (category === "api") apiCalls[key] = (apiCalls[key] ?? 0) + 1;
        const result = original.apply(this, args);
        if (category === "api" && result && typeof result === "object" && "id" in result)
          wrapNode(result as Record<string, unknown>);
        return result;
      };
    }
  };
  const api = mock.api as unknown as Record<string, unknown>;
  for (const key of Object.keys(api)) {
    const value = api[key];
    if (key === "clientStorage" && value && typeof value === "object") wrap(value as Record<string, unknown>, "storage");
    else if (key === "currentPage" && value && typeof value === "object") wrap(value as Record<string, unknown>, "api");
    else if (key === "variables" && value && typeof value === "object") wrap(value as Record<string, unknown>, "api");
    else if (typeof value === "function") {
      const original = value as (...args: unknown[]) => unknown;
      api[key] = function (this: unknown, ...args: unknown[]) {
        apiCalls[key] = (apiCalls[key] ?? 0) + 1;
        const result = original.apply(this, args);
        if (result && typeof result === "object" && "id" in result) wrapNode(result as Record<string, unknown>);
        return result;
      };
    }
  }
  return {
    apiCalls,
    get apiFunctionCalls() { return Object.values(apiCalls).reduce((sum, count) => sum + count, 0); },
    get nodeMethodCalls() { return nodeMethodCalls; },
    get mutationMethodCalls() { return mutationMethodCalls; },
    get layoutPropertyWrites() { return layoutPropertyWrites; },
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

function oneScreen(program: DesignProgramV1, screenId: string): DesignProgramV1 {
  return { ...program, screens: program.screens.filter(({ id }) => id === screenId) };
}

async function runScenario(scenario: Scenario, injectAppendReflow: boolean) {
  const taskId = `fw4-${scenario.id.toLowerCase()}-local-task`;
  const mock = createMockApi({ resetSiblingSizingOnAppend: injectAppendReflow });
  const documentId = `${mock.api.fileKey ?? "file-test"}-page_current`;
  const counters = instrument(mock);
  const pluginMessages: Array<Record<string, unknown>> = [];
  const executor = createFigmaToolExecutor(mock.api, (message) => pluginMessages.push(message as unknown as Record<string, unknown>));
  const rootIds = new Map<string, string>();
  const rendererDispatches = { request: 0, return: 0 };
  const readbackDispatches = { request: 0, acknowledgement: 0 };
  const stages: string[] = [];
  const roots: Array<{ screenId: string; nodeId: string; attachedNodes: number; createdNodes: number }> = [];
  const findingsBefore: Record<string, number> = Object.create(null) as Record<string, number>;
  const findingsAfter: Record<string, number> = Object.create(null) as Record<string, number>;
  let localHarnessMs = 0;
  let geometryReadbacks = 0;
  let geometryRepairs = 0;
  let renderBytes = 0;
  let readbackBytes = 0;
  let expectedReadbackBytes = 0;
  let peakInFlightWrites = 0;
  let inFlightWrites = 0;
  let replayAddedNodes = 0;
  let replayStable = true;

  for (const savedScreen of scenario.program.screens) {
    const program = oneScreen(scenario.program, savedScreen.id);
    const parsed = parseDesignProgram(program);
    if (!parsed.success) throw new Error(`invalid local fixture ${scenario.id}/${savedScreen.id}`);
    const beforeIds = new Set(mock.nodes.map(({ id }) => id));
    const requestId = `${taskId}_render_${savedScreen.id}_1`;
    renderBytes += utf8Bytes(JSON.stringify({ type: "design-program-render", requestId, taskId, documentId, program }));
    rendererDispatches.request++;
    inFlightWrites++;
    peakInFlightWrites = Math.max(peakInFlightWrites, inFlightWrites);
    stages.push("program-loaded-from-synthetic-fixture", "render-request");
    const started = performance.now();
    const result = await renderDesignProgramLocal(mock.api, program, {
      taskId,
      documentId,
      pageId: "page:current",
      executor,
      requestId,
      expectedRootNodeId: rootIds.get(savedScreen.id),
      rootReceipt: { read: () => rootIds.get(savedScreen.id) ?? "", write: (nodeId) => rootIds.set(savedScreen.id, nodeId) },
      lookupNode: (nodeId) => mock.api.getNodeByIdAsync(nodeId),
    });
    localHarnessMs += performance.now() - started;
    inFlightWrites--;
    rendererDispatches.return++;
    if (!result.success) {
      throw new Error(`renderer failed ${scenario.id}/${savedScreen.id}: ${JSON.stringify(result)}`);
    }
    geometryReadbacks += result.geometryReadbacks;
    geometryRepairs += result.geometryRepairs;
    stages.push("native-root-created-or-reused", "renderer-readback", "adoption-ack");
    const rootResult = result.roots[0]!;
    const root = mock.nodes.find(({ id }) => id === rootResult.nodeId);
    if (!root || root.parent?.id !== "page:current") throw new Error(`root missing ${scenario.id}/${savedScreen.id}`);
    const createdNodes = mock.nodes.filter(({ id }) => !beforeIds.has(id)).length;
    roots.push({ screenId: savedScreen.id, nodeId: root.id, attachedNodes: countTree(root), createdNodes });
    rootIds.set(savedScreen.id, root.id);

    const expectedLayout = projectNativeLayoutExpectations(program, savedScreen.id);
    const readbackRequest = {
      type: "task-native-inspect" as const,
      requestId: `${taskId}_inspect_${savedScreen.id}_1`,
      documentId,
      taskId,
      refs: [rootResult.ref],
      geometry: {
        programFingerprint: parsed.fingerprint,
        requireReceipt: true,
        expectedRootNodeId: root.id,
        ...(process.env.VITE_FW4_GEOMETRY === "fw4-geometry-v1" ? { expectedLayout } : {}),
      },
    };
    const parsedRequest = UIToPluginSchema.parse(readbackRequest) as Extract<UIToPluginMessage, { type: "task-native-inspect" }>;
    const serializedReadback = JSON.stringify(parsedRequest);
    readbackBytes += utf8Bytes(serializedReadback);
    expectedReadbackBytes += utf8Bytes(JSON.stringify({ ...readbackRequest, geometry: { ...readbackRequest.geometry, expectedLayout } }));
    readbackDispatches.request++;
    const beforeReadback = pluginMessages.length;
    await executor(parsedRequest);
    readbackDispatches.acknowledgement += pluginMessages.length > beforeReadback ? 1 : 0;
    stages.push("task-native-readback-request", "native-readback-ack");
    const response = PluginToUISchema.parse(pluginMessages.at(-1));
    if (response.type !== "task-native-inspection-result" || response.success !== true)
      throw new Error(`native readback failed ${scenario.id}/${savedScreen.id}`);
    if (response.geometry && Array.isArray(response.geometry.findings)) {
      for (const { code } of response.geometry.findings as Array<{ code: string }>) findingsAfter[code] = (findingsAfter[code] ?? 0) + 1;
    }
    const observed = inspectProgramGeometry(root as unknown as FrameNode, {
      taskId,
      pageId: "page:current",
      expectedLayout,
    });
    for (const { code } of observed.findings) findingsBefore[code] = (findingsBefore[code] ?? 0) + 1;
    geometryReadbacks++;

    const nodeCountBeforeReplay = mock.nodes.length;
    const replay = await renderDesignProgramLocal(mock.api, program, {
      taskId,
      documentId,
      pageId: "page:current",
      executor,
      expectedRootNodeId: root.id,
      rootReceipt: { read: () => rootIds.get(savedScreen.id) ?? "", write: (nodeId) => rootIds.set(savedScreen.id, nodeId) },
      lookupNode: (nodeId) => mock.api.getNodeByIdAsync(nodeId),
    });
    replayStable &&= replay.success && replay.roots[0]?.nodeId === root.id;
    replayAddedNodes += mock.nodes.length - nodeCountBeforeReplay;
    geometryReadbacks += replay.success ? replay.geometryReadbacks : 0;
  }

  return {
    scenario: scenario.id,
    screenCount: scenario.program.screens.length,
    injectedFault: injectAppendReflow ? "mock-resets-previous-sibling-sizing-on-append" : null,
    path: process.env.VITE_FW4_GEOMETRY === "fw4-geometry-v1" ? "gate_on" : "gate_off",
    evidence: "LOCAL_FAKE_FIGMA_RUNTIME",
    measurements: {
      uiToPluginDispatches: null,
      directProductionRendererInvocations: rendererDispatches,
      bridgeAcknowledgements: null,
      rendererReturnAcknowledgements: rendererDispatches.return,
      nativeReadbackRequests: readbackDispatches.request,
      nativeReadbackAcknowledgements: readbackDispatches.acknowledgement,
      geometryReadbacks,
      geometryRepairs,
      figmaApiFunctionCalls: counters.apiCalls,
      figmaApiFunctionCallTotal: counters.apiFunctionCalls,
      nativeNodeMethodCalls: counters.nodeMethodCalls,
      nativeMutationMethodCalls: counters.mutationMethodCalls,
      layoutPropertyWrites: counters.layoutPropertyWrites,
      attachedNodes: roots.reduce((sum, root) => sum + root.attachedNodes, 0),
      createdNodes: roots.reduce((sum, root) => sum + root.createdNodes, 0),
      nativeRootIds: roots.map(({ screenId, nodeId }) => ({ screenId, nodeId })),
      findingsFromPostRunLayoutProbe: findingsBefore,
      findingsFromTaskNativeReadback: findingsAfter,
      errors: 0,
      skips: 0,
      rendererReplayAttempts: roots.length,
      rendererReplayStable: replayStable && replayAddedNodes === 0,
      replayAddedNodes,
      peakInFlightWrites,
      renderPayloadBytes: renderBytes,
      taskReadbackPayloadBytes: readbackBytes,
      taskReadbackPayloadBytesWithExpectations: expectedReadbackBytes,
      localHarnessMs,
      checkpoints: "The UI ChatTask checkpoint owner is not invoked by this plugin-side local harness.",
    },
    roots,
    stageOrder: stages,
    limitations: [
      "Direct calls to renderDesignProgramLocal are counted; actual UI bridge messages and bridge acknowledgements are not observed.",
      "Figma API calls are observed through the repository fake runtime, not Figma Desktop.",
      "The append-reflow fault is deterministic fault injection, not evidence that Desktop Figma exhibits this exact reset.",
      "Elapsed time is local JavaScript harness time only; it is not Desktop rendering latency or user-perceived speed.",
      "The post-run probe counts sizing findings only and does not replace full visual QA or screenshot inspection.",
    ],
  };
}

export async function runFw4NativeGeometryBenchmark() {
  const results = [];
  for (const scenario of makeScenarios()) {
    results.push(await runScenario(scenario, false));
    results.push(await runScenario(scenario, true));
  }
  return {
    schemaVersion: 1,
    runAt: new Date().toISOString(),
    featureGate: { variable: "VITE_FW4_GEOMETRY", enabledValue: "fw4-geometry-v1", default: "off" },
    runtime: "mock",
    scenarios: results,
  };
}
