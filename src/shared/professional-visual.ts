import type { DesignPatternId, DesignScreenRole } from "./design-patterns.js";

export const PROFESSIONAL_VISUAL_VERSION = 1 as const;

export function professionalStorefrontRequirements(role: DesignScreenRole):
  | {
      patterns: readonly DesignPatternId[];
      items?: { pattern: DesignPatternId; minimum: number };
      images: number;
      prices: number;
      guidance: string;
    }
  | undefined {
  switch (role) {
    case "home":
      return {
        patterns: ["hero-banner", "category-chips", "product-card"],
        items: { pattern: "product-card", minimum: 4 },
        images: 5,
        prices: 4,
        guidance:
          "Lead with one editorial fashion hero containing artwork, a headline and a campaign CTA. Follow it with categories and four distinct, named and priced products. Use two columns only where names and prices fit at readable sizes. Keep navigation in its assigned section.",
      };
    case "detail":
      return {
        patterns: ["image-gallery", "variant-selector", "cta-group"],
        images: 3,
        prices: 1,
        guidance:
          "Lead with a dominant gallery image and at least two thumbnails in the same gallery. Add product title, toman price, separate labeled size and color choice groups, a useful product description, and an add-to-cart CTA. Let details extend below the fold.",
      };
    case "cart":
      return {
        patterns: ["cart-item", "quantity-control", "price-summary", "checkout-block", "cta-group"],
        items: { pattern: "cart-item", minimum: 2 },
        images: 2,
        prices: 3,
        guidance:
          "Show two distinct items with a thumbnail, name, selected variant, line price and independent quantity controls in each. Group subtotal, delivery, discount and a coherent final total above checkout. Use compact line items and a visually distinct price summary.",
      };
    default:
      return undefined;
  }
}

export const FASHION_ART_PATHS = {
  coat: "M8 2 L12 4 L16 2 L22 6 L24 16 L20 18 L18 11 L19 24 L5 24 L6 11 L4 18 L0 16 L2 6 Z M9 3 L10 11 L12 9 L14 11 L15 3 L12 5 Z",
  coatBack:
    "M8 2 L12 3 L16 2 L22 6 L24 16 L20 18 L18 11 L19 24 L5 24 L6 11 L4 18 L0 16 L2 6 Z M11 5 L13 5 L13 22 L11 22 Z",
  textile:
    "M2 4 L20 2 L22 20 L4 22 Z M5 6 L5 7 L19 5 L19 4 Z M6 10 L6 11 L20 9 L20 8 Z M6 14 L6 15 L20 13 L20 12 Z M7 18 L7 19 L20 17 L20 16 Z",
  trousers: "M5 2 L19 2 L21 24 L15 24 L12 10 L9 24 L3 24 Z M5 5 L19 5 L19 6 L5 6 Z",
  shirt:
    "M8 2 L12 5 L16 2 L23 6 L20 12 L17 10 L17 23 L7 23 L7 10 L4 12 L1 6 Z M9 3 L10 6 L12 7 L14 6 L15 3 L12 5 Z",
  scarf:
    "M5 3 L18 3 L21 8 L19 13 L17 23 L12 23 L14 12 L10 12 L9 23 L4 23 L5 11 L3 7 Z M7 5 L5 8 L7 10 L17 10 L19 8 L17 5 Z",
} as const;

export function fashionArtwork(input: {
  name: string;
  width: number;
  height: number;
  padding: number;
  gap: number;
}) {
  const width = input.width - 2 * input.padding;
  const height = input.height - 2 * input.padding - input.gap - 20;
  if (width < 48 || height < 12) return undefined;
  const name = input.name;
  const iconName: keyof typeof FASHION_ART_PATHS = /نمای پارچه/u.test(name)
    ? "textile"
    : /نمای پشت/u.test(name)
      ? "coatBack"
      : /شلوار|trouser|denim/iu.test(name)
        ? "trousers"
        : /روسری|شال|scarf/iu.test(name)
          ? "scarf"
          : /پیراهن|تیشرت|shirt/iu.test(name)
            ? "shirt"
            : "coat";
  return {
    iconName,
    size: Math.min(150, Math.floor(width * 0.74), height),
    palette: iconName === "coat" || iconName === "scarf" ? ("brand" as const) : ("accent" as const),
  };
}
