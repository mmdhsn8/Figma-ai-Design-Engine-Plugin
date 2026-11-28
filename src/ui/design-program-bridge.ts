import { NativeRenderAttachmentEvidenceSchema, PluginToUISchema, type NativeRenderAttachmentEvidence, type PluginToUIMessage, type UIToPluginMessage } from "../shared/messages";
import { DESIGN_PROGRAM_LIMITS, designProgramNativeRootRef, DesignProgramV1Schema, fingerprintDesignProgram } from "../shared/design-program";
import { FW2_FEATURE, ContextResultSchema, parseContextSnapshot, type ContextRead } from "../shared/design-context";
import { requestedDesignContext } from "../shared/chat-generation";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash, nativeRenderReceiptId } from "../shared/fw7-observability";
import { FW7_BUILD_ID } from "../shared/fw7-feature";

export type DesignProgramRenderRequest = Extract<UIToPluginMessage, { type: "design-program-render" }>;
export type DesignProgramRenderResponse = Extract<PluginToUIMessage, { type: "design-program-render-result" }>;
export type DesignProgramRenderProgress = Extract<PluginToUIMessage, { type: "design-program-render-progress" }>;
export type ContextResponse = Extract<PluginToUIMessage, { type: "design-context-result" }>;

export const NATIVE_RENDER_ACK_LIMITS = {
  progressSilenceDiagnosticMs: 35_000,
  baseDeadlineMs: 60_000,
  perNodeBudgetMs: 500,
  absoluteDeadlineMs: 240_000,
  heartbeatMs: 10_000,
  lateObservationMs: 120_000,
  maxLateObservers: 30,
} as const;

export function nativeRenderAckBudgetMs(program: DesignProgramRenderRequest["program"]): number {
  const count = (node: typeof program.screens[number]["root"]): number =>
    1 + (node.type === "container" ? node.children.reduce((sum, child) => sum + count(child), 0) : 0);
  const total = program.screens.reduce((sum, screen) => sum + count(screen.root), 0) +
    (program.componentsV1 ?? []).reduce((sum, component) => sum + count(component.root), 0);
  const nodes = Math.min(DESIGN_PROGRAM_LIMITS.nodes, total);
  return Math.min(NATIVE_RENDER_ACK_LIMITS.absoluteDeadlineMs,
    NATIVE_RENDER_ACK_LIMITS.baseDeadlineMs + nodes * NATIVE_RENDER_ACK_LIMITS.perNodeBudgetMs);
}

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
    taskGeneration: value.taskGeneration,
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
  if (request.taskGeneration && parsed.data.taskGeneration !== request.taskGeneration) return;
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
  options: { signal?: AbortSignal; onProgress?: (progress: DesignProgramRenderProgress) => void } = {},
): Promise<DesignProgramRenderResponse> {
  const uiBuildId = (window as Window & { __fadBuildId?: string }).__fadBuildId ?? FW7_BUILD_ID;
  const wireRequest: DesignProgramRenderRequest = { ...request, uiBuildId };
  const expectedScreenId = request.program.screens[0]?.id;
  const expectedFingerprint = renderFingerprint(request);
  const expectedRootRef = expectedScreenId ? designProgramNativeRootRef(request.program.id, expectedScreenId) : undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const startedMonotonic = typeof performance !== "undefined" ? performance.now() : startedAt;
    const absoluteBudgetMs = nativeRenderAckBudgetMs(request.program);
    let lastProgressAt = startedAt;
    let lastProgressStage = "ui_request_queued";
    let lastProgressSequence = 0;
    let observedRootNodeId: string | undefined;
    let observedParentNodeId: string | undefined;
    let observedPageId: string | undefined;
    let observedRootAttached = false;
    let progressCount = 0;
    let progressSilenceReported = false;
    let idleTimer: number | undefined;
    let ackConfirmationSent = false;
    const elapsed = () => Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedMonotonic));
    const removeActiveListeners = () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      if (hardTimer !== undefined) window.clearTimeout(hardTimer);
      window.removeEventListener("message", receive);
      options.signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      removeActiveListeners();
    };
    const pushLateObserver = () => installLateDesignRenderObserver(wireRequest, uiBuildId);
    const confirmPluginResponse = (accepted: boolean, receiptId?: string, pluginBuildId = uiBuildId) => {
      if (ackConfirmationSent || !expectedScreenId) return;
      ackConfirmationSent = true;
      try {
        parent.postMessage({ pluginMessage: {
          type: "design-program-render-ack-confirm", requestId: request.requestId, taskId: request.taskId,
          ...(request.taskGeneration ? { taskGeneration: request.taskGeneration } : {}), screenId: expectedScreenId,
          uiBuildId, pluginBuildId, accepted, ...(receiptId ? { receiptId } : {}),
        } }, "*");
        renderAckDiagnostic({ stage: "ui", event: "ack_confirmation_dispatched", eventAtMs: Date.now(), elapsedMs: elapsed(),
          taskId: request.taskId, taskGeneration: request.taskGeneration,
          taskGenerationHash: fw7CorrelationHash(request.taskGeneration), requestId: request.requestId,
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          uiBuildId, pluginBuildId, receiptId, accepted, reason: "stop_plugin_ack_heartbeat" });
      } catch {
        renderAckDiagnostic({ stage: "ui", event: "ack_confirmation_dispatch_failed", eventAtMs: Date.now(), elapsedMs: elapsed(),
          taskId: request.taskId, requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          receiptId, rejectionStage: "ack_confirmation_transport", reason: "post_message_failed" });
      }
    };
    const rejectTerminal = (kind: "timeout" | "cancelled") => {
      if (settled) return;
      const durationMs = elapsed();
      pushLateObserver();
      finish();
      renderAckDiagnostic({ stage: "ui", event: kind === "timeout" ? "ack_timeout" : "render_cancelled",
        eventAtMs: Date.now(), elapsedMs: durationMs, taskId: request.taskId,
        taskGeneration: request.taskGeneration, taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
        requestId: request.requestId, requestIdHash: fw7CorrelationHash(request.requestId),
        screenId: expectedScreenId, requestType: wireRequest.type, uiBuildId,
        absoluteBudgetMs, lastProgressStage, lastProgressAgeMs: Math.max(0, Date.now() - lastProgressAt), progressCount,
        progressSilenceReported,
        dispatchState: "sent", observedAttachment: observedRootAttached,
        nativeRootNodeId: observedRootNodeId, nativeParentNodeId: observedParentNodeId, pageId: observedPageId,
        receiptProduced: false, receiptValid: false, ownershipValidated: false,
        checkpointState: "pre-render-checkpoint-confirmed; native-result-unconfirmed",
        rejectionStage: kind === "timeout" ? "ack_deadline" : "stop_signal",
        reason: kind === "timeout" ? "render_absolute_deadline" : "task_stopped" });
      if (kind === "timeout") reject(new NativeRenderBridgeError(
        "Figma did not acknowledge the render before its bounded deadline. Any attached root is retained; Resume will reconcile the saved screen identity.",
        "native_render_ack_timeout"));
      else reject(new NativeRenderBridgeError(
        "The task stopped while native rendering was in flight. Any attached root is retained for reconciliation on Resume.",
        "native_render_cancelled"));
    };
    const resetIdleTimer = () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined;
        if (settled || progressSilenceReported) return;
        progressSilenceReported = true;
        renderAckDiagnostic({ stage: "ui", event: "progress_silence_detected", eventAtMs: Date.now(), elapsedMs: elapsed(),
          taskId: request.taskId, taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId, uiBuildId,
          lastProgressStage, lastProgressAgeMs: Math.max(0, Date.now() - lastProgressAt), progressCount,
          absoluteBudgetMs, rejectionStage: "progress_watchdog", reason: "awaiting_absolute_render_deadline" });
      }, NATIVE_RENDER_ACK_LIMITS.progressSilenceDiagnosticMs);
    };
    const cancel = () => rejectTerminal("cancelled");
    const recordProgress = (progress: DesignProgramRenderProgress) => {
      if (progress.taskId !== request.taskId || progress.screenId !== expectedScreenId ||
          (request.taskGeneration && progress.taskGeneration !== request.taskGeneration)) {
        renderAckDiagnostic({ stage: "ui", event: "progress_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(),
          taskId: request.taskId, taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          responseTaskId: progress.taskId, responseScreenId: progress.screenId,
          rejectionStage: "progress_correlation", reason: "task_screen_generation_mismatch" });
        return;
      }
      if (progress.uiBuildId !== uiBuildId || progress.pluginBuildId !== uiBuildId) {
        renderAckDiagnostic({ stage: "ui", event: "progress_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(),
          taskId: request.taskId, requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          uiBuildId, responseUiBuildId: progress.uiBuildId, pluginBuildId: progress.pluginBuildId,
          rejectionStage: "progress_build_identity", reason: "runtime_build_mismatch" });
        return;
      }
      if (progress.sequence <= lastProgressSequence) {
        renderAckDiagnostic({ stage: "ui", event: "progress_ignored", eventAtMs: Date.now(), elapsedMs: elapsed(),
          taskId: request.taskId, requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
          progressSequence: progress.sequence, lastProgressSequence, rejectionStage: "progress_sequence", reason: "duplicate_or_out_of_order" });
        return;
      }
      lastProgressSequence = progress.sequence;
      lastProgressAt = Date.now();
      lastProgressStage = progress.stage;
      progressCount++;
      observedRootNodeId = progress.nativeRootNodeId ?? observedRootNodeId;
      observedParentNodeId = progress.nativeParentNodeId ?? observedParentNodeId;
      observedPageId = progress.pageId ?? observedPageId;
      if (progress.nativeRootNodeId && progress.nativeParentNodeId && progress.nativeParentNodeId === progress.pageId)
        observedRootAttached = true;
      resetIdleTimer();
      renderAckDiagnostic({ stage: "ui", event: "render_progress_received", eventAtMs: Date.now(), elapsedMs: elapsed(),
        pluginElapsedMs: progress.elapsedMs, taskId: request.taskId, taskGeneration: request.taskGeneration,
        taskGenerationHash: fw7CorrelationHash(request.taskGeneration), requestId: request.requestId,
        requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
        uiBuildId, pluginBuildId: progress.pluginBuildId, progressSequence: progress.sequence,
        progressStage: progress.stage, pageId: progress.pageId, nativeRootNodeId: progress.nativeRootNodeId,
        nativeParentNodeId: progress.nativeParentNodeId, nativeNodeCount: progress.nativeNodeCount,
        operationCount: progress.operationCount, receiptId: progress.receiptId,
        absoluteBudgetMs, rejectionStage: "none", reason: "correlated_plugin_progress" });
      try { options.onProgress?.(progress); }
      catch { renderAckDiagnostic({ stage: "ui", event: "progress_consumer_failed", eventAtMs: Date.now(), elapsedMs: elapsed(),
        taskId: request.taskId, requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
        rejectionStage: "progress_consumer", reason: "consumer_callback_threw" }); }
    };
    const receive = (event: MessageEvent) => {
      if (event.source && event.source !== parent) return;
      const raw = event.data?.pluginMessage;
      if (!raw || typeof raw !== "object") return;
      const rawMessage = raw as Record<string, unknown>;
      if (rawMessage.requestId !== request.requestId) {
        if ((rawMessage.type === "design-program-render-result" || rawMessage.type === "design-program-render-progress") && rawMessage.taskId === request.taskId)
          renderAckDiagnostic({ stage: "ui", event: "out_of_order_response_ignored", eventAtMs: Date.now(), elapsedMs: elapsed(),
            taskId: request.taskId, requestIdHash: fw7CorrelationHash(request.requestId),
            responseRequestIdHash: fw7CorrelationHash(typeof rawMessage.requestId === "string" ? rawMessage.requestId : undefined),
            screenId: expectedScreenId, responseType: rawMessage.type, rejectionStage: "request_correlation", reason: "different_request_id" });
        return;
      }
      const parsed = PluginToUISchema.safeParse(raw);
      if (!parsed.success) {
        const evidence = attachmentEvidence(raw, request, uiBuildId);
        if (rawMessage.type === "design-program-render-result" && rawMessage.taskId === request.taskId) {
          const receiptId = evidence ? nativeRenderReceiptId({ requestId: request.requestId, taskId: request.taskId,
            screenId: evidence.screenId, rootNodeId: evidence.nativeRootNodeId, operationIds: evidence.adoptionOperationIds }) : undefined;
          confirmPluginResponse(false, receiptId, typeof rawMessage.pluginBuildId === "string" ? rawMessage.pluginBuildId : uiBuildId);
        }
        const issuePaths = parsed.error.issues.slice(0, 6).map(({ path, code }) => `${path.map(String).join(".") || "message"}:${code}`);
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
          taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
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
      if (parsed.data.type === "design-program-render-progress") {
        recordProgress(parsed.data);
        return;
      }
      if (parsed.data.type === "protocol-error") {
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
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
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
          responseTaskId: parsed.data.taskId, requestIdHash: fw7CorrelationHash(request.requestId),
          requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId,
          pluginBuildId: parsed.data.pluginBuildId ?? "unknown", attached: false,
          receiptProduced: false, receiptValid: false, ownershipValidated: false,
          checkpointState: "not_confirmed", rejectionStage: "task_correlation", reason: "task_id_mismatch" });
        finish();
        reject(new NativeRenderBridgeError("The native render response belongs to a different task.", "native_render_task_mismatch"));
        return;
      }
      if (parsed.data.type === "design-program-render-result") {
        const ackReceiptId = parsed.data.success && parsed.data.nativeRootNodeId && parsed.data.screenId && parsed.data.adoptionOperationIds
          ? nativeRenderReceiptId({ requestId: request.requestId, taskId: request.taskId, screenId: parsed.data.screenId,
              rootNodeId: parsed.data.nativeRootNodeId, operationIds: parsed.data.adoptionOperationIds }) : undefined;
        const generationMatches = !request.taskGeneration || parsed.data.taskGeneration === request.taskGeneration;
        const buildMatches = parsed.data.uiBuildId === uiBuildId && parsed.data.pluginBuildId === uiBuildId;
        const identityMatches = parsed.data.screenId === expectedScreenId && parsed.data.programFingerprint === expectedFingerprint &&
          parsed.data.rootRef === expectedRootRef && parsed.data.nativeBatchId === request.program.id &&
          parsed.data.nativeParentNodeId !== undefined;
        const screenMatches = !parsed.data.screenId || parsed.data.screenId === expectedScreenId;
        confirmPluginResponse(generationMatches && buildMatches && screenMatches && (!parsed.data.success || identityMatches),
          ackReceiptId, parsed.data.pluginBuildId ?? uiBuildId);
      }
      if (request.taskGeneration && parsed.data.taskGeneration !== request.taskGeneration) {
        const evidence = attachmentEvidence(raw, request, uiBuildId);
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
          taskGenerationHash: fw7CorrelationHash(request.taskGeneration), responseTaskGenerationHash: fw7CorrelationHash(parsed.data.taskGeneration),
          requestIdHash: fw7CorrelationHash(request.requestId), screenId: parsed.data.screenId ?? expectedScreenId,
          responseType: parsed.data.type, nativeRootNodeId: parsed.data.nativeRootNodeId, nativeParentNodeId: parsed.data.nativeParentNodeId,
          attached: Boolean(evidence), receiptProduced: Boolean(parsed.data.adoptionOperationIds?.length), receiptValid: Boolean(evidence),
          ownershipValidated: Boolean(evidence), checkpointState: "not_confirmed", rejectionStage: "task_generation", reason: "task_generation_mismatch" });
        finish();
        reject(new NativeRenderBridgeError("The native render response belongs to a different task generation.", "native_render_generation_mismatch", evidence));
        return;
      }
      if (parsed.data.uiBuildId !== uiBuildId || parsed.data.pluginBuildId !== uiBuildId) {
        const evidence = attachmentEvidence(raw, request, uiBuildId);
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
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
        renderAckDiagnostic({ stage: "ui", event: "ack_rejected", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
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
      const receiptId = parsed.data.success && parsed.data.nativeRootNodeId && parsed.data.adoptionOperationIds
        ? nativeRenderReceiptId({ requestId: request.requestId, taskId: request.taskId, screenId: parsed.data.screenId!,
            rootNodeId: parsed.data.nativeRootNodeId, operationIds: parsed.data.adoptionOperationIds }) : undefined;
      renderAckDiagnostic({ stage: "ui", event: "ack_received", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
        taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
        requestIdHash: fw7CorrelationHash(request.requestId), screenId: parsed.data.screenId ?? expectedScreenId,
        requestType: wireRequest.type, responseType: parsed.data.type, uiBuildId,
        pluginBuildId: parsed.data.pluginBuildId, nativeRootNodeId: parsed.data.nativeRootNodeId,
        nativeParentNodeId: parsed.data.nativeParentNodeId, attached: Boolean(parsed.data.nativeRootNodeId),
        pageId: observedPageId, receiptId,
        receiptProduced: Boolean(parsed.data.adoptionOperationIds?.length), receiptValid: parsed.data.success,
        ownershipValidated: parsed.data.success,
        rendererGeometryReadback: parsed.data.success ? "complete" : parsed.data.errorCode,
        taskNativeReadback: "pending",
        checkpointState: "ui_task_checkpoint_pending", rejectionStage: "none", reason: parsed.data.errorCode ?? "none" });
      renderAckDiagnostic({ stage: "ui", event: "ack_validated", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
        taskGenerationHash: fw7CorrelationHash(request.taskGeneration), requestIdHash: fw7CorrelationHash(request.requestId),
        screenId: parsed.data.screenId ?? expectedScreenId, nativeRootNodeId: parsed.data.nativeRootNodeId,
        nativeParentNodeId: parsed.data.nativeParentNodeId, pageId: observedPageId, receiptId,
        uiBuildId, pluginBuildId: parsed.data.pluginBuildId, ownershipValidated: parsed.data.success,
        rejectionStage: parsed.data.success ? "none" : "renderer_result", reason: parsed.data.errorCode ?? "valid_ack" });
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
    const hardTimer = window.setTimeout(() => rejectTerminal("timeout"), absoluteBudgetMs);
    resetIdleTimer();
    window.addEventListener("message", receive);
    if (options.signal?.aborted) { cancel(); return; }
    options.signal?.addEventListener("abort", cancel, { once: true });
    renderAckDiagnostic({ stage: "ui", event: "request_sent", eventAtMs: Date.now(), elapsedMs: elapsed(),
      taskId: request.taskId, taskGeneration: request.taskGeneration,
      taskGenerationHash: fw7CorrelationHash(request.taskGeneration), requestId: request.requestId,
      requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
      requestType: wireRequest.type, uiBuildId, expectedRootRef, expectedProgramFingerprint: expectedFingerprint,
      absoluteBudgetMs, checkpointState: "program_saved_before_dispatch", dispatchState: "post_message_start" });
    try {
      parent.postMessage({ pluginMessage: wireRequest }, "*");
      resetIdleTimer();
    }
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
    renderAckDiagnostic({ stage: "ui", event: "request_dispatched", eventAtMs: Date.now(), elapsedMs: elapsed(), taskId: request.taskId,
      taskGeneration: request.taskGeneration, taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
      requestId: request.requestId, requestIdHash: fw7CorrelationHash(request.requestId), screenId: expectedScreenId,
      requestType: wireRequest.type, uiBuildId, expectedRootRef, expectedProgramFingerprint: expectedFingerprint,
      pageId: undefined, absoluteBudgetMs, maxLegalNodes: DESIGN_PROGRAM_LIMITS.nodes,
      checkpointState: "program_saved_before_dispatch", dispatchState: "sent" });
  });
}

type LateRenderObserver = { request: DesignProgramRenderRequest; uiBuildId: string; timer: number };
const lateRenderObservers = new Map<string, LateRenderObserver>();
let lateRenderListenerInstalled = false;

function removeLateRenderObserver(requestId: string): void {
  const observer = lateRenderObservers.get(requestId);
  if (!observer) return;
  window.clearTimeout(observer.timer);
  lateRenderObservers.delete(requestId);
  if (!lateRenderObservers.size && lateRenderListenerInstalled) {
    window.removeEventListener("message", receiveLateRenderMessage);
    lateRenderListenerInstalled = false;
  }
}

function receiveLateRenderMessage(event: MessageEvent): void {
  if (event.source && event.source !== parent) return;
  const raw = event.data?.pluginMessage;
  if (!raw || typeof raw !== "object") return;
  const rawMessage = raw as Record<string, unknown>;
  if (typeof rawMessage.requestId !== "string") return;
  const observer = lateRenderObservers.get(rawMessage.requestId);
  if (!observer) return;
  const parsed = PluginToUISchema.safeParse(raw);
  if (!parsed.success) {
    if (rawMessage.type === "design-program-render-result")
      renderAckDiagnostic({ stage: "ui", event: "late_ack_rejected", eventAtMs: Date.now(), taskId: observer.request.taskId,
        taskGenerationHash: fw7CorrelationHash(observer.request.taskGeneration), requestIdHash: fw7CorrelationHash(observer.request.requestId),
        screenId: observer.request.program.screens[0]?.id, rejectionStage: "response_schema", reason: "malformed_late_response" });
    return;
  }
  if (parsed.data.type === "design-program-render-progress") {
    if (parsed.data.requestId !== observer.request.requestId) return;
    renderAckDiagnostic({ stage: "ui", event: "late_render_progress", eventAtMs: Date.now(), taskId: observer.request.taskId,
      taskGenerationHash: fw7CorrelationHash(observer.request.taskGeneration), requestIdHash: fw7CorrelationHash(observer.request.requestId),
      screenId: observer.request.program.screens[0]?.id, progressStage: parsed.data.stage,
      pluginBuildId: parsed.data.pluginBuildId, elapsedMs: parsed.data.elapsedMs, reason: "render_after_ui_deadline" });
    return;
  }
  if (!parsed.success || parsed.data.type !== "design-program-render-result") return;
  const request = observer.request;
  const result = parsed.data;
  const evidence = attachmentEvidence(raw, request, observer.uiBuildId);
  const expectedFingerprint = renderFingerprint(request);
  const expectedScreenId = request.program.screens[0]?.id;
  const identityMatches = result.taskId === request.taskId && result.screenId === expectedScreenId &&
    result.programFingerprint === expectedFingerprint && result.rootRef === (expectedScreenId ? designProgramNativeRootRef(request.program.id, expectedScreenId) : undefined) &&
    result.nativeBatchId === request.program.id && result.uiBuildId === observer.uiBuildId && result.pluginBuildId === observer.uiBuildId &&
    (!request.taskGeneration || result.taskGeneration === request.taskGeneration);
  const receiptId = result.success && result.nativeRootNodeId && result.adoptionOperationIds
    ? nativeRenderReceiptId({ requestId: request.requestId, taskId: request.taskId, screenId: result.screenId!,
        rootNodeId: result.nativeRootNodeId, operationIds: result.adoptionOperationIds }) : undefined;
  renderAckDiagnostic({ stage: "ui", event: "late_ack_observed", eventAtMs: Date.now(), taskId: request.taskId,
    taskGeneration: request.taskGeneration, taskGenerationHash: fw7CorrelationHash(request.taskGeneration),
    requestId: request.requestId, requestIdHash: fw7CorrelationHash(request.requestId),
    screenId: result.screenId ?? expectedScreenId, responseType: result.type,
    uiBuildId: observer.uiBuildId, pluginBuildId: result.pluginBuildId,
    nativeRootNodeId: result.nativeRootNodeId, nativeParentNodeId: result.nativeParentNodeId,
    receiptId, attached: Boolean(evidence), receiptValid: Boolean(evidence && identityMatches),
    ownershipValidated: Boolean(evidence && identityMatches), checkpointState: "resume_reconciliation_required",
    rejectionStage: evidence && identityMatches ? "late_after_deadline" : "late_receipt_invalid",
    reason: evidence && identityMatches ? "valid_receipt_arrived_after_ui_timeout" : "late_response_not_accepted" });
  try {
    parent.postMessage({ pluginMessage: { type: "design-program-render-ack-confirm", requestId: request.requestId,
      taskId: request.taskId, ...(request.taskGeneration ? { taskGeneration: request.taskGeneration } : {}),
      screenId: expectedScreenId!, uiBuildId: observer.uiBuildId,
      pluginBuildId: result.pluginBuildId ?? observer.uiBuildId, accepted: false, ...(receiptId ? { receiptId } : {}) } }, "*");
  } catch { /* Late acknowledgement is diagnostic only; Resume remains the checkpoint owner. */ }
  removeLateRenderObserver(request.requestId);
}

function installLateDesignRenderObserver(request: DesignProgramRenderRequest, uiBuildId: string): void {
  if (lateRenderObservers.has(request.requestId)) return;
  while (lateRenderObservers.size >= NATIVE_RENDER_ACK_LIMITS.maxLateObservers) {
    const oldest = lateRenderObservers.keys().next().value as string | undefined;
    if (!oldest) break;
    removeLateRenderObserver(oldest);
  }
  const timer = window.setTimeout(() => removeLateRenderObserver(request.requestId), NATIVE_RENDER_ACK_LIMITS.lateObservationMs);
  lateRenderObservers.set(request.requestId, { request, uiBuildId, timer });
  if (!lateRenderListenerInstalled) {
    window.addEventListener("message", receiveLateRenderMessage);
    lateRenderListenerInstalled = true;
  }
}
