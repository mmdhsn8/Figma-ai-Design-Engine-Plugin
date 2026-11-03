import { DESIGN_SCHEMA_VERSION } from "../shared/schema";
import { parseMultiScreenText, type MultiScreenSpec } from "../shared/multi-screen-schema";
import {
  DESIGN_GENERATION_COLOR_TOKENS,
  validateGeneratedDesignResponse,
  type DesignPlan,
  type GeneratedDesignNode,
} from "../shared/design-generation";

export type PreparedGeneratedDesign = {
  json: string;
  batch: MultiScreenSpec;
  nodeCount: number;
};

export type PreparedDesignResult =
  { success: true; data: PreparedGeneratedDesign } | { success: false; errors: string[] };

export function prepareGeneratedDesign(raw: string, plan: DesignPlan): PreparedDesignResult {
  const parsed = validateGeneratedDesignResponse(raw, plan);
  if (!parsed.success) return parsed;

  const { design } = parsed.data;
  const screensById = new Map(design.screens.map((screen) => [screen.id, screen]));
  const batch: MultiScreenSpec = {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    id: "ai-generated-design",
    name: design.projectName,
    designSystem: {
      id: "ai-generated-design-system",
      namespace: "ai-generated",
      name: design.projectName,
      version: "1.0.0",
      typography: {},
      borders: {},
      colors: {
        [DESIGN_GENERATION_COLOR_TOKENS.brand]: design.palette.brand,
        [DESIGN_GENERATION_COLOR_TOKENS.accent]: design.palette.accent,
        [DESIGN_GENERATION_COLOR_TOKENS.page]: design.palette.page,
        [DESIGN_GENERATION_COLOR_TOKENS.surface]: design.palette.surface,
        [DESIGN_GENERATION_COLOR_TOKENS.text]: design.palette.text,
        [DESIGN_GENERATION_COLOR_TOKENS.muted]: design.palette.muted,
        [DESIGN_GENERATION_COLOR_TOKENS.border]: design.palette.border,
      },
    },
    screens: plan.screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      order: screen.order,
      devicePreset: screen.devicePreset,
      width: screen.width,
      height: screen.height,
      background: { token: DESIGN_GENERATION_COLOR_TOKENS.page },
      layout: {
        mode: "vertical",
        gap: screen.devicePreset === "mobile" ? 16 : 24,
        padding:
          screen.devicePreset === "mobile"
            ? { top: 20, right: 20, bottom: 20, left: 20 }
            : { top: 32, right: 32, bottom: 32, left: 32 },
        counterAxisAlign: "stretch",
      },
      children: (screensById.get(screen.id)?.children ?? []).map((node) =>
        mapNode(node, plan.direction),
      ),
    })),
  };
  const json = JSON.stringify(batch, null, 2);
  if (json.length > 1_000_000) {
    return {
      success: false,
      errors: ["The prepared JSON exceeds the existing 1 MB editor limit."],
    };
  }
  const validated = parseMultiScreenText(json);
  if (!validated.success) return { success: false, errors: validated.errors.slice(0, 12) };
  return {
    success: true,
    data: { json, batch: validated.data, nodeCount: validated.nodeCount },
  };
}

function mapNode(
  node: GeneratedDesignNode,
  direction: DesignPlan["direction"],
): MultiScreenSpec["screens"][number]["children"][number] {
  const token =
    node.palette === "none" ? undefined : { token: DESIGN_GENERATION_COLOR_TOKENS[node.palette] };
  const visual =
    node.elevation === "soft"
      ? {
          effects: [
            {
              type: "drop-shadow" as const,
              color: "#0F172A",
              opacity: 0.1,
              offsetX: 0,
              offsetY: 4,
              radius: 12,
              spread: 0,
            },
          ],
        }
      : undefined;
  if (node.type === "text") {
    return {
      type: "text",
      name: node.name,
      text: node.text ?? "",
      fontSize: node.fontSize,
      fontStyle: node.fontStyle,
      color: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.text },
      textAlign:
        node.textAlign === "center"
          ? "center"
          : node.textAlign === "left" || node.textAlign === "right"
            ? node.textAlign
            : direction === "rtl"
              ? "right"
              : "left",
      width: node.width,
      sizing: { width: "fill", height: "hug" },
      textAutoResize: "height",
      qualityRole: node.qualityRole,
      ...(visual ? { visual } : {}),
    };
  }
  if (node.type === "frame") {
    return {
      type: "frame",
      name: node.name,
      width: node.width,
      height: node.height,
      children: node.children.map((child) => mapNode(child, direction)),
      ...(token ? { background: token } : {}),
      ...(node.children.length
        ? {
            layout: {
              mode: node.layout as "vertical" | "horizontal",
              gap: node.gap,
              padding: {
                top: node.padding,
                right: node.padding,
                bottom: node.padding,
                left: node.padding,
              },
              counterAxisAlign: "stretch" as const,
            },
          }
        : {}),
      ...(node.cornerRadius ? { cornerRadius: node.cornerRadius } : {}),
      qualityRole: node.qualityRole,
      ...(visual ? { visual } : {}),
    };
  }
  return {
    type: node.type,
    name: node.name,
    width: node.width,
    height: node.height,
    fill: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.surface },
    ...(node.cornerRadius ? { cornerRadius: node.cornerRadius } : {}),
    qualityRole: node.qualityRole,
    ...(visual ? { visual } : {}),
  };
}
