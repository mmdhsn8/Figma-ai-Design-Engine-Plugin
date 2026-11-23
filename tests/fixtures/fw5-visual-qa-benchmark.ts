import { performance } from "node:perf_hooks";
import { createFigmaToolExecutor } from "../../src/plugin/figma-tool-executor";
import { renderDesignProgramLocal } from "../../src/plugin/design-program-spike";
import { parseDesignProgram, type DesignProgramV1 } from "../../src/shared/design-program";
import { FW5_VISUAL_CAPTURE_LIMITS } from "../../src/shared/fw5-visual-qa";
import { utf8Bytes } from "../../src/shared/generation-limits";
import { PluginToUISchema, UIToPluginSchema, type UIToPluginMessage } from "../../src/shared/messages";
import { createMockApi, type MockNode } from "../figma-mock";
import { designProgramFixtures } from "./design-programs";
import { ONE_PIXEL_PNG } from "../visual-fixtures";

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
    { id: "F10", program: { ...buildScreens(learning, buildingTitles), id: "fw5-persian-building-management" } },
  ];
}

function instrumentApi(mock: ReturnType<typeof createMockApi>) {
  const apiCalls: Record<string, number> = Object.create(null) as Record<string, number>;
  let nodeMethodCalls = 0;
  const seen = new WeakSet<object>();
  const wrapNode = (node: Record<string, unknown>) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value !== "function") continue;
      const original = value as (...args: unknown[]) => unknown;
      node[key] = function (this: unknown, ...args: unknown[]) {
        nodeMethodCalls++;
        return original.apply(this, args);
      };
    }
  };
  const api = mock.api as unknown as Record<string, unknown>;
  for (const key of Object.keys(api)) {
    const value = api[key];
    if (key === "currentPage" && value && typeof value === "object") {
      for (const method of Object.keys(value)) {
        const member = (value as Record<string, unknown>)[method];
        if (typeof member !== "function") continue;
        const original = member as (...args: unknown[]) => unknown;
        (value as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
          apiCalls[`currentPage.${method}`] = (apiCalls[`currentPage.${method}`] ?? 0) + 1;
          return original.apply(this, args);
        };
      }
    }
    if (typeof value !== "function") continue;
    const original = value as (...args: unknown[]) => unknown;
    api[key] = function (this: unknown, ...args: unknown[]) {
      apiCalls[key] = (apiCalls[key] ?? 0) + 1;
      const result = original.apply(this, args);
      if (result && typeof result === "object" && "id" in result) wrapNode(result as Record<string, unknown>);
      return result;
    };
  }
  return {
    apiCalls,
    get apiCallTotal() { return Object.values(apiCalls).reduce((sum, value) => sum + value, 0); },
    get nodeMethodCalls() { return nodeMethodCalls; },
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

async function runScenario(scenario: Scenario) {
  const gateOn = process.env.VITE_FW5_VISUAL_QA === "fw5-visual-qa-v1";
  const taskId = `fw5-bench-${scenario.id.toLowerCase()}-${gateOn ? "on" : "off"}`;
  const documentId = "file-test-56-page_current";
  const pngBytes = new Uint8Array(Buffer.from(ONE_PIXEL_PNG, "base64"));
  const mock = createMockApi({ simulateFill: true, exportBytes: pngBytes });
  const counters = instrumentApi(mock);
  const outbound: Array<Record<string, unknown>> = [];
  const rawExecutor = createFigmaToolExecutor(mock.api, (message) => outbound.push(message as unknown as Record<string, unknown>));
  let uiToPluginDispatches = 0;
  let pluginAcknowledgements = 0;
  let rendererInvocations = 0;
  let nativeReadbackRequests = 0;
  let captureRequests = 0;
  let requestBytes = 0;
  let responsePngBytes = 0;
  let readbackResponseBytes = 0;
  let captureReceiptMetadataBytes = 0;
  let localHarnessMs = 0;
  let peakInFlightOperations = 0;
  let inFlightOperations = 0;
  const roots: Array<{ screenId: string; nodeId: string; parentId: string | null; nodeCount: number }> = [];
  const captures: Array<{ screenId: string; receiptId: string; rootId: string; pageId: string; readbackRevision: string; width: number; height: number; bytes: number; exportScale: number; status: string }> = [];
  const stageOrder: string[] = [];

  for (const savedScreen of scenario.program.screens) {
    const program = oneScreen(scenario.program, savedScreen.id);
    const parsed = parseDesignProgram(program);
    if (!parsed.success) throw new Error(`Invalid fixture ${scenario.id}/${savedScreen.id}`);
    const requestId = `${taskId}_render_${savedScreen.id}_1`;
    rendererInvocations++;
    stageOrder.push(`${savedScreen.id}:render`);
    inFlightOperations++;
    peakInFlightOperations = Math.max(peakInFlightOperations, inFlightOperations);
    const started = performance.now();
    const rendered = await renderDesignProgramLocal(mock.api, program, {
      taskId,
      documentId,
      pageId: "page:current",
      executor: rawExecutor,
      requestId,
      lookupNode: (nodeId) => mock.api.getNodeByIdAsync(nodeId),
    });
    localHarnessMs += performance.now() - started;
    inFlightOperations--;
    if (!rendered.success) throw new Error(`Renderer failed: ${JSON.stringify(rendered)}`);
    const rootResult = rendered.roots[0]!;
    const root = mock.nodes.find(({ id }) => id === rootResult.nodeId);
    if (!root || root.parent?.id !== "page:current") throw new Error(`Root missing or detached for ${savedScreen.id}`);
    roots.push({ screenId: savedScreen.id, nodeId: root.id, parentId: root.parent?.id ?? null, nodeCount: countTree(root) });
    stageOrder.push(`${savedScreen.id}:native-root-attached`);

    const inspectRequest = UIToPluginSchema.parse({
      type: "task-native-inspect",
      requestId: `${taskId}_inspect_${savedScreen.id}_1`,
      taskId,
      documentId,
      refs: [rootResult.ref],
      geometry: { programFingerprint: parsed.fingerprint, requireReceipt: true, expectedRootNodeId: root.id },
    }) as Extract<UIToPluginMessage, { type: "task-native-inspect" }>;
    requestBytes += utf8Bytes(JSON.stringify(inspectRequest));
    uiToPluginDispatches++;
    nativeReadbackRequests++;
    const beforeInspect = outbound.length;
    await rawExecutor(inspectRequest);
    pluginAcknowledgements += outbound.length > beforeInspect ? 1 : 0;
    const inspection = PluginToUISchema.parse(outbound.at(-1));
    if (inspection.type !== "task-native-inspection-result" || !inspection.success || !inspection.geometry?.receipt || (gateOn && inspection.nativePageId !== "page:current"))
      throw new Error(`Readback failed for ${savedScreen.id}`);
    readbackResponseBytes += utf8Bytes(JSON.stringify(inspection));
    stageOrder.push(`${savedScreen.id}:native-readback-confirmed`);

    if (gateOn) {
      const captureRequest = UIToPluginSchema.parse({
        type: "task-native-visual-capture",
        requestId: `${taskId}_capture_${savedScreen.id}_1`,
        rootRef: rootResult.ref,
        visualCapture: {
          version: 1,
          taskId,
          screenId: savedScreen.id,
          authorizedDocumentScope: { documentId, pageId: inspection.nativePageId, rootId: root.id },
          pageId: inspection.nativePageId,
          rootId: root.id,
          programFingerprint: parsed.fingerprint,
          readbackRevision: inspection.geometry.receipt,
          maxPixelWidth: FW5_VISUAL_CAPTURE_LIMITS.maxPixelWidth,
          maxPixelHeight: FW5_VISUAL_CAPTURE_LIMITS.maxPixelHeight,
          maxBytes: FW5_VISUAL_CAPTURE_LIMITS.maxBytes,
          deadlineAtMs: Date.now() + FW5_VISUAL_CAPTURE_LIMITS.timeoutMs,
          captureNonce: `${taskId}_capture_${savedScreen.id}_1`,
        },
      }) as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
      requestBytes += utf8Bytes(JSON.stringify(captureRequest));
      uiToPluginDispatches++;
      captureRequests++;
      const beforeCapture = outbound.length;
      await rawExecutor(captureRequest);
      pluginAcknowledgements += outbound.length > beforeCapture ? 1 : 0;
      const capture = PluginToUISchema.parse(outbound.at(-1));
      if (capture.type !== "task-native-visual-capture-result" || !capture.success || capture.visualCapture?.receipt.rootId !== root.id)
        throw new Error(`PNG export failed for ${savedScreen.id}`);
      responsePngBytes += capture.visualCapture.pngBytes.byteLength;
      const receipt = capture.visualCapture.receipt;
      captureReceiptMetadataBytes += utf8Bytes(JSON.stringify({ ...capture, visualCapture: { receipt } }));
      captures.push({ screenId: savedScreen.id, receiptId: receipt.receiptId, rootId: receipt.rootId, pageId: receipt.pageId,
        readbackRevision: receipt.readbackRevision, width: receipt.width, height: receipt.height, bytes: receipt.byteLength,
        exportScale: receipt.exportScale, status: receipt.status });
      stageOrder.push(`${savedScreen.id}:png-exported`);
    }
  }

  return {
    scenario: scenario.id,
    screenCount: scenario.program.screens.length,
    gate: gateOn ? "ON" : "OFF",
    execution: "LOCAL_FAKE_FIGMA_RUNTIME",
    measured: {
      uiToPluginExecutorDispatches: uiToPluginDispatches,
      actualUIBridgeMessagesObserved: false,
      pluginAcknowledgements: pluginAcknowledgements,
      rendererInvocations: rendererInvocations,
      nativeReadbackRequests,
      nativeReadbackAcknowledgements: pluginAcknowledgements - captureRequests,
      nativePngExportCalls: mock.exportCalls.length,
      figmaApiOperations: counters.apiCalls,
      figmaApiOperationTotal: counters.apiCallTotal,
      nativeNodeMethodCalls: counters.nodeMethodCalls,
      attachedNodes: roots.reduce((sum, root) => sum + root.nodeCount, 0),
      createdNodes: mock.nodes.length,
      nativeRootIds: roots.map(({ screenId, nodeId, parentId }) => ({ screenId, nodeId, parentId })),
      nativeReadbackConfirmed: nativeReadbackRequests,
      nativeReadbackResponsePayloadBytesJsonEstimate: readbackResponseBytes,
      captureReceiptMetadataPayloadBytesJsonEstimate: captureReceiptMetadataBytes,
      screenshotResponseBytes: responsePngBytes,
      requestPayloadBytesJsonEstimate: requestBytes,
      serializationMethod: "UTF-8 JSON length for typed request payloads; Uint8Array response counted by byteLength",
      checkpointWrites: null,
      checkpointReadbacks: null,
      peakInFlightOperations,
      errors: 0,
      retries: 0,
      localHarnessMs: Number(localHarnessMs.toFixed(3)),
    },
    roots,
    captures,
    stageOrder,
    outcomes: roots.map((root) => ({ screenId: root.screenId, visualCapture: gateOn ? "CAPTURED" : "NOT_REQUESTED", visualReview: "VISUAL_REVIEW_UNAVAILABLE", overallVisualStatus: "UNVERIFIED" })),
    paritySnapshot: roots.map(({ screenId, parentId, nodeCount }) => ({ screenId, parentId, nodeCount })),
    limitations: [
      "The renderer function and executor are invoked directly in a deterministic harness; this does not measure serialized UI bridge messages or Figma Desktop latency.",
      "The one-pixel PNG is synthetic fake-runtime output; it is not screenshot evidence from Figma or a visual-quality judgement.",
      "The harness does not invoke the ChatTask checkpoint owner; checkpoint write/readback counts are null and covered only by task integration tests.",
      "No reviewer/provider calls, OAuth calls, network access, or real document mutations occur.",
    ],
  };
}

export async function runFw5VisualQaBenchmark() {
  const results = [];
  const gateOn = process.env.VITE_FW5_VISUAL_QA === "fw5-visual-qa-v1";
  results.push({ scenario: "F0", screenCount: 0, gate: gateOn ? "ON" : "OFF", execution: "ROUTE_EXCLUDED_NOT_MEASURED", measured: null,
    routeExpectation: { rendererInvocations: 0, nativeReadbackRequests: 0, nativePngExportCalls: 0, taskCheckpointOperations: 0 },
    outcomes: [], paritySnapshot: [], limitations: ["F0 counters are not measured by this plugin-side harness. Existing F0 greeting-route tests prove the task is answered without model planning or native operations; because FW-5 is only entered by a Universal design task, this route never injects a capture callback."] });
  for (const scenario of makeScenarios()) results.push(await runScenario(scenario));
  return {
    schemaVersion: 1,
    featureGate: { variable: "VITE_FW5_VISUAL_QA", enabledValue: "fw5-visual-qa-v1", default: "off" },
    runtime: "LOCAL_FAKE_FIGMA_RUNTIME",
    fixtures: ["F0 greeting/no native task", "F1 synthetic learning dashboard", "F3 synthetic booking flow", "F10 Persian building-management adaptation"],
    scenarios: results,
  };
}
