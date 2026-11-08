import {
  PluginToUISchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";

type Request = Extract<UIToPluginMessage, { type: "task-native-inspect" | "task-native-focus" }>;
type Response = Extract<
  PluginToUIMessage,
  { type: "task-native-inspection-result" | "task-native-focus-result" }
>;

export function taskNativeBridge(message: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (!parsed.success) return;
      if (parsed.data.type === "protocol-error") {
        if (parsed.data.requestId !== message.requestId) return;
        finish();
        reject(new Error(parsed.data.message));
        return;
      }
      if (
        parsed.data.type !== "task-native-inspection-result" &&
        parsed.data.type !== "task-native-focus-result"
      )
        return;
      if (parsed.data.requestId !== message.requestId) return;
      finish();
      if (!parsed.data.success)
        reject(new Error(parsed.data.error ?? "The task-owned native layers could not be read."));
      else resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error("Figma did not respond to the task-layer request. Refresh and try again."));
    }, 15_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: message }, "*");
  });
}
