import { countDesignNodes, parseDesignText } from "../shared/schema";
import { isMultiScreenInput, parseMultiScreenText } from "../shared/multi-screen-schema";
import {
  UIToPluginSchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";
import { FigmaToolStateDiagnosticSchema } from "../shared/figma-tools";
import type { DesignSpec } from "../shared/schema";
import type { MultiScreenSpec } from "../shared/multi-screen-schema";
import { renderDesign, renderMultiScreenDesign } from "./renderer";
import { collectFontRequirements, unavailableFontWarnings } from "./font-preflight";
import { createGenerationController } from "./generation-controller";
import { createFigmaToolExecutor } from "./figma-tool-executor";
import { renderDesignProgramLocal } from "./design-program-spike";
import { handleChatTaskStorage } from "./chat-task-storage";
import { checkpointHash, decodeChatTaskStorageMessage, traceCheckpoint } from "../shared/chat-checkpoint-wire";
import { FW7_BUILD_ID } from "../shared/fw7-feature";
import { handleChatHistoryStorage } from "./chat-history-storage";
import { handleModelPreferenceStorage } from "./model-preference-storage";
import { handleDesignEnginePreferenceStorage } from "./design-engine-preference-storage";
import { handleBrandKitStorage, PinnedBrandAssetResolutionError, resolvePinnedBrandVisualAssets } from "./brand-kit-storage";
import { handleDesignSkillStorage } from "./design-skill-storage";
import { FW2_ENABLED } from "../shared/design-context-feature";
import { createDesignContextController } from "./design-context-controller";
import { prepareContextReuse } from "./design-context-reuse";
import { FW5_VISUAL_QA_ENABLED } from "../shared/fw5-visual-qa-feature";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";

figma.showUI(__html__, { width: 440, height: 720, themeColors: true });
const COMPANION_RESTORE_TICKET_KEY = "companion-restore-ticket-v1";
let checkpointRuntimeCompatible = false;

function send(message: PluginToUIMessage, taskId?: string): void {
  figma.ui.postMessage(message);
  const typed = message as PluginToUIMessage & { requestId?: string; taskId?: string; nativeRootNodeId?: string; success?: boolean; revision?: { hash: string; bytes: number } };
  const id = taskId ?? typed.taskId;
  const runId = id ?? typed.requestId ?? "plugin-unscoped";
  if (["design-program-render-result", "task-native-inspection-result", "task-native-visual-capture-result", "task-native-visual-repair-result", "chat-task-result"].includes(message.type)) {
    fw7Telemetry.record({ runId, ...(id ? { taskId: id } : {}), requestIdHash: fw7CorrelationHash(typed.requestId), rootNodeHash: fw7CorrelationHash(typed.nativeRootNodeId), boundary: "ui-plugin", kind: "bridge_response_sent", stage: message.type === "chat-task-result" ? "checkpoint" : "native", operation: message.type, result: typed.success === false ? "failed" : "received", ...(message.type === "chat-task-result" ? { checkpointRevisionHash: typed.revision?.hash, checkpointBytes: typed.revision?.bytes, counter: "checkpointAcksSent" as const } : { counter: "pluginResponsesSent" as const }) });
    if (message.type === "chat-task-result")
      fw7Telemetry.record({ runId, ...(id ? { taskId: id } : {}), requestIdHash: fw7CorrelationHash(typed.requestId), checkpointRevisionHash: typed.revision?.hash, checkpointBytes: typed.revision?.bytes, boundary: "checkpoint-owner", kind: "checkpoint_ack", stage: "checkpoint", operation: "chat-task-result", result: typed.success === false ? "failed" : "succeeded" });
  }
}

function toolRequestId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as Record<string, unknown>;
  const value = typeof message.requestId === "string" ? message.requestId : message.batchId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value) ? value : undefined;
}

function reportToolExecutorFailure(
  message: Extract<UIToPluginMessage, { type: "tool-execute" | "tool-delete-consent" }>,
  error: unknown,
): void {
  const details = (
    error instanceof Error ? error.message : "The plugin executor failed unexpectedly."
  ).slice(0, 400);
  const diagnostic =
    error && typeof error === "object" && "diagnostic" in error
      ? FigmaToolStateDiagnosticSchema.safeParse(error.diagnostic)
      : undefined;
  const toolStateDiagnostic = diagnostic?.success ? diagnostic.data : undefined;
  if (message.type === "tool-delete-consent") {
    send({
      type: "tool-delete-consent-result",
      protocolVersion: 1,
      requestId: message.requestId,
      success: false,
      message: details.slice(0, 300),
      ...(toolStateDiagnostic ? { toolStateDiagnostic } : {}),
    });
    return;
  }
  send({
    type: "tool-result",
    protocolVersion: 1,
    batchId: message.batchId,
    success: false,
    cancelled: false,
    committedOperationIds: [],
    partialOperationIds:
      message.operations[0] &&
      [
        "create_frame",
        "create_text",
        "create_rectangle",
        "set_auto_layout",
        "set_properties",
        "append_child",
        "reparent_node",
        "delete_node",
      ].includes(message.operations[0].action.tool)
        ? [message.operations[0].operationId]
        : [],
    results: message.operations.map((operation, index) => ({
      operationId: operation.operationId,
      success: false,
      replayed: false,
      acknowledgementStatus:
        index === 0 &&
        [
          "create_frame",
          "create_text",
          "create_rectangle",
          "set_auto_layout",
          "set_properties",
          "append_child",
          "reparent_node",
          "delete_node",
        ].includes(operation.action.tool)
          ? "ambiguous"
          : "not_attempted",
      error: index === 0 ? details : "Not attempted after the plugin executor stopped.",
      ...(index === 0 && toolStateDiagnostic ? { data: { toolStateDiagnostic } } : {}),
    })),
  });
}

const generationController = createGenerationController(figma, send);
const figmaToolExecutor = createFigmaToolExecutor(figma, send);
function activeDocumentId() {
  const fileId = figma.fileKey ?? figma.root.getPluginData("fad.document-id");
  return fileId ? `${fileId}-${figma.currentPage.id.replaceAll(":", "_")}` : undefined;
}
const designContext = createDesignContextController(figma, FW2_ENABLED, activeDocumentId);

async function fontWarnings(input: DesignSpec | MultiScreenSpec): Promise<string[]> {
  try {
    const fonts = await figma.listAvailableFontsAsync();
    return unavailableFontWarnings(
      collectFontRequirements(input),
      fonts.map(({ fontName }) => fontName),
    );
  } catch {
    return [
      "Figma could not list available fonts during validation; generation will still report actual font fallbacks.",
    ];
  }
}

figma.ui.onmessage = async (rawMessage: unknown) => {
  if (rawMessage && typeof rawMessage === "object" && "type" in rawMessage &&
      rawMessage.type === "plugin-runtime-handshake") {
    const handshake = UIToPluginSchema.safeParse(rawMessage);
    if (!handshake.success) {
      checkpointRuntimeCompatible = false;
      send({ type: "protocol-error", requestId: toolRequestId(rawMessage), message: "The plugin runtime handshake was invalid. Reload the development plugin." });
      return;
    }
    if (handshake.data.type !== "plugin-runtime-handshake") return;
    const compatible = handshake.data.protocolVersion === 1 && handshake.data.buildId === FW7_BUILD_ID;
    checkpointRuntimeCompatible = compatible;
    send({
      type: "plugin-runtime-handshake-result",
      requestId: handshake.data.requestId,
      protocolVersion: 1,
      uiBuildId: handshake.data.buildId,
      pluginBuildId: FW7_BUILD_ID,
      compatible,
    });
    return;
  }
  if (rawMessage && typeof rawMessage === "object" && "type" in rawMessage &&
      (rawMessage.type === "chat-task-save" || rawMessage.type === "chat-task-load")) {
    const request = rawMessage as { requestId?: unknown; documentId?: unknown };
    const requestId = typeof request.requestId === "string" && request.requestId.length <= 100
      ? request.requestId : "";
    const documentId = typeof request.documentId === "string" && request.documentId.length <= 300
      ? request.documentId : "";
    const postResult = (result: Extract<PluginToUIMessage, { type: "chat-task-result" }>, taskId?: string) => {
      try {
        send(result, taskId);
        traceCheckpoint("controller", "ack_posted", requestId, {
          success: result.success, code: result.errorCode, ...result.revision,
        });
      } catch {
        traceCheckpoint("controller", "ack_post_failed", requestId);
      }
    };
    const rejectCheckpoint = (errorCode: string, error: string) => postResult({
      type: "chat-task-result", requestId, documentId, success: false,
      errorCategory: "checkpoint_storage", errorCode, error,
    });
    if (!checkpointRuntimeCompatible) {
      rejectCheckpoint("checkpoint_build_mismatch", "The UI and Figma plugin builds have not completed a compatible checkpoint handshake. Reload the development plugin and reopen it.");
      return;
    }
    const wire = rawMessage.type === "chat-task-load" ? "load" : "taskJson" in rawMessage ? "json" : "object";
    traceCheckpoint("controller", "received", requestId, { operation: rawMessage.type, wire, buildId: FW7_BUILD_ID });
    try {
      const checkpoint = decodeChatTaskStorageMessage(rawMessage);
      if (!checkpoint.success) {
        traceCheckpoint("controller", "rejected", requestId, {
          operation: rawMessage.type, wire, buildId: FW7_BUILD_ID,
          code: checkpoint.code, phase: checkpoint.phase, bytes: checkpoint.bytes, issues: checkpoint.issues,
        });
        rejectCheckpoint(checkpoint.code, checkpoint.code === "checkpoint_size_limit"
          ? "Task checkpoint exceeds its 512 KiB safety budget. Existing canvas changes are retained."
          : checkpoint.code === "checkpoint_revision_mismatch"
            ? "The checkpoint changed during transport. The last saved checkpoint was retained."
            : `Figma rejected the ${rawMessage.type} during ${checkpoint.phase} validation. The last saved checkpoint was retained. Reference ${checkpointHash(requestId)}.${checkpoint.issues ? ` Checks: ${checkpoint.issues}.` : ""}`.slice(0, 500));
        return;
      }
      const taskId = checkpoint.data.type === "chat-task-save" ? checkpoint.data.task?.id : undefined;
      if (taskId)
        traceCheckpoint("controller", "validated", requestId, { taskHash: checkpointHash(taskId), wire });
      fw7Telemetry.record({ runId: taskId ?? checkpoint.data.requestId, ...(taskId ? { taskId } : {}), requestIdHash: fw7CorrelationHash(checkpoint.data.requestId), boundary: "ui-plugin", kind: "bridge_request_received", stage: "checkpoint", operation: checkpoint.data.type, result: "received", counter: "pluginRequestsReceived" });
      postResult(await handleChatTaskStorage(figma, checkpoint.data, { prevalidated: true }), taskId);
    } catch {
      rejectCheckpoint("checkpoint_controller_failed", "Figma could not process the checkpoint request.");
    }
    return;
  }
  const message = UIToPluginSchema.safeParse(rawMessage);
  if (!message.success) {
    send({
      type: "protocol-error",
      ...(toolRequestId(rawMessage) ? { requestId: toolRequestId(rawMessage) } : {}),
      message: "The plugin received an invalid request. Reload the plugin and try again.",
    });
    return;
  }
  // Handshake handling above replies before schema-based operation dispatch.
  if (message.data.type === "plugin-runtime-handshake") return;
  if (["design-program-render", "task-native-inspect", "task-native-visual-capture", "task-native-visual-repair"].includes(message.data.type)) {
    const request = message.data as UIToPluginMessage & { requestId?: string; taskId?: string };
    const runId = request.taskId ?? request.requestId ?? "plugin-unscoped";
    fw7Telemetry.record({ runId, ...(request.taskId ? { taskId: request.taskId } : {}), requestIdHash: fw7CorrelationHash(request.requestId), boundary: "ui-plugin", kind: "bridge_request_received", stage: "native", operation: message.data.type, result: "received", counter: "pluginRequestsReceived" });
  }
  if (message.data.type === "design-context-read") {
    const result = await designContext.read(message.data);
    if (FW2_ENABLED) console.info("[FAD_DESIGN_CONTEXT] " + JSON.stringify(result.success ? {
      scope: result.snapshot.scope, coverage: result.snapshot.coverage, digest: result.snapshot.digest,
      nodes: result.snapshot.nodes.length, resources: result.snapshot.resources.length, reasons: result.snapshot.reasons,
    } : { code: result.code }));
    send(result);
    return;
  }
  if (message.data.type === "design-context-cancel") {
    designContext.cancel(message.data);
    return;
  }
  if (message.data.type === "chat-task-load" || message.data.type === "chat-task-save") {
    send(await handleChatTaskStorage(figma, message.data));
    return;
  }
  if (message.data.type === "brand-kit-storage") {
    send(await handleBrandKitStorage(figma.clientStorage, message.data));
    return;
  }
  if (message.data.type === "design-skills-storage") {
    send(await handleDesignSkillStorage(figma.clientStorage, message.data));
    return;
  }
  if (
    message.data.type === "chat-history-load" ||
    message.data.type === "chat-history-upsert" ||
    message.data.type === "chat-history-delete" ||
    message.data.type === "chat-history-delete-all"
  ) {
    send(await handleChatHistoryStorage(figma, message.data));
    return;
  }
  if (message.data.type === "design-program-render") {
    const request = message.data;
    const page = figma.currentPage;
    const pageId = page.id;
    const receiptKey = `fad.program-root.v1:${request.taskId}:${request.program.screens[0]?.id}`;
    const assertCurrentScope = () => {
      if (figma.currentPage.id !== pageId || activeDocumentId() !== request.documentId)
        throw new Error("stale_document_scope");
    };
    try {
      assertCurrentScope();
      const referencedAssets = new Set<string>();
      const collectAssets = (node: typeof request.program.screens[number]["root"]) => {
        if (node.type === "image" && node.asset.source === "user-approved-brand-kit" && node.asset.assetRef)
          referencedAssets.add(node.asset.assetRef);
        if (node.type === "container") node.children.forEach(collectAssets);
      };
      request.program.screens.forEach(({ root }) => collectAssets(root));
      const assets = await resolvePinnedBrandVisualAssets(figma.clientStorage, request.brandKit, [...referencedAssets]);
      const grant = FW2_ENABLED && request.contextTicket
        ? designContext.reuse(request.contextTicket, request.taskId, request.documentId) : undefined;
      const result = await renderDesignProgramLocal(figma, request.program, {
        taskId: request.taskId,
        documentId: request.documentId,
        pageId,
        executor: figmaToolExecutor,
        assets,
        contextReuse: grant ? () => prepareContextReuse(figma, grant.snapshot, grant.current) : undefined,
        assertCurrentScope,
        requestId: request.requestId,
        expectedRootNodeId: request.expectedRootNodeId,
        rootReceipt: {
          read: () => page.getPluginData(receiptKey),
          write: (nodeId) => page.setPluginData(receiptKey, nodeId),
        },
        lookupNode: (nodeId) => figma.getNodeByIdAsync(nodeId),
      });
      if (!result.success) {
        send({
          type: "design-program-render-result",
          requestId: request.requestId,
          taskId: request.taskId,
          success: false,
          errorCode: result.code,
          ...(result.nativeRootNodeId ? { nativeRootNodeId: result.nativeRootNodeId } : {}),
          findings: result.findings.slice(0, 20),
        });
        return;
      }
      const root = result.roots.find(({ screenId }) => screenId === request.program.screens[0]?.id);
      if (!root) throw new Error("rendered_root_missing");
      send({
        type: "design-program-render-result",
        requestId: request.requestId,
        taskId: request.taskId,
        success: true,
        screenId: root.screenId,
        nativeRootNodeId: root.nodeId,
        rootRef: root.ref,
        nativeBatchId: result.batchId,
        adoptionOperationIds: result.operationIds,
        programFingerprint: result.fingerprint,
        nativeNodeCount: result.registeredRefs,
        ...(FW5_VISUAL_QA_ENABLED ? { visualCaptureEligible: root.freshlyCreated === true } : {}),
        geometryVersion: result.geometryVersion,
        geometryRepairs: result.geometryRepairs,
        geometryDurationMs: result.timingsMs.geometry,
        ...((result.fontFallback || result.contextFindings?.length) ? { findings: [
          ...(result.fontFallback ? [{ code: "native_font_fallback", path: "typography", message: "A requested font could not be used for this text. Figma loaded a fallback font.", severity: "warning" as const }] : []),
          ...(result.contextFindings ?? []),
        ] } : {}),
      });
    } catch (error) {
      const staleScope = error instanceof Error && error.message === "stale_document_scope";
      const assetFailure = error instanceof PinnedBrandAssetResolutionError;
      const failureCode = staleScope ? "stale_document_scope" : assetFailure ? "pinned_brand_asset_unavailable" : "native_render_error";
      const failureMessage = staleScope
        ? "The active Figma document or page changed; no screen was adopted."
        : assetFailure
          ? error.code === "asset_outside_pinned_revision"
            ? "The composition references an asset outside this task's pinned Brand Kit revision; no screen was adopted."
            : error.code === "asset_missing_or_changed"
              ? "A pinned Brand Kit asset is missing or changed. Restore the pinned asset or remove its reference, then resume; no screen was adopted."
              : error.code === "asset_bundle_too_large"
                ? "The referenced pinned assets exceed the local renderer's safe bundle limit. Use fewer or smaller assets, then resume; no screen was adopted."
                : "A pinned Brand Kit asset failed local format or provenance validation; no screen was adopted."
          : "The local native renderer could not confirm this screen.";
      send({
        type: "design-program-render-result",
        requestId: request.requestId,
        taskId: request.taskId,
        success: false,
        errorCode: failureCode,
        findings: [{
          code: failureCode,
          path: "renderer",
          message: failureMessage,
          severity: "error",
        }],
      });
    }
    return;
  }
  if (
    message.data.type === "tool-execute" ||
    message.data.type === "tool-cancel" ||
    message.data.type === "tool-pause" ||
    message.data.type === "tool-delete-consent" ||
    message.data.type === "task-native-inspect" ||
    message.data.type === "task-native-focus" ||
    message.data.type === "task-native-visual-capture" ||
    message.data.type === "task-native-visual-capture-cancel" ||
    message.data.type === "task-native-visual-repair" ||
    message.data.type === "task-native-visual-repair-cancel"
  ) {
    void figmaToolExecutor(message.data).catch((error: unknown) => {
      if (message.data.type === "tool-execute" || message.data.type === "tool-delete-consent")
        reportToolExecutorFailure(message.data, error);
    });
    return;
  }
  if (
    message.data.type === "generation-context" ||
    message.data.type === "generation-remember" ||
    message.data.type === "generation-render" ||
    message.data.type === "generation-verify" ||
    message.data.type === "generation-select" ||
    message.data.type === "generation-prepare" ||
    message.data.type === "generation-apply-section"
  ) {
    send(await generationController(message.data));
    return;
  }

  if (message.data.type === "load-companion-restore-ticket") {
    try {
      const saved: unknown = await figma.clientStorage.getAsync(COMPANION_RESTORE_TICKET_KEY);
      const ticket =
        typeof saved === "string" &&
        saved.length <= 12_000 &&
        /^FADP1T:[A-Za-z0-9+/]+=*$/u.test(saved)
          ? saved
          : null;
      send({ type: "companion-restore-ticket", ticket, storageAvailable: true });
    } catch {
      send({ type: "companion-restore-ticket", ticket: null, storageAvailable: false });
    }
    return;
  }

  if (message.data.type === "save-companion-restore-ticket") {
    let success = true;
    try {
      if (message.data.ticket === null) {
        await figma.clientStorage.deleteAsync(COMPANION_RESTORE_TICKET_KEY);
      } else if (/^FADP1T:[A-Za-z0-9+/]+=*$/u.test(message.data.ticket)) {
        await figma.clientStorage.setAsync(COMPANION_RESTORE_TICKET_KEY, message.data.ticket);
      } else {
        success = false;
      }
    } catch {
      success = false;
    }
    send({
      type: "companion-restore-ticket-saved",
      requestId: message.data.requestId,
      success,
    });
    return;
  }

  if (
    message.data.type === "load-model-preference" ||
    message.data.type === "save-model-preference"
  ) {
    send(await handleModelPreferenceStorage(figma.clientStorage, message.data));
    return;
  }

  if (
    message.data.type === "load-design-engine-preference" ||
    message.data.type === "save-design-engine-preference"
  ) {
    send(await handleDesignEnginePreferenceStorage(figma.clientStorage, message.data));
    return;
  }

  if (message.data.type === "validate") {
    if (isMultiScreenInput(message.data.json)) {
      const multiResult = parseMultiScreenText(message.data.json);
      const fontWarningsForInput = multiResult.success
        ? await fontWarnings(multiResult.data)
        : undefined;
      send(
        multiResult.success
          ? {
              type: "validation-result",
              requestId: message.data.requestId,
              success: true,
              multiScreen: {
                totalScreens: multiResult.data.screens.length,
                nodeCount: multiResult.nodeCount,
                screens: multiResult.data.screens.map((screen) => ({
                  id: screen.id,
                  name: screen.name,
                  group: screen.group,
                  devicePreset: screen.devicePreset,
                  width: screen.width,
                  height: screen.height,
                })),
              },
              fontWarnings: fontWarningsForInput,
            }
          : {
              type: "validation-result",
              requestId: message.data.requestId,
              success: false,
              errors: multiResult.errors,
            },
      );
      return;
    }
    const result = parseDesignText(message.data.json);
    const fontWarningsForInput = result.success ? await fontWarnings(result.data) : undefined;
    send(
      result.success
        ? {
            type: "validation-result",
            requestId: message.data.requestId,
            success: true,
            counts: countDesignNodes(result.data),
            fontWarnings: fontWarningsForInput,
          }
        : {
            type: "validation-result",
            requestId: message.data.requestId,
            success: false,
            errors: result.errors,
          },
    );
    return;
  }

  if (message.data.type === "generate-multi-screen") {
    const requestId = message.data.requestId;
    const multiResult = parseMultiScreenText(message.data.json);
    if (!multiResult.success) {
      send({
        type: "render-error",
        requestId,
        message: "The multi-screen JSON needs corrections before generation.",
        errors: multiResult.errors,
      });
      return;
    }
    try {
      const result = await renderMultiScreenDesign(figma, multiResult.data, {
        gap: message.data.gap,
        maxRowWidth: message.data.maxRowWidth,
        onProgress: (progress) => send({ type: "multi-screen-progress", requestId, ...progress }),
      });
      send({ type: "multi-screen-result", requestId, ...result });
    } catch (error) {
      send({
        type: "render-error",
        requestId,
        message:
          error instanceof Error ? error.message : "An unexpected Figma error occurred. Try again.",
      });
    }
    return;
  }

  const parsed = parseDesignText(message.data.json);
  if (!parsed.success) {
    send({
      type: "render-error",
      requestId: message.data.requestId,
      message: "The design JSON needs corrections before it can be rendered.",
      errors: parsed.errors,
    });
    return;
  }

  if (message.data.type === "generate" && parsed.data.designSystem) {
    send({
      type: "render-error",
      requestId: message.data.requestId,
      message:
        "This JSON contains a design system. Use the explicit Create / Update Design System action.",
    });
    return;
  }
  if (message.data.type === "apply-design-system" && !parsed.data.designSystem) {
    send({
      type: "render-error",
      requestId: message.data.requestId,
      message: "No designSystem section was found in this JSON.",
    });
    return;
  }

  try {
    const result = await renderDesign(
      figma,
      parsed.data,
      message.data.type === "apply-design-system" ? { updateOwned: message.data.updateOwned } : {},
    );
    send({
      type: "render-result",
      requestId: message.data.requestId,
      success: true,
      frameName: result.frameName,
      counts: result.counts,
      warnings: result.warnings,
      fontSelections: result.fontSelections,
      designSystem: result.designSystem,
    });
  } catch (error) {
    send({
      type: "render-error",
      requestId: message.data.requestId,
      message:
        error instanceof Error ? error.message : "An unexpected Figma error occurred. Try again.",
    });
  }
};
