import { describe, expect, it } from "vitest";
import { crc32ForPngChunk, ONE_PIXEL_PNG } from "./visual-fixtures";
import {
  embeddedImageBytes,
  inspectEmbeddedImage,
  isFigmaPathData,
  parseSafeSvg,
  scaleFigmaPathData,
} from "../src/shared/visual-assets";

describe("offline visual asset safety", () => {
  it("validates local PNG headers, dimensions and byte limits", () => {
    expect(inspectEmbeddedImage(ONE_PIXEL_PNG, "image/png")).toEqual({
      valid: true,
      width: 1,
      height: 1,
    });
    expect(embeddedImageBytes(ONE_PIXEL_PNG)).toBeInstanceOf(Uint8Array);
    expect(inspectEmbeddedImage("not base64", "image/png").error).toContain("canonical base64");

    const oversizedBytes = embeddedImageBytes(ONE_PIXEL_PNG);
    oversizedBytes[16] = 0;
    oversizedBytes[17] = 0;
    oversizedBytes[18] = 0x13;
    oversizedBytes[19] = 0x88; // 5,000 px wide
    const headerCrc = crc32ForPngChunk(oversizedBytes.slice(12, 29));
    oversizedBytes[29] = headerCrc >>> 24;
    oversizedBytes[30] = (headerCrc >>> 16) & 0xff;
    oversizedBytes[31] = (headerCrc >>> 8) & 0xff;
    oversizedBytes[32] = headerCrc & 0xff;
    const overDimension = Buffer.from(oversizedBytes).toString("base64");
    expect(inspectEmbeddedImage(overDimension, "image/png").error).toContain("4,096 px");
    expect(inspectEmbeddedImage("A".repeat(350_000), "image/png").error).toContain("256 KiB");

    const corruptBytes = embeddedImageBytes(ONE_PIXEL_PNG);
    corruptBytes[corruptBytes.length - 1] ^= 0xff;
    expect(
      inspectEmbeddedImage(Buffer.from(corruptBytes).toString("base64"), "image/png").error,
    ).toContain("checksums are corrupt");
  });

  it.each([
    ["bit depth", 24, 3],
    ["color type", 25, 1],
    ["compression method", 26, 1],
    ["filter method", 27, 1],
    ["interlace method", 28, 2],
  ] as const)("rejects PNGs with invalid IHDR %s despite a valid checksum", (_, index, value) => {
    const invalidHeader = embeddedImageBytes(ONE_PIXEL_PNG);
    invalidHeader[index] = value;
    const headerCrc = crc32ForPngChunk(invalidHeader.slice(12, 29));
    invalidHeader[29] = headerCrc >>> 24;
    invalidHeader[30] = (headerCrc >>> 16) & 0xff;
    invalidHeader[31] = (headerCrc >>> 8) & 0xff;
    invalidHeader[32] = headerCrc & 0xff;

    expect(
      inspectEmbeddedImage(Buffer.from(invalidHeader).toString("base64"), "image/png").valid,
    ).toBe(false);
  });

  it("accepts a deliberately small editable SVG path subset", () => {
    const safe = parseSafeSvg(
      '<svg viewBox="0 0 24 24"><path id="check" d="M 3 12 L 9 18 L 21 4 Z" fill="#2563EB"/></svg>',
    );
    expect(safe).toMatchObject({
      success: true,
      data: {
        width: 24,
        height: 24,
        paths: [{ name: "check", fill: "#2563EB" }],
      },
    });
  });

  it.each([
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 24 24"><path d="M 0 0 L 2 2 Z" fill="url(https://example.invalid/x)"/></svg>',
    '<svg viewBox="0 0 24 24"><g><path d="M 0 0 L 2 2 Z"/></g></svg>',
    '<svg viewBox="0 0 24 24"><path transform="scale(2)" d="M 0 0 L 2 2 Z"/></svg>',
    '<svg viewBox="0 0 24 24"><path id="layer/with/slashes" d="M 0 0 L 2 2 Z"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="m 0 0 l 2 2 z"/></svg>',
    '<svg viewBox="1 0 24 24"><path d="M 0 0 L 2 2 Z"/></svg>',
  ])("rejects unsafe or unsupported SVG: %s", (svg) => {
    expect(parseSafeSvg(svg).success).toBe(false);
  });

  it("bounds vector paths and scales only validated absolute coordinates", () => {
    expect(isFigmaPathData("M 0 0 C 1 2 3 4 5 6 Z")).toBe(true);
    expect(isFigmaPathData("M 0 0 A 3 3 0 0 1 6 6 Z")).toBe(false);
    expect(isFigmaPathData(`M 0 0 L ${"1 ".repeat(2_100)} Z`)).toBe(false);
    expect(scaleFigmaPathData("M 1 2 L 3 4 Z", 2, 3)).toBe("M 2 6 L 6 12 Z");
    expect(() => scaleFigmaPathData("m 1 2 l 3 4", 2, 2)).toThrow(/invalid/i);
  });
});
