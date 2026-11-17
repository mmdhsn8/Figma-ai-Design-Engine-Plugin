import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "../src/companion/draft-store";
import { createGenerationTransaction } from "../src/shared/generation-transaction";
import { draftFixture } from "./generation-fixture";
import { describe, expect, it } from "vitest";
import { createDesignSections, generatedSectionLayoutFits } from "../src/shared/design-generation";
import {
  calculateTomanCart,
  composeStorefrontSection,
  formatPersianInteger,
  isSampleStorefront,
} from "../src/shared/storefront-layout";
import {
  prepareGeneratedDesign,
  normalizeGeneratedSectionContrast,
} from "../src/ui/design-generation";
import { auditVisualQuality } from "../src/shared/visual-quality";

import { brief, storefrontPlan } from "./storefront-fixture";

describe("deterministic Persian storefront", () => {
  it("formats integer values deterministically without Intl", () => {
    expect(formatPersianInteger(0)).toBe("۰");
    expect(formatPersianInteger(1_234_567)).toBe("۱٬۲۳۴٬۵۶۷");
    expect(formatPersianInteger(-1_234)).toBe("\u200e−۱٬۲۳۴");
    expect(() => formatPersianInteger(1.5)).toThrow("Expected a safe integer.");
  });

  it("prices exact integer toman and rejects invalid quantities and adjustments", () => {
    expect(
      calculateTomanCart(
        [
          { unitPrice: 1_290_000, quantity: 1 },
          { unitPrice: 490_000, quantity: 2 },
        ],
        50_000,
        80_000,
      ),
    ).toEqual({
      lineTotals: [1_290_000, 980_000],
      subtotal: 2_270_000,
      shipping: 50_000,
      discount: 80_000,
      total: 2_240_000,
    });
    expect(calculateTomanCart([], 0, 0).total).toBe(0);
    expect(() => calculateTomanCart([{ unitPrice: 10, quantity: 1.5 }], 0, 0)).toThrow(RangeError);
    expect(() =>
      calculateTomanCart([{ unitPrice: Number.MAX_SAFE_INTEGER, quantity: 2 }], 0, 0),
    ).toThrow(RangeError);
    expect(() => calculateTomanCart([{ unitPrice: 10, quantity: 1 }], 0, 11)).toThrow(RangeError);
  });

  it("limits sample data to the named sample brief", () => {
    expect(isSampleStorefront(storefrontPlan)).toBe(true);
    expect(
      isSampleStorefront({
        ...storefrontPlan,
        request: { ...storefrontPlan.request, prompt: brief + " قیمت ۳۰۰٬۰۰۰ تومان." },
      }),
    ).toBe(false);
  });

  it("loads saved layout-version sections and preserves palette, values and transaction identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fad-storefront-checkpoint-"));
    try {
      const { manifest } = draftFixture();
      manifest.request = storefrontPlan.request;
      manifest.visualCompositionVersion = 1;
      const store = createDraftStore(directory);
      await store.start("storefront-test", manifest);
      const screen = storefrontPlan.screens[2]!;
      const plan = { ...storefrontPlan, screens: [screen] };
      for (const { id } of createDesignSections(plan).slice(0, 2)) {
        const design = composeStorefrontSection(plan, id);
        const transaction = createGenerationTransaction({
          generationId: manifest.generationId,
          documentScope: manifest.documentId,
          screenId: screen.id,
          sectionId: id,
          transactionId: `${screen.id}-${id}`,
          design,
        });
        await store.saveSection(
          "storefront-test",
          manifest.documentId,
          manifest.generationId,
          transaction,
          design,
        );
      }
      const freshStore = createDraftStore(directory);
      const saved = await freshStore.load("storefront-test", manifest.documentId);
      expect(saved?.manifest.request.storefrontLayoutVersion).toBe(1);
      expect(saved?.transactions).toHaveLength(2);
      expect(saved?.transactions[1]?.transaction.dependencies).toEqual([
        saved?.transactions[0]?.transaction.idempotency_key,
      ]);
      expect(saved?.transactions[1]?.design).toEqual(composeStorefrontSection(plan, "primary"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prepares the complete three-screen batch with stable artwork and catalog values", () => {
    const plan = storefrontPlan;
    const sections = createDesignSections(plan);
    const screens = plan.screens.map((screen) => {
      const screenPlan = { ...plan, screens: [screen] };
      return {
        id: screen.id,
        children: sections.flatMap(({ id }) => {
          const composed = composeStorefrontSection(screenPlan, id);
          return normalizeGeneratedSectionContrast(composed, screenPlan).design.screens[0]!
            .children;
        }),
      };
    });
    const identity = composeStorefrontSection(plan, "identity");
    const prepared = prepareGeneratedDesign(JSON.stringify({ ...identity, screens }), plan, {
      visualCompositionVersion: 1,
    });
    if (!prepared.success) throw new Error(prepared.errors.join(" "));
    const [home, detail, cart] = prepared.data.visualSpecs;
    const copies = (spec: typeof home) => spec?.nodes.map(({ text }) => text).filter(Boolean);
    expect(copies(home)).toContain("۱٬۲۹۰٬۰۰۰ تومان");
    expect(copies(detail)).toContain("۱٬۲۹۰٬۰۰۰ تومان");
    expect(copies(cart)).toEqual(
      expect.arrayContaining([
        "۱٬۲۹۰٬۰۰۰ تومان",
        "۴۹۰٬۰۰۰ تومان",
        "۹۸۰٬۰۰۰ تومان",
        "۲٬۲۷۰٬۰۰۰ تومان",
        "۵۰٬۰۰۰ تومان",
        "−۸۰٬۰۰۰ تومان",
        "۲٬۲۴۰٬۰۰۰ تومان",
      ]),
    );
    expect(prepared.data.batch.screens).toHaveLength(3);
    expect(prepared.data.batch.designSystem?.components?.length).toBeLessThan(11);
    expect(prepared.data.assetCoverage.placeholders).toBe(11);
    expect(prepared.data.assetCoverage.authorizedAssets).toBe(0);
  });

  it.each(storefrontPlan.screens)("prepares all durable sections for $screenRole", (screen) => {
    const plan = { ...storefrontPlan, screens: [screen] };
    const sections = createDesignSections(plan);
    let total = 0;
    for (const { id } of sections) {
      const generated = composeStorefrontSection(plan, id);
      const root = generated.screens[0]!.children[0]!;
      expect(generatedSectionLayoutFits(root)).toBe(true);
      total += root.height;
      const normalized = normalizeGeneratedSectionContrast(generated, plan);
      expect(normalized.findings).toEqual([]);
      const prepared = prepareGeneratedDesign(JSON.stringify(normalized.design), plan, {
        scope: "section",
        sectionId: id,
        visualCompositionVersion: 1,
      });
      if (!prepared.success)
        throw new Error(`${screen.screenRole}/${id}: ${prepared.errors.join(" ")}`);
      expect(prepared.data.batch.screens[0]).toMatchObject({ width: 390, height: 844 });
      expect(
        auditVisualQuality(prepared.data.batch).diagnostics.filter(
          ({ code }) => code === "low-contrast",
        ),
      ).toEqual([]);
    }
    expect(total + 72).toBeGreaterThan(844);
  });
});
