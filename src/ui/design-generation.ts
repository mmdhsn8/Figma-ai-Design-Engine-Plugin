import { DESIGN_SCHEMA_VERSION } from "../shared/schema";
import { parseMultiScreenText, type MultiScreenSpec } from "../shared/multi-screen-schema";
import {
  DESIGN_GENERATION_COLOR_TOKENS,
  normalizeGeneratedDesignResponse,
  type GeneratedDesign,
  type DesignPlan,
  type GeneratedDesignNode,
} from "../shared/design-generation";
import { designIconPath, createVisualDesignSpec, type VisualDesignSpec } from "../shared/visual-design-spec";
import { inferPatternsForScreen } from "../shared/design-patterns";

export type PreparedGeneratedDesign = {
  json: string;
  batch: MultiScreenSpec;
  nodeCount: number;
  visualSpecs: VisualDesignSpec[];
};

export type PreparedDesignResult =
  { success: true; data: PreparedGeneratedDesign } | { success: false; errors: string[] };

export function pendingGenerationScreens(
  plan: DesignPlan,
  completedScreens: readonly GeneratedDesign["screens"][number][],
): DesignPlan["screens"] {
  const completedIds = new Set(completedScreens.map(({ id }) => id));
  return plan.screens.filter(({ id }) => !completedIds.has(id));
}

export function retainGeneratedScreen(
  completedScreens: GeneratedDesign["screens"],
  screen: GeneratedDesign["screens"][number],
): GeneratedDesign["screens"] {
  return completedScreens.some(({ id }) => id === screen.id)
    ? completedScreens
    : [...completedScreens, screen];
}

export function prepareGeneratedDesign(
  raw: string,
  plan: DesignPlan,
  options: { scope?: "screen" | "section"; sectionId?: "identity" | "primary" | "supporting" } = {},
): PreparedDesignResult {
  const parsed = normalizeGeneratedDesignResponse(raw, plan);
  if (!parsed.success) return parsed;

  const { design } = parsed.data;
  const screensById = new Map(design.screens.map((screen) => [screen.id, screen]));
  const visualSpecs: VisualDesignSpec[] = [];
  for (const screen of plan.screens) {
    const source = screensById.get(screen.id);
    if (!source) return { success: false, errors: [`Missing generated screen “${screen.id}”.`] };
    if (options.scope === "section" && options.sectionId)
      for (const node of source.children) node.sectionId ??= options.sectionId;
    const requestedPatterns = inferPatternsForScreen(
      plan.request.prompt,
      plan.domain,
      screen.familyName,
      plan.request.screenCount * (plan.request.target === "both" ? 2 : 1),
      plan.fidelity === "high_fidelity",
    ).filter((pattern) => {
      if (options.scope !== "section") return true;
      if (options.sectionId === "identity") return ["app-bar", "navigation", "search"].includes(pattern);
      if (options.sectionId === "primary") return !["app-bar", "navigation", "footer"].includes(pattern);
      if (options.sectionId === "supporting") return ["footer", "empty-state", "loading-state", "error-state"].includes(pattern);
      return false;
    });
    const visualSpec = createVisualDesignSpec({
      brief: plan.brief,
      screen,
      projectScreenCount: plan.request.screenCount * (plan.request.target === "both" ? 2 : 1),
      requiredPatterns: requestedPatterns,
      requireHighFidelityStructure: options.scope !== "section",
      palette: design.palette,
      children: source.children,
    });
    if (!visualSpec.success)
      return { success: false, errors: visualSpec.errors.map((error) => `${screen.id}: ${error}`) };
    visualSpecs.push(visualSpec.data);
  }
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
      children: (screensById.get(screen.id)?.children ?? []).map((node, index) =>
        mapNode(
          node,
          plan.direction,
          "vertical",
          plan.language,
          `${screen.id}.${node.sectionId ?? options.sectionId ?? "main"}.n${index}`,
        ),
      ),
    })),
  };
  const json = JSON.stringify(batch, null, 2);
  const validated = parseMultiScreenText(json);
  if (!validated.success) return { success: false, errors: validated.errors.slice(0, 12) };
  return {
    success: true,
    data: { json, batch: validated.data, nodeCount: validated.nodeCount, visualSpecs },
  };
}

function mapNode(
  node: GeneratedDesignNode,
  direction: DesignPlan["direction"],
  parentLayout: "vertical" | "horizontal",
  language: DesignPlan["language"],
  logicalRef: string,
): MultiScreenSpec["screens"][number]["children"][number] {
  const token =
    node.palette === "none" ? undefined : { token: DESIGN_GENERATION_COLOR_TOKENS[node.palette] };
  const interactive = node.qualityRole === "button" || node.qualityRole === "input";
  const touchSizing = interactive
    ? {
        sizing: {
          width: parentLayout === "vertical" ? ("fill" as const) : ("fixed" as const),
          height: parentLayout === "horizontal" ? ("fill" as const) : ("fixed" as const),
        },
      }
    : {};
  const visual =
    node.elevation === "soft" || node.opacity !== undefined
      ? {
          ...(node.opacity !== undefined ? { opacity: node.opacity } : {}),
          ...(node.elevation === "soft"
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
            : {}),
        }
      : undefined;
  if (node.type === "text") {
    if (interactive) {
      return {
        type: "frame",
        name: node.name,
        width: node.width,
        height: node.height,
        ...touchSizing,
        qualityRole: node.qualityRole,
        logicalRef,
        ...(node.pattern ? { pattern: node.pattern } : {}),
        layout: {
          mode: "vertical",
          gap: 0,
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          counterAxisAlign: "stretch",
        },
        children: [
          mapNode(
            { ...node, qualityRole: "body", name: `${node.name} label` },
            direction,
            "vertical",
            language,
            `${logicalRef}.label`,
          ),
        ],
      };
    }
    return {
      type: "text",
      name: node.name,
      text: node.text ?? "",
      fontSize: node.fontSize,
      fontStyle: node.fontStyle,
      ...(node.fontFamily ? { fontFamily: node.fontFamily } : {}),
      ...(node.lineHeight ? { lineHeight: node.lineHeight } : {}),
      ...(node.letterSpacing !== undefined ? { letterSpacing: node.letterSpacing } : {}),
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
      logicalRef,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      ...(visual ? { visual } : {}),
    };
  }
  if (node.type === "frame") {
    return {
      type: "frame",
      name: node.name,
      width: node.width,
      height: node.height,
      children: node.children.map((child, index) =>
        mapNode(
          child,
          direction,
          node.layout === "horizontal" ? "horizontal" : "vertical",
          language,
          `${logicalRef}.n${index}`,
        ),
      ),
      ...touchSizing,
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
      logicalRef,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      ...(visual ? { visual } : {}),
      ...(node.strokePalette
        ? { stroke: { color: { token: DESIGN_GENERATION_COLOR_TOKENS[node.strokePalette] }, width: 1 } }
        : {}),
    };
  }
  if (node.type === "icon") {
    const pathData = node.iconName ? designIconPath(node.iconName) : undefined;
    if (!pathData) throw new Error(`Icon “${node.iconName ?? "unknown"}” is not in the bundled allowlist.`);
    return {
      type: "vector",
      name: node.name,
      width: node.width,
      height: node.height,
      pathData,
      fill: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.brand },
      qualityRole: node.qualityRole,
      logicalRef,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      ...(visual ? { visual } : {}),
    };
  }
  if (node.type === "image") {
    const disclosure = language === "fa" ? "جایگاه تصویر · عکس واقعی نیست" : "Image placeholder · not a real photo";
    return {
      type: "frame",
      name: node.name,
      width: node.width,
      height: node.height,
      background: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.surface },
      layout: {
        mode: "vertical",
        gap: 8,
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
        counterAxisAlign: "center",
      },
      children: [
        {
          type: "ellipse",
          name: "Editable illustration placeholder",
          width: Math.min(36, Math.max(20, node.width - 16)),
          height: Math.min(36, Math.max(20, node.width - 16)),
          fill: { token: DESIGN_GENERATION_COLOR_TOKENS.accent },
          qualityRole: "decorative",
          logicalRef: `${logicalRef}.illustration`,
        },
        {
          type: "text",
          name: "Image placeholder disclosure",
          text: disclosure,
          fontSize: 10,
          color: { token: DESIGN_GENERATION_COLOR_TOKENS.muted },
          textAlign: "center",
          width: Math.max(1, node.width - 16),
          height: 14,
          sizing: { width: "fill", height: "fixed" },
          textAutoResize: "height",
          qualityRole: "body",
          logicalRef: `${logicalRef}.disclosure`,
        },
      ],
      ...(node.cornerRadius ? { cornerRadius: node.cornerRadius } : {}),
      qualityRole: "image",
      logicalRef,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      ...(visual ? { visual } : {}),
      ...(node.strokePalette
        ? { stroke: { color: { token: DESIGN_GENERATION_COLOR_TOKENS[node.strokePalette] }, width: 1 } }
        : {}),
    };
  }
  return {
    type: node.type,
    name: node.name,
    width: node.width,
    height: node.height,
    fill: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.surface },
    ...touchSizing,
    logicalRef,
    ...(node.pattern ? { pattern: node.pattern } : {}),
    ...(node.cornerRadius ? { cornerRadius: node.cornerRadius } : {}),
    qualityRole: node.qualityRole,
    ...(visual ? { visual } : {}),
    ...(node.strokePalette
      ? { stroke: { color: { token: DESIGN_GENERATION_COLOR_TOKENS[node.strokePalette] }, width: 1 } }
      : {}),
  };
}
