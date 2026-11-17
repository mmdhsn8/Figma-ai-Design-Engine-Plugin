import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import type { PluginToUIMessage } from "../shared/messages";
import type { ChatTask } from "../shared/chat-task";
import { ChatTaskSchema } from "../shared/chat-task";

const CHAT_TASK_WRITE_ACK_TIMEOUT_MS = 10_000;
const CHAT_TASK_WRITE_RECONCILE_TIMEOUT_MS = 5_000;
const CHAT_TASK_WRITE_RECONCILE_POLL_MS = 1_250;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export class ChatTaskBridgeError extends Error {
  readonly category = "checkpoint_storage";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function chatTaskBridge(
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
) {
  return new Promise<
    Extract<import("../shared/messages").PluginToUIMessage, { type: "chat-task-result" }>
  >((resolve, reject) => {
    let timer: number | undefined;
    let reconciliationDeadline: number | undefined;
    let reconciliationPoll: number | undefined;
    let finished = false;
    let recoveryRequestId: string | undefined;
    let recoveryAttempt = 0;
    let reconciliationStartedAt: number | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (reconciliationDeadline !== undefined) clearTimeout(reconciliationDeadline);
      if (reconciliationPoll !== undefined) clearTimeout(reconciliationPoll);
      window.removeEventListener("message", receive);
    };
    const requestRecoveryRead = () => {
      recoveryAttempt++;
      recoveryRequestId = `${message.requestId.slice(0, 72)}_reconcile_${recoveryAttempt}`;
      parent.postMessage({
        pluginMessage: {
          type: "chat-task-load",
          requestId: recoveryRequestId,
          documentId: message.documentId,
          ...(message.chatId ? { chatId: message.chatId } : {}),
        },
      }, "*");
    };
    const timeout = () => {
      timer = undefined;
      if (message.type !== "chat-task-save") {
        finish();
        reject(new ChatTaskBridgeError("Task checkpoint load timed out; saved data was not changed.", "checkpoint_load_timeout"));
        return;
      }
      reconciliationStartedAt = Date.now();
      reconciliationDeadline = window.setTimeout(() => {
        finish();
        reject(new ChatTaskBridgeError(
          "Task checkpoint save could not be confirmed after a storage read; no further canvas batch was started. Retry storage recovery before resuming.",
          "checkpoint_timeout",
        ));
      }, CHAT_TASK_WRITE_RECONCILE_TIMEOUT_MS);
      requestRecoveryRead();
    };
    const receive = (event: MessageEvent) => {
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (
        !parsed.success ||
        parsed.data.type !== "chat-task-result" ||
        (parsed.data.requestId !== message.requestId && parsed.data.requestId !== recoveryRequestId)
      )
        return;
      if (parsed.data.requestId === recoveryRequestId && message.type === "chat-task-save") {
        if (!parsed.data.success) {
          finish();
          reject(new ChatTaskBridgeError(
            parsed.data.error ?? "Task checkpoint recovery could not read the saved task.",
            parsed.data.errorCode ?? "checkpoint_recovery_failed",
          ));
          return;
        }
        const expected = message.task === null ? null : ChatTaskSchema.safeParse(message.task);
        const expectedTask = expected === null ? null : expected.success ? expected.data : undefined;
        const savedTask = (parsed.data.task as ChatTask | null | undefined) ?? null;
        if (expectedTask !== undefined && stableJson(savedTask) === stableJson(expectedTask)) {
          finish();
          resolve({ type: "chat-task-result", requestId: message.requestId, success: true, documentId: parsed.data.documentId });
        } else {
          const elapsed = Date.now() - (reconciliationStartedAt ?? Date.now());
          if (elapsed >= CHAT_TASK_WRITE_RECONCILE_TIMEOUT_MS) {
            finish();
            reject(new ChatTaskBridgeError(
              "The latest saved task does not match the checkpoint being committed; no further canvas batch was started. Retry storage recovery before resuming.",
              "checkpoint_write_unconfirmed",
            ));
          } else {
            reconciliationPoll = window.setTimeout(requestRecoveryRead, CHAT_TASK_WRITE_RECONCILE_POLL_MS);
          }
        }
        return;
      }
      if (parsed.data.requestId === message.requestId && message.type === "chat-task-save" && recoveryRequestId && !parsed.data.success)
        return;
      finish();
      if (parsed.data.success) resolve(parsed.data);
        else
          reject(
            new ChatTaskBridgeError(
              parsed.data.error ?? "Task checkpoint could not be saved.",
              parsed.data.errorCode ?? "checkpoint_load_failed",
            ),
          );
    };
    timer = window.setTimeout(timeout, CHAT_TASK_WRITE_ACK_TIMEOUT_MS);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: message }, "*");
  });
}

export function chatHistoryBridge(
  message: Extract<
    UIToPluginMessage,
    { type: "chat-history-load" | "chat-history-upsert" | "chat-history-delete" }
  >,
) {
  return new Promise<Extract<PluginToUIMessage, { type: "chat-history-result" }>>(
    (resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
      };
      const receive = (event: MessageEvent) => {
        const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
        if (
          !parsed.success ||
          parsed.data.type !== "chat-history-result" ||
          parsed.data.requestId !== message.requestId
        )
          return;
        finish();
        if (parsed.data.success) resolve(parsed.data);
        else reject(new Error(parsed.data.error ?? "Chat history could not be saved."));
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("Chat history request timed out; saved checkpoints were not changed."));
      }, 10_000);
      window.addEventListener("message", receive);
      parent.postMessage({ pluginMessage: message }, "*");
    },
  );
}
