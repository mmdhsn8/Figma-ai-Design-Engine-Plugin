import { describe, expect, it } from "vitest";
import phase1 from "../src/samples/sample-design.json";
import phase2 from "../src/samples/phase-2-storefront.json";
import phase3 from "../src/samples/phase-3-design-system.json";
import phase4 from "../src/samples/phase-4-multi-screen.json";
import visualDemo from "../src/samples/phase-4.5-visual-design.json";
import ltrFixture from "../src/samples/visual-ltr-fixture.json";
import { auditVisualQuality, contrastRatio } from "../src/shared/visual-quality";
import { parseDesignValue } from "../src/shared/schema";
import { parseMultiScreenValue } from "../src/shared/multi-screen-schema";
import type { DesignSpec } from "../src/shared/schema";

describe("visual quality preflight", () => {
  it("keeps every legacy sample valid and accepts the offline visual demo and LTR fixture", () => {
    expect(parseDesignValue(phase1).success).toBe(true);
    expect(parseDesignValue(phase2).success).toBe(true);
    expect(parseDesignValue(phase3).success).toBe(true);
    expect(parseMultiScreenValue(phase4).success).toBe(true);
    const demo = parseMultiScreenValue(visualDemo);
    if (!demo.success) throw new Error(demo.errors.join("\n"));
    expect(demo.data.screens).toHaveLength(10);
    const containsVector = (nodes: DesignSpec["document"]["children"]): boolean =>
      nodes.some(
        (node) =>
          node.type === "vector" || (node.type === "frame" && containsVector(node.children)),
      );
    expect(demo.data.screens.some((screen) => containsVector(screen.children))).toBe(true);
    expect(parseDesignValue(ltrFixture).success).toBe(true);

    const compositions = new Set(
      demo.data.screens.map((screen) => screen.children.map((node) => node.type).join(",")),
    );
    expect(compositions.size).toBeGreaterThan(2);
  });

  it("uses WCAG luminance math and reports actionable paths without a quality score", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("invalid", "#FFFFFF")).toBeUndefined();
    const audit = auditVisualQuality(phase1 as DesignSpec);
    expect(audit).toMatchObject({ screenCount: 1, estimatedNativeNodes: expect.any(Number) });
    expect(audit).not.toHaveProperty("score");
    expect(audit.diagnostics.every((diagnostic) => diagnostic.path && diagnostic.action)).toBe(
      true,
    );
  });

  it("detects small text, low contrast, missing image description and small targets", () => {
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Preflight fixture",
        width: 390,
        height: 844,
        background: "#FFFFFF",
        children: [
          {
            type: "text",
            name: "Fine print",
            text: "تنظیمات",
            fontSize: 10,
            color: "#CCCCCC",
            x: 8,
            y: 8,
          },
          {
            type: "rectangle",
            name: "Compact action",
            width: 32,
            height: 32,
            fill: "#2563EB",
            x: 8,
            y: 32,
            qualityRole: "button",
          },
          {
            type: "image",
            name: "Product photo",
            width: 100,
            height: 100,
            assetId: "item-photo",
            x: 8,
            y: 72,
          },
        ],
      },
    };
    const audit = auditVisualQuality(design);
    expect(audit.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["tiny-text", "low-contrast", "small-touch-target", "missing-alt"]),
    );
    expect(audit.diagnostics.find(({ code }) => code === "low-contrast")?.path).toBe(
      "document.children[0]",
    );
  });

  it("measures contrast only for single opaque solid paints", () => {
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Unmeasurable paint fixture",
        width: 320,
        height: 240,
        background: "#FFFFFF",
        children: [
          {
            type: "frame",
            name: "Gradient background",
            x: 0,
            y: 0,
            width: 200,
            height: 120,
            visual: {
              fills: [
                {
                  type: "linear",
                  stops: [
                    { position: 0, color: "#FFFFFF" },
                    { position: 1, color: "#000000" },
                  ],
                },
              ],
            },
            children: [
              {
                type: "text",
                name: "Gradient text",
                text: "Contrast depends on position",
                fontSize: 16,
                color: "#CCCCCC",
                x: 8,
                y: 8,
                visual: { fills: [{ type: "solid", color: "#CCCCCC", opacity: 0.5 }] },
              },
            ],
          },
        ],
      },
    };

    expect(parseDesignValue(design).success).toBe(true);
    expect(auditVisualQuality(design).diagnostics.map(({ code }) => code)).not.toContain(
      "low-contrast",
    );
  });

  it("honors explicit quality exceptions without hiding other checks", () => {
    const design = structuredClone(phase1) as unknown as DesignSpec;
    const text = design.document.children.find((node) => node.type === "text");
    if (!text || text.type !== "text") throw new Error("Fixture text is missing.");
    text.fontSize = 10;
    text.qualityExceptions = ["tiny-text"];
    const audit = auditVisualQuality(design);
    expect(audit.diagnostics.some(({ code }) => code === "tiny-text")).toBe(false);
  });

  it("validates native gradients, strokes, effects, vectors and rejects bad references/assets", () => {
    const rich: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Native visual features",
        width: 320,
        height: 240,
        background: "#FFFFFF",
        children: [
          {
            type: "rectangle",
            name: "Gradient card",
            x: 12,
            y: 12,
            width: 120,
            height: 80,
            fill: "#FFFFFF",
            cornerRadii: { topLeft: 16, topRight: 8, bottomRight: 16, bottomLeft: 8 },
            visual: {
              opacity: 0.96,
              fills: [
                {
                  type: "linear",
                  angle: 24,
                  stops: [
                    { position: 0, color: "#123B5D" },
                    { position: 1, color: "#2563EB" },
                  ],
                },
              ],
              strokes: [{ color: "#E2E8F0", width: 1, align: "inside", dashPattern: [3, 2] }],
              effects: [
                {
                  type: "drop-shadow",
                  color: "#123B5D",
                  opacity: 0.16,
                  offsetX: 0,
                  offsetY: 5,
                  radius: 16,
                  spread: 0,
                },
                { type: "background-blur", radius: 4 },
              ],
            },
          },
          {
            type: "vector",
            name: "Vector check",
            x: 152,
            y: 18,
            width: 32,
            height: 32,
            pathData: "M 2 16 L 12 26 L 30 4 Z",
            fill: "#16A34A",
          },
        ],
      },
    };
    expect(parseDesignValue(rich).success).toBe(true);

    const invalidOpacity = structuredClone(rich);
    const rectangle = invalidOpacity.document.children[0];
    if (rectangle.type !== "rectangle") throw new Error("Visual fixture node changed.");
    rectangle.visual!.opacity = 1.1;
    expect(parseDesignValue(invalidOpacity).success).toBe(false);

    const invalidGradient = structuredClone(rich);
    const invalidRectangle = invalidGradient.document.children[0];
    if (invalidRectangle.type !== "rectangle") throw new Error("Visual fixture node changed.");
    invalidRectangle.visual!.fills![0] = {
      type: "linear",
      stops: [
        { position: 0.5, color: "#123B5D" },
        { position: 0.5, color: "#2563EB" },
      ],
    };
    expect(parseDesignValue(invalidGradient).success).toBe(false);

    const missingImage: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Missing asset",
        width: 320,
        height: 240,
        background: "#FFFFFF",
        children: [
          { type: "image", name: "Missing", assetId: "absent", x: 1, y: 1, width: 12, height: 12 },
        ],
      },
    };
    const imageResult = parseDesignValue(missingImage);
    expect(imageResult.success).toBe(false);
    if (!imageResult.success)
      expect(imageResult.errors.join(" ")).toContain("references missing asset “absent”");

    const unresolvedVisualToken = structuredClone(phase3) as unknown as DesignSpec;
    const node = unresolvedVisualToken.document.children.find(
      (candidate) => candidate.type === "text",
    );
    if (!node || node.type !== "text") throw new Error("Phase 3 fixture text node is missing.");
    node.visual = { fills: [{ type: "solid", color: { token: "color.missing.visual" } }] };
    const tokenResult = parseDesignValue(unresolvedVisualToken);
    expect(tokenResult.success).toBe(false);
    if (!tokenResult.success)
      expect(tokenResult.errors.join(" ")).toContain("references missing token");
  });

  it("flags long fixed text as a heuristic and repeated non-instance frame patterns", () => {
    const text = {
      type: "text" as const,
      name: "Long label",
      text: "محتوای طولانی ".repeat(15),
      fontSize: 14,
      color: "#0F172A",
      width: 80,
      height: 24,
      textAutoResize: "height" as const,
      x: 1,
      y: 1,
    };
    const repeated = (): DesignSpec["document"]["children"][number] => ({
      type: "frame",
      name: "Repeated row",
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      children: [
        { type: "ellipse", name: "Icon", x: 0, y: 0, width: 24, height: 24, fill: "#2563EB" },
        text,
      ],
    });
    const design: DesignSpec = {
      schemaVersion: "1.0.0",
      document: {
        name: "Repeated long rows",
        width: 390,
        height: 844,
        background: "#FFFFFF",
        children: [repeated(), repeated(), repeated()],
      },
    };
    const codes = auditVisualQuality(design).diagnostics.map(({ code }) => code);
    expect(codes).toContain("overflow-risk");
    expect(codes).toContain("duplicated-pattern");
  });
});
