import { describe, expect, it } from "vitest";
import {
  auditNativeSection,
  auditStorefrontDesign,
  nativeContrastRatio,
  type NativeVisualNode,
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
      visible: false,
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
    expect(findings.find(({ code }) => code === "missing-ref")).toMatchObject({
      ref: "missing",
      expected: "present",
      actual: "missing",
    });
    expect(findings.find(({ code }) => code === "hidden-node")).toMatchObject({
      ref: "root",
      expected: "visible=true",
      actual: "visible=false",
    });
    expect(findings.find(({ code }) => code === "overlapping-auto-layout")).toMatchObject({
      refs: ["empty", "overlap"],
      expected: "non-overlapping children",
    });
    expect(
      JSON.parse(findings.find(({ code }) => code === "overlapping-auto-layout")!.actual),
    ).toEqual({
      overlapWidth: 44,
      overlapHeight: 30,
      overlapArea: 1_320,
    });
    expect(findings.filter(({ code }) => code === "low-contrast").map(({ ref }) => ref)).toContain(
      "transparent",
    );
    expect(
      findings.filter(({ code }) => code === "low-contrast").map(({ ref }) => ref),
    ).not.toContain("large-text");
    expect(nativeContrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("reproduces the five-finding live QA shape without rounding away failing contrast", () => {
    const root: NativeVisualNode = {
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
      layoutMode: "NONE",
      children: [
        ...["clip-a", "clip-b", "clip-c"].map((ref, index) => ({
          ref,
          type: "FRAME",
          name: ref,
          x: index === 0 ? 190 : index === 2 ? -0.25 : 80,
          y: index === 1 ? 95.5 : 4,
          width: 30,
          height: 20,
          bounds: {
            x: index === 0 ? 190 : index === 2 ? -0.25 : 80,
            y: index === 1 ? 95.5 : 4,
            width: 30,
            height: 20,
          },
          visible: true,
        })),
        {
          ref: "contrast-450",
          type: "TEXT",
          name: "Near threshold",
          text: "Text",
          x: 4,
          y: 4,
          width: 60,
          height: 20,
          bounds: { x: 4, y: 4, width: 60, height: 20 },
          visible: true,
          textColor: "#8B6F7D",
          fontSize: 14,
        },
        {
          ref: "contrast-361",
          type: "TEXT",
          name: "Low contrast",
          text: "Text",
          x: 4,
          y: 30,
          width: 60,
          height: 20,
          bounds: { x: 4, y: 30, width: 60, height: 20 },
          visible: true,
          textColor: "#91875A",
          fontSize: 14,
        },
      ],
    };
    const findings = auditNativeSection(
      [root],
      ["root", "clip-a", "clip-b", "clip-c", "contrast-450", "contrast-361"],
    );
    expect(findings.map(({ code }) => code)).toEqual([
      "clipped-child",
      "clipped-child",
      "clipped-child",
      "low-contrast",
      "low-contrast",
    ]);
    const nearThreshold = findings.find(({ ref }) => ref === "contrast-450")!;
    expect(nativeContrastRatio("#8B6F7D", "#FFFFFF")).toBeLessThan(4.5);
    expect(Number.parseFloat(nearThreshold.actual)).toBeCloseTo(4.499, 3);
    expect(nearThreshold.actual).not.toBe("4.50:1 contrast");
    expect(
      Number.parseFloat(findings.find(({ ref }) => ref === "contrast-361")!.actual),
    ).toBeCloseTo(3.61, 2);
  });

  it("composites translucent fills before measuring text contrast", () => {
    const roots: NativeVisualNode[] = [
      {
        ref: "screen",
        type: "FRAME",
        name: "Screen",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        visible: true,
        fill: "#FFFFFF",
        children: [
          {
            ref: "surface",
            type: "FRAME",
            name: "Translucent surface",
            x: 0,
            y: 0,
            width: 100,
            height: 60,
            visible: true,
            fill: "#000000",
            fillOpacity: 0.5,
            children: [
              {
                ref: "text",
                type: "TEXT",
                name: "Text",
                text: "Label",
                x: 4,
                y: 4,
                width: 60,
                height: 20,
                visible: true,
                textColor: "#999999",
                fontSize: 14,
              },
            ],
          },
        ],
      },
    ];
    expect(auditNativeSection(roots, ["text"]).find(({ ref }) => ref === "text")?.actual).toMatch(
      /^1\./u,
    );
  });

  it("uses native float RGB when 8-bit hex rounding would cross the contrast threshold", () => {
    const findings = auditNativeSection(
      [
        {
          ref: "screen",
          type: "FRAME",
          name: "Screen",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          visible: true,
          fill: "#FFFFFF",
          fillRGB: { r: 1, g: 1, b: 1 },
          children: [
            {
              ref: "native-float-text",
              type: "TEXT",
              name: "Near-threshold native text",
              text: "Label",
              x: 4,
              y: 4,
              width: 100,
              height: 24,
              visible: true,
              textColor: "#8B6F7D",
              textColorRGB: { r: 0.543138, g: 111 / 255, b: 125 / 255 },
              fontSize: 14,
            },
          ],
        },
      ],
      ["native-float-text"],
    );

    expect(nativeContrastRatio("#8B6F7D", "#FFFFFF")).toBeLessThan(4.5);
    expect(findings.filter(({ code }) => code === "low-contrast")).toEqual([]);
  });

  it("distinguishes unclipped overflow from clipping and respects transformed RTL Auto Layout bounds", () => {
    const outside: NativeVisualNode = {
      ref: "outside",
      type: "FRAME",
      name: "Outside",
      x: 220,
      y: 0,
      width: 40,
      height: 30,
      bounds: { x: 220, y: 0, width: 40, height: 30 },
      visible: true,
    };
    const unclipped: NativeVisualNode = {
      ref: "unclipped",
      type: "FRAME",
      name: "Unclipped parent",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      visible: true,
      clipsContent: false,
      children: [outside],
    };
    expect(
      auditNativeSection([unclipped], ["outside"]).some(({ code }) => code === "clipped-child"),
    ).toBe(false);
    const explicitlyClipped = { ...unclipped, clipsContent: true };
    expect(
      auditNativeSection([explicitlyClipped], ["outside"]).find(
        ({ code }) => code === "clipped-child",
      ),
    ).toMatchObject({
      ref: "outside",
      message: expect.stringContaining("cannot determine whether that clip is intentional"),
    });

    const rtlLayout: NativeVisualNode = {
      ref: "rtl-root",
      type: "FRAME",
      name: "RTL Auto Layout",
      x: 100,
      y: 200,
      width: 200,
      height: 100,
      bounds: { x: 100, y: 200, width: 200, height: 100 },
      absoluteTransform: [
        [-1, 0, 300],
        [0, 1, 200],
      ],
      visible: true,
      fill: "#FFFFFF",
      clipsContent: true,
      layoutMode: "HORIZONTAL",
      padding: { top: 10, right: 16, bottom: 10, left: 12 },
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      children: [
        {
          ref: "rtl-nested",
          type: "FRAME",
          name: "Nested layout",
          x: 12,
          y: 10,
          width: 160,
          height: 80,
          bounds: { x: 128, y: 210, width: 160, height: 80 },
          absoluteTransform: [
            [-1, 0, 288],
            [0, 1, 210],
          ],
          visible: true,
          clipsContent: true,
          layoutMode: "VERTICAL",
          padding: { top: 8, right: 8, bottom: 8, left: 8 },
          children: [
            {
              ref: "rtl-copy",
              type: "TEXT",
              name: "RTL copy",
              text: "متن فارسی",
              x: 8,
              y: 8,
              width: 100,
              height: 24,
              bounds: { x: 180, y: 218, width: 100, height: 24 },
              absoluteTransform: [
                [-1, 0, 280],
                [0, 1, 218],
              ],
              visible: true,
              textColor: "#000000",
              fontSize: 16,
              layoutSizingHorizontal: "FILL",
            },
          ],
        },
      ],
    };
    expect(auditNativeSection([rtlLayout], ["rtl-root", "rtl-nested", "rtl-copy"])).toEqual([]);
  });
});
