import { describe, expect, it } from "vitest";
import phase1 from "../src/samples/sample-design.json";
import phase2 from "../src/samples/phase-2-storefront.json";
import phase3 from "../src/samples/phase-3-design-system.json";
import phase4 from "../src/samples/phase-4-multi-screen.json";
import {
  orderMultiScreenItems,
  parseMultiScreenText,
  parseMultiScreenValue,
  type MultiScreenSpec,
} from "../src/shared/multi-screen-schema";
import { parseDesignValue } from "../src/shared/schema";

describe("multi-screen schema", () => {
  it("keeps Phase 1–3 JSON valid and accepts the Phase 4 sample", () => {
    expect(parseDesignValue(phase1).success).toBe(true);
    expect(parseDesignValue(phase2).success).toBe(true);
    expect(parseDesignValue(phase3).success).toBe(true);
    const parsed = parseMultiScreenValue(phase4);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.screens).toHaveLength(10);
      expect(parsed.data.designSystem?.namespace).toBe("apparel-core");
      expect(parsed.nodeCount).toBeGreaterThan(parsed.data.screens.length);
    }
  });

  it("sorts screens by group, order, and stable ID regardless of source array order", () => {
    const batch = structuredClone(phase4) as MultiScreenSpec;
    const expected = orderMultiScreenItems(batch.screens).map((screen) => screen.id);
    const parsed = parseMultiScreenValue({ ...batch, screens: [...batch.screens].reverse() });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.screens.map((screen) => screen.id)).toEqual(expected);
  });

  it("rejects duplicate IDs, colliding names, empty batches, and unsafe names", () => {
    const duplicateId = structuredClone(phase4) as MultiScreenSpec;
    duplicateId.screens[1].id = duplicateId.screens[0].id;
    const idResult = parseMultiScreenValue(duplicateId);
    expect(idResult.success).toBe(false);
    if (!idResult.success) expect(idResult.errors.join(" ")).toContain("id");

    const duplicateName = structuredClone(phase4) as MultiScreenSpec;
    duplicateName.screens[1].name = duplicateName.screens[0].name.toLocaleUpperCase("en-US");
    expect(parseMultiScreenValue(duplicateName).success).toBe(false);

    const empty = { ...phase4, screens: [] };
    expect(parseMultiScreenValue(empty).success).toBe(false);

    const unsafe = structuredClone(phase4) as MultiScreenSpec;
    unsafe.screens[0].name = "unsafe/name";
    expect(parseMultiScreenValue(unsafe).success).toBe(false);
  });

  it("reports screen-scoped token references and invalid dimensions", () => {
    const missingToken = structuredClone(phase4) as MultiScreenSpec;
    missingToken.screens[0].background = { token: "color.not-found" };
    const referenceResult = parseMultiScreenValue(missingToken);
    expect(referenceResult.success).toBe(false);
    if (!referenceResult.success) {
      expect(referenceResult.errors.join(" ")).toContain(
        `screens["${missingToken.screens[0].id}"]`,
      );
      expect(referenceResult.errors.join(" ")).toContain("missing token");
    }

    const invalidSize = structuredClone(phase4) as MultiScreenSpec;
    invalidSize.screens[0].width = Number.POSITIVE_INFINITY;
    expect(parseMultiScreenValue(invalidSize).success).toBe(false);
  });

  it("keeps all screens and nodes above the former aggregate limits", () => {
    const largeBatch = structuredClone(phase4) as MultiScreenSpec;
    const template = largeBatch.screens[0];
    largeBatch.screens = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(template),
      id: `screen-${index}`,
      name: `Screen ${index}`,
    }));
    expect(parseMultiScreenValue(largeBatch).success).toBe(true);

    const manyNodes: MultiScreenSpec = {
      schemaVersion: "1.0.0",
      id: "large-batch",
      name: "Large Batch",
      screens: Array.from({ length: 100 }, (_, screenIndex) => ({
        id: `screen-${screenIndex}`,
        name: `Screen ${screenIndex}`,
        width: 390,
        height: 844,
        layout: { mode: "vertical" as const },
        children: Array.from({ length: 50 }, (_, nodeIndex) => ({
          type: "text" as const,
          name: `Text ${screenIndex}-${nodeIndex}`,
          text: "Content",
          fontSize: 12,
          color: "#123456",
        })),
      })),
    };
    const countResult = parseMultiScreenValue(manyNodes);
    expect(countResult.success).toBe(true);
    if (countResult.success) expect(countResult.nodeCount).toBeGreaterThan(5_000);
  });

  it("rejects duplicate JSON keys in pasted multi-screen source", () => {
    const parsed = parseMultiScreenText(
      '{"schemaVersion":"1.0.0","id":"batch-one","id":"batch-two","name":"Batch","screens":[]}',
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.errors.join(" ")).toContain("Duplicate JSON key");
  });
});
