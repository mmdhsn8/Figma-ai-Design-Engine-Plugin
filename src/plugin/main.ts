import { countDesignNodes, parseDesignText } from "../shared/schema";
import { UIToPluginSchema, type PluginToUIMessage } from "../shared/messages";
import { renderDesign } from "./renderer";

figma.showUI(__html__, { width: 440, height: 720, themeColors: true });

function send(message: PluginToUIMessage): void {
  figma.ui.postMessage(message);
}

figma.ui.onmessage = async (rawMessage: unknown) => {
  const message = UIToPluginSchema.safeParse(rawMessage);
  if (!message.success) {
    send({
      type: "protocol-error",
      message: "The plugin received an invalid request. Reload the plugin and try again.",
    });
    return;
  }

  if (message.data.type === "validate") {
    const result = parseDesignText(message.data.json);
    send(
      result.success
        ? {
            type: "validation-result",
            requestId: message.data.requestId,
            success: true,
            counts: countDesignNodes(result.data),
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

  try {
    const result = await renderDesign(figma, parsed.data);
    send({
      type: "render-result",
      requestId: message.data.requestId,
      success: true,
      frameName: result.frameName,
      counts: result.counts,
      warnings: result.warnings,
      fontSelections: result.fontSelections,
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
