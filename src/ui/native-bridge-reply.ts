import { PluginToUISchema } from "../shared/messages";

export function matchNativeBridgeReply(
  raw: unknown,
  expected: { requestId: string; taskId?: string; type: string },
) {
  if (!raw || typeof raw !== "object") return;
  const message = raw as { requestId?: unknown; taskId?: unknown; type?: unknown };
  if (message.requestId !== expected.requestId) return;
  if (message.type !== expected.type && message.type !== "protocol-error") return;
  if (expected.taskId && typeof message.taskId === "string" && message.taskId !== expected.taskId)
    return;
  return PluginToUISchema.safeParse(raw);
}
