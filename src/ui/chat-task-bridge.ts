import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import type { PluginToUIMessage } from "../shared/messages";
import {
  checkpointHash,
  checkpointJson,
  checkpointRevision,
  traceCheckpoint,
} from "../shared/chat-checkpoint-wire";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";
import { FW7_BUILD_ID } from "../shared/fw7-feature";

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

let runtimeHandshake: Promise<void> | undefined;

function ensureCheckpointRuntime() {
  if (runtimeHandshake) return runtimeHandshake;
  runtimeHandshake = new Promise<void>((resolve, reject) => {
    const uiBuildId = (window as Window & { __fadBuildId?: string }).__fadBuildId ?? FW7_BUILD_ID;
    const requestId = `checkpoint-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finish = (error?: ChatTaskBridgeError) => {
      clearTimeout(deadline);
      window.removeEventListener("message", receive);
      if (error) reject(error);
      else resolve();
    };
    const receive = (event: MessageEvent) => {
      const raw = event.data?.pluginMessage;
      if (raw?.requestId !== requestId) return;
      const parsed = PluginToUISchema.safeParse(raw);
      if (!parsed.success) {
        finish(new ChatTaskBridgeError(
          "Figma returned an invalid runtime handshake response. Reload the development plugin and reopen it.",
          "checkpoint_protocol_error",
        ));
        return;
      }
      if (parsed.data.type === "protocol-error") {
        finish(new ChatTaskBridgeError(
          "The Figma plugin rejected the checkpoint handshake. Reload the development plugin and reopen it.",
          "checkpoint_build_mismatch",
        ));
        return;
      }
      if (parsed.data.type !== "plugin-runtime-handshake-result") {
        finish(new ChatTaskBridgeError(
          "Figma returned an unexpected runtime handshake response. Reload the development plugin and reopen it.",
          "checkpoint_protocol_error",
        ));
        return;
      }
      const result = parsed.data;
      if (result.compatible && result.protocolVersion === 1 && result.uiBuildId === uiBuildId && result.pluginBuildId === uiBuildId) {
        finish();
        return;
      }
      finish(new ChatTaskBridgeError(
        `The UI and Figma plugin builds are incompatible (${result.uiBuildId} / ${result.pluginBuildId}). Reload the development plugin and reopen it.`,
        "checkpoint_build_mismatch",
      ));
    };
    const deadline = window.setTimeout(() => finish(new ChatTaskBridgeError(
      "Figma did not confirm that the UI and plugin builds match. Reload the development plugin and reopen it.",
      "checkpoint_build_mismatch",
    )), 3_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: {
      type: "plugin-runtime-handshake",
      requestId,
      protocolVersion: 1,
      buildId: uiBuildId,
    } }, "*");
  }).catch((error: unknown) => {
    runtimeHandshake = undefined;
    throw error;
  });
  return runtimeHandshake;
}

type CheckpointResult = Extract<PluginToUIMessage, { type: "chat-task-result" }>;

export async function chatTaskBridge(
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
) {
  const handshake = ensureCheckpointRuntime();
  await handshake;
  const json = message.type === "chat-task-save" ? checkpointJson(message.task) : undefined;
  const expected = json === undefined ? undefined : checkpointRevision(json);
  const outbound =
    message.type === "chat-task-save"
      ? {
          type: message.type,
          requestId: message.requestId,
          documentId: message.documentId,
          ...(message.chatId ? { chatId: message.chatId } : {}),
          taskJson: json!,
          revision: expected!,
        }
      : message;

  return new Promise<CheckpointResult>((resolve, reject) => {
    let deadline: number | undefined;
    let poll: number | undefined;
    let recoveryRequestId: string | undefined;
    let recoveryAttempt = 0;
    let lastMismatch = false;
    const trace = (event: string, details = {}) =>
      traceCheckpoint("ui", event, message.requestId, { ...expected, ...details });
    const eventRunId = message.type === "chat-task-save" ? message.task?.id ?? message.requestId : message.requestId;
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
        fw7Telemetry.record({ runId: eventRunId, taskId: message.type === "chat-task-save" ? message.task?.id : undefined, requestIdHash: fw7CorrelationHash(request.requestId), checkpointRevisionHash: expected?.hash, checkpointBytes: expected?.bytes, boundary: "ui-plugin", kind: "bridge_dispatch", stage: "checkpoint", operation: request.type, result: "started", counter: "uiPluginDispatches" });
        if (request.type === "chat-task-save")
          fw7Telemetry.record({ runId: eventRunId, taskId: message.type === "chat-task-save" ? message.task?.id : undefined, requestIdHash: fw7CorrelationHash(request.requestId), checkpointRevisionHash: expected?.hash, checkpointBytes: expected?.bytes, boundary: "ui-plugin", kind: "checkpoint_write_started", stage: "checkpoint", operation: "chat-task-save", result: "started" });
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
      fw7Telemetry.record({ runId: eventRunId, taskId: message.type === "chat-task-save" ? message.task?.id : undefined, requestIdHash: fw7CorrelationHash(result.requestId), checkpointRevisionHash: result.revision?.hash, checkpointBytes: result.revision?.bytes, boundary: "ui-plugin", kind: "bridge_ack_received", stage: "checkpoint", operation: confirming ? "chat-task-confirm-read" : message.type, result: result.success ? "received" : "failed", counter: "uiPluginAcksReceived" });
      trace(confirming ? "confirm_received" : "ack_received", {
        receivedHash: result.revision?.hash,
        receivedBytes: result.revision?.bytes,
        code: result.errorCode,
        success: result.success,
      });
      if (!result.success) {
        // A still-open iframe can outlive the controller that acknowledged its handshake.
        if (result.errorCode === "checkpoint_build_mismatch" && runtimeHandshake === handshake)
          runtimeHandshake = undefined;
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
      fw7Telemetry.record({ runId: eventRunId, taskId: message.type === "chat-task-save" ? message.task?.id : undefined, requestIdHash: fw7CorrelationHash(result.requestId), checkpointRevisionHash: result.revision?.hash, checkpointBytes: result.revision?.bytes, boundary: "checkpoint-owner", kind: message.type === "chat-task-save" ? "checkpoint_ack" : "checkpoint_read_result", stage: "checkpoint", operation: message.type, result: "confirmed" });
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
    trace("post", { operation: message.type, wire: message.type === "chat-task-save" ? "json" : "load", buildId: FW7_BUILD_ID });
    post(outbound);
  });
}

export async function chatHistoryBridge(
  message: Extract<
    UIToPluginMessage,
    { type: "chat-history-load" | "chat-history-upsert" | "chat-history-delete" | "chat-history-delete-all" }
  >,
) {
  const mutating = message.type === "chat-history-upsert" || message.type === "chat-history-delete" || message.type === "chat-history-delete-all";
  if (mutating) await ensureCheckpointRuntime();
  return await new Promise<Extract<PluginToUIMessage, { type: "chat-history-result" }>>(
    (resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
      };
      const receive = (event: MessageEvent) => {
        const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
        if (parsed.success && parsed.data.type === "protocol-error" && parsed.data.requestId === message.requestId) {
          finish();
          reject(new Error(parsed.data.message.slice(0, 300)));
          return;
        }
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
        reject(new Error("Chat history request timed out. Reopen the plugin to check the saved history."));
      }, message.type === "chat-history-delete-all" ? 30_000 : 10_000);
      window.addEventListener("message", receive);
      parent.postMessage({ pluginMessage: message }, "*");
    },
  );
}
