import { DESIGN_SCHEMA_VERSION } from "../shared/schema";
import { parseMultiScreenText, type MultiScreenSpec } from "../shared/multi-screen-schema";
import {
  DESIGN_GENERATION_COLOR_TOKENS,
  normalizeGeneratedDesignResponse,
  type GeneratedDesign,
  type DesignPlan,
  type GeneratedDesignNode,
} from "../shared/design-generation";
import {
  designIconPath,
  createVisualDesignSpec,
  type VisualDesignSpec,
} from "../shared/visual-design-spec";
import { inferPatternsForScreen } from "../shared/design-patterns";
import {
  resolveBrandKitTokens,
  resolveBrandTextAlignment,
  type BrandTypographyRole,
  type PinnedBrandKit,
  type BrandKitTokens,
} from "../shared/brand-kit";
import type { VisualAsset } from "../shared/visual-schema";

export type PreparedGeneratedDesign = {
  json: string;
  batch: MultiScreenSpec;
  nodeCount: number;
  visualSpecs: VisualDesignSpec[];
  brandConflicts: string[];
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
  options: {
    scope?: "screen" | "section";
    sectionId?: "identity" | "primary" | "supporting";
    assets?: VisualAsset[];
  } = {},
): PreparedDesignResult {
  const parsed = normalizeGeneratedDesignResponse(raw, plan);
  if (!parsed.success) return parsed;

  const design = structuredClone(parsed.data.design);
  const pinnedAssetIds = new Set(plan.brandKit?.assets.map(({ assetId }) => assetId) ?? []);
  const resolvedAssets = options.assets ?? [];
  if (resolvedAssets.some(({ id }) => !pinnedAssetIds.has(id)))
    return {
      success: false,
      errors: ["Generated design referenced an asset outside its pinned Brand Kit revision."],
    };
  if (plan.brandKit?.assets.some(({ assetId }) => !resolvedAssets.some(({ id }) => id === assetId)))
    return {
      success: false,
      errors: [
        "A pinned Brand Kit asset is missing; generation is blocked without substituting another asset.",
      ],
    };
  if (hasUnapprovedAssetReference(design.screens, pinnedAssetIds))
    return {
      success: false,
      errors: ["Generated design referenced an asset outside its pinned Brand Kit revision."],
    };
  const brandConflicts: string[] = [];
  if (plan.brandKit) {
    const resolved = resolvePalette(
      design.palette,
      plan.request.prompt,
      plan.brandKit,
      plan.request.theme,
    );
    design.palette = resolved.palette;
    brandConflicts.push(...resolved.conflicts);
  }
  const screensById = new Map(design.screens.map((screen) => [screen.id, screen]));
  const visualSpecs: VisualDesignSpec[] = [];
  for (const screen of plan.screens) {
    const source = screensById.get(screen.id);
    if (!source) return { success: false, errors: [`Missing generated screen “${screen.id}”.`] };
    if (options.scope === "section" && options.sectionId)
      for (const node of source.children) node.sectionId ??= options.sectionId;
    if (plan.brandKit) {
      const logoResult = applyPinnedBrandLogo(
        source.children,
        plan.brandKit,
        resolvedAssets,
        options,
      );
      if (!logoResult.success) return { success: false, errors: [logoResult.error] };
    }
    const requestedPatterns = inferPatternsForScreen(
      plan.request.prompt,
      plan.domain,
      screen.familyName,
      plan.request.screenCount * (plan.request.target === "both" ? 2 : 1),
      plan.fidelity === "high_fidelity",
    ).filter((pattern) => {
      if (options.scope !== "section") return true;
      if (options.sectionId === "identity")
        return ["app-bar", "navigation", "search"].includes(pattern);
      if (options.sectionId === "primary")
        return !["app-bar", "navigation", "footer"].includes(pattern);
      if (options.sectionId === "supporting")
        return ["footer", "empty-state", "loading-state", "error-state"].includes(pattern);
      return false;
    });
    const visualSpec = createVisualDesignSpec({
      brief: plan.brief,
      screen,
      projectScreenCount: plan.request.screenCount * (plan.request.target === "both" ? 2 : 1),
      requiredPatterns: requestedPatterns,
      designSkills: plan.designSkills,
      requireHighFidelityStructure: options.scope !== "section",
      palette: design.palette,
      ...(plan.brandKit
        ? {
            semanticTokens: resolveBrandKitTokens(
              plan.brandKit,
              plan.request.theme === "dark" ? "dark" : "light",
            ),
          }
        : {}),
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
          plan.request.prompt,
          `${screen.id}.${node.sectionId ?? options.sectionId ?? "main"}.n${index}`,
          plan.brandKit
            ? resolveBrandKitTokens(plan.brandKit, plan.request.theme === "dark" ? "dark" : "light")
            : undefined,
        ),
      ),
    })),
    ...(resolvedAssets.length ? { assets: resolvedAssets } : {}),
  };
  const json = JSON.stringify(batch, null, 2);
  const validated = parseMultiScreenText(json);
  if (!validated.success) return { success: false, errors: validated.errors.slice(0, 12) };
  return {
    success: true,
    data: {
      json,
      batch: validated.data,
      nodeCount: validated.nodeCount,
      visualSpecs,
      brandConflicts,
    },
  };
}

function hasUnapprovedAssetReference(
  screens: GeneratedDesign["screens"],
  approved: ReadonlySet<string>,
): boolean {
  const visit = (nodes: GeneratedDesignNode[]): boolean =>
    nodes.some(
      (node) => (node.assetId !== undefined && !approved.has(node.assetId)) || visit(node.children),
    );
  return screens.some(({ children }) => visit(children));
}

function explicitColor(
  prompt: string,
  role: "brand" | "accent" | "page" | "surface" | "text" | "muted" | "border",
): string | undefined {
  const expressions: Record<typeof role, RegExp> = {
    brand: /(?:primary|brand|رنگ\s*(?:اصلی|برند))[^\n#]{0,80}(#[0-9a-f]{6})/iu,
    accent: /(?:accent|تأکیدی|تاکیدی)[^\n#]{0,80}(#[0-9a-f]{6})/iu,
    page: /(?:background|page|پس[‌ ]?زمینه)[^\n#]{0,80}(#[0-9a-f]{6})/iu,
    surface: /(?:surface|سطح)[^\n#]{0,80}(#[0-9a-f]{6})/iu,
    text: /(?:text|متن)[^\n#]{0,80}(#[0-9a-f]{6})/iu,
    muted: /(?:muted|کم[‌ ]?رنگ)[^\n#]{0,80}(#[0-9a-f]{6})/iu,
    border: /(?:border|خط\s*دور)[^\n#]{0,80}(#[0-9a-f]{6})/iu,
  };
  return expressions[role].exec(prompt)?.[1]?.toUpperCase();
}

function resolvePalette(
  generated: GeneratedDesign["palette"],
  prompt: string,
  pinned: PinnedBrandKit,
  mode: "auto" | "light" | "dark",
): { palette: GeneratedDesign["palette"]; conflicts: string[] } {
  const tokens = resolveBrandKitTokens(pinned, mode === "dark" ? "dark" : "light").palette;
  const roles = {
    brand: { value: tokens.primary, taskRole: "brand" as const },
    accent: { value: tokens.accent, taskRole: "accent" as const },
    page: { value: tokens.background, taskRole: "page" as const },
    surface: { value: tokens.surface, taskRole: "surface" as const },
    text: { value: tokens.text, taskRole: "text" as const },
    muted: { value: tokens.mutedText, taskRole: "muted" as const },
    border: { value: tokens.border, taskRole: "border" as const },
  };
  const palette = { ...generated };
  const conflicts: string[] = [];
  for (const [role, choice] of Object.entries(roles) as Array<
    [keyof typeof roles, (typeof roles)[keyof typeof roles]]
  >) {
    const userValue = explicitColor(prompt, choice.taskRole);
    const resolved = userValue ?? choice.value;
    if (userValue && userValue !== choice.value)
      conflicts.push(
        `User-requested ${role} ${userValue} takes precedence over the pinned Brand Kit value ${choice.value}.`,
      );
    else if (generated[role] !== resolved)
      conflicts.push(
        `Model-proposed ${role} ${generated[role]} was resolved to pinned Brand Kit token ${resolved}.`,
      );
    palette[role] = resolved;
  }
  return { palette, conflicts };
}

function applyPinnedBrandLogo(
  children: GeneratedDesignNode[],
  pinned: PinnedBrandKit,
  assets: VisualAsset[],
  options: { scope?: "screen" | "section"; sectionId?: "identity" | "primary" | "supporting" },
): { success: true } | { success: false; error: string } {
  if (options.scope === "section" && options.sectionId !== "identity") return { success: true };
  const brandAsset = pinned.assets.find(({ variant }) => variant === "primary") ?? pinned.assets[0];
  if (!brandAsset) return { success: true };
  if (!assets.some(({ id }) => id === brandAsset.assetId))
    return {
      success: false,
      error: `Pinned logo “${brandAsset.name}” is unavailable; no substitute was applied.`,
    };
  const root = children.find(
    (node) => node.type === "frame" && (!node.sectionId || node.sectionId === "identity"),
  );
  if (!root || root.type !== "frame")
    return {
      success: false,
      error: "The identity section has no safe Auto Layout frame for the pinned logo.",
    };
  if (root.children.some((node) => node.assetId === brandAsset.assetId)) return { success: true };
  const scale = Math.min(48 / brandAsset.width, 48 / brandAsset.height, 1);
  root.children.unshift({
    type: "image",
    name: `Approved brand logo · ${pinned.name}`,
    text: null,
    palette: "none",
    width: Math.max(1, Math.round(brandAsset.width * scale)),
    height: Math.max(1, Math.round(brandAsset.height * scale)),
    fontSize: 12,
    fontStyle: "Regular",
    textAlign: "center",
    cornerRadius: 0,
    elevation: "none",
    layout: "none",
    gap: 0,
    padding: 0,
    qualityRole: "image",
    assetId: brandAsset.assetId,
    children: [],
    sectionId: "identity",
  });
  return { success: true };
}

export function applyPinnedBrandLogoToSection(
  design: GeneratedDesign,
  plan: DesignPlan,
  sectionId: "identity" | "primary" | "supporting",
  assets: VisualAsset[],
): GeneratedDesign {
  if (!plan.brandKit) return design;
  const screens = structuredClone(design.screens);
  for (const screen of screens) {
    const result = applyPinnedBrandLogo(screen.children, plan.brandKit, assets, {
      scope: "section",
      sectionId,
    });
    if (!result.success) throw new Error(result.error);
  }
  return { ...design, screens };
}

function mapNode(
  node: GeneratedDesignNode,
  direction: DesignPlan["direction"],
  parentLayout: "vertical" | "horizontal",
  language: DesignPlan["language"],
  prompt: string,
  logicalRef: string,
  brandTokens?: BrandKitTokens,
  forcedTypographyRole?: keyof BrandKitTokens["typography"],
): MultiScreenSpec["screens"][number]["children"][number] {
  const typographyRole =
    forcedTypographyRole ??
    (node.qualityRole === "heading"
      ? node.fontSize >= 30
        ? "heading1"
        : node.fontSize >= 22
          ? "heading2"
          : "heading3"
      : node.qualityRole === "button"
        ? "button"
        : node.qualityRole === "decorative"
          ? "caption"
          : "body");
  const typography = brandTokens?.typography[typographyRole];
  const roleRadius =
    node.qualityRole === "button"
      ? brandTokens?.components.buttonRadius
      : node.qualityRole === "input"
        ? brandTokens?.components.inputRadius
        : node.pattern === "product-card" || node.pattern === "stat-card"
          ? brandTokens?.components.cardRadius
          : undefined;
  const cornerRadius =
    roleRadius ??
    (node.cornerRadius && brandTokens
      ? nearestToken(node.cornerRadius, brandTokens.radii)
      : node.cornerRadius);
  const gap = brandTokens ? nearestToken(node.gap, brandTokens.spacing) : node.gap;
  const padding = brandTokens ? nearestToken(node.padding, brandTokens.spacing) : node.padding;
  const textAlignment = resolveBrandTextAlignment(
    brandTokens,
    typographyRole as BrandTypographyRole,
    prompt,
    node.textAlign ?? (direction === "rtl" ? "right" : "left"),
  );
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
                    color: brandTokens?.shadow.color ?? "#0F172A",
                    opacity: brandTokens?.shadow.opacity ?? 0.1,
                    offsetX: brandTokens?.shadow.offsetX ?? 0,
                    offsetY: brandTokens?.shadow.offsetY ?? 4,
                    radius: brandTokens?.shadow.radius ?? 12,
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
            prompt,
            `${logicalRef}.label`,
            brandTokens,
            "button",
          ),
        ],
      };
    }
    return {
      type: "text",
      name: node.name,
      text: node.text ?? "",
      fontSize: typography?.size ?? node.fontSize,
      fontStyle: typography?.style ?? node.fontStyle,
      ...(typography?.requestedFamily || node.fontFamily
        ? { fontFamily: typography?.requestedFamily ?? node.fontFamily }
        : {}),
      ...(typography
        ? { fontFallback: { family: typography.fallbackFamily, style: "Regular" } }
        : {}),
      ...((typography?.lineHeight ?? node.lineHeight)
        ? { lineHeight: typography?.lineHeight ?? node.lineHeight }
        : {}),
      ...(typography?.letterSpacing !== undefined || node.letterSpacing !== undefined
        ? { letterSpacing: typography?.letterSpacing ?? node.letterSpacing }
        : {}),
      color: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.text },
      textAlign: textAlignment,
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
          prompt,
          `${logicalRef}.n${index}`,
          brandTokens,
        ),
      ),
      ...touchSizing,
      ...(token ? { background: token } : {}),
      ...(node.children.length
        ? {
            layout: {
              mode: node.layout as "vertical" | "horizontal",
              gap,
              padding: {
                top: padding,
                right: padding,
                bottom: padding,
                left: padding,
              },
              counterAxisAlign: "stretch" as const,
            },
          }
        : {}),
      ...(cornerRadius ? { cornerRadius } : {}),
      qualityRole: node.qualityRole,
      logicalRef,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      ...(visual ? { visual } : {}),
      ...(node.strokePalette
        ? {
            stroke: {
              color: { token: DESIGN_GENERATION_COLOR_TOKENS[node.strokePalette] },
              width: brandTokens?.stroke ?? 1,
            },
          }
        : {}),
    };
  }
  if (node.type === "icon") {
    const pathData = node.iconName ? designIconPath(node.iconName) : undefined;
    if (!pathData)
      throw new Error(`Icon “${node.iconName ?? "unknown"}” is not in the bundled allowlist.`);
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
    if (node.assetId)
      return {
        type: "image",
        name: node.name,
        width: node.width,
        height: node.height,
        assetId: node.assetId,
        fit: "fit",
        alt: node.text ?? node.name,
        qualityRole: "image",
        logicalRef,
      };
    const disclosure =
      language === "fa" ? "جایگاه تصویر · عکس واقعی نیست" : "Image placeholder · not a real photo";
    return {
      type: "frame",
      name: node.name,
      width: node.width,
      height: node.height,
      background: token ?? { token: DESIGN_GENERATION_COLOR_TOKENS.surface },
      layout: {
        mode: "vertical",
        gap,
        padding: { top: padding, right: padding, bottom: padding, left: padding },
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
      ...(cornerRadius ? { cornerRadius } : {}),
      qualityRole: "image",
      logicalRef,
      ...(node.pattern ? { pattern: node.pattern } : {}),
      ...(visual ? { visual } : {}),
      ...(node.strokePalette
        ? {
            stroke: {
              color: { token: DESIGN_GENERATION_COLOR_TOKENS[node.strokePalette] },
              width: 1,
            },
          }
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
      ? {
          stroke: {
            color: { token: DESIGN_GENERATION_COLOR_TOKENS[node.strokePalette] },
            width: brandTokens?.stroke ?? 1,
          },
        }
      : {}),
  };
}

function nearestToken(value: number, scale: number[]): number {
  return scale.reduce(
    (closest, candidate) =>
      Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
    scale[0] ?? value,
  );
}
