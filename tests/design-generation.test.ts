import phase45Sample from "../src/samples/phase-4.5-visual-design.json?raw";
import dashboardSample from "../src/samples/phase-5-english-dashboard.json?raw";
import { parseMultiScreenText } from "../src/shared/multi-screen-schema";
import {
  createDesignPlan,
  validateGeneratedDesignResponse,
  type DesignGenerationRequest,
  type GeneratedDesign,
  type GeneratedDesignNode,
} from "../src/shared/design-generation";
import { prepareGeneratedDesign } from "../src/ui/design-generation";
import { describe, expect, it } from "vitest";

function request(overrides: Partial<DesignGenerationRequest> = {}): DesignGenerationRequest {
  return {
    prompt: "Create a polished storefront with realistic product and checkout screens.",
    target: "mobile",
    screenCount: 2,
    language: "auto",
    style: "",
    projectType: "auto",
    theme: "auto",
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

  it("keeps Persian copy and RTL alignment editable in the prepared native text layers", () => {
    const plan = planFor(
      request({
        prompt: "یک فروشگاه فارسی با صفحهٔ خانه و سبد خرید",
        language: "fa",
        screenNames: ["خانه", "سبد خرید"],
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
