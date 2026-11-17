import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import type { PluginToUIMessage } from "../shared/messages";
import {
  checkpointHash,
  checkpointJson,
  checkpointRevision,
  traceCheckpoint,
} from "../shared/chat-checkpoint-wire";

const CHAT_TASK_WRITE_ACK_TIMEOUT_MS = 10_000;
const CHAT_TASK_WRITE_RECONCILE_TIMEOUT_MS = 5_000;
const CHAT_TASK_WRITE_RECONCILE_POLL_MS = 1_250;

export class ChatTaskBridgeError extends Error {
  readonly category = "checkpoint_storage";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type CheckpointResult = Extract<PluginToUIMessage, { type: "chat-task-result" }>;

export function chatTaskBridge(
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
) {
  const json = message.type === "chat-task-save" ? checkpointJson(message.task) : undefined;
  const expected = json === undefined ? undefined : checkpointRevision(json);
  const outbound =
    message.type === "chat-task-save"
      ? { ...message, task: JSON.parse(json!), revision: expected }
      : message;

  return new Promise<CheckpointResult>((resolve, reject) => {
    let deadline: number | undefined;
    let poll: number | undefined;
    let recoveryRequestId: string | undefined;
    let recoveryAttempt = 0;
    let lastMismatch = false;
    const trace = (event: string, details = {}) =>
      traceCheckpoint("ui", event, message.requestId, { ...expected, ...details });
    const finish = () => {
      window.clearTimeout(deadline);
      window.clearTimeout(poll);
      window.removeEventListener("message", receive);
    };
    const fail = (error: string, code: string) => {
      trace("failed", { code });
      finish();
      reject(new ChatTaskBridgeError(error, code));
    };
    const post = (request: typeof outbound | typeof message) => {
      try {
        parent.postMessage({ pluginMessage: request }, "*");
      } catch {
        fail("Figma could not transfer the checkpoint request.", "checkpoint_transport_failed");
      }
    };
    const requestRecoveryRead = () => {
      recoveryRequestId = `${message.requestId.slice(0, 72)}_reconcile_${++recoveryAttempt}`;
      trace("confirm_post", { readCorrelation: checkpointHash(recoveryRequestId) });
      post({
        type: "chat-task-load",
        requestId: recoveryRequestId,
        documentId: message.documentId,
        ...(message.chatId ? { chatId: message.chatId } : {}),
        confirm: expected,
      });
    };
    const reconcile = () => {
      if (recoveryRequestId) return;
      window.clearTimeout(deadline);
      deadline = window.setTimeout(() => {
        fail(
          "Task checkpoint save could not be confirmed after a storage read; no further canvas batch was started. Retry storage recovery before resuming.",
          lastMismatch ? "checkpoint_write_unconfirmed" : "checkpoint_timeout",
        );
      }, CHAT_TASK_WRITE_RECONCILE_TIMEOUT_MS);
      requestRecoveryRead();
    };
    const receive = (event: MessageEvent) => {
      const raw = event.data?.pluginMessage;
      if (!raw || (raw.requestId !== message.requestId && raw.requestId !== recoveryRequestId))
        return;
      if (raw.type !== "chat-task-result" && raw.type !== "protocol-error") return;
      const parsed = PluginToUISchema.safeParse(raw);
      if (!parsed.success || parsed.data.type === "protocol-error") {
        fail(
          "Figma rejected the checkpoint message. Reload the development plugin before retrying.",
          "checkpoint_protocol_error",
        );
        return;
      }
      const result = parsed.data;
      if (result.type !== "chat-task-result") return;
      const confirming = result.requestId === recoveryRequestId;
      trace(confirming ? "confirm_received" : "ack_received", {
        receivedHash: result.revision?.hash,
        receivedBytes: result.revision?.bytes,
        code: result.errorCode,
        success: result.success,
      });
      if (!result.success) {
        if (!confirming && result.errorCode === "checkpoint_read_unconfirmed") {
          reconcile();
          return;
        }
        fail(
          result.error ?? "Task checkpoint storage failed.",
          result.errorCode ?? "checkpoint_storage_failed",
        );
        return;
      }
      const sameScope = !message.documentId || result.documentId === message.documentId;
      const sameRevision =
        !expected ||
        (result.revision?.hash === expected.hash && result.revision.bytes === expected.bytes);
      if (!sameScope) {
        fail(
          "Figma returned a checkpoint for a different document or page.",
          "checkpoint_scope_mismatch",
        );
        return;
      }
      if (!sameRevision) {
        lastMismatch = true;
        if (confirming) {
          window.clearTimeout(poll);
          poll = window.setTimeout(requestRecoveryRead, CHAT_TASK_WRITE_RECONCILE_POLL_MS);
        } else reconcile();
        return;
      }
      trace("confirmed");
      finish();
      resolve(confirming ? { ...result, requestId: message.requestId } : result);
    };
    deadline = window.setTimeout(() => {
      trace("ack_deadline");
      if (expected) reconcile();
      else
        fail(
          "Task checkpoint load timed out; saved data was not changed.",
          "checkpoint_load_timeout",
        );
    }, CHAT_TASK_WRITE_ACK_TIMEOUT_MS);
    window.addEventListener("message", receive);
    trace("post", { operation: message.type });
    post(outbound);
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
