import { readFileSync, writeFileSync } from "node:fs";

const phase4 = JSON.parse(
  readFileSync(new URL("../src/samples/phase-4-multi-screen.json", import.meta.url), "utf8"),
);
const ref = (token) => ({ token });
const colorValue = (value) =>
  typeof value === "string" && value.startsWith("#") ? value : ref(value);
const text = (name, value, type, color, extra = {}) => ({
  type: "text",
  name,
  text: value,
  textStyle: ref(`typography.${type}`),
  color: typeof color === "string" && color.startsWith("#") ? color : ref(color),
  ...extra,
});
const frame = (name, width, height, children = [], extra = {}) => ({
  type: "frame",
  name,
  width,
  height,
  children,
  ...extra,
});
const rect = (name, x, y, width, height, fill, extra = {}) => ({
  type: "rectangle",
  name,
  ...(x === undefined ? {} : { x }),
  ...(y === undefined ? {} : { y }),
  width,
  height,
  fill: typeof fill === "string" && fill.startsWith("#") ? fill : ref(fill),
  ...extra,
});
const ellipse = (name, x, y, width, height, fill, extra = {}) => ({
  type: "ellipse",
  name,
  x,
  y,
  width,
  height,
  fill: typeof fill === "string" && fill.startsWith("#") ? fill : ref(fill),
  ...extra,
});
const vector = (name, x, y, width, height, pathData, fill, extra = {}) => ({
  type: "vector",
  name,
  x,
  y,
  width,
  height,
  pathData,
  fill: typeof fill === "string" && fill.startsWith("#") ? fill : ref(fill),
  ...extra,
});
const vectorFlow = (name, width, height, pathData, fill, extra = {}) => ({
  type: "vector",
  name,
  width,
  height,
  pathData,
  fill: typeof fill === "string" && fill.startsWith("#") ? fill : ref(fill),
  ...extra,
});
const instance = (componentId, name, extra = {}) => ({
  type: "instance",
  componentId,
  name,
  ...extra,
});
const shadow = (opacity = 0.12, y = 8, radius = 24) => ({
  effects: [
    { type: "drop-shadow", color: "#123B5D", opacity, offsetX: 0, offsetY: y, radius, spread: 0 },
  ],
});
const gradient = (first, second, angle = -24) => ({
  fills: [
    {
      type: "linear",
      angle,
      stops: [
        { position: 0, color: colorValue(first) },
        { position: 1, color: colorValue(second) },
      ],
    },
  ],
});
const auto = (mode = "vertical", gap = 12, padding = 0) => ({
  mode,
  gap,
  padding: { top: padding, right: padding, bottom: padding, left: padding },
  primaryAxisAlign: "start",
  counterAxisAlign: mode === "horizontal" ? "center" : "stretch",
});
const root = (id, name, order, children, height = 900) => ({
  id,
  name,
  group: "خرید پوشاک",
  order,
  devicePreset: "mobile",
  width: 390,
  height,
  background: ref("color.page.background"),
  layout: auto("vertical", 12, 24),
  children,
});
const header = (title, eyebrow = "") =>
  frame(
    "Header",
    342,
    48,
    [
      text("Screen title", title, "heading", "color.text.primary", {
        textAlign: "right",
        sizing: { width: "fill", height: "hug" },
      }),
      vectorFlow("Navigation chevron", 20, 20, "M 14 4 L 6 10 L 14 16 Z", "color.brand.deepNavy"),
    ],
    { layout: auto("horizontal", 8, 0), ...(eyebrow ? { name: `${title} — ${eyebrow}` } : {}) },
  );
const searchInstance = () =>
  instance("search-field", "Search field", { sizing: { width: "fill", height: "fixed" } });
const primaryButton = (name = "Primary action") =>
  instance("button.primary", name, { sizing: { width: "fill", height: "fixed" } });
const productCard = (name = "Product card instance") =>
  instance("product-card.basic", name, { sizing: { width: "fill", height: "fixed" } });
const chipShelf = () =>
  frame(
    "RTL category shelf",
    342,
    42,
    [
      instance("category-chip", "همه", { x: 248, y: 2 }),
      instance("category-chip", "مانتو", { x: 158, y: 2 }),
      instance("category-chip", "کیف", { x: 68, y: 2 }),
    ],
    { qualityRole: "decorative" },
  );

function illustration(name, width, height, tone = "color.surface.pale", variant = "coat") {
  const clothing =
    variant === "shirt"
      ? "M 40 28 L 64 16 L 80 30 L 96 16 L 120 28 L 108 56 L 98 48 L 98 126 L 62 126 L 62 48 L 52 56 Z"
      : variant === "bag"
        ? "M 40 48 L 104 48 L 98 120 L 46 120 Z M 54 48 C 54 12 90 12 90 48"
        : "M 48 18 L 92 18 L 118 48 L 106 62 L 98 54 L 98 150 L 42 150 L 42 54 L 34 62 L 22 48 Z";
  const bodyW = variant === "coat" ? 140 : 120;
  const bodyH = variant === "coat" ? 166 : 142;
  return frame(
    name,
    width,
    height,
    [
      ellipse("Soft halo", width - 138, 18, 102, 102, "color.action.highlight", {
        visual: { opacity: 0.2 },
      }),
      ellipse("Editorial circle", 22, height - 74, 68, 68, "color.brand.deepNavy", {
        visual: { opacity: 0.08 },
      }),
      vector(
        "Garment illustration — editable path",
        (width - bodyW) / 2,
        (height - bodyH) / 2 - 2,
        bodyW,
        bodyH,
        clothing,
        "color.action.primary",
        {
          visual: {
            effects: [
              {
                type: "drop-shadow",
                color: "#123B5D",
                opacity: 0.18,
                offsetX: 2,
                offsetY: 7,
                radius: 12,
                spread: 0,
              },
            ],
          },
        },
      ),
      rect("Garment seam", width / 2 - 1, height / 2 - 6, 2, Math.min(56, height / 3), "#FFFFFF", {
        visual: { opacity: 0.68 },
      }),
      text("Editorial illustration label", "تصویرسازی برداری", "caption", "color.brand.deepNavy", {
        x: 16,
        y: height - 32,
        width: 112,
        height: 18,
        textAlign: "right",
      }),
    ],
    {
      visual: { ...gradient("color.surface.pale", tone, -28), clipsContent: true },
      cornerRadius: 18,
    },
  );
}

const designSystem = JSON.parse(JSON.stringify(phase4.designSystem));
designSystem.typography = {
  "typography.display": {
    fontFamily: "Arial",
    fontStyle: "Bold",
    fontSize: 32,
    lineHeight: 40,
    textAlign: "right",
  },
  "typography.heading": {
    fontFamily: "Arial",
    fontStyle: "Bold",
    fontSize: 24,
    lineHeight: 32,
    textAlign: "right",
  },
  "typography.section": {
    fontFamily: "Arial",
    fontStyle: "Bold",
    fontSize: 18,
    lineHeight: 26,
    textAlign: "right",
  },
  "typography.body": {
    fontFamily: "Arial",
    fontStyle: "Regular",
    fontSize: 14,
    lineHeight: 22,
    textAlign: "right",
  },
  "typography.caption": {
    fontFamily: "Arial",
    fontStyle: "Regular",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "right",
  },
  "typography.price": {
    fontFamily: "Arial",
    fontStyle: "Bold",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "right",
  },
  "typography.button": {
    fontFamily: "Arial",
    fontStyle: "Bold",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
};

const components = [
  {
    type: "component",
    id: "button.primary",
    key: "button.primary",
    variant: { state: "primary" },
    name: "Button — Primary",
    width: 342,
    height: 48,
    background: ref("color.action.primary"),
    cornerRadius: 12,
    visual: {
      ...gradient("color.brand.deepNavy", "color.action.primary", -18),
      ...shadow(0.14, 6, 16),
    },
    layout: {
      ...auto("horizontal", 8, 12),
      primaryAxisAlign: "center",
      counterAxisAlign: "center",
    },
    children: [text("Button label", "ادامه خرید", "button", "#FFFFFF", { textAlign: "center" })],
  },
  {
    type: "component",
    id: "button.secondary",
    key: "button.secondary",
    variant: { state: "secondary" },
    name: "Button — Secondary",
    width: 342,
    height: 48,
    background: ref("color.surface.pale"),
    stroke: ref("border.default"),
    cornerRadius: 12,
    layout: {
      ...auto("horizontal", 8, 12),
      primaryAxisAlign: "center",
      counterAxisAlign: "center",
    },
    children: [
      text("Button label", "مشاهده جزئیات", "button", "color.brand.deepNavy", {
        textAlign: "center",
      }),
    ],
  },
  {
    type: "component",
    id: "button.disabled",
    key: "button.disabled",
    variant: { state: "disabled" },
    name: "Button — Disabled",
    width: 342,
    height: 48,
    background: ref("color.border.default"),
    cornerRadius: 12,
    layout: {
      ...auto("horizontal", 8, 12),
      primaryAxisAlign: "center",
      counterAxisAlign: "center",
    },
    children: [
      text("Button label", "ناموجود", "button", "color.text.muted", { textAlign: "center" }),
    ],
  },
  {
    type: "component",
    id: "search-field",
    key: "search-field",
    name: "Search Field",
    width: 342,
    height: 50,
    background: "#FFFFFF",
    stroke: ref("border.default"),
    cornerRadius: 14,
    layout: {
      ...auto("horizontal", 10, 12),
      primaryAxisAlign: "start",
      counterAxisAlign: "center",
    },
    children: [
      text("Search placeholder", "جست‌وجوی محصول…", "body", "color.text.muted", {
        sizing: { width: "fill", height: "hug" },
      }),
      vectorFlow(
        "Search icon",
        20,
        20,
        "M 8 2 C 4 2 2 4 2 8 C 2 12 4 14 8 14 C 12 14 14 12 14 8 C 14 4 12 2 8 2 M 13 13 L 19 19",
        "color.brand.deepNavy",
      ),
    ],
  },
  {
    type: "component",
    id: "category-chip",
    key: "category-chip",
    name: "Category Chip",
    width: 82,
    height: 38,
    background: ref("color.surface.pale"),
    cornerRadius: 19,
    layout: { ...auto("horizontal", 4, 8), primaryAxisAlign: "center", counterAxisAlign: "center" },
    children: [
      text("Category label", "مانتو", "caption", "color.brand.deepNavy", { textAlign: "center" }),
    ],
  },
  {
    type: "component",
    id: "product-card.basic",
    key: "product-card.basic",
    name: "Product Card — Vector Editorial",
    width: 342,
    height: 354,
    background: "#FFFFFF",
    stroke: ref("border.default"),
    cornerRadius: 18,
    visual: shadow(0.09, 5, 18),
    layout: { ...auto("vertical", 8, 12), primaryAxisAlign: "start", counterAxisAlign: "stretch" },
    children: [
      illustration("Editorial vector artwork", 318, 168, "color.surface.pale", "coat"),
      text("Product title", "مانتو لینن آبی", "body", "color.text.primary"),
      frame(
        "Product price row",
        318,
        24,
        [
          text("Product price", "۱٬۲۹۰٬۰۰۰ تومان", "price", "color.brand.deepNavy", {
            textAlign: "right",
            sizing: { width: "fill", height: "hug" },
          }),
          text("Product discount", "٪۲۰ تخفیف", "caption", "color.status.error", {
            textAlign: "left",
          }),
        ],
        { layout: auto("horizontal", 6, 0) },
      ),
      instance("button.primary", "Quick add instance", {
        sizing: { width: "fill", height: "fixed" },
      }),
    ],
  },
];
designSystem.components = components;

const inputField = (title, value, state = "default") =>
  frame(
    `${title} field`,
    342,
    54,
    [
      text("Field label", title, "caption", "color.text.muted"),
      text("Field value", value, "body", "color.text.primary"),
    ],
    {
      background: "#FFFFFF",
      stroke: state === "error" ? ref("border.error") : ref("border.default"),
      cornerRadius: 12,
      visual:
        state === "focus"
          ? { strokes: [{ color: ref("color.action.primary"), width: 1.5, align: "inside" }] }
          : undefined,
      layout: auto("vertical", 2, 10),
    },
  );
const bottomNav = (active) =>
  frame(
    "Bottom navigation — RTL order",
    342,
    48,
    [
      text(
        "خانه",
        active === "home" ? "⌂\nخانه" : "⌂\nخانه",
        "caption",
        active === "home" ? "color.action.primary" : "color.text.muted",
        { textAlign: "center" },
      ),
      text(
        "دسته‌ها",
        "◫\nدسته‌ها",
        "caption",
        active === "categories" ? "color.action.primary" : "color.text.muted",
        { textAlign: "center" },
      ),
      text(
        "علاقه‌مندی",
        "♡\nعلاقه‌مندی",
        "caption",
        active === "favorites" ? "color.action.primary" : "color.text.muted",
        { textAlign: "center" },
      ),
      text(
        "سبد خرید",
        "▱\nسبد خرید",
        "caption",
        active === "cart" ? "color.action.primary" : "color.text.muted",
        { textAlign: "center" },
      ),
    ],
    {
      layout: {
        ...auto("horizontal", 4, 4),
        primaryAxisAlign: "space-between",
        counterAxisAlign: "center",
      },
      background: "#FFFFFF",
      cornerRadius: 12,
      visual: { ...shadow(0.06, -2, 12) },
    },
  );
const promoHero = (title, subtitle, label = "پیشنهاد محدود") =>
  frame(
    "Promotional hero — layered editable art",
    342,
    188,
    [
      ellipse("Sky motif", 232, -24, 128, 128, "color.action.highlight", {
        constraints: { horizontal: "right", vertical: "top" },
        visual: { opacity: 0.28 },
      }),
      vector(
        "Abstract garment form",
        224,
        24,
        90,
        128,
        "M 28 8 L 58 8 L 76 28 L 68 40 L 60 34 L 60 112 L 26 112 L 26 34 L 18 40 L 10 28 Z",
        "#FFFFFF",
        {
          visual: {
            opacity: 0.92,
            effects: [
              {
                type: "drop-shadow",
                color: "#0F172A",
                opacity: 0.12,
                offsetX: 0,
                offsetY: 5,
                radius: 10,
                spread: 0,
              },
            ],
          },
        },
      ),
      text("Promo badge", label, "caption", "#FFFFFF", { x: 18, y: 18, width: 146, height: 20 }),
      text("Promo title", title, "heading", "#FFFFFF", { x: 18, y: 52, width: 190, height: 36 }),
      text("Promo subtitle", subtitle, "body", "#FFFFFF", { x: 18, y: 94, width: 184, height: 46 }),
    ],
    {
      visual: {
        ...gradient("color.brand.deepNavy", "color.action.primary", -16),
        clipsContent: true,
        ...shadow(0.16, 9, 24),
      },
      cornerRadius: 20,
    },
  );
const miniProduct = (title, price, variant = "shirt") =>
  frame(
    `Product row — ${title}`,
    342,
    108,
    [
      illustration("Editable vector product thumb", 86, 84, "color.surface.pale", variant),
      frame(
        "Product metadata",
        236,
        84,
        [
          text("Product title", title, "body", "color.text.primary"),
          text("Product price", price, "price", "color.brand.deepNavy"),
          text("Product note", "ارسال رایگان · موجود", "caption", "color.status.success"),
        ],
        { layout: auto("vertical", 2, 0) },
      ),
    ],
    {
      layout: auto("horizontal", 12, 10),
      background: "#FFFFFF",
      stroke: ref("border.default"),
      cornerRadius: 14,
    },
  );
const rtlChips = () =>
  frame(
    "RTL filter controls",
    342,
    40,
    [
      instance("category-chip", "فیلترها", { x: 248, y: 1 }),
      instance("category-chip", "قیمت", { x: 158, y: 1 }),
      instance("category-chip", "رنگ", { x: 68, y: 1 }),
    ],
    {},
  );

const screens = [
  root(
    "welcome",
    "شروع تازه",
    10,
    [
      frame(
        "Editorial cover — Welcome",
        342,
        316,
        [
          ellipse("Navy halo", 8, 26, 286, 286, "color.brand.deepNavy", {
            visual: { opacity: 0.08 },
          }),
          {
            ...illustration("Vector fashion cover", 258, 250, "color.action.highlight", "coat"),
            x: 42,
            y: 40,
          },
          text("Collection marker", "NEW SEASON  /  ۱۴۰۵", "caption", "color.brand.deepNavy", {
            x: 16,
            y: 16,
            width: 210,
            height: 18,
          }),
        ],
        {
          visual: {
            fills: [
              {
                type: "radial",
                stops: [
                  { position: 0, color: "#FFFFFF" },
                  { position: 1, color: "#DBEEFF" },
                ],
              },
            ],
            clipsContent: true,
            ...shadow(0.08, 5, 16),
          },
          cornerRadius: 24,
        },
      ),
      text("Welcome eyebrow", "مجموعهٔ فصل تازه", "caption", "color.action.primary"),
      text("Welcome title", "انتخابی برای\nهر روزِ تو", "display", "color.brand.deepNavy"),
      text(
        "Welcome copy",
        "لباس‌های خوش‌دوخت، رنگ‌های آرام و جزئیاتی که در استفادهٔ روزمره می‌درخشند.",
        "body",
        "color.text.muted",
      ),
      primaryButton("Begin browsing instance"),
      text("Welcome progress", "●  ○  ○", "caption", "color.action.primary", {
        textAlign: "center",
      }),
    ],
    844,
  ),
  root(
    "sign-in",
    "ورود به حساب",
    20,
    [
      header("خوش برگشتی"),
      text("Sign in eyebrow", "حساب کاربری", "caption", "color.action.primary"),
      text("Sign in heading", "ورود به حساب", "heading", "color.text.primary"),
      text(
        "Sign in description",
        "برای دیدن سفارش‌ها و فهرست علاقه‌مندی‌ها وارد شو.",
        "body",
        "color.text.muted",
      ),
      inputField("شمارهٔ همراه", "۰۹۱۲ ۳۴۵ ۶۷۸۹", "focus"),
      inputField("رمز عبور", "••••••••••"),
      text("Forgot password", "رمز عبور را فراموش کرده‌ام", "caption", "color.action.primary"),
      primaryButton("Sign in instance"),
      text("Sign in divider", "یا با شمارهٔ همراه ادامه بده", "caption", "color.text.muted", {
        textAlign: "center",
      }),
      instance("button.secondary", "Continue as guest instance", {
        sizing: { width: "fill", height: "fixed" },
      }),
      text("Sign up prompt", "حساب نداری؟ ثبت‌نام", "body", "color.brand.deepNavy", {
        textAlign: "center",
      }),
    ],
    844,
  ),
  root(
    "home",
    "خانه",
    30,
    [
      header("فروشگاه", "خانه"),
      searchInstance(),
      promoHero("بهارِ سبک‌تر", "تا ۳۰٪ تخفیف روی انتخاب‌های تازه"),
      frame(
        "Category section heading",
        342,
        28,
        [
          text("Categories title", "دسته‌بندی‌ها", "section", "color.text.primary", {
            sizing: { width: "fill", height: "hug" },
          }),
          text("See all categories", "مشاهدهٔ همه", "caption", "color.action.primary"),
        ],
        { layout: auto("horizontal", 4, 0) },
      ),
      chipShelf(),
      frame(
        "Featured product heading",
        342,
        28,
        [
          text("Featured title", "پیشنهاد امروز", "section", "color.text.primary", {
            sizing: { width: "fill", height: "hug" },
          }),
          text("Discount label", "۲۰٪ کمتر", "caption", "color.status.error"),
        ],
        { layout: auto("horizontal", 4, 0) },
      ),
      productCard("Featured Product Card instance"),
      bottomNav("home"),
    ],
    1_040,
  ),
  root(
    "categories",
    "دسته‌بندی",
    40,
    [
      header("دسته‌بندی‌ها"),
      text("Categories intro", "برای استایل امروزت انتخاب کن", "body", "color.text.muted"),
      chipShelf(),
      promoHero("پارچه‌های طبیعی", "کتان و لینن برای روزهای روشن"),
      frame(
        "Category tiles",
        342,
        196,
        [
          frame(
            "Tunic category",
            164,
            184,
            [
              illustration("Tunic editorial art", 140, 126, "#EFF6FF", "coat"),
              text("Category label", "مانتو و رویه", "body", "color.text.primary", {
                textAlign: "center",
              }),
            ],
            {
              layout: auto("vertical", 8, 10),
              background: "#FFFFFF",
              cornerRadius: 16,
              visual: { ...shadow(0.06, 4, 12) },
            },
          ),
          frame(
            "Bag category",
            164,
            184,
            [
              illustration("Bag editorial art", 140, 126, "#E9F6FB", "bag"),
              text("Category label", "کیف و اکسسوری", "body", "color.text.primary", {
                textAlign: "center",
              }),
            ],
            {
              layout: auto("vertical", 8, 10),
              background: "#FFFFFF",
              cornerRadius: 16,
              visual: { ...shadow(0.06, 4, 12) },
            },
          ),
        ],
        { layout: auto("horizontal", 12, 0) },
      ),
      text(
        "Categories editorial note",
        "انتخاب‌های ساده برای روزهای شلوغ",
        "section",
        "color.brand.deepNavy",
      ),
      bottomNav("categories"),
    ],
    940,
  ),
  root(
    "search",
    "جست‌وجو",
    50,
    [
      header("جست‌وجو"),
      searchInstance(),
      text("Search query heading", "نتیجه برای «مانتو لینن»", "section", "color.text.primary"),
      rtlChips(),
      frame(
        "Search result badge",
        342,
        32,
        [
          text("Search count", "۲۴ محصول", "caption", "color.text.muted", {
            sizing: { width: "fill", height: "hug" },
          }),
          text("Sort mode", "مرتب‌سازی: جدیدترین", "caption", "color.action.primary"),
        ],
        { layout: auto("horizontal", 4, 0) },
      ),
      miniProduct("مانتو لینن یقه‌دار", "۱٬۲۹۰٬۰۰۰ تومان", "coat"),
      miniProduct("شومیز آبی آسمانی", "۷۸۰٬۰۰۰ تومان", "shirt"),
      miniProduct("کیف دستی مینیمال", "۹۴۰٬۰۰۰ تومان", "bag"),
    ],
    980,
  ),
  root(
    "product-detail",
    "جزئیات محصول",
    60,
    [
      header("جزئیات محصول"),
      frame(
        "Product detail gallery — vector",
        342,
        316,
        [
          {
            ...illustration("Large garment editorial illustration", 290, 266, "#DCEEFF", "coat"),
            x: 26,
            y: 18,
          },
          ellipse("Gallery favorite background", 282, 16, 42, 42, "#FFFFFF", {
            visual: { opacity: 0.9 },
          }),
          text("Gallery favorite icon", "♡", "section", "color.status.error", {
            x: 292,
            y: 22,
            width: 22,
            height: 28,
            textAlign: "center",
          }),
          text("Gallery index", "۰۱  /  ۰۳", "caption", "color.brand.deepNavy", {
            x: 16,
            y: 278,
            width: 70,
            height: 20,
          }),
        ],
        {
          visual: { ...gradient("#EFF6FF", "#D7EDFF", -38), clipsContent: true },
          cornerRadius: 22,
        },
      ),
      frame(
        "Detail title and price",
        342,
        74,
        [
          text("Product title", "مانتو لینن آبی", "heading", "color.text.primary", {
            sizing: { width: "fill", height: "hug" },
          }),
          text("Price", "۱٬۲۹۰٬۰۰۰ تومان", "price", "color.brand.deepNavy"),
          text("Old price", "۱٬۶۱۰٬۰۰۰ تومان", "caption", "color.text.muted"),
        ],
        { layout: auto("vertical", 4, 0) },
      ),
      frame(
        "Detail rating",
        342,
        34,
        [
          text("Rating star", "★ ۴٫۸", "caption", "color.action.primary"),
          text("Rating count", "۲۱۸ نظر", "caption", "color.text.muted"),
        ],
        { layout: auto("horizontal", 8, 0) },
      ),
      text("Available sizes title", "انتخاب سایز", "section", "color.text.primary"),
      chipShelf(),
      primaryButton("Add product to cart instance"),
      text(
        "Product details note",
        "پارچهٔ کتان طبیعی · مناسب استفادهٔ روزانه",
        "body",
        "color.text.muted",
      ),
    ],
    1_000,
  ),
  root(
    "favorites",
    "علاقه‌مندی‌ها",
    70,
    [
      header("علاقه‌مندی‌ها"),
      text("Favorites intro", "انتخاب‌هایی که ذخیره کرده‌ای", "body", "color.text.muted"),
      frame(
        "Favorites spotlight",
        342,
        156,
        [
          ellipse("Favorites glow", 222, 8, 112, 112, "color.action.highlight", {
            visual: { opacity: 0.22 },
          }),
          vector(
            "Favorites star icon",
            254,
            24,
            56,
            56,
            "M 28 2 L 35 20 L 54 21 L 39 33 L 44 52 L 28 41 L 12 52 L 17 33 L 2 21 L 21 20 Z",
            "color.action.primary",
          ),
          text("Favorites spotlight title", "برای بعد نگه‌دار", "heading", "#FFFFFF", {
            x: 18,
            y: 24,
            width: 184,
            height: 34,
          }),
          text("Favorites spotlight copy", "همهٔ انتخاب‌هایت یک‌جا", "body", "#FFFFFF", {
            x: 18,
            y: 66,
            width: 184,
            height: 30,
          }),
        ],
        {
          visual: {
            ...gradient("color.brand.deepNavy", "color.action.primary"),
            clipsContent: true,
          },
          cornerRadius: 18,
        },
      ),
      frame(
        "Favorites section title",
        342,
        28,
        [
          text("Favorites heading", "محصولات ذخیره‌شده", "section", "color.text.primary", {
            sizing: { width: "fill", height: "hug" },
          }),
          text("Favorites count", "۳ مورد", "caption", "color.text.muted"),
        ],
        { layout: auto("horizontal", 4, 0) },
      ),
      miniProduct("مانتو لینن آبی", "۱٬۲۹۰٬۰۰۰ تومان", "coat"),
      miniProduct("شومیز روشن", "۷۸۰٬۰۰۰ تومان", "shirt"),
      bottomNav("favorites"),
    ],
    970,
  ),
  root(
    "cart",
    "سبد خرید",
    80,
    [
      header("سبد خرید"),
      text("Cart count", "۲ محصول در سبد", "body", "color.text.muted"),
      miniProduct("مانتو لینن آبی", "۱٬۲۹۰٬۰۰۰ تومان", "coat"),
      miniProduct("شومیز آبی آسمانی", "۷۸۰٬۰۰۰ تومان", "shirt"),
      inputField("کد تخفیف", "کد خود را وارد کنید"),
      frame(
        "Cart summary card",
        342,
        146,
        [
          frame(
            "Subtotal row",
            318,
            24,
            [
              text("Subtotal label", "جمع کالاها", "body", "color.text.muted", {
                sizing: { width: "fill", height: "hug" },
              }),
              text("Subtotal amount", "۲٬۰۷۰٬۰۰۰ تومان", "price", "color.text.primary"),
            ],
            { layout: auto("horizontal", 4, 0) },
          ),
          frame(
            "Shipping row",
            318,
            24,
            [
              text("Shipping label", "هزینهٔ ارسال", "body", "color.text.muted", {
                sizing: { width: "fill", height: "hug" },
              }),
              text("Shipping amount", "رایگان", "price", "color.status.success"),
            ],
            { layout: auto("horizontal", 4, 0) },
          ),
          rect("Summary divider", undefined, undefined, 318, 1, "color.border.default"),
          frame(
            "Total row",
            318,
            30,
            [
              text("Total label", "مبلغ نهایی", "section", "color.text.primary", {
                sizing: { width: "fill", height: "hug" },
              }),
              text("Total amount", "۲٬۰۷۰٬۰۰۰ تومان", "price", "color.brand.deepNavy"),
            ],
            { layout: auto("horizontal", 4, 0) },
          ),
        ],
        {
          layout: auto("vertical", 8, 12),
          background: "#FFFFFF",
          cornerRadius: 14,
          visual: { ...shadow(0.06, 4, 12) },
        },
      ),
      primaryButton("Proceed to checkout instance"),
      bottomNav("cart"),
    ],
    1_020,
  ),
  root(
    "checkout",
    "تسویه‌حساب",
    90,
    [
      header("تسویه‌حساب"),
      frame(
        "Checkout stepper",
        342,
        54,
        [
          ellipse("Step three", 18, 10, 30, 30, "color.action.primary"),
          text(
            "Step label",
            "۰۱ آدرس     —     ۰۲ پرداخت     —     ۰۳ تأیید",
            "caption",
            "color.brand.deepNavy",
            { x: 54, y: 15, width: 270, height: 22 },
          ),
        ],
        { background: "#FFFFFF", cornerRadius: 16 },
      ),
      text("Address heading", "نشانی ارسال", "section", "color.text.primary"),
      frame(
        "Selected address card",
        342,
        108,
        [
          text("Address recipient", "سارا احمدی · خانه", "body", "color.text.primary"),
          text(
            "Address details",
            "تهران، خیابان ولیعصر، کوچهٔ بهار، پلاک ۲۴",
            "caption",
            "color.text.muted",
          ),
          text("Change address", "ویرایش نشانی", "caption", "color.action.primary"),
        ],
        {
          layout: auto("vertical", 4, 12),
          background: "#FFFFFF",
          stroke: ref("border.default"),
          cornerRadius: 14,
        },
      ),
      text("Payment heading", "روش پرداخت", "section", "color.text.primary"),
      frame(
        "Payment methods",
        342,
        134,
        [
          frame(
            "Online payment selected",
            318,
            48,
            [
              ellipse("Selected radio", undefined, undefined, 18, 18, "color.action.primary"),
              text("Online payment", "پرداخت آنلاین · درگاه امن", "body", "color.text.primary", {
                sizing: { width: "fill", height: "hug" },
              }),
            ],
            { layout: auto("horizontal", 8, 8), background: "#EFF6FF", cornerRadius: 10 },
          ),
          frame(
            "Pay at delivery",
            318,
            48,
            [
              ellipse("Unselected radio", undefined, undefined, 18, 18, "#FFFFFF", {
                visual: {
                  strokes: [{ color: ref("color.border.default"), width: 1, align: "inside" }],
                },
              }),
              text("Cash on delivery", "پرداخت هنگام تحویل", "body", "color.text.primary", {
                sizing: { width: "fill", height: "hug" },
              }),
            ],
            { layout: auto("horizontal", 8, 8), background: "#FFFFFF", cornerRadius: 10 },
          ),
        ],
        { layout: auto("vertical", 8, 8), background: "#FFFFFF", cornerRadius: 14 },
      ),
      inputField("یادداشت سفارش", "مثلاً زمان مناسب تحویل"),
      frame(
        "Checkout total",
        342,
        52,
        [
          text("Checkout total label", "مبلغ قابل پرداخت", "body", "color.text.muted", {
            sizing: { width: "fill", height: "hug" },
          }),
          text("Checkout total value", "۲٬۰۷۰٬۰۰۰ تومان", "price", "color.brand.deepNavy"),
        ],
        { layout: auto("horizontal", 8, 10), background: "#FFFFFF", cornerRadius: 12 },
      ),
      primaryButton("Pay and confirm order instance"),
    ],
    1_000,
  ),
  root(
    "confirmation",
    "سفارش ثبت شد",
    100,
    [
      frame(
        "Order success hero",
        342,
        322,
        [
          ellipse("Success glow", 77, 18, 188, 188, "#38BDF8", { visual: { opacity: 0.14 } }),
          ellipse("Success badge", 122, 64, 98, 98, "#FFFFFF", {
            visual: { ...shadow(0.1, 4, 14) },
          }),
          vector(
            "Editable checkmark",
            145,
            90,
            50,
            42,
            "M 2 21 L 17 36 L 48 4",
            "color.status.success",
            {
              visual: {
                strokes: [{ color: ref("color.status.success"), width: 6, align: "center" }],
              },
            },
          ),
          text("Order success label", "سفارش شما ثبت شد", "heading", "color.brand.deepNavy", {
            x: 24,
            y: 204,
            width: 294,
            height: 36,
            textAlign: "center",
          }),
          text(
            "Order confirmation copy",
            "از اعتمادت سپاسگزاریم. وضعیت سفارش از همین‌جا قابل پیگیری است.",
            "body",
            "color.text.muted",
            { x: 24, y: 248, width: 294, height: 46, textAlign: "center" },
          ),
        ],
        { visual: { ...gradient("#FFFFFF", "#E6F4FF", 90), clipsContent: true }, cornerRadius: 22 },
      ),
      frame(
        "Order reference card",
        342,
        118,
        [
          text("Order number label", "شمارهٔ سفارش", "caption", "color.text.muted"),
          text("Order number", "FA-۱۴۰۵-۰۰۲۴۸۱", "section", "color.brand.deepNavy"),
          text(
            "Estimated delivery",
            "زمان تقریبی تحویل: ۲ تا ۳ روز کاری",
            "body",
            "color.text.primary",
          ),
        ],
        {
          layout: auto("vertical", 4, 14),
          background: "#FFFFFF",
          stroke: ref("border.default"),
          cornerRadius: 14,
        },
      ),
      text(
        "Order complete note",
        "رسید پرداخت به شمارهٔ همراهت ارسال می‌شود.",
        "caption",
        "color.text.muted",
        { textAlign: "center" },
      ),
      primaryButton("Track order instance"),
      instance("button.secondary", "Return to store instance", {
        sizing: { width: "fill", height: "fixed" },
      }),
      text(
        "Order support note",
        "برای راهنمایی با پشتیبانی تماس بگیر",
        "body",
        "color.action.primary",
        { textAlign: "center" },
      ),
    ],
    844,
  ),
];

const output = {
  schemaVersion: "1.0.0",
  id: "apparel-visual-quality-demo",
  name: "جریان خرید پوشاک — تصویرسازی بومی",
  designSystem,
  screens,
};
writeFileSync(
  new URL("../src/samples/phase-4.5-visual-design.json", import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
