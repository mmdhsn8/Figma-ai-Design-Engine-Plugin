import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import type { PluginToUIMessage } from "../shared/messages";

export function chatTaskBridge(
  message: Extract<UIToPluginMessage, { type: "chat-task-load" | "chat-task-save" }>,
) {
  return new Promise<
    Extract<import("../shared/messages").PluginToUIMessage, { type: "chat-task-result" }>
  >((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (
        !parsed.success ||
        parsed.data.type !== "chat-task-result" ||
        parsed.data.requestId !== message.requestId
      )
        return;
      finish();
      if (parsed.data.success) resolve(parsed.data);
      else reject(new Error(parsed.data.error ?? "Task checkpoint could not be saved."));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("Task checkpoint timed out; no further canvas batch was started."));
    }, 10_000);
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
