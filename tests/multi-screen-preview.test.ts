import { describe, expect, it } from "vitest";
import phase4 from "../src/samples/phase-4-multi-screen.json";
import { PluginToUISchema } from "../src/shared/messages";
import {
  createMultiScreenPreview,
  multiScreenProgressText,
  multiScreenResultLines,
} from "../src/shared/multi-screen-preview";
import { parseMultiScreenValue } from "../src/shared/multi-screen-schema";

describe("multi-screen UI preview and reporting", () => {
  it("previews ordered screens, dimensions, groups, node estimate, and shared-asset reuse", () => {
    const parsed = parseMultiScreenValue(phase4);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const preview = createMultiScreenPreview(parsed.data, parsed.nodeCount);
    expect(preview).toMatchObject({
      id: "persian-commerce-app",
      estimatedNodeCount: parsed.nodeCount,
      screens: expect.arrayContaining([
        expect.objectContaining({
          id: "tablet-catalog",
          width: 834,
          height: 1112,
          devicePreset: "tablet",
        }),
      ]),
    });
    expect(preview.screens).toHaveLength(10);
    expect(preview.sharedAssetSummary).toContain("resolved once");
    expect(preview.sharedAssetSummary).toContain("reused");
  });

  it("formats progress and per-screen failure details honestly", () => {
    const progress = PluginToUISchema.parse({
      type: "multi-screen-progress",
      requestId: "req-1",
      index: 2,
      total: 10,
      screenId: "home",
      screenName: "خانه",
      status: "started",
    });
    expect(progress.type).toBe("multi-screen-progress");
    if (progress.type === "multi-screen-progress") {
      expect(multiScreenProgressText(progress)).toContain("1 of 10 attempted");
    }

    const report = PluginToUISchema.parse({
      type: "multi-screen-result",
      requestId: "req-1",
      batchId: "commerce",
      batchName: "Commerce",
      totalScreens: 2,
      generatedScreens: 1,
      failedScreens: 1,
      estimatedNodeCount: 45,
      createdNodeCount: 40,
      gap: 120,
      maxRowWidth: 6_000,
      counts: { frames: 2, texts: 10, rectangles: 3, components: 1, instances: 4 },
      screens: [
        {
          id: "home",
          name: "خانه",
          width: 390,
          height: 844,
          status: "generated",
          counts: { frames: 1, texts: 8, rectangles: 1, components: 0, instances: 2 },
          warnings: [],
        },
        {
          id: "cart",
          name: "سبد خرید",
          width: 390,
          height: 900,
          status: "failed",
          counts: { frames: 0, texts: 0, rectangles: 0, components: 0, instances: 0 },
          error: "Mock failure",
          warnings: [],
        },
      ],
      warnings: ["One screen failed."],
      fontSelections: [],
    });
    expect(report.type).toBe("multi-screen-result");
    if (report.type === "multi-screen-result") {
      expect(multiScreenResultLines(report)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("40 native nodes created"),
          "cart: Mock failure",
          "One screen failed.",
        ]),
      );
    }
  });
});
