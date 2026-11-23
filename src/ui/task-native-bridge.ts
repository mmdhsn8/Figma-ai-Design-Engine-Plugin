import {
  PluginToUISchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";

type Request = Extract<UIToPluginMessage, { type: "task-native-inspect" | "task-native-focus" }>;
type VisualCaptureRequest = Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>;
type Response = Extract<
  PluginToUIMessage,
  { type: "task-native-inspection-result" | "task-native-focus-result" }
>;

type VisualCaptureResponse = Extract<PluginToUIMessage, { type: "task-native-visual-capture-result" }>;
type VisualRepairRequest = Extract<UIToPluginMessage, { type: "task-native-visual-repair" }>;
type VisualRepairResponse = Extract<PluginToUIMessage, { type: "task-native-visual-repair-result" }>;

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
      reject(Object.assign(new Error("Figma did not respond to the task-layer request. Resume to retry native readback."), { code: "native_readback_timeout" }));
    }, 15_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: message }, "*");
  });
}

export function taskNativeVisualCaptureBridge(message: VisualCaptureRequest, signal: AbortSignal): Promise<VisualCaptureResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const postCancel = () => {
      try {
        parent.postMessage({ pluginMessage: { type: "task-native-visual-capture-cancel", requestId: message.requestId,
          taskId: message.visualCapture.taskId, captureNonce: message.visualCapture.captureNonce } }, "*");
      } catch { /* The plugin may already be closed; the UI task remains the commit authority. */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      postCancel();
      finish();
      reject(Object.assign(new Error("Visual capture was cancelled before its receipt could be accepted."), { code: "visual_capture_cancelled" }));
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== parent) return;
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (!parsed.success || parsed.data.type !== "task-native-visual-capture-result" || parsed.data.requestId !== message.requestId) return;
      finish();
      if (parsed.data.taskId !== message.visualCapture.taskId) {
        reject(Object.assign(new Error("Visual capture response task identity did not match its request."), { code: "visual_capture_identity_mismatch" }));
        return;
      }
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      postCancel();
      finish();
      reject(Object.assign(new Error("Figma visual capture timed out; the native root remains intact."), { code: "visual_capture_timeout" }));
    }, 15_000);
    if (signal.aborted) { window.clearTimeout(timer); reject(Object.assign(new Error("Visual capture was cancelled before dispatch."), { code: "visual_capture_cancelled" })); return; }
    signal.addEventListener("abort", cancel, { once: true });
    window.addEventListener("message", receive);
    try { parent.postMessage({ pluginMessage: message }, "*"); }
    catch {
      finish();
      reject(Object.assign(new Error("Figma did not accept the bounded visual capture request."), { code: "visual_capture_unavailable" }));
    }
  });
}

/** Correlates one bounded FW-4 sizing repair and fences it on task stop. */
export function taskNativeVisualRepairBridge(message: VisualRepairRequest, signal: AbortSignal): Promise<VisualRepairResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const postCancel = () => {
      try { parent.postMessage({ pluginMessage: { type: "task-native-visual-repair-cancel", requestId: message.request.requestId, taskId: message.request.taskId } }, "*"); }
      catch { /* Plugin closure cannot change the task owner's stopped state. */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      postCancel();
      finish();
      reject(Object.assign(new Error("Visual repair was cancelled before its receipt could be accepted."), { code: "visual_repair_cancelled" }));
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== parent) return;
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (!parsed.success || parsed.data.type !== "task-native-visual-repair-result" || parsed.data.result.requestId !== message.request.requestId) return;
      finish();
      const result = parsed.data.result;
      if (result.taskId !== message.request.taskId || result.screenId !== message.request.screenId ||
          result.rootId !== message.request.rootId || result.captureReceiptId !== message.request.captureReceiptId) {
        reject(Object.assign(new Error("Visual repair response identity did not match its request."), { code: "visual_repair_identity_mismatch" }));
        return;
      }
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      postCancel();
      finish();
      reject(Object.assign(new Error("Figma visual repair timed out; the original root remains intact."), { code: "visual_repair_timeout" }));
    }, 15_000);
    if (signal.aborted) {
      window.clearTimeout(timer);
      reject(Object.assign(new Error("Visual repair was cancelled before dispatch."), { code: "visual_repair_cancelled" }));
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    window.addEventListener("message", receive);
    try { parent.postMessage({ pluginMessage: message }, "*"); }
    catch {
      finish();
      reject(Object.assign(new Error("Figma did not accept the bounded visual repair request."), { code: "visual_repair_unavailable" }));
    }
  });
}
