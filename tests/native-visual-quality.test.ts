import { describe, expect, it } from "vitest";
import {
  auditNativeSection,
  auditStorefrontDesign,
  nativeContrastRatio,
} from "../src/shared/native-visual-quality";
import {
  englishMobileStorefront,
  persianDesktopStorefront,
  persianMobileStorefront,
  reported23OperationMobileProxy,
} from "./professional-design-fixtures";

const codes = (input: Parameters<typeof auditStorefrontDesign>[0]) =>
  auditStorefrontDesign(input).map(({ code }) => code);

describe("professional native-design quality baseline", () => {
  it("records the 23-operation Persian 390×844 wireframe proxy and its measurable gaps", () => {
    expect(reported23OperationMobileProxy.reportedOperations).toBe(23);
    expect(reported23OperationMobileProxy.reportedStages).toBe(4);
    const count = (nodes: typeof reported23OperationMobileProxy.nodes): number =>
      nodes.reduce((total, node) => total + 1 + count(node.children ?? []), 0);
    expect(count(reported23OperationMobileProxy.nodes)).toBe(23);
    const issues = codes(reported23OperationMobileProxy);
    expect(issues).toEqual(
      expect.arrayContaining([
        "missing-section",
        "insufficient-hierarchy",
        "undersized-target",
        "inconsistent-cards",
        "excessive-whitespace",
      ]),
    );
  });

  it.each([persianMobileStorefront, persianDesktopStorefront, englishMobileStorefront])(
    "meets deterministic storefront structure, hierarchy, density, CTA, and fallback criteria ($viewport.width×$viewport.height)",
    (fixture) => expect(auditStorefrontDesign(fixture)).toEqual([]),
  );

  it("detects missing refs, blank text, clipped children, auto-layout overlap, and weak measurable contrast", () => {
    const bad = {
      ref: "root",
      type: "FRAME",
      name: "Root",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      visible: true,
      fill: "#FFFFFF",
      clipsContent: true,
      layoutMode: "HORIZONTAL" as const,
      children: [
        {
          ref: "empty",
          type: "TEXT",
          name: "Empty",
          text: " ",
          x: 4,
          y: 4,
          width: 80,
          height: 30,
          bounds: { x: 4, y: 4, width: 80, height: 30 },
          visible: true,
          textColor: "#CCCCCC",
          fontSize: 14,
        },
        {
          ref: "outside",
          type: "FRAME",
          name: "Outside",
          x: 250,
          y: 4,
          width: 80,
          height: 30,
          bounds: { x: 250, y: 4, width: 80, height: 30 },
          visible: true,
        },
        {
          ref: "overlap",
          type: "FRAME",
          name: "Overlap",
          x: 40,
          y: 4,
          width: 80,
          height: 30,
          bounds: { x: 40, y: 4, width: 80, height: 30 },
          visible: true,
        },
        {
          ref: "transparent",
          type: "TEXT",
          name: "Transparent text",
          text: "Visible only faintly",
          x: 130,
          y: 44,
          width: 60,
          height: 20,
          bounds: { x: 130, y: 44, width: 60, height: 20 },
          visible: true,
          textColor: "#CCCCCC",
          fontSize: 14,
          opacity: 0.5,
        },
        {
          ref: "large-text",
          type: "TEXT",
          name: "Large text",
          text: "Hero heading",
          x: 130,
          y: 70,
          width: 60,
          height: 24,
          bounds: { x: 130, y: 70, width: 60, height: 24 },
          visible: true,
          textColor: "#777777",
          fontSize: 24,
        },
      ],
    };
    const findings = auditNativeSection([bad], ["root", "missing"]);
    expect(findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "missing-ref",
        "empty-text",
        "clipped-child",
        "overlapping-auto-layout",
        "low-contrast",
      ]),
    );
    expect(
      findings.filter(({ code }) => code === "low-contrast").map(({ ref }) => ref),
    ).not.toContain("transparent");
    expect(
      findings.filter(({ code }) => code === "low-contrast").map(({ ref }) => ref),
    ).not.toContain("large-text");
    expect(nativeContrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });
});
