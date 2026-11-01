import { describe, expect, it, vi } from "vitest";
import phase3 from "../src/samples/phase-3-design-system.json";
import { parseDesignValue, type DesignSpec } from "../src/shared/schema";
import { resolveDesignSystemTokens } from "../src/plugin/design-system/token-resolver";
import {
  createOrReuseNativeStyles,
  designSystemAssetPluginDataKey,
  type StyleRegistryApi,
} from "../src/plugin/design-system/style-registry";
import {
  COMPONENT_OWNER_KEY,
  markOwnedComponent,
  readOwnedComponents,
} from "../src/plugin/design-system/component-registry";
import { inspectVariableCapability } from "../src/plugin/design-system/variable-adapter";

function getSystem() {
  const parsed = parseDesignValue(phase3);
  if (!parsed.success) throw new Error(parsed.errors.join(" "));
  return resolveDesignSystemTokens(parsed.data);
}

function makeStyleApi(options: { failTextStyle?: boolean } = {}) {
  const paints: PaintStyle[] = [];
  const texts: TextStyle[] = [];
  let nextId = 1;
  const makeBase = (type: "PAINT" | "TEXT") => {
    const pluginData = new Map<string, string>();
    const style = {
      id: `style-${nextId++}`,
      type,
      name: "",
      getPluginData(key: string) {
        return pluginData.get(key) ?? "";
      },
      setPluginData(key: string, value: string) {
        pluginData.set(key, value);
      },
      remove() {
        const list = type === "PAINT" ? paints : texts;
        const index = list.indexOf(this as unknown as PaintStyle & TextStyle);
        if (index >= 0) list.splice(index, 1);
      },
    };
    return style;
  };
  const api = {
    createPaintStyle: vi.fn(() => {
      const style = {
        ...makeBase("PAINT"),
        paints: [] as readonly Paint[],
      } as unknown as PaintStyle;
      return style;
    }),
    createTextStyle: vi.fn(() => {
      if (options.failTextStyle) throw new Error("Text style creation failed");
      return {
        ...makeBase("TEXT"),
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 12,
        lineHeight: { unit: "AUTO" },
        letterSpacing: { unit: "PIXELS", value: 0 },
        textDecoration: "NONE",
      } as unknown as TextStyle;
    }),
    getLocalPaintStylesAsync: vi.fn(async () => paints),
    getLocalTextStylesAsync: vi.fn(async () => texts),
  } as unknown as StyleRegistryApi;
  return { api, paints, texts };
}

function fontMap(tables: ReturnType<typeof getSystem>["tables"]): Map<string, FontName> {
  return new Map(
    [...tables.typography].map(([token, value]) => [
      token,
      { family: value.fontFamily, style: value.fontStyle },
    ]),
  );
}

describe("design-system style registry", () => {
  it("creates native paint/text styles once and reuses owned styles on re-import", async () => {
    const { tables } = getSystem();
    const { api, paints, texts } = makeStyleApi();
    const first = await createOrReuseNativeStyles(
      api,
      "apparel-core",
      tables,
      { byToken: fontMap(tables) },
      false,
    );
    expect(first.report.created).toHaveLength(15);
    expect(paints).toHaveLength(11);
    expect(texts).toHaveLength(4);
    expect(paints[0].getPluginData(designSystemAssetPluginDataKey)).toContain(
      "design-system:apparel-core:color:",
    );

    const second = await createOrReuseNativeStyles(
      api,
      "apparel-core",
      tables,
      { byToken: fontMap(tables) },
      false,
    );
    expect(second.report.reused).toHaveLength(15);
    expect(second.report.created).toEqual([]);
    expect(paints).toHaveLength(11);
    expect(texts).toHaveLength(4);
  });

  it("avoids a same-name unrelated paint style and does not overwrite user edits", async () => {
    const { tables } = getSystem();
    const { api, paints } = makeStyleApi();
    const unrelated = {
      id: "unrelated-style",
      type: "PAINT",
      name: "Design System/apparel-core/Color/brand/deepNavy",
      paints: [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }],
      getPluginData: () => "",
      setPluginData: vi.fn(),
      remove: vi.fn(),
    } as unknown as PaintStyle;
    paints.push(unrelated);
    await createOrReuseNativeStyles(
      api,
      "apparel-core",
      tables,
      { byToken: fontMap(tables) },
      false,
    );
    const managed = paints.find((style) => style.getPluginData(designSystemAssetPluginDataKey));
    expect(managed?.name).toContain("FAD Engine 2");
    expect(unrelated.paints).toEqual([{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }]);

    managed!.paints = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    const edited = await createOrReuseNativeStyles(
      api,
      "apparel-core",
      tables,
      { byToken: fontMap(tables) },
      true,
    );
    expect(edited.report.skipped).toContain("color.brand.deepNavy");
    expect(managed!.paints).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]);
  });

  it("updates only unchanged owned styles by explicit request and rolls back prior values", async () => {
    const original = getSystem();
    const { api, paints } = makeStyleApi();
    await createOrReuseNativeStyles(
      api,
      "apparel-core",
      original.tables,
      { byToken: fontMap(original.tables) },
      false,
    );
    const changed = structuredClone(phase3) as unknown as DesignSpec;
    changed.designSystem!.colors["color.brand.deepNavy"] = "#112233";
    const parsed = parseDesignValue(changed);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const resolved = resolveDesignSystemTokens(parsed.data);
    const update = await createOrReuseNativeStyles(
      api,
      "apparel-core",
      resolved.tables,
      { byToken: fontMap(resolved.tables) },
      true,
    );
    expect(update.report.updated).toContain("color.brand.deepNavy");
    const managed = paints.find(
      (style) =>
        style.getPluginData(designSystemAssetPluginDataKey) ===
        "design-system:apparel-core:color:color.brand.deepNavy",
    )!;
    expect(managed.paints).toEqual([
      { type: "SOLID", color: { r: 17 / 255, g: 34 / 255, b: 51 / 255 } },
    ]);
    update.rollback();
    expect(managed.paints).toEqual([
      { type: "SOLID", color: { r: 18 / 255, g: 59 / 255, b: 93 / 255 } },
    ]);
  });

  it("removes newly created styles after a partial registry failure", async () => {
    const { tables } = getSystem();
    const { api, paints, texts } = makeStyleApi({ failTextStyle: true });
    await expect(
      createOrReuseNativeStyles(api, "apparel-core", tables, { byToken: fontMap(tables) }, false),
    ).rejects.toThrow("Text style creation failed");
    expect(paints).toEqual([]);
    expect(texts).toEqual([]);
  });
});

describe("design-system component registry and fallbacks", () => {
  it("finds owned masters by stable ID, keeps duplicates, and reports them", () => {
    const { spec } = getSystem();
    const definition = spec.designSystem!.components![0];
    const makeComponent = () => {
      const data = new Map<string, string>();
      return {
        type: "COMPONENT",
        getPluginData(key: string) {
          return data.get(key) ?? "";
        },
        setPluginData(key: string, value: string) {
          data.set(key, value);
        },
      } as unknown as ComponentNode;
    };
    const first = makeComponent();
    const second = makeComponent();
    markOwnedComponent(first, "apparel-core", definition);
    markOwnedComponent(second, "apparel-core", definition);
    const result = readOwnedComponents(
      { findAll: (predicate) => [first, second].filter(predicate) },
      "apparel-core",
      [definition],
    );
    expect(result.byComponentId.get(definition.id)).toBe(first);
    expect(first.getPluginData(COMPONENT_OWNER_KEY)).toContain("button.primary");
    expect(result.warnings.join(" ")).toContain("Multiple owned masters");
  });

  it("uses resolved-value fallback when variable API is unavailable or unverified", () => {
    expect(inspectVariableCapability(undefined)).toMatchObject({
      availableInTypings: false,
      enabled: false,
    });
    const available = inspectVariableCapability({ createVariableCollection: () => ({}) });
    expect(available).toMatchObject({ availableInTypings: true, enabled: false });
    expect(available.fallback).toContain("not been verified");
  });
});
