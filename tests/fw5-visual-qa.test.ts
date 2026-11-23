import { afterEach, describe, expect, it, vi } from "vitest";
import { UIToPluginSchema, type PluginToUIMessage, type UIToPluginMessage } from "../src/shared/messages";
import {
  FW5_VISUAL_CAPTURE_LIMITS,
  runVisualReviewerV1,
  VisualCaptureRequestV1Schema,
  VisualCaptureReceiptV1Schema,
  VisualCaptureTransportV1Schema,
  VisualRepairProposalV1Schema,
  planVisualCaptureScale,
  pngDimensions,
  visualContentDigest,
  type VisualReviewerV1,
  type VisualReviewRequestV1,
} from "../src/shared/fw5-visual-qa";
import { ONE_PIXEL_PNG } from "./visual-fixtures";
import { createMockApi, type MockNode } from "./figma-mock";
import { ChatTaskSchema, type ChatTask } from "../src/shared/chat-task";
import { createDefaultVisualLanguage } from "../src/shared/design-composition";
import { parseDesignProgram } from "../src/shared/design-program";
import { ProjectPlanDraftSchema, parseProjectPlanDraft, projectPlanFingerprint } from "../src/shared/universal-design";
import { designProgramFixtures } from "./fixtures/design-programs";
import { projectNativeLayoutExpectations } from "../src/shared/fw4-geometry";
import { inspectProgramGeometry, PROGRAM_GEOMETRY_KEY } from "../src/plugin/design-program-geometry";
import { visualReviewCapability } from "../src/shared/fw5-provider-visual-review";
import { createFW5VisualReviewAdapter } from "../src/ui/fw5-visual-review-adapter";
import type { CompanionStatus } from "../src/ui/companion-client";

const TASK_ID = "fw5-visual-task-0001";
const DOCUMENT_ID = "file-test-56-page_current";
const FW5_FEATURE = "fw5-visual-qa-v1";
const PNG_BYTES = new Uint8Array(Buffer.from(ONE_PIXEL_PNG, "base64"));
let taskNativeBridgeSink: ((message: PluginToUIMessage) => void) | undefined;

function screenProgram() {
  return {
    programVersion: 1,
    id: "fw5-native-capture",
    revision: 1,
    goal: "Present a short bilingual building notice.",
    audience: "Residents",
    locale: { language: "fa-IR", direction: "rtl" },
    visualIntent: "A compact, legible notice with editable native text.",
    contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", "rtl"],
    tokens: {
      colors: { ink: "#20283A", surface: "#FFFFFF" },
      spacing: [8, 12, 16],
      headingFont: "Inter",
      bodyFont: "Inter",
    },
    references: [],
    screens: [{
      id: "screen-01",
      title: "Building notice",
      purpose: "Read a bilingual resident notice.",
      order: 0,
      viewport: { preset: "mobile", width: 390, height: 844 },
      scroll: "none",
      dependsOn: [],
      root: {
        type: "container",
        id: "notice-content",
        name: "Notice content",
        semanticRole: "notice-content",
        width: { mode: "fixed", value: 342 },
        height: { mode: "fixed", value: 260 },
        layout: { axis: "column", gap: 12, padding: { top: 12, right: 12, bottom: 12, left: 12 }, align: "start", crossAlign: "start" },
        children: [{
          type: "text",
          id: "notice-copy",
          name: "Notice copy",
          semanticRole: "body",
          interaction: "none",
          width: { mode: "hug", value: 230 },
          height: { mode: "hug", value: 60 },
          text: "ورودی ساختمان تا ساعت ۱۸ باز است · Update 123",
          color: "token:ink",
          fontSize: 16,
          weight: "regular",
        }],
      },
    }],
  };
}

async function renderedCapture(gate: boolean, exportFailure = false, enabledUpstreamGates = { fw2: false, fw4: false }, exportBytes?: Uint8Array, exportDelayMs = 0,
  mode: "capture-only" | "review" | "review+bounded-repair" = "capture-only") {
  vi.resetModules();
  vi.stubEnv("VITE_FW5_VISUAL_QA", gate ? FW5_FEATURE : "");
  vi.stubEnv("VITE_FW5_VISUAL_QA_MODE", mode);
  vi.stubEnv("VITE_FW2_CONTEXT", enabledUpstreamGates.fw2 ? "fw2-context-v1" : "");
  vi.stubEnv("VITE_FW4_GEOMETRY", enabledUpstreamGates.fw4 ? "fw4-geometry-v1" : "");
  const [{ createFigmaToolExecutor }, { renderDesignProgramLocal }] = await Promise.all([
    import("../src/plugin/figma-tool-executor"),
    import("../src/plugin/design-program-spike"),
  ]);
  const mock = createMockApi({ simulateFill: true, exportFailure, exportBytes: exportBytes ?? PNG_BYTES, exportDelayMs });
  const unrelated = mock.api.createFrame() as unknown as MockNode;
  unrelated.name = "Unrelated sentinel";
  unrelated.resize(100, 40);
  unrelated.setPluginData("fad.tool.task-id.v1", "other-task-0001");
  const unrelatedBefore = { name: unrelated.name, width: unrelated.width, height: unrelated.height, parent: unrelated.parent?.id };
  const messages: PluginToUIMessage[] = [];
  const executor = createFigmaToolExecutor(mock.api, (message) => { messages.push(message); taskNativeBridgeSink?.(message); });
  const rendered = await renderDesignProgramLocal(mock.api, screenProgram(), {
    taskId: TASK_ID,
    documentId: DOCUMENT_ID,
    pageId: "page:current",
    executor,
    requestId: "fw5_render_screen_01",
  });
  if (!rendered.success) throw new Error(`Mock renderer failed: ${rendered.code} ${JSON.stringify(rendered.findings)}`);
  const root = mock.nodes.find(({ id }) => id === rendered.roots[0]?.nodeId)!;
  const geometryReceipt = root.getPluginData("fad.design.geometry-receipt.v1");
  const receiptHex = geometryReceipt.slice(3);
  const alternateGeometryReceipt = receiptHex.length < 8 ? `v1-${receiptHex.padStart(8, "0")}` : `v1-${receiptHex.replace(/^0+/u, "")}`;
  if (alternateGeometryReceipt !== geometryReceipt)
    root.setPluginData("fad.design.geometry-receipt.v1", alternateGeometryReceipt);
  const inspectRequest = UIToPluginSchema.parse({
    type: "task-native-inspect",
    requestId: "fw5_inspect_screen_01",
    taskId: TASK_ID,
    documentId: DOCUMENT_ID,
    refs: [rendered.roots[0]!.ref],
    geometry: { programFingerprint: rendered.fingerprint, requireReceipt: true, expectedRootNodeId: root.id },
  });
  await executor(inspectRequest as Parameters<typeof executor>[0]);
  const inspection = messages.at(-1);
  if (inspection?.type !== "task-native-inspection-result" || !inspection.success || !inspection.geometry?.receipt)
    throw new Error("Mock native readback did not produce a verified receipt: " + JSON.stringify(inspection));
  expect(inspection.geometry.receipt).toBe(geometryReceipt);
  const captureRequest = UIToPluginSchema.parse({
    type: "task-native-visual-capture",
    requestId: "fw5_capture_screen_01",
    rootRef: rendered.roots[0]!.ref,
    visualCapture: {
      version: 1,
      taskId: TASK_ID,
      screenId: "screen-01",
      authorizedDocumentScope: { documentId: DOCUMENT_ID, pageId: "page:current", rootId: root.id },
      pageId: "page:current",
      rootId: root.id,
      programFingerprint: rendered.fingerprint,
      readbackRevision: inspection.geometry.receipt,
      maxPixelWidth: FW5_VISUAL_CAPTURE_LIMITS.maxPixelWidth,
      maxPixelHeight: FW5_VISUAL_CAPTURE_LIMITS.maxPixelHeight,
      maxBytes: FW5_VISUAL_CAPTURE_LIMITS.maxBytes,
      deadlineAtMs: Date.now() + FW5_VISUAL_CAPTURE_LIMITS.timeoutMs,
      captureNonce: "fw5_capture_screen_01",
    },
  });
  return { mock, messages, executor, rendered, root, unrelated, unrelatedBefore, captureRequest };
}

async function runTaskCheckpointCapture(captureFails = false, reviewOptions?: {
  gateEnabled?: boolean;
  nativeBridge?: boolean;
  recheckCaptureFails?: boolean;
  reviewer?: VisualReviewerV1;
  consent?: boolean;
  mode?: "review" | "review+bounded-repair";
  providerAdapter?: boolean;
  geometryMismatch?: boolean;
  repairVisual?: (request: Extract<UIToPluginMessage, { type: "task-native-visual-repair" }>) => Promise<Extract<PluginToUIMessage, { type: "task-native-visual-repair-result" }>>;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_FW5_VISUAL_QA", reviewOptions?.gateEnabled === false ? "" : FW5_FEATURE);
  vi.stubEnv("VITE_FW5_VISUAL_QA_MODE", reviewOptions?.mode ?? "");
  vi.stubEnv("VITE_FW4_GEOMETRY", reviewOptions?.geometryMismatch ? "fw4-geometry-v1" : "");
  const { runUniversalDesignTask } = await import("../src/ui/universal-design-task");
  const taskId = "fw5-checkpoint-task-001";
  const draft = ProjectPlanDraftSchema.parse({
    productPurpose: "Help residents read an important building notice.",
    projectNarrative: "A single mobile screen presents one concise, readable notice.",
    audience: "Residents",
    primaryUserGoals: ["Read the notice"],
    capabilities: ["Read a notice", "See the next step"],
    keyEntities: [{ name: "notice", meaning: "A synthetic building notice.", provenance: "illustrative" }],
    domainTags: ["building-notice"],
    platform: "mobile",
    locale: "fa-IR",
    direction: "rtl",
    screenCount: 1,
    styleDirection: "Calm, clear, readable and native.",
    contentDensity: "low",
    contentSamplePolicy: "clearly-illustrative",
    accessibilityMinimums: ["Readable text and visible focus."],
    componentOpportunities: [],
    designConstraints: [],
    screens: [{
      order: 0, name: "اطلاعیه", role: "notice", purpose: "Read the building notice.",
      source: "requested", primaryTask: "Read the notice", entryState: "Notice opened", exitState: "Notice understood",
      regions: [{ name: "Notice copy", semanticRole: "body", content: "Synthetic notice text.", priority: 1 }],
      dataRelationships: [], responsiveConstraints: ["Use the mobile viewport."], accessibilityNotes: ["Keep Persian text readable."],
      entityRefs: ["notice"], actions: [], states: ["ready"], navigationOrders: [], dependencyOrders: [], scroll: "vertical",
    }],
    knownFacts: ["The user requested a building notice."],
    assumptions: ["No existing Figma document was inspected."],
    nonGoals: ["No real resident information."],
  });
  const planned = parseProjectPlanDraft(draft, {
    taskId, requestedScreenCount: 1, requestedTarget: "mobile", requestedLocale: "fa-IR",
    visualLanguageFallback: createDefaultVisualLanguage({ styleDirection: draft.styleDirection, density: "low", locale: "fa-IR" }),
  });
  if (!planned.success) throw new Error("Test plan invalid: " + JSON.stringify(planned.findings));
  const source = structuredClone(designProgramFixtures[0]) as Record<string, unknown>;
  source.id = "fw5-checkpoint-program";
  source.screens = [(source.screens as Array<Record<string, unknown>>)[0]!];
  const sourceScreen = (source.screens as Array<Record<string, unknown>>)[0]!;
  sourceScreen.id = "screen-01";
  sourceScreen.title = "اطلاعیه";
  sourceScreen.order = 0;
  sourceScreen.purpose = "Read the building notice.";
  const parsedProgram = parseDesignProgram(source);
  if (!parsedProgram.success) throw new Error("Test program invalid: " + JSON.stringify(parsedProgram.findings));
  const expectedLayout = projectNativeLayoutExpectations(parsedProgram.data, "screen-01");
  const sizingExpectation = expectedLayout[0]!;
  const screenRef = "fw5-screen-01-root";
  const task = ChatTaskSchema.parse({
    version: 1,
    id: taskId,
    documentId: "file-test-56-page_current",
    prompt: "برای اطلاعیهٔ ساختمان یک صفحهٔ موبایل فارسی و راست‌چین بساز.",
    model: "provider/account-visible-model",
    intent: "create",
    executionRoute: "universal-design-v1",
    context: [], stages: [], ledger: [], pending: [], recent: [], starts: [],
    rounds: 0, status: "ready", text: "",
    projectPlan: planned.plan,
    projectPlanFingerprint: projectPlanFingerprint(planned.plan),
    universalScreens: [{
      screenId: "screen-01", status: "program_saved", composeAttempts: 0, repairDispatches: 0,
      program: parsedProgram.data, fingerprint: parsedProgram.fingerprint, renderAttempts: 0,
    }],
  }) as ChatTask;
  const saved: ChatTask[] = [];
  const mock = reviewOptions?.nativeBridge ? createMockApi({ simulateFill: true, exportBytes: PNG_BYTES }) : undefined;
  const native = mock ? await (async () => {
    const { createFigmaToolExecutor } = await import("../src/plugin/figma-tool-executor");
    const { renderDesignProgramLocal } = await import("../src/plugin/design-program-spike");
    const { taskNativeBridge, taskNativeVisualCaptureBridge } = await import("../src/ui/task-native-bridge");
    const events = new EventTarget();
    const parentShim = {
      postMessage(data: { pluginMessage: unknown }) {
        const message = UIToPluginSchema.parse(data.pluginMessage);
        if (message.type === "task-native-inspect" || message.type === "task-native-visual-capture" ||
            message.type === "task-native-visual-capture-cancel") void executor(message);
      },
    };
    const executor = createFigmaToolExecutor(mock.api, (message) => {
      const event = new Event("message");
      Object.assign(event, { source: parentShim, data: { pluginMessage: message } });
      events.dispatchEvent(event);
    });
    vi.stubGlobal("window", Object.assign(events, { setTimeout, clearTimeout }));
    vi.stubGlobal("parent", parentShim);
    return {
      capture: taskNativeVisualCaptureBridge,
      inspect: taskNativeBridge,
      async render(program: typeof parsedProgram.data, requestId: string) {
        const result = await renderDesignProgramLocal(mock.api, program, {
          taskId, documentId: DOCUMENT_ID, pageId: "page:current", executor, requestId,
        });
        if (!result.success) throw new Error(result.code);
        const root = result.roots[0]!;
        return {
          type: "design-program-render-result" as const, requestId, taskId, success: true,
          screenId: root.screenId, nativeRootNodeId: root.nodeId, rootRef: root.ref, nativeBatchId: result.batchId,
          adoptionOperationIds: result.operationIds, programFingerprint: result.fingerprint,
          nativeNodeCount: result.registeredRefs, visualCaptureEligible: root.freshlyCreated === true,
          geometryVersion: result.geometryVersion,
        };
      },
    };
  })() : undefined;
  let inspectionCount = 0;
  const captureVisual = vi.fn(async (request: Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>, signal: AbortSignal) => {
    if (native) return native.capture(request, signal);
    const failed = captureFails || (reviewOptions?.recheckCaptureFails === true && request.visualCapture.captureAttempt === 2);
    const receipt = {
      version: 1 as const, status: failed ? "CAPTURE_FAILED" as const : "CAPTURED" as const,
      receiptId: "fw5-" + request.visualCapture.captureNonce,
      taskId, screenId: "screen-01", documentId: task.documentId, pageId: "page:current",
      rootId: "mock-fw5-root-01", programFingerprint: parsedProgram.fingerprint,
      readbackRevision: request.visualCapture.readbackRevision, mime: "image/png" as const,
      width: failed ? 0 : 1, height: failed ? 0 : 1,
      byteLength: failed ? 0 : PNG_BYTES.byteLength, capturedAtMs: Date.now(), exportScale: 1,
      captureAttempt: request.visualCapture.captureAttempt, ...(request.visualCapture.previousReceiptId ? { previousReceiptId: request.visualCapture.previousReceiptId } : {}),
      diagnostic: failed ? "export_failed" as const : "none" as const,
    };
    return failed
      ? { type: "task-native-visual-capture-result" as const, requestId: request.requestId, taskId, success: false, receipt, exportDurationMs: 3 }
      : { type: "task-native-visual-capture-result" as const, requestId: request.requestId, taskId, success: true, visualCapture: { receipt, pngBytes: new Uint8Array(PNG_BYTES) }, exportDurationMs: 3 };
  });
  const providerPrompts: string[] = [];
  const providerRequests: Array<Record<string, unknown>> = [];
  const providerSession = {
    sessionId: "fw5_provider_session_01",
    accountScope: "a".repeat(64),
  };
  const providerStatus = {
    companion: "connected" as const, auth: "ready" as const, authLabel: "Ready", planUseAuthorized: true, modelCount: 1,
    ...providerSession,
  } satisfies CompanionStatus;
  const providerFetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toContain("/v1/visual-review");
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    providerRequests.push(request);
    const findings = request.imageRevision === 1 ? [{
      issueCode: "native_layout_sizing_mismatch",
      severity: "error",
      confidence: 0.98,
      imageLocation: { x: 0.1, y: 0.1, width: 0.6, height: 0.4 },
      matchedNativeNodeId: "mock-fw5-frame-01",
      nodePath: "root/content",
      evidence: "The content frame appears constrained against its parent.",
      proposedAction: "fw4-sizing",
      property: "layoutSizingHorizontal",
      expectedValue: "HUG",
      proposedValue: sizingExpectation.horizontalSizing,
      recheckRequired: true,
    }] : [];
    return Response.json({
      version: 1,
      requestId: request.requestId,
      model: "account-model",
      capability: { status: "supported", provenance: "provider_result", model: "account-model" },
      response: { verdict: findings.length ? "findings" : "pass", confidence: 0.98, findings },
    });
  });
  const providerAdapter = reviewOptions?.providerAdapter ? createFW5VisualReviewAdapter({
    enabled: true,
    mode: reviewOptions.mode ?? "review",
    token: "paired-local-token",
    model: "account-model",
    models: [{ slug: "account-model", displayName: "Account Model" }],
    session: providerSession,
    task,
    assertCurrent: () => undefined,
    getStatus: async () => providerStatus,
    inspectRoot: async (request) => ({
      type: "task-native-inspection-result", success: true, taskId: request.taskId, nativePageId: request.pageId,
      expectedRootStatus: "present", geometry: { receipt: request.readbackRevision },
      nodes: [{ ref: request.rootRef, id: request.rootId }],
    }) as unknown as Extract<PluginToUIMessage, { type: "task-native-inspection-result" }>,
    confirm: (message) => { providerPrompts.push(message); return true; },
    fetcher: providerFetcher,
  }) : undefined;
  await runUniversalDesignTask(task, {
    model: vi.fn(async () => { throw new Error("No provider calls are permitted in this fixture."); }),
    save: vi.fn(async (snapshot) => { saved.push(structuredClone(snapshot)); }),
    progress: vi.fn(),
    assertAuthorized: vi.fn(async () => undefined),
    renderProgram: native?.render ?? vi.fn(async (_program, requestId) => ({
      type: "design-program-render-result" as const,
      requestId,
      taskId,
      success: true,
      screenId: "screen-01",
      nativeRootNodeId: "mock-fw5-root-01",
      rootRef: screenRef,
      nativeBatchId: "batch-fw5-task-01",
      adoptionOperationIds: ["adopt-fw5-root-01", "adopt-fw5-frame-01", "adopt-fw5-copy-01"],
      programFingerprint: parsedProgram.fingerprint,
      nativeNodeCount: 3,
      visualCaptureEligible: true,
      geometryVersion: 1 as const,
    })),
    inspectProgram: native ? async (request) => {
      const response = await native.inspect(request);
      if (response.type !== "task-native-inspection-result") throw new Error("Unexpected native bridge result.");
      return response;
    } : vi.fn(async () => {
      const recheck = inspectionCount++ > 0;
      const findings = reviewOptions?.geometryMismatch && !recheck ? [{
        code: "native_layout_sizing_mismatch", nodeId: "mock-fw5-frame-01", parentId: "mock-fw5-root-01",
        logicalRef: sizingExpectation.logicalRef,
        expectedLayout: { horizontalSizing: sizingExpectation.horizontalSizing, verticalSizing: sizingExpectation.verticalSizing },
        observedLayout: { horizontalSizing: "HUG", verticalSizing: sizingExpectation.verticalSizing },
      }] : [];
      return {
      type: "task-native-inspection-result" as const,
      requestId: "task-inspect-request-01",
      success: true,
      taskId,
      nativePageId: "page:current",
      expectedRootStatus: "present" as const,
      unresolvedRefs: [],
      truncated: false,
      nodes: [
        { id: "mock-fw5-root-01", ref: screenRef, logicalRef: sizingExpectation.parentLogicalRef, name: "Task root", type: "FRAME", x: 0, y: 0, width: 390, height: 844, visible: true, clipsContent: true, overflowDirection: "VERTICAL" as const, layoutMode: "VERTICAL" },
        { id: "mock-fw5-frame-01", parentId: "mock-fw5-root-01", ref: "fw5-screen-01-frame", logicalRef: sizingExpectation.logicalRef, name: "Task content", type: "FRAME", x: 12, y: 12, width: 342, height: 260, visible: true, layoutMode: "VERTICAL", layoutSizingHorizontal: recheck ? sizingExpectation.horizontalSizing : "HUG", layoutSizingVertical: sizingExpectation.verticalSizing },
        { id: "mock-fw5-text-01", parentId: "mock-fw5-frame-01", ref: "fw5-screen-01-copy", name: "Notice copy", type: "TEXT", x: 12, y: 12, width: 320, height: 48, visible: true },
      ],
      geometry: { version: 1 as const, coverage: "complete" as const, measuredNodes: 3, durationMs: 1, receipt: recheck ? "v1-89abcdef" : "v1-01234567", findings },
    }; }),
    captureVisual,
    ...(reviewOptions?.repairVisual ? { repairVisual: reviewOptions.repairVisual } : {}),
    ...(providerAdapter ? {
      visualReviewer: providerAdapter.reviewer,
      authorizeVisualReview: providerAdapter.authorize,
    } : reviewOptions ? {
      visualReviewer: reviewOptions.reviewer,
      authorizeVisualReview: vi.fn(async (identity) => reviewOptions.consent === false ? undefined : ({
        version: 1, authorized: true, recipient: "authorized-image-provider", authorizationId: "fw5_review_auth_01", ...identity,
      })),
    } : {}),
    signal: new AbortController().signal,
    timingEvidence: "mock",
  });
  return { task, saved, captureVisual, mock, providerPrompts, providerRequests, providerFetcher };
}

afterEach(() => {
  taskNativeBridgeSink = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("FW-5 visual evidence contract and native exporter", () => {
  it("reports image capability as unknown until an observed provider result exists", () => {
    expect(visualReviewCapability({ authorized: true, consented: true, model: "account-model" })).toMatchObject({
      status: "unknown", provenance: "unverified_local_assumption", detail: "no_model_modality_metadata",
    });
    expect(visualReviewCapability({ authorized: false, consented: true })).toMatchObject({ status: "authorization_required", provenance: "account_authorization" });
    expect(visualReviewCapability({ authorized: true, consented: false })).toMatchObject({ status: "consent_required", provenance: "user_consent" });
    expect(visualReviewCapability({ authorized: true, consented: true, observed: "supported" })).toMatchObject({ status: "supported", provenance: "provider_result" });
    expect(visualReviewCapability({ authorized: true, consented: true, observed: "unsupported" })).toMatchObject({ status: "unsupported", provenance: "provider_result" });
    expect(visualReviewCapability({ authorized: true, consented: true, observed: "temporarily_unavailable" })).toMatchObject({ status: "temporarily_unavailable", provenance: "provider_result" });
  });

  it("strictly bounds capture requests, receipts, PNG dimensions, and local checksum", () => {
    expect(VisualCaptureRequestV1Schema.safeParse({
      version: 1, taskId: TASK_ID, screenId: "screen-01",
      authorizedDocumentScope: { documentId: DOCUMENT_ID, pageId: "page:current", rootId: "root-1" },
      pageId: "page:current", rootId: "root-1", programFingerprint: "dpv1-0123456789abcdef",
      readbackRevision: "v1-01234567", maxPixelWidth: 2048, maxPixelHeight: 2048, maxBytes: 4_194_304,
      deadlineAtMs: Date.now() + 10_000, captureNonce: "fw5_capture_test_01",
    }).success).toBe(true);
    expect(VisualCaptureRequestV1Schema.safeParse({ version: 1, arbitraryCode: "eval('x')" }).success).toBe(false);
    expect(VisualCaptureRequestV1Schema.safeParse({
      version: 1, taskId: TASK_ID, screenId: "screen-01",
      authorizedDocumentScope: { documentId: DOCUMENT_ID, pageId: "page:other", rootId: "root-1" },
      pageId: "page:current", rootId: "root-1", programFingerprint: "dpv1-0123456789abcdef",
      readbackRevision: "v1-01234567", maxPixelWidth: 2048, maxPixelHeight: 2048, maxBytes: 4_194_304,
      deadlineAtMs: Date.now() + 10_000, captureNonce: "fw5_capture_test_01",
    }).success).toBe(false);
    const dimensions = pngDimensions(PNG_BYTES);
    expect(dimensions).toEqual({ width: 1, height: 1 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(pngDimensions(PNG_BYTES.subarray(0, PNG_BYTES.length - 1))).toBeUndefined();
    expect(planVisualCaptureScale(390, 844)).toBe(1);
    expect(planVisualCaptureScale(10_000, 10_000)).toBeUndefined();
    expect(PNG_BYTES.byteLength).toBeLessThan(FW5_VISUAL_CAPTURE_LIMITS.maxBytes);
    expect(visualContentDigest(PNG_BYTES)).toMatch(/^fnv1a64-[a-f0-9]{16}$/u);
    const receipt = VisualCaptureReceiptV1Schema.parse({
      version: 1, status: "CAPTURED", receiptId: "fw5-test_capture_nonce_001", taskId: TASK_ID,
      screenId: "screen-01", documentId: DOCUMENT_ID, pageId: "page:current", rootId: "root-1",
      programFingerprint: "dpv1-0123456789abcdef", readbackRevision: "v1-01234567", mime: "image/png",
      width: 1, height: 1, byteLength: PNG_BYTES.byteLength, capturedAtMs: Date.now(), exportScale: 1,
      captureAttempt: 1, diagnostic: "none",
    });
    expect(VisualCaptureTransportV1Schema.safeParse({ receipt, pngBytes: PNG_BYTES }).success).toBe(true);
    expect(VisualCaptureTransportV1Schema.safeParse({ receipt, pngBytes: new Uint8Array(FW5_VISUAL_CAPTURE_LIMITS.maxBytes + 1) }).success).toBe(false);
  });

  it("requires an exact review grant and validates reviewer identity, node grounding, bounds, and source", async () => {
    const request = {
      version: 1 as const, requestId: "fw5_review_capture_01", taskId: TASK_ID, taskGeneration: `generation-${TASK_ID}`, screenId: "screen-01" as const,
      documentId: DOCUMENT_ID, pageId: "page:current", rootId: "root-review-01", programFingerprint: "dpv1-0123456789abcdef",
      readbackRevision: "v1-01234567", receiptId: "fw5-capture-receipt-01", imageRevision: 1 as const, viewport: { width: 390, height: 844 },
      scrollIntent: "none" as const, nodes: [{ nodeId: "root-review-01", type: "FRAME" as const, bounds: { x: 0, y: 0, width: 390, height: 844 }, visible: true }],
      program: { programId: "review-program", programRevision: 1, screenId: "screen-01" as const,
        viewport: { width: 390, height: 844 }, language: "fa-IR", direction: "rtl" as const, scrollIntent: "none" as const,
        nodes: [{ nodeId: "copy", type: "text" as const, semanticRole: "body", width: { mode: "FIXED" as const, value: 320 }, height: { mode: "HUG" as const, value: 48 }, textLength: 12, fontSize: 16 }] },
      pngBytes: PNG_BYTES,
    };
    const grant = { version: 1 as const, authorized: true as const, recipient: "authorized-image-provider" as const,
      authorizationId: "fw5_review_auth_01", taskId: TASK_ID, screenId: "screen-01" as const, documentId: DOCUMENT_ID,
      pageId: "page:current", rootId: "root-review-01", programFingerprint: request.programFingerprint,
      readbackRevision: request.readbackRevision, receiptId: "fw5-capture-receipt-01" };
    const result = { version: 1 as const, requestId: request.requestId, receiptId: request.receiptId,
      taskId: TASK_ID, screenId: "screen-01" as const, rootId: request.rootId,
      programFingerprint: request.programFingerprint, readbackRevision: request.readbackRevision,
      kind: "vision" as const, verdict: "findings" as const, confidence: 0.7, findings: [{
      findingId: "fw5f-0123abcd", issueCode: "hierarchy_concern" as const, source: "pixel-review" as const,
      taskId: TASK_ID, screenId: "screen-01" as const, evidenceSource: "image+native-readback" as const,
      severity: "warning" as const, evidenceRef: "capture:fw5-capture-receipt-01", nodeId: "root-review-01",
      bounds: { x: 10, y: 10, width: 40, height: 20 }, confidence: 0.7, uncertain: true, safeToAutoRepair: false,
    }] };
    const review = vi.fn(async () => result);
    const reviewer = { capabilities: vi.fn(async () => ({ version: 1, kind: "vision", acceptsPng: true, maxBytes: 1024, maxFindings: 2 })), review };
    const response = await runVisualReviewerV1(reviewer, request, grant, new AbortController().signal);
    expect(response).toEqual(result);
    expect(review).toHaveBeenCalledOnce();
    await expect(runVisualReviewerV1(reviewer, request, { ...grant, rootId: "different-root" }, new AbortController().signal)).rejects.toThrow(/grant does not match/u);
    expect(review).toHaveBeenCalledOnce();
    const aborted = new AbortController();
    aborted.abort();
    await expect(runVisualReviewerV1(reviewer, request, grant, aborted.signal)).rejects.toThrow(/cancelled/u);
    expect(review).toHaveBeenCalledOnce();
    await expect(runVisualReviewerV1({ ...reviewer, review: vi.fn(async () => ({ ...result, findings: [{ ...result.findings[0]!, nodeId: "fabricated-node" }] })) }, request, grant, new AbortController().signal)).rejects.toThrow(/unknown native node/u);
    await expect(runVisualReviewerV1({ ...reviewer, review: vi.fn(async () => ({ ...result, findings: [{ ...result.findings[0]!, source: "human" }] })) }, request, grant, new AbortController().signal)).rejects.toThrow(/pixel-review/u);
    await expect(runVisualReviewerV1({ ...reviewer, review: vi.fn(async () => ({ ...result, findings: [{ ...result.findings[0]!, bounds: { x: 380, y: 830, width: 20, height: 20 } }] })) }, request, grant, new AbortController().signal)).rejects.toThrow(/viewport/u);
  });

  it("keeps repair proposals property-only and revision-bound", () => {
    const proposal = {
      version: 1, proposalId: "fw5-repair-screen01-root01", taskId: TASK_ID, screenId: "screen-01",
      pageId: "page:current", rootId: "root-01", programFingerprint: "dpv1-0123456789abcdef", readbackRevision: "v1-01234567", captureReceiptId: "fw5-capture_0123456789",
      findingId: "fw5f-0123abcd", targetNodeId: "frame-01", expectedParentId: "root-01", targetType: "FRAME",
      property: "layoutSizingHorizontal", expectedValue: "HUG", proposedValue: "FIXED", source: "fw4-sizing-convergence",
    };
    expect(VisualRepairProposalV1Schema.safeParse(proposal).success).toBe(true);
    expect(VisualRepairProposalV1Schema.safeParse({ ...proposal, property: "fills", proposedValue: "#fff" }).success).toBe(false);
    expect(VisualRepairProposalV1Schema.safeParse({ ...proposal, targetNodeId: "x", delete: true }).success).toBe(false);
    expect(VisualRepairProposalV1Schema.safeParse({ ...proposal, expectedValue: "FILL", proposedValue: "HEIGHT" }).success).toBe(false);
  });

  it("exports only the freshly rendered task root after its native readback, and replays without a second export", async () => {
    const harness = await renderedCapture(true);
    expect(harness.rendered.roots[0]).toMatchObject({ freshlyCreated: true });
    const unrelatedState = { name: harness.unrelated.name, width: harness.unrelated.width, height: harness.unrelated.height, parent: harness.unrelated.parent?.id };
    await harness.executor(harness.captureRequest as Parameters<typeof harness.executor>[0]);
    const result = harness.messages.at(-1);
    expect(result?.type).toBe("task-native-visual-capture-result");
    if (result?.type !== "task-native-visual-capture-result") return;
    expect(result.success, JSON.stringify(result.receipt)).toBe(true);
    expect(result.visualCapture?.receipt).toMatchObject({
      status: "CAPTURED", rootId: harness.root.id, pageId: "page:current", taskId: TASK_ID,
      screenId: "screen-01", programFingerprint: harness.rendered.fingerprint,
      readbackRevision: expect.stringMatching(/^v1-[a-f0-9]{1,8}$/u), width: 1, height: 1,
    });
    expect(result.visualCapture?.pngBytes).toEqual(PNG_BYTES);
    expect(harness.mock.exportCalls).toHaveLength(1);
    expect(harness.mock.exportCalls[0]?.nodeId).toBe(harness.root.id);
    expect({ name: harness.unrelated.name, width: harness.unrelated.width, height: harness.unrelated.height, parent: harness.unrelated.parent?.id }).toEqual(unrelatedState);
    expect(harness.mock.storage.size).toBeGreaterThan(0);
    expect(JSON.stringify([...harness.mock.storage.values()])).not.toContain("137,80,78,71");

    await harness.executor(harness.captureRequest as Parameters<typeof harness.executor>[0]);
    const replay = harness.messages.at(-1);
    expect(replay).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "root_reused_or_recovered" } });
    expect(harness.mock.exportCalls).toHaveLength(1);
    expect(harness.root.removed).toBe(false);
  });

  it("keeps gate-off export disabled and records injected export failure without removing task roots", async () => {
    const disabled = await renderedCapture(false);
    await disabled.executor(disabled.captureRequest as Parameters<typeof disabled.executor>[0]);
    expect(disabled.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "gate_disabled" } });
    expect(disabled.mock.exportCalls).toHaveLength(0);
    expect(disabled.root.removed).toBe(false);

    const failed = await renderedCapture(true, true);
    const rootsBefore = failed.mock.page.children.map(({ id }) => id);
    await failed.executor(failed.captureRequest as Parameters<typeof failed.executor>[0]);
    expect(failed.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { status: "CAPTURE_FAILED", diagnostic: "export_failed" } });
    expect(failed.mock.exportCalls).toHaveLength(1);
    expect(failed.mock.page.children.map(({ id }) => id)).toEqual(rootsBefore);
    expect(failed.root.removed).toBe(false);
    expect({ name: failed.unrelated.name, width: failed.unrelated.width, height: failed.unrelated.height, parent: failed.unrelated.parent?.id }).toEqual(failed.unrelatedBefore);
  });

  it("keeps the single-export slot occupied while a timed-out native export is still resolving", async () => {
    const slow = await renderedCapture(true, false, { fw2: false, fw4: false }, undefined, 250);
    const base = slow.captureRequest as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
    const first = UIToPluginSchema.parse({
      ...base,
      visualCapture: { ...base.visualCapture, deadlineAtMs: Date.now() + 40 },
    }) as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
    vi.useFakeTimers();
    try {
      const firstRun = slow.executor(first);
      await vi.advanceTimersByTimeAsync(40);
      await firstRun;
      expect(slow.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "capture_deadline_exceeded" } });
      expect(slow.mock.exportCalls).toHaveLength(1);
      expect(slow.root.removed).toBe(false);

      const second = UIToPluginSchema.parse({
        ...base,
        requestId: "fw5_capture_screen_01_retry",
        visualCapture: { ...base.visualCapture, captureNonce: "fw5_capture_screen_01_retry", deadlineAtMs: Date.now() + 5_000 },
      }) as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
      await slow.executor(second);
      expect(slow.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "capture_in_flight_limit" } });
      expect(slow.mock.exportCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(210);
      const afterSettle = UIToPluginSchema.parse({
        ...second,
        requestId: "fw5_capture_screen_01_after_settle",
        visualCapture: { ...second.visualCapture, captureNonce: "fw5_capture_screen_01_after_settle", deadlineAtMs: Date.now() + 5_000 },
      }) as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
      await slow.executor(afterSettle);
      expect(slow.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "root_reused_or_recovered" } });
      expect(slow.mock.exportCalls).toHaveLength(1);
      expect(slow.root.removed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a moved root before exporting and leaves its moved and unrelated nodes in place", async () => {
    const moved = await renderedCapture(true);
    moved.mock.otherPage.appendChild(moved.root);
    const rootsBefore = moved.mock.otherPage.children.map(({ id }) => id);
    await moved.executor(moved.captureRequest as Parameters<typeof moved.executor>[0]);
    expect(moved.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { status: "UNVERIFIED" } });
    expect(moved.mock.exportCalls).toHaveLength(0);
    expect(moved.mock.otherPage.children.map(({ id }) => id)).toEqual(rootsBefore);
    expect(moved.root.removed).toBe(false);
    expect({ name: moved.unrelated.name, width: moved.unrelated.width, height: moved.unrelated.height, parent: moved.unrelated.parent?.id }).toEqual(moved.unrelatedBefore);
  });

  it("refuses stale native readback and an explicit pre-dispatch cancellation without exporting", async () => {
    const stale = await renderedCapture(true);
    const textNode = stale.mock.nodes.find(({ type }) => type === "TEXT")!;
    (textNode as unknown as { characters: string }).characters = "User changed this after readback";
    await stale.executor(stale.captureRequest as Parameters<typeof stale.executor>[0]);
    expect(stale.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { status: "UNVERIFIED", diagnostic: "readback_stale" } });
    expect(stale.mock.exportCalls).toHaveLength(0);
    expect(stale.root.removed).toBe(false);

    const stopped = await renderedCapture(true);
    const request = stopped.captureRequest as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
    await stopped.executor(UIToPluginSchema.parse({
      type: "task-native-visual-capture-cancel", requestId: request.requestId,
      taskId: TASK_ID, captureNonce: request.visualCapture.captureNonce,
    }) as Parameters<typeof stopped.executor>[0]);
    await stopped.executor(request);
    expect(stopped.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "capture_cancelled" } });
    expect(stopped.mock.exportCalls).toHaveLength(0);
    expect(stopped.root.removed).toBe(false);
  });

  it("rejects malformed or oversized PNG results after export and preserves the native tree", async () => {
    const invalid = await renderedCapture(true, false, { fw2: false, fw4: false }, new Uint8Array([1, 2, 3]));
    const invalidTree = invalid.mock.page.children.map(({ id }) => id);
    await invalid.executor(invalid.captureRequest as Parameters<typeof invalid.executor>[0]);
    expect(invalid.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { diagnostic: "invalid_png" } });
    expect(invalid.mock.exportCalls).toHaveLength(1);
    expect(invalid.mock.page.children.map(({ id }) => id)).toEqual(invalidTree);
    expect(invalid.root.removed).toBe(false);

    const oversizedPng = new Uint8Array(FW5_VISUAL_CAPTURE_LIMITS.maxBytes + 1);
    oversizedPng.set(PNG_BYTES.slice(0, 16));
    const view = new DataView(oversizedPng.buffer);
    view.setUint32(16, 2048, false);
    view.setUint32(20, 2048, false);
    const oversized = await renderedCapture(true, false, { fw2: false, fw4: false }, oversizedPng);
    await oversized.executor(oversized.captureRequest as Parameters<typeof oversized.executor>[0]);
    expect(oversized.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: false, receipt: { status: "CAPTURE_FAILED", diagnostic: "capture_limit_exceeded" } });
    expect(oversized.mock.exportCalls).toHaveLength(1);
    expect(oversized.root.removed).toBe(false);
  });

  it("keeps capture isolated while FW-2 and FW-4 gates are enabled", async () => {
    const combined = await renderedCapture(true, false, { fw2: true, fw4: true });
    await combined.executor(combined.captureRequest as Parameters<typeof combined.executor>[0]);
    const result = combined.messages.at(-1);
    expect(result?.type).toBe("task-native-visual-capture-result");
    if (result?.type !== "task-native-visual-capture-result") return;
    expect(result.success).toBe(true);
    expect(result.visualCapture?.receipt.rootId).toBe(combined.root.id);
    expect(combined.mock.exportCalls).toHaveLength(1);
    expect(combined.root.removed).toBe(false);
  });

  it("applies one root-scoped FW-4 sizing repair, confirms readback, and permits only its linked second capture", async () => {
    const harness = await renderedCapture(true, false, { fw2: false, fw4: true }, undefined, 0, "review+bounded-repair");
    const parsedProgram = parseDesignProgram(screenProgram());
    expect(parsedProgram.success).toBe(true);
    if (!parsedProgram.success) return;
    const expectations = projectNativeLayoutExpectations(parsedProgram.data, "screen-01");
    const byRef = new Map(expectations.map((expectation) => [expectation.logicalRef, expectation]));
    const target = harness.mock.nodes.find((node) => {
      const logicalRef = node.getPluginData("fad.design.logical-ref");
      const expected = byRef.get(logicalRef);
      return node.type === "FRAME" && node.id !== harness.root.id && node.parent?.type === "FRAME" &&
        node.parent.layoutMode !== "NONE" && expected?.parentLogicalRef === node.parent.getPluginData("fad.design.logical-ref") &&
        expected.horizontalSizing !== undefined;
    });
    expect(target, "fixture must contain a task subtree frame with an Auto Layout parent").toBeDefined();
    if (!target || target.parent?.type !== "FRAME") return;
    const expectation = byRef.get(target.getPluginData("fad.design.logical-ref"))!;
    const expectedValue = expectation.horizontalSizing;
    const wrongValue = expectedValue === "HUG" ? "FIXED" : "HUG";
    target.layoutSizingHorizontal = wrongValue;
    const mismatch = inspectProgramGeometry(harness.root as unknown as FrameNode, {
      taskId: TASK_ID, pageId: "page:current", requireOwnership: true,
      expectedLayout: expectations, verifyLayoutSizing: true,
    });
    expect(mismatch.findings).toHaveLength(1);
    expect(mismatch.findings[0]).toMatchObject({ code: "native_layout_sizing_mismatch", nodeId: target.id, parentId: target.parent.id });
    harness.root.setPluginData(PROGRAM_GEOMETRY_KEY, mismatch.receipt);

    const originalCapture = harness.captureRequest as Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
    const captureRequest = UIToPluginSchema.parse({ ...originalCapture, visualCapture: { ...originalCapture.visualCapture, readbackRevision: mismatch.receipt } });
    await harness.executor(captureRequest as Parameters<typeof harness.executor>[0]);
    const captureMessage = harness.messages.at(-1);
    expect(captureMessage?.type).toBe("task-native-visual-capture-result");
    if (captureMessage?.type !== "task-native-visual-capture-result" || !captureMessage.success || !captureMessage.visualCapture) return;
    const receipt = captureMessage.visualCapture.receipt;
    const proposalId = `fw5-repair-${TASK_ID}_screen-01_1`;
    const proposal = VisualRepairProposalV1Schema.parse({
      version: 1, proposalId, taskId: TASK_ID, screenId: "screen-01", pageId: "page:current", rootId: harness.root.id,
      programFingerprint: harness.rendered.fingerprint, readbackRevision: mismatch.receipt, captureReceiptId: receipt.receiptId,
      findingId: "fw5f-0123abcd", targetNodeId: target.id, expectedParentId: target.parent.id, targetType: "FRAME",
      property: "layoutSizingHorizontal", expectedValue: wrongValue, proposedValue: expectedValue, source: "fw4-sizing-convergence",
    });
    const repairRequest = UIToPluginSchema.parse({ type: "task-native-visual-repair", request: {
      version: 1, requestId: proposalId, taskId: TASK_ID, screenId: "screen-01", documentId: DOCUMENT_ID,
      pageId: "page:current", rootId: harness.root.id, rootRef: harness.rendered.roots[0]!.ref,
      programFingerprint: harness.rendered.fingerprint, captureReceiptId: receipt.receiptId,
      deadlineAtMs: Date.now() + 10_000, proposal,
    } });
    const rootCount = harness.mock.page.children.length;
    const unrelatedBefore = { ...harness.unrelatedBefore };
    const bridgeListeners = new Set<(event: MessageEvent) => void>();
    const parentShim = {
      postMessage(data: { pluginMessage?: unknown }) {
        const parsed = UIToPluginSchema.safeParse(data.pluginMessage);
        if (parsed.success) void harness.executor(parsed.data as Parameters<typeof harness.executor>[0]);
      },
    };
    const windowShim = {
      addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") bridgeListeners.add(listener); },
      removeEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") bridgeListeners.delete(listener); },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    taskNativeBridgeSink = (message) => {
      const event = { source: parentShim, data: { pluginMessage: message } } as unknown as MessageEvent;
      bridgeListeners.forEach((listener) => listener(event));
    };
    vi.stubGlobal("window", windowShim);
    vi.stubGlobal("parent", parentShim);
    const { taskNativeVisualRepairBridge } = await import("../src/ui/task-native-bridge");
    const bridgedRepair = await taskNativeVisualRepairBridge(
      repairRequest as Extract<UIToPluginMessage, { type: "task-native-visual-repair" }>, new AbortController().signal,
    );
    expect(bridgedRepair.type).toBe("task-native-visual-repair-result");
    const repairMessage = harness.messages.at(-1);
    expect(repairMessage?.type).toBe("task-native-visual-repair-result");
    if (repairMessage?.type !== "task-native-visual-repair-result") return;
    expect(repairMessage.result).toMatchObject({ status: "APPLIED", reason: "none", targetNodeId: target.id, property: "layoutSizingHorizontal" });
    expect(target.layoutSizingHorizontal).toBe(expectedValue);
    expect(repairMessage.result.readbackRevision).not.toBe(mismatch.receipt);
    expect(harness.root.id).toBe(receipt.rootId);
    expect(harness.root.removed).toBe(false);
    expect(harness.mock.page.children).toHaveLength(rootCount);
    expect({ name: harness.unrelated.name, width: harness.unrelated.width, height: harness.unrelated.height, parent: harness.unrelated.parent?.id }).toEqual(unrelatedBefore);

    await harness.executor(repairRequest as Parameters<typeof harness.executor>[0]);
    expect(harness.messages.at(-1)).toMatchObject({ type: "task-native-visual-repair-result", result: { status: "REJECTED", reason: "repair_already_used" } });
    const recheckNonce = "fw5_capture_recheck_01";
    const recheckRequest = UIToPluginSchema.parse({ ...originalCapture, requestId: recheckNonce, visualCapture: {
      ...originalCapture.visualCapture, captureNonce: recheckNonce, captureAttempt: 2, previousReceiptId: receipt.receiptId,
      readbackRevision: repairMessage.result.readbackRevision,
    } });
    await harness.executor(recheckRequest as Parameters<typeof harness.executor>[0]);
    expect(harness.messages.at(-1)).toMatchObject({ type: "task-native-visual-capture-result", success: true,
      visualCapture: { receipt: { captureAttempt: 2, previousReceiptId: receipt.receiptId, rootId: receipt.rootId } } });
    expect(harness.mock.exportCalls).toHaveLength(2);
  });

  it("persists the metadata-only capture outcome through the existing Universal task checkpoint owner", async () => {
    const { task, saved, captureVisual } = await runTaskCheckpointCapture();
    const screen = task.universalScreens?.[0];
    expect(captureVisual).toHaveBeenCalledOnce();
    expect(task.status).toBe("completed");
    expect(task.text).toContain("کیفیت بصری تأییدنشده است");
    expect(task.text).toContain("screen-01:1×1px");
    expect(screen?.status).toBe("verified");
    expect(screen?.nativeRootNodeId).toBe("mock-fw5-root-01");
    expect(screen?.nativePageId).toBe("page:current");
    expect(screen?.visualQa).toMatchObject({
      status: "REVIEW_UNAVAILABLE",
      nativeGeometry: "PASS",
      designProgramConsistency: "PASS",
      visualCapture: "CAPTURED",
      visualReview: "VISUAL_REVIEW_UNAVAILABLE",
      repair: { status: "NOT_REQUIRED", attempts: 0 },
      diagnostics: { reviewerCalls: 0, payloadBytes: PNG_BYTES.byteLength, exportMs: 3 },
    });
    expect(screen?.visualQa?.captureReceipt?.contentDigest).toMatch(/^fnv1a64-[a-f0-9]{16}$/u);
    expect(saved.at(-1)?.universalScreens?.[0]?.visualQa).toEqual(screen?.visualQa);
    expect(screen?.visualQa?.captureReceipt).not.toHaveProperty("pngBytes");
    expect(JSON.stringify(saved)).not.toContain('"pngBytes"');
    expect(JSON.stringify(saved)).not.toContain('"0":137');
  });

  it("routes the real captured PNG and bounded native/program context through the task owner's authorized reviewer seam", async () => {
    let reviewInput: VisualReviewRequestV1 | undefined;
    let bytesAtCall: number[] = [];
    const reviewer: VisualReviewerV1 = {
      capabilities: async () => ({ version: 1, kind: "vision", acceptsPng: true, maxBytes: FW5_VISUAL_CAPTURE_LIMITS.maxBytes, maxFindings: 4 }),
      review: async (request) => {
        reviewInput = request;
        bytesAtCall = Array.from(request.pngBytes);
        return {
          version: 1, requestId: request.requestId, receiptId: request.receiptId, taskId: request.taskId,
          screenId: request.screenId, rootId: request.rootId, programFingerprint: request.programFingerprint,
          readbackRevision: request.readbackRevision, kind: "vision", verdict: "findings", confidence: 0.86,
          findings: [{
            findingId: "fw5f-95a4e885", taskId: request.taskId, screenId: request.screenId,
            issueCode: "text_clipped", source: "pixel-review", evidenceSource: "image+native-readback",
            severity: "warning", evidenceRef: `capture:${request.receiptId}`, nodeId: request.nodes.find(({ type }) => type === "TEXT")?.nodeId,
            bounds: { x: 12, y: 12, width: 320, height: 48 }, confidence: 0.86, uncertain: false,
            safeToAutoRepair: false, unrepairableReason: "insufficient_evidence",
          }],
        };
      },
    };
    const { task, saved, mock } = await runTaskCheckpointCapture(false, { reviewer, mode: "review+bounded-repair", nativeBridge: true });
    const rootId = task.universalScreens?.[0]?.nativeRootNodeId;
    const textId = reviewInput?.nodes.find(({ type }) => type === "TEXT")?.nodeId;
    expect(mock?.exportCalls).toHaveLength(1);
    expect(textId).toBeDefined();
    const qa = task.universalScreens?.[0]?.visualQa;
    expect(bytesAtCall, JSON.stringify(qa)).toEqual(Array.from(PNG_BYTES));
    expect(reviewInput).toMatchObject({
      taskId: "fw5-checkpoint-task-001", screenId: "screen-01", rootId,
      program: { language: "fa-IR", direction: "rtl", screenId: "screen-01" },
      nodes: expect.arrayContaining([expect.objectContaining({ nodeId: rootId, type: "FRAME" }), expect.objectContaining({ nodeId: textId, type: "TEXT" })]),
    });
    expect(qa).toMatchObject({
      status: "ISSUES_DETECTED",
      visualReview: "REVIEWED",
      findingCounts: { pixelReview: 1 },
      findings: [expect.objectContaining({ issueCode: "text_clipped", nodeId: textId, evidenceSource: "image+native-readback" })],
      repair: { status: "REPAIR_BLOCKED", attempts: 0, reason: "no_safe_proposal" },
      diagnostics: { reviewerCalls: 1 },
    });
    expect(task.status).toBe("completed");
    expect(saved.at(-1)?.universalScreens?.[0]?.visualQa).toEqual(qa);
    expect(JSON.stringify(saved)).not.toContain('"pngBytes"');
    expect(reviewInput?.pngBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("runs one authorized visual sizing repair through fresh readback, second capture, and final review in the task owner", async () => {
    let includeUnsupportedFinding = false;
    const reviewer: VisualReviewerV1 = {
      capabilities: async () => ({ version: 1, kind: "vision", acceptsPng: true, maxBytes: FW5_VISUAL_CAPTURE_LIMITS.maxBytes, maxFindings: 4 }),
      review: vi.fn(async (request) => request.receiptId.endsWith("_a2") ? ({
        version: 1, requestId: request.requestId, receiptId: request.receiptId, taskId: request.taskId,
        screenId: request.screenId, rootId: request.rootId, programFingerprint: request.programFingerprint,
        readbackRevision: request.readbackRevision, kind: "vision", verdict: "pass", confidence: 0.94, findings: [],
      }) : ({
        version: 1, requestId: request.requestId, receiptId: request.receiptId, taskId: request.taskId,
        screenId: request.screenId, rootId: request.rootId, programFingerprint: request.programFingerprint,
        readbackRevision: request.readbackRevision, kind: "vision", verdict: "findings", confidence: 0.94,
        findings: [{
          findingId: "fw5f-0123abcd", taskId: request.taskId, screenId: request.screenId,
          issueCode: "native_layout_sizing_mismatch", source: "pixel-review", evidenceSource: "image+native-readback",
          severity: "error", evidenceRef: `capture:${request.receiptId}`, nodeId: "mock-fw5-frame-01",
          confidence: 0.95, uncertain: false, safeToAutoRepair: true, suggestedRepairCategory: "layout-sizing",
          proposedAction: { kind: "fw4-sizing", targetNodeId: "mock-fw5-frame-01", property: "layoutSizingHorizontal", expectedValue: "HUG", proposedValue: "FIXED" },
        }, ...(includeUnsupportedFinding ? [{
          findingId: "fw5f-95a4e885", taskId: request.taskId, screenId: request.screenId,
          issueCode: "text_clipped" as const, source: "pixel-review" as const, evidenceSource: "image+native-readback" as const,
          severity: "warning" as const, evidenceRef: `capture:${request.receiptId}`, nodeId: "mock-fw5-text-01",
          confidence: 0.88, uncertain: false, safeToAutoRepair: false,
          unrepairableReason: "insufficient_evidence" as const,
        }] : [])],
      })),
    };
    const repairVisual = vi.fn(async (message: Extract<UIToPluginMessage, { type: "task-native-visual-repair" }>) => ({
      type: "task-native-visual-repair-result" as const,
      result: { version: 1 as const, requestId: message.request.requestId, taskId: message.request.taskId,
        screenId: message.request.screenId, rootId: message.request.rootId, captureReceiptId: message.request.captureReceiptId,
        status: "APPLIED" as const, reason: "none" as const, readbackRevision: "v1-89abcdef",
        targetNodeId: "mock-fw5-frame-01", property: "layoutSizingHorizontal" as const },
    }));
    const { task, saved, captureVisual } = await runTaskCheckpointCapture(false, {
      reviewer, mode: "review+bounded-repair", geometryMismatch: true, repairVisual,
    });
    const qa = task.universalScreens?.[0]?.visualQa;
    expect(repairVisual).toHaveBeenCalledOnce();
    expect(captureVisual).toHaveBeenCalledTimes(2);
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    expect(task.status).toBe("completed");
    expect(task.universalScreens?.[0]?.status).toBe("verified");
    expect(task.universalScreens?.[0]?.nativeRootNodeId).toBe("mock-fw5-root-01");
    expect(qa).toMatchObject({
      status: "VISUAL_QA_PASSED", nativeGeometry: "PASS", designProgramConsistency: "PASS",
      beforeReceiptId: expect.stringMatching(/^fw5-/u), afterReceiptId: expect.stringMatching(/_a2$/u),
      repair: { status: "APPLIED", attempts: 1, reason: "none", method: "fw4-sizing-convergence" },
      diagnostics: { reviewerCalls: 2, repairAttempts: 1, repairMethods: ["layoutSizingHorizontal"] },
      findings: expect.arrayContaining([expect.objectContaining({ issueCode: "native_layout_sizing_mismatch", resolution: "repaired" })]),
    });
    expect(saved.some((snapshot) => snapshot.universalScreens?.[0]?.visualQa?.status === "RECHECK_PENDING")).toBe(true);
    expect(saved.at(-1)?.universalScreens?.[0]?.visualQa).toEqual(qa);
    expect(JSON.stringify(saved)).not.toContain('"pngBytes"');

    includeUnsupportedFinding = true;
    const partial = await runTaskCheckpointCapture(false, { reviewer, mode: "review+bounded-repair", geometryMismatch: true, repairVisual });
    const partialQa = partial.task.universalScreens?.[0]?.visualQa;
    expect(partialQa).toMatchObject({
      status: "ISSUES_DETECTED",
      repair: { status: "APPLIED", attempts: 1, method: "fw4-sizing-convergence" },
      findings: expect.arrayContaining([
        expect.objectContaining({ findingId: "fw5f-0123abcd", resolution: "repaired" }),
        expect.objectContaining({ findingId: "fw5f-95a4e885", issueCode: "text_clipped", resolution: "unrepaired" }),
      ]),
      findingCounts: { pixelReview: 2 },
    });
    expect(partial.task.status).toBe("completed");
    expect(partial.task.universalScreens?.[0]?.nativeRootNodeId).toBe("mock-fw5-root-01");
    expect(partial.saved.at(-1)?.universalScreens?.[0]?.visualQa).toEqual(partialQa);
    expect(JSON.stringify(partial.saved)).not.toContain('"pngBytes"');

    includeUnsupportedFinding = false;
    vi.mocked(reviewer.review).mockClear();
    const failedRecheck = await runTaskCheckpointCapture(false, {
      reviewer, mode: "review+bounded-repair", geometryMismatch: true, repairVisual, recheckCaptureFails: true,
    });
    expect(failedRecheck.captureVisual).toHaveBeenCalledTimes(2);
    expect(reviewer.review).toHaveBeenCalledOnce();
    expect(failedRecheck.task.universalScreens?.[0]).toMatchObject({
      status: "verified", nativeRootNodeId: "mock-fw5-root-01",
      visualQa: { status: "RECHECK_FAILED", visualCapture: "CAPTURE_FAILED", nativeGeometry: "PASS" },
    });
  });

  it("wires the consented Companion adapter through typed issue, repair, recheck, and checkpoint using only a fake fetch", async () => {
    const repairVisual = vi.fn(async (message: Extract<UIToPluginMessage, { type: "task-native-visual-repair" }>) => ({
      type: "task-native-visual-repair-result" as const,
      result: { version: 1 as const, requestId: message.request.requestId, taskId: message.request.taskId,
        screenId: message.request.screenId, rootId: message.request.rootId, captureReceiptId: message.request.captureReceiptId,
        status: "APPLIED" as const, reason: "none" as const, readbackRevision: "v1-89abcdef",
        targetNodeId: "mock-fw5-frame-01", property: "layoutSizingHorizontal" as const },
    }));
    const { task, saved, captureVisual, providerPrompts, providerRequests, providerFetcher } = await runTaskCheckpointCapture(false, {
      providerAdapter: true, mode: "review+bounded-repair", geometryMismatch: true, repairVisual,
    });
    const screen = task.universalScreens?.[0];
    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain("screen-01");
    expect(providerPrompts[0]).toContain("mock-fw5-root-01");
    expect(providerPrompts[0]).toContain("the initial screenshot");
    expect(providerPrompts[1]).toContain("the post-repair recheck screenshot");
    expect(providerFetcher).toHaveBeenCalledTimes(2);
    expect(providerRequests.map(({ imageRevision }) => imageRevision)).toEqual([1, 2]);
    expect(providerRequests.every(({ consentImageCount, pngBase64, provider, model }) =>
      consentImageCount === 1 && pngBase64 === ONE_PIXEL_PNG && provider === "openai-responses" && model === "account-model")).toBe(true);
    expect(repairVisual).toHaveBeenCalledOnce();
    expect(captureVisual).toHaveBeenCalledTimes(2);
    expect(task.status).toBe("completed");
    expect(screen).toMatchObject({ status: "verified", nativeRootNodeId: "mock-fw5-root-01", visualQa: {
      status: "VISUAL_QA_PASSED", visualReview: "REVIEWED", repair: { status: "APPLIED", attempts: 1 },
      beforeReceiptId: expect.any(String), afterReceiptId: expect.any(String),
      diagnostics: { reviewerCalls: 2, repairAttempts: 1 },
    } });
    expect(saved.some((snapshot) => snapshot.universalScreens?.[0]?.visualQa?.status === "RECHECK_PENDING")).toBe(true);
    expect(saved.at(-1)?.universalScreens?.[0]?.visualQa).toEqual(screen?.visualQa);
    expect(JSON.stringify(saved)).not.toContain('"pngBytes"');
    expect(JSON.stringify(saved)).not.toContain(ONE_PIXEL_PNG);
  });

  it("keeps the Universal task gate-off path free of captures, reviews, and FW-5 checkpoint fields", async () => {
    const reviewer: VisualReviewerV1 = {
      capabilities: vi.fn(async () => ({ version: 1, kind: "vision", acceptsPng: true, maxBytes: 1_024, maxFindings: 2 })),
      review: vi.fn(async () => { throw new Error("Gate-off must not call the reviewer."); }),
    };
    const repairVisual = vi.fn(async () => { throw new Error("Gate-off must not dispatch repair."); });
    const { task, saved, captureVisual } = await runTaskCheckpointCapture(false, {
      gateEnabled: false, reviewer, mode: "review+bounded-repair", repairVisual,
    });
    expect(task.status).toBe("completed");
    expect(task.universalScreens?.[0]?.status).toBe("verified");
    expect(captureVisual).not.toHaveBeenCalled();
    expect(reviewer.capabilities).not.toHaveBeenCalled();
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(repairVisual).not.toHaveBeenCalled();
    expect(task.universalScreens?.[0]?.visualQa).toBeUndefined();
    expect(saved.every((snapshot) => snapshot.universalScreens?.every((screen) => !Object.hasOwn(screen, "visualQa")))).toBe(true);
  });

  it("does not invoke the image reviewer when request-scoped consent is absent", async () => {
    const reviewer: VisualReviewerV1 = {
      capabilities: vi.fn(async () => ({ version: 1, kind: "vision", acceptsPng: true, maxBytes: 1_024, maxFindings: 2 })),
      review: vi.fn(async () => { throw new Error("Reviewer must not run without explicit authorization."); }),
    };
    const { task } = await runTaskCheckpointCapture(false, { reviewer, consent: false, mode: "review" });
    expect(reviewer.capabilities).not.toHaveBeenCalled();
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(task.universalScreens?.[0]?.visualQa).toMatchObject({ status: "REVIEW_UNAVAILABLE", visualReview: "VISUAL_REVIEW_CONSENT_REQUIRED", diagnostics: { reviewerCalls: 0, failureReason: "VISUAL_REVIEW_CONSENT_REQUIRED" } });
  });

  it("preserves native completion while persisting CAPTURE_FAILED as a separate visual result", async () => {
    const { task, saved, captureVisual } = await runTaskCheckpointCapture(true);
    const screen = task.universalScreens?.[0];
    expect(captureVisual).toHaveBeenCalledOnce();
    expect(task.status).toBe("completed");
    expect(task.text).toContain("بازبینی بصری کامل نشد");
    expect(screen?.status).toBe("verified");
    expect(screen?.visualQa).toMatchObject({
      status: "CAPTURE_FAILED",
      nativeGeometry: "PASS",
      designProgramConsistency: "PASS",
      visualCapture: "CAPTURE_FAILED",
      visualReview: "VISUAL_REVIEW_UNAVAILABLE",
      repair: { status: "NOT_REQUIRED", attempts: 0 },
      captureReceipt: { status: "CAPTURE_FAILED", diagnostic: "export_failed", byteLength: 0 },
    });
    expect(saved.at(-1)?.universalScreens?.[0]?.visualQa).toEqual(screen?.visualQa);
    expect(JSON.stringify(saved)).not.toContain('"pngBytes"');
  });

  it("keeps F1, F3, and F10 native roots isolated with one bounded capture per fresh screen", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_FW5_VISUAL_QA", FW5_FEATURE);
    vi.stubEnv("VITE_FW4_GEOMETRY", "");
    vi.stubEnv("VITE_FW2_CONTEXT", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { runFw5VisualQaBenchmark } = await import("./fixtures/fw5-visual-qa-benchmark");
    const report = await runFw5VisualQaBenchmark();
    log.mockRestore();
    for (const scenario of report.scenarios) {
      if (!("roots" in scenario) || !["F1", "F3", "F10"].includes(scenario.scenario)) continue;
      expect(scenario.execution).toBe("LOCAL_FAKE_FIGMA_RUNTIME");
      expect(scenario.measured.nativePngExportCalls).toBe(scenario.screenCount);
      expect(scenario.measured.nativeReadbackRequests).toBe(scenario.screenCount);
      expect(scenario.measured.peakInFlightOperations).toBe(1);
      expect(scenario.measured.errors).toBe(0);
      expect(new Set(scenario.roots.map(({ nodeId }) => nodeId)).size).toBe(scenario.screenCount);
      expect(scenario.roots.every(({ parentId }) => parentId === "page:current")).toBe(true);
      expect(scenario.outcomes.every(({ visualCapture, visualReview, overallVisualStatus }) =>
        visualCapture === "CAPTURED" && visualReview === "VISUAL_REVIEW_UNAVAILABLE" && overallVisualStatus === "UNVERIFIED")).toBe(true);
    }
  });
});
