import { utf8Bytes } from "./generation-limits";
import { CHAT_TASK_MAX_BYTES } from "./chat-task";
import { ChatTaskJsonSaveEnvelopeSchema, ChatTaskStorageMessageSchema, type UIToPluginMessage } from "./messages";

// Use the same JSON semantics before transport, on disk, and after read-back.
export function checkpointJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

export function checkpointHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return (left >>> 0).toString(16).padStart(8, "0") + (right >>> 0).toString(16).padStart(8, "0");
}

export function checkpointRevision(json: string) {
  return { hash: checkpointHash(json), bytes: utf8Bytes(json) };
}

type CheckpointMessage = Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>;
type CheckpointDecodeResult = { success: true; data: CheckpointMessage } | {
  success: false;
  code: "checkpoint_protocol_error" | "checkpoint_size_limit" | "checkpoint_revision_mismatch";
  phase: "envelope" | "size" | "revision" | "json" | "schema";
  issues?: string;
  bytes?: number;
};

const diagnosticFields = new Set([
  "type", "requestId", "documentId", "chatId", "task", "taskJson", "id", "confirm",
  "revision", "hash", "bytes", "version", "status", "lifecycle", "projectPlan",
  "projectPlanFingerprint", "universalManifest", "universalScreens", "universalMetrics",
  "traceEvents", "fingerprint", "platform", "viewport", "preset", "width", "height",
  "screens", "screenId", "stages", "program", "pending", "recent", "root", "children",
  "action", "functionCall", "arguments", "brandKit", "designSkills", "visualLanguageV1",
]);

function checkpointIssues(issues: readonly { code: string; path: PropertyKey[] }[]): string {
  return issues.slice(0, 4).map(({ code, path }) => {
    const field = path.slice(0, 8).map((part) =>
      typeof part === "number" ? `[${part}]` : typeof part === "string" && diagnosticFields.has(part) ? part : "?");
    return `${code}:${field.join(".") || "message"}`;
  }).join(",");
}

export function decodeChatTaskStorageMessage(raw: unknown): CheckpointDecodeResult {
  let message = raw;
  let bytes: number | undefined;
  if (raw && typeof raw === "object" && "type" in raw && raw.type === "chat-task-save") {
    if ("taskJson" in raw) {
      const envelope = ChatTaskJsonSaveEnvelopeSchema.safeParse(raw);
      if (!envelope.success)
        return { success: false, code: "checkpoint_protocol_error", phase: "envelope", issues: checkpointIssues(envelope.error.issues) };
      const { taskJson, ...scope } = envelope.data;
      if (taskJson.length > CHAT_TASK_MAX_BYTES)
        return { success: false, code: "checkpoint_size_limit", phase: "size" };
      bytes = utf8Bytes(taskJson);
      if (bytes > CHAT_TASK_MAX_BYTES)
        return { success: false, code: "checkpoint_size_limit", phase: "size", bytes };
      if (scope.revision.bytes !== bytes || scope.revision.hash !== checkpointHash(taskJson))
        return { success: false, code: "checkpoint_revision_mismatch", phase: "revision", bytes };
      try {
        message = { ...scope, task: JSON.parse(taskJson) as unknown };
      } catch {
        return { success: false, code: "checkpoint_protocol_error", phase: "json", bytes };
      }
    } else if ("task" in raw) {
      const json = JSON.stringify(raw.task);
      if (json !== undefined) bytes = utf8Bytes(json);
      if (bytes !== undefined && bytes > CHAT_TASK_MAX_BYTES)
        return { success: false, code: "checkpoint_size_limit", phase: "size", bytes };
    }
  }
  const parsed = ChatTaskStorageMessageSchema.safeParse(message);
  return parsed.success ? parsed : {
    success: false, code: "checkpoint_protocol_error", phase: "schema", bytes,
    issues: checkpointIssues(parsed.error.issues),
  };
}

export function traceCheckpoint(
  side: "ui" | "controller",
  event: string,
  requestId: string,
  details: Record<string, string | number | boolean | undefined> = {},
) {
  console.log(
    "[FAD_CHECKPOINT] " +
      JSON.stringify({
        version: 2,
        side,
        event,
        correlation: checkpointHash(requestId),
        atMs: Date.now(),
        ...details,
      }),
  );
}
