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
});
