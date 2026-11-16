import { PluginToUISchema, type PluginToUIMessage, type UIToPluginMessage } from "../shared/messages";

type Request = Extract<UIToPluginMessage, { type: "load-design-engine-preference" | "save-design-engine-preference" }>;
type Response = Extract<PluginToUIMessage, { type: "design-engine-preference-loaded" | "design-engine-preference-saved" }>;

export function designEnginePreferenceBridge(request: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (!parsed.success || !("requestId" in parsed.data) || parsed.data.requestId !== request.requestId) return;
      if (parsed.data.type !== "design-engine-preference-loaded" && parsed.data.type !== "design-engine-preference-saved") return;
      finish();
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error("The Design Engine preference did not respond. New Chat tasks are paused until the saved engine can be confirmed."));
    }, 10_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: request }, "*");
  });
}
