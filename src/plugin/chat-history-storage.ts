import {
  CHAT_HISTORY_MAX_CHATS,
  CHAT_HISTORY_MAX_BYTES,
  ChatHistoryConversationSchema,
  ChatHistoryIndexSchema,
  emptyChatHistory,
} from "../shared/chat-history";
import { ChatTaskSchema } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";

const writeQueues = new Map<string, Promise<void>>();

async function serializeByKey<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => (release = resolve));
  const queued = previous.then(() => turn);
  writeQueues.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (writeQueues.get(key) === queued) writeQueues.delete(key);
  }
}

function pageScope(api: PluginAPI): { pageId: string; documentId: string } {
  let local = api.root.getPluginData("fad.document-id");
  if (!local) {
    local = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    api.root.setPluginData("fad.document-id", local);
  }
  const pageId = api.currentPage.id;
  return { pageId, documentId: `${api.fileKey ?? local}-${pageId.replaceAll(":", "_")}` };
}

export async function handleChatHistoryStorage(
  api: PluginAPI,
  message: Extract<
    UIToPluginMessage,
    { type: "chat-history-load" | "chat-history-upsert" | "chat-history-delete" }
  >,
): Promise<Extract<PluginToUIMessage, { type: "chat-history-result" }>> {
  const { pageId, documentId } = pageScope(api);
  const key = `fad.chat-history.v1:${documentId}`;
  const legacyTaskKey = `fad.chat-task.v1:${documentId}`;
  try {
    if (message.type !== "chat-history-load" && message.documentId !== documentId)
      throw new Error(
        "Document/page changed; reopen the original page before changing chat history.",
      );
    const history = await serializeByKey(key, async () => {
      const raw: unknown = await api.clientStorage.getAsync(key);
      const parsed =
        raw == null
          ? { success: true as const, data: emptyChatHistory() }
          : ChatHistoryIndexSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          "Saved chat history is invalid and was preserved; no task or canvas data was changed.",
        );
      let current = parsed.data;

      if (message.type === "chat-history-upsert") {
        const record = ChatHistoryConversationSchema.parse(message.conversation);
        const previous = current.conversations.find(({ id }) => id === record.id);
        const safeRecord = {
          ...record,
          createdAt: previous?.createdAt ?? record.createdAt,
          ...(previous && previous.updatedAt > record.updatedAt
            ? { ...previous, createdAt: previous.createdAt }
            : {}),
        };
        if (!previous && current.conversations.length >= CHAT_HISTORY_MAX_CHATS)
          throw new Error("Chat history is full. Delete an old chat before creating another.");
        const conversations = [
          ...current.conversations.filter(({ id }) => id !== record.id),
          safeRecord,
        ].sort((first, second) => second.updatedAt - first.updatedAt);
        const activeChatId =
          message.activeChatId === undefined ? current.activeChatId : message.activeChatId;
        if (activeChatId && !conversations.some(({ id }) => id === activeChatId))
          throw new Error("The selected chat is no longer in this document's history.");
        current = { version: 1, activeChatId, conversations };
        if (utf8Bytes(JSON.stringify(current)) > CHAT_HISTORY_MAX_BYTES)
          throw new Error(
            "Chat history reached its 2 MiB storage limit. Delete an older chat and retry.",
          );
        if (api.currentPage.id !== pageId)
          throw new Error("Page changed while saving chat history.");
        await api.clientStorage.setAsync(key, current);
      } else if (message.type === "chat-history-delete") {
        const existing = current.conversations.find(({ id }) => id === message.chatId);
        if (!existing) return current;
        const taskKeys = [`fad.chat-task.v2:${documentId}:${message.chatId}`];
        const legacyRaw: unknown = await api.clientStorage.getAsync(legacyTaskKey);
        if (
          legacyRaw &&
          typeof legacyRaw === "object" &&
          "id" in legacyRaw &&
          legacyRaw.id === message.chatId
        )
          taskKeys.push(legacyTaskKey);
        const backups = await Promise.all(
          taskKeys.map(async (taskKey) => ({
            key: taskKey,
            value: await api.clientStorage.getAsync(taskKey),
          })),
        );
        for (const backup of backups) {
          if (backup.value == null) continue;
          const task = ChatTaskSchema.safeParse(backup.value);
          if (!task.success)
            throw new Error(
              "A chat checkpoint is invalid and was preserved; repair it before deleting this chat.",
            );
          if (task.data.status === "running")
            throw new Error(
              "This task is still running. Stop it and wait for its checkpoint before deleting the chat.",
            );
        }
        const nextConversations = current.conversations.filter(({ id }) => id !== message.chatId);
        const next: typeof current = {
          version: 1,
          activeChatId:
            current.activeChatId === message.chatId
              ? (nextConversations[0]?.id ?? null)
              : current.activeChatId,
          conversations: nextConversations,
        };
        try {
          for (const taskKey of taskKeys) await api.clientStorage.deleteAsync(taskKey);
          if (api.currentPage.id !== pageId)
            throw new Error("Page changed while deleting chat history.");
          await api.clientStorage.setAsync(key, next);
        } catch (error) {
          await api.clientStorage.setAsync(key, current);
          for (const backup of backups)
            if (backup.value != null) await api.clientStorage.setAsync(backup.key, backup.value);
          throw error;
        }
        current = next;
      }

      if (api.currentPage.id !== pageId)
        throw new Error("Page changed while accessing chat history.");
      return current;
    });
    return {
      type: "chat-history-result",
      requestId: message.requestId,
      success: true,
      documentId,
      history,
    };
  } catch (error) {
    return {
      type: "chat-history-result",
      requestId: message.requestId,
      success: false,
      documentId,
      error: (error instanceof Error ? error.message : "Chat history is unavailable.").slice(
        0,
        500,
      ),
    };
  }
}
