import { describe, expect, it } from "vitest";
import {
  boundsFromTransform,
  boundsIntersect,
  boundsIntersectWithGap,
  CanvasPlacementError,
  clusterBounds,
  DEFAULT_MAX_ROW_WIDTH,
  DEFAULT_MIN_CANVAS_GAP,
  generatePlacementCandidates,
  normalizeBounds,
  normalizePlacementSettings,
  planCanvasPlacements,
  type CanvasBounds,
  type PlacementItem,
} from "../src/plugin/canvas-placement";
import {
  getCanvasNodeBounds,
  readTopLevelCanvasObstacles,
} from "../src/plugin/figma-canvas-adapter";

function item(id = "screen", width = 390, height = 844): PlacementItem {
  return { id, width, height };
}

function fakeSceneNode(properties: {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  renderBounds?: CanvasBounds | null;
  bounds?: CanvasBounds | null;
  transform?: Transform;
  children?: unknown[];
}): SceneNode {
  return {
    id: "mock-node",
    name: properties.name ?? "Mock node",
    x: properties.x ?? 0,
    y: properties.y ?? 0,
    width: properties.width ?? 100,
    height: properties.height ?? 100,
    absoluteRenderBounds: properties.renderBounds ?? null,
    absoluteBoundingBox: properties.bounds ?? null,
    absoluteTransform: properties.transform ?? [
      [1, 0, properties.x ?? 0],
      [0, 1, properties.y ?? 0],
    ],
    children: properties.children ?? [],
  } as unknown as SceneNode;
}

function assertOutsideAll(
  placement: CanvasBounds,
  obstacles: readonly CanvasBounds[],
  gap = DEFAULT_MIN_CANVAS_GAP,
): void {
  for (const obstacle of obstacles) {
    expect(boundsIntersectWithGap(obstacle, placement, gap)).toBe(false);
  }
}

describe("canvas geometry", () => {
  it("normalizes negative dimensions and uses half-open intersection", () => {
    expect(normalizeBounds({ x: 20, y: 40, width: -10, height: -15 })).toEqual({
      x: 10,
      y: 25,
      width: 10,
      height: 15,
    });
    expect(
      boundsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }),
    ).toBe(false);
  });

  it("uses a predictable origin on an empty page", () => {
    expect(planCanvasPlacements([item()], [])).toEqual([{ ...item(), x: 0, y: 0 }]);
  });

  it("places consecutive generations side by side with the minimum gap", () => {
    const first = planCanvasPlacements([item()], [])[0];
    const firstBounds = { x: first.x, y: first.y, width: first.width, height: first.height };
    const second = planCanvasPlacements([item("second")], [firstBounds])[0];
    expect(second.y).toBe(first.y);
    expect(second.x - (first.x + first.width)).toBe(DEFAULT_MIN_CANVAS_GAP);
    assertOutsideAll({ x: second.x, y: second.y, width: second.width, height: second.height }, [
      firstBounds,
    ]);
  });

  it("keeps ten generations in stable left-to-right order", () => {
    const placed: CanvasBounds[] = [];
    const positions: number[] = [];
    for (let index = 0; index < 10; index++) {
      const [next] = planCanvasPlacements([item(`screen-${index}`)], placed);
      positions.push(next.x);
      placed.push({ x: next.x, y: next.y, width: next.width, height: next.height });
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (let index = 1; index < placed.length; index++) {
      expect(placed[index].x - (placed[index - 1].x + placed[index - 1].width)).toBe(
        DEFAULT_MIN_CANVAS_GAP,
      );
    }
  });

  it.each([100, 250, 500])("places %i repeated generations without collisions", (count) => {
    const existing: CanvasBounds[] = [];
    const startedAt = performance.now();
    for (let index = 0; index < count; index++) {
      const [next] = planCanvasPlacements([item(`screen-${index}`)], existing);
      const nextBounds = { x: next.x, y: next.y, width: next.width, height: next.height };
      assertOutsideAll(nextBounds, existing);
      existing.push(nextBounds);
    }
    const elapsedMs = performance.now() - startedAt;
    expect(Number.isFinite(elapsedMs)).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(existing).toHaveLength(count);
    const columnsPerRow = Math.floor(
      (DEFAULT_MAX_ROW_WIDTH + DEFAULT_MIN_CANVAS_GAP) / (390 + DEFAULT_MIN_CANVAS_GAP),
    );
    const lastIndex = count - 1;
    const last = existing.at(-1)!;
    expect(last.y).toBe(Math.floor(lastIndex / columnsPerRow) * (844 + DEFAULT_MIN_CANVAS_GAP));
    expect(last.x).toBe((lastIndex % columnsPerRow) * (390 + DEFAULT_MIN_CANVAS_GAP));
  });

  it("avoids irregular page objects and handles 100, 250, and 500 obstacles", () => {
    for (const count of [100, 250, 500]) {
      const obstacles = Array.from({ length: count }, (_, index) => ({
        x: (index % 17) * 510 - 2_000,
        y: Math.floor(index / 17) * 960 - 1_500,
        width: 240 + (index % 9) * 80,
        height: 180 + (index % 13) * 60,
      }));
      const [placement] = planCanvasPlacements([item(`screen-${count}`)], obstacles);
      assertOutsideAll(placement, obstacles);
    }

    const irregular = [
      { x: -560, y: -120, width: 900, height: 280 },
      { x: 80, y: 440, width: 1_600, height: 300 },
      { x: 1_900, y: -1_200, width: 500, height: 480 },
      { x: -1_500, y: 2_100, width: 1_200, height: 160 },
    ];
    const [placement] = planCanvasPlacements([item()], irregular);
    assertOutsideAll(placement, irregular);
  });

  it("supports different screen dimensions and mixed-size batches", () => {
    const screens = [
      item("phone", 390, 844),
      item("desktop", 1_440, 900),
      item("tablet", 834, 1_112),
    ];
    const planned = planCanvasPlacements(screens, []);
    expect(planned.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [510, 0],
      [2_070, 0],
    ]);
    expect(clusterBounds(screens)).toEqual({ x: 0, y: 0, width: 2_904, height: 1_112 });
    expect(planned[1].x - (planned[0].x + planned[0].width)).toBe(DEFAULT_MIN_CANVAS_GAP);
    expect(planned[2].x - (planned[1].x + planned[1].width)).toBe(DEFAULT_MIN_CANVAS_GAP);
  });

  it("uses the tallest actual cluster to set the next row height", () => {
    const planned = planCanvasPlacements(
      [item("phone", 390, 844), item("desktop", 1_440, 900), item("tablet", 834, 1_112)],
      [],
      { gap: DEFAULT_MIN_CANVAS_GAP, maxRowWidth: 2_000 },
    );
    expect(planned.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [510, 0],
      [0, 1_020],
    ]);
  });

  it("plans 500 mixed-size clusters as a collision-free batch", () => {
    const batch = Array.from({ length: 500 }, (_, index) =>
      item(`cluster-${index}`, index % 2 === 0 ? 390 : 1_440, 500 + (index % 7) * 80),
    );
    const startedAt = performance.now();
    const planned = planCanvasPlacements(batch, []);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(elapsedMs)).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(planned).toHaveLength(500);
    for (let first = 0; first < planned.length; first++) {
      for (let second = first + 1; second < planned.length; second++) {
        expect(
          boundsIntersectWithGap(
            {
              x: planned[first].x,
              y: planned[first].y,
              width: planned[first].width,
              height: planned[first].height,
            },
            {
              x: planned[second].x,
              y: planned[second].y,
              width: planned[second].width,
              height: planned[second].height,
            },
            DEFAULT_MIN_CANVAS_GAP,
          ),
        ).toBe(false);
      }
    }
  });

  it("handles negative coordinates and bounds crossing the origin", () => {
    const obstacle = { x: -100, y: -50, width: 150, height: 100 };
    const [placement] = planCanvasPlacements([item()], [obstacle]);
    expect(placement).toMatchObject({ x: 170, y: 0 });
    assertOutsideAll(placement, [obstacle]);
  });

  it("accepts exact safety-gap contact and rejects a smaller gap", () => {
    const original = { x: 0, y: 0, width: 100, height: 100 };
    expect(boundsIntersectWithGap(original, { x: 0, y: 220, width: 100, height: 20 }, 120)).toBe(
      false,
    );
    expect(boundsIntersectWithGap(original, { x: 0, y: 219.99, width: 100, height: 20 }, 120)).toBe(
      true,
    );
  });

  it("fills six clusters left-to-right and wraps using the maximum row width", () => {
    const planned = planCanvasPlacements(
      Array.from({ length: 6 }, (_, index) => item(`screen-${index}`)),
      [],
      { gap: DEFAULT_MIN_CANVAS_GAP, maxRowWidth: 1_200 },
    );
    expect(planned.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [510, 0],
      [0, 964],
      [510, 964],
      [0, 1_928],
      [510, 1_928],
    ]);
    for (const placement of planned) {
      expect(placement.x + placement.width).toBeLessThanOrEqual(1_200);
    }
    for (let first = 0; first < planned.length; first++) {
      for (let second = first + 1; second < planned.length; second++) {
        assertOutsideAll(
          {
            x: planned[second].x,
            y: planned[second].y,
            width: planned[second].width,
            height: planned[second].height,
          },
          [
            {
              x: planned[first].x,
              y: planned[first].y,
              width: planned[first].width,
              height: planned[first].height,
            },
          ],
        );
      }
    }
  });

  it("allows exact max-row-width and gap boundary contact", () => {
    const [first, second, third] = planCanvasPlacements(
      [item("first"), item("second"), item("third")],
      [],
      { gap: DEFAULT_MIN_CANVAS_GAP, maxRowWidth: 900 },
    );
    expect(first.x).toBe(0);
    expect(first.x + first.width + DEFAULT_MIN_CANVAS_GAP).toBe(second.x);
    expect(second.x + second.width).toBe(900);
    expect(second).toMatchObject({ x: 510, y: 0 });
    expect(third).toMatchObject({ x: 0, y: 964 });
    expect(
      boundsIntersectWithGap(
        { x: 0, y: 0, width: 390, height: 844 },
        { x: 510, y: 0, width: 390, height: 844 },
        DEFAULT_MIN_CANVAS_GAP,
      ),
    ).toBe(false);
  });

  it("skips an unrelated obstacle in the next horizontal slot", () => {
    const obstacles = [
      { x: 0, y: 0, width: 390, height: 844 },
      { x: 510, y: 0, width: 390, height: 844 },
    ];
    const [placement] = planCanvasPlacements([item()], obstacles, {
      gap: DEFAULT_MIN_CANVAS_GAP,
      maxRowWidth: 900,
    });
    expect(placement).toMatchObject({ x: 0, y: 964 });
    assertOutsideAll(placement, obstacles);
  });

  it("validates centralized gap and row-width settings", () => {
    expect(DEFAULT_MAX_ROW_WIDTH).toBe(6_000);
    expect(normalizePlacementSettings()).toEqual({
      gap: DEFAULT_MIN_CANVAS_GAP,
      maxRowWidth: DEFAULT_MAX_ROW_WIDTH,
    });
    expect(() => normalizePlacementSettings({ gap: -1 })).toThrow(/cannot be negative/);
    expect(() => normalizePlacementSettings({ maxRowWidth: 0 })).toThrow(/greater than zero/);
    expect(() => normalizePlacementSettings({ maxRowWidth: Number.NaN })).toThrow(/finite/);
  });

  it("returns a clear bounded-search error when spacing loses numeric precision", () => {
    const obstacle = { x: 0, y: -1e308, width: 100, height: 1.7e308 };
    expect(() => planCanvasPlacements([item()], [obstacle])).toThrow(/gap cannot be represented/);
    expect(() =>
      generatePlacementCandidates({ x: 0, y: 0, width: 390, height: 844 }, [obstacle]),
    ).toThrow(CanvasPlacementError);
  });

  it("rejects invalid bounds and impossible placement dimensions", () => {
    expect(() => normalizeBounds({ x: Number.NaN, y: 0, width: 10, height: 10 })).toThrow(
      /Bounds x must be a finite number/,
    );
    expect(() => planCanvasPlacements([item("bad", Number.POSITIVE_INFINITY, 100)], [])).toThrow(
      /finite number/,
    );
    expect(() => planCanvasPlacements([item("negative", -1, 100)], [])).toThrow(
      /positive width and height/,
    );
    expect(() => planCanvasPlacements([item(), item()], [])).toThrow(/duplicated/);
  });

  it("does not mutate existing page bounds and leaves room for a component cluster", () => {
    const obstacles = [
      { x: -400, y: -80, width: 560, height: 240 },
      { x: 900, y: 200, width: 180, height: 100 },
    ];
    const before = structuredClone(obstacles);
    const cluster = item("screen-plus-components", 390 + 56 + 390, 844);
    const [placement] = planCanvasPlacements([cluster], obstacles);
    expect(obstacles).toEqual(before);
    assertOutsideAll(placement, obstacles);
    expect(placement.width).toBe(836);
  });

  it("returns deterministic placements for unchanged page bounds", () => {
    const obstacles = [
      { x: 200, y: -100, width: 500, height: 500 },
      { x: 3_000, y: 600, width: 1_400, height: 900 },
    ];
    const groups = [item("a", 390, 844), item("b", 1_440, 900), item("c", 390, 1_600)];
    expect(planCanvasPlacements(groups, obstacles)).toEqual(
      planCanvasPlacements(groups, obstacles),
    );
  });

  it("uses transformed rectangle corners as a rotated AABB fallback", () => {
    const angle = (45 * Math.PI) / 180;
    const rotated = boundsFromTransform(100, 50, [
      [Math.cos(angle), -Math.sin(angle), 0],
      [Math.sin(angle), Math.cos(angle), 0],
    ]);
    expect(rotated.x).toBeCloseTo(-35.3553, 3);
    expect(rotated.y).toBe(0);
    expect(rotated.width).toBeCloseTo(106.066, 3);
    expect(rotated.height).toBeCloseTo(106.066, 3);

    const node = fakeSceneNode({
      width: 100,
      height: 50,
      transform: [
        [Math.cos(angle), -Math.sin(angle), 0],
        [Math.sin(angle), Math.cos(angle), 0],
      ],
    });
    expect(getCanvasNodeBounds(node)).toMatchObject({ x: rotated.x, y: rotated.y });
  });

  it("prefers rendered page AABBs and counts only top-level nodes as obstacles", () => {
    const child = fakeSceneNode({ name: "Nested child", x: 4, y: 4, width: 20, height: 20 });
    const parent = fakeSceneNode({
      name: "Top-level group",
      x: 10,
      y: 10,
      width: 200,
      height: 200,
      renderBounds: { x: 6, y: 6, width: 208, height: 208 },
      bounds: { x: 10, y: 10, width: 200, height: 200 },
      children: [child],
    });
    const obstacles = readTopLevelCanvasObstacles({ children: [parent] } as unknown as PageNode);
    expect(obstacles).toEqual([{ x: 6, y: 6, width: 208, height: 208 }]);
    expect(obstacles).toHaveLength(1);
  });

  it("falls back to a transform when bounding-box APIs return invalid values", () => {
    const fallback = fakeSceneNode({
      name: "Rotated with missing bounds",
      width: 100,
      height: 50,
      renderBounds: { x: Number.NaN, y: 0, width: 100, height: 50 },
      bounds: null,
      transform: [
        [0, -1, 100],
        [1, 0, 25],
      ],
    });
    expect(getCanvasNodeBounds(fallback)).toEqual({ x: 50, y: 25, width: 50, height: 100 });

    const noBounds = fakeSceneNode({
      name: "No usable geometry",
      width: Number.NaN,
      height: Number.NaN,
      renderBounds: { x: Number.NaN, y: 0, width: 1, height: 1 },
      bounds: null,
      transform: [
        [Number.NaN, 0, 0],
        [0, 1, 0],
      ],
    });
    expect(() => getCanvasNodeBounds(noBounds)).toThrow(/Cannot determine safe page bounds/);
  });
});
