export const DEFAULT_MIN_CANVAS_GAP = 120;
export const DEFAULT_MAX_ROW_WIDTH = 6_000;

export interface CanvasPlacementSettings {
  gap: number;
  maxRowWidth: number;
}

export const DEFAULT_CANVAS_PLACEMENT_SETTINGS: Readonly<CanvasPlacementSettings> = Object.freeze({
  gap: DEFAULT_MIN_CANVAS_GAP,
  maxRowWidth: DEFAULT_MAX_ROW_WIDTH,
});

export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementItem {
  id: string;
  width: number;
  height: number;
}

export interface PlannedPlacement extends PlacementItem {
  x: number;
  y: number;
}

export interface PlacementCandidate {
  x: number;
  y: number;
}

export type TransformMatrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
];

export type CanvasPlacementSettingsInput = number | Partial<CanvasPlacementSettings>;

interface ExpandedBounds extends CanvasBounds {
  right: number;
  bottom: number;
}

interface ForbiddenStartInterval {
  start: number;
  end: number;
}

export class CanvasPlacementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanvasPlacementError";
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new CanvasPlacementError(
      `${label} must be a finite number to place canvas content safely.`,
    );
  }
}

export function normalizePlacementSettings(
  input: CanvasPlacementSettingsInput = DEFAULT_CANVAS_PLACEMENT_SETTINGS,
): CanvasPlacementSettings {
  const settings = typeof input === "number" ? { gap: input } : input;
  const gap = settings.gap ?? DEFAULT_MIN_CANVAS_GAP;
  const maxRowWidth = settings.maxRowWidth ?? DEFAULT_MAX_ROW_WIDTH;
  assertFinite(gap, "Canvas gap");
  assertFinite(maxRowWidth, "Maximum row width");
  if (gap < 0) throw new CanvasPlacementError("Canvas gap cannot be negative.");
  if (maxRowWidth <= 0) {
    throw new CanvasPlacementError("Maximum row width must be greater than zero.");
  }
  return { gap, maxRowWidth };
}

export function normalizeBounds(bounds: CanvasBounds): CanvasBounds {
  assertFinite(bounds.x, "Bounds x");
  assertFinite(bounds.y, "Bounds y");
  assertFinite(bounds.width, "Bounds width");
  assertFinite(bounds.height, "Bounds height");

  const x2 = bounds.x + bounds.width;
  const y2 = bounds.y + bounds.height;
  assertFinite(x2, "Bounds right edge");
  assertFinite(y2, "Bounds bottom edge");
  if (bounds.width !== 0 && x2 === bounds.x) {
    throw new CanvasPlacementError("Bounds width is too small to represent at its x coordinate.");
  }
  if (bounds.height !== 0 && y2 === bounds.y) {
    throw new CanvasPlacementError("Bounds height is too small to represent at its y coordinate.");
  }

  const left = Math.min(bounds.x, x2);
  const top = Math.min(bounds.y, y2);
  const right = Math.max(bounds.x, x2);
  const bottom = Math.max(bounds.y, y2);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expandBoundsWithEdges(bounds: CanvasBounds, gap: number): ExpandedBounds {
  const normalized = normalizeBounds(bounds);
  const x = normalized.x - gap;
  const y = normalized.y - gap;
  const originalRight = normalized.x + normalized.width;
  const originalBottom = normalized.y + normalized.height;
  const right = originalRight + gap;
  const bottom = originalBottom + gap;
  assertFinite(x, "Expanded bounds left edge");
  assertFinite(y, "Expanded bounds top edge");
  assertFinite(right, "Expanded bounds right edge");
  assertFinite(bottom, "Expanded bounds bottom edge");
  const width = right - x;
  const height = bottom - y;
  assertFinite(width, "Expanded bounds width");
  assertFinite(height, "Expanded bounds height");
  if (
    gap > 0 &&
    (x === normalized.x ||
      y === normalized.y ||
      right === originalRight ||
      bottom === originalBottom)
  ) {
    throw new CanvasPlacementError(
      "The minimum canvas gap cannot be represented at these coordinates; move or resize the extreme object before generating.",
    );
  }
  return { x, y, width, height, right, bottom };
}

export function expandBounds(bounds: CanvasBounds, gap: number): CanvasBounds {
  const expanded = expandBoundsWithEdges(bounds, normalizePlacementSettings({ gap }).gap);
  return { x: expanded.x, y: expanded.y, width: expanded.width, height: expanded.height };
}

/** Half-open AABB intersection: touching edges do not overlap. */
export function boundsIntersect(first: CanvasBounds, second: CanvasBounds): boolean {
  const a = normalizeBounds(first);
  const b = normalizeBounds(second);
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Expands the first bounds by the requested safety gap before testing intersection. */
export function boundsIntersectWithGap(
  first: CanvasBounds,
  second: CanvasBounds,
  gap = DEFAULT_MIN_CANVAS_GAP,
): boolean {
  return boundsIntersect(expandBounds(first, gap), second);
}

export function boundsFromTransform(
  width: number,
  height: number,
  transform: TransformMatrix,
): CanvasBounds {
  assertFinite(width, "Transformed node width");
  assertFinite(height, "Transformed node height");
  if (width < 0 || height < 0) {
    throw new CanvasPlacementError("Transformed node dimensions cannot be negative.");
  }
  const values = transform.flat();
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    throw new CanvasPlacementError(
      "Node transform is invalid; safe canvas bounds cannot be determined.",
    );
  }
  const [[m00, m01, m02], [m10, m11, m12]] = transform;
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => ({
    x: m00 * x + m01 * y + m02,
    y: m10 * x + m11 * y + m12,
  }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return normalizeBounds({
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  });
}

function validateItems(items: readonly PlacementItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.id.trim())
      throw new CanvasPlacementError("Every generated screen group needs a stable id.");
    if (ids.has(item.id))
      throw new CanvasPlacementError(`Placement id “${item.id}” is duplicated.`);
    ids.add(item.id);
    assertFinite(item.width, `Placement “${item.id}” width`);
    assertFinite(item.height, `Placement “${item.id}” height`);
    if (item.width <= 0 || item.height <= 0) {
      throw new CanvasPlacementError(`Placement “${item.id}” must have positive width and height.`);
    }
  }
}

function normalizedObstacles(obstacles: readonly CanvasBounds[], gap: number): ExpandedBounds[] {
  return obstacles.map((obstacle) => expandBoundsWithEdges(obstacle, gap));
}

function findFirstAvailableX(
  item: PlacementItem,
  rowY: number,
  minimumX: number,
  rowWidth: number,
  obstacles: readonly ExpandedBounds[],
): { x: number | null; blockingBottom: number } {
  const maxX = rowWidth - item.width;
  const rowBottom = rowY + item.height;
  assertFinite(maxX, "Maximum canvas x coordinate");
  assertFinite(rowBottom, "Candidate row bottom");

  const intervals: ForbiddenStartInterval[] = [];
  let blockingBottom = rowY;
  for (const obstacle of obstacles) {
    if (!(obstacle.y < rowBottom && rowY < obstacle.bottom)) continue;

    if (obstacle.x < rowWidth && obstacle.right > 0) {
      blockingBottom = Math.max(blockingBottom, obstacle.bottom);
    }

    const start = obstacle.x - item.width;
    assertFinite(start, "Forbidden placement interval start");
    if (start < maxX && obstacle.right > minimumX) intervals.push({ start, end: obstacle.right });
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  let x = minimumX;
  for (const interval of intervals) {
    // Intervals are open: exact contact with an obstacle's expanded edge is safe.
    if (x > interval.start && x < interval.end) x = interval.end;
    if (x > maxX) return { x: null, blockingBottom };
  }
  return { x: x <= maxX ? x : null, blockingBottom };
}

function nextRowY(
  rowY: number,
  itemHeight: number,
  currentRowHeight: number,
  gap: number,
  blockingBottom: number,
): number {
  const minimumNextY = rowY + (currentRowHeight > 0 ? currentRowHeight : itemHeight) + gap;
  const nextY = Math.max(minimumNextY, blockingBottom);
  assertFinite(nextY, "Next canvas row y coordinate");
  if (nextY <= rowY) {
    throw new CanvasPlacementError(
      "Canvas row spacing cannot be represented at these coordinates; move or resize extreme content before generating.",
    );
  }
  return nextY;
}

/**
 * Plans screen groups left-to-right, wrapping into rows at maxRowWidth.
 * Obstacles are expanded once; each row query sorts only the intervals that can
 * block that row. A placement therefore takes O(n log n) time for n obstacles,
 * with row advances bounded by the number of distinct blocking bounds.
 */
export function planCanvasPlacements(
  items: readonly PlacementItem[],
  obstacles: readonly CanvasBounds[],
  settingsInput: CanvasPlacementSettingsInput = DEFAULT_CANVAS_PLACEMENT_SETTINGS,
): PlannedPlacement[] {
  const settings = normalizePlacementSettings(settingsInput);
  validateItems(items);
  if (items.length === 0) return [];

  const expandedObstacles = normalizedObstacles(obstacles, settings.gap);
  const placements: PlannedPlacement[] = [];
  const allExpandedObstacles = [...expandedObstacles];
  let rowY = 0;
  let cursorX = 0;
  let rowHeight = 0;

  for (const item of items) {
    const rowWidth = Math.max(settings.maxRowWidth, item.width);
    let found = false;
    let rowAdvances = 0;
    const maxRowAdvances = expandedObstacles.length + placements.length + 2;

    while (!found && rowAdvances <= maxRowAdvances) {
      const candidate = findFirstAvailableX(item, rowY, cursorX, rowWidth, allExpandedObstacles);
      if (candidate.x !== null) {
        const placement = { ...item, x: candidate.x, y: rowY };
        placements.push(placement);
        allExpandedObstacles.push(expandBoundsWithEdges(placement, settings.gap));
        cursorX = candidate.x + item.width + settings.gap;
        assertFinite(cursorX, "Next horizontal canvas position");
        rowHeight = Math.max(rowHeight, item.height);
        found = true;
      } else {
        rowY = nextRowY(rowY, item.height, rowHeight, settings.gap, candidate.blockingBottom);
        cursorX = 0;
        rowHeight = 0;
        rowAdvances += 1;
      }
    }

    if (!found) {
      throw new CanvasPlacementError(
        `Canvas placement exhausted its ${maxRowAdvances + 1} row attempts. Check obstacle bounds and available numeric coordinate range.`,
      );
    }
  }
  return placements;
}

export function clusterBounds(
  items: readonly PlacementItem[],
  settingsInput: CanvasPlacementSettingsInput = DEFAULT_CANVAS_PLACEMENT_SETTINGS,
): CanvasBounds {
  const settings = normalizePlacementSettings(settingsInput);
  if (items.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const placements = planCanvasPlacements(items, [], settings);
  const left = Math.min(...placements.map((placement) => placement.x));
  const top = Math.min(...placements.map((placement) => placement.y));
  const right = Math.max(...placements.map((placement) => placement.x + placement.width));
  const bottom = Math.max(...placements.map((placement) => placement.y + placement.height));
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  return normalizeBounds(bounds);
}

/** Returns the planner's first deterministic row-major candidate for one cluster. */
export function generatePlacementCandidates(
  cluster: CanvasBounds,
  obstacles: readonly CanvasBounds[],
  settingsInput: CanvasPlacementSettingsInput = DEFAULT_CANVAS_PLACEMENT_SETTINGS,
): PlacementCandidate[] {
  const normalized = normalizeBounds(cluster);
  if (normalized.width <= 0 || normalized.height <= 0) {
    throw new CanvasPlacementError("Generated cluster bounds must have positive width and height.");
  }
  const [placement] = planCanvasPlacements(
    [{ id: "candidate", width: normalized.width, height: normalized.height }],
    obstacles,
    settingsInput,
  );
  if (!placement) throw new CanvasPlacementError("No canvas placement candidate was generated.");
  return [{ x: placement.x, y: placement.y }];
}
