import { describe, expect, it } from "vitest";
import {
  createDesignPlan,
  createDesignSectionInstructions,
  createDesignSections,
} from "../src/shared/design-generation";
import { fashionArtwork } from "../src/shared/professional-visual";
import {
  createVisualCompositionContract,
  summarizeVisualAssetCoverage,
  validateVisualCompositionCoverage,
  type VisualCompositionNode,
} from "../src/shared/visual-composition";

const request = {
  prompt:
    "برای فروشگاه پوشاک فارسی ماه‌پوش سه صفحه حرفه‌ای با قیمت تومان و طراحی زرشکی و کرم بساز.",
  target: "mobile",
  screenCount: 3,
  screenNames: ["خانه فروشگاه", "جزئیات محصول", "سبد خرید"],
  language: "fa",
  style: "زرشکی و کرم",
};
type Pattern = NonNullable<VisualCompositionNode["pattern"]>;
function fixture(role: "home" | "detail" | "cart") {
  const nodes: VisualCompositionNode[] = [];
  const add = (logicalRef: string, parts: Partial<VisualCompositionNode>) =>
    nodes.push({
      logicalRef,
      sectionId: "primary",
      nodeType: "frame",
      nativeType: "FRAME",
      qualityRole: "decorative",
      ...parts,
    });
  const text = (parentRef: string, id: string, value: string, heading = false) =>
    add(`${parentRef}-${id}`, {
      parentRef,
      nodeType: "text",
      nativeType: "TEXT",
      text: value,
      qualityRole: heading ? "heading" : "body",
    });
  const image = (parentRef: string, id: string) =>
    add(`${parentRef}-${id}`, {
      parentRef,
      nodeType: "image",
      qualityRole: "image",
      placeholder: true,
    });
  const pattern = (logicalRef: string, value: Pattern, parentRef?: string) =>
    add(logicalRef, { pattern: value, ...(parentRef ? { parentRef } : {}) });
  const button = (parentRef: string, id: string, label: string) => {
    const ref = `${parentRef}-${id}`;
    add(ref, { parentRef, qualityRole: "button" });
    text(ref, "label", label);
  };
  const products = [
    ["مانتوی لینن آبان", "۱٬۲۹۰٬۰۰۰ تومان"],
    ["شال نخی گلبرگ", "۴۹۰٬۰۰۰ تومان"],
    ["شلوار راسته باران", "۸۹۰٬۰۰۰ تومان"],
    ["پیراهن نخی مهتاب", "۹۹۰٬۰۰۰ تومان"],
  ];
  const cards = (cart: boolean) =>
    products.slice(0, cart ? 2 : 4).forEach(([title, price], index) => {
      const ref = `item-${index}`;
      pattern(ref, cart ? "cart-item" : "product-card");
      image(ref, "art");
      text(ref, "title", title!, true);
      text(ref, "price", price!);
      if (cart) {
        text(ref, "variant", index ? "کرم · تک‌سایز" : "زرشکی · M");
        const qty = `${ref}-quantity`;
        pattern(qty, "quantity-control", ref);
        button(qty, "minus", "کاهش");
        text(qty, "value", "۱");
        button(qty, "plus", "افزایش");
      }
    });
  if (role === "home") {
    pattern("hero", "hero-banner");
    image("hero", "coat-art");
    text("hero", "title", "لایه‌های سبک برای روزهای بهاری", true);
    button("hero", "action", "دیدن مجموعه");
    pattern("categories", "category-chips");
    button("categories", "coat", "مانتو");
    button("categories", "scarf", "شال");
    cards(false);
  } else if (role === "detail") {
    pattern("gallery", "image-gallery");
    for (const id of ["main", "front", "fabric"]) image("gallery", id);
    text("gallery", "title", "مانتوی لینن آبان", true);
    text("gallery", "price", "۱٬۲۹۰٬۰۰۰ تومان");
    text("gallery", "description", "لینن سبک با برش آزاد، مناسب هوای گرم.");
    pattern("options", "variant-selector");
    text("options", "sizes", "سایز");
    button("options", "small", "S");
    button("options", "medium", "M");
    text("options", "colors", "رنگ");
    button("options", "cream", "کرم");
    button("options", "berry", "زرشکی");
  } else {
    cards(true);
    pattern("summary", "price-summary");
    text("summary", "subtotal", "جمع جزء ۱٬۷۸۰٬۰۰۰ تومان");
    text("summary", "shipping", "ارسال ۵۰٬۰۰۰ تومان");
    text("summary", "discount", "تخفیف ۸۰٬۰۰۰ تومان");
    text("summary", "total", "مبلغ نهایی ۱٬۷۵۰٬۰۰۰ تومان");
    pattern("checkout", "checkout-block");
  }
  pattern("cta", "cta-group", role === "cart" ? "checkout" : undefined);
  button(
    "cta",
    "action",
    { home: "خرید مجموعه", detail: "افزودن به سبد", cart: "ادامه خرید" }[role],
  );
  return nodes;
}

describe("Phase 14 Persian fashion composition", () => {
  it.each(["home", "detail", "cart"] as const)(
    "accepts substantial %s content and flags missing imagery",
    (role) => {
      const nodes = fixture(role);
      const contract = createVisualCompositionContract({
        domain: "commerce",
        role,
        professionalVisualVersion: 1,
        sectionId: "primary",
        locale: "fa",
        prompt: request.prompt,
        mood: request.style,
        viewport: { width: 390, height: 844 },
        spacingScale: [4, 8, 16],
        requiredPatterns: [],
        assetCoverage: summarizeVisualAssetCoverage(nodes, 0),
      });
      expect(validateVisualCompositionCoverage(contract, nodes)).toEqual([]);
      expect(
        validateVisualCompositionCoverage(
          contract,
          nodes.filter(({ nodeType }) => nodeType !== "image"),
        ),
      ).toEqual(expect.arrayContaining([expect.stringContaining("image_slots_below_minimum")]));
      if (role === "cart") {
        expect(
          validateVisualCompositionCoverage(
            contract,
            nodes.filter(({ pattern }) => pattern !== "quantity-control"),
          ),
        ).toEqual(expect.arrayContaining([expect.stringContaining("cart_item_quantity_missing")]));
      }
    },
  );

  it("preserves plan identities and supports additional roles", () => {
    const legacy = createDesignPlan(request);
    const current = createDesignPlan({ ...request, professionalVisualVersion: 1 });
    if (!legacy.success || !current.success) throw new Error(JSON.stringify({ current, legacy }));
    expect(legacy.data.brief.professionalVisualVersion).toBeUndefined();
    expect(current.data.brief.professionalVisualVersion).toBe(1);
    expect(current.data.screens.map(({ id }) => id)).toEqual(
      legacy.data.screens.map(({ id }) => id),
    );
    const sections = createDesignSections(current.data);
    const primary = sections.find(({ id }) => id === "primary")!;
    expect(
      createDesignSectionInstructions(current.data, current.data.screens[0]!, primary),
    ).toContain("four distinct");
    const extra = [
      "جست‌وجو",
      "فهرست محصولات",
      "نشان‌شده‌ها",
      "حساب کاربری",
      "تسویه حساب",
      "سفارش‌ها",
      "راهنما",
    ];
    const ten = createDesignPlan({
      ...request,
      professionalVisualVersion: 1,
      screenCount: 10,
      screenNames: [...request.screenNames, ...extra],
    });
    expect(ten.success && new Set(ten.data.screens.map(({ id }) => id)).size).toBe(10);
  });

  it("budgets artwork inside the image slot with room for editable disclosure", () => {
    expect(
      fashionArtwork({ name: "شلوار راسته", width: 150, height: 128, padding: 8, gap: 8 }),
    ).toEqual({ iconName: "trousers", size: 84, palette: "accent" });
    expect(
      fashionArtwork({ name: "شال", width: 44, height: 44, padding: 8, gap: 8 }),
    ).toBeUndefined();
  });
});
