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
  "variant-selector",
  "cart-item",
  "quantity-control",
  "price-summary",
  "trust-row",
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

export const DESIGN_SCREEN_ROLES = [
  "home",
  "listing",
  "detail",
  "cart",
  "checkout",
  "account",
  "other",
] as const;
export type DesignScreenRole = (typeof DESIGN_SCREEN_ROLES)[number];
export type DesignSectionRole = "identity" | "primary" | "supporting";

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
    composition:
      'labeled input surface with qualityRole="input" on the search frame itself or a descendant input frame, at least 44×44 px, visible body-role placeholder text, search icon, and optional filter affordance; an icon, button, label, or pattern tag alone is not an input',
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
    id: "variant-selector",
    label: "Product variant selector",
    composition:
      "visible size or color choices with touch-sized options and a clearly selected choice",
    domains: ["commerce"],
  },
  {
    id: "cart-item",
    label: "Cart item",
    composition:
      "thumbnail or disclosed image placeholder, product name, variant, quantity control, and line price",
    domains: ["commerce"],
  },
  {
    id: "quantity-control",
    label: "Quantity control",
    composition: "decrease and increase affordances around a readable current quantity",
    domains: ["commerce"],
  },
  {
    id: "price-summary",
    label: "Price summary",
    composition: "aligned subtotal, applicable delivery/discount, and clearly emphasized total",
    domains: ["commerce", "finance"],
  },
  {
    id: "trust-row",
    label: "Trust and delivery row",
    composition: "one or two concise delivery, returns, payment or support assurances",
    domains: ["commerce", "finance", "travel"],
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
  "variant-selector":
    /\b(?:variant|size|color)\s+(?:selector|options?)\b|انتخاب(?:گر)?\s*(?:سایز|رنگ)|سایزها|رنگ‌ها/iu,
  "cart-item": /\b(?:cart|basket)\s+items?\b|اقلام?\s*سبد|محصولات?\s*سبد/iu,
  "quantity-control": /\bquantity\s+(?:control|stepper)\b|کنترل\s*تعداد|تعداد\s*محصول/iu,
  "price-summary": /\b(?:price|order)\s+summary\b|خلاصه\s*(?:قیمت|سفارش)|جمع\s*کل/iu,
  "trust-row": /\b(?:trust|delivery|shipping)\s+(?:row|details?)\b|ارسال|مرجوعی|ضمانت/iu,
  form: /\b(?:form|input\s+fields?|sign\s*in|sign\s*up|login)\b|فرم|ورود|ثبت‌نام/iu,
  "checkout-block": /\b(?:checkout|payment|order\s+summary|cart)\b|پرداخت|تسویه|سبد خرید/iu,
  "stat-card": /\b(?:kpi|statistics|stat\s+cards?|metrics?)\b|شاخص|آمار|معیار/iu,
  "data-table": /\b(?:data\s+table|table|rows?\s+and\s+columns)\b|جدول/iu,
  "empty-state": /\bempty\s+state\b|حالت خالی/iu,
  "loading-state": /\bloading\s+state\b|حالت بارگذاری/iu,
  "error-state": /\berror\s+state\b|حالت خطا/iu,
  footer: /\bfooter\b|پاورقی|پایین صفحه/iu,
};

const LEGACY_PATTERN_IDS = [
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
] as const satisfies readonly DesignPatternId[];
const LEGACY_PATTERN_SET = new Set<DesignPatternId>(LEGACY_PATTERN_IDS);

export function inferRequestedDesignPatterns(prompt: string): DesignPatternId[] {
  return DESIGN_PATTERN_IDS.filter((id) => PATTERN_TERMS[id].test(prompt));
}

const COMMERCE_ROLE_PATTERNS: Readonly<Record<DesignScreenRole, readonly DesignPatternId[]>> = {
  home: [
    "app-bar",
    "navigation",
    "search",
    "hero-banner",
    "cta-group",
    "category-chips",
    "product-card",
    "trust-row",
    "footer",
  ],
  listing: ["app-bar", "navigation", "search", "category-chips", "product-card", "footer"],
  detail: ["app-bar", "image-gallery", "variant-selector", "cta-group", "trust-row"],
  cart: [
    "app-bar",
    "cart-item",
    "quantity-control",
    "price-summary",
    "checkout-block",
    "cta-group",
    "trust-row",
  ],
  checkout: ["app-bar", "form", "price-summary", "checkout-block", "cta-group", "trust-row"],
  account: ["app-bar", "form", "cta-group", "footer"],
  other: [],
};

const COMMERCE_ROLE_SECTION_PATTERNS: Readonly<
  Record<DesignScreenRole, Readonly<Record<DesignSectionRole, readonly DesignPatternId[]>>>
> = {
  home: {
    identity: ["app-bar", "navigation", "search"],
    primary: ["hero-banner", "cta-group", "category-chips", "product-card"],
    supporting: ["trust-row", "footer"],
  },
  listing: {
    identity: ["app-bar", "search"],
    primary: ["category-chips", "product-card"],
    supporting: ["navigation", "footer"],
  },
  detail: {
    identity: ["app-bar"],
    primary: ["image-gallery", "variant-selector", "cta-group"],
    supporting: ["trust-row"],
  },
  cart: {
    identity: ["app-bar"],
    primary: ["cart-item", "quantity-control", "price-summary", "checkout-block", "cta-group"],
    supporting: ["trust-row"],
  },
  checkout: {
    identity: ["app-bar"],
    primary: ["form", "price-summary", "checkout-block", "cta-group"],
    supporting: ["trust-row"],
  },
  account: {
    identity: ["app-bar"],
    primary: ["form", "cta-group"],
    supporting: ["footer"],
  },
  other: {
    identity: ["app-bar", "navigation", "search"],
    primary: [],
    supporting: ["footer", "empty-state", "loading-state", "error-state"],
  },
};

export function inferDesignScreenRole(familyName: string): DesignScreenRole {
  const family = familyName.normalize("NFKC").toLocaleLowerCase();
  if (/cart|basket|سبد\s*(?:خرید)?|سبدخرید/iu.test(family)) return "cart";
  if (/checkout|payment|place\s+order|تسویه|پرداخت/iu.test(family)) return "checkout";
  if (/detail|product\s+view|item\s+view|product\s+page|جزئیات|مشخصات\s*محصول/iu.test(family))
    return "detail";
  if (/home|landing|welcome|خانه|صفحه\s*اصلی|اصلی|خوش‌آمد|خوشامد/iu.test(family)) return "home";
  if (/account|profile|settings|حساب|پروفایل|تنظیمات/iu.test(family)) return "account";
  if (/catalog|browse|listing|products?|shop|search|محصولات|فهرست|جستجو|فروشگاه/iu.test(family))
    return "listing";
  return "other";
}

export function commerceRolePatterns(role: DesignScreenRole): readonly DesignPatternId[] {
  return COMMERCE_ROLE_PATTERNS[role];
}

export function patternsForSectionRole(
  patterns: readonly DesignPatternId[],
  role: DesignScreenRole,
  section: DesignSectionRole,
): DesignPatternId[] {
  const rolePatterns = new Set(COMMERCE_ROLE_PATTERNS[role]);
  const sectionPatterns = new Set(COMMERCE_ROLE_SECTION_PATTERNS[role][section]);
  return patterns.filter((pattern) => {
    if (rolePatterns.has(pattern)) return sectionPatterns.has(pattern);
    if (section === "identity") return ["app-bar", "navigation", "search"].includes(pattern);
    if (section === "supporting")
      return ["footer", "trust-row", "empty-state", "loading-state", "error-state"].includes(
        pattern,
      );
    return !["app-bar", "navigation", "footer", "trust-row"].includes(pattern);
  });
}

export function commerceRoleSectionGuidance(
  role: DesignScreenRole,
  section: DesignSectionRole,
): string | undefined {
  const guidance: Partial<Record<DesignScreenRole, Record<DesignSectionRole, string>>> = {
    home: {
      identity:
        "Use a compact Persian RTL brand/search header; keep search and navigation controls touch-sized.",
      primary:
        "Make the campaign visually dominant, then show category shortcuts and at least two distinct side-by-side product cards. Each card needs its own product name, toman price, image slot, and restrained action.",
      supporting:
        "Use a concise delivery/returns trust row and a compact bottom navigation. Keep this section secondary to the campaign and product cards.",
    },
    listing: {
      identity: "Keep the app bar compact and make search/discovery immediately visible.",
      primary:
        "Build a balanced mobile product grid with at least two distinct product cards, consistent image ratios, concise names, toman prices and clear product hierarchy.",
      supporting:
        "Add compact navigation or one helpful merchandising/trust detail without repeating the product grid.",
    },
    detail: {
      identity: "Use only the compact product-detail app bar and relevant back/favorite actions.",
      primary:
        "Prioritize a coherent product image gallery, product title and toman price, visible size/color choices with a selected state, and one prominent add-to-cart action. Keep details in a clear RTL reading order.",
      supporting:
        "Show concise delivery/returns assurance and useful product information. Do not repeat the gallery or replace product details with a second generic card.",
    },
    cart: {
      identity: "Use a compact cart app bar with a clear cart title and relevant back action.",
      primary:
        "Show a populated cart item row with thumbnail/image slot, product name, selected variant, quantity stepper and line price. Follow it with subtotal, applicable discount/delivery, total and one prominent checkout CTA. Do not show an empty-cart state unless the brief explicitly requests it.",
      supporting:
        "Add concise delivery, discount or payment reassurance only when relevant; avoid repeating the item row or checkout summary.",
    },
    checkout: {
      identity: "Keep the checkout app bar compact and show the current checkout step when useful.",
      primary:
        "Group clearly labeled delivery/payment fields with a transparent order summary and one primary confirmation action.",
      supporting:
        "Use concise delivery/payment reassurance and preserve room for validation messages.",
    },
    account: {
      identity: "Use a compact account app bar with the current destination clearly named.",
      primary:
        "Show the requested account identity and grouped account controls with clear labels.",
      supporting: "Add only relevant secondary account navigation or help.",
    },
  };
  return guidance[role]?.[section];
}

export function inferLegacyPatternsForScreen(
  prompt: string,
  domain: string,
  familyName: string,
  screenCount: number,
  includeHighFidelityDefaults = false,
): DesignPatternId[] {
  const requested = inferRequestedDesignPatterns(prompt).filter((pattern) =>
    LEGACY_PATTERN_SET.has(pattern),
  );
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

export function inferPatternsForScreen(
  prompt: string,
  domain: string,
  familyName: string,
  screenCount: number,
  includeHighFidelityDefaults = false,
): DesignPatternId[] {
  const legacy = inferLegacyPatternsForScreen(
    prompt,
    domain,
    familyName,
    screenCount,
    includeHighFidelityDefaults,
  );
  if (domain !== "commerce" || !includeHighFidelityDefaults) return legacy;
  const role = inferDesignScreenRole(familyName);
  if (role === "other") return legacy;
  const rolePatterns = commerceRolePatterns(role);
  const conflictingPatterns: Partial<Record<DesignScreenRole, readonly DesignPatternId[]>> = {
    listing: ["hero-banner", "image-gallery", "variant-selector", "cart-item", "quantity-control"],
    detail: ["search", "category-chips", "product-card", "cart-item", "quantity-control"],
    cart: ["hero-banner", "search", "category-chips", "product-card", "image-gallery", "form"],
    checkout: ["hero-banner", "search", "category-chips", "product-card", "image-gallery"],
    account: ["hero-banner", "search", "category-chips", "product-card", "image-gallery"],
    home: ["cart-item", "quantity-control", "price-summary", "variant-selector"],
  };
  const conflicts = new Set(conflictingPatterns[role] ?? []);
  const family = familyName.toLocaleLowerCase();
  const start = prompt.toLocaleLowerCase().indexOf(family);
  const hasLocalExplicitRequirement = (pattern: DesignPatternId): boolean =>
    start >= 0 &&
    PATTERN_TERMS[pattern].test(
      prompt.slice(Math.max(0, start - 120), start + family.length + 180),
    );
  const selected = new Set<DesignPatternId>(rolePatterns);
  legacy.forEach((pattern) => {
    if (!conflicts.has(pattern) || hasLocalExplicitRequirement(pattern)) selected.add(pattern);
  });
  return DESIGN_PATTERN_IDS.filter((pattern) => selected.has(pattern));
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
