import { describe, expect, it } from "vitest";
import sample from "../src/samples/sample-design.json";
import storefront from "../src/samples/phase-2-storefront.json";
import {
  DESIGN_SCHEMA_VERSION,
  MAX_NESTING_DEPTH,
  MAX_NODE_COUNT,
  orderComponentDefinitions,
  parseDesignText,
  parseDesignValue,
  type DesignNode,
  type DesignSpec,
  type FrameNodeSpec,
  type TextNodeSpec,
} from "../src/shared/schema";

function emptyDesign(): DesignSpec {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    document: {
      name: "Test",
      width: 390,
      height: 844,
      background: "#F8FAFC",
      children: [],
    },
  };
}

function textNode(name: string, x = 0, y = 0): TextNodeSpec {
  return { type: "text", name, text: "سلام", x, y, fontSize: 14, color: "#0F172A" };
}

function frameNode(name: string, children: DesignNode[] = [], x = 0, y = 0): FrameNodeSpec {
  return { type: "frame", name, x, y, width: 200, height: 160, children };
}

describe("design schema", () => {
  it("preserves the Phase 1 schema and positioned sample payload", () => {
    const result = parseDesignValue(sample);
    expect(result.success).toBe(true);
    expect(sample.schemaVersion).toBe("1.0.0");
    expect(sample.document.children.every((node) => "x" in node && "y" in node)).toBe(true);
  });

  it("accepts the nested Persian storefront demo with components and instances", () => {
    const result = parseDesignValue(storefront);
    expect(result.success).toBe(true);
    expect(storefront.document.width).toBe(390);
    expect(storefront.document.height).toBe(844);
  });

  it("reports invalid JSON syntax", () => {
    const result = parseDesignText('{ "schemaVersion": ');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors[0]).toMatch(/Invalid JSON syntax/);
  });

  it("rejects unsupported versions, node types, and unknown properties", () => {
    const version = parseDesignValue({ ...sample, schemaVersion: "2.0.0" });
    expect(version.success).toBe(false);
    if (!version.success) expect(version.errors[0]).toContain("Unsupported schema version");

    const design = structuredClone(sample) as unknown as DesignSpec;
    (design.document.children[0] as unknown as { type: string }).type = "ellipse";
    const nodeType = parseDesignValue(design);
    expect(nodeType.success).toBe(false);
    if (!nodeType.success) expect(nodeType.errors.join(" ")).toContain("unsupported node type");

    const extra = structuredClone(sample) as unknown as Record<string, unknown> & {
      document: Record<string, unknown>;
    };
    extra.document.extra = "ignored?";
    const unknown = parseDesignValue(extra);
    expect(unknown.success).toBe(false);
    if (!unknown.success) expect(unknown.errors.join(" ")).toContain("unsupported property");
  });

  it("validates recursive frames up to the nesting limit", () => {
    const makeNested = (depth: number): DesignNode => {
      let node: DesignNode = frameNode(`Frame ${depth}`);
      for (let level = depth - 1; level >= 1; level--) {
        node = frameNode(`Frame ${level}`, [node]);
      }
      return node;
    };
    const valid = emptyDesign();
    valid.document.children = [makeNested(MAX_NESTING_DEPTH)];
    expect(parseDesignValue(valid).success).toBe(true);

    const invalid = emptyDesign();
    invalid.document.children = [makeNested(MAX_NESTING_DEPTH + 1)];
    const result = parseDesignValue(invalid);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join(" ")).toContain("maximum nesting depth");
  });

  it("enforces the total node limit before recursive parsing", () => {
    const design = emptyDesign();
    design.document.children = [
      frameNode(
        "Large A",
        Array.from({ length: 250 }, (_, index) => textNode(`A ${index}`)),
      ),
      frameNode(
        "Large B",
        Array.from({ length: 250 }, (_, index) => textNode(`B ${index}`)),
      ),
    ];
    const result = parseDesignValue(design);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join(" ")).toContain(`${MAX_NODE_COUNT}`);
  });

  it("accepts nested Auto Layout and rejects incompatible sizing and alignment", () => {
    const valid = emptyDesign();
    valid.document.layout = { mode: "vertical", counterAxisAlign: "stretch" };
    valid.document.children = [
      {
        ...textNode("Fill Text"),
        x: undefined,
        y: undefined,
        sizing: { width: "fill", height: "hug" },
      },
    ];
    expect(parseDesignValue(valid).success).toBe(true);

    const positioned = structuredClone(valid);
    positioned.document.children[0] = textNode("Positioned in Auto Layout", 10, 10);
    const positionedResult = parseDesignValue(positioned);
    expect(positionedResult.success).toBe(false);
    if (!positionedResult.success)
      expect(positionedResult.errors.join(" ")).toContain("inside an Auto Layout parent");

    const fillOutside = emptyDesign();
    fillOutside.document.children = [
      { ...textNode("Unsupported Fill"), sizing: { width: "fill", height: "hug" } },
    ];
    const fillResult = parseDesignValue(fillOutside);
    expect(fillResult.success).toBe(false);
    if (!fillResult.success)
      expect(fillResult.errors.join(" ")).toContain("requires an Auto Layout parent");

    const hugParent = emptyDesign();
    hugParent.document.layout = { mode: "vertical", counterAxisAlign: "center" };
    hugParent.document.children = [
      {
        ...frameNode("Hug Parent", [
          {
            ...textNode("Fill Child"),
            x: undefined,
            y: undefined,
            sizing: { width: "fill", height: "hug" },
          },
        ]),
        x: undefined,
        y: undefined,
        layout: { mode: "vertical" },
        sizing: { width: "hug", height: "fixed" },
      },
    ];
    const hugResult = parseDesignValue(hugParent);
    expect(hugResult.success).toBe(false);
    if (!hugResult.success) expect(hugResult.errors.join(" ")).toContain("parent hugs that axis");

    const badBaseline = emptyDesign();
    badBaseline.document.layout = { mode: "vertical", counterAxisAlign: "baseline" };
    expect(parseDesignValue(badBaseline).success).toBe(false);
  });

  it("accepts native constraints only on absolutely positioned, non-Auto-Layout children", () => {
    const absolute = emptyDesign();
    absolute.document.children = [
      {
        type: "rectangle",
        name: "Anchored decoration",
        x: 12,
        y: 12,
        width: 40,
        height: 40,
        fill: "#2563EB",
        constraints: { horizontal: "left-right", vertical: "bottom" },
      },
    ];
    expect(parseDesignValue(absolute).success).toBe(true);

    const invalid = structuredClone(absolute);
    invalid.document.layout = { mode: "horizontal" };
    const invalidResult = parseDesignValue(invalid);
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.errors.join(" ")).toContain("constraints can only be used");
      expect(invalidResult.errors.join(" ")).toContain("uses x/y inside an Auto Layout parent");
    }
  });

  it("rejects unsupported HUG nodes and conflicting stretch sizing", () => {
    const hugRectangle = emptyDesign();
    hugRectangle.document.layout = { mode: "vertical", counterAxisAlign: "center" };
    hugRectangle.document.children = [
      {
        type: "rectangle",
        name: "Hug Rectangle",
        width: 20,
        height: 20,
        fill: "#2563EB",
        sizing: { width: "hug", height: "fixed" },
      },
    ];
    const hugResult = parseDesignValue(hugRectangle);
    expect(hugResult.success).toBe(false);
    if (!hugResult.success) expect(hugResult.errors.join(" ")).toContain("hug requires text");

    const stretch = emptyDesign();
    stretch.document.layout = { mode: "vertical", counterAxisAlign: "stretch" };
    stretch.document.children = [
      {
        ...textNode("Fixed Width"),
        x: undefined,
        y: undefined,
        sizing: { width: "fixed", height: "hug" },
        width: 100,
      },
    ];
    const stretchResult = parseDesignValue(stretch);
    expect(stretchResult.success).toBe(false);
    if (!stretchResult.success)
      expect(stretchResult.errors.join(" ")).toContain(
        "conflicts with the parent's counterAxisAlign stretch",
      );
  });

  it("rejects invalid or duplicate component references and orders dependencies", () => {
    const missing = emptyDesign();
    missing.document.layout = { mode: "vertical" };
    missing.document.children = [{ type: "instance", componentId: "missing" }];
    const missingResult = parseDesignValue(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success)
      expect(missingResult.errors.join(" ")).toContain("missing componentId");

    const duplicate = structuredClone(storefront) as unknown as DesignSpec;
    const components = duplicate.document.components!;
    const ordered = orderComponentDefinitions(components);
    expect(ordered.map((component) => component.id)).toEqual([
      "button.primary",
      "product-card.basic",
    ]);
    components[1].id = components[0].id;
    const duplicateResult = parseDesignValue(duplicate);
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success)
      expect(duplicateResult.errors.join(" ")).toContain("is duplicated");

    const cycle = emptyDesign();
    cycle.document.components = [
      {
        type: "component",
        id: "a",
        name: "A",
        width: 40,
        height: 40,
        layout: { mode: "vertical" },
        children: [{ type: "instance", componentId: "b" }],
      },
      {
        type: "component",
        id: "b",
        name: "B",
        width: 40,
        height: 40,
        layout: { mode: "vertical" },
        children: [{ type: "instance", componentId: "a" }],
      },
    ];
    const cycleResult = parseDesignValue(cycle);
    expect(cycleResult.success).toBe(false);
    if (!cycleResult.success) expect(cycleResult.errors.join(" ")).toContain("cycle detected");
  });

  it("preserves mixed Persian and Latin text and validates fills, strokes, and radii", () => {
    const mixed = structuredClone(sample) as unknown as DesignSpec;
    const heading = mixed.document.children[0];
    if (heading.type === "text") heading.text = "کالا A-17 — ۱۲۳";
    expect(parseDesignValue(mixed).success).toBe(true);

    const visual = emptyDesign();
    visual.document.children = [
      {
        type: "rectangle",
        name: "Rounded Border",
        x: 8,
        y: 8,
        width: 80,
        height: 80,
        fill: "#FFFFFF",
        stroke: { color: "#E2E8F0", width: 2 },
        cornerRadii: { topLeft: 2, topRight: 4, bottomRight: 6, bottomLeft: 8 },
      },
    ];
    expect(parseDesignValue(visual).success).toBe(true);
    visual.document.children[0] = {
      ...(visual.document.children[0] as Extract<DesignNode, { type: "rectangle" }>),
      cornerRadius: 8,
    };
    const conflict = parseDesignValue(visual);
    expect(conflict.success).toBe(false);
    if (!conflict.success)
      expect(conflict.errors.join(" ")).toContain("cannot set both cornerRadius and cornerRadii");

    const invalidColor = emptyDesign();
    invalidColor.document.background = "#FFF";
    const colorResult = parseDesignValue(invalidColor);
    expect(colorResult.success).toBe(false);
    if (!colorResult.success) expect(colorResult.errors.join(" ")).toContain("6-digit hex color");
  });
});
