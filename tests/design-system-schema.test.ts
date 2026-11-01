import { describe, expect, it } from "vitest";
import phase1 from "../src/samples/sample-design.json";
import phase2 from "../src/samples/phase-2-storefront.json";
import phase3 from "../src/samples/phase-3-design-system.json";
import { parseDesignText, parseDesignValue, type DesignSpec } from "../src/shared/schema";
import { resolveDesignSystemTokens } from "../src/plugin/design-system/token-resolver";
import { planDesignSystemApply } from "../src/plugin/design-system/apply-design-system";

describe("design-system schema and token resolution", () => {
  it("keeps both prior schemas valid and accepts the additive Phase 3 sample", () => {
    expect(parseDesignValue(phase1).success).toBe(true);
    expect(parseDesignValue(phase2).success).toBe(true);
    const parsed = parseDesignValue(phase3);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe("1.0.0");
      expect(parsed.data.designSystem?.namespace).toBe("apparel-core");
      expect(parsed.data.designSystem?.components).toHaveLength(4);
    }
  });

  it("resolves color, spacing, radius, border and Persian typography references", () => {
    const parsed = parseDesignValue(phase3);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { spec, tables } = resolveDesignSystemTokens(parsed.data);
    expect(tables.colors.get("color.brand.deepNavy")).toBe("#123B5D");
    expect(tables.spacing.get("spacing.lg")).toBe(16);
    expect(tables.radii.get("radius.card")).toBe(12);
    expect(tables.borders.get("border.default")).toEqual({ color: "#E2E8F0", width: 1 });
    const title = spec.document.children[0];
    expect(title).toMatchObject({
      type: "text",
      text: "محصولات منتخب",
      fontFamily: "Arial",
      fontSize: 24,
      textAlign: "right",
      color: "#123B5D",
    });
    expect(planDesignSystemApply(parsed.data)).toMatchObject({
      namespace: "apparel-core",
      colors: 11,
      typography: 4,
      plannedPaintStyles: 11,
      plannedTextStyles: 4,
      plannedMasters: 4,
    });
  });

  it("rejects missing and cross-category references before mutation", () => {
    const missing = structuredClone(phase3) as unknown as DesignSpec;
    missing.document.background = { token: "color.notFound" };
    const missingResult = parseDesignValue(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) expect(missingResult.errors.join(" ")).toContain("missing token");

    const crossType = structuredClone(phase3) as unknown as DesignSpec;
    const title = crossType.document.children[0];
    if (title.type === "text") title.color = { token: "spacing.lg" };
    const crossTypeResult = parseDesignValue(crossType);
    expect(crossTypeResult.success).toBe(false);
    if (!crossTypeResult.success)
      expect(crossTypeResult.errors.join(" ")).toContain("expects a color token");
  });

  it("rejects alias cycles, duplicate tokens across categories, and duplicate component keys", () => {
    const cyclic = structuredClone(phase3) as unknown as DesignSpec;
    cyclic.designSystem!.colors["color.brand.deepNavy"] = { token: "color.action.primary" };
    cyclic.designSystem!.colors["color.action.primary"] = { token: "color.brand.deepNavy" };
    const cycleResult = parseDesignValue(cyclic);
    expect(cycleResult.success).toBe(false);
    if (!cycleResult.success) expect(cycleResult.errors.join(" ")).toContain("alias cycle");

    const duplicateToken = structuredClone(phase3) as unknown as DesignSpec;
    duplicateToken.designSystem!.spacing!.aliases["color.brand.deepNavy"] = 8;
    const duplicateResult = parseDesignValue(duplicateToken);
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success)
      expect(duplicateResult.errors.join(" ")).toMatch(/duplicated|prefix/);

    const duplicateComponent = structuredClone(phase3) as unknown as DesignSpec;
    const components = duplicateComponent.designSystem!.components!;
    components[1].key = components[0].key;
    const duplicateKeyResult = parseDesignValue(duplicateComponent);
    expect(duplicateKeyResult.success).toBe(false);
    if (!duplicateKeyResult.success)
      expect(duplicateKeyResult.errors.join(" ")).toContain("component key");
  });

  it("enforces six-digit alpha-free colors, typography bounds, and token-count limits", () => {
    const alpha = structuredClone(phase3) as unknown as DesignSpec;
    alpha.designSystem!.colors["color.brand.deepNavy"] = "#123B5D80";
    const alphaResult = parseDesignValue(alpha);
    expect(alphaResult.success).toBe(false);

    const badTypography = structuredClone(phase3) as unknown as DesignSpec;
    badTypography.designSystem!.typography["typography.heading"].fontSize = 0;
    expect(parseDesignValue(badTypography).success).toBe(false);

    const outOfRangeReference = structuredClone(phase3) as unknown as DesignSpec;
    outOfRangeReference.designSystem!.spacing!.aliases["spacing.tooLarge"] = 700;
    outOfRangeReference.designSystem!.typography["typography.heading"].fontSize = {
      token: "spacing.tooLarge",
    };
    const rangeResult = parseDesignValue(outOfRangeReference);
    expect(rangeResult.success).toBe(false);
    if (!rangeResult.success)
      expect(rangeResult.errors.join(" ")).toContain("outside the supported range");

    const tooMany = structuredClone(phase3) as unknown as DesignSpec;
    for (let index = 0; index < 200; index++) {
      tooMany.designSystem!.colors[`color.extra.token${index}`] = "#123456";
    }
    const limitResult = parseDesignValue(tooMany);
    expect(limitResult.success).toBe(false);
    if (!limitResult.success) expect(limitResult.errors.join(" ")).toContain("limit is 200");
  });

  it("reports malformed JSON and keeps schema 1.0.0 unchanged", () => {
    expect(parseDesignText("{").success).toBe(false);
    const repeatedJsonKey = parseDesignText(
      '{"schemaVersion":"1.0.0","schemaVersion":"1.0.0","document":{}}',
    );
    expect(repeatedJsonKey.success).toBe(false);
    if (!repeatedJsonKey.success)
      expect(repeatedJsonKey.errors.join(" ")).toContain("Duplicate JSON key");
    expect(phase1.schemaVersion).toBe("1.0.0");
    expect(phase2.schemaVersion).toBe("1.0.0");
    expect(phase3.schemaVersion).toBe("1.0.0");
  });
});
