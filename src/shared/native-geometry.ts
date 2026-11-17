export const NATIVE_GEOMETRY_VERSION = 1 as const;
export const GEOMETRY_EPSILON = 0.001;

export type GeometryTransform = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
];
export type GeometryRect = { x: number; y: number; width: number; height: number };
export type GeometryInsets = { top: number; right: number; bottom: number; left: number };
export type GeometryBox = { width: number; height: number; absoluteTransform?: GeometryTransform };

/** Content bounds, excluding effects and strokes, projected into the parent's local axes. */
export function childBoundsInParent(parent: GeometryBox, child: GeometryBox): GeometryRect | undefined {
  if (!parent.absoluteTransform || !child.absoluteTransform) return;
  const [[a, c, e], [b, d, f]] = parent.absoluteTransform;
  const [[g, i, k], [h, j, l]] = child.absoluteTransform;
  if (![a, b, c, d, e, f, g, h, i, j, k, l, parent.width, parent.height, child.width, child.height].every(Number.isFinite))
    return;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) <= 1e-12) return;
  const points = [[0, 0], [child.width, 0], [0, child.height], [child.width, child.height]].map(([x, y]) => {
    const dx = g * x + i * y + k - e;
    const dy = h * x + j * y + l - f;
    return { x: (d * dx - c * dy) / determinant, y: (a * dy - b * dx) / determinant };
  });
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  const width = Math.max(...points.map((point) => point.x)) - x;
  const height = Math.max(...points.map((point) => point.y)) - y;
  if ([x, y, width, height].every(Number.isFinite)) return { x, y, width, height };
}

export function overflowByEdge(parent: GeometryBox, bounds: GeometryRect, padding?: GeometryInsets): GeometryInsets {
  return {
    left: Math.max(0, (padding?.left ?? 0) - bounds.x),
    right: Math.max(0, bounds.x + bounds.width - parent.width + (padding?.right ?? 0)),
    top: Math.max(0, (padding?.top ?? 0) - bounds.y),
    bottom: Math.max(0, bounds.y + bounds.height - parent.height + (padding?.bottom ?? 0)),
  };
}

export function minimumAxisExtent(children: readonly { mode: string; value: number; min?: number }[], gap: number, insets: number): number {
  return children.reduce((sum, child) => sum + (child.mode === "fixed" ? child.value : child.min ?? 0), insets)
    + Math.max(0, children.length - 1) * gap;
}
