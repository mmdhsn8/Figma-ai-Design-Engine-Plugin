import { describe, expect, it } from "vitest";
import { PluginToUISchema, UIToPluginSchema } from "../src/shared/messages";

describe("plugin message contract", () => {
  it("bounds task-owned native inspection and focus requests and responses", () => {
    expect(
      UIToPluginSchema.safeParse({
        type: "task-native-inspect",
        requestId: "inspect-task-0001",
        documentId: "file-page",
        taskId: "chat-task-0001",
        refs: ["screen-root"],
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "task-native-inspect",
        requestId: "inspect-task-0001",
        documentId: "file-page",
        taskId: "chat-task-0001",
        refs: [],
        includeDocument: true,
      }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({
        type: "task-native-focus",
        requestId: "focus-task-0001",
        documentId: "file-page",
        taskId: "chat-task-0001",
        nodeIds: ["node:1"],
        mode: "select",
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "task-native-inspection-result",
        requestId: "inspect-task-0001",
        success: true,
        taskId: "chat-task-0001",
        nodes: [
          {
            id: "node:1",
            name: "Home screen",
            type: "FRAME",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            visible: true,
          },
        ],
        unresolvedRefs: [],
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it("validates document-scoped chat history operations and scoped checkpoints", () => {
    const conversation = {
      id: "conversation-0001",
      title: "Storefront",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      taskState: "new",
      messages: [],
    };
    expect(
      UIToPluginSchema.safeParse({
        type: "chat-history-upsert",
        requestId: "history-1",
        documentId: "file-page",
        conversation,
        activeChatId: conversation.id,
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "chat-history-delete",
        requestId: "history-2",
        documentId: "file-page",
        chatId: conversation.id,
        deleteCanvas: true,
      }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({
        type: "chat-task-load",
        requestId: "task-load",
        chatId: conversation.id,
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "chat-history-result",
        requestId: "history-load",
        success: true,
        documentId: "file-page",
        history: { version: 1, activeChatId: null, conversations: [] },
      }).success,
    ).toBe(true);
  });

  it("allows only encrypted local restore tickets through Figma client storage messages", () => {
    const sealed = "FADP1T:" + "A".repeat(64);
    expect(UIToPluginSchema.safeParse({ type: "load-companion-restore-ticket" }).success).toBe(
      true,
    );
    expect(
      UIToPluginSchema.safeParse({
        type: "save-companion-restore-ticket",
        requestId: "storage-1",
        ticket: sealed,
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "companion-restore-ticket",
        ticket: sealed,
        storageAvailable: true,
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "save-companion-restore-ticket",
        requestId: "storage-2",
        ticket: "plaintext-bearer-token",
      }).success,
    ).toBe(false);
  });

  it("validates model preference reads and writes without accepting arbitrary IDs", () => {
    expect(
      UIToPluginSchema.safeParse({ type: "load-model-preference", requestId: "pref-load-1" })
        .success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "save-model-preference",
        requestId: "pref-save-1",
        selectedModel: "provider/model-a",
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "save-model-preference",
        requestId: "pref-save-2",
        selectedModel: "provider model with spaces",
      }).success,
    ).toBe(false);
    expect(
      PluginToUISchema.safeParse({
        type: "model-preference-loaded",
        requestId: "pref-load-1",
        state: "valid",
        selectedModel: "provider/model-a",
      }).success,
    ).toBe(true);
  });

  it("accepts typed validate and generate requests", () => {
    expect(
      UIToPluginSchema.safeParse({ type: "validate", requestId: "r1", json: "{}" }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({ type: "generate", requestId: "r2", json: "{}" }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "generate-multi-screen",
        requestId: "r5",
        json: "{}",
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "generate-multi-screen",
        requestId: "r6",
        json: "{}",
        gap: 1_200,
        maxRowWidth: 6_000,
      }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({
        type: "apply-design-system",
        requestId: "r3",
        json: "{}",
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "apply-design-system",
        requestId: "r4",
        json: "{}",
        updateOwned: true,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown request types and extra request properties", () => {
    expect(
      UIToPluginSchema.safeParse({ type: "execute", requestId: "r1", json: "{}" }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({ type: "validate", requestId: "r1", json: "{}", code: "" })
        .success,
    ).toBe(false);
  });

  it("accepts successful render responses", () => {
    expect(
      PluginToUISchema.safeParse({
        type: "render-result",
        requestId: "r3",
        success: true,
        frameName: "Sample",
        counts: { frames: 2, texts: 3, rectangles: 1, components: 1, instances: 1 },
        warnings: [],
        fontSelections: [
          {
            requestedFamily: "Arial",
            requestedStyle: "Regular",
            usedFamily: "Arial",
            usedStyle: "Regular",
            fellBack: false,
          },
        ],
        designSystem: {
          namespace: "apparel-core",
          created: ["style:color.brand.primary"],
          reused: [],
          updated: [],
          skipped: [],
          fallbacks: [],
          warnings: [],
        },
      }).success,
    ).toBe(true);
  });

  it("accepts typed validation counts and rejects malformed render summaries", () => {
    expect(
      PluginToUISchema.safeParse({
        type: "validation-result",
        requestId: "r4",
        success: true,
        counts: { frames: 1, texts: 2, rectangles: 1, components: 0, instances: 0 },
        fontWarnings: ["Font missing during preflight."],
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "render-result",
        requestId: "r5",
        success: true,
        frameName: "Sample",
        counts: { frames: 1, texts: 0, rectangles: 0, components: 0, instances: 0 },
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("accepts multi-screen validation, progress, and per-screen outcome reports", () => {
    expect(
      PluginToUISchema.safeParse({
        type: "validation-result",
        requestId: "r6",
        success: true,
        multiScreen: {
          totalScreens: 1,
          nodeCount: 3,
          screens: [
            {
              id: "home",
              name: "خانه",
              width: 390,
              height: 844,
              devicePreset: "mobile",
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "multi-screen-progress",
        requestId: "r6",
        index: 1,
        total: 1,
        screenId: "home",
        screenName: "خانه",
        status: "generated",
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "multi-screen-result",
        requestId: "r6",
        batchId: "commerce",
        batchName: "Commerce",
        totalScreens: 1,
        generatedScreens: 1,
        failedScreens: 0,
        estimatedNodeCount: 3,
        createdNodeCount: 3,
        gap: 120,
        maxRowWidth: 6_000,
        counts: { frames: 1, texts: 2, rectangles: 0, components: 0, instances: 0 },
        screens: [
          {
            id: "home",
            name: "خانه",
            width: 390,
            height: 844,
            status: "generated",
            counts: { frames: 1, texts: 2, rectangles: 0, components: 0, instances: 0 },
            warnings: [],
          },
        ],
        warnings: [],
        fontSelections: [],
      }).success,
    ).toBe(true);
  });
});
