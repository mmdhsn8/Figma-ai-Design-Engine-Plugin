import {
  PluginToUISchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";
import { matchNativeBridgeReply } from "./native-bridge-reply";

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
    const inspecting = message.type === "task-native-inspect";
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      const parsed = matchNativeBridgeReply(event.data?.pluginMessage, {
        requestId: message.requestId, taskId: inspecting ? message.taskId : undefined,
        type: inspecting ? "task-native-inspection-result" : "task-native-focus-result",
      });
      if (!parsed) return;
      if (!parsed.success || parsed.data.type === "protocol-error") {
        fw7Telemetry.record({ runId: message.taskId, taskId: message.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "bridge_ack_received", stage: "native_inspection", operation: "protocol-error", result: "failed", reasonCode: "protocol_error", counter: "uiPluginAcksReceived" });
        finish();
        reject(Object.assign(new Error("Figma rejected the task-layer request or returned invalid layer evidence. Reload the development plugin before retrying."), { code: "native_readback_protocol_error" }));
        return;
      }
      if (message.type === "task-native-inspect") {
        if (parsed.data.type !== "task-native-inspection-result" || parsed.data.requestId !== message.requestId) return;
        fw7Telemetry.record({ runId: message.taskId, taskId: message.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "bridge_ack_received", stage: "native_readback", operation: parsed.data.type, result: "received", counter: "uiPluginAcksReceived" });
        finish();
        fw7Telemetry.record({ runId: message.taskId, taskId: message.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "native_readback_result", stage: "native_readback", operation: "task-native-inspect", result: parsed.data.success ? parsed.data.geometry?.coverage === "complete" ? "confirmed" : "unverified" : "failed", observedCount: parsed.data.success ? parsed.data.nodes?.length ?? 0 : undefined, reasonCode: !parsed.data.success ? "native_readback_failed" : parsed.data.geometry?.coverage !== "complete" ? "readback_coverage_incomplete" : undefined });
        if (!parsed.data.success) reject(new Error(parsed.data.error ?? "The task-owned native layers could not be read."));
        else resolve(parsed.data);
      } else {
        if (parsed.data.type !== "task-native-focus-result" || parsed.data.requestId !== message.requestId) return;
        fw7Telemetry.record({ runId: message.taskId, taskId: message.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "bridge_ack_received", stage: "native_focus", operation: parsed.data.type, result: "received", counter: "uiPluginAcksReceived" });
        finish();
        if (!parsed.data.success) reject(new Error(parsed.data.error ?? "The task-owned nodes could not be focused."));
        else resolve(parsed.data);
      }
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(Object.assign(new Error("Figma did not respond to the task-layer request. Resume to retry native readback."), { code: "native_readback_timeout" }));
    }, 15_000);
    window.addEventListener("message", receive);
    try { parent.postMessage({ pluginMessage: message }, "*"); }
    catch {
      finish();
      reject(Object.assign(new Error("Figma could not receive the task-layer request. Reopen the plugin and retry."), { code: "native_readback_transport_failed" }));
      return;
    }
    fw7Telemetry.record({ runId: message.taskId, taskId: message.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "bridge_dispatch", stage: message.type === "task-native-inspect" ? "native_readback" : "native_focus", operation: message.type, result: "started", counter: "uiPluginDispatches" });
  });
}

export function taskNativeVisualCaptureBridge(message: VisualCaptureRequest, signal: AbortSignal): Promise<VisualCaptureResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const postCancel = () => {
      try {
        parent.postMessage({ pluginMessage: { type: "task-native-visual-capture-cancel", requestId: message.requestId,
          taskId: message.visualCapture.taskId, captureNonce: message.visualCapture.captureNonce } }, "*");
        fw7Telemetry.record({ runId: message.visualCapture.taskId, taskId: message.visualCapture.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "bridge_dispatch", stage: "visual_capture", operation: "task-native-visual-capture-cancel", result: "cancelled", counter: "uiPluginDispatches" });
        fw7Telemetry.record({ runId: message.visualCapture.taskId, taskId: message.visualCapture.taskId, boundary: "task-owner", kind: "cancellation", stage: "visual_capture", operation: "exportAsync", result: "cancelled", reasonCode: "capture_cancelled", counter: "cancellations" });
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
      fw7Telemetry.record({ runId: message.visualCapture.taskId, taskId: message.visualCapture.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "bridge_ack_received", stage: "visual_capture", operation: "task-native-visual-capture-result", result: "received", counter: "uiPluginAcksReceived" });
      fw7Telemetry.record({ runId: message.visualCapture.taskId, taskId: message.visualCapture.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "figma-api", kind: "visual_capture_result", stage: "visual_capture", operation: "exportAsync", result: parsed.data.success ? "succeeded" : "failed", durationMs: parsed.data.exportDurationMs, reasonCode: parsed.data.success ? undefined : parsed.data.receipt?.diagnostic });
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
    try { parent.postMessage({ pluginMessage: message }, "*"); fw7Telemetry.record({ runId: message.visualCapture.taskId, taskId: message.visualCapture.taskId, requestIdHash: fw7CorrelationHash(message.requestId), boundary: "ui-plugin", kind: "visual_capture_started", stage: "visual_capture", operation: "task-native-visual-capture", result: "started", counter: "uiPluginDispatches" }); }
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
      try { parent.postMessage({ pluginMessage: { type: "task-native-visual-repair-cancel", requestId: message.request.requestId, taskId: message.request.taskId } }, "*"); fw7Telemetry.record({ runId: message.request.taskId, taskId: message.request.taskId, requestIdHash: fw7CorrelationHash(message.request.requestId), boundary: "ui-plugin", kind: "bridge_dispatch", stage: "visual_repair", operation: "task-native-visual-repair-cancel", result: "cancelled", counter: "uiPluginDispatches" }); }
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
      fw7Telemetry.record({ runId: message.request.taskId, taskId: message.request.taskId, requestIdHash: fw7CorrelationHash(message.request.requestId), boundary: "ui-plugin", kind: "bridge_ack_received", stage: "visual_repair", operation: "task-native-visual-repair-result", result: "received", counter: "uiPluginAcksReceived" });
      fw7Telemetry.record({ runId: message.request.taskId, taskId: message.request.taskId, requestIdHash: fw7CorrelationHash(message.request.requestId), boundary: "figma-api", kind: "visual_repair_result", stage: "visual_repair", operation: "task-native-visual-repair", result: parsed.data.result.status === "APPLIED" ? "applied" : "failed", reasonCode: parsed.data.result.status === "REJECTED" ? "repair_rejected" : undefined });
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
    try { parent.postMessage({ pluginMessage: message }, "*"); fw7Telemetry.record({ runId: message.request.taskId, taskId: message.request.taskId, requestIdHash: fw7CorrelationHash(message.request.requestId), boundary: "ui-plugin", kind: "bridge_dispatch", stage: "visual_repair", operation: "task-native-visual-repair", result: "started", counter: "uiPluginDispatches" }); }
    catch {
      finish();
      reject(Object.assign(new Error("Figma did not accept the bounded visual repair request."), { code: "visual_repair_unavailable" }));
    }
  });
}
