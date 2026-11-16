import { describe, expect, it } from "vitest";
import {
  commerceRolePatterns,
  inferDesignScreenRole,
  inferPatternsForScreen,
  patternsForSectionRole,
} from "../src/shared/design-patterns";
import { generatedSectionMaxHeight } from "../src/shared/design-generation";
import {
  createVisualCompositionContract,
  summarizeVisualAssetCoverage,
  validateVisualCompositionCoverage,
  VisualCompositionContractSchema,
  type VisualCompositionNode,
} from "../src/shared/visual-composition";

describe("versioned visual composition contract", () => {
  it.each([
    ["صفحه اصلی", "home"],
    ["محصولات", "listing"],
    ["جزئیات محصول", "detail"],
    ["سبد خرید", "cart"],
    ["تسویه حساب", "checkout"],
    ["حساب کاربری", "account"],
  ] as const)("classifies the Persian %s screen as %s", (name, expected) => {
    expect(inferDesignScreenRole(name)).toBe(expected);
  });

  it("keeps detail and cart requirements semantically distinct and section-local", () => {
    const detail = inferPatternsForScreen("فروشگاه لباس", "commerce", "جزئیات محصول", 3, true);
    const cart = inferPatternsForScreen("فروشگاه لباس", "commerce", "سبد خرید", 3, true);

    expect(detail).toEqual(expect.arrayContaining([...commerceRolePatterns("detail")]));
    expect(cart).toEqual(expect.arrayContaining([...commerceRolePatterns("cart")]));
    expect(detail).toContain("variant-selector");
    expect(detail).not.toContain("cart-item");
    expect(cart).toContain("quantity-control");
    expect(cart).not.toContain("image-gallery");
    const detailPrimary = patternsForSectionRole(detail, "detail", "primary");
    expect(detailPrimary).toEqual(
      expect.arrayContaining(["image-gallery", "variant-selector", "cta-group"]),
    );
    expect(detailPrimary).toHaveLength(3);
  });

  it("budgets scroll content independently from the viewport and preserves desktop limits", () => {
    const mobile = { devicePreset: "mobile" as const };
    const desktop = { devicePreset: "desktop" as const };
    const mobileContentBudget =
      generatedSectionMaxHeight(mobile, "identity") +
      generatedSectionMaxHeight(mobile, "primary") +
      generatedSectionMaxHeight(mobile, "supporting") +
      2 * 16 +
      2 * 20;

    expect(generatedSectionMaxHeight(mobile, "primary")).toBe(1600);
    expect(generatedSectionMaxHeight(mobile, "identity")).toBe(300);
    expect(generatedSectionMaxHeight(mobile, "supporting")).toBe(210);
    expect(mobileContentBudget).toBe(2182);
    expect(mobileContentBudget).toBeGreaterThan(844);
    expect(generatedSectionMaxHeight(desktop, "primary")).toBe(240);
  });

  it("accepts a dense editable detail composition and rejects missing semantic slots", () => {
    const requiredPatterns = inferPatternsForScreen(
      "یک صفحه جزئیات محصول فروشگاه لباس",
      "commerce",
      "جزئیات محصول",
      1,
      true,
    );
    const contract = createVisualCompositionContract({
      domain: "commerce",
      role: "detail",
      locale: "fa",
      sectionId: "primary",
      mood: "معاصر و حرفه‌ای",
      prompt: "RTL product detail",
      viewport: { width: 390, height: 844 },
      spacingScale: [4, 8, 12, 16, 24, 32],
      requiredPatterns,
      assetCoverage: {
        status: "placeholder-backed",
        requiredSlots: 1,
        authorizedAssets: 0,
        placeholders: 1,
      },
    });
    const validNodes: VisualCompositionNode[] = [
      {
        logicalRef: "gallery",
        sectionId: "primary",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "decorative",
        pattern: "image-gallery",
      },
      {
        logicalRef: "product-image",
        parentRef: "gallery",
        sectionId: "primary",
        nodeType: "image",
        nativeType: "FRAME",
        qualityRole: "image",
        placeholder: true,
      },
      {
        logicalRef: "variants",
        sectionId: "primary",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "decorative",
        pattern: "variant-selector",
      },
      ...["small", "medium"].map((size) => ({
        logicalRef: `variant-${size}`,
        parentRef: "variants",
        sectionId: "primary" as const,
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "button",
        text: size,
      })),
      {
        logicalRef: "purchase",
        sectionId: "primary",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "decorative",
        pattern: "cta-group",
      },
      {
        logicalRef: "add-to-cart",
        parentRef: "purchase",
        sectionId: "primary",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "button",
        text: "افزودن به سبد",
      },
      {
        logicalRef: "title",
        sectionId: "primary",
        nodeType: "text",
        nativeType: "TEXT",
        qualityRole: "heading",
        text: "مانتو لینن",
      },
      {
        logicalRef: "price",
        sectionId: "primary",
        nodeType: "text",
        nativeType: "TEXT",
        qualityRole: "body",
        text: "۱٬۲۹۰٬۰۰۰ تومان",
      },
    ];

    expect(validateVisualCompositionCoverage(contract, validNodes)).toEqual([]);
    expect(
      validateVisualCompositionCoverage(
        contract,
        validNodes.filter(({ logicalRef }) => logicalRef !== "price"),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("price_count_below_minimum")]));
    const sparseNodes = validNodes.filter(
      ({ logicalRef }) => logicalRef !== "product-image" && logicalRef !== "variant-medium",
    );
    expect(validateVisualCompositionCoverage(contract, sparseNodes)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("image_slots_below_minimum"),
        expect.stringContaining("variant_choices_missing"),
      ]),
    );
  });

  it("rejects empty home and cart primary sections against their role recipes", () => {
    for (const [role, name, expectedCode] of [
      ["home", "خانه", "product-card:0/2"],
      ["cart", "سبد خرید", "cart-item:0/1"],
    ] as const) {
      const patterns = inferPatternsForScreen("فروشگاه لباس", "commerce", name, 3, true);
      const contract = createVisualCompositionContract({
        domain: "commerce",
        role,
        sectionId: "primary",
        mood: "professional",
        prompt: "Persian storefront",
        viewport: { width: 390, height: 844 },
        spacingScale: [4, 8, 12, 16],
        requiredPatterns: patterns,
        assetCoverage: {
          status: "incomplete",
          requiredSlots: role === "home" ? 2 : 1,
          authorizedAssets: 0,
          placeholders: 0,
        },
      });
      const errors = validateVisualCompositionCoverage(contract, []);

      expect(errors.some((error) => error.includes(expectedCode))).toBe(true);
      expect(errors.some((error) => error.includes("image_slots_below_minimum"))).toBe(true);
    }
  });

  it("rejects empty commerce identity patterns even when their tags are present", () => {
    const patterns = inferPatternsForScreen("فروشگاه لباس", "commerce", "خانه", 1, true);
    const contract = createVisualCompositionContract({
      domain: "commerce",
      role: "home",
      locale: "fa",
      sectionId: "identity",
      mood: "professional",
      prompt: "Persian RTL storefront",
      viewport: { width: 390, height: 844 },
      spacingScale: [4, 8, 12, 16],
      requiredPatterns: patterns,
      assetCoverage: {
        status: "not-required",
        requiredSlots: 0,
        authorizedAssets: 0,
        placeholders: 0,
      },
    });
    const nodes: VisualCompositionNode[] = [
      {
        logicalRef: "app-bar",
        sectionId: "identity",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "decorative",
        pattern: "app-bar",
      },
      {
        logicalRef: "navigation",
        sectionId: "identity",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "decorative",
        pattern: "navigation",
      },
      {
        logicalRef: "search",
        sectionId: "identity",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "decorative",
        pattern: "search",
      },
    ];

    expect(validateVisualCompositionCoverage(contract, nodes)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("app_bar_identity_missing"),
        expect.stringContaining("navigation_labels_missing"),
        expect.stringContaining("search_field_missing"),
      ]),
    );
  });

  it.each(["root", "descendant", "missing", "sibling"] as const)(
    "validates a search field at %s without confusing unrelated inputs for the search control",
    (placement) => {
      const contract = createVisualCompositionContract({
        domain: "commerce",
        role: "home",
        sectionId: "identity",
        mood: "professional",
        prompt: "Persian storefront search",
        viewport: { width: 390, height: 844 },
        spacingScale: [4, 8, 16],
        requiredPatterns: ["search"],
        assetCoverage: { status: "not-required", requiredSlots: 0, authorizedAssets: 0, placeholders: 0 },
      });
      const nodes: VisualCompositionNode[] = [{
        logicalRef: "search",
        sectionId: "identity",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: placement === "root" ? "input" : "decorative",
        pattern: "search",
      }, {
        logicalRef: "search-label",
        parentRef: "search",
        sectionId: "identity",
        nodeType: "text",
        nativeType: "TEXT",
        qualityRole: "body",
        text: "جستجوی محصولات",
      }];
      if (placement === "descendant" || placement === "sibling") nodes.push({
        logicalRef: "field",
        ...(placement === "descendant" ? { parentRef: "search" } : {}),
        sectionId: "identity",
        nodeType: "frame",
        nativeType: "FRAME",
        qualityRole: "input",
      });
      const errors = validateVisualCompositionCoverage(contract, nodes);
      if (placement === "root" || placement === "descendant") expect(errors).toEqual([]);
      else expect(errors).toContain("visual_composition.search_field_missing:home:identity:search");
    },
  );

  it("accepts complete home product cards and a populated cart composition", () => {
    const makeContract = (role: "home" | "cart", name: string) =>
      createVisualCompositionContract({
        domain: "commerce",
        role,
        locale: "fa",
        sectionId: "primary",
        mood: "professional",
        prompt: "فروشگاه با قیمت به تومان",
        viewport: { width: 390, height: 844 },
        spacingScale: [4, 8, 12, 16],
        requiredPatterns: inferPatternsForScreen("فروشگاه لباس", "commerce", name, 3, true),
        assetCoverage: {
          status: "placeholder-backed",
          requiredSlots: role === "home" ? 2 : 1,
          authorizedAssets: 0,
          placeholders: role === "home" ? 2 : 1,
        },
      });
    const item = (
      logicalRef: string,
      overrides: Partial<VisualCompositionNode> = {},
    ): VisualCompositionNode => ({
      logicalRef,
      sectionId: "primary",
      nodeType: "frame",
      nativeType: "FRAME",
      qualityRole: "decorative",
      ...overrides,
    });
    const homeNodes: VisualCompositionNode[] = [
      item("hero", { pattern: "hero-banner" }),
      item("hero-title", {
        parentRef: "hero",
        nodeType: "text",
        qualityRole: "heading",
        text: "تازه‌های بهار",
      }),
      item("hero-action", { parentRef: "hero", qualityRole: "button", text: "مشاهده" }),
      item("cta", { pattern: "cta-group" }),
      item("cta-action", { parentRef: "cta", qualityRole: "button", text: "خرید" }),
      item("categories", { pattern: "category-chips" }),
      item("category-one", { parentRef: "categories", qualityRole: "button", text: "مانتو" }),
      item("category-two", { parentRef: "categories", qualityRole: "button", text: "شال" }),
      ...["one", "two"].flatMap((id) => [
        item(`card-${id}`, { pattern: "product-card" }),
        item(`image-${id}`, {
          parentRef: `card-${id}`,
          nodeType: "image",
          qualityRole: "image",
          placeholder: true,
        }),
        item(`title-${id}`, {
          parentRef: `card-${id}`,
          nodeType: "text",
          qualityRole: "body",
          text: `محصول ${id}`,
        }),
        item(`price-${id}`, {
          parentRef: `card-${id}`,
          nodeType: "text",
          qualityRole: "body",
          text: "۳۵۰٬۰۰۰ تومان",
        }),
        item(`metadata-${id}`, {
          parentRef: `card-${id}`,
          nodeType: "text",
          qualityRole: "body",
          text: "ارسال سریع",
        }),
      ]),
    ];
    const cartNodes: VisualCompositionNode[] = [
      item("cart-item", { pattern: "cart-item" }),
      item("cart-image", {
        parentRef: "cart-item",
        nodeType: "image",
        qualityRole: "image",
        placeholder: true,
      }),
      item("cart-title", {
        parentRef: "cart-item",
        nodeType: "text",
        qualityRole: "body",
        text: "مانتو لینن",
      }),
      item("cart-variant", {
        parentRef: "cart-item",
        nodeType: "text",
        qualityRole: "body",
        text: "سایز M",
      }),
      item("cart-price", {
        parentRef: "cart-item",
        nodeType: "text",
        qualityRole: "body",
        text: "۱٬۲۹۰٬۰۰۰ تومان",
      }),
      item("quantity", { pattern: "quantity-control" }),
      item("quantity-minus", { parentRef: "quantity", qualityRole: "button", text: "−" }),
      item("quantity-value", {
        parentRef: "quantity",
        nodeType: "text",
        qualityRole: "body",
        text: "۱",
      }),
      item("quantity-plus", { parentRef: "quantity", qualityRole: "button", text: "+" }),
      item("summary", { pattern: "price-summary" }),
      item("subtotal", {
        parentRef: "summary",
        nodeType: "text",
        qualityRole: "body",
        text: "جمع جزء ۱٬۲۹۰٬۰۰۰ تومان",
      }),
      item("shipping", {
        parentRef: "summary",
        nodeType: "text",
        qualityRole: "body",
        text: "ارسال ۵۰٬۰۰۰ تومان",
      }),
      item("total", {
        parentRef: "summary",
        nodeType: "text",
        qualityRole: "body",
        text: "مجموع ۱٬۳۴۰٬۰۰۰ تومان",
      }),
      item("checkout", { pattern: "checkout-block" }),
      item("purchase", { pattern: "cta-group" }),
      item("purchase-action", {
        parentRef: "purchase",
        qualityRole: "button",
        text: "ادامهٔ خرید",
      }),
    ];

    expect(validateVisualCompositionCoverage(makeContract("home", "خانه"), homeNodes)).toEqual([]);
    expect(validateVisualCompositionCoverage(makeContract("cart", "سبد خرید"), cartNodes)).toEqual(
      [],
    );
  });

  it("reports authorization separately from placeholder coverage", () => {
    expect(
      summarizeVisualAssetCoverage([{ nodeType: "image", assetId: "brand/product-01" }], 1),
    ).toEqual({
      status: "complete",
      requiredSlots: 1,
      authorizedAssets: 1,
      placeholders: 0,
    });
    expect(summarizeVisualAssetCoverage([{ nodeType: "image", placeholder: true }], 1).status).toBe(
      "placeholder-backed",
    );
    expect(summarizeVisualAssetCoverage([], 1).status).toBe("incomplete");
    expect(summarizeVisualAssetCoverage([], 0).status).toBe("not-required");
  });

  it("strips unknown optional contract fields while validating the supported version", () => {
    const contract = createVisualCompositionContract({
      domain: "product",
      role: "other",
      mood: "quiet",
      prompt: "Productivity interface",
      viewport: { width: 390, height: 844 },
      spacingScale: [4, 8, 12],
      requiredPatterns: [],
      assetCoverage: {
        status: "not-required",
        requiredSlots: 0,
        authorizedAssets: 0,
        placeholders: 0,
      },
    });
    const restored = VisualCompositionContractSchema.parse({
      ...contract,
      futureOptionalField: { value: true },
    });

    expect(restored).not.toHaveProperty("futureOptionalField");
    expect(restored.version).toBe(1);
  });
});
