import type {
  DesignPlan,
  DesignSection,
  GeneratedDesign,
  GeneratedDesignNode,
} from "./design-generation.js";

import { commerceRolePatterns, type DesignScreenRole } from "./design-patterns.js";

export function storefrontPatterns(role: DesignScreenRole) {
  return [...new Set([...commerceRolePatterns(role), "navigation" as const])];
}

type Product = {
  id: string;
  name: string;
  price: number;
  color: string;
  size: string;
  description: string;
};

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function formatPersianInteger(value: number): string {
  if (!Number.isSafeInteger(value)) throw new RangeError("Expected a safe integer.");
  const sign = value < 0 ? "\u200e−" : "";
  const grouped = Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, "٬");
  return `${sign}${grouped}`.replace(/[0-9]/gu, (digit) => PERSIAN_DIGITS[Number(digit)]!);
}

// Sample merchandise only. A shared catalog keeps prices and variants consistent across views.
const catalog: readonly Product[] = [
  {
    id: "aban",
    name: "مانتوی لینن آبان",
    price: 1_290_000,
    color: "زرشکی",
    size: "M",
    description:
      "لینن تنفس‌پذیر با برش آزاد، دو جیب و دکمه‌های مات. سبک و مناسب لایه‌پوشی در روزهای گرم.",
  },
  {
    id: "golbarg",
    name: "شال نخی گلبرگ",
    price: 490_000,
    color: "کرم",
    size: "آزاد",
    description: "شال نخی سبک با بافت نرم و لبهٔ دوخته.",
  },
  {
    id: "baran",
    name: "شلوار راسته باران",
    price: 890_000,
    color: "خاکی",
    size: "M",
    description: "فیت راسته با دو جیب جانبی.",
  },
  {
    id: "mahtab",
    name: "پیراهن نخی مهتاب",
    price: 990_000,
    color: "شیری",
    size: "L",
    description: "پیراهن نخی روزمره با یقه کلاسیک.",
  },
];

export function calculateTomanCart(
  lines: readonly { unitPrice: number; quantity: number }[],
  shipping: number,
  discount: number,
) {
  const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (!whole(shipping) || !whole(discount)) throw new RangeError("Invalid toman adjustment.");
  const lineTotals = lines.map(({ unitPrice, quantity }) => {
    const amount = unitPrice * quantity;
    if (!whole(unitPrice) || !whole(quantity) || quantity < 1 || !whole(amount))
      throw new RangeError("Invalid cart product price or quantity.");
    return amount;
  });
  const subtotal = lineTotals.reduce((sum, amount) => sum + amount, 0);
  if (!whole(subtotal) || !whole(subtotal + shipping) || discount > subtotal)
    throw new RangeError("Invalid cart subtotal or discount.");
  return { lineTotals, subtotal, shipping, discount, total: subtotal + shipping - discount };
}

const toman = (value: number) => `${formatPersianInteger(value)} تومان`;
type Node = GeneratedDesignNode;
const node = (fields: Partial<Node> & Pick<Node, "type" | "name" | "width" | "height">): Node => ({
  text: null,
  palette: "none",
  fontSize: 14,
  fontStyle: "Regular",
  textAlign: "right",
  cornerRadius: 0,
  elevation: "none",
  layout: "none",
  gap: 0,
  padding: 0,
  qualityRole: "decorative",
  children: [],
  ...fields,
});

const text = (
  copy: string,
  width: number,
  size = 14,
  heading = false,
  palette: Node["palette"] = "text",
  lines = 1,
) =>
  node({
    type: "text",
    name: copy,
    text: copy,
    width,
    height: (size + 10) * lines,
    fontSize: size,
    fontFamily: "Noto Sans Arabic",
    lineHeight: size + 6,
    fontStyle: heading ? "Bold" : "Regular",
    qualityRole: heading ? "heading" : "body",
    palette,
  });

function stack(name: string, width: number, children: Node[], options: Partial<Node> = {}) {
  const resolved = { gap: 12, padding: 0, ...options };
  return node({
    type: "frame",
    name,
    width,
    layout: "vertical",
    children,
    height:
      children.reduce((height, item) => height + item.height, 0) +
      Math.max(0, children.length - 1) * resolved.gap +
      2 * resolved.padding,
    ...resolved,
  });
}

function row(name: string, width: number, rtlChildren: Node[], options: Partial<Node> = {}) {
  return node({
    type: "frame",
    name,
    width,
    layout: "horizontal",
    gap: 8,
    children: [...rtlChildren].reverse(),
    height: Math.max(...rtlChildren.map(({ height }) => height)) + 2 * (options.padding ?? 0),
    ...options,
  });
}

const surface = { palette: "surface", cornerRadius: 16 } as const;

function button(
  label: string,
  width: number,
  primary = false,
  qualityRole: "button" | "input" = "button",
) {
  const copy = text(label, width, 14, false, primary ? "surface" : "text");
  copy.textAlign = "center";
  return stack(label, width, [copy], {
    height: 48,
    qualityRole,
    palette: primary ? "brand" : "surface",
    cornerRadius: 12,
    ...(primary ? {} : { strokePalette: "border" as const }),
  });
}

const artwork = (name: string, width: number, height: number) =>
  node({
    type: "image",
    name,
    width,
    height,
    palette: "page",
    cornerRadius: 12,
    qualityRole: "image",
    placeholder: true,
  });

function pair(label: string, value: string, width: number, heading = false) {
  const left = Math.floor(width * 0.56);
  return row(label, width, [
    text(label, width - left - 8, heading ? 15 : 13, heading),
    text(value, left, heading ? 16 : 14, heading),
  ]);
}

function home(width: number) {
  const inner = width - 24;
  const grid = width >= 336;
  const tileWidth = grid ? Math.floor((width - 8) / 2) : width;
  const tiles = catalog.map((product) =>
    stack(
      product.name,
      tileWidth,
      [
        artwork(product.name, tileWidth - 16, 106),
        text(product.name, tileWidth - 16, 14, true, "text", 2),
        text(toman(product.price), tileWidth - 16, 13, false, "muted"),
      ],
      { ...surface, padding: 8, gap: 4, strokePalette: "border", pattern: "product-card" },
    ),
  );
  const categories = ["مانتو", "شال", "شلوار", "پیراهن"].map((name) =>
    button(name, Math.floor((width - 24) / 4)),
  );
  const promo = stack("مشاهده مجموعه", inner, [button("دیدن مجموعه بهار", inner, true)], {
    pattern: "cta-group",
  });
  return [
    stack(
      "داستان فصل",
      width,
      [
        text("مجموعه بهار · ۰۱", inner, 13, false, "muted"),
        text("لایه‌های سبک، روزهای روشن", inner, 25, true, "text", 2),
        artwork("مانتوی لینن · طرح مجموعه بهار", inner, 171),
        promo,
      ],
      { ...surface, padding: 12, gap: 8, pattern: "hero-banner" },
    ),
    row("دسته‌بندی‌ها", width, categories, { pattern: "category-chips" }),
    text("منتخب‌های این هفته", width, 20, true),
    ...(grid
      ? [
          row("منتخب‌ها · ردیف اول", width, tiles.slice(0, 2)),
          row("منتخب‌ها · ردیف دوم", width, tiles.slice(2)),
        ]
      : tiles),
  ];
}

function detail(width: number) {
  const product = catalog[0]!;
  const thumb = Math.floor((width - 16) / 3);
  const option = Math.floor((width - 16) / 3);
  const available = "در انبار · آماده ارسال";
  return [
    stack(
      "گالری محصول",
      width,
      [
        artwork(product.name, width, 276),
        row("نماهای محصول", width, [
          artwork(`${product.name} · نمای روبه‌رو`, thumb, 78),
          artwork(`${product.name} · نمای پشت`, thumb, 78),
          artwork(`${product.name} · نمای پارچه`, thumb, 78),
        ]),
      ],
      { pattern: "image-gallery" },
    ),
    text("مجموعه لینن ماه‌پوش", width, 13, false, "muted"),
    text(product.name, width, 26, true),
    pair("قیمت", toman(product.price), width, true),
    stack(
      "انتخاب رنگ و سایز",
      width,
      [
        text("رنگ", width, 14, true),
        row("رنگ‌ها", width, [
          button(product.color, option, true),
          button("کرم", option),
          button("خاکی", option),
        ]),
        text("سایز", width, 14, true),
        row("سایزها", width, [
          button("S", option),
          button(product.size, option, true),
          button("L", option),
        ]),
      ],
      { gap: 8, pattern: "variant-selector" },
    ),
    text(available, width, 13, false, "muted"),
    stack("افزودن به سبد", width, [button("افزودن به سبد خرید", width, true)], {
      pattern: "cta-group",
    }),
    stack(
      "درباره محصول",
      width,
      [
        text("درباره محصول", width - 24, 17, true),
        text(product.description, width - 24, 15, false, "text", 4),
        text("شست‌وشوی ملایم با آب سرد", width - 24, 13, false, "muted"),
      ],
      { ...surface, padding: 12, gap: 8 },
    ),
  ];
}

function cart(width: number) {
  const lines = catalog
    .slice(0, 2)
    .map((product, index) => ({ product, unitPrice: product.price, quantity: index + 1 }));
  const balance = calculateTomanCart(lines, 50_000, 80_000);
  const inner = width - 24;
  const cards = lines.map(({ product, quantity }, index) => {
    const infoWidth = inner - 80;
    return stack(
      product.name,
      width,
      [
        row("مشخصات قلم", inner, [
          artwork(product.name, 72, 84),
          stack(
            product.name,
            infoWidth,
            [
              text(product.name, infoWidth, 15, true),
              text(`${product.color} · ${product.size}`, infoWidth, 13, false, "muted"),
              text(toman(product.price), infoWidth, 13),
            ],
            { gap: 4 },
          ),
        ]),
        row("تعداد و مبلغ قلم", inner, [
          row(
            "کنترل تعداد",
            148,
            [button("+", 44), text(formatPersianInteger(quantity), 44), button("−", 44)],
            { pattern: "quantity-control" },
          ),
          text(toman(balance.lineTotals[index]!), inner - 156, 13, true),
        ]),
      ],
      { ...surface, padding: 12, gap: 8, pattern: "cart-item" },
    );
  });
  return [
    ...cards,
    stack("کد تخفیف", width, [button("کد تخفیف را وارد کنید", width, false, "input")]),
    stack(
      "خلاصه سفارش",
      width,
      [
        text("خلاصه سفارش", inner, 18, true),
        pair("جمع اقلام", toman(balance.subtotal), inner),
        pair("ارسال", toman(balance.shipping), inner),
        pair("تخفیف", `−${toman(balance.discount)}`, inner),
        pair("مبلغ نهایی", toman(balance.total), inner, true),
      ],
      { ...surface, padding: 12, gap: 8, pattern: "price-summary" },
    ),
    stack(
      "ادامه سفارش",
      width,
      [
        stack("ادامه خرید", width, [button("ادامه و انتخاب ارسال", width, true)], {
          pattern: "cta-group",
        }),
      ],
      { pattern: "checkout-block" },
    ),
  ];
}

export function isSampleStorefront(plan: DesignPlan): boolean {
  const originalBrief = plan.request.prompt.split("\n\nShared design direction:", 1)[0] ?? "";
  return (
    Boolean(plan.brief.professionalVisualVersion) &&
    /ماه[‌\s-]*پوش/u.test(originalBrief) &&
    /زرشکی/u.test(originalBrief) &&
    /کرم/u.test(originalBrief) &&
    !/#[0-9a-f]{6}\b|کاتالوگ پیوست|عکس پیوست/u.test(originalBrief) &&
    !/[0-9۰-۹٠-٩][0-9۰-۹٠-٩٬,]*\s*(?:تومان|ریال)/u.test(originalBrief) &&
    plan.screens.length === 3 &&
    plan.screens.every(
      ({ screenRole }) =>
        plan.designSkills?.every(({ requiredPatterns }) =>
          requiredPatterns.every((pattern) => storefrontPatterns(screenRole).includes(pattern)),
        ) ?? true,
    ) &&
    ["home", "detail", "cart"].every((role) =>
      plan.screens.some(({ screenRole }) => screenRole === role),
    )
  );
}

export function composeStorefrontSection(
  plan: DesignPlan,
  section: DesignSection["id"],
): GeneratedDesign {
  const screen = plan.screens[0]!;
  const width = screen.width - 40;
  const role = screen.screenRole;
  const name = plan.brandKit?.name ?? "ماه‌پوش";
  let children: Node[];
  if (section === "identity") {
    const caption = { home: name, detail: "جزئیات محصول", cart: "سبد خرید" }[
      role as "home" | "detail" | "cart"
    ];
    children = [
      row(
        caption,
        width,
        [text(caption, width - 64, 22, true), button(role === "home" ? "سبد" : "بازگشت", 56)],
        { pattern: "app-bar" },
      ),
    ];
    children.push(
      row(
        "مسیر فروشگاه",
        width,
        ["خانه", "محصولات", "سبد"].map((label, index) =>
          button(
            label,
            Math.floor((width - 16) / 3),
            (role === "home" ? 0 : role === "detail" ? 1 : 2) === index,
          ),
        ),
        { pattern: "navigation" },
      ),
    );
    if (role === "home")
      children.push({
        ...button("جست‌وجوی مدل، رنگ یا جنس", width, false, "input"),
        pattern: "search",
      });
  } else if (section === "primary") {
    children = role === "home" ? home(width) : role === "detail" ? detail(width) : cart(width);
  } else {
    const labels = role === "home" ? ["خانه", "دسته‌ها", "سبد", "حساب"] : [];
    children = [
      stack(
        "ارسال و بازگشت",
        width,
        [
          text("ارسال ۲ تا ۴ روز کاری", width - 24, 14, true),
          text("امکان بازگشت تا ۷ روز پس از تحویل", width - 24, 13, false, "muted"),
        ],
        { ...surface, padding: 12, gap: 4, pattern: "trust-row" },
      ),
      ...(labels.length
        ? [
            row(
              "ناوبری فروشگاه",
              width,
              labels.map((label, index) =>
                button(label, Math.floor((width - 24) / 4), index === 0),
              ),
              { pattern: "footer" },
            ),
          ]
        : []),
    ];
  }
  return {
    projectName: name,
    palette: {
      brand: "#742943",
      accent: "#B26B52",
      page: "#F6EDE1",
      surface: "#FFFCF7",
      text: "#2A1920",
      muted: "#684E53",
      border: "#D8BDB8",
    },
    screens: [
      { id: screen.id, children: [stack(section, width, children, { sectionId: section })] },
    ],
  };
}
