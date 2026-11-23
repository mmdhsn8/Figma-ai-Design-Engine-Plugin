import { ChatTaskSchema, CHAT_TASK_MAX_BYTES } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import type { ChatTask } from "../shared/chat-task";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import {
  checkpointHash,
  checkpointJson,
  checkpointRevision,
  traceCheckpoint,
} from "../shared/chat-checkpoint-wire";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";

const MAX_QUEUED_CHAT_TASK_STORAGE_OPERATIONS = 8;
const MAX_CHAT_TASK_STORAGE_KEYS = 32;
const MAX_IN_FLIGHT_CHAT_TASK_SAVES = 8;
const storageQueues = new Map<string, { tail: Promise<void>; pending: number }>();
const inFlightSaves = new Map<
  string,
  { signature: string; result: Promise<ChatTaskStorageResult> }
>();
const recentSaves = new Map<string, { signature: string; result: ChatTaskStorageResult }>();
const MAX_RECENT_SAVES = 16;

type ChatTaskStorageResult = Extract<PluginToUIMessage, { type: "chat-task-result" }>;

class ChatTaskStorageBusyError extends Error {
  readonly code = "checkpoint_queue_full";
}

async function withStorageQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  let queue = storageQueues.get(key);
  if (!queue) {
    if (storageQueues.size >= MAX_CHAT_TASK_STORAGE_KEYS)
      throw new ChatTaskStorageBusyError(
        "Checkpoint storage has too many unresolved task writes; retry after storage recovery.",
      );
    queue = { tail: Promise.resolve(), pending: 0 };
    storageQueues.set(key, queue);
  }
  if (queue.pending >= MAX_QUEUED_CHAT_TASK_STORAGE_OPERATIONS)
    throw new ChatTaskStorageBusyError(
      "Checkpoint storage is busy; the existing saved task was retained.",
    );

  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.pending++;
  await previous;
  try {
    return await work();
  } finally {
    queue.pending--;
    release();
    if (queue.pending === 0 && storageQueues.get(key) === queue) storageQueues.delete(key);
  }
}

export interface ChatTaskStorageOptions {
  /** The main controller passes a request that already passed the shared protocol schema. */
  prevalidated?: boolean;
}

export async function handleChatTaskStorage(
  api: PluginAPI,
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
  options: ChatTaskStorageOptions = {},
): Promise<Extract<PluginToUIMessage, { type: "chat-task-result" }>> {
  if (message.type !== "chat-task-save") return performChatTaskStorage(api, message, options);
  let signature: string;
  try {
    signature = checkpointJson(message.task);
  } catch {
    return performChatTaskStorage(api, message, options);
  }
  const requestKey = `${api.fileKey ?? "local"}\u0000${api.currentPage.id}\u0000${message.documentId}\u0000${message.chatId ?? "legacy"}\u0000${message.task?.id ?? "delete"}\u0000${message.requestId}`;
  const pending = inFlightSaves.get(requestKey);
  if (pending) {
    if (pending.signature === signature) return pending.result;
    return saveRequestConflict(message);
  }
  const recent = recentSaves.get(requestKey);
  if (recent) {
    if (recent.signature !== signature) return saveRequestConflict(message);
    const expected = checkpointRevision(signature);
    const current = await performChatTaskStorage(
      api,
      {
        type: "chat-task-load",
        requestId: message.requestId,
        documentId: message.documentId,
        chatId: message.chatId,
        confirm: expected,
      },
      options,
    );
    if (!current.success) return current;
    return current.revision?.hash === expected.hash && current.revision.bytes === expected.bytes
      ? recent.result
      : saveRequestConflict(
          message,
          "A newer checkpoint superseded this save request.",
          "checkpoint_revision_mismatch",
        );
  }
  if (inFlightSaves.size >= MAX_IN_FLIGHT_CHAT_TASK_SAVES)
    return saveRequestConflict(
      message,
      "Checkpoint storage has too many unresolved saves; retry after storage recovery.",
      "checkpoint_queue_full",
    );

  const result = performChatTaskStorage(api, message, options, signature);
  inFlightSaves.set(requestKey, { signature, result });
  const completed = await result;
  inFlightSaves.delete(requestKey);
  if (completed.success) {
    recentSaves.set(requestKey, { signature, result: completed });
    while (recentSaves.size > MAX_RECENT_SAVES)
      recentSaves.delete(recentSaves.keys().next().value as string);
  }
  return completed;
}

function saveRequestConflict(
  message: Extract<UIToPluginMessage, { type: "chat-task-save" }>,
  error = "A checkpoint request ID was reused for different task data; the existing saved task was retained.",
  errorCode = "checkpoint_request_conflict",
): ChatTaskStorageResult {
  return {
    type: "chat-task-result",
    requestId: message.requestId,
    success: false,
    documentId: message.documentId,
    errorCategory: "checkpoint_storage",
    errorCode,
    error,
  };
}

async function performChatTaskStorage(
  api: PluginAPI,
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
  options: ChatTaskStorageOptions,
  signature?: string,
): Promise<ChatTaskStorageResult> {
  let documentId = message.documentId ?? "";
  let phase = "scope";
  let keyHash: string | undefined;
  const trace = (event: string, details = {}) =>
    traceCheckpoint("controller", event, message.requestId, { keyHash, ...details });
  const taskId = message.type === "chat-task-save" ? message.task?.id : undefined;
  const runId = taskId ?? message.requestId;
  const storageCall = async <T>(operation: "read" | "write", invoke: () => Promise<T>, revision?: { hash: string; bytes: number }): Promise<T> => {
    const startedAt = Date.now();
    const kind = operation === "read" ? "checkpoint_read" : "checkpoint_write";
    fw7Telemetry.record({ runId, ...(taskId ? { taskId } : {}), requestIdHash: fw7CorrelationHash(message.requestId), checkpointRevisionHash: revision?.hash, checkpointBytes: revision?.bytes, boundary: "checkpoint-owner", kind: `${kind}_started` as "checkpoint_read_started" | "checkpoint_write_started", stage: "checkpoint", operation: operation === "read" ? "client-storage-read" : "client-storage-write", result: "started", counter: operation === "read" ? "checkpointStorageReads" : "checkpointStorageWrites" });
    try {
      const value = await invoke();
      const endedAt = Date.now();
      fw7Telemetry.record({ runId, ...(taskId ? { taskId } : {}), requestIdHash: fw7CorrelationHash(message.requestId), checkpointRevisionHash: revision?.hash, checkpointBytes: revision?.bytes, boundary: "checkpoint-owner", kind: `${kind}_result` as "checkpoint_read_result" | "checkpoint_write_result", stage: "checkpoint", operation: operation === "read" ? "client-storage-read" : "client-storage-write", result: "succeeded", durationMs: Math.max(0, Math.round(endedAt - startedAt)) });
      return value;
    } catch (error) {
      const endedAt = Date.now();
      fw7Telemetry.record({ runId, ...(taskId ? { taskId } : {}), requestIdHash: fw7CorrelationHash(message.requestId), checkpointRevisionHash: revision?.hash, checkpointBytes: revision?.bytes, boundary: "checkpoint-owner", kind: `${kind}_result` as "checkpoint_read_result" | "checkpoint_write_result", stage: "checkpoint", operation: operation === "read" ? "client-storage-read" : "client-storage-write", result: "failed", reasonCode: "client_storage_error", durationMs: Math.max(0, Math.round(endedAt - startedAt)) });
      throw error;
    }
  };
  try {
    let local = api.root.getPluginData("fad.document-id");
    if (!local) {
      local = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      api.root.setPluginData("fad.document-id", local);
    }
    const pageId = api.currentPage.id;
    documentId = `${api.fileKey ?? local}-${pageId.replaceAll(":", "_")}`;
    const legacyKey = `fad.chat-task.v1:${documentId}`;
    const key = message.chatId ? `fad.chat-task.v2:${documentId}:${message.chatId}` : legacyKey;
    keyHash = checkpointHash(key);
    trace("storage_request", {
      operation: message.type,
      confirmation: message.type === "chat-task-load" && !!message.confirm,
    });
    if (message.documentId && message.documentId !== documentId)
      throw new Error("Document/page changed; reopen chat history on the original page.");
    let task: unknown = message.type === "chat-task-save" ? message.task : undefined;
    if (message.type === "chat-task-save" && message.documentId !== documentId)
      throw new Error("Document/page changed; return to the task's original page before resuming.");
    let parsedTask: ChatTask | undefined;
    if (task != null) {
      const size = utf8Bytes(signature ?? checkpointJson(task));
      if (size > CHAT_TASK_MAX_BYTES)
        throw new Error(
          "Task checkpoint exceeds its 512 KiB safety budget. Existing canvas changes are retained.",
        );
      if (options.prevalidated && message.type === "chat-task-save") {
        parsedTask = task as ChatTask;
      } else {
        const parsed = ChatTaskSchema.safeParse(task);
        if (!parsed.success)
          throw new Error(
            "Saved task checkpoint is invalid. It was retained; no canvas changes were made.",
          );
        parsedTask = parsed.data;
      }
      if (parsedTask.documentId !== documentId)
        throw new Error("Saved task belongs to another document/page.");
    }
    if (api.currentPage.id !== pageId)
      throw new Error("Page changed while accessing the task checkpoint.");
    if (message.type === "chat-task-load") {
      // Reads remain available during a slow or interrupted write so recovery can inspect the last durable value.
      phase = "read";
      if (!message.confirm && storageQueues.has(key))
        throw new ChatTaskStorageBusyError(
          "A checkpoint write is still in progress. Wait for it to settle or reopen the plugin before resuming.",
        );
      trace("read_start");
      task = await storageCall("read", () => api.clientStorage.getAsync(key));
      if (task == null && message.chatId && !message.confirm) {
        const legacy = await storageCall("read", () => api.clientStorage.getAsync(legacyKey));
        if (
          legacy &&
          typeof legacy === "object" &&
          "id" in legacy &&
          legacy.id === message.chatId
        ) {
          task = legacy;
          keyHash = checkpointHash(legacyKey);
        }
      }
      const revision = checkpointRevision(checkpointJson(task ?? null));
      trace("read_end", {
        ...revision,
        present: task != null,
        outcome: message.confirm
          ? revision.hash === message.confirm.hash && revision.bytes === message.confirm.bytes
            ? "match"
            : "mismatch"
          : "loaded",
      });
      if (task != null) {
        if (utf8Bytes(JSON.stringify(task)) > CHAT_TASK_MAX_BYTES)
          throw new Error(
            "Saved task checkpoint exceeds its 512 KiB safety budget; it was retained.",
          );
        const parsed = ChatTaskSchema.safeParse(task);
        if (!parsed.success)
          throw new Error(
            "Saved task checkpoint is invalid. It was retained; no canvas changes were made.",
          );
        if (parsed.data.documentId !== documentId)
          throw new Error("Saved task belongs to another document/page.");
        task = parsed.data;
      }
      if (api.currentPage.id !== pageId)
        throw new Error("Page changed while accessing the task checkpoint.");
      return {
        type: "chat-task-result",
        requestId: message.requestId,
        success: true,
        documentId,
        revision,
        ...(!message.confirm ? { task: (task as ChatTask | undefined) ?? null } : {}),
      };
    } else {
      const json = signature ?? checkpointJson(parsedTask ?? null);
      const revision = checkpointRevision(json);
      if (
        message.revision &&
        (message.revision.bytes !== revision.bytes || message.revision.hash !== revision.hash)
      )
        return saveRequestConflict(
          message,
          "The checkpoint changed during transport.",
          "checkpoint_revision_mismatch",
        );
      trace("write_queued", revision);
      await withStorageQueue(key, async () => {
        if (api.currentPage.id !== pageId)
          throw new Error("Page changed before writing the task checkpoint.");
        phase = "write";
        trace("write_start", revision);
        if (message.chatId && parsedTask == null) await storageCall("write", () => api.clientStorage.deleteAsync(key), revision);
        else await storageCall("write", () => api.clientStorage.setAsync(key, JSON.parse(json)), revision);
        trace("write_end", revision);
        phase = "read_back";
        trace("read_back_start", revision);
        const actual = await storageCall("read", () => api.clientStorage.getAsync(key), revision);
        const stored = checkpointJson(actual ?? null);
        trace("read_back_end", {
          ...checkpointRevision(stored),
          present: actual != null,
          outcome: stored === json ? "match" : "mismatch",
        });
        if (stored !== json)
          throw new Error("Figma storage read-back returned a different checkpoint revision.");
      });
      if (api.currentPage.id !== pageId)
        throw new Error("Page changed while accessing the task checkpoint.");
      return {
        type: "chat-task-result",
        requestId: message.requestId,
        success: true,
        documentId,
        revision,
      };
    }
  } catch (error) {
    const quota =
      phase === "write" &&
      /quota|storage limit|exceed/i.test(error instanceof Error ? error.message : String(error));
    trace("storage_error", { phase, quota });
    return {
      type: "chat-task-result",
      requestId: message.requestId,
      success: false,
      documentId,
      errorCategory: "checkpoint_storage",
      errorCode:
        error instanceof ChatTaskStorageBusyError
          ? error.code
          : phase === "read_back"
            ? "checkpoint_read_unconfirmed"
            : quota
              ? "checkpoint_storage_quota"
              : message.type === "chat-task-load"
                ? "checkpoint_load_failed"
                : "checkpoint_save_failed",
      error: (error instanceof Error ? error.message : "Task checkpoint is unavailable.").slice(
        0,
        500,
      ),
    };
  }
}
