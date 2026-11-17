import { describe, expect, it } from "vitest";
import { childBoundsInParent, minimumAxisExtent, overflowByEdge, type GeometryTransform } from "../src/shared/native-geometry";
import { fitProgramScrollBody, inspectProgramGeometry } from "../src/plugin/design-program-geometry";
import { createMockApi } from "./figma-mock";

const at = (x: number, y: number): GeometryTransform => [[1, 0, x], [0, 1, y]];

describe("native geometry v1", () => {
  it("grows only the measured scroll body and stops when there is no further correction", () => {
    const { api } = createMockApi();
    const root = api.createFrame();
    const body = api.createFrame();
    const content = api.createFrame();
    root.resize(390, 844);
    root.clipsContent = true;
    root.overflowDirection = "VERTICAL";
    body.resize(390, 1000);
    content.resize(342, 1200);
    root.appendChild(body);
    body.appendChild(content);
    const options = { taskId: "geometry-test", pageId: api.currentPage.id };
    expect(inspectProgramGeometry(root, options).findings).toContainEqual(expect.objectContaining({ code: "native_vertical_overflow" }));
    expect(fitProgramScrollBody(root)).toBe(true);
    expect(body.height).toBe(1200);
    expect(root.height).toBe(844);
    expect(inspectProgramGeometry(root, options).findings).toEqual([]);
    expect(fitProgramScrollBody(root)).toBe(false);
  });

  it.each([155, 20, 4])("classifies %i px of horizontal bleed in parent-local coordinates", (bleed) => {
    const parent = { width: 390, height: 844, absoluteTransform: at(510, 300) };
    const child = { x: 99, width: 320, height: 44, absoluteTransform: at(510 + 390 + bleed - 320, 330) };
    const bounds = childBoundsInParent(parent, child)!;
    expect(bounds).toEqual({ x: 70 + bleed, y: 30, width: 320, height: 44 });
    expect(overflowByEdge(parent, bounds)).toEqual({ left: 0, top: 0, right: bleed, bottom: 0 });
  });

  it("finds six pixels of vertical text bleed in a 44 px parent", () => {
    const parent = { width: 80, height: 44, absoluteTransform: at(510, 300) };
    const bounds = childBoundsInParent(parent, { width: 60, height: 50, absoluteTransform: at(520, 300) })!;
    expect(overflowByEdge(parent, bounds)).toEqual({ left: 0, top: 0, right: 0, bottom: 6 });
  });

  it("uses padding and gap plus fixed and fill minimums before accepting a 350 px row", () => {
    const required = minimumAxisExtent([{ mode: "fixed", value: 240 }, { mode: "fill", value: 70, min: 208 }], 16, 40);
    expect(required).toBe(504);
    expect(required - 350).toBe(154);
  });

  it("projects all four rotated corners and rejects an unmeasurable parent transform", () => {
    const parent = { width: 390, height: 844, absoluteTransform: [[0, -1, 510], [1, 0, 300]] as const };
    const child = { width: 20, height: 40, absoluteTransform: at(470, 310) };
    expect(childBoundsInParent(parent, child)).toEqual({ x: 10, y: 20, width: 40, height: 20 });
    expect(childBoundsInParent({ ...parent, absoluteTransform: [[0, 0, 510], [0, 0, 300]] }, child)).toBeUndefined();
    expect(childBoundsInParent(parent, { width: 20, height: 40 })).toBeUndefined();
  });
});
