import {
  CHAT_HISTORY_MAX_CHATS,
  CHAT_HISTORY_MAX_BYTES,
  ChatHistoryConversationSchema,
  ChatHistoryIndexSchema,
  emptyChatHistory,
  type ChatHistoryConversation,
  type ChatHistoryIndex,
} from "../shared/chat-history";
import { ChatTaskSchema } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import { withChatCheckpointDeletion } from "./chat-task-storage";

const CHAT_HISTORY_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

type PreservedHistory = { version: 1; records: unknown[]; metadata: unknown[] };

type Recovery = {
  history: ChatHistoryIndex;
  damaged: boolean;
  preservedRecords: unknown[];
  preservedMetadata: unknown[];
  unreadableCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreservedHistory(
  value: unknown,
):
  | { exists: false; writable: true; value: PreservedHistory }
  | { exists: true; writable: true; value: PreservedHistory }
  | { exists: true; writable: false; value: null } {
  if (value == null)
    return { exists: false, writable: true, value: { version: 1, records: [], metadata: [] } };
  if (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.records) &&
    Array.isArray(value.metadata)
  )
    return {
      exists: true,
      writable: true,
      value: { version: 1, records: value.records, metadata: value.metadata },
    };
  return { exists: true, writable: false, value: null };
}

function jsonIdentity(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function appendUnique(target: unknown[], values: unknown[]): void {
  const known = new Set(target.map(jsonIdentity));
  for (const value of values) {
    const identity = jsonIdentity(value);
    if (known.has(identity)) continue;
    known.add(identity);
    target.push(value);
  }
}

function recoverHistory(raw: unknown): Recovery {
  if (raw == null)
    return {
      history: emptyChatHistory(),
      damaged: false,
      preservedRecords: [],
      preservedMetadata: [],
      unreadableCount: 0,
    };

  const strict = ChatHistoryIndexSchema.safeParse(raw);
  if (strict.success)
    return {
      history: strict.data,
      damaged: false,
      preservedRecords: [],
      preservedMetadata: [],
      unreadableCount: 0,
    };

  const source = isRecord(raw) ? raw : null;
  const rawConversations = Array.isArray(source?.conversations) ? source.conversations : [];
  const recordsById = new Map<string, ChatHistoryConversation>();
  const preservedRecords: unknown[] = [];
  let unreadableCount = 0;

  for (const candidate of rawConversations) {
    const parsed = ChatHistoryConversationSchema.safeParse(candidate);
    if (!parsed.success) {
      preservedRecords.push(candidate);
      unreadableCount++;
      continue;
    }
    const previous = recordsById.get(parsed.data.id);
    if (!previous) {
      recordsById.set(parsed.data.id, parsed.data);
      continue;
    }
    unreadableCount++;
    if (parsed.data.updatedAt > previous.updatedAt) {
      preservedRecords.push(previous);
      recordsById.set(parsed.data.id, parsed.data);
    } else {
      preservedRecords.push(parsed.data);
    }
  }

  const sorted = [...recordsById.values()].sort(
    (first, second) => second.updatedAt - first.updatedAt,
  );
  if (sorted.length > CHAT_HISTORY_MAX_CHATS) {
    preservedRecords.push(...sorted.slice(CHAT_HISTORY_MAX_CHATS));
    unreadableCount += sorted.length - CHAT_HISTORY_MAX_CHATS;
  }
  const conversations = sorted.slice(0, CHAT_HISTORY_MAX_CHATS);
  const activeCandidate = source?.activeChatId;
  const activeChatId =
    typeof activeCandidate === "string" && conversations.some(({ id }) => id === activeCandidate)
      ? activeCandidate
      : null;

  const preservedMetadata = !source
    ? [raw]
    : !Array.isArray(source.conversations)
      ? [raw]
      : Object.keys(source).some((key) => key !== "conversations")
        ? [{ ...source, conversations: undefined }]
        : [];
  if (unreadableCount === 0) unreadableCount = 1;

  return {
    history: { version: 1, activeChatId, conversations },
    damaged: true,
    preservedRecords,
    preservedMetadata,
    unreadableCount,
  };
}

function preservedCount(archive: PreservedHistory): number {
  return Math.max(archive.records.length, archive.metadata.length ? 1 : 0);
}

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
    { type: "chat-history-load" | "chat-history-upsert" | "chat-history-delete" | "chat-history-delete-all" }
  >,
): Promise<Extract<PluginToUIMessage, { type: "chat-history-result" }>> {
  const { pageId, documentId } = pageScope(api);
  const key = `fad.chat-history.v1:${documentId}`;
  const archiveKey = `fad.chat-history-preserved.v1:${documentId}`;
  const legacyTaskKey = `fad.chat-task.v1:${documentId}`;
  try {
    if (message.type !== "chat-history-load" && message.documentId !== documentId)
      throw new Error(
        "Document/page changed; reopen the original page before changing chat history.",
      );
    const accessHistory = () => serializeByKey(key, async () => {
      const raw: unknown = await api.clientStorage.getAsync(key);
      const archiveRaw: unknown = await api.clientStorage.getAsync(archiveKey);
      const parsedArchive = parsePreservedHistory(archiveRaw);
      const recovery = recoverHistory(raw);
      const current = recovery.history;
      let archive = parsedArchive.writable
        ? parsedArchive.value
        : { version: 1 as const, records: [], metadata: [] };
      if (!parsedArchive.writable && message.type !== "chat-history-load")
        throw new Error(
          "The saved-history recovery archive is damaged and was preserved; no history or task data was changed.",
        );

      const prepareArchive = (records: unknown[], metadata: unknown[]) => {
        const next = {
          version: 1 as const,
          records: [...archive.records],
          metadata: [...archive.metadata],
        };
        appendUnique(next.records, records);
        appendUnique(next.metadata, metadata);
        if (utf8Bytes(JSON.stringify(next)) > CHAT_HISTORY_ARCHIVE_MAX_BYTES)
          throw new Error(
            "The recovery archive reached its 2 MiB limit. Existing saved history was preserved and no change was made.",
          );
        return next;
      };
      const persist = async (next: ChatHistoryIndex, nextArchive: PreservedHistory) => {
        if (api.currentPage.id !== pageId)
          throw new Error("Page changed while saving chat history.");
        const archiveChanged = jsonIdentity(nextArchive) !== jsonIdentity(archive);
        if (archiveChanged) await api.clientStorage.setAsync(archiveKey, nextArchive);
        if (api.currentPage.id !== pageId)
          throw new Error("Page changed while saving chat history.");
        await api.clientStorage.setAsync(key, next);
        archive = nextArchive;
      };

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
        const next: ChatHistoryIndex = { version: 1, activeChatId, conversations };
        if (utf8Bytes(JSON.stringify(next)) > CHAT_HISTORY_MAX_BYTES)
          throw new Error(
            "Chat history reached its 2 MiB storage limit. Delete an older chat and retry.",
          );
        const nextArchive = prepareArchive(recovery.preservedRecords, recovery.preservedMetadata);
        await persist(next, nextArchive);
        return {
          history: next,
          archive: nextArchive,
          archiveDamaged: false,
          recoveryCount: 0,
        };
      }

      if (message.type === "chat-history-delete" || message.type === "chat-history-delete-all") {
        const targets = new Set(
          current.conversations
            .filter(({ id }) => message.type === "chat-history-delete-all" || id === message.chatId)
            .map(({ id }) => id),
        );
        if (targets.size === 0)
          return {
            history: current,
            archive,
            archiveDamaged: !parsedArchive.writable,
            recoveryCount: recovery.unreadableCount,
          };
        const taskKeys = [...targets].map((id) => `fad.chat-task.v2:${documentId}:${id}`);
        const legacyRaw: unknown = await api.clientStorage.getAsync(legacyTaskKey);
        if (
          legacyRaw &&
          typeof legacyRaw === "object" &&
          "id" in legacyRaw &&
          typeof legacyRaw.id === "string" && targets.has(legacyRaw.id)
        )
          taskKeys.push(legacyTaskKey);
        const taskBackups = await Promise.all(
          taskKeys.map(async (taskKey) => ({
            key: taskKey,
            value: await api.clientStorage.getAsync(taskKey),
          })),
        );
        for (const backup of taskBackups) {
          if (backup.value == null) continue;
          const task = ChatTaskSchema.safeParse(backup.value);
          if (!task.success)
            throw new Error(
              "A chat checkpoint is invalid and was preserved; repair it before deleting this chat.",
            );
          if (task.data.documentId !== documentId)
            throw new Error("A saved checkpoint belongs to a different Figma page and was preserved.");
        }
        const nextConversations = current.conversations.filter(({ id }) => !targets.has(id));
        const next: ChatHistoryIndex = {
          version: 1,
          activeChatId:
            current.activeChatId && targets.has(current.activeChatId)
              ? (nextConversations[0]?.id ?? null)
              : current.activeChatId,
          conversations: nextConversations,
        };
        const nextArchive = prepareArchive(recovery.preservedRecords, recovery.preservedMetadata);
        nextArchive.records = nextArchive.records.filter(
          (record) => !isRecord(record) || typeof record.id !== "string" || !targets.has(record.id),
        );
        const archiveChanged = jsonIdentity(nextArchive) !== jsonIdentity(archive);
        const mainBackup = raw;
        try {
          if (api.currentPage.id !== pageId)
            throw new Error("Page changed while deleting chat history.");
          if (archiveChanged) await api.clientStorage.setAsync(archiveKey, nextArchive);
          for (const backup of taskBackups)
            if (backup.value != null) await api.clientStorage.deleteAsync(backup.key);
          if (api.currentPage.id !== pageId)
            throw new Error("Page changed while deleting chat history.");
          await api.clientStorage.setAsync(key, next);
          archive = nextArchive;
        } catch (error) {
          if (mainBackup != null) await api.clientStorage.setAsync(key, mainBackup);
          else await api.clientStorage.deleteAsync(key);
          for (const backup of taskBackups)
            if (backup.value != null) await api.clientStorage.setAsync(backup.key, backup.value);
          if (parsedArchive.writable) {
            if (parsedArchive.exists)
              await api.clientStorage.setAsync(archiveKey, parsedArchive.value);
            else await api.clientStorage.deleteAsync(archiveKey);
          }
          throw error;
        }
        return {
          history: next,
          archive: nextArchive,
          archiveDamaged: false,
          recoveryCount: 0,
        };
      }

      return {
        history: current,
        archive,
        archiveDamaged: !parsedArchive.writable,
        recoveryCount: recovery.unreadableCount,
      };
    });
    const result = message.type === "chat-history-delete" || message.type === "chat-history-delete-all"
      ? await withChatCheckpointDeletion(documentId, accessHistory)
      : await accessHistory();
    return {
      type: "chat-history-result",
      requestId: message.requestId,
      success: true,
      documentId,
      history: result.history,
      corruptRecordCount: result.archiveDamaged
        ? Math.min(Math.max(preservedCount(result.archive), 1), 10_000)
        : Math.min(Math.max(preservedCount(result.archive), result.recoveryCount), 10_000),
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
