import { hexToRgb } from "./figma-utils";
import type { ResolvedVisualFill, ResolvedVisualStyle } from "./design-system/token-resolver";

type VisualTarget = {
  fills: readonly Paint[] | PluginAPI["mixed"];
  strokes: readonly Paint[] | PluginAPI["mixed"];
  opacity: number;
  effects: readonly Effect[];
  blendMode: BlendMode;
  strokeWeight: number | PluginAPI["mixed"];
  strokeAlign: "CENTER" | "INSIDE" | "OUTSIDE" | PluginAPI["mixed"];
  dashPattern: readonly number[] | PluginAPI["mixed"];
  clipsContent?: boolean;
};

export function linearGradientTransform(degrees: number): Transform {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    [cosine, -sine, 0.5 - 0.5 * cosine + 0.5 * sine],
    [sine, cosine, 0.5 - 0.5 * sine - 0.5 * cosine],
  ];
}

function paintForFill(fill: ResolvedVisualFill): Paint {
  if (fill.type === "solid") {
    return {
      type: "SOLID",
      color: hexToRgb(fill.color),
      opacity: fill.opacity,
    };
  }
  return {
    type: fill.type === "linear" ? "GRADIENT_LINEAR" : "GRADIENT_RADIAL",
    gradientTransform:
      fill.type === "linear"
        ? linearGradientTransform(fill.angle ?? 0)
        : [
            [1, 0, 0],
            [0, 1, 0],
          ],
    gradientStops: fill.stops.map((stop) => ({
      position: stop.position,
      color: { ...hexToRgb(stop.color), a: 1 },
    })),
    opacity: fill.opacity,
  };
}

function effectsForStyle(visual: ResolvedVisualStyle): Effect[] {
  return (visual.effects ?? []).map((effect): Effect => {
    switch (effect.type) {
      case "layer-blur":
        return { type: "LAYER_BLUR", blurType: "NORMAL", radius: effect.radius, visible: true };
      case "background-blur":
        return {
          type: "BACKGROUND_BLUR",
          blurType: "NORMAL",
          radius: effect.radius,
          visible: true,
        };
      case "drop-shadow": {
        const { r, g, b } = hexToRgb(effect.color);
        return {
          type: "DROP_SHADOW",
          color: { r, g, b, a: effect.opacity },
          offset: { x: effect.offsetX, y: effect.offsetY },
          radius: effect.radius,
          spread: effect.spread,
          visible: true,
          blendMode: "NORMAL",
        };
      }
      case "inner-shadow": {
        const { r, g, b } = hexToRgb(effect.color);
        return {
          type: "INNER_SHADOW",
          color: { r, g, b, a: effect.opacity },
          offset: { x: effect.offsetX, y: effect.offsetY },
          radius: effect.radius,
          spread: effect.spread,
          visible: true,
          blendMode: "NORMAL",
        };
      }
    }
  });
}

export function applyFigmaVisualStyle(
  node: VisualTarget,
  visual: ResolvedVisualStyle | undefined,
  imageHash?: string,
  imageFit: ImagePaint["scaleMode"] = "FILL",
): void {
  if (!visual) return;
  if (visual.fills !== undefined) {
    const overlays = visual.fills.map(paintForFill);
    node.fills = imageHash
      ? [{ type: "IMAGE", imageHash, scaleMode: imageFit }, ...overlays]
      : overlays;
  } else if (imageHash) {
    node.fills = [{ type: "IMAGE", imageHash, scaleMode: imageFit }];
  }
  if (visual.opacity !== undefined) node.opacity = visual.opacity;
  if (visual.blendMode) node.blendMode = visual.blendMode.toUpperCase() as BlendMode;
  if (visual.strokes !== undefined) {
    node.strokes = visual.strokes.map((stroke) => ({
      type: "SOLID",
      color: hexToRgb(stroke.color),
      opacity: 1,
    }));
    const first = visual.strokes[0];
    if (first) {
      node.strokeWeight = first.width;
      node.strokeAlign = first.align.toUpperCase() as VisualTarget["strokeAlign"];
      node.dashPattern = first.dashPattern ? [...first.dashPattern] : [];
    }
  }
  if (visual.effects !== undefined) node.effects = effectsForStyle(visual);
  if (visual.clipsContent !== undefined && "clipsContent" in node) {
    node.clipsContent = visual.clipsContent;
  }
}

export function resolvedFillPaints(visual: ResolvedVisualStyle | undefined): Paint[] | undefined {
  return visual?.fills?.map(paintForFill);
}

export function normalizeImageFit(
  fit: "fill" | "fit" | "crop" | "tile" | undefined,
): ImagePaint["scaleMode"] {
  const value = fit ?? "fill";
  return value.toUpperCase() as ImagePaint["scaleMode"];
}
