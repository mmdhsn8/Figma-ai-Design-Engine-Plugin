import {
  PluginToUISchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";

export type DesignProgramRenderRequest = Extract<UIToPluginMessage, { type: "design-program-render" }>;
export type DesignProgramRenderResponse = Extract<PluginToUIMessage, { type: "design-program-render-result" }>;

export function renderDesignProgramBridge(
  request: DesignProgramRenderRequest,
): Promise<DesignProgramRenderResponse> {
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
      if (!parsed.success) return;
      if (parsed.data.type === "protocol-error" && parsed.data.requestId === request.requestId) {
        finish();
        reject(new Error(parsed.data.message));
        return;
      }
      if (parsed.data.type !== "design-program-render-result") return;
      if (parsed.data.requestId !== request.requestId || parsed.data.taskId !== request.taskId) return;
      finish();
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(Object.assign(new Error("Figma did not acknowledge the render in time. Resume will reconcile the saved native screen identity."), { code: "native_render_ack_timeout" }));
    }, 60_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: request }, "*");
  });
}
