import { countDesignNodes, parseDesignText } from "../shared/schema";
import { isMultiScreenInput, parseMultiScreenText } from "../shared/multi-screen-schema";
import {
  UIToPluginSchema,
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";
import type { DesignSpec } from "../shared/schema";
import type { MultiScreenSpec } from "../shared/multi-screen-schema";
import { renderDesign, renderMultiScreenDesign } from "./renderer";
import { collectFontRequirements, unavailableFontWarnings } from "./font-preflight";
import { createGenerationController } from "./generation-controller";
import { createFigmaToolExecutor } from "./figma-tool-executor";
import { handleChatTaskStorage } from "./chat-task-storage";

figma.showUI(__html__, { width: 440, height: 720, themeColors: true });
const COMPANION_RESTORE_TICKET_KEY = "companion-restore-ticket-v1";

function send(message: PluginToUIMessage): void {
  figma.ui.postMessage(message);
}

function toolRequestId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as Record<string, unknown>;
  const value = message.type === "tool-delete-consent" ? message.requestId : message.batchId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value) ? value : undefined;
}

function reportToolExecutorFailure(
  message: Extract<UIToPluginMessage, { type: "tool-execute" | "tool-delete-consent" }>,
  error: unknown,
): void {
  const details = (
    error instanceof Error ? error.message : "The plugin executor failed unexpectedly."
  ).slice(0, 400);
  if (message.type === "tool-delete-consent") {
    send({
      type: "tool-delete-consent-result",
      protocolVersion: 1,
      requestId: message.requestId,
      success: false,
      message: details.slice(0, 300),
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
    partialOperationIds: [],
    results: [
      {
        operationId: message.operations[0]!.operationId,
        success: false,
        replayed: false,
        error: details,
      },
    ],
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
  if (
    message.data.type === "tool-execute" ||
    message.data.type === "tool-cancel" ||
    message.data.type === "tool-delete-consent"
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
