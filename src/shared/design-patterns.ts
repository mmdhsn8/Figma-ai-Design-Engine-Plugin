export const DESIGN_PATTERN_IDS = [
  "app-bar",
  "navigation",
  "hero-banner",
  "cta-group",
  "search",
  "category-chips",
  "product-card",
  "service-card",
  "image-gallery",
  "list-item",
  "form",
  "checkout-block",
  "stat-card",
  "data-table",
  "empty-state",
  "loading-state",
  "error-state",
  "footer",
] as const;

export type DesignPatternId = (typeof DESIGN_PATTERN_IDS)[number];

export interface DesignPatternDefinition {
  id: DesignPatternId;
  label: string;
  composition: string;
  domains: readonly string[];
}

/** Reusable composition guidance shared by the brief builder and model instructions. */
export const DESIGN_PATTERN_CATALOG: readonly DesignPatternDefinition[] = [
  {
    id: "app-bar",
    label: "App bar",
    composition:
      "brand or page title, one primary navigation row, and only relevant compact actions",
    domains: ["all"],
  },
  {
    id: "navigation",
    label: "Navigation",
    composition:
      "clearly grouped destinations with a visible current state and editable icon/text items",
    domains: ["all"],
  },
  {
    id: "hero-banner",
    label: "Hero banner",
    composition:
      "one dominant message, supporting copy, a clear action, and an image or labeled native illustration slot when useful",
    domains: ["commerce", "saas", "education", "onboarding", "media", "travel"],
  },
  {
    id: "cta-group",
    label: "Call to action group",
    composition: "one primary action and at most one visually subordinate alternative",
    domains: ["all"],
  },
  {
    id: "search",
    label: "Search",
    composition: "labeled input surface, search icon, and optional filter affordance",
    domains: ["commerce", "saas", "education", "content", "travel"],
  },
  {
    id: "category-chips",
    label: "Category chips",
    composition: "compact, consistently sized selectable filters with clear selected state",
    domains: ["commerce", "content", "travel"],
  },
  {
    id: "product-card",
    label: "Product card",
    composition:
      "image or labeled image placeholder, concise title, useful metadata, price where requested, and a restrained action",
    domains: ["commerce"],
  },
  {
    id: "service-card",
    label: "Service card",
    composition: "service identity, outcome or scope, key metadata, and a clear next action",
    domains: ["saas", "education", "health", "travel", "productivity"],
  },
  {
    id: "image-gallery",
    label: "Image gallery",
    composition:
      "consistent image ratios, intentional crop, and a clear placeholder disclosure when no authorized asset exists",
    domains: ["commerce", "media", "travel", "social"],
  },
  {
    id: "list-item",
    label: "List item",
    composition:
      "aligned leading icon or thumbnail, primary label, secondary metadata, and optional trailing action",
    domains: ["all"],
  },
  {
    id: "form",
    label: "Form",
    composition:
      "visible labels, grouped fields, clear validation space, and one primary submit action",
    domains: ["all"],
  },
  {
    id: "checkout-block",
    label: "Checkout block",
    composition:
      "item summary, transparent totals, requested payment details, and one clear confirmation action",
    domains: ["commerce", "finance"],
  },
  {
    id: "stat-card",
    label: "Statistic card",
    composition: "metric label, legible value, optional comparison, and a restrained data cue",
    domains: ["dashboard", "saas", "finance", "education"],
  },
  {
    id: "data-table",
    label: "Data table",
    composition:
      "aligned column labels, readable rows, clear status treatment, and sensible overflow",
    domains: ["dashboard", "saas", "finance", "education"],
  },
  {
    id: "empty-state",
    label: "Empty state",
    composition: "plain-language explanation and a useful next action",
    domains: ["all"],
  },
  {
    id: "loading-state",
    label: "Loading state",
    composition: "calm progress indication with context and stable content geometry",
    domains: ["all"],
  },
  {
    id: "error-state",
    label: "Error state",
    composition:
      "specific but non-sensitive explanation, recovery action, and preserved user input",
    domains: ["all"],
  },
  {
    id: "footer",
    label: "Footer",
    composition: "secondary navigation or contextual actions with clear hierarchy",
    domains: ["commerce", "saas", "content", "travel"],
  },
] as const;

const PATTERN_TERMS: Readonly<Record<DesignPatternId, RegExp>> = {
  "app-bar": /\b(?:app\s*bar|header|top\s*bar)\b|سربرگ|هدر|نوار بالا/iu,
  navigation: /\b(?:navigation|nav\s*bar|menu|tabs?)\b|ناوبری|منو|تب‌ها/iu,
  "hero-banner": /\b(?:hero|banner|masthead)\b|بنر|بخش قهرمان/iu,
  "cta-group": /\b(?:cta|call\s+to\s+action|primary\s+action)\b|فراخوان|دکمه اصلی/iu,
  search: /\bsearch(?:\s+(?:bar|field|input))?\b|جست[وجوی]+/iu,
  "category-chips": /\b(?:categories|category\s+chips|filters?)\b|دسته‌بندی|دسته بندی|فیلترها/iu,
  "product-card": /\b(?:product\s+cards?|products?|item\s+cards?)\b|کارت(?:‌|\s)?محصول|محصولات/iu,
  "service-card": /\b(?:service\s+cards?|service\s+list)\b|کارت خدمات|خدمات/iu,
  "image-gallery": /\b(?:image\s+gallery|gallery|photos?|imagery)\b|گالری تصویر|تصاویر/iu,
  "list-item": /\b(?:list|activity\s+feed|recent\s+items)\b|فهرست|لیست|فعالیت‌های اخیر/iu,
  form: /\b(?:form|input\s+fields?|sign\s*in|sign\s*up|login)\b|فرم|ورود|ثبت‌نام/iu,
  "checkout-block": /\b(?:checkout|payment|order\s+summary|cart)\b|پرداخت|تسویه|سبد خرید/iu,
  "stat-card": /\b(?:kpi|statistics|stat\s+cards?|metrics?)\b|شاخص|آمار|معیار/iu,
  "data-table": /\b(?:data\s+table|table|rows?\s+and\s+columns)\b|جدول/iu,
  "empty-state": /\bempty\s+state\b|حالت خالی/iu,
  "loading-state": /\bloading\s+state\b|حالت بارگذاری/iu,
  "error-state": /\berror\s+state\b|حالت خطا/iu,
  footer: /\bfooter\b|پاورقی|پایین صفحه/iu,
};

export function inferRequestedDesignPatterns(prompt: string): DesignPatternId[] {
  return DESIGN_PATTERN_IDS.filter((id) => PATTERN_TERMS[id].test(prompt));
}

export function inferPatternsForScreen(
  prompt: string,
  domain: string,
  familyName: string,
  screenCount: number,
  includeHighFidelityDefaults = false,
): DesignPatternId[] {
  const requested = inferRequestedDesignPatterns(prompt);
  const family = familyName.toLocaleLowerCase();
  const home = /home|overview|landing|welcome|خانه|اصلی|نمای کلی|خوش‌آمد|خوشامد/iu.test(family);
  const catalog = /product|catalog|browse|search|محصول|جستجو/iu.test(family);
  const detail = /detail|product|جزئیات|محصول/iu.test(family);
  const checkout = /checkout|cart|payment|order|پرداخت|سبد|تسویه/iu.test(family);
  const dashboard =
    /dashboard|analytics|overview|activity|گزارش|تحلیل|نمای کلی/iu.test(family) ||
    domain === "dashboard";
  const form = /sign|login|register|account|profile|settings|فرم|ورود|ثبت‌نام|حساب|تنظیمات/iu.test(
    family,
  );
  const list = /task|activity|list|feed|وظیفه|فعالیت|فهرست|لیست/iu.test(family);
  const defaults = new Set<DesignPatternId>();
  if (includeHighFidelityDefaults) {
    if (domain === "commerce") {
      if (home)
        [
          "app-bar",
          "navigation",
          "hero-banner",
          "cta-group",
          "category-chips",
          "product-card",
        ].forEach((pattern) => defaults.add(pattern as DesignPatternId));
      else if (catalog)
        ["app-bar", "navigation", "search", "category-chips", "product-card"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (detail)
        ["app-bar", "image-gallery", "cta-group"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (checkout)
        ["app-bar", "checkout-block", "form", "cta-group"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (form)
        ["app-bar", "form", "cta-group"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "dashboard" || domain === "saas") {
      if (dashboard || home)
        ["app-bar", "navigation", "stat-card", "data-table"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (form)
        ["app-bar", "form"].forEach((pattern) => defaults.add(pattern as DesignPatternId));
    } else if (domain === "onboarding") {
      if (home)
        ["hero-banner", "cta-group"].forEach((pattern) => defaults.add(pattern as DesignPatternId));
    } else if (domain === "education") {
      if (home)
        ["app-bar", "hero-banner", "service-card", "cta-group"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (catalog || list)
        ["app-bar", "search", "list-item"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "health") {
      if (home) ["service-card"].forEach((pattern) => defaults.add(pattern as DesignPatternId));
      else if (list)
        ["app-bar", "list-item"].forEach((pattern) => defaults.add(pattern as DesignPatternId));
    } else if (domain === "productivity") {
      if (home || list)
        ["app-bar", "navigation", "list-item", "cta-group"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (dashboard)
        ["app-bar", "stat-card", "list-item"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "finance") {
      if (home || dashboard)
        ["app-bar", "stat-card", "list-item"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (form || checkout)
        ["app-bar", "form", "checkout-block"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "travel") {
      if (home)
        ["app-bar", "hero-banner", "search", "service-card"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
      else if (catalog)
        ["app-bar", "search", "service-card"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "portfolio" || domain === "media" || domain === "content") {
      if (home)
        ["app-bar", "hero-banner", "image-gallery", "list-item"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "social") {
      if (home || list)
        ["app-bar", "navigation", "list-item"].forEach((pattern) =>
          defaults.add(pattern as DesignPatternId),
        );
    } else if (domain === "product" && home) {
      ["app-bar", "hero-banner", "cta-group"].forEach((pattern) =>
        defaults.add(pattern as DesignPatternId),
      );
    }
  }
  const explicitForThisScreen = (pattern: DesignPatternId): boolean => {
    const screenIndex = prompt.toLocaleLowerCase().indexOf(family);
    if (screenIndex < 0 || !PATTERN_TERMS[pattern].test(prompt)) return false;
    return PATTERN_TERMS[pattern].test(
      prompt.slice(Math.max(0, screenIndex - 120), screenIndex + family.length + 180),
    );
  };
  const suitableRequested = requested.filter((pattern) => {
    if (screenCount <= 1) return true;
    if (explicitForThisScreen(pattern)) return true;
    if (["app-bar", "navigation", "cta-group", "list-item"].includes(pattern))
      return home || checkout || dashboard || form;
    if (pattern === "hero-banner")
      return home || /onboard|welcome|intro|خانه|خوش‌آمد|خوشامد/iu.test(family);
    if (pattern === "search" || pattern === "category-chips")
      return catalog || (domain === "commerce" && home);
    if (pattern === "product-card") return domain === "commerce" && (home || catalog);
    if (pattern === "service-card") return domain !== "commerce" && (home || catalog || dashboard);
    if (pattern === "image-gallery")
      return detail || /gallery|media|portfolio|گالری|تصویر/iu.test(family);
    if (pattern === "form") return form || checkout;
    if (pattern === "checkout-block") return checkout;
    if (pattern === "stat-card" || pattern === "data-table") return dashboard;
    if (pattern === "footer") return home || catalog || checkout || dashboard;
    if (["empty-state", "loading-state", "error-state"].includes(pattern))
      return /empty|loading|error|خالی|بارگذاری|خطا/iu.test(family);
    return false;
  });
  const required = new Set([...defaults, ...suitableRequested]);
  return DESIGN_PATTERN_IDS.filter((pattern) => required.has(pattern));
}

export function designPatternInstructions(domain: string): string {
  const relevant = DESIGN_PATTERN_CATALOG.filter(
    (pattern) => pattern.domains.includes("all") || pattern.domains.includes(domain),
  );
  return relevant
    .map(
      (pattern) =>
        `- ${pattern.id}: ${pattern.composition}. Tag its root frame with pattern="${pattern.id}" when used.`,
    )
    .join("\n");
}
