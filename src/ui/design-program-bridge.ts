import { NativeRenderAttachmentEvidenceSchema, PluginToUISchema, type NativeRenderAttachmentEvidence, type PluginToUIMessage, type UIToPluginMessage } from "../shared/messages";
import { designProgramNativeRootRef, DesignProgramV1Schema, fingerprintDesignProgram } from "../shared/design-program";
import { FW2_FEATURE, ContextResultSchema, parseContextSnapshot, type ContextRead } from "../shared/design-context";
import { requestedDesignContext } from "../shared/chat-generation";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";
import { FW7_BUILD_ID } from "../shared/fw7-feature";

export type DesignProgramRenderRequest = Extract<UIToPluginMessage, { type: "design-program-render" }>;
export type DesignProgramRenderResponse = Extract<PluginToUIMessage, { type: "design-program-render-result" }>;
export type ContextResponse = Extract<PluginToUIMessage, { type: "design-context-result" }>;

export class NativeRenderBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly attachmentEvidence?: NativeRenderAttachmentEvidence,
  ) {
    super(message);
    this.name = "NativeRenderBridgeError";
  }
}

function renderFingerprint(request: DesignProgramRenderRequest): string | undefined {
  const program = DesignProgramV1Schema.safeParse(request.program);
  return program.success ? fingerprintDesignProgram(program.data) : undefined;
}

function attachmentEvidence(raw: unknown, request: DesignProgramRenderRequest, uiBuildId: string): NativeRenderAttachmentEvidence | undefined {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  if (value.type !== "design-program-render-result" || value.success !== true ||
      value.requestId !== request.requestId || value.taskId !== request.taskId) return;
  const parsed = NativeRenderAttachmentEvidenceSchema.safeParse({
    requestId: value.requestId, taskId: value.taskId, screenId: value.screenId,
    rootRef: value.rootRef, nativeRootNodeId: value.nativeRootNodeId,
    nativeParentNodeId: value.nativeParentNodeId, nativeBatchId: value.nativeBatchId,
    programFingerprint: value.programFingerprint, uiBuildId: value.uiBuildId,
    pluginBuildId: value.pluginBuildId, adoptionOperationIds: value.adoptionOperationIds,
    nativeNodeCount: value.nativeNodeCount,
  });
  if (!parsed.success) return;
  const screenId = request.program.screens[0]?.id;
  const fingerprint = renderFingerprint(request);
  if (!screenId || !fingerprint || parsed.data.screenId !== screenId ||
      parsed.data.rootRef !== designProgramNativeRootRef(request.program.id, screenId) ||
      parsed.data.nativeBatchId !== request.program.id || parsed.data.programFingerprint !== fingerprint ||
      parsed.data.uiBuildId !== uiBuildId || parsed.data.pluginBuildId !== uiBuildId) return;
  return parsed.data;
}

function renderAckDiagnostic(input: Record<string, unknown>): void {
  console.info("[FAD_NATIVE_RENDER_ACK] " + JSON.stringify(input));
}

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
  const uiBuildId = (window as Window & { __fadBuildId?: string }).__fadBuildId ?? FW7_BUILD_ID;
  const wireRequest: DesignProgramRenderRequest = { ...request, uiBuildId };
  const expectedScreenId = request.program.screens[0]?.id;
  const expectedFingerprint = renderFingerprint(request);
  const expectedRootRef = expectedScreenId ? designProgramNativeRootRef(request.program.id, expectedScreenId) : undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      if (event.source && event.source !== parent) return;
      const raw = event.data?.pluginMessage;
      if (!raw || typeof raw !== "object" || (raw as { requestId?: unknown }).requestId !== request.requestId) return;
      const rawMessage = raw as Record<string, unknown>;
      const parsed = PluginToUISchema.safeParse(raw);
      if (!parsed.success) {
        const evidence = attachmentEvidence(raw, request, uiBuildId);
        const issuePaths = parsed.error.issues.slice(0, 6).map(({ path, code }) => `${path.map(String).join(".") || "message"}:${code}`);
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", atMs: Date.now(), taskId: request.taskId,
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          requestType: wireRequest.type, responseType: typeof rawMessage.type === "string" ? rawMessage.type : "unknown",
          uiBuildId, pluginBuildId: typeof rawMessage.pluginBuildId === "string" ? rawMessage.pluginBuildId : "missing",
          nativeRootNodeId: typeof rawMessage.nativeRootNodeId === "string" ? rawMessage.nativeRootNodeId : undefined,
          nativeParentNodeId: typeof rawMessage.nativeParentNodeId === "string" ? rawMessage.nativeParentNodeId : undefined,
          attached: Boolean(evidence), receiptProduced: Array.isArray(rawMessage.adoptionOperationIds),
          receiptValid: Boolean(evidence), ownershipValidated: Boolean(evidence),
          checkpointState: "not_confirmed", rejectionStage: "response_schema", issuePaths,
          reason: evidence ? "invalid_non_ownership_response_field" : "invalid_or_incomplete_ownership_evidence" });
        finish();
        reject(new NativeRenderBridgeError(
          evidence
            ? "Figma attached and adopted this native root, but the render response had an invalid field. Resume will reconcile the same root before continuing."
            : "Figma returned a native render response without complete, matching ownership evidence. The root was retained for reconciliation.",
          evidence ? "native_render_ack_invalid_with_attachment" : "native_render_protocol_error",
          evidence,
        ));
        return;
      }
      if (parsed.data.type === "protocol-error") {
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", atMs: Date.now(), taskId: request.taskId,
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId,
          pluginBuildId: parsed.data.pluginBuildId ?? "unknown", attached: false,
          receiptProduced: false, receiptValid: false, ownershipValidated: false,
          checkpointState: "not_confirmed", rejectionStage: "plugin_protocol", reason: "protocol_error" });
        finish();
        reject(new NativeRenderBridgeError("The Figma plugin rejected the native render protocol request. Reload both runtimes before resuming.", "native_render_protocol_error"));
        return;
      }
      if (parsed.data.type !== "design-program-render-result") {
        finish();
        reject(new NativeRenderBridgeError("Figma returned an unexpected response for the native render request.", "native_render_unexpected_response"));
        return;
      }
      if (parsed.data.taskId !== request.taskId) {
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", atMs: Date.now(), taskId: request.taskId,
          responseTaskId: parsed.data.taskId, requestIdHash: fw7CorrelationHash(request.requestId),
          requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId,
          pluginBuildId: parsed.data.pluginBuildId ?? "unknown", attached: false,
          receiptProduced: false, receiptValid: false, ownershipValidated: false,
          checkpointState: "not_confirmed", rejectionStage: "task_correlation", reason: "task_id_mismatch" });
        finish();
        reject(new NativeRenderBridgeError("The native render response belongs to a different task.", "native_render_task_mismatch"));
        return;
      }
      if (parsed.data.uiBuildId !== uiBuildId || parsed.data.pluginBuildId !== uiBuildId) {
        const evidence = attachmentEvidence(raw, request, uiBuildId);
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", atMs: Date.now(), taskId: request.taskId,
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: parsed.data.screenId ?? expectedScreenId,
          requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId,
          responseUiBuildId: parsed.data.uiBuildId ?? "missing", pluginBuildId: parsed.data.pluginBuildId ?? "missing",
          nativeRootNodeId: parsed.data.nativeRootNodeId, nativeParentNodeId: parsed.data.nativeParentNodeId,
          attached: Boolean(evidence), receiptProduced: Boolean(parsed.data.adoptionOperationIds?.length),
          receiptValid: Boolean(evidence), ownershipValidated: Boolean(evidence), checkpointState: "not_confirmed",
          rejectionStage: "build_identity", reason: "runtime_build_mismatch" });
        finish();
        reject(new NativeRenderBridgeError("The UI and Figma plugin builds do not match. The same root will be reconciled after both runtimes are reloaded.",
          "native_render_build_mismatch", evidence));
        return;
      }
      const identityMatches = parsed.data.screenId === expectedScreenId &&
        parsed.data.programFingerprint === expectedFingerprint && parsed.data.rootRef === expectedRootRef &&
        parsed.data.nativeBatchId === request.program.id && parsed.data.nativeParentNodeId !== undefined;
      if (parsed.data.success && !identityMatches) {
        const evidence = attachmentEvidence(raw, request, uiBuildId);
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", atMs: Date.now(), taskId: request.taskId,
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: parsed.data.screenId,
          requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId, pluginBuildId: parsed.data.pluginBuildId,
          nativeRootNodeId: parsed.data.nativeRootNodeId, nativeParentNodeId: parsed.data.nativeParentNodeId,
          attached: Boolean(evidence), receiptProduced: Boolean(parsed.data.adoptionOperationIds?.length),
          receiptValid: Boolean(evidence), ownershipValidated: Boolean(evidence), checkpointState: "not_confirmed",
          rejectionStage: "ownership_identity", reason: "render_identity_mismatch" });
        finish();
        reject(new NativeRenderBridgeError("Figma returned a root or receipt that did not match the saved screen program.",
          "native_render_ownership_mismatch", evidence));
        return;
      }
      if (!parsed.data.success && parsed.data.screenId && parsed.data.screenId !== expectedScreenId) {
        finish();
        reject(new NativeRenderBridgeError("Figma returned a failed render receipt for a different screen.", "native_render_screen_mismatch"));
        return;
      }
      renderAckDiagnostic({ stage: "ui", event: "ack_received", atMs: Date.now(), taskId: request.taskId,
        requestIdHash: fw7CorrelationHash(request.requestId), screenId: parsed.data.screenId ?? expectedScreenId,
        requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId,
        pluginBuildId: parsed.data.pluginBuildId, nativeRootNodeId: parsed.data.nativeRootNodeId,
        nativeParentNodeId: parsed.data.nativeParentNodeId, attached: Boolean(parsed.data.nativeRootNodeId),
        receiptProduced: Boolean(parsed.data.adoptionOperationIds?.length), receiptValid: parsed.data.success,
        ownershipValidated: parsed.data.success,
        rendererGeometryReadback: parsed.data.success ? "complete" : parsed.data.errorCode,
        taskNativeReadback: "pending",
        checkpointState: "ui_task_checkpoint_pending", rejectionStage: "none", reason: parsed.data.errorCode ?? "none" });
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
      renderAckDiagnostic({ stage: "ui", event: "ack_timeout", atMs: Date.now(), taskId: request.taskId,
        requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
        requestType: wireRequest.type, uiBuildId, attached: false, receiptProduced: false,
        receiptValid: false, ownershipValidated: false, checkpointState: "not_confirmed",
        rejectionStage: "ack_timeout", reason: "native_render_ack_timeout" });
      reject(new NativeRenderBridgeError("Figma did not acknowledge the render in time. Resume will reconcile the saved native screen identity.", "native_render_ack_timeout"));
    }, 60_000);
    window.addEventListener("message", receive);
    try { parent.postMessage({ pluginMessage: wireRequest }, "*"); }
    catch {
      finish();
      reject(new NativeRenderBridgeError("Figma could not receive the native render request. Resume after reopening the plugin.", "native_render_transport_failed"));
      return;
    }
    fw7Telemetry.record({
      runId: request.taskId, taskId: request.taskId, screenId: request.program.screens[0]?.id,
      requestIdHash: fw7CorrelationHash(request.requestId), boundary: "ui-plugin", kind: "bridge_dispatch",
      stage: "native_render", operation: "design-program-render", result: "started", counter: "uiPluginDispatches",
    });
    renderAckDiagnostic({ stage: "ui", event: "request_dispatched", atMs: Date.now(), taskId: request.taskId,
      requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
      requestType: wireRequest.type, uiBuildId, expectedRootRef, expectedProgramFingerprint: expectedFingerprint,
      checkpointState: "program_saved_before_dispatch" });
  });
}
