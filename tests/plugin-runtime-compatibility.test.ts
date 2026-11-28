import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { brandAssetContentHash } from "../src/shared/brand-kit";
import { encodeBase64, embeddedImageBytes } from "../src/shared/visual-assets";
import { ChatTaskSchema } from "../src/shared/chat-task";
import { checkpointJson, checkpointRevision } from "../src/shared/chat-checkpoint-wire";
import { FW2_FEATURE } from "../src/shared/design-context";
import { parseProjectPlanDraft, universalJobManifestFingerprint } from "../src/shared/universal-design";
import { chatHistoryBridge } from "../src/ui/chat-task-bridge";
import type { chatTaskBridge as chatTaskBridgeType } from "../src/ui/chat-task-bridge";
import { createMockApi } from "./figma-mock";
import { designProgramFixtures } from "./fixtures/design-programs";
import { projectNativeLayoutExpectations } from "../src/shared/fw4-geometry";
import type { taskNativeBridge as taskNativeBridgeType } from "../src/ui/task-native-bridge";
import { DesignProgramV1Schema } from "../src/shared/design-program";
import type { renderDesignProgramBridge as renderDesignProgramBridgeType } from "../src/ui/design-program-bridge";

const pluginBundle = readFileSync(new URL("../dist/plugin.js", import.meta.url), "utf8");
const uiHtml = readFileSync(new URL("../dist/ui.html", import.meta.url), "utf8");
const bundledBuildId = uiHtml.match(/__fadBuildId=["']([^"']{1,100})["']/u)?.[1]
  ?? uiHtml.match(/git-[a-f0-9]{12}-[a-f0-9]{64}/u)?.[0]
  ?? pluginBundle.match(/git-[A-Za-z0-9._:+-]{1,100}/u)?.[0]
  ?? "source-unknown";
let compiledUiBridge = "";
let compiledTaskNativeBridge = "";
let compiledDesignProgramBridge = "";

beforeAll(async () => {
  const output = await build({
    configFile: fileURLToPath(new URL("../vite.ui.config.ts", import.meta.url)),
    define: { "import.meta.env.VITE_FW7_BUILD_ID": JSON.stringify(bundledBuildId) },
    build: {
      write: false,
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(new URL("../src/ui/chat-task-bridge.ts", import.meta.url)),
        name: "FadCompiledUiBridge",
        formats: ["iife"],
        fileName: () => "ui-bridge.js",
      },
    },
  });
  const chunks = Array.isArray(output)
    ? output.flatMap((result) => "output" in result ? result.output : [])
    : "output" in output ? output.output : [];
  compiledUiBridge = chunks.find((chunk) => chunk.type === "chunk")?.code ?? "";
  if (!compiledUiBridge) throw new Error("Vite did not emit the compiled UI bridge harness.");

  const taskOutput = await build({
    configFile: fileURLToPath(new URL("../vite.ui.config.ts", import.meta.url)),
    define: { "import.meta.env.VITE_FW7_BUILD_ID": JSON.stringify(bundledBuildId) },
    build: {
      write: false,
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(new URL("../src/ui/task-native-bridge.ts", import.meta.url)),
        name: "FadCompiledTaskNativeBridge",
        formats: ["iife"],
        fileName: () => "task-native-bridge.js",
      },
    },
  });
  const taskChunks = Array.isArray(taskOutput)
    ? taskOutput.flatMap((result) => "output" in result ? result.output : [])
    : "output" in taskOutput ? taskOutput.output : [];
  compiledTaskNativeBridge = taskChunks.find((chunk) => chunk.type === "chunk")?.code ?? "";
  if (!compiledTaskNativeBridge) throw new Error("Vite did not emit the compiled native task bridge harness.");

  const designOutput = await build({
    configFile: fileURLToPath(new URL("../vite.ui.config.ts", import.meta.url)),
    define: { "import.meta.env.VITE_FW7_BUILD_ID": JSON.stringify(bundledBuildId) },
    build: {
      write: false,
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(new URL("../src/ui/design-program-bridge.ts", import.meta.url)),
        name: "FadCompiledDesignProgramBridge",
        formats: ["iife"],
        fileName: () => "design-program-bridge.js",
      },
    },
  });
  const designChunks = Array.isArray(designOutput)
    ? designOutput.flatMap((result) => "output" in result ? result.output : [])
    : "output" in designOutput ? designOutput.output : [];
  compiledDesignProgramBridge = designChunks.find((chunk) => chunk.type === "chunk")?.code ?? "";
  if (!compiledDesignProgramBridge) throw new Error("Vite did not emit the compiled DesignProgram bridge harness.");
});

function savedFingerprint(value: unknown): string {
  const json = checkpointJson(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < json.length; index++) {
    hash ^= BigInt(json.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

describe("Figma main sandbox runtime compatibility", () => {
  it("re-reads the same attached root through the compiled UI/plugin bridge after transient geometry loss", async () => {
    const mock = createMockApi();
    const unrelated = mock.api.createFrame();
    unrelated.name = "Unrelated canvas layer";
    mock.page.appendChild(unrelated as never);
    const pageData = new Map<string, string>();
    Object.assign(mock.page, {
      getPluginData: (key: string) => pageData.get(key) ?? "",
      setPluginData: (key: string, value: string) => pageData.set(key, value),
    });
    const messages: Array<Record<string, unknown>> = [];
    const events = new EventTarget();
    const pluginLog = vi.fn();
    const figma = mock.api as unknown as {
      showUI: ReturnType<typeof vi.fn>;
      ui: { onmessage?: unknown; postMessage: (message: unknown) => void };
      fileKey: string;
      currentPage: { id: string };
    };
    figma.showUI = vi.fn();
    let injectedRepairCount: number | undefined = 2;
    figma.ui = {
      onmessage: undefined,
      postMessage: (message) => {
        const reply = message as Record<string, unknown>;
        if (injectedRepairCount !== undefined && reply.type === "design-program-render-result" && reply.success === true) {
          // The renderer may combine a scroll-body fit with bounded sizing
          // convergence. The schema's old maximum of one rejected this real
          // producer shape after native attachment and ownership adoption.
          reply.geometryRepairs = injectedRepairCount;
          injectedRepairCount = undefined;
        }
        messages.push(reply);
        events.dispatchEvent(new MessageEvent("message", { data: { pluginMessage: reply } }));
      },
    };
    const context = createContext({
      figma,
      __html__: uiHtml,
      setTimeout,
      clearTimeout,
      console: { log: pluginLog, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }, { codeGeneration: { strings: false, wasm: false } });
    runInContext(pluginBundle, context);
    const pluginRequest = (context as unknown as { figma: { ui: { onmessage: (message: unknown) => Promise<void> } } }).figma.ui.onmessage;

    const source = designProgramFixtures[0]!;
    const program = DesignProgramV1Schema.parse({
      ...source,
      id: "compiled-boundary",
      screens: source.screens.map((screen) => ({ ...screen, id: "screen-01" })),
    });
    const taskId = "compiled-native-task-01";
    const documentId = `${figma.fileKey}-${figma.currentPage.id.replaceAll(":", "_")}`;
    const renderUiContext = createContext({
      window: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
      parent: { postMessage: ({ pluginMessage }: { pluginMessage: unknown }) => { void pluginRequest(pluginMessage); } },
      setTimeout,
      clearTimeout,
      console: { info: vi.fn(), log: vi.fn() },
      MessageEvent,
    });
    runInContext(compiledDesignProgramBridge, renderUiContext);
    const renderBridge = (renderUiContext as unknown as {
      FadCompiledDesignProgramBridge: { renderDesignProgramBridge: typeof renderDesignProgramBridgeType };
    }).FadCompiledDesignProgramBridge.renderDesignProgramBridge;
    const renderPromise = renderBridge({
      type: "design-program-render",
      requestId: "compiled-render-request-01",
      taskId,
      documentId,
      program,
    });
    const renderOutcome = await renderPromise.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    const rendered = messages.find((message) => message.type === "design-program-render-result") as {
      success?: boolean; nativeRootNodeId?: string; rootRef?: string; screenId?: string; programFingerprint?: string;
      nativeNodeCount?: number; geometryRepairs?: number; nativeParentNodeId?: string; uiBuildId?: string; pluginBuildId?: string;
    } | undefined;
    expect(rendered).toMatchObject({ success: true, geometryRepairs: 2 });
    expect(mock.nodes.find(({ id }) => id === rendered?.nativeRootNodeId)?.parent?.id).toBe(mock.page.id);
    expect(mock.nodes.find(({ id }) => id === rendered?.nativeRootNodeId)?.getPluginData("fad.tool.task-id.v1")).toBe(taskId);
    expect("error" in renderOutcome ? renderOutcome.error : undefined,
      JSON.stringify("error" in renderOutcome ? renderOutcome.error : undefined)).toBeUndefined();
    if (!("response" in renderOutcome)) throw new Error("The compiled render bridge returned no acknowledgement.");
    expect(renderOutcome.response).toMatchObject({ success: true, geometryRepairs: 2 });
    expect(rendered, JSON.stringify({ rendered, logs: pluginLog.mock.calls })).toMatchObject({ success: true, screenId: "screen-01" });
    const originalRootId = rendered!.nativeRootNodeId!;
    expect(rendered).toMatchObject({ nativeParentNodeId: mock.page.id, uiBuildId: bundledBuildId, pluginBuildId: bundledBuildId });
    injectedRepairCount = 14;
    const invalidAckOutcome = await renderBridge({
      type: "design-program-render", requestId: "compiled-render-request-02", taskId, documentId, program,
    }).then((response) => ({ response }), (error: unknown) => ({ error }));
    expect(invalidAckOutcome).toMatchObject({ error: {
      code: "native_render_ack_invalid_with_attachment",
      attachmentEvidence: { nativeRootNodeId: originalRootId, nativeParentNodeId: mock.page.id, nativeNodeCount: rendered!.nativeNodeCount },
    } });
    const screenRootsAfterInvalidAck = mock.page.children.filter((node) => node.getPluginData("fad.multi-screen.batch-id") === program.id &&
      node.getPluginData("fad.multi-screen.screen-id") === "screen-01");
    expect(screenRootsAfterInvalidAck.map(({ id }) => id)).toEqual([originalRootId]);
    const rootsBeforeStaleBuild = mock.page.children.filter((node) => node.getPluginData("fad.multi-screen.batch-id") === program.id);
    await pluginRequest({ type: "design-program-render", requestId: "compiled-render-request-03", taskId,
      documentId, uiBuildId: "stale-ui-build", program });
    expect(messages.at(-1)).toMatchObject({ type: "design-program-render-result", requestId: "compiled-render-request-03",
      taskId, success: false, errorCode: "runtime_build_mismatch", pluginBuildId: bundledBuildId });
    expect(mock.page.children.filter((node) => node.getPluginData("fad.multi-screen.batch-id") === program.id)
      .map(({ id }) => id)).toEqual(rootsBeforeStaleBuild.map(({ id }) => id));
    const originalNodeIds = mock.nodes.map(({ id }) => id).sort();
    const textNode = mock.nodes.find((node) => node.type === "TEXT")!;
    const originalBounds = Object.getOwnPropertyDescriptor(textNode, "absoluteRenderBounds")!;
    let boundsReads = 0;
    Object.defineProperty(textNode, "absoluteRenderBounds", {
      configurable: true,
      get() {
        boundsReads++;
        return boundsReads === 1 ? null : originalBounds.get!.call(textNode);
      },
    });

    const uiContext = createContext({
      window: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
      parent: {
        postMessage: ({ pluginMessage }: { pluginMessage: unknown }) => { void pluginRequest(pluginMessage); },
      },
      setTimeout,
      clearTimeout,
      console: { info: vi.fn(), log: vi.fn() },
      MessageEvent,
    });
    runInContext(compiledTaskNativeBridge, uiContext);
    const bridge = (uiContext as unknown as {
      FadCompiledTaskNativeBridge: { taskNativeBridge: typeof taskNativeBridgeType };
    }).FadCompiledTaskNativeBridge.taskNativeBridge;
    const readback = await bridge({
      type: "task-native-inspect",
      requestId: "compiled-inspect-request-01",
      documentId,
      taskId,
      refs: [rendered!.rootRef!],
      geometry: {
        programFingerprint: rendered!.programFingerprint!,
        requireReceipt: true,
        screenId: "screen-01",
        expectedRootNodeId: originalRootId,
        expectedLayout: projectNativeLayoutExpectations(program, "screen-01"),
      },
    });

    expect(readback).toMatchObject({
      type: "task-native-inspection-result", success: true, expectedRootStatus: "present",
      geometry: { coverage: "complete", readAttempts: 2 },
    });
    expect(boundsReads).toBeGreaterThanOrEqual(2);
    expect(mock.nodes.find(({ id }) => id === originalRootId)?.parent?.id).toBe(mock.page.id);
    expect(mock.nodes.map(({ id }) => id).sort()).toEqual(originalNodeIds);
    expect(mock.page.children.filter((node) => node.getPluginData("fad.multi-screen.batch-id")).map(({ id }) => id))
      .toEqual([originalRootId]);
    expect(unrelated.parent?.id).toBe(mock.page.id);
    expect(messages.filter((message) => message.type === "design-program-render-result")).toHaveLength(3);
    expect(messages.filter((message) => message.type === "task-native-inspection-result")).toHaveLength(1);
  });

  it("executes the built plugin and verifies checkpoint receipts across a controller reload", async () => {
    const page = {
      id: "page-1",
      name: "Page 1",
      selection: [],
      children: [],
      findAll: () => [],
      getPluginData: () => "",
      setPluginData: vi.fn(),
      on: vi.fn(),
    };
    const root = {
      id: "file-1",
      children: [page],
      getPluginData: () => "",
      setPluginData: vi.fn(),
    };
    const storage = new Map<string, string>();
    const figma = {
      showUI: vi.fn(),
      ui: { onmessage: undefined as unknown, postMessage: vi.fn() },
      currentPage: page,
      root,
      fileKey: "file-1",
      mode: "default",
      editorType: "figma",
      on: vi.fn(),
      clientStorage: {
        getAsync: vi.fn(async (key: string) => {
          const value = storage.get(key);
          return value === undefined ? undefined : JSON.parse(value);
        }),
        setAsync: vi.fn(async (key: string, value: unknown) => {
          storage.set(key, JSON.stringify(value));
        }),
        deleteAsync: vi.fn(async (key: string) => { storage.delete(key); }),
        keysAsync: vi.fn(async () => []),
      },
    };
    const sandbox = {
      figma,
      Intl: undefined,
      setTimeout,
      clearTimeout,
      console: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const boot = (bundle = pluginBundle) => {
      const context = createContext({ ...sandbox }, { codeGeneration: { strings: false, wasm: false } });
      expect(runInContext("typeof Intl", context)).toBe("undefined");
      // Exercise a sandbox whose collation differs from the UI's. A persisted
      // fingerprint must be independent of either process's locale ordering.
      runInContext(`String.prototype.localeCompare = function (other) {
        const left = String(this), right = String(other);
        return left < right ? 1 : left > right ? -1 : 0;
      };
      // Exercise a sandbox with a divergent unsigned BigInt result. The bridge's
      // stable checkpoint hash uses 32-bit operations and remains unaffected.
      const originalAsUintN = BigInt.asUintN;
      BigInt.asUintN = (bits, value) => originalAsUintN(bits, value) ^ 1n;`, context);
      runInContext(bundle, context);
    };

    expect(boot).not.toThrow();
    expect(figma.showUI).toHaveBeenCalledOnce();
    expect(figma.showUI.mock.calls[0]?.[0]).toBe(uiHtml);
    expect(typeof figma.ui.onmessage).toBe("function");
    const request = (message: unknown) =>
      (figma.ui.onmessage as (value: unknown) => Promise<void>)(message);
    const result = () => figma.ui.postMessage.mock.lastCall?.[0];
    const handshake = (requestId: string, buildId: string) => request({
      type: "plugin-runtime-handshake", requestId, protocolVersion: 1, buildId,
    });
    if (process.env.FAD_PREVIOUS_ARTIFACTS) {
      const previousUi = readFileSync(`${process.env.FAD_PREVIOUS_ARTIFACTS}/ui.html`, "utf8");
      const previousPlugin = readFileSync(`${process.env.FAD_PREVIOUS_ARTIFACTS}/plugin.js`, "utf8");
      const previousId = previousUi.match(/git-[a-f0-9]{12}-[a-f0-9]{64}/u)?.[0];
      expect(previousId).toBeTruthy();
      expect(previousId).not.toBe(bundledBuildId);
      boot(previousPlugin);
      expect(figma.showUI.mock.lastCall?.[0]).toBe(previousUi);
      await handshake("vm-current-ui-old-controller", bundledBuildId);
      expect(result()).toMatchObject({ compatible: false, uiBuildId: bundledBuildId, pluginBuildId: previousId });
      await request({ type: "chat-task-load", requestId: "vm-real-mixed-bundles" });
      expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_build_mismatch" });
      boot();
      await handshake("vm-old-ui-current-controller", previousId!);
      expect(result()).toMatchObject({ compatible: false, uiBuildId: previousId, pluginBuildId: bundledBuildId });
      expect(figma.clientStorage.setAsync).not.toHaveBeenCalled();
    }
    await request({
      type: "design-context-read", requestId: "vm-context-01", feature: FW2_FEATURE,
      taskId: "task-vm-01", documentId: "file-1-page-1", intent: "create",
      prompt: "Create a screen. Use the selection as design context.", scope: "selection",
    });
    expect(result()).toMatchObject(process.env.VITE_FW2_CONTEXT === FW2_FEATURE
      ? { success: true, snapshot: { nodes: [], resources: [], scope: "selection" } }
      : { success: false, code: "UNSUPPORTED" });
    expect(page.setPluginData).not.toHaveBeenCalled();
    expect(root.setPluginData).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
    await handshake("vm-runtime-stale", "stale-ui-build");
    expect(result()).toMatchObject({ type: "plugin-runtime-handshake-result", compatible: false, uiBuildId: "stale-ui-build", pluginBuildId: bundledBuildId });
    await request({ type: "chat-task-load", requestId: "vm-no-handshake", documentId: "file-1-page-1" });
    expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_build_mismatch" });
    await handshake("vm-runtime-current", bundledBuildId);
    expect(result()).toMatchObject({ type: "plugin-runtime-handshake-result", compatible: true, uiBuildId: bundledBuildId, pluginBuildId: bundledBuildId });
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "task-vm-01",
      documentId: "file-1-page-1",
      executionRoute: "universal-design-v1",
      prompt: "Storage fixture",
      context: [],
      stages: [],
      ledger: [],
      pending: [],
      recent: [],
      starts: [],
      rounds: 0,
      status: "ready",
      text: "",
      targetName: undefined,
    });
    const scope = { documentId: task.documentId, chatId: "chat-vm-01" };
    const revision = checkpointRevision(checkpointJson(task));
    await request({ type: "chat-task-save", requestId: "vm-save-01", ...scope, task, revision });
    expect(result()).toMatchObject({ success: true, revision });
    expect(result()).not.toHaveProperty("task");

    // setAsync can resolve before the expected value is observable.
    figma.clientStorage.setAsync.mockImplementationOnce(async () => undefined);
    const stale = { ...task, text: "stale-write fixture" };
    await request({
      type: "chat-task-save",
      requestId: "vm-save-02",
      ...scope,
      task: stale,
      revision: checkpointRevision(checkpointJson(stale)),
    });
    expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_read_unconfirmed" });
    await request({ type: "chat-task-save", requestId: "vm-save-invalid", ...scope, task: {} });
    expect(result()).toMatchObject({
      success: false,
      errorCode: "checkpoint_protocol_error",
      requestId: "vm-save-invalid",
    });

    boot();
    await handshake("vm-runtime-reload", bundledBuildId);
    await request({
      type: "chat-task-load",
      requestId: "vm-confirm-01",
      ...scope,
      confirm: revision,
    });
    expect(result()).toMatchObject({ success: true, revision });
    expect(result()).not.toHaveProperty("task");
    await request({ type: "chat-task-load", requestId: "vm-load-01", ...scope });
    expect(result()).toMatchObject({ success: true, task: { id: task.id }, revision });

    const names = ["Shop Browse", "Product Detail"];
    const prompt = "create 2 screen for online shop";
    const planned = parseProjectPlanDraft({
      productPurpose: "Help shoppers browse and evaluate products.",
      projectNarrative: "Show a catalog and a product detail view.",
      audience: "Online shoppers",
      primaryUserGoals: ["Browse products", "Review details"],
      capabilities: [], keyEntities: [], domainTags: ["shop"],
      platform: "mobile", locale: "en-US", direction: "ltr", screenCount: 2,
      styleDirection: "Clear product hierarchy", contentDensity: "medium",
      contentSamplePolicy: "clearly-illustrative", accessibilityMinimums: [],
      componentOpportunities: [], designConstraints: [], knownFacts: [], assumptions: [], nonGoals: [],
      screens: names.map((name, order) => ({
        name, order, role: order ? "details" : "catalog", purpose: name, source: "inferred",
        primaryTask: name, entryState: "Arrive at view", exitState: "Finish reviewing",
        regions: [{ name: "Main", semanticRole: "main", content: "Editable product content", priority: 1 }],
        dataRelationships: [], responsiveConstraints: [], accessibilityNotes: [], entityRefs: [],
        actions: [], states: [], navigationOrders: [], dependencyOrders: [], scroll: "none",
      })),
    }, { taskId: task.id, requestedScreenCount: 2 });
    if (!planned.success) throw new Error("Expected a valid two-screen project plan fixture.");
    const model = "account-visible-model";
    const manifest = {
      version: 1, taskId: task.id, engineRoute: "universal-design-v1", modelSlug: model,
      planFingerprint: planned.fingerprint, designProgramVersion: planned.plan.designProgramVersion,
      platform: planned.plan.platform, locale: planned.plan.locale, direction: planned.plan.direction,
      screens: planned.plan.screens.map(({ screenId, order, name, role, dependencies }) => ({ screenId, order, name, role, dependencies })),
      skills: [], capabilities: planned.plan.capabilityFlags,
      layoutCapabilities: ["auto-layout", "fill-and-hug-sizing", "bounded-wrap", "vertical-scroll", "native-components", "editable-text"],
    };
    expect(planned.fingerprint).toBe(`ppv1-${savedFingerprint(planned.plan)}`);
    expect(universalJobManifestFingerprint(manifest)).toBe(`ujm1-${savedFingerprint(manifest)}`);
    const unicodeManifest = { ...manifest, screens: [{ ...manifest.screens[0]!, name: "صفحهٔ اول 🛍️" }] };
    expect(universalJobManifestFingerprint(unicodeManifest)).toBe(`ujm1-${savedFingerprint(unicodeManifest)}`);
    const shop = ChatTaskSchema.parse({
      ...task, ...scope, model, prompt, intent: "create", status: "running", lifecycle: "UNIVERSAL_COMPOSING",
      projectPlan: planned.plan, projectPlanFingerprint: planned.fingerprint,
      universalManifest: { ...manifest, fingerprint: universalJobManifestFingerprint(manifest) },
      stages: names.map((title) => ({ title, completed: false, operations: 0, rounds: 0 })),
      universalScreens: planned.plan.screens.map(({ screenId }) => ({ screenId, status: "pending" })),
    });
    const shopRevision = checkpointRevision(checkpointJson(shop));
    const events = new EventTarget();
    const sent: unknown[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const routeToPlugin = (pluginMessage: unknown) => {
      const copy = structuredClone(pluginMessage) as { type?: string };
      sent.push(copy);
      void request(copy).then(() => {
        events.dispatchEvent(new MessageEvent("message", { data: { pluginMessage: structuredClone(result()) } }));
      });
    };
    vi.stubGlobal("window", {
      __fadBuildId: bundledBuildId,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    vi.stubGlobal("parent", {
      postMessage: ({ pluginMessage }: { pluginMessage: unknown }) => routeToPlugin(pluginMessage),
    });
    const uiContext = createContext({
      window: {
        __fadBuildId: bundledBuildId,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
      parent: { postMessage: ({ pluginMessage }: { pluginMessage: unknown }) => routeToPlugin(pluginMessage) },
      setTimeout,
      clearTimeout,
      console: { info: vi.fn(), log: vi.fn() },
      performance: globalThis.performance,
      MessageEvent,
    });
    runInContext(compiledUiBridge, uiContext);
    const uiBridge = (uiContext as unknown as { FadCompiledUiBridge: { chatTaskBridge: typeof chatTaskBridgeType } }).FadCompiledUiBridge.chatTaskBridge;
    try {
      const emittedUiWindow = uiContext.window as unknown as { __fadBuildId: string };
      const emittedUiBuildId = emittedUiWindow.__fadBuildId;
      const firstMismatchDispatch = sent.length;
      emittedUiWindow.__fadBuildId = "deliberately-stale-ui-build";
      await expect(uiBridge({
        type: "chat-task-load",
        requestId: "vm-compiled-stale-load",
        ...scope,
      })).rejects.toMatchObject({ code: "checkpoint_build_mismatch" });
      expect(sent.slice(firstMismatchDispatch).map((message) => (message as { type: string }).type))
        .toEqual(["plugin-runtime-handshake"]);
      emittedUiWindow.__fadBuildId = emittedUiBuildId;

      await expect(uiBridge({ type: "chat-task-save", requestId: "vm-shop-save", ...scope, task: shop }))
        .resolves.toMatchObject({ success: true, revision: shopRevision });
      const sentSave = sent.find((message) => Boolean(
        message && typeof message === "object" && "type" in message && message.type === "chat-task-save",
      ));
      expect(sentSave).toMatchObject({ type: "chat-task-save", ...scope, taskJson: checkpointJson(shop), revision: shopRevision });
      expect(sentSave).not.toHaveProperty("task");
      expect((sentSave as { taskJson: string }).taskJson).not.toContain('"targetName"');
      expect((sentSave as { revision: { bytes: number } }).revision.bytes)
        .toBe(new TextEncoder().encode((sentSave as { taskJson: string }).taskJson).byteLength);

      const durable = [...storage.entries()];
      const writes = figma.clientStorage.setAsync.mock.calls.length;
      const secret = "fixture-private-content-must-not-be-logged";
      const malformed = { ...shop, prompt: secret, projectPlan: { ...planned.plan, viewport: { ...planned.plan.viewport, width: 401 } } };
      const badJson = checkpointJson(malformed);
      const truncated = badJson.slice(0, -1);
      await request({ type: "chat-task-save", requestId: "vm-shop-truncated", ...scope, taskJson: truncated, revision: checkpointRevision(truncated) });
      expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_protocol_error" });
      await request({ type: "chat-task-save", requestId: "vm-shop-invalid", ...scope, taskJson: badJson, revision: checkpointRevision(badJson) });
      expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_protocol_error" });
      expect(result()).toHaveProperty("error", expect.stringContaining("chat-task-save during schema validation"));
      expect(result()).toHaveProperty("error", expect.stringContaining("task.projectPlan.viewport.width"));
      expect(result()).toHaveProperty("error", expect.not.stringContaining(secret));
      const diagnostics = sandbox.console.log.mock.calls.flat().join(" ");
      expect(diagnostics).toContain('"event":"rejected"');
      expect(diagnostics).toContain('"phase":"json"');
      expect(diagnostics).toContain('"phase":"schema"');
      expect(diagnostics).toContain("task.projectPlan.viewport.width");
      expect(diagnostics).not.toContain(secret);
      await request({ type: "chat-task-save", requestId: "vm-shop-revision", ...scope, taskJson: checkpointJson(shop), revision: { ...shopRevision, bytes: shopRevision.bytes + 1 } });
      expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_revision_mismatch" });
      const badManifest = checkpointJson({ ...shop, universalManifest: { ...shop.universalManifest, modelSlug: "different-model" } });
      await request({ type: "chat-task-save", requestId: "vm-shop-manifest", ...scope, taskJson: badManifest, revision: checkpointRevision(badManifest) });
      expect(result()).toMatchObject({ success: false, errorCode: "checkpoint_protocol_error", error: expect.stringContaining("task.universalManifest.fingerprint") });
      expect(figma.clientStorage.setAsync).toHaveBeenCalledTimes(writes);
      expect([...storage.entries()]).toEqual(durable);

      boot();
      await expect(uiBridge({ type: "chat-task-load", requestId: "vm-shop-restart", ...scope }))
        .rejects.toMatchObject({ code: "checkpoint_build_mismatch" });
      const afterRejectedLoad = sent.length;
      const confirmation = await uiBridge({ type: "chat-task-load", requestId: "vm-shop-confirm", ...scope, confirm: shopRevision });
      expect(sent.slice(afterRejectedLoad).map((message) => (message as { type: string }).type))
        .toEqual(["plugin-runtime-handshake", "chat-task-load"]);
      expect(confirmation).toMatchObject({ success: true, revision: shopRevision });
      expect(confirmation).not.toHaveProperty("task");
      const recovery = await uiBridge({ type: "chat-task-load", requestId: "vm-shop-recovery", ...scope });
      expect(recovery).toMatchObject({ success: true, revision: shopRevision, task: { id: task.id, stages: names.map((title) => ({ title, completed: false })) } });
      expect(recovery.task?.universalScreens?.map(({ screenId, nativeRootNodeId }) => [screenId, nativeRootNodeId]))
        .toEqual([["screen-01", undefined], ["screen-02", undefined]]);
      expect(figma.clientStorage.deleteAsync).not.toHaveBeenCalled();

      const historyRecord = {
        id: scope.chatId,
        title: "Shop Browse and Product Detail",
        createdAt: 1,
        updatedAt: 2,
        taskState: "running" as const,
        messages: [],
      };
      const savedHistory = await chatHistoryBridge({
        type: "chat-history-upsert", requestId: "vm-shop-history-save",
        documentId: scope.documentId, conversation: historyRecord, activeChatId: scope.chatId,
      });
      expect(savedHistory.history?.conversations).toEqual([historyRecord]);
      const deletedHistory = await chatHistoryBridge({
        type: "chat-history-delete-all", requestId: "vm-shop-history-delete-all", documentId: scope.documentId,
      });
      expect(deletedHistory.history).toEqual({ version: 1, activeChatId: null, conversations: [] });
      expect(storage.has(`fad.chat-task.v2:${scope.documentId}:${scope.chatId}`)).toBe(false);
      expect(storage.get(`fad.chat-history.v1:${scope.documentId}`)).toBe(JSON.stringify({ version: 1, activeChatId: null, conversations: [] }));
      expect(page.children).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      logSpy.mockRestore();
    }
  });

  it("fails promptly when an older plugin rejects the checkpoint handshake", async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    const posted: unknown[] = [];
    const context = createContext({
      window: {
        __fadBuildId: bundledBuildId,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
      parent: {
        postMessage: ({ pluginMessage }: { pluginMessage: { requestId: string; type: string } }) => {
          posted.push(pluginMessage);
          if (pluginMessage.type !== "plugin-runtime-handshake") return;
          events.dispatchEvent(new MessageEvent("message", {
            data: {
              pluginMessage: {
                type: "protocol-error",
                requestId: pluginMessage.requestId,
                message: "The plugin received an invalid request.",
              },
            },
          }));
        },
      },
      setTimeout,
      clearTimeout,
      console: { info: vi.fn(), log: vi.fn() },
    });
    runInContext(compiledUiBridge, context);
    const bridge = (context as unknown as {
      FadCompiledUiBridge: { chatTaskBridge: typeof chatTaskBridgeType };
    }).FadCompiledUiBridge.chatTaskBridge;
    let observed: unknown;
    const outcome = bridge({
      type: "chat-task-load",
      requestId: "stale-plugin-load-01",
      documentId: "file-1-page-1",
    }).then(
      () => { observed = "resolved"; },
      (error: unknown) => { observed = error; },
    );
    try {
      for (let index = 0; index < 6; index++) await Promise.resolve();
      expect(observed).toMatchObject({ code: "checkpoint_build_mismatch" });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ type: "plugin-runtime-handshake" });
      await outcome;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("encodes and decodes base64 without btoa or atob", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64(bytes);

    expect(encoded).toBe("AAEC/f7/");
    expect([...embeddedImageBytes(encoded)]).toEqual([...bytes]);
    expect(brandAssetContentHash(encoded)).toBe("605157d4");
  });
});
