import {
  boundsFromTransform,
  CanvasPlacementError,
  normalizeBounds,
  type CanvasBounds,
  type TransformMatrix,
} from "./canvas-placement";

function nodeLabel(node: SceneNode): string {
  return node.name ? `“${node.name}”` : `node ${node.id}`;
}

export function getCanvasNodeBounds(node: SceneNode): CanvasBounds {
  const renderBounds = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null;
  const candidates = [renderBounds, node.absoluteBoundingBox];
  let lastError: unknown;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizeBounds(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  try {
    return boundsFromTransform(node.width, node.height, node.absoluteTransform as TransformMatrix);
  } catch (error) {
    throw new CanvasPlacementError(
      `Cannot determine safe page bounds for ${nodeLabel(node)}. Fix its dimensions or transform before generating.`,
      { cause: lastError ?? error },
    );
  }
}

/** Reads page-level children only; descendants are already represented by their top-level parent bounds. */
export function readTopLevelCanvasObstacles(
  page: Pick<PageNode, "children">,
  excludeNodeIds: ReadonlySet<string> = new Set(),
): CanvasBounds[] {
  return page.children.filter((node) => !excludeNodeIds.has(node.id)).map(getCanvasNodeBounds);
}

/** Moves only the newly generated page-level root so its measured AABB reaches the planned point. */
export function placeTopLevelNode(
  node: SceneNode,
  measuredBounds: CanvasBounds,
  target: Pick<CanvasBounds, "x" | "y">,
): void {
  const current = normalizeBounds(measuredBounds);
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new CanvasPlacementError("Planned canvas position must use finite page coordinates.");
  }
  const nextX = node.x + (target.x - current.x);
  const nextY = node.y + (target.y - current.y);
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    throw new CanvasPlacementError(
      "Planned canvas position exceeds Figma's usable coordinate range.",
    );
  }
  node.x = nextX;
  node.y = nextY;
}
