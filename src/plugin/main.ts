import { countDesignNodes, parseDesignText } from "../shared/schema";
import { isMultiScreenInput, parseMultiScreenText } from "../shared/multi-screen-schema";
import {
  ChatTaskStorageMessageSchema,
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
import { CHAT_TASK_MAX_BYTES } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import { traceCheckpoint } from "../shared/chat-checkpoint-wire";
import { handleChatHistoryStorage } from "./chat-history-storage";
import { handleModelPreferenceStorage } from "./model-preference-storage";
import { handleDesignEnginePreferenceStorage } from "./design-engine-preference-storage";
import { handleBrandKitStorage, PinnedBrandAssetResolutionError, resolvePinnedBrandVisualAssets } from "./brand-kit-storage";
import { handleDesignSkillStorage } from "./design-skill-storage";

figma.showUI(__html__, { width: 440, height: 720, themeColors: true });
const COMPANION_RESTORE_TICKET_KEY = "companion-restore-ticket-v1";

function send(message: PluginToUIMessage): void {
  figma.ui.postMessage(message);
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
      (rawMessage.type === "chat-task-save" || rawMessage.type === "chat-task-load")) {
    const request = rawMessage as { requestId?: unknown; documentId?: unknown; task?: unknown };
    const requestId = typeof request.requestId === "string" && request.requestId.length <= 100
      ? request.requestId : "";
    const documentId = typeof request.documentId === "string" && request.documentId.length <= 300
      ? request.documentId : "";
    const postResult = (result: Extract<PluginToUIMessage, { type: "chat-task-result" }>) => {
      try {
        send(result);
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
    traceCheckpoint("controller", "received", requestId, { operation: rawMessage.type });
    try {
      const raw = rawMessage.type === "chat-task-save" ? JSON.stringify(request.task) : undefined;
      if (raw !== undefined && utf8Bytes(raw) > CHAT_TASK_MAX_BYTES) {
        rejectCheckpoint("checkpoint_size_limit", "Task checkpoint exceeds its 512 KiB safety budget. Existing canvas changes are retained.");
        return;
      }
      const checkpoint = ChatTaskStorageMessageSchema.safeParse(rawMessage);
      if (!checkpoint.success) {
        rejectCheckpoint("checkpoint_protocol_error", "Figma received an invalid checkpoint message. Reload the development plugin before retrying.");
        return;
      }
      postResult(await handleChatTaskStorage(figma, checkpoint.data, { prevalidated: true }));
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
    message.data.type === "chat-history-delete"
  ) {
    send(await handleChatHistoryStorage(figma, message.data));
    return;
  }
  if (message.data.type === "design-program-render") {
    const request = message.data;
    const page = figma.currentPage;
    const pageId = page.id;
    const receiptKey = `fad.program-root.v1:${request.taskId}:${request.program.screens[0]?.id}`;
    const activeDocumentId = () => {
      const localId = figma.root.getPluginData("fad.document-id");
      const fileId = figma.fileKey ?? localId;
      return fileId ? `${fileId}-${figma.currentPage.id.replaceAll(":", "_")}` : undefined;
    };
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
      const result = await renderDesignProgramLocal(figma, request.program, {
        taskId: request.taskId,
        documentId: request.documentId,
        pageId,
        executor: figmaToolExecutor,
        assets,
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
        geometryVersion: result.geometryVersion,
        geometryRepairs: result.geometryRepairs,
        geometryDurationMs: result.timingsMs.geometry,
        ...(result.fontFallback ? { findings: [{ code: "native_font_fallback", path: "typography", message: "A requested font could not be used for this text. Figma loaded a fallback font.", severity: "warning" as const }] } : {}),
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
    message.data.type === "task-native-focus"
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
