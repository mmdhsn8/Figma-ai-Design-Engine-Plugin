import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { brandAssetContentHash } from "../src/shared/brand-kit";
import { encodeBase64, embeddedImageBytes } from "../src/shared/visual-assets";

const pluginBundle = readFileSync(new URL("../dist/plugin.js", import.meta.url), "utf8");

describe("Figma main sandbox runtime compatibility", () => {
  it("executes the built plugin entrypoint with Intl and browser globals unavailable", () => {
    const page = {
      id: "page-1",
      name: "Page 1",
      selection: [],
      children: [],
      findAll: () => [],
      getPluginData: () => "",
      setPluginData: vi.fn(),
      on: vi.fn(),
    };
    const root = {
      id: "file-1",
      children: [page],
      getPluginData: () => "",
      setPluginData: vi.fn(),
    };
    const figma = {
      showUI: vi.fn(),
      ui: { onmessage: undefined as unknown, postMessage: vi.fn() },
      currentPage: page,
      root,
      fileKey: "file-1",
      on: vi.fn(),
      clientStorage: {
        getAsync: vi.fn(async () => undefined),
        setAsync: vi.fn(async () => undefined),
        deleteAsync: vi.fn(async () => undefined),
        keysAsync: vi.fn(async () => []),
      },
    };
    const sandbox = {
      figma,
      Intl: undefined,
      console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    expect(runInNewContext("typeof Intl", sandbox)).toBe("undefined");
    expect(() => runInNewContext(pluginBundle, sandbox)).not.toThrow();
    expect(figma.showUI).toHaveBeenCalledOnce();
    expect(typeof figma.ui.onmessage).toBe("function");
  });

  it("encodes and decodes base64 without btoa or atob", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64(bytes);

    expect(encoded).toBe("AAEC/f7/");
    expect([...embeddedImageBytes(encoded)]).toEqual([...bytes]);
    expect(brandAssetContentHash(encoded)).toBe("605157d4");
  });
});
