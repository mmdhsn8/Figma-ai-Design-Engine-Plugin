import phase45Sample from "../src/samples/phase-4.5-visual-design.json?raw";
import dashboardSample from "../src/samples/phase-5-english-dashboard.json?raw";
import { parseMultiScreenText } from "../src/shared/multi-screen-schema";
import {
  createDesignPlan,
  createDesignInstructions,
  normalizeGeneratedDesignResponse,
  generationRepairTargets,
  applyGenerationRepair,
  validateGeneratedDesignResponse,
  type DesignGenerationRequest,
  type GeneratedDesign,
  type GeneratedDesignNode,
} from "../src/shared/design-generation";
import {
  pendingGenerationScreens,
  prepareGeneratedDesign,
  retainGeneratedScreen,
} from "../src/ui/design-generation";
import { describe, expect, it } from "vitest";

function request(overrides: Partial<DesignGenerationRequest> = {}): DesignGenerationRequest {
  return {
    prompt: "Create a storefront interface for a design-system fixture.",
    target: "mobile",
    screenCount: 2,
    language: "auto",
    style: "",
    projectType: "auto",
    theme: "auto",
    fidelity: "standard",
    ...overrides,
  };
}

function planFor(input: DesignGenerationRequest) {
  const plan = createDesignPlan(input);
  if (!plan.success) throw new Error(plan.errors.join(" "));
  return plan.data;
}

function textNode(text: string): GeneratedDesignNode {
  return {
    type: "text",
    name: "Page title",
    text,
    palette: "text",
    width: 300,
    height: 48,
    fontSize: 24,
    fontStyle: "Bold",
    textAlign: "left",
    cornerRadius: 0,
    elevation: "none",
    layout: "none",
    gap: 0,
    padding: 0,
    qualityRole: "heading",
    children: [],
  };
}

function generatedResponse(ids: string[]): GeneratedDesign {
  return {
    projectName: "Atelier Store",
    palette: {
      brand: "#263A36",
      accent: "#B97755",
      page: "#F6F3EE",
      surface: "#FFFFFF",
      text: "#1E2926",
      muted: "#68736F",
      border: "#D9DED9",
    },
    screens: ids.map((id, index) => ({
      id,
      children: [
        {
          type: "frame",
          name: `Page content ${index + 1}`,
          text: null,
          palette: "none",
          width: 350,
          height: 600,
          fontSize: 16,
          fontStyle: "Regular",
          textAlign: "left",
          cornerRadius: 0,
          elevation: "none",
          layout: "vertical",
          gap: 16,
          padding: 16,
          qualityRole: "decorative",
          children: [textNode(index === 0 ? "New season" : "Featured pieces")],
        },
      ],
    })),
  };
}

describe("brief planner and constrained design generation", () => {
  it("defaults to high fidelity, preserves explicit wireframe mode, and covers non-commerce domains", () => {
    const defaultPlan = createDesignPlan(
      request({
        prompt: "Design a professional education onboarding flow with clear learning progress.",
        fidelity: undefined,
        target: "mobile",
        screenCount: 1,
        screenNames: ["Welcome"],
      }),
    );
    expect(defaultPlan).toMatchObject({
      success: true,
      data: { fidelity: "high_fidelity", domain: "education", screens: [{ familyName: "Welcome" }] },
    });
    expect(
      createDesignPlan(request({
        prompt: "Create a wireframe for a health app welcome screen.",
        fidelity: undefined,
        screenCount: 1,
        screenNames: ["Welcome"],
      })),
    ).toMatchObject({ success: true, data: { fidelity: "wireframe", domain: "health" } });
    expect(
      createDesignPlan(request({
        prompt: "Create a SaaS workspace for a team.",
        fidelity: undefined,
        screenCount: 1,
        screenNames: ["Tasks"],
      })),
    ).toMatchObject({ success: true, data: { fidelity: "high_fidelity", domain: "saas" } });
    expect(
      createDesignPlan(request({
        prompt: "Create a productivity task manager for a team.",
        fidelity: undefined,
        screenCount: 1,
        screenNames: ["Tasks"],
      })),
    ).toMatchObject({ success: true, data: { fidelity: "high_fidelity", domain: "productivity" } });
  });

  it("preflights high-fidelity native hierarchy and stable, parent-first refs", () => {
    const plan = planFor(request({
      prompt: "Create a professional health app home screen.",
      target: "mobile",
      screenCount: 1,
      screenNames: ["Home"],
      fidelity: "high_fidelity",
      projectType: "product",
    }));
    const design: GeneratedDesign = {
      ...generatedResponse([plan.screens[0]!.id]),
      screens: [{
        id: plan.screens[0]!.id,
        children: [{
          type: "frame",
          name: "Home content region",
          pattern: "service-card",
          text: null,
          palette: "surface",
          width: 350,
          height: 600,
          fontSize: 16,
          fontStyle: "Regular",
          textAlign: "left",
          cornerRadius: 12,
          elevation: "none",
          layout: "vertical",
          gap: 16,
          padding: 16,
          qualityRole: "decorative",
          children: [
            textNode("Your daily wellness"),
            {
              type: "icon",
              name: "Heart icon",
              text: null,
              palette: "brand",
              width: 24,
              height: 24,
              fontSize: 16,
              fontStyle: "Regular",
              textAlign: "center",
              cornerRadius: 0,
              elevation: "none",
              layout: "none",
              gap: 0,
              padding: 0,
              qualityRole: "decorative",
              iconName: "heart",
              children: [],
            },
          ],
        }],
      }],
    };
    const prepared = prepareGeneratedDesign(JSON.stringify(design), plan);
    expect(prepared.success).toBe(true);
    if (!prepared.success) throw new Error(prepared.errors.join(" "));
    const nodes = prepared.data.visualSpecs[0]!.nodes;
    expect(nodes.map(({ logicalRef }) => logicalRef)).toEqual([
      "home.root",
      "home.main.n0",
      "home.main.n0.n0",
      "home.main.n0.n1",
    ]);
    expect(nodes[2]).toMatchObject({ nodeType: "text", qualityRole: "heading", nativeType: "TEXT" });
    expect(nodes[3]).toMatchObject({ nodeType: "icon", iconName: "heart", nativeType: "VECTOR" });

    const flat = structuredClone(design);
    flat.screens[0]!.children = [textNode("A flat title")];
    const rejected = prepareGeneratedDesign(JSON.stringify(flat), plan);
    expect(rejected.success).toBe(false);
    if (!rejected.success)
      expect(rejected.errors.join(" ")).toContain("Required pattern “service-card”");
  });

  it("turns image slots into disclosed editable native placeholders with matching spec refs", () => {
    const plan = planFor(request({
      prompt: "Create a health app home screen with a visual image placeholder.",
      screenCount: 1,
      screenNames: ["Home"],
      fidelity: "high_fidelity",
      projectType: "product",
    }));
    const design = generatedResponse([plan.screens[0]!.id]);
    const content = design.screens[0]!.children[0]!;
    content.pattern = "service-card";
    content.children.push({
      type: "image",
      name: "Wellness illustration slot",
      text: null,
      palette: "surface",
      width: 180,
      height: 120,
      fontSize: 16,
      fontStyle: "Regular",
      textAlign: "center",
      cornerRadius: 12,
      elevation: "none",
      layout: "none",
      gap: 0,
      padding: 0,
      qualityRole: "image",
      placeholder: true,
      children: [],
    });
    const prepared = prepareGeneratedDesign(JSON.stringify(design), plan);
    expect(prepared.success).toBe(true);
    if (!prepared.success) throw new Error(prepared.errors.join(" "));
    const refs = prepared.data.visualSpecs[0]!.nodes.map(({ logicalRef }) => logicalRef);
    expect(refs).toContain("home.main.n0.n1.illustration");
    expect(refs).toContain("home.main.n0.n1.disclosure");
    const root = prepared.data.batch.screens[0]!.children[0];
    expect(root?.type).toBe("frame");
    if (root?.type === "frame") expect(root.children[1]).toMatchObject({ type: "frame", name: "Wellness illustration slot" });
  });

  it("normalizes Persian, Finglish, and English briefs without losing the user's copy language", () => {
    const persian = createDesignPlan(
      request({ prompt: "یک فروشگاه لباس فارسی با صفحهٔ خانه و سبد خرید طراحی کن." }),
    );
    expect(persian).toMatchObject({
      success: true,
      data: { language: "fa", direction: "rtl", projectType: "storefront" },
    });

    const finglish = createDesignPlan(
      request({
        prompt: "ye foroshgah lebas ba safhe khane va kharid besaz",
        language: "auto",
      }),
    );
    expect(finglish).toMatchObject({
      success: true,
      data: { language: "fa", direction: "rtl", projectType: "storefront" },
    });

    const english = createDesignPlan(
      request({ prompt: "Build a SaaS analytics dashboard", target: "desktop" }),
    );
    expect(english).toMatchObject({
      success: true,
      data: { language: "en", direction: "ltr", projectType: "dashboard" },
    });
    expect(
      createDesignPlan(
        request({ prompt: "Build a dashboard with orders and notifications for the team." }),
      ),
    ).toMatchObject({
      success: true,
      data: { screens: [{ familyName: "Overview" }, { familyName: "Analytics" }] },
    });
  });

  it("accepts a long Persian brief for two mobile screens named home and detail", () => {
    const prompt = `یک فروشگاه اینترنتی فارسی با طراحی کامل موبایل بساز. ${"برای جزئیات بیشتر، تجربهٔ خرید روان و دسترس‌پذیر باشد. ".repeat(55)}`;
    expect(prompt.length).toBeGreaterThan(2_000);
    expect(
      createDesignPlan(
        request({
          prompt,
          target: "mobile",
          screenCount: 2,
          screenNames: ["خانه", "جزئیات"],
        }),
      ),
    ).toMatchObject({
      success: true,
      data: {
        language: "fa",
        direction: "rtl",
        screens: [
          { familyName: "خانه", devicePreset: "mobile", width: 390 },
          { familyName: "جزئیات", devicePreset: "mobile", width: 390 },
        ],
      },
    });
  });

  it("makes stable, ordered Mobile/Desktop counterparts and rejects inconsistent screen choices", () => {
    const plan = planFor(
      request({
        prompt: "یک فروشگاه لباس طراحی کن",
        target: "both",
        screenNames: ["خانه", "سبد خرید"],
      }),
    );
    expect(
      plan.screens.map(({ id, devicePreset, width, height, order }) => [
        id,
        devicePreset,
        width,
        height,
        order,
      ]),
    ).toEqual([
      ["screen-1-mobile", "mobile", 390, 844, 0],
      ["screen-1-desktop", "desktop", 1440, 900, 1],
      ["screen-2-mobile", "mobile", 390, 844, 2],
      ["screen-2-desktop", "desktop", 1440, 900, 3],
    ]);
    expect(plan.screens.map(({ name }) => name)).toEqual([
      "خانه — موبایل",
      "خانه — دسکتاپ",
      "سبد خرید — موبایل",
      "سبد خرید — دسکتاپ",
    ]);

    expect(createDesignPlan(request({ screenNames: ["Home"] }))).toMatchObject({ success: false });

    const manyScreens = createDesignPlan(
      request({
        prompt:
          "برای فروشگاه لباس صفحه اصلی، لیست محصولات، جزئیات محصول، آپلود تصویر چاپ، سبد خرید و پرداخت بساز.",
      }),
    );
    expect(manyScreens).toMatchObject({
      success: false,
      errors: [expect.stringContaining("names 6 screens")],
    });
    expect(
      createDesignPlan(
        request({
          prompt:
            "Build a mobile app with screens: Home, Profile, Billing, Notifications, Help, Settings",
        }),
      ),
    ).toMatchObject({ success: false, errors: [expect.stringContaining("names 6 screens")] });
    const explicitBatch = createDesignPlan(
      request({
        prompt:
          "برای فروشگاه لباس صفحه اصلی، لیست محصولات، جزئیات محصول، آپلود تصویر چاپ، سبد خرید و پرداخت بساز.",
        screenNames: ["خانه", "محصولات"],
      }),
    );
    expect(explicitBatch).toMatchObject({
      success: true,
      data: { screens: [{ familyName: "خانه" }, { familyName: "محصولات" }] },
    });

    const extendedBatch = createDesignPlan(
      request({
        target: "both",
        screenCount: 6,
        screenNames: ["Home", "Search", "Product", "Favorites", "Cart", "Account"],
      }),
    );
    expect(extendedBatch.success).toBe(true);
    if (extendedBatch.success) expect(extendedBatch.data.screens).toHaveLength(12);
  });

  it("plans bounded 400-screen mobile batches and 400 responsive counterparts", () => {
    const names = Array.from({ length: 400 }, (_, index) => `Screen ${index + 1}`);
    const mobile = createDesignPlan(request({ target: "mobile", screenCount: 400, screenNames: names }));
    expect(mobile.success).toBe(true);
    if (mobile.success) expect(mobile.data.screens).toHaveLength(400);

    const responsive = createDesignPlan(request({
      target: "both",
      screenCount: 200,
      screenNames: names.slice(0, 200),
    }));
    expect(responsive.success).toBe(true);
    if (responsive.success) expect(responsive.data.screens).toHaveLength(400);
    expect(createDesignPlan(request({ target: "both", screenCount: 201, screenNames: names.slice(0, 201) })))
      .toMatchObject({ success: false, errors: [expect.stringContaining("200 screen families")] });
  });

  it("requires domain-specific high-fidelity composition patterns", () => {
    const commerce = planFor(request({
      prompt: "Create a professional mobile storefront home screen.",
      target: "mobile",
      screenCount: 1,
      screenNames: ["Home"],
      fidelity: "high_fidelity",
      projectType: "storefront",
    }));
    const commerceInstructions = createDesignInstructions(commerce);
    expect(commerceInstructions).toContain("hero-banner");
    expect(commerceInstructions).toContain("category-chips");
    expect(commerceInstructions).toContain("product-card");

    const dashboard = planFor(request({
      prompt: "Create a high fidelity SaaS overview dashboard.",
      target: "desktop",
      screenCount: 1,
      screenNames: ["Overview"],
      fidelity: "high_fidelity",
    }));
    expect(createDesignInstructions(dashboard)).toContain("stat-card");
    expect(createDesignInstructions(dashboard)).toContain("data-table");
  });

  it("resumes only missing planned screens and never duplicates a completed screen", () => {
    const plan = planFor(
      request({
        screenCount: 3,
        screenNames: ["Home", "Products", "Cart"],
      }),
    );
    const saved = [
      { id: plan.screens[0]!.id, children: [] },
      { id: plan.screens[2]!.id, children: [] },
    ];

    expect(pendingGenerationScreens(plan, saved).map(({ id }) => id)).toEqual([
      plan.screens[1]!.id,
    ]);
    expect(retainGeneratedScreen(saved, saved[0]!)).toBe(saved);
    expect(retainGeneratedScreen(saved, { id: plan.screens[1]!.id, children: [] })).toHaveLength(3);
  });

  it("repairs nested mobile controls, growing ancestors without changing RTL, order, padding or gaps", () => {
    const plan = planFor(request({ screenNames: ["Home", "Detail"], language: "fa" }));
    const control = (role: "button" | "input"): GeneratedDesignNode => ({
      ...textNode(""),
      type: "rectangle",
      text: null,
      name: role,
      width: 20,
      height: 24,
      qualityRole: role,
      textAlign: "right",
    });
    const row: GeneratedDesignNode = {
      ...control("button"),
      type: "frame",
      name: "RTL row",
      qualityRole: "decorative",
      width: 80,
      height: 40,
      padding: 8,
      gap: 12,
      layout: "horizontal",
      children: [control("button"), control("input")],
    };
    const outer = {
      ...row,
      name: "Outer",
      width: 200,
      height: 80,
      layout: "vertical" as const,
      children: [row],
    };
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    generated.screens[1]!.children = [outer];
    const raw = JSON.stringify(generated);
    expect(validateGeneratedDesignResponse(raw, plan).success).toBe(false);
    const normalized = normalizeGeneratedDesignResponse(raw, plan);
    expect(normalized.success).toBe(true);
    if (!normalized.success) return;
    const repaired = normalized.data.design.screens[1]!.children[0]!.children[0]!;
    expect(repaired).toMatchObject({
      width: 116,
      height: 60,
      padding: 8,
      gap: 12,
      layout: "horizontal",
    });
    expect(
      repaired.children.map(({ name, width, height, textAlign }) => [
        name,
        width,
        height,
        textAlign,
      ]),
    ).toEqual([
      ["button", 44, 44, "right"],
      ["input", 44, 44, "right"],
    ]);
    expect(normalized.data.design.screens[0]).toEqual(generated.screens[0]);
    expect(
      validateGeneratedDesignResponse(JSON.stringify(normalized.data.design), plan).success,
    ).toBe(true);
    expect(normalizeGeneratedDesignResponse(JSON.stringify(normalized.data.design), plan)).toEqual(
      normalized,
    );
    expect(JSON.stringify(generated)).toBe(raw);
    const prepared = prepareGeneratedDesign(raw, plan);
    if (!prepared.success) throw new Error(prepared.errors.join("\n"));
    if (prepared.success) {
      const frame = prepared.data.batch.screens[1]!.children[0]!;
      expect(frame.type).toBe("frame");
      if (frame.type === "frame" && frame.children[0]?.type === "frame") {
        expect(frame.children[0].children[0]).toMatchObject({
          width: 44,
          height: 44,
          sizing: { width: "fixed", height: "fill" },
        });
      }
    }
  });

  it("normalizes missing directions in a nested Persian product card before strict validation", () => {
    const plan = planFor(
      request({
        prompt: "یک فروشگاه فارسی با کارت محصول، قیمت و دکمه خرید طراحی کن.",
        screenNames: ["خانه", "محصول"],
        language: "fa",
        projectType: "storefront",
      }),
    );
    const productScreen = plan.screens[1]!;
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    const text = (
      name: string,
      content: string,
      width: number,
      height: number,
    ): GeneratedDesignNode => ({
      ...textNode(content),
      name,
      width,
      height,
      textAlign: "right",
    });
    const button: GeneratedDesignNode = {
      ...text("افزودن به سبد", "افزودن به سبد", 90, 36),
      palette: "brand",
      qualityRole: "button",
    };
    const actions: GeneratedDesignNode = {
      ...generated.screens[1]!.children[0]!,
      name: "اقدام‌ها",
      width: 164,
      height: 60,
      padding: 4,
      gap: 8,
      layout: "none",
      children: [
        button,
        {
          ...button,
          type: "ellipse",
          text: null,
          name: "علاقه‌مندی",
          palette: "accent",
          qualityRole: "decorative",
          width: 44,
          height: 44,
        },
      ],
    };
    const details: GeneratedDesignNode = {
      ...generated.screens[1]!.children[0]!,
      name: "جزئیات محصول",
      width: 180,
      height: 220,
      padding: 8,
      gap: 8,
      layout: "none",
      children: [
        text("نام محصول", "مانتو لینن", 148, 32),
        text("قیمت", "۱٬۲۵۰٬۰۰۰ تومان", 120, 24),
        actions,
      ],
    };
    const card: GeneratedDesignNode = {
      ...generated.screens[1]!.children[0]!,
      name: "کارت محصول",
      pattern: "product-card",
      width: 318,
      height: 280,
      padding: 12,
      gap: 12,
      layout: "none",
      children: [
        {
          ...button,
          type: "image",
          text: null,
          name: "تصویر محصول",
          palette: "surface",
          qualityRole: "image",
          width: 100,
          height: 220,
          placeholder: true,
          children: [],
        },
        details,
      ],
    };
    generated.screens[1]!.children[0]!.children = [card];
    const screenPlan = { ...plan, screens: [productScreen] };
    const raw = JSON.stringify({ ...generated, screens: [generated.screens[1]!] });

    const beforeNormalization = validateGeneratedDesignResponse(raw, screenPlan);
    expect(beforeNormalization.success).toBe(false);
    if (!beforeNormalization.success) {
      expect(beforeNormalization.errors).toContain(
        `screens.${productScreen.id}.children[0].children[0] needs an Auto Layout direction because it has children.`,
      );
      expect(beforeNormalization.errors).toContain(
        `screens.${productScreen.id}.children[0].children[0].children[1] needs an Auto Layout direction because it has children.`,
      );
      expect(beforeNormalization.errors).toContain(
        `screens.${productScreen.id}.children[0].children[0].children[1].children[2] needs an Auto Layout direction because it has children.`,
      );
    }

    const normalized = normalizeGeneratedDesignResponse(raw, screenPlan);
    if (!normalized.success) throw new Error(normalized.errors.join("\n"));
    expect(normalized.success).toBe(true);
    const normalizedCard = normalized.data.design.screens[0]!.children[0]!.children[0]!;
    const normalizedDetails = normalizedCard.children[1]!;
    const normalizedActions = normalizedDetails.children[2]!;
    expect([normalizedCard.layout, normalizedDetails.layout, normalizedActions.layout]).toEqual([
      "horizontal",
      "vertical",
      "horizontal",
    ]);
    expect(normalizedCard).toMatchObject({ width: 318, height: 280, padding: 12, gap: 12 });
    expect(normalizedDetails).toMatchObject({ width: 180, height: 220, padding: 8, gap: 8 });
    expect(normalizedActions).toMatchObject({ width: 164, height: 60, padding: 4, gap: 8 });
    expect(normalizedDetails.children.map(({ name }) => name)).toEqual([
      "نام محصول",
      "قیمت",
      "اقدام‌ها",
    ]);
    expect(normalizedDetails.children[0]).toMatchObject({
      text: "مانتو لینن",
      textAlign: "right",
    });
    expect(
      validateGeneratedDesignResponse(JSON.stringify(normalized.data.design), screenPlan),
    ).toMatchObject({ success: true });
    expect(
      normalizeGeneratedDesignResponse(JSON.stringify(normalized.data.design), screenPlan),
    ).toEqual(normalized);
    const prepared = prepareGeneratedDesign(JSON.stringify(normalized.data.design), screenPlan);
    if (!prepared.success) throw new Error(prepared.errors.join("\n"));
    expect(prepared.success).toBe(true);
    const sectionRoot = prepared.data.batch.screens[0]!.children[0]!;
    const preparedCard = sectionRoot.type === "frame" ? sectionRoot.children[0]! : undefined;
    const preparedDetails = preparedCard?.type === "frame" ? preparedCard.children[1]! : undefined;
    const preparedActions =
      preparedDetails?.type === "frame" ? preparedDetails.children[2]! : undefined;
    expect(preparedCard).toMatchObject({ type: "frame", layout: { mode: "horizontal" } });
    expect(preparedDetails).toMatchObject({ type: "frame", layout: { mode: "vertical" } });
    expect(preparedActions).toMatchObject({ type: "frame", layout: { mode: "horizontal" } });
    if (preparedActions?.type === "frame")
      expect(preparedActions.children[0]).toMatchObject({
        type: "frame",
        sizing: { width: "fixed", height: "fill" },
      });
    if (preparedActions?.type === "frame" && preparedActions.children[0]?.type === "frame")
      expect(preparedActions.children[0].children[0]).toMatchObject({
        type: "text",
        text: "افزودن به سبد",
        textAlign: "right",
      });
  });

  it.each([1, 4, 7])(
    "normalizes missing Auto Layout directions through valid nesting depth %i",
    (depth) => {
      const plan = planFor(request({ screenNames: ["Home", "Product"], language: "fa" }));
      const generated = generatedResponse(plan.screens.map(({ id }) => id));
      let child = textNode("عنوان محصول");
      for (let index = depth - 1; index >= 0; index--) {
        child = {
          ...generated.screens[1]!.children[0]!,
          name: `تو در تو ${index}`,
          width: 350,
          height: 600,
          layout: "none",
          children: [child],
        };
      }
      generated.screens[1]!.children = [child];
      const normalized = normalizeGeneratedDesignResponse(JSON.stringify(generated), plan);
      expect(normalized.success).toBe(true);
      if (!normalized.success) return;
      let current = normalized.data.design.screens[1]!.children[0]!;
      for (let index = 0; index < depth; index++) {
        expect(current.layout).toBe("vertical");
        current = current.children[0]!;
      }
      expect(current.text).toBe("عنوان محصول");
    },
  );

  it("normalizes nested containers on desktop while retaining strict validation", () => {
    const plan = planFor(
      request({ target: "desktop", screenNames: ["Home", "Product"], language: "fa" }),
    );
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    const container = generated.screens[1]!.children[0]!;
    container.layout = "none";
    const raw = JSON.stringify(generated);
    expect(validateGeneratedDesignResponse(raw, plan)).toMatchObject({
      success: false,
      errors: [expect.stringContaining("needs an Auto Layout direction")],
    });
    const normalized = normalizeGeneratedDesignResponse(raw, plan);
    expect(normalized.success).toBe(true);
    if (normalized.success) {
      expect(normalized.data.design.screens[1]!.children[0]!.layout).toBe("vertical");
      expect(
        validateGeneratedDesignResponse(JSON.stringify(normalized.data.design), plan),
      ).toMatchObject({ success: true });
    }
  });

  it("keeps exact paths for impossible repairs and resumes only the failed screen", () => {
    const plan = planFor(request({ screenNames: ["Home", "Detail"], language: "fa" }));
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    const button: GeneratedDesignNode = {
      ...textNode(""),
      type: "rectangle",
      text: null,
      qualityRole: "button",
      width: 20,
      height: 20,
    };
    generated.screens[1]!.children = [
      {
        ...button,
        type: "frame",
        qualityRole: "decorative",
        layout: "horizontal",
        width: 350,
        height: 244,
        padding: 100,
        gap: 100,
        children: [button, { ...button }],
      },
    ];
    const saved = [generated.screens[0]!];
    const pending = pendingGenerationScreens(plan, saved);
    expect(pending.map(({ id }) => id)).toEqual(["detail"]);
    const screenPlan = { ...plan, screens: pending };
    const failed = normalizeGeneratedDesignResponse(
      JSON.stringify({ ...generated, screens: [generated.screens[1]!] }),
      screenPlan,
    );
    expect(failed).toMatchObject({
      success: false,
      errors: [
        "screens.detail.children[0].children[0] button is below the 44 px minimum tap target.",
        "screens.detail.children[0].children[1] button is below the 44 px minimum tap target.",
      ],
    });
    if (failed.success) return;
    expect(createDesignInstructions(screenPlan, failed.errors)).toContain(failed.errors[0]);
    expect(saved).toHaveLength(1);
    const fixed = structuredClone(generated.screens[1]!);
    fixed.children[0]!.gap = 12;
    const repaired = normalizeGeneratedDesignResponse(
      JSON.stringify({ ...generated, screens: [fixed] }),
      screenPlan,
    );
    expect(repaired.success).toBe(true);
    if (!repaired.success) return;
    const completed = retainGeneratedScreen(saved, repaired.data.design.screens[0]!);
    expect(retainGeneratedScreen(completed, repaired.data.design.screens[0]!)).toBe(completed);
    expect(pendingGenerationScreens(plan, completed)).toEqual([]);
    expect(completed[0]).toBe(saved[0]);
  });

  it("does not normalize invalid schemas and repairs small desktop controls", () => {
    const plan = planFor(request({ screenNames: ["Home", "Detail"] }));
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    generated.screens[0]!.children = [
      { ...textNode("خرید"), width: 20, height: 20, qualityRole: "button" },
    ];
    expect(normalizeGeneratedDesignResponse(JSON.stringify(generated), plan).success).toBe(true);
    expect(
      normalizeGeneratedDesignResponse(JSON.stringify({ ...generated, script: "bad" }), plan)
        .success,
    ).toBe(false);
    const desktop = planFor(request({ target: "desktop", screenNames: ["Home", "Detail"] }));
    const desktopRepair = normalizeGeneratedDesignResponse(JSON.stringify(generated), desktop);
    expect(desktopRepair.success).toBe(true);
    if (desktopRepair.success)
      expect(desktopRepair.data.design.screens[0]!.children[0]).toMatchObject({
        width: 44,
        height: 44,
      });
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "repairs a text button at nesting depth %i without changing Persian copy",
    (depth) => {
      const plan = planFor(request({ screenNames: ["Home", "Detail"], language: "fa" }));
      const generated = generatedResponse(plan.screens.map(({ id }) => id));
      let control: GeneratedDesignNode = {
        ...textNode("خرید"),
        name: "خرید",
        width: 24,
        height: 24,
        qualityRole: "button",
        textAlign: "right",
      };
      for (let index = 0; index < depth; index++)
        control = {
          ...control,
          type: "frame",
          text: null,
          qualityRole: "decorative",
          layout: index % 2 ? "horizontal" : "vertical",
          width: 200,
          height: 200,
          padding: 0,
          gap: 8,
          children: [control],
        };
      generated.screens[1]!.children = [control];
      const normalized = normalizeGeneratedDesignResponse(JSON.stringify(generated), plan);
      expect(normalized.success).toBe(true);
      if (!normalized.success) return;
      expect(
        normalizeGeneratedDesignResponse(JSON.stringify(normalized.data.design), plan),
      ).toEqual(normalized);
      const prepared = prepareGeneratedDesign(JSON.stringify(normalized.data.design), plan);
      expect(prepared.success).toBe(true);
    },
  );

  it("rejects controls whose nominal size is safe but parent stretch shrinks the touch target", () => {
    const plan = planFor(request({ screenNames: ["Home", "Detail"] }));
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    const button: GeneratedDesignNode = {
      ...textNode(""),
      type: "rectangle",
      text: null,
      qualityRole: "button",
      width: 44,
      height: 44,
    };
    generated.screens[1]!.children = [
      {
        ...button,
        type: "frame",
        qualityRole: "decorative",
        width: 350,
        height: 40,
        padding: 0,
        layout: "horizontal",
        children: [button],
      },
      { ...textNode("Other content"), height: 748 },
    ];
    const result = normalizeGeneratedDesignResponse(JSON.stringify(generated), plan);
    expect(result).toMatchObject({
      success: false,
      errors: [
        "screens.detail.children[0].children[0] button is below the 44 px minimum tap target.",
      ],
    });
  });

  it("applies only exact targeted replacements and refuses role removal or copy changes", () => {
    const plan = planFor(request({ screenNames: ["Home", "Detail"] }));
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    const target = { ...textNode("خرید"), width: 20, height: 20, qualityRole: "button" as const };
    generated.screens[1]!.children = [target];
    const raw = JSON.stringify(generated);
    const targets = generationRepairTargets(raw, [
      "screens.detail.children[0] button is below the 44 px minimum tap target.",
    ]);
    expect(targets).toHaveLength(1);
    const repaired = JSON.parse(
      applyGenerationRepair(
        raw,
        targets,
        JSON.stringify({ nodes: [{ ...target, width: 44, height: 44 }] }),
      ),
    );
    expect(repaired.screens[0]).toEqual(generated.screens[0]);
    expect(repaired.screens[1].children[0]).toMatchObject({
      width: 44,
      height: 44,
      text: "خرید",
      qualityRole: "button",
    });
    expect(() =>
      applyGenerationRepair(
        raw,
        targets,
        JSON.stringify({ nodes: [{ ...target, qualityRole: "decorative" }] }),
      ),
    ).toThrow("semantics");
    expect(() =>
      applyGenerationRepair(
        raw,
        targets,
        JSON.stringify({ nodes: [{ ...target, text: "changed" }] }),
      ),
    ).toThrow("copy");
  });

  it("does not hide depth-limit failures when a text target needs a hit-area wrapper", () => {
    const plan = planFor(request({ screenNames: ["Home", "Detail"] }));
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    let node: GeneratedDesignNode = {
      ...textNode("خرید"),
      width: 20,
      height: 20,
      qualityRole: "button",
    };
    for (let depth = 0; depth < 7; depth++)
      node = {
        ...node,
        type: "frame",
        text: null,
        qualityRole: "decorative",
        layout: "vertical",
        width: 200,
        height: 200,
        padding: 0,
        children: [node],
      };
    generated.screens[1]!.children = [node];
    expect(normalizeGeneratedDesignResponse(JSON.stringify(generated), plan)).toMatchObject({
      success: false,
      errors: [expect.stringContaining("eight-level nesting limit")],
    });
  });

  it("converts a validated response into the existing multi-screen schema and shared color tokens", () => {
    const plan = planFor(request({ target: "both" }));
    const raw = JSON.stringify(generatedResponse(plan.screens.map(({ id }) => id)));
    const prepared = prepareGeneratedDesign(raw, plan);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;

    const checked = parseMultiScreenText(prepared.data.json);
    expect(checked.success).toBe(true);
    if (!checked.success) return;
    expect(
      checked.data.screens.map(({ id, devicePreset, width, height }) => [
        id,
        devicePreset,
        width,
        height,
      ]),
    ).toEqual(
      plan.screens.map(({ id, devicePreset, width, height }) => [id, devicePreset, width, height]),
    );
    expect(checked.data.designSystem?.colors["color.brand.primary"]).toBe("#263A36");
    expect(checked.data.screens[0]?.children[0]?.type).toBe("frame");
  });

  it("prepares multi-megabyte output with every requested screen and node intact", () => {
    const plan = planFor(request());
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    generated.screens.forEach((screen) => {
      screen.children = Array.from({ length: 2_600 }, (_, index) => ({
        ...textNode("Product description ".repeat(18)),
        name: `Product description ${index}`,
      }));
    });
    const source = JSON.stringify(generated);
    expect(source.length).toBeGreaterThan(2 * 1_024 * 1_024);

    const prepared = prepareGeneratedDesign(source, plan);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    expect(prepared.data.nodeCount).toBeGreaterThan(5_200);
    const rendererInput = parseMultiScreenText(prepared.data.json);
    expect(rendererInput.success).toBe(true);
    if (rendererInput.success) {
      expect(rendererInput.data.screens.map(({ children }) => children.length)).toEqual([
        2_600, 2_600,
      ]);
      expect(rendererInput.nodeCount).toBeGreaterThan(5_000);
    }
  });

  it("keeps Persian copy and RTL alignment editable in the prepared native text layers", () => {
    const plan = planFor(
      request({
        prompt: "یک فروشگاه فارسی با صفحهٔ خانه و جزئیات",
        language: "fa",
        screenNames: ["خانه", "جزئیات"],
      }),
    );
    const generated = generatedResponse(plan.screens.map(({ id }) => id));
    const frame = generated.screens[0]!.children[0]!;
    const text = frame.children[0]!;
    text.text = "تازه‌ترین محصولات  ·  SKU-32";
    text.textAlign = "right";
    const prepared = prepareGeneratedDesign(JSON.stringify(generated), plan);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    const renderedText = prepared.data.batch.screens[0]?.children[0];
    expect(renderedText?.type).toBe("frame");
    if (renderedText?.type !== "frame") return;
    expect(renderedText.children[0]).toMatchObject({
      type: "text",
      text: "تازه‌ترین محصولات  ·  SKU-32",
      textAlign: "right",
      textAutoResize: "height",
    });
  });

  it("rejects hostile, malformed, incomplete, over-depth, and undersized tap-target output", () => {
    const plan = planFor(request());
    const valid = generatedResponse(plan.screens.map(({ id }) => id));
    const hostile = structuredClone(valid) as Record<string, unknown>;
    hostile["script"] = "figma.closePlugin()";
    expect(validateGeneratedDesignResponse(JSON.stringify(hostile), plan).success).toBe(false);

    const wrongScreens = generatedResponse(["unexpected", plan.screens[1]!.id]);
    expect(validateGeneratedDesignResponse(JSON.stringify(wrongScreens), plan).success).toBe(false);

    const tooSmall = generatedResponse(plan.screens.map(({ id }) => id));
    const firstScreen = tooSmall.screens[0]!;
    const firstNode = firstScreen.children[0]!;
    firstNode.qualityRole = "button";
    firstNode.width = 20;
    firstNode.height = 30;
    expect(validateGeneratedDesignResponse(JSON.stringify(tooSmall), plan)).toMatchObject({
      success: false,
      errors: [expect.stringContaining("44 px minimum tap target")],
    });

    const deeplyNested = generatedResponse(plan.screens.map(({ id }) => id));
    let parent: GeneratedDesignNode[] = deeplyNested.screens[0]!.children;
    for (let depth = 1; depth <= 9; depth += 1) {
      const next = {
        ...textNode(""),
        type: "frame" as const,
        text: null,
        name: `Depth ${depth}`,
        palette: "none" as const,
        layout: "vertical" as const,
        children: [] as GeneratedDesignNode[],
      };
      parent.push(next);
      parent = next.children;
    }
    expect(validateGeneratedDesignResponse(JSON.stringify(deeplyNested), plan)).toMatchObject({
      success: false,
      errors: [expect.stringContaining("maximum depth of 8")],
    });

    expect(validateGeneratedDesignResponse("{not json", plan)).toMatchObject({ success: false });
  });

  it("keeps the Persian storefront and English dashboard fixtures deterministic and offline", () => {
    const persian = parseMultiScreenText(phase45Sample);
    const dashboard = parseMultiScreenText(dashboardSample);
    expect(persian.success && persian.data.screens.map(({ id }) => id)).toEqual([
      "welcome",
      "sign-in",
      "home",
      "categories",
      "search",
      "product-detail",
      "favorites",
      "cart",
      "checkout",
      "confirmation",
    ]);
    expect(dashboard.success && dashboard.data.screens.map(({ id }) => id)).toEqual([
      "overview",
      "orders",
    ]);
    expect(dashboard.success && dashboard.data.designSystem?.components?.length).toBe(1);
  });
});
