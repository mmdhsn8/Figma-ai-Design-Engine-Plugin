import { z } from "zod";
import { TokenColorValueSchema } from "./design-system-schema";
import { inspectEmbeddedImage, isFigmaPathData } from "./visual-assets";

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/);
const fileNameSchema = z.string().trim().min(1).max(160);
const dimensionSchema = z.number().finite().min(1).max(4_096);
const colorSchema = TokenColorValueSchema;

const SolidFillSchema = z
  .object({
    type: z.literal("solid"),
    color: colorSchema,
    opacity: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const GradientStopSchema = z
  .object({
    position: z.number().finite().min(0).max(1),
    color: colorSchema,
  })
  .strict();

const GradientFillSchema = z
  .object({
    type: z.enum(["linear", "radial"]),
    angle: z.number().finite().min(-360).max(360).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    stops: z.array(GradientStopSchema).min(2).max(6),
  })
  .strict()
  .superRefine((fill, context) => {
    for (let index = 1; index < fill.stops.length; index++) {
      if (fill.stops[index].position <= fill.stops[index - 1].position) {
        context.addIssue({
          code: "custom",
          path: ["stops", index, "position"],
          message: "Gradient stops must have strictly increasing positions.",
        });
      }
    }
  });

export const VisualFillSchema = z.discriminatedUnion("type", [SolidFillSchema, GradientFillSchema]);
export type VisualFill = z.infer<typeof VisualFillSchema>;

const VisualStrokeSchema = z
  .object({
    color: colorSchema,
    width: z.number().finite().min(0.25).max(100).default(1),
    align: z.enum(["inside", "center", "outside"]).default("inside"),
    dashPattern: z.array(z.number().finite().min(0.25).max(100)).max(8).optional(),
  })
  .strict();

const ShadowEffectSchema = z
  .object({
    type: z.enum(["drop-shadow", "inner-shadow"]),
    color: colorSchema,
    opacity: z.number().finite().min(0).max(1).default(0.18),
    offsetX: z.number().finite().min(-1_000).max(1_000).default(0),
    offsetY: z.number().finite().min(-1_000).max(1_000).default(4),
    radius: z.number().finite().min(0).max(256).default(16),
    spread: z.number().finite().min(-100).max(100).default(0),
  })
  .strict();

const BlurEffectSchema = z
  .object({
    type: z.enum(["layer-blur", "background-blur"]),
    radius: z.number().finite().min(0).max(256),
  })
  .strict();

export const VisualEffectSchema = z.discriminatedUnion("type", [
  ShadowEffectSchema,
  BlurEffectSchema,
]);
export type VisualEffect = z.infer<typeof VisualEffectSchema>;

export const VisualStyleSchema = z
  .object({
    /** When set, replaces the legacy fill/background paint. Alpha is expressed only as opacity. */
    fills: z.array(VisualFillSchema).max(4).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    strokes: z.array(VisualStrokeSchema).max(3).optional(),
    effects: z.array(VisualEffectSchema).max(4).optional(),
    blendMode: z.enum(["normal", "multiply", "screen", "overlay"]).optional(),
    clipsContent: z.boolean().optional(),
  })
  .strict();
export type VisualStyle = z.infer<typeof VisualStyleSchema>;

export const QualityRuleSchema = z.enum([
  "tiny-text",
  "low-contrast",
  "small-touch-target",
  "overflow-risk",
  "duplicated-pattern",
  "missing-alt",
  "missing-asset-license",
  "spacing-variety",
  "style-variety",
  "weak-hierarchy",
  "repeated-placeholders",
]);
export type QualityRule = z.infer<typeof QualityRuleSchema>;

const VectorAssetPathSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    data: z.string().min(3).max(8_192),
    fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict()
  .superRefine((path, context) => {
    if (!isFigmaPathData(path.data)) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "Use only bounded absolute M/L/Q/C/Z path commands supported by Figma.",
      });
    }
  });

const CommonAssetSchema = {
  id: idSchema,
  name: fileNameSchema,
  width: dimensionSchema,
  height: dimensionSchema,
  license: z.string().trim().min(2).max(500),
  attribution: z.string().trim().max(500).optional(),
};

const RasterAssetSchema = z
  .object({
    ...CommonAssetSchema,
    kind: z.literal("raster"),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif"]),
    base64: z.string().min(16).max(350_000),
    alt: z.string().trim().max(300).optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    const result = inspectEmbeddedImage(asset.base64, asset.mimeType);
    if (!result.valid) {
      context.addIssue({ code: "custom", path: ["base64"], message: result.error });
      return;
    }
    if (result.width !== asset.width || result.height !== asset.height) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: `Declared asset size must match its bytes (${result.width} × ${result.height}).`,
      });
    }
  });

const SvgAssetSchema = z
  .object({
    ...CommonAssetSchema,
    kind: z.literal("svg-paths"),
    paths: z.array(VectorAssetPathSchema).min(1).max(32),
    alt: z.string().trim().max(300).optional(),
  })
  .strict();

export const VisualAssetSchema = z.discriminatedUnion("kind", [RasterAssetSchema, SvgAssetSchema]);
export type VisualAsset = z.infer<typeof VisualAssetSchema>;

export const VisualNodeMetaSchema = z
  .object({
    qualityRole: z.enum(["button", "input", "image", "heading", "body", "decorative"]).optional(),
    qualityExceptions: z.array(QualityRuleSchema).max(10).optional(),
  })
  .strict();

/** Figma accepts only a small, absolute SVG-path subset through VectorNode.vectorPaths. */
export function safeVectorPathString(value: string): boolean {
  return value.length <= 8_192 && isFigmaPathData(value);
}

export function visualAssetSize(asset: VisualAsset): number {
  if (asset.kind === "svg-paths")
    return asset.paths.reduce((size, path) => size + path.data.length, 0);
  return Math.floor((asset.base64.length * 3) / 4);
}
