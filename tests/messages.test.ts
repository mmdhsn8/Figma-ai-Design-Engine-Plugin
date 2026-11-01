import { describe, expect, it } from "vitest";
import { PluginToUISchema, UIToPluginSchema } from "../src/shared/messages";

describe("plugin message contract", () => {
  it("accepts typed validate and generate requests", () => {
    expect(
      UIToPluginSchema.safeParse({ type: "validate", requestId: "r1", json: "{}" }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({ type: "generate", requestId: "r2", json: "{}" }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "generate-multi-screen",
        requestId: "r5",
        json: "{}",
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "generate-multi-screen",
        requestId: "r6",
        json: "{}",
        gap: 1_200,
        maxRowWidth: 6_000,
      }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({
        type: "apply-design-system",
        requestId: "r3",
        json: "{}",
      }).success,
    ).toBe(true);
    expect(
      UIToPluginSchema.safeParse({
        type: "apply-design-system",
        requestId: "r4",
        json: "{}",
        updateOwned: true,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown request types and extra request properties", () => {
    expect(
      UIToPluginSchema.safeParse({ type: "execute", requestId: "r1", json: "{}" }).success,
    ).toBe(false);
    expect(
      UIToPluginSchema.safeParse({ type: "validate", requestId: "r1", json: "{}", code: "" })
        .success,
    ).toBe(false);
  });

  it("accepts successful render responses", () => {
    expect(
      PluginToUISchema.safeParse({
        type: "render-result",
        requestId: "r3",
        success: true,
        frameName: "Sample",
        counts: { frames: 2, texts: 3, rectangles: 1, components: 1, instances: 1 },
        warnings: [],
        fontSelections: [
          {
            requestedFamily: "Arial",
            requestedStyle: "Regular",
            usedFamily: "Arial",
            usedStyle: "Regular",
            fellBack: false,
          },
        ],
        designSystem: {
          namespace: "apparel-core",
          created: ["style:color.brand.primary"],
          reused: [],
          updated: [],
          skipped: [],
          fallbacks: [],
          warnings: [],
        },
      }).success,
    ).toBe(true);
  });

  it("accepts typed validation counts and rejects malformed render summaries", () => {
    expect(
      PluginToUISchema.safeParse({
        type: "validation-result",
        requestId: "r4",
        success: true,
        counts: { frames: 1, texts: 2, rectangles: 1, components: 0, instances: 0 },
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "render-result",
        requestId: "r5",
        success: true,
        frameName: "Sample",
        counts: { frames: 1, texts: 0, rectangles: 0, components: 0, instances: 0 },
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("accepts multi-screen validation, progress, and per-screen outcome reports", () => {
    expect(
      PluginToUISchema.safeParse({
        type: "validation-result",
        requestId: "r6",
        success: true,
        multiScreen: {
          totalScreens: 1,
          nodeCount: 3,
          screens: [
            {
              id: "home",
              name: "خانه",
              width: 390,
              height: 844,
              devicePreset: "mobile",
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "multi-screen-progress",
        requestId: "r6",
        index: 1,
        total: 1,
        screenId: "home",
        screenName: "خانه",
        status: "generated",
      }).success,
    ).toBe(true);
    expect(
      PluginToUISchema.safeParse({
        type: "multi-screen-result",
        requestId: "r6",
        batchId: "commerce",
        batchName: "Commerce",
        totalScreens: 1,
        generatedScreens: 1,
        failedScreens: 0,
        estimatedNodeCount: 3,
        createdNodeCount: 3,
        gap: 120,
        maxRowWidth: 6_000,
        counts: { frames: 1, texts: 2, rectangles: 0, components: 0, instances: 0 },
        screens: [
          {
            id: "home",
            name: "خانه",
            width: 390,
            height: 844,
            status: "generated",
            counts: { frames: 1, texts: 2, rectangles: 0, components: 0, instances: 0 },
            warnings: [],
          },
        ],
        warnings: [],
        fontSelections: [],
      }).success,
    ).toBe(true);
  });
});
