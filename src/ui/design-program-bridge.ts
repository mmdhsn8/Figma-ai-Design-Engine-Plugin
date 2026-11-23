import {
  PluginToUISchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";
import { FW2_FEATURE, ContextResultSchema, parseContextSnapshot, type ContextRead } from "../shared/design-context";
import { requestedDesignContext } from "../shared/chat-generation";

export type DesignProgramRenderRequest = Extract<UIToPluginMessage, { type: "design-program-render" }>;
export type DesignProgramRenderResponse = Extract<PluginToUIMessage, { type: "design-program-render-result" }>;
export type ContextResponse = Extract<PluginToUIMessage, { type: "design-context-result" }>;

export function readDesignContextBridge(request: ContextRead, signal: AbortSignal): Promise<ContextResponse> {
  const correlation = { feature: FW2_FEATURE, requestId: request.requestId, taskId: request.taskId } as const;
  const failure = (code: Extract<ContextResponse, { success: false }>["code"]): ContextResponse =>
    ({ ...correlation, type: "design-context-result", success: false, code });
  if (signal.aborted) return Promise.resolve(failure("CANCELLED"));
  return new Promise((resolve) => {
    const post = (message: ContextRead | { type: "design-context-cancel" } & typeof correlation) => {
      try { parent.postMessage({ pluginMessage: message }, "*"); return true; } catch { return false; }
    };
    const finish = (result: ContextResponse) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (!result.success) signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      post({ ...correlation, type: "design-context-cancel" });
      finish(failure("CANCELLED"));
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== parent) return;
      const raw = event.data?.pluginMessage;
      if (raw?.type !== "design-context-result" || raw.requestId !== request.requestId || raw.taskId !== request.taskId) return;
      if (raw.success === true && !parseContextSnapshot(raw.snapshot)) { finish(failure("INVALID")); return; }
      const parsed = ContextResultSchema.safeParse(raw);
      if (!parsed.success) { finish(failure("INVALID")); return; }
      if (parsed.data.success && (parsed.data.snapshot.scope !== request.scope ||
        (request.intent === "edit" && (parsed.data.snapshot.pageId !== request.targetPageId ||
          parsed.data.snapshot.roots.length !== 1 || parsed.data.snapshot.roots[0] !== request.targetNodeId)))) {
        finish(failure("INVALID"));
        return;
      }
      finish(parsed.data);
    };
    const timer = window.setTimeout(() => {
      post({ ...correlation, type: "design-context-cancel" });
      finish(failure("TIMEOUT"));
    }, 1_300);
    window.addEventListener("message", receive);
    signal.addEventListener("abort", cancel, { once: true });
    if (!post(request)) finish(failure("UNAVAILABLE"));
  });
}

export function taskContextRequest(task: { id: string; documentId: string; prompt: string }, intent: "create" | "edit", requestId: string, target?: { nodeId: string; pageId: string }): ContextRead | undefined {
  const approval = requestedDesignContext(task.prompt, intent);
  if (!approval || (intent === "edit" && !target)) return;
  return {
    type: "design-context-read", feature: FW2_FEATURE, requestId, taskId: task.id,
    documentId: task.documentId, prompt: task.prompt, intent, scope: approval.scope, targetNodeId: target?.nodeId, targetPageId: target?.pageId,
  };
}

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
