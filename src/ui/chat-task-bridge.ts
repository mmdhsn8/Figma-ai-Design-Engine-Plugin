import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";

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
