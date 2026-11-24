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

const pluginBundle = readFileSync(new URL("../dist/plugin.js", import.meta.url), "utf8");
const uiHtml = readFileSync(new URL("../dist/ui.html", import.meta.url), "utf8");
const bundledBuildId = uiHtml.match(/__fadBuildId=["']([^"']{1,100})["']/u)?.[1]
  ?? pluginBundle.match(/git-[A-Za-z0-9._:+-]{1,100}/u)?.[0]
  ?? "source-unknown";
let compiledUiBridge = "";

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
    const boot = () => {
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
      runInContext(pluginBundle, context);
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
      await handshake("vm-shop-runtime-reload", bundledBuildId);
      const confirmation = await uiBridge({ type: "chat-task-load", requestId: "vm-shop-confirm", ...scope, confirm: shopRevision });
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

  it("encodes and decodes base64 without btoa or atob", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64(bytes);

    expect(encoded).toBe("AAEC/f7/");
    expect([...embeddedImageBytes(encoded)]).toEqual([...bytes]);
    expect(brandAssetContentHash(encoded)).toBe("605157d4");
  });
});
