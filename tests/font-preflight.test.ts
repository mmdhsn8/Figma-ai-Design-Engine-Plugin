import { describe, expect, it } from "vitest";
import phase3 from "../src/samples/phase-3-design-system.json";
import phase45 from "../src/samples/phase-4.5-visual-design.json";
import { collectFontRequirements, unavailableFontWarnings } from "../src/plugin/font-preflight";
import { parseMultiScreenValue } from "../src/shared/multi-screen-schema";
import { parseDesignValue } from "../src/shared/schema";

describe("read-only font preflight", () => {
  it("collects declared text styles and requirements across screens/components once", () => {
    const parsed = parseMultiScreenValue(phase45);
    if (!parsed.success) throw new Error(parsed.errors.join("\n"));
    const fonts = collectFontRequirements(parsed.data);
    expect(fonts).toContainEqual({ family: "Arial", style: "Bold" });
    expect(fonts).toContainEqual({ family: "Arial", style: "Regular" });
    expect(new Set(fonts.map(({ family, style }) => `${family}/${style}`)).size).toBe(fonts.length);
  });

  it("warns about missing requested styles and a missing Inter fallback", () => {
    const parsed = parseDesignValue(phase3);
    if (!parsed.success) throw new Error(parsed.errors.join("\n"));
    const requirements = collectFontRequirements(parsed.data);
    const warnings = unavailableFontWarnings(requirements, [{ family: "Inter", style: "Regular" }]);
    expect(warnings.some((warning) => warning.includes("unavailable in this Figma editor"))).toBe(
      true,
    );
    expect(warnings).not.toContain(
      "Inter Regular fallback is also unavailable; text generation may stop until a usable font is available.",
    );
    expect(
      unavailableFontWarnings(requirements, []).some((warning) =>
        warning.includes("Inter Regular fallback is also unavailable"),
      ),
    ).toBe(true);
  });
});
