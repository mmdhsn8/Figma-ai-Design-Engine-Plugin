import { ChatTaskSchema, CHAT_TASK_MAX_BYTES } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";

export async function handleChatTaskStorage(
  api: PluginAPI,
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
): Promise<Extract<PluginToUIMessage, { type: "chat-task-result" }>> {
  let local = api.root.getPluginData("fad.document-id");
  if (!local) {
    local = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    api.root.setPluginData("fad.document-id", local);
  }
  const pageId = api.currentPage.id;
  const documentId = `${api.fileKey ?? local}-${pageId.replaceAll(":", "_")}`;
  const key = `fad.chat-task.v1:${documentId}`;
  try {
    const task =
      message.type === "chat-task-load" ? await api.clientStorage.getAsync(key) : message.task;
    if (message.type === "chat-task-save" && message.documentId !== documentId)
      throw new Error("Document/page changed; return to the task's original page before resuming.");
    if (task != null) {
      if (utf8Bytes(JSON.stringify(task)) > CHAT_TASK_MAX_BYTES)
        throw new Error(
          "Task checkpoint exceeds its 512 KiB safety budget. Existing canvas changes are retained.",
        );
      const parsed = ChatTaskSchema.safeParse(task);
      if (!parsed.success)
        throw new Error(
          "Saved task checkpoint is invalid. It was retained; no canvas changes were made.",
        );
      if (parsed.data.documentId !== documentId)
        throw new Error("Saved task belongs to another document/page.");
    }
    if (api.currentPage.id !== pageId)
      throw new Error("Page changed while accessing the task checkpoint.");
    if (message.type === "chat-task-save") await api.clientStorage.setAsync(key, task);
    return {
      type: "chat-task-result",
      requestId: message.requestId,
      success: true,
      documentId,
      task: task ?? null,
    };
  } catch (error) {
    return {
      type: "chat-task-result",
      requestId: message.requestId,
      success: false,
      documentId,
      error: (error instanceof Error ? error.message : "Task checkpoint is unavailable.").slice(
        0,
        500,
      ),
    };
  }
}
