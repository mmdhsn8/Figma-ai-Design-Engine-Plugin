import { z } from "zod";
import {
  DESIGN_PATTERN_IDS,
  DESIGN_SCREEN_ROLES,
  patternsForSectionRole,
  type DesignPatternId,
  type DesignScreenRole,
  type DesignSectionRole,
} from "./design-patterns.js";

export const VISUAL_COMPOSITION_VERSION = 1 as const;

export const VisualAssetCoverageSchema = z
  .object({
    status: z.enum(["complete", "placeholder-backed", "not-required", "incomplete"]),
    requiredSlots: z.number().int().min(0).max(10_000),
    authorizedAssets: z.number().int().min(0).max(10_000),
    placeholders: z.number().int().min(0).max(10_000),
  })
  .strict();
export type VisualAssetCoverage = z.infer<typeof VisualAssetCoverageSchema>;

const RequiredPatternsBySectionSchema = z
  .object({
    identity: z.array(z.enum(DESIGN_PATTERN_IDS)).max(18),
    primary: z.array(z.enum(DESIGN_PATTERN_IDS)).max(18),
    supporting: z.array(z.enum(DESIGN_PATTERN_IDS)).max(18),
  })
  .strip();

const VisualCompositionPatternCountSchema = z
  .object({
    section: z.enum(["identity", "primary", "supporting"]).optional(),
    pattern: z.enum(DESIGN_PATTERN_IDS),
    minimum: z.number().int().min(1).max(10),
  })
  .strip();

export const VisualCompositionContractSchema = z
  .object({
    version: z.literal(VISUAL_COMPOSITION_VERSION),
    domain: z.string().trim().min(1).max(80),
    screenRole: z.enum(DESIGN_SCREEN_ROLES),
    sectionId: z.enum(["identity", "primary", "supporting"]).optional(),
    visualIntent: z
      .object({
        mood: z.string().trim().min(1).max(160),
        density: z.enum(["compact", "balanced", "spacious"]),
        typographyScale: z.string().trim().min(1).max(160),
        imageryTreatment: z.literal("authorized-asset-or-labeled-placeholder"),
        sectionEmphasis: z.array(z.string().trim().min(1).max(100)).max(8),
      })
      .strip(),
    layout: z
      .object({
        viewportWidth: z.number().int().positive().max(5_000),
        viewportHeight: z.number().int().positive().max(5_000),
        innerWidth: z.number().int().positive().max(5_000),
        outerPadding: z.number().int().min(0).max(256),
        spacingScale: z.array(z.number().min(0).max(128)).min(2).max(8),
        flow: z.literal("vertical"),
        alignment: z.literal("stretch"),
        contentHeight: z.literal("content-driven-within-section-bounds"),
        overflow: z.literal("no-unintended-overflow"),
      })
      .strip(),
    content: z
      .object({
        requiredPatternsBySection: RequiredPatternsBySectionSchema,
        sectionEmphasis: z.array(z.string().trim().min(1).max(100)).max(8),
      })
      .strip(),
    assets: VisualAssetCoverageSchema,
    quality: z
      .object({
        minimumPatternCounts: z.array(VisualCompositionPatternCountSchema).max(18),
        minimumImageSlots: z.number().int().min(0).max(20),
        minimumHeadingCount: z.number().int().min(0).max(10),
        minimumButtonCount: z.number().int().min(0).max(20),
        minimumPriceCount: z.number().int().min(0).max(20),
        priceFormat: z.enum(["toman", "numeric"]),
        noUnintendedOverflow: z.literal(true),
      })
      .strip(),
  })
  .strip();
export type VisualCompositionContract = z.infer<typeof VisualCompositionContractSchema>;

export type VisualCompositionNode = {
  logicalRef: string;
  parentRef?: string;
  sectionId?: DesignSectionRole;
  nodeType: string;
  nativeType: string;
  qualityRole: string;
  pattern?: DesignPatternId;
  text?: string;
  assetId?: string;
  placeholder?: boolean;
};

const roleEmphasis: Readonly<Record<DesignScreenRole, readonly string[]>> = {
  home: ["campaign", "categories", "product-merchandising", "navigation"],
  listing: ["discovery", "product-grid", "filters"],
  detail: ["product-gallery", "variants", "purchase-action", "delivery-trust"],
  cart: ["cart-items", "quantity", "price-summary", "checkout-action"],
  checkout: ["delivery-details", "order-summary", "confirmation-action"],
  account: ["account-identity", "requested-controls"],
  other: ["user-requested-primary-task", "supporting-information"],
};

export function createVisualCompositionContract(input: {
  domain: string;
  role: DesignScreenRole;
  locale?: "fa" | "en";
  sectionId?: DesignSectionRole;
  mood: string;
  prompt: string;
  viewport: { width: number; height: number };
  spacingScale: number[];
  requiredPatterns: readonly DesignPatternId[];
  assetCoverage: VisualAssetCoverage;
}): VisualCompositionContract {
  const density = /compact|dense|فشرده/iu.test(input.prompt)
    ? "compact"
    : /airy|spacious|ساده و خلوت|فضای خالی/iu.test(input.prompt)
      ? "spacious"
      : "balanced";
  const patternsBySection =
    input.domain === "commerce"
      ? {
          identity: patternsForSectionRole(input.requiredPatterns, input.role, "identity"),
          primary: patternsForSectionRole(input.requiredPatterns, input.role, "primary"),
          supporting: patternsForSectionRole(input.requiredPatterns, input.role, "supporting"),
        }
      : {
          identity: input.requiredPatterns.filter((pattern) =>
            ["app-bar", "navigation", "search"].includes(pattern),
          ),
          primary: input.requiredPatterns.filter(
            (pattern) =>
              ![
                "app-bar",
                "navigation",
                "search",
                "footer",
                "empty-state",
                "loading-state",
                "error-state",
              ].includes(pattern),
          ),
          supporting: input.requiredPatterns.filter((pattern) =>
            ["footer", "empty-state", "loading-state", "error-state"].includes(pattern),
          ),
        };
  const relevantSections = input.sectionId
    ? [input.sectionId]
    : (["identity", "primary", "supporting"] as const);
  const minimumPatternCounts: Array<{
    section?: DesignSectionRole;
    pattern: DesignPatternId;
    minimum: number;
  }> = [];
  const addMinimum = (section: DesignSectionRole, pattern: DesignPatternId, minimum: number) => {
    if (!relevantSections.includes(section)) return;
    if (!patternsBySection[section].includes(pattern)) return;
    minimumPatternCounts.push({ section, pattern, minimum });
  };
  if (input.domain === "commerce" && input.role === "home") {
    addMinimum("primary", "hero-banner", 1);
    addMinimum("primary", "category-chips", 1);
    addMinimum("primary", "product-card", 2);
  } else if (input.domain === "commerce" && input.role === "listing") {
    addMinimum("primary", "product-card", 2);
  } else if (input.domain === "commerce" && input.role === "detail") {
    addMinimum("primary", "image-gallery", 1);
    addMinimum("primary", "variant-selector", 1);
    addMinimum("primary", "cta-group", 1);
  } else if (input.domain === "commerce" && input.role === "cart") {
    addMinimum("primary", "cart-item", 1);
    addMinimum("primary", "quantity-control", 1);
    addMinimum("primary", "price-summary", 1);
    addMinimum("primary", "checkout-block", 1);
    addMinimum("primary", "cta-group", 1);
  } else if (input.domain === "commerce" && input.role === "checkout") {
    addMinimum("primary", "form", 1);
    addMinimum("primary", "price-summary", 1);
    addMinimum("primary", "cta-group", 1);
  }
  const mobile = input.viewport.width === 390;
  const imageRoles: DesignScreenRole[] = ["home", "listing", "detail", "cart"];
  const roleMinimumImages =
    input.domain === "commerce" && imageRoles.includes(input.role)
      ? input.role === "home" || input.role === "listing"
        ? 2
        : 1
      : 0;
  const minimumImageSlots =
    input.sectionId && input.sectionId !== "primary" ? 0 : roleMinimumImages;
  const minimumPriceCount =
    input.domain !== "commerce" ||
    input.sectionId === "identity" ||
    input.sectionId === "supporting"
      ? 0
      : input.role === "home" || input.role === "listing"
        ? 2
        : ["detail", "cart", "checkout"].includes(input.role)
          ? 1
          : 0;
  const priceFormat =
    /تومان|toman/iu.test(input.prompt) || /fa/iu.test(input.locale ?? "") ? "toman" : "numeric";
  return VisualCompositionContractSchema.parse({
    version: VISUAL_COMPOSITION_VERSION,
    domain: input.domain,
    screenRole: input.role,
    ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    visualIntent: {
      mood: input.mood.trim().slice(0, 160) || "Professional and restrained",
      density,
      typographyScale:
        "Use semantic display, heading, body, caption and button roles from the pinned style direction.",
      imageryTreatment: "authorized-asset-or-labeled-placeholder",
      sectionEmphasis: roleEmphasis[input.role],
    },
    layout: {
      viewportWidth: input.viewport.width,
      viewportHeight: input.viewport.height,
      innerWidth: Math.max(1, input.viewport.width - (mobile ? 40 : 64)),
      outerPadding: mobile ? 20 : 32,
      spacingScale: input.spacingScale,
      flow: "vertical",
      alignment: "stretch",
      contentHeight: "content-driven-within-section-bounds",
      overflow: "no-unintended-overflow",
    },
    content: {
      requiredPatternsBySection: patternsBySection,
      sectionEmphasis: roleEmphasis[input.role],
    },
    assets: input.assetCoverage,
    quality: {
      minimumPatternCounts,
      minimumImageSlots,
      minimumHeadingCount:
        input.domain !== "commerce"
          ? input.sectionId === "supporting" ||
            input.sectionId === "identity" ||
            input.role === "other"
            ? 0
            : 1
          : input.sectionId === "supporting" || input.sectionId === "identity"
            ? 0
            : input.sectionId === "primary"
              ? ["home", "listing", "detail"].includes(input.role)
                ? 1
                : 0
              : input.role === "other"
                ? 0
                : 1,
      minimumButtonCount:
        input.domain !== "commerce"
          ? 0
          : input.sectionId && input.sectionId !== "primary"
            ? 0
            : ["home", "detail", "cart", "checkout", "account"].includes(input.role)
              ? 1
              : 0,
      minimumPriceCount,
      priceFormat,
      noUnintendedOverflow: true,
    },
  });
}

export function summarizeVisualAssetCoverage(
  nodes: readonly Pick<VisualCompositionNode, "nodeType" | "assetId" | "placeholder">[],
  requiredSlots: number,
): VisualAssetCoverage {
  const images = nodes.filter((node) => node.nodeType === "image");
  const authorizedAssets = images.filter((node) => Boolean(node.assetId)).length;
  const placeholders = images.filter((node) => node.placeholder === true && !node.assetId).length;
  const status =
    requiredSlots === 0 && images.length === 0
      ? "not-required"
      : images.length < requiredSlots
        ? "incomplete"
        : placeholders > 0
          ? "placeholder-backed"
          : authorizedAssets >= requiredSlots
            ? "complete"
            : "incomplete";
  return VisualAssetCoverageSchema.parse({ status, requiredSlots, authorizedAssets, placeholders });
}

function descendantsFor(
  rootRef: string,
  childrenByParent: ReadonlyMap<string, readonly VisualCompositionNode[]>,
): VisualCompositionNode[] {
  const descendants: VisualCompositionNode[] = [];
  const visit = (parentRef: string) => {
    for (const child of childrenByParent.get(parentRef) ?? []) {
      descendants.push(child);
      visit(child.logicalRef);
    }
  };
  visit(rootRef);
  return descendants;
}

export function validateVisualCompositionCoverage(
  contract: VisualCompositionContract,
  nodes: readonly VisualCompositionNode[],
): string[] {
  const errors: string[] = [];
  const grouped = new Map<DesignSectionRole, VisualCompositionNode[]>();
  for (const node of nodes) {
    if (!node.sectionId) continue;
    const values = grouped.get(node.sectionId) ?? [];
    values.push(node);
    grouped.set(node.sectionId, values);
  }
  const checks: Array<{ section: DesignSectionRole; nodes: readonly VisualCompositionNode[] }> =
    contract.sectionId
      ? [
          {
            section: contract.sectionId,
            nodes: nodes.filter(({ sectionId }) => sectionId === contract.sectionId),
          },
        ]
      : grouped.size
        ? (["identity", "primary", "supporting"] as const).map((section) => ({
            section,
            nodes: grouped.get(section) ?? [],
          }))
        : [{ section: "primary", nodes }];
  const nodesForSection = new Map(
    checks.map(({ section, nodes: sectionNodes }) => [section, sectionNodes]),
  );
  for (const { section, nodes: sectionNodes } of checks) {
    const found = new Set(sectionNodes.flatMap((node) => (node.pattern ? [node.pattern] : [])));
    for (const pattern of contract.content.requiredPatternsBySection[section]) {
      if (!found.has(pattern))
        errors.push(
          `visual_composition.required_pattern_missing:${contract.screenRole}:${section}:${pattern}`,
        );
    }
  }
  const childrenByParent = new Map<string, VisualCompositionNode[]>();
  for (const node of nodes) {
    if (!node.parentRef) continue;
    const children = childrenByParent.get(node.parentRef) ?? [];
    children.push(node);
    childrenByParent.set(node.parentRef, children);
  }
  for (const requirement of contract.quality.minimumPatternCounts) {
    const candidates = requirement.section
      ? (nodesForSection.get(requirement.section) ?? [])
      : nodes;
    const actual = candidates.filter((node) => node.pattern === requirement.pattern).length;
    if (actual < requirement.minimum)
      errors.push(
        `visual_composition.pattern_count_below_minimum:${contract.screenRole}:${requirement.section ?? "screen"}:${requirement.pattern}:${actual}/${requirement.minimum}`,
      );
  }
  const imageNodes = nodes.filter((node) => node.nodeType === "image");
  if (imageNodes.length < contract.quality.minimumImageSlots)
    errors.push(
      `visual_composition.image_slots_below_minimum:${contract.screenRole}:${imageNodes.length}/${contract.quality.minimumImageSlots}`,
    );
  const headingCount = nodes.filter(
    (node) => node.nodeType === "text" && node.qualityRole === "heading",
  ).length;
  if (headingCount < contract.quality.minimumHeadingCount)
    errors.push(
      `visual_composition.heading_count_below_minimum:${contract.screenRole}:${headingCount}/${contract.quality.minimumHeadingCount}`,
    );
  const buttonCount = nodes.filter((node) => node.qualityRole === "button").length;
  if (buttonCount < contract.quality.minimumButtonCount)
    errors.push(
      `visual_composition.button_count_below_minimum:${contract.screenRole}:${buttonCount}/${contract.quality.minimumButtonCount}`,
    );
  const pricePattern =
    contract.quality.priceFormat === "toman"
      ? /[0-9۰-۹٠-٩][0-9۰-۹٠-٩,٬.]*\s*(?:تومان|toman)/iu
      : /[0-9۰-۹٠-٩][0-9۰-۹٠-٩,٬.]*/u;
  const prices = nodes.filter(
    (node) =>
      node.nodeType === "text" &&
      node.qualityRole !== "decorative" &&
      pricePattern.test(node.text ?? ""),
  );
  if (prices.length < contract.quality.minimumPriceCount)
    errors.push(
      `visual_composition.price_count_below_minimum:${contract.screenRole}:${prices.length}/${contract.quality.minimumPriceCount}:${contract.quality.priceFormat}`,
    );
  for (const { section, nodes: sectionNodes } of checks) {
    for (const root of sectionNodes.filter((node) => node.pattern)) {
      const descendants = descendantsFor(root.logicalRef, childrenByParent);
      const images = descendants.filter((node) => node.nodeType === "image");
      const texts = descendants.filter((node) => node.nodeType === "text" && node.text?.trim());
      const buttons = descendants.filter((node) => node.qualityRole === "button");
      const controls = descendants.filter(
        (node) => node.qualityRole === "button" || node.qualityRole === "input",
      );
      if (root.pattern === "app-bar" && !texts.length && !images.length)
        errors.push(
          `visual_composition.app_bar_identity_missing:${contract.screenRole}:${section}:${root.logicalRef}`,
        );
      if (root.pattern === "navigation" && texts.length < 2)
        errors.push(
          `visual_composition.navigation_labels_missing:${contract.screenRole}:${section}:${root.logicalRef}:${texts.length}/2`,
        );
      if (
        root.pattern === "search" &&
        root.qualityRole !== "input" &&
        !descendants.some((node) => node.qualityRole === "input")
      )
        errors.push(
          `visual_composition.search_field_missing:${contract.screenRole}:${section}:${root.logicalRef}`,
        );
      const hasPrice = descendants.some(
        (node) => node.nodeType === "text" && pricePattern.test(node.text ?? ""),
      );
      if (["product-card", "image-gallery", "cart-item"].includes(root.pattern!)) {
        if (!images.length)
          errors.push(
            `visual_composition.pattern_image_missing:${contract.screenRole}:${section}:${root.pattern}:${root.logicalRef}`,
          );
        if (["product-card", "cart-item"].includes(root.pattern!) && texts.length < 2)
          errors.push(
            `visual_composition.pattern_content_sparse:${contract.screenRole}:${section}:${root.pattern}:${root.logicalRef}:${texts.length}/2`,
          );
        if (["product-card", "cart-item"].includes(root.pattern!) && !hasPrice)
          errors.push(
            `visual_composition.pattern_price_missing:${contract.screenRole}:${section}:${root.pattern}:${root.logicalRef}:${contract.quality.priceFormat}`,
          );
        if (root.pattern === "cart-item" && texts.length < 3)
          errors.push(
            `visual_composition.cart_item_fields_missing:${contract.screenRole}:${section}:${root.logicalRef}:${texts.length}/3`,
          );
      }
      if (["hero-banner", "cta-group"].includes(root.pattern!) && !buttons.length)
        errors.push(
          `visual_composition.pattern_action_missing:${contract.screenRole}:${section}:${root.pattern}:${root.logicalRef}`,
        );
      if (
        root.pattern === "hero-banner" &&
        !descendants.some((node) => node.qualityRole === "heading")
      )
        errors.push(
          `visual_composition.hero_heading_missing:${contract.screenRole}:${section}:${root.logicalRef}`,
        );
      if (root.pattern === "variant-selector" && controls.length < 2)
        errors.push(
          `visual_composition.variant_choices_missing:${contract.screenRole}:${section}:${root.logicalRef}:${controls.length}/2`,
        );
      if (root.pattern === "quantity-control" && (controls.length < 2 || !texts.length))
        errors.push(
          `visual_composition.quantity_controls_missing:${contract.screenRole}:${section}:${root.logicalRef}`,
        );
      if (root.pattern === "price-summary" && texts.length < 3)
        errors.push(
          `visual_composition.price_summary_fields_missing:${contract.screenRole}:${section}:${root.logicalRef}:${texts.length}/3`,
        );
      if (root.pattern === "price-summary" && !hasPrice)
        errors.push(
          `visual_composition.pattern_price_missing:${contract.screenRole}:${section}:${root.pattern}:${root.logicalRef}:${contract.quality.priceFormat}`,
        );
      if (root.pattern === "trust-row" && !texts.length)
        errors.push(
          `visual_composition.trust_content_missing:${contract.screenRole}:${section}:${root.logicalRef}`,
        );
      if (root.pattern === "category-chips" && controls.length < 2)
        errors.push(
          `visual_composition.category_choices_missing:${contract.screenRole}:${section}:${root.logicalRef}:${controls.length}/2`,
        );
      if (root.pattern === "form" && !descendants.some((node) => node.qualityRole === "input"))
        errors.push(
          `visual_composition.form_fields_missing:${contract.screenRole}:${section}:${root.logicalRef}`,
        );
    }
  }
  return [...new Set(errors)].slice(0, 24);
}
