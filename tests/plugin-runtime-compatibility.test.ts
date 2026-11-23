import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { brandAssetContentHash } from "../src/shared/brand-kit";
import { encodeBase64, embeddedImageBytes } from "../src/shared/visual-assets";
import { ChatTaskSchema } from "../src/shared/chat-task";
import { checkpointJson, checkpointRevision } from "../src/shared/chat-checkpoint-wire";
import { FW2_FEATURE } from "../src/shared/design-context";

const pluginBundle = readFileSync(new URL("../dist/plugin.js", import.meta.url), "utf8");

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
        deleteAsync: vi.fn(async () => undefined),
        keysAsync: vi.fn(async () => []),
      },
    };
    const sandbox = {
      figma,
      Intl: undefined,
      console: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    expect(runInNewContext("typeof Intl", sandbox)).toBe("undefined");
    expect(() => runInNewContext(pluginBundle, sandbox)).not.toThrow();
    expect(figma.showUI).toHaveBeenCalledOnce();
    expect(typeof figma.ui.onmessage).toBe("function");
    const request = (message: unknown) =>
      (figma.ui.onmessage as (value: unknown) => Promise<void>)(message);
    const result = () => figma.ui.postMessage.mock.lastCall?.[0];
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

    runInNewContext(pluginBundle, sandbox);
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
  });

  it("encodes and decodes base64 without btoa or atob", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64(bytes);

    expect(encoded).toBe("AAEC/f7/");
    expect([...embeddedImageBytes(encoded)]).toEqual([...bytes]);
    expect(brandAssetContentHash(encoded)).toBe("605157d4");
  });
});
