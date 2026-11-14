import { describe, expect, it } from "vitest";
import {
  BRAND_KIT_MAX_TOTAL_ASSET_BYTES,
  BrandKitRevisionSchema,
  brandAssetContentHash,
  colorContrastRatio,
  pinBrandKit,
  resolveBrandReadingDirection,
  resolveBrandTextAlignment,
  resolveBrandKitTokens,
  validateBrandAsset,
  type BrandKitRevision,
  type BrandKitStorageCommand,
} from "../src/shared/brand-kit";
import { handleBrandKitStorage, type BrandKitStorageApi } from "../src/plugin/brand-kit-storage";
import type { UIToPluginMessage } from "../src/shared/messages";
import { ONE_PIXEL_PNG } from "./visual-fixtures";
import {
  createDesignInstructions,
  createDesignPlan,
  type DesignGenerationRequest,
  type GeneratedDesign,
} from "../src/shared/design-generation";
import { DraftManifestSchema } from "../src/shared/generation-draft";
import { prepareGeneratedDesign } from "../src/ui/design-generation";

const INDEX_KEY = "fad.brand-kits.v1:index";
const PRESERVED_KEY = "fad.brand-kits.v1:preserved";

class MemoryStorage implements BrandKitStorageApi {
  values = new Map<string, unknown>();
  failSetKey: string | null = null;
  failSetOnce = true;

  async getAsync(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async setAsync(key: string, value: unknown): Promise<void> {
    if (this.failSetKey === key) {
      if (!this.failSetOnce) throw new Error("storage_write_failed");
      this.failSetOnce = false;
      throw new Error("storage_write_failed");
    }
    this.values.set(key, value);
  }

  async keysAsync(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

function fixture(overrides: Partial<BrandKitRevision> = {}): BrandKitRevision {
  return BrandKitRevisionSchema.parse({
    schemaVersion: 1,
    id: "brand_fixture_01",
    revision: 1,
    name: "کاج / KAJ",
    description: "آزمون محلی",
    locale: "fa",
    direction: "rtl",
    createdAt: 100,
    updatedAt: 100,
    status: "active",
    tokens: {
      palette: {
        primary: "#2463EB",
        secondary: "#1E3A8A",
        accent: "#F97316",
        background: "#F8FAFC",
        surface: "#FFFFFF",
        text: "#0F172A",
        mutedText: "#64748B",
        border: "#CBD5E1",
        success: "#15803D",
        warning: "#B45309",
        error: "#B91C1C",
        custom: {},
      },
      typography: Object.fromEntries(
        ["display", "heading1", "heading2", "heading3", "body", "caption", "button"].map((role) => [
          role,
          {
            requestedFamily: "Brand Display",
            fallbackFamily: "Inter",
            style: "Regular",
            weight: 400,
            size: 16,
            lineHeight: 24,
            letterSpacing: 0,
            alignment: "right",
            direction: "rtl",
          },
        ]),
      ),
      spacing: [4, 8, 12, 16],
      radii: [4, 8, 12],
      stroke: 1,
      shadow: { color: "#0F172A", opacity: 0.12, offsetX: 0, offsetY: 6, radius: 18 },
      grid: {
        mobileColumns: 4,
        desktopColumns: 12,
        mobileGutter: 12,
        desktopGutter: 24,
        desktopBreakpoint: 900,
      },
      density: "comfortable",
      components: { buttonRadius: 12, cardRadius: 16, inputRadius: 10, buttonHeight: 48 },
      themes: [],
    },
    assets: [],
    ...overrides,
  });
}

let requestSequence = 0;
async function send(storage: MemoryStorage, command: BrandKitStorageCommand) {
  const message: Extract<UIToPluginMessage, { type: "brand-kit-storage" }> = {
    type: "brand-kit-storage",
    requestId: `brand-test-${++requestSequence}`,
    command,
  };
  const result = await handleBrandKitStorage(storage, message);
  if (result.type !== "brand-kit-result") throw new Error("Unexpected storage response type.");
  return result;
}

describe("Brand Kit domain contract", () => {
  it("pins immutable tokens, resolves inherited themes and checks contrast", () => {
    const kit = fixture({
      tokens: {
        ...fixture().tokens,
        themes: [
          {
            mode: "light",
            inherits: "base",
            palette: { primary: "#004466", customglow: "#FF00AA" },
          },
          { mode: "dark", inherits: "light", palette: { background: "#101820" } },
        ],
      },
    });
    const pinned = pinBrandKit(kit);
    const dark = resolveBrandKitTokens(pinned, "dark");
    expect(dark.palette.primary).toBe("#004466");
    expect(dark.palette.background).toBe("#101820");
    expect(dark.palette.custom.customglow).toBe("#FF00AA");
    expect(pinned.revision).toBe(1);
    expect(colorContrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21);
    expect(
      BrandKitRevisionSchema.safeParse({
        ...kit,
        tokens: {
          ...kit.tokens,
          themes: [
            { mode: "light", inherits: "dark", palette: {} },
            { mode: "dark", inherits: "light", palette: {} },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps explicit task alignment and direction ahead of pinned Brand Kit defaults", () => {
    const kit = fixture();
    expect(
      resolveBrandTextAlignment(kit.tokens, "body", "Keep the text left-aligned.", "right"),
    ).toBe("left");
    expect(resolveBrandTextAlignment(kit.tokens, "body", "Use the brand typography.", "left")).toBe(
      "right",
    );
    expect(resolveBrandReadingDirection("rtl", "Build this screen left-to-right.", "RTL")).toBe(
      "LTR",
    );
    expect(resolveBrandReadingDirection("ltr", "متن را راست‌به‌چپ نگه‌دار", "LTR")).toBe("RTL");
    expect(resolveBrandReadingDirection("auto", "Create an English dashboard.", "LTR")).toBe("LTR");
  });

  it("rejects malformed colors, duplicate asset variants and unsafe SVG input", () => {
    expect(
      BrandKitRevisionSchema.safeParse({
        ...fixture(),
        tokens: { ...fixture().tokens, palette: { ...fixture().tokens.palette, primary: "red" } },
      }).success,
    ).toBe(false);
    expect(
      validateBrandAsset(
        "image/svg+xml",
        Buffer.from('<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>').toString("base64"),
      ).valid,
    ).toBe(false);
    expect(validateBrandAsset("image/svg+xml", "AA==").valid).toBe(false);
    expect(validateBrandAsset("text/html", "PGgxPng8L2gxPg==").valid).toBe(false);
  });
});

describe("durable local Brand Kit storage", () => {
  it("loads an empty store cleanly, saves stable revisions and detects stale writes", async () => {
    const storage = new MemoryStorage();
    const empty = await send(storage, { action: "load" });
    expect(empty).toMatchObject({
      success: true,
      snapshot: { integrity: "clean", brands: [], defaultBrandId: null },
    });

    const first = await send(storage, { action: "save", kit: fixture(), expectedRevision: null });
    expect(first).toMatchObject({
      success: true,
      snapshot: { brands: [{ id: "brand_fixture_01", revision: 1 }] },
    });
    const kit = first.snapshot!.brands[0]!;
    const updated = await send(storage, {
      action: "save",
      kit: { ...kit, name: "KAJ Studio" },
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({
      success: true,
      snapshot: { brands: [{ id: "brand_fixture_01", name: "KAJ Studio", revision: 2 }] },
    });
    expect(await send(storage, { action: "save", kit, expectedRevision: 1 })).toMatchObject({
      success: false,
      errorCode: "revision_conflict",
    });
    expect((await send(storage, { action: "load" })).snapshot?.brands[0]?.revision).toBe(2);
  });

  it("keeps the ID through duplicate, archive, restore and default-brand changes", async () => {
    const storage = new MemoryStorage();
    await send(storage, { action: "save", kit: fixture(), expectedRevision: null });
    await send(storage, { action: "set-default", brandId: "brand_fixture_01" });
    const archived = await send(storage, {
      action: "set-status",
      brandId: "brand_fixture_01",
      status: "archived",
    });
    expect(archived.snapshot).toMatchObject({
      defaultBrandId: null,
      brands: [{ id: "brand_fixture_01", revision: 2, status: "archived" }],
    });
    const restored = await send(storage, {
      action: "set-status",
      brandId: "brand_fixture_01",
      status: "active",
    });
    expect(restored.snapshot?.brands[0]).toMatchObject({
      id: "brand_fixture_01",
      revision: 3,
      status: "active",
    });
    expect(
      await send(storage, { action: "set-default", brandId: "brand_fixture_01" }),
    ).toMatchObject({ success: true, snapshot: { defaultBrandId: "brand_fixture_01" } });
  });

  it("preserves malformed data in a sidecar and fails closed when that sidecar is unusable", async () => {
    const storage = new MemoryStorage();
    const corruptIndex = {
      version: 1,
      entries: "damaged",
      defaultBrandId: "bad",
      updatedAt: "old",
    };
    storage.values.set(INDEX_KEY, corruptIndex);
    expect(await send(storage, { action: "load" })).toMatchObject({
      success: true,
      snapshot: { integrity: "recovered" },
    });
    const saved = await send(storage, { action: "save", kit: fixture(), expectedRevision: null });
    expect(saved.success).toBe(true);
    expect(storage.values.get(PRESERVED_KEY)).toMatchObject({
      version: 1,
      entries: [{ key: INDEX_KEY, value: corruptIndex }],
    });

    const blocked = new MemoryStorage();
    const original = { version: 1, entries: "damaged" };
    blocked.values.set(INDEX_KEY, original);
    blocked.values.set(PRESERVED_KEY, { corrupted: true });
    const failed = await send(blocked, { action: "save", kit: fixture(), expectedRevision: null });
    expect(failed).toMatchObject({ success: false, errorCode: "archive_failed" });
    expect(blocked.values.get(INDEX_KEY)).toBe(original);
    await expect(blocked.keysAsync()).resolves.not.toContain(
      "fad.brand-kits.v1:revision:brand_fixture_01:1",
    );
  });

  it("preserves unknown future versions read-only and recovers the previous revision after a partial index write", async () => {
    const future = new MemoryStorage();
    const futureIndex = { version: 2, payload: "newer-format" };
    future.values.set(INDEX_KEY, futureIndex);
    expect(await send(future, { action: "load" })).toMatchObject({
      success: true,
      snapshot: { integrity: "future-readonly" },
    });
    expect(
      await send(future, { action: "save", kit: fixture(), expectedRevision: null }),
    ).toMatchObject({ success: false, errorCode: "future_version" });
    expect(future.values.get(INDEX_KEY)).toBe(futureIndex);
    expect(
      await send(future, {
        action: "save-asset",
        assetId: "asset_future_01",
        mimeType: "image/png",
        base64: ONE_PIXEL_PNG,
      }),
    ).toMatchObject({ success: false, errorCode: "future_version" });
    expect(future.values.get(INDEX_KEY)).toBe(futureIndex);
    expect(future.values.has("fad.brand-kits.v1:asset:asset_future_01")).toBe(false);

    const storage = new MemoryStorage();
    await send(storage, { action: "save", kit: fixture(), expectedRevision: null });
    storage.failSetKey = INDEX_KEY;
    const result = await send(storage, {
      action: "save",
      kit: { ...fixture(), name: "Interrupted" },
      expectedRevision: 1,
    });
    expect(result).toMatchObject({ success: false, errorCode: "storage_unavailable" });
    expect((await send(storage, { action: "load" })).snapshot?.brands[0]).toMatchObject({
      revision: 1,
      name: "کاج / KAJ",
    });
  });

  it("stores and resolves only valid, pinned local assets within bounded budgets", async () => {
    const storage = new MemoryStorage();
    const assetId = "asset_fixture_01";
    const asset = {
      assetId,
      kind: "raster" as const,
      variant: "primary" as const,
      name: "Logo PNG",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      contentHash: brandAssetContentHash(ONE_PIXEL_PNG),
      provenance: "user-provided" as const,
      rightsNote: "Provided by the brand team",
      createdAt: 101,
    };
    expect(
      await send(storage, {
        action: "save-asset",
        assetId,
        mimeType: "image/png",
        base64: ONE_PIXEL_PNG,
      }),
    ).toMatchObject({ success: true });
    const kit = fixture({ assets: [asset] });
    expect((await send(storage, { action: "save", kit, expectedRevision: null })).success).toBe(
      true,
    );
    const resolved = await send(storage, { action: "load-asset", assetId });
    expect(resolved).toMatchObject({ success: true, assetBase64: ONE_PIXEL_PNG });
    expect(BRAND_KIT_MAX_TOTAL_ASSET_BYTES).toBe(1024 * 1024);
    const corrupt = await send(storage, {
      action: "import",
      data: {
        schema: "figma-ai-brand-kit",
        schemaVersion: 1,
        brand: fixture({
          id: "brand_import_0001",
          assets: [{ ...asset, assetId: "asset_fixture_02", contentHash: "00000000" }],
        }),
        assets: [{ assetId: "asset_fixture_02", base64: "AA==" }],
      },
    });
    expect(corrupt).toMatchObject({ success: false, errorCode: "asset_invalid" });
  });
});

describe("Brand Kit planning, generation and task pinning", () => {
  const request: DesignGenerationRequest = {
    prompt: "Create a Persian commerce storefront and use this primary brand color #CC1133.",
    target: "mobile",
    screenCount: 1,
    screenNames: ["خانه"],
    language: "fa",
    style: "",
    projectType: "storefront",
    theme: "dark",
    fidelity: "standard",
  };

  function generated(planScreenId: string): GeneratedDesign {
    const shared = {
      text: null,
      palette: "none" as const,
      width: 320,
      height: 48,
      fontSize: 16,
      fontStyle: "Regular" as const,
      textAlign: "right" as const,
      cornerRadius: 0,
      elevation: "none" as const,
      layout: "none" as const,
      gap: 0,
      padding: 0,
      qualityRole: "heading" as const,
      children: [],
    };
    return {
      projectName: "KAJ Storefront",
      palette: {
        brand: "#263A36",
        accent: "#B97755",
        page: "#F6F3EE",
        surface: "#FFFFFF",
        text: "#1E2926",
        muted: "#68736F",
        border: "#D9DED9",
      },
      screens: [
        {
          id: planScreenId,
          children: [
            {
              type: "frame",
              name: "Product content",
              text: null,
              palette: "surface",
              width: 350,
              height: 560,
              fontSize: 16,
              fontStyle: "Regular",
              textAlign: "right",
              cornerRadius: 10,
              elevation: "soft",
              layout: "vertical",
              gap: 16,
              padding: 16,
              qualityRole: "decorative",
              pattern: "product-card",
              strokePalette: "border",
              children: [
                {
                  ...shared,
                  type: "image",
                  name: "Product image",
                  text: null,
                  palette: "accent",
                  width: 320,
                  height: 180,
                  qualityRole: "image",
                  placeholder: true,
                },
                {
                  ...shared,
                  type: "text",
                  name: "Page title",
                  text: "فروشگاه آنلاین",
                  palette: "text",
                  fontSize: 26,
                  fontStyle: "Bold",
                  fontFamily: "Inter",
                  qualityRole: "heading",
                },
                {
                  ...shared,
                  type: "text",
                  name: "Primary action",
                  text: "مشاهدهٔ محصولات",
                  palette: "brand",
                  fontSize: 14,
                  qualityRole: "button",
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it("applies brand tokens to the generated native spec and keeps explicit task colors first", () => {
    const planResult = createDesignPlan(request, pinBrandKit(fixture()));
    expect(planResult.success).toBe(true);
    if (!planResult.success) throw new Error(planResult.errors.join(" "));
    const plan = planResult.data;
    const prepared = prepareGeneratedDesign(JSON.stringify(generated(plan.screens[0]!.id)), plan);
    if (!prepared.success) throw new Error(prepared.errors.join(" "));
    expect(Object.values(prepared.data.batch.designSystem?.colors ?? {})).toContain("#CC1133");
    expect(prepared.data.visualSpecs[0]?.tokens.brand).toBe("#CC1133");
    expect(prepared.data.brandConflicts.join(" ")).toContain("User-requested brand #CC1133");
    expect(prepared.data.visualSpecs[0]?.semanticTokens?.palette.primary).toBe("#2463EB");
    expect(prepared.data.batch.screens[0]?.children[0]).toMatchObject({
      cornerRadius: 16,
      stroke: { width: 1 },
      visual: { effects: [{ type: "drop-shadow", color: "#0F172A" }] },
    });
    const heading = prepared.data.visualSpecs[0]?.nodes.find((node) => node.name === "Page title");
    expect(heading?.typography).toMatchObject({ family: "Brand Display", size: 16 });
    expect(createDesignInstructions(plan)).toContain("pinned Brand Kit");
  });

  it("pins exact brand and model in a reloadable generation manifest and blocks missing assets", () => {
    const pinned = pinBrandKit(fixture());
    const plan = createDesignPlan(request, pinned);
    expect(plan.success).toBe(true);
    if (!plan.success) throw new Error(plan.errors.join(" "));
    const manifest = DraftManifestSchema.parse({
      version: 1,
      documentId: "figma-document-test",
      generationId: "generation-test-0001",
      model: "gpt-5.2",
      request: plan.data.request,
      brandKit: pinned,
      createdAt: 100,
    });
    const restored = DraftManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
    expect(restored.model).toBe("gpt-5.2");
    expect(restored.brandKit).toEqual(pinned);
    expect(restored.brandKit?.revision).toBe(1);

    const missingAssetKit = fixture({
      assets: [
        {
          assetId: "asset_missing_01",
          kind: "raster",
          variant: "primary",
          name: "Brand logo",
          mimeType: "image/png",
          width: 1,
          height: 1,
          contentHash: "00000000",
          provenance: "user-provided",
          rightsNote: "Brand team file",
          createdAt: 101,
        },
      ],
    });
    const assetPlan = createDesignPlan(request, pinBrandKit(missingAssetKit));
    expect(assetPlan.success).toBe(true);
    if (!assetPlan.success) throw new Error(assetPlan.errors.join(" "));
    expect(
      prepareGeneratedDesign(
        JSON.stringify(generated(assetPlan.data.screens[0]!.id)),
        assetPlan.data,
      ),
    ).toMatchObject({
      success: false,
      errors: [expect.stringContaining("pinned Brand Kit asset is missing")],
    });
  });
});
