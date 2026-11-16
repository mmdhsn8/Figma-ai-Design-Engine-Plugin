import { createDesignPlan } from "../src/shared/design-generation";
import { isSampleStorefront } from "../src/shared/storefront-layout";
import { brief as storefrontBrief } from "./storefront-fixture";
import { describe, expect, it } from "vitest";
import {
  createMultiScreenDesignRequest,
  MultiScreenDesignRequestSchema,
  parseChatGenerationIntent,
  type ChatGenerationPlanInput,
} from "../src/shared/chat-generation";

const sharedBrief = {
  platform: "mobile" as const,
  viewport: { width: 390, height: 844 },
  brandDirection: "Calm and trustworthy",
  audience: "Patients and caregivers",
  content: ["Page title", "Primary action", "Helpful summary"],
  hierarchy: "Title, key information, one primary action, then supporting details",
  typography: { family: "Vazirmatn", style: "Regular", headingSize: 28, bodySize: 16 },
  spacingScale: [8, 12, 16, 24],
  radiusScale: [8, 12, 16],
  palette: {
    source: "curated-default" as const,
    background: "#F7F8FA",
    surface: "#FFFFFF",
    primary: "#28645A",
    accent: "#D8A657",
    text: "#172321",
    muted: "#66736F",
  },
  imagePolicy: "labeled-native-fallback" as const,
  interactionPriorities: ["Appointment booking", "Accessible support"],
  readingDirection: "RTL" as const,
};

function input(
  count: number,
  names = Array.from({ length: count }, (_, index) => `Health screen ${index + 1}`),
): ChatGenerationPlanInput {
  return {
    taskId: "chat-task-001",
    generationId: "generation-chat-task-001",
    documentId: "document-chat-task-001",
    model: "provider/model-exact",
    prompt: "Create a Persian healthcare patient portal with clear, reassuring workflows.",
    intent: { schemaVersion: 1, screenCount: count, target: "mobile", locale: "fa-IR" },
    brief: sharedBrief,
    stages: names.map((title, index) => ({
      title,
      goal: `Complete ${title} for a healthcare patient portal.`,
      purpose: `Help patients complete the ${title.toLocaleLowerCase()} task.`,
      priority: index + 1,
      contentPlaceholders: ["Patient name", "Status", "Next action"],
      dependsOn: index ? [names[index - 1]!] : [],
      navigation: index ? [names[index - 1]!] : [],
      componentOpportunities: ["Consistent appointment card"],
    })),
  };
}

describe("Chat to structured generation contract", () => {
  it.each([
    ["یک صفحه برای اپ بساز", 1],
    ["برای اپ من سه صفحه فارسی طراحی کن", 3],
    ["برای فروشگاه لباس فارسی من سه صفحه موبایل طراحی کن: صفحه اصلی، جزئیات محصول و سبد خرید.\nراست‌به‌چپ، عرض ۳۹۰ پیکسل و لایه‌های قابل‌ویرایش در Figma. از Brand Kit و Skills فعال استفاده کن.", 3],
    ["برای فروشگاه من ۱۰ صفحه طراحی کن", 10],
    ["Create ten screens for my dashboard", 10],
  ])("parses bounded create intent: %s", (prompt, count) => {
    expect(parseChatGenerationIntent(prompt)).toMatchObject({
      kind: "ready",
      intent: { screenCount: count },
    });
  });

  it("routes the Persian acceptance brief from Chat to the deterministic storefront profile", () => {
    const parsed = parseChatGenerationIntent(storefrontBrief);
    if (parsed.kind !== "ready") throw new Error(parsed.kind);
    const task = createMultiScreenDesignRequest({
      ...input(3, ["خانه فروشگاه", "جزئیات محصول", "سبد خرید"]),
      prompt: storefrontBrief,
      intent: parsed.intent,
      brief: { ...sharedBrief, audience: "خریداران پوشاک", brandDirection: "زرشکی و کرم" },
    });
    if (!task.success) throw new Error(task.errors.join(" "));
    const plan = createDesignPlan({ ...task.data.request, professionalVisualVersion: 1 });
    if (!plan.success) throw new Error(plan.errors.join(" "));
    expect(isSampleStorefront(plan.data)).toBe(true);
    expect(plan.data.screens.map(({ id }) => id)).toEqual(task.data.screens.map(({ id }) => id));
  });

  it("does not route edits or multi-device requests into the generation handoff", () => {
    expect(parseChatGenerationIntent("Change the header on screen 3").kind).toBe("not_a_handoff");
    expect(parseChatGenerationIntent("Create 3 screens for mobile and desktop").kind).toBe(
      "unsupported_target",
    );
    expect(parseChatGenerationIntent("Create 11 screens")).toMatchObject({
      kind: "out_of_range",
      screenCount: 11,
    });
  });

  it.each([1, 3, 10])(
    "translates %i Chat stages to renderer-valid RTL screens in stable order",
    (count) => {
      const first = createMultiScreenDesignRequest(input(count));
      const second = createMultiScreenDesignRequest(input(count));
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (!first.success || !second.success) return;
      expect(first.data.screens).toHaveLength(count);
      expect(first.data.screens.map(({ order }) => order)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
      expect(first.data.screens.map(({ name }) => name)).toEqual(
        Array.from({ length: count }, (_, index) => `Health screen ${index + 1}`),
      );
      expect(first.data.screens.every(({ width, height }) => width === 390 && height === 844)).toBe(
        true,
      );
      expect(first.data.direction).toBe("rtl");
      expect(first.data.planFingerprint).toMatch(/^p12-[a-f0-9]{16}$/u);
      expect(first.data.planFingerprint).toBe(second.success ? second.data.planFingerprint : "");
      expect(first.data.request.prompt).toContain("healthcare patient portal");
      expect(first.data.screens[0]?.id).toBe("health-screen-1");
    },
  );

  it("uses the planned app domain and roles instead of an apparel-only flow", () => {
    const result = createMultiScreenDesignRequest(
      input(3, ["Appointments", "Care plan", "Messages"]),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.screens.map(({ name }) => name)).toEqual([
      "Appointments",
      "Care plan",
      "Messages",
    ]);
    expect(result.data.visualContext.appDomain).not.toContain("apparel");
  });

  it("rejects count mismatches, duplicate names, unsupported viewport, and oversized briefs", () => {
    expect(createMultiScreenDesignRequest(input(3, ["Home", "Results"]))).toMatchObject({
      success: false,
    });
    expect(createMultiScreenDesignRequest(input(2, ["Home", "home"]))).toMatchObject({
      success: false,
    });
    expect(
      createMultiScreenDesignRequest({
        ...input(1),
        brief: { ...sharedBrief, viewport: { width: 350, height: 800 } },
      }),
    ).toMatchObject({ success: false });
    expect(
      createMultiScreenDesignRequest({ ...input(1), prompt: "x".repeat(12_001) }),
    ).toMatchObject({ success: false });
  });

  it("rejects unknown dependencies and cyclic screen ordering before native execution", () => {
    expect(
      createMultiScreenDesignRequest(
        input(2, ["Appointments", "Messages"]).stages[0]
          ? {
              ...input(2, ["Appointments", "Messages"]),
              stages: [
                { ...input(2, ["Appointments", "Messages"]).stages[0]!, dependsOn: ["Missing"] },
                input(2, ["Appointments", "Messages"]).stages[1]!,
              ],
            }
          : input(2),
      ),
    ).toMatchObject({ success: false });
    const cyclic = input(2, ["Appointments", "Messages"]);
    cyclic.stages = [
      { ...cyclic.stages[0]!, dependsOn: ["Messages"] },
      { ...cyclic.stages[1]!, dependsOn: ["Appointments"] },
    ];
    expect(createMultiScreenDesignRequest(cyclic)).toMatchObject({ success: false });
  });

  it("rejects unsupported native component references and inconsistent plan dimensions", () => {
    const result = createMultiScreenDesignRequest(input(1));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const componentRef = structuredClone(result.data);
    componentRef.screens[0]!.componentReferences = ["existing-private-component"];
    expect(MultiScreenDesignRequestSchema.safeParse(componentRef).success).toBe(false);
    const wrongSize = structuredClone(result.data);
    wrongSize.screens[0]!.height = 201;
    expect(MultiScreenDesignRequestSchema.safeParse(wrongSize).success).toBe(false);
    const duplicateIds = structuredClone(result.data);
    duplicateIds.screens.push({ ...duplicateIds.screens[0]!, order: 1 });
    (duplicateIds.request as { screenCount: number; screenNames?: string[] }).screenCount = 2;
    (duplicateIds.request as { screenCount: number; screenNames?: string[] }).screenNames = [
      duplicateIds.screens[0]!.name,
      `${duplicateIds.screens[0]!.name} copy`,
    ];
    expect(MultiScreenDesignRequestSchema.safeParse(duplicateIds).success).toBe(false);
    const unsupportedTarget = structuredClone(result.data);
    (unsupportedTarget.request as { target: string }).target = "tablet";
    expect(MultiScreenDesignRequestSchema.safeParse(unsupportedTarget).success).toBe(false);
    const pairedTarget = structuredClone(result.data);
    (pairedTarget.request as { target: string }).target = "both";
    expect(MultiScreenDesignRequestSchema.safeParse(pairedTarget).success).toBe(false);
  });
});
