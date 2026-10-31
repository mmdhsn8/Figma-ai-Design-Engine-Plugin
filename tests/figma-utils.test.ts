import { describe, expect, it } from "vitest";
import { hexToRgb } from "../src/plugin/figma-utils";

describe("hexToRgb", () => {
  it("converts 6-digit hex to normalized 0–1 channels", () => {
    expect(hexToRgb("#FF8000")).toEqual({ r: 1, g: 128 / 255, b: 0 });
  });

  it("rejects invalid hex", () => {
    expect(() => hexToRgb("#FFF")).toThrow(/6-digit/);
  });
});
