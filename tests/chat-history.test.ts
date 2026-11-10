import { describe, expect, it } from "vitest";
import type { ChatTask } from "../src/shared/chat-task";
import {
  chatHistoryMatchesQuery,
  chatHistoryExportJson,
  chatHistoryTitle,
  duplicateChatHistoryConversation,
  newChatHistoryConversation,
  renameChatHistoryConversation,
  ChatHistoryConversationSchema,
  ChatHistoryIndexSchema,
} from "../src/shared/chat-history";
import { handleChatHistoryStorage } from "../src/plugin/chat-history-storage";
import { handleChatTaskStorage } from "../src/plugin/chat-task-storage";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHistoryView } from "../src/ui/chat-history-view";
import type { ChatHistoryConversation } from "../src/shared/chat-history";
import { createMockApi } from "./figma-mock";

const conversation = (id: string, title = "New chat"): ChatHistoryConversation => ({
  id,
  title,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  taskState: "new",
  messages: [],
});

describe("chat history schema and export", () => {
  it("labels an active restored running checkpoint as needing recovery", () => {
    const active = {
      ...conversation("conversation-0001", "Saved task"),
      taskState: "running" as const,
    };
    const html = renderToStaticMarkup(
      createElement(ChatHistoryView, {
        conversations: [active],
        activeChatId: active.id,
        canSwitch: true,
        onNew: () => undefined,
        onOpen: () => undefined,
        onRename: () => undefined,
        onDuplicate: () => undefined,
        onExport: () => undefined,
        onDelete: () => undefined,
      }),
    );
    expect(html).toContain("Current · Needs recovery");
  });

  it("creates, searches, renames, and duplicates conversations without copying task ownership", () => {
    const created = newChatHistoryConversation("conversation-0001", 1_700_000_000_000, "model-a");
    expect(created).toMatchObject({
      title: "New chat",
      taskState: "new",
      model: "model-a",
      messages: [],
    });
    const source = ChatHistoryConversationSchema.parse({
      ...created,
      title: "Storefront",
      taskId: "task-private-id",
      messages: [
        { id: "message-1", role: "user", content: "Create a Persian product page" },
        { id: "message-2", role: "assistant", content: "The page is ready" },
      ],
    });
    expect(chatHistoryMatchesQuery(source, "PERSIAN PRODUCT")).toBe(true);
    expect(chatHistoryMatchesQuery(source, "missing term")).toBe(false);
    expect(renameChatHistoryConversation(source, "  New title  ", 1_700_000_000_100)).toMatchObject(
      {
        title: "New title",
        updatedAt: 1_700_000_000_100,
        taskId: "task-private-id",
      },
    );
    const duplicate = duplicateChatHistoryConversation(
      source,
      "conversation-0002",
      1_700_000_000_200,
    );
    expect(duplicate).toMatchObject({
      title: "Storefront (copy)",
      taskState: "new",
      messages: [
        { id: "conversation-0002-0", role: "user" },
        { id: "conversation-0002-1", role: "assistant" },
      ],
    });
    expect(duplicate).not.toHaveProperty("taskId");
  });

  it("derives a bounded title from the first user message and excludes checkpoint data from exports", () => {
    const messages: ChatHistoryConversation["messages"] = [
      { id: "u1", role: "user", content: "Create a Persian storefront" },
      { id: "a1", role: "assistant", content: "Done" },
    ];
    expect(chatHistoryTitle(messages)).toBe("Create a Persian storefront");
    expect(
      chatHistoryTitle([{ id: "u", role: "user", content: "x".repeat(100) }]).length,
    ).toBeLessThanOrEqual(72);
    const record = ChatHistoryConversationSchema.parse({
      ...conversation("conversation-0001", "Storefront"),
      taskId: "task-private-id",
      messages,
    });
    const exported = chatHistoryExportJson(record);
    expect(exported).toContain("Create a Persian storefront");
    expect(exported).not.toContain("task-private-id");
  });

  it("rejects malformed IDs and oversized message history at the storage boundary", () => {
    expect(ChatHistoryConversationSchema.safeParse(conversation("bad")).success).toBe(false);
    expect(
      ChatHistoryConversationSchema.safeParse({
        ...conversation("conversation-0001"),
        messages: Array.from({ length: 81 }, (_, index) => ({
          id: `message-${index}`,
          role: "user" as const,
          content: "prompt",
        })),
      }).success,
    ).toBe(false);
    const duplicate = conversation("conversation-0001");
    expect(
      ChatHistoryIndexSchema.safeParse({
        version: 1,
        activeChatId: "missing-chat-0001",
        conversations: [duplicate, duplicate],
      }).success,
    ).toBe(false);
  });
});

function scopedTask(api: PluginAPI, id: string, status: ChatTask["status"] = "ready"): ChatTask {
  const documentId = `${api.fileKey}-${api.currentPage.id.replaceAll(":", "_")}`;
  return {
    version: 1,
    id: `task-${id}`,
    referenceScope: "task-v1",
    documentId,
    prompt: "Create an editable mobile storefront.",
    lifecycle: "UNPLANNED",
    modelRoundTrace: [],
    context: [],
    stages: [],
    ledger: [],
    pending: [],
    recent: [],
    starts: [],
    rounds: 0,
    roundBreakdown: {
      prePlan: 0,
      planning: 0,
      execution: 0,
      inspection: 0,
      completion: 0,
      correction: 0,
      continuation: 0,
      modelRetries: 0,
    },
    batches: 0,
    lifecycleTransitions: 0,
    lastResponseCalls: 0,
    validationCorrections: 0,
    referenceCorrections: 0,
    status,
    text: "",
  };
}

describe("document-scoped chat history", () => {
  it("persists concurrent chat upserts without losing other conversations", async () => {
    const mock = createMockApi();
    const documentId = `${mock.api.fileKey}-${mock.api.currentPage.id.replaceAll(":", "_")}`;
    const results = await Promise.all(
      ["conversation-0001", "conversation-0002"].map((id) =>
        handleChatHistoryStorage(mock.api, {
          type: "chat-history-upsert",
          requestId: `save-${id}`,
          documentId,
          conversation: conversation(id),
          activeChatId: id,
        }),
      ),
    );

    expect(results.every((result) => result.success)).toBe(true);
    const loaded = await handleChatHistoryStorage(mock.api, {
      type: "chat-history-load",
      requestId: "load-history",
    });
    expect(loaded.history?.conversations.map(({ id }) => id).sort()).toEqual([
      "conversation-0001",
      "conversation-0002",
    ]);
  });

  it("keeps history indexes isolated between Figma pages", async () => {
    const mock = createMockApi();
    const firstDocumentId = `${mock.api.fileKey}-${mock.api.currentPage.id.replaceAll(":", "_")}`;
    await handleChatHistoryStorage(mock.api, {
      type: "chat-history-upsert",
      requestId: "save-first-page-chat",
      documentId: firstDocumentId,
      conversation: conversation("conversation-0001", "First page chat"),
      activeChatId: "conversation-0001",
    });

    mock.switchCurrentPage();
    const secondPage = await handleChatHistoryStorage(mock.api, {
      type: "chat-history-load",
      requestId: "load-second-page-history",
    });
    expect(secondPage.documentId).not.toBe(firstDocumentId);
    expect(secondPage.history?.conversations).toEqual([]);
  });

  it("isolates per-chat checkpoints and deleting history never deletes canvas nodes", async () => {
    const mock = createMockApi();
    const documentId = `${mock.api.fileKey}-${mock.api.currentPage.id.replaceAll(":", "_")}`;
    const firstId = "conversation-0001";
    const secondId = "conversation-0002";
    const first = { ...conversation(firstId), taskId: "task-conversation-0001" };
    const second = { ...conversation(secondId), taskId: "task-conversation-0002" };
    const firstTask = scopedTask(mock.api, firstId);
    const secondTask = scopedTask(mock.api, secondId);
    const node = mock.api.createFrame();
    node.name = "Existing canvas work";
    const rootsBeforeDelete = mock.roots.slice();

    for (const [chatId, record, task] of [
      [firstId, first, firstTask],
      [secondId, second, secondTask],
    ] as const) {
      expect(
        (
          await handleChatTaskStorage(mock.api, {
            type: "chat-task-save",
            requestId: `task-save-${chatId}`,
            documentId,
            chatId,
            task,
          })
        ).success,
      ).toBe(true);
      expect(
        (
          await handleChatHistoryStorage(mock.api, {
            type: "chat-history-upsert",
            requestId: `history-save-${chatId}`,
            documentId,
            conversation: record,
          })
        ).success,
      ).toBe(true);
    }

    expect(
      (
        await handleChatTaskStorage(mock.api, {
          type: "chat-task-load",
          requestId: "load-first-task",
          chatId: firstId,
        })
      ).task,
    ).toEqual(firstTask);
    expect(
      (
        await handleChatTaskStorage(mock.api, {
          type: "chat-task-load",
          requestId: "load-second-task",
          chatId: secondId,
        })
      ).task,
    ).toEqual(secondTask);

    const deleted = await handleChatHistoryStorage(mock.api, {
      type: "chat-history-delete",
      requestId: "delete-first-chat",
      documentId,
      chatId: firstId,
    });
    expect(deleted.success).toBe(true);
    expect(deleted.history?.conversations.map(({ id }) => id)).toEqual([secondId]);
    expect(
      (
        await handleChatTaskStorage(mock.api, {
          type: "chat-task-load",
          requestId: "first-task-is-gone",
          chatId: firstId,
        })
      ).task,
    ).toBeNull();
    expect(
      (
        await handleChatTaskStorage(mock.api, {
          type: "chat-task-load",
          requestId: "second-task-remains",
          chatId: secondId,
        })
      ).task,
    ).toEqual(secondTask);
    expect(mock.roots).toEqual(rootsBeforeDelete);
    expect(mock.roots[0]).toBe(node);
  });

  it("refuses to delete a chat with a running checkpoint and preserves both records", async () => {
    const mock = createMockApi();
    const documentId = `${mock.api.fileKey}-${mock.api.currentPage.id.replaceAll(":", "_")}`;
    const chatId = "conversation-0001";
    const record = conversation(chatId);
    const task = scopedTask(mock.api, chatId, "running");
    await handleChatTaskStorage(mock.api, {
      type: "chat-task-save",
      requestId: "save-running-task",
      documentId,
      chatId,
      task,
    });
    await handleChatHistoryStorage(mock.api, {
      type: "chat-history-upsert",
      requestId: "save-running-history",
      documentId,
      conversation: record,
    });

    const result = await handleChatHistoryStorage(mock.api, {
      type: "chat-history-delete",
      requestId: "refuse-running-delete",
      documentId,
      chatId,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("still running");
    expect(
      (
        await handleChatTaskStorage(mock.api, {
          type: "chat-task-load",
          requestId: "running-task-retained",
          chatId,
        })
      ).task,
    ).toEqual(task);
    expect(
      (
        await handleChatHistoryStorage(mock.api, {
          type: "chat-history-load",
          requestId: "running-history-retained",
        })
      ).history?.conversations,
    ).toEqual([record]);
  });
});
