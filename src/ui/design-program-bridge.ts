import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import { FW2_FEATURE, ContextResultSchema, parseContextSnapshot, type ContextRead } from "../shared/design-context";
import { requestedDesignContext } from "../shared/chat-generation";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";
import { matchNativeBridgeReply } from "./native-bridge-reply";

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
      const parsed = matchNativeBridgeReply(event.data?.pluginMessage, {
        requestId: request.requestId, taskId: request.taskId, type: "design-program-render-result",
      });
      if (!parsed) return;
      if (!parsed.success || parsed.data.type === "protocol-error") {
        finish();
        reject(Object.assign(new Error("Figma rejected the native render message or returned invalid ownership evidence. Reload the development plugin before resuming."), { code: "native_render_protocol_error" }));
        return;
      }
      if (parsed.data.type !== "design-program-render-result") return;
      if (parsed.data.requestId !== request.requestId || parsed.data.taskId !== request.taskId) return;
      fw7Telemetry.record({
        runId: request.taskId, taskId: request.taskId, screenId: parsed.data.screenId ?? request.program.screens[0]?.id,
        requestIdHash: fw7CorrelationHash(request.requestId), boundary: "ui-plugin", kind: "bridge_ack_received",
        stage: "native_render", operation: "design-program-render-result", result: "received", counter: "uiPluginAcksReceived",
      });
      fw7Telemetry.record({
        runId: request.taskId, taskId: request.taskId, screenId: parsed.data.screenId ?? request.program.screens[0]?.id,
        requestIdHash: fw7CorrelationHash(request.requestId), boundary: "ui-plugin", kind: "native_render_result",
        stage: "native_render", operation: "design-program-render", result: parsed.data.success ? "applied" : "failed",
        ...(parsed.data.success
          ? { observedCount: parsed.data.nativeNodeCount }
          : { observedCount: parsed.data.attachedNodeCount, reasonCode: parsed.data.errorCode ?? "native_render_failed" }),
      });
      finish();
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(Object.assign(new Error("Figma did not acknowledge the render in time. Resume will reconcile the saved native screen identity."), { code: "native_render_ack_timeout" }));
    }, 60_000);
    window.addEventListener("message", receive);
    try { parent.postMessage({ pluginMessage: request }, "*"); }
    catch {
      finish();
      reject(Object.assign(new Error("Figma could not receive the native render request. Resume after reopening the plugin."), { code: "native_render_transport_failed" }));
      return;
    }
    fw7Telemetry.record({
      runId: request.taskId, taskId: request.taskId, screenId: request.program.screens[0]?.id,
      requestIdHash: fw7CorrelationHash(request.requestId), boundary: "ui-plugin", kind: "bridge_dispatch",
      stage: "native_render", operation: "design-program-render", result: "started", counter: "uiPluginDispatches",
    });
  });
}
