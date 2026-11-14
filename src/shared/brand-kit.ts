import { z } from "zod";
import { FIGMA_CLIENT_STORAGE_QUOTA_BYTES } from "./client-storage-limits.js";
import { parseSafeSvg, inspectEmbeddedImage } from "./visual-assets.js";
import { VisualAssetSchema, type VisualAsset } from "./visual-schema.js";
import { BrandColorRoleSchema, type BrandColorRole } from "./brand-color-role.js";

export { BrandColorRoleSchema } from "./brand-color-role.js";
export type { BrandColorRole } from "./brand-color-role.js";

export const BRAND_KIT_SCHEMA_VERSION = 1 as const;
export const BRAND_KIT_MAX_RECORDS = 100;
export const BRAND_KIT_MAX_ASSET_BYTES = 256 * 1024;
export const BRAND_KIT_MAX_TOTAL_ASSET_BYTES = 1024 * 1024;
export const BRAND_KIT_MAX_ARCHIVE_BYTES = 1024 * 1024;

function decodeUtf8Base64(value: string): string {
  const binary = atob(value);
  const escaped = new Array<string>(binary.length);
  for (let index = 0; index < binary.length; index++)
    escaped[index] = `%${binary.charCodeAt(index).toString(16).padStart(2, "0")}`;
  return decodeURIComponent(escaped.join(""));
}

const SafeId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/u);
const HexColor = z.string().regex(/^#[\da-f]{6}$/iu);
const ColorRoles = BrandColorRoleSchema.options;

const PaletteSchema = z
  .object({
    primary: HexColor,
    secondary: HexColor,
    accent: HexColor,
    background: HexColor,
    surface: HexColor,
    text: HexColor,
    mutedText: HexColor,
    border: HexColor,
    success: HexColor,
    warning: HexColor,
    error: HexColor,
    custom: z.record(z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/u), HexColor).default({}),
  })
  .strict();

export const BrandTypographyRoleSchema = z
  .object({
    requestedFamily: z.string().trim().min(1).max(100),
    fallbackFamily: z.string().trim().min(1).max(100).default("Inter"),
    style: z.string().trim().min(1).max(80).default("Regular"),
    weight: z.number().int().min(100).max(900).multipleOf(100).default(400),
    size: z.number().finite().min(8).max(96),
    lineHeight: z.number().finite().min(8).max(160),
    letterSpacing: z.number().finite().min(-10).max(20).default(0),
    alignment: z.enum(["left", "center", "right", "justified"]).default("left"),
    direction: z.enum(["ltr", "rtl", "auto"]).default("auto"),
  })
  .strict();

const TypographySchema = z
  .object({
    display: BrandTypographyRoleSchema,
    heading1: BrandTypographyRoleSchema,
    heading2: BrandTypographyRoleSchema,
    heading3: BrandTypographyRoleSchema,
    body: BrandTypographyRoleSchema,
    caption: BrandTypographyRoleSchema,
    button: BrandTypographyRoleSchema,
  })
  .strict();

const ShadowSchema = z
  .object({
    color: HexColor,
    opacity: z.number().min(0).max(1),
    offsetX: z.number().min(-100).max(100),
    offsetY: z.number().min(-100).max(100),
    radius: z.number().min(0).max(128),
  })
  .strict();

export const BrandKitAssetSchema = z
  .object({
    assetId: SafeId,
    kind: z.enum(["raster", "svg-paths"]),
    variant: z.enum(["primary", "alternate", "monochrome"]),
    name: z.string().trim().min(1).max(120),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/svg+xml"]),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    contentHash: z.string().regex(/^[0-9a-f]{8}$/u),
    provenance: z.literal("user-provided"),
    rightsNote: z.string().trim().min(2).max(500),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.kind === "svg-paths" && asset.mimeType !== "image/svg+xml")
      context.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: "SVG path assets must use image/svg+xml.",
      });
    if (asset.kind === "raster" && asset.mimeType === "image/svg+xml")
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "SVG files must be parsed as safe editable paths.",
      });
  });

const AssetsSchema = z
  .array(BrandKitAssetSchema)
  .max(8)
  .superRefine((assets, context) => {
    if (new Set(assets.map(({ assetId }) => assetId)).size !== assets.length)
      context.addIssue({ code: "custom", message: "Asset IDs must be unique within a revision." });
    if (new Set(assets.map(({ variant }) => variant)).size !== assets.length)
      context.addIssue({ code: "custom", message: "Each logo variant can appear only once." });
  });

const ThemeSchema = z
  .object({
    mode: z.enum(["light", "dark"]),
    inherits: z.enum(["base", "light", "dark"]).default("base"),
    palette: z.record(z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,47}$/u), HexColor).default({}),
  })
  .strict();

export const BrandKitTokensSchema = z
  .object({
    palette: PaletteSchema,
    typography: TypographySchema,
    spacing: z.array(z.number().finite().min(0).max(128)).min(3).max(8),
    radii: z.array(z.number().finite().min(0).max(128)).min(2).max(6),
    stroke: z.number().finite().min(0.25).max(16),
    shadow: ShadowSchema,
    grid: z
      .object({
        mobileColumns: z.number().int().min(2).max(8),
        desktopColumns: z.number().int().min(4).max(24),
        mobileGutter: z.number().min(0).max(64),
        desktopGutter: z.number().min(0).max(128),
        desktopBreakpoint: z.number().int().min(600).max(2000),
      })
      .strict(),
    density: z.enum(["comfortable", "compact", "spacious"]),
    components: z
      .object({
        buttonRadius: z.number().min(0).max(128),
        cardRadius: z.number().min(0).max(128),
        inputRadius: z.number().min(0).max(128),
        buttonHeight: z.number().min(32).max(72),
      })
      .strict(),
    themes: z.array(ThemeSchema).max(2).default([]),
  })
  .strict()
  .superRefine((tokens, context) => {
    if (new Set(tokens.themes.map(({ mode }) => mode)).size !== tokens.themes.length)
      context.addIssue({
        code: "custom",
        path: ["themes"],
        message: "A theme mode may be defined only once.",
      });
    const themes = new Map(tokens.themes.map((theme) => [theme.mode, theme]));
    for (const mode of themes.keys()) {
      const visited = new Set<string>();
      let current: "light" | "dark" | "base" = mode;
      while (current !== "base") {
        if (visited.has(current)) {
          context.addIssue({
            code: "custom",
            path: ["themes"],
            message: "Theme inheritance must not contain cycles.",
          });
          break;
        }
        visited.add(current);
        current = themes.get(current)?.inherits ?? "base";
      }
    }
  });

export const BrandKitRevisionSchema = z
  .object({
    schemaVersion: z.literal(BRAND_KIT_SCHEMA_VERSION),
    id: SafeId,
    revision: z.number().int().min(1).max(1_000_000),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    locale: z.enum(["fa", "en", "mixed"]).default("fa"),
    direction: z.enum(["rtl", "ltr", "auto"]).default("rtl"),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    status: z.enum(["active", "archived"]),
    notes: z.string().trim().max(1000).optional(),
    tokens: BrandKitTokensSchema,
    assets: AssetsSchema.default([]),
  })
  .strict();
export type BrandKitRevision = z.infer<typeof BrandKitRevisionSchema>;
export type BrandKitTokens = z.infer<typeof BrandKitTokensSchema>;

export const PinnedBrandKitSchema = z
  .object({
    id: SafeId,
    revision: z.number().int().min(1).max(1_000_000),
    name: z.string().trim().min(1).max(100),
    locale: z.enum(["fa", "en", "mixed"]),
    direction: z.enum(["rtl", "ltr", "auto"]),
    tokens: BrandKitTokensSchema,
    assets: AssetsSchema,
    tokenHash: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict()
  .superRefine((kit, context) => {
    if (brandKitTokenHash(kit) !== kit.tokenHash)
      context.addIssue({
        code: "custom",
        path: ["tokenHash"],
        message: "Pinned brand token integrity check failed.",
      });
  });
export type PinnedBrandKit = z.infer<typeof PinnedBrandKitSchema>;

export const BrandKitIndexSchema = z
  .object({
    version: z.literal(BRAND_KIT_SCHEMA_VERSION),
    entries: z
      .array(z.object({ id: SafeId, currentRevision: z.number().int().positive() }).strict())
      .max(BRAND_KIT_MAX_RECORDS),
    defaultBrandId: SafeId.nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type BrandKitIndex = z.infer<typeof BrandKitIndexSchema>;

export const BrandKitStoreSnapshotSchema = z
  .object({
    version: z.literal(BRAND_KIT_SCHEMA_VERSION),
    brands: z.array(BrandKitRevisionSchema).max(BRAND_KIT_MAX_RECORDS),
    defaultBrandId: SafeId.nullable(),
    integrity: z.enum(["clean", "recovered", "future-readonly"]),
    preservedRecordCount: z.number().int().min(0).max(10_000),
  })
  .strict();
export type BrandKitStoreSnapshot = z.infer<typeof BrandKitStoreSnapshotSchema>;

export const BrandKitStorageCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load") }).strict(),
  z
    .object({
      action: z.literal("save"),
      kit: BrandKitRevisionSchema,
      expectedRevision: z.number().int().positive().nullable(),
    })
    .strict(),
  z.object({ action: z.literal("set-default"), brandId: SafeId.nullable() }).strict(),
  z
    .object({
      action: z.literal("set-status"),
      brandId: SafeId,
      status: z.enum(["active", "archived"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("save-asset"),
      assetId: SafeId,
      mimeType: z.string().max(40),
      base64: z.string().max(350_000),
    })
    .strict(),
  z.object({ action: z.literal("load-asset"), assetId: SafeId }).strict(),
  z.object({ action: z.literal("import"), data: z.unknown() }).strict(),
]);
export type BrandKitStorageCommand = z.infer<typeof BrandKitStorageCommandSchema>;

export const BrandKitStorageResultSchema = z
  .object({
    type: z.literal("brand-kit-result"),
    requestId: z.string().min(1).max(100),
    success: z.boolean(),
    snapshot: BrandKitStoreSnapshotSchema.optional(),
    assetBase64: z.string().max(350_000).optional(),
    errorCode: z
      .enum([
        "storage_unavailable",
        "index_corrupt",
        "future_version",
        "revision_conflict",
        "invalid_record",
        "quota_exceeded",
        "archive_failed",
        "asset_missing",
        "asset_invalid",
        "import_collision",
        "not_found",
        "default_invalid",
      ])
      .optional(),
    error: z.string().max(500).optional(),
  })
  .strict();

export const BRAND_KIT_STORAGE_QUOTA_BYTES = FIGMA_CLIENT_STORAGE_QUOTA_BYTES;

export const BrandKitExportSchema = z
  .object({
    schema: z.literal("figma-ai-brand-kit"),
    schemaVersion: z.literal(BRAND_KIT_SCHEMA_VERSION),
    brand: BrandKitRevisionSchema,
    assets: z.array(z.object({ assetId: SafeId, base64: z.string().max(350_000) }).strict()).max(8),
  })
  .strict();

export function brandKitTokenHash(
  kit: Pick<BrandKitRevision, "tokens" | "assets" | "direction">,
): string {
  const source = JSON.stringify({
    tokens: kit.tokens,
    assets: kit.assets,
    direction: kit.direction,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function pinBrandKit(kit: BrandKitRevision): PinnedBrandKit {
  return PinnedBrandKitSchema.parse({
    id: kit.id,
    revision: kit.revision,
    name: kit.name,
    locale: kit.locale,
    direction: kit.direction,
    tokens: kit.tokens,
    assets: kit.assets,
    tokenHash: brandKitTokenHash(kit),
  });
}

export function resolveBrandKitTokens(
  pinned: PinnedBrandKit,
  mode: "light" | "dark" = "light",
): BrandKitTokens {
  const tokens = structuredClone(pinned.tokens);
  const themes = new Map(tokens.themes.map((theme) => [theme.mode, theme]));
  const resolved: Record<string, string> = {};
  const apply = (current: "light" | "dark", visited: Set<string>): void => {
    if (visited.has(current)) return;
    visited.add(current);
    const theme = themes.get(current);
    if (!theme) return;
    if (theme.inherits !== "base") apply(theme.inherits, visited);
    Object.assign(resolved, theme.palette);
  };
  apply(mode, new Set());
  if (!Object.keys(resolved).length) return tokens;
  const palette = { ...tokens.palette, custom: { ...tokens.palette.custom } } as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(resolved)) {
    if (ColorRoles.includes(key as BrandColorRole)) palette[key] = value;
    else (palette.custom as Record<string, string>)[key] = value;
  }
  return BrandKitTokensSchema.parse({ ...tokens, palette });
}

export type BrandTypographyRole = keyof BrandKitTokens["typography"];
export type BrandTextAlignment = "left" | "center" | "right" | "justified";
export type BrandReadingDirection = "LTR" | "RTL";

/** Explicit task direction wins over the pinned kit's default direction. */
export function resolveBrandReadingDirection(
  brandDirection: "rtl" | "ltr" | "auto" | undefined,
  prompt: string,
  fallback: BrandReadingDirection,
): BrandReadingDirection {
  if (
    /(?:\b(?:rtl|right[- ]to[- ]left|right[- ]to left)\b|راست[‌ ]?به[‌ ]?چپ|راست‌چین)/iu.test(
      prompt,
    )
  )
    return "RTL";
  if (/(?:\b(?:ltr|left[- ]to[- ]right)\b|چپ[‌ ]?به[‌ ]?راست|چپ‌چین)/iu.test(prompt)) return "LTR";
  return brandDirection === "rtl" ? "RTL" : brandDirection === "ltr" ? "LTR" : fallback;
}

/** Explicit task alignment wins; otherwise use the selected Brand Kit role alignment. */
export function resolveBrandTextAlignment(
  tokens: Pick<BrandKitTokens, "typography"> | undefined,
  role: BrandTypographyRole,
  prompt: string,
  fallback: BrandTextAlignment,
): BrandTextAlignment {
  const explicit =
    /(?:\b(?:left[- ]aligned|align(?:ment)? to (?:the )?left|align (?:it )?left|flush left)\b|چپ[‌ ]?چین|تراز[‌ ]?چپ)/iu.test(
      prompt,
    )
      ? "left"
      : /(?:\b(?:right[- ]aligned|align(?:ment)? to (?:the )?right|align (?:it )?right|flush right)\b|راست[‌ ]?چین|تراز[‌ ]?راست)/iu.test(
            prompt,
          )
        ? "right"
        : /(?:\b(?:center(?:ed)?[- ]aligned|align(?:ment)? to (?:the )?center|align (?:it )?center)\b|وسط[‌ ]?چین|تراز[‌ ]?وسط)/iu.test(
              prompt,
            )
          ? "center"
          : /(?:\b(?:fully justified|justified text|justify the text)\b|تراز[‌ ]?دوطرفه)/iu.test(
                prompt,
              )
            ? "justified"
            : undefined;
  return explicit ?? tokens?.typography[role].alignment ?? fallback;
}

export function createPinnedBrandKit(kit: BrandKitRevision): PinnedBrandKit {
  return pinBrandKit(BrandKitRevisionSchema.parse(kit));
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)!
    .map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function colorContrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function validateBrandAsset(
  mimeType: string,
  base64: string,
):
  | { valid: true; kind: "raster" | "svg-paths"; width: number; height: number }
  | { valid: false; error: string } {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64))
    return { valid: false, error: "فایل تصویر به‌درستی کدگذاری نشده است." };
  if (base64.length * 0.75 > BRAND_KIT_MAX_ASSET_BYTES)
    return { valid: false, error: "هر فایل نشان حداکثر ۲۵۶ کیلوبایت است." };
  if (mimeType === "image/svg+xml") {
    let source: string;
    try {
      source = decodeUtf8Base64(base64);
    } catch {
      return { valid: false, error: "کدگذاری SVG معتبر نیست." };
    }
    const parsed = parseSafeSvg(source);
    return parsed.success
      ? { valid: true, kind: "svg-paths", width: parsed.data.width, height: parsed.data.height }
      : { valid: false, error: parsed.error };
  }
  if (!(["image/png", "image/jpeg", "image/gif"] as string[]).includes(mimeType))
    return { valid: false, error: "فقط PNG، JPEG، GIF و SVG ایمن پشتیبانی می‌شوند." };
  const inspected = inspectEmbeddedImage(base64, mimeType);
  return inspected.valid
    ? { valid: true, kind: "raster", width: inspected.width, height: inspected.height }
    : { valid: false, error: inspected.error ?? "فایل تصویر معتبر نیست." };
}

export function rejectPrototypeKeys(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => rejectPrototypeKeys(item, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      ["__proto__", "prototype", "constructor"].includes(key) ||
      rejectPrototypeKeys(item, depth + 1),
  );
}

export function brandAssetContentHash(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export function createBrandVisualAsset(
  asset: z.infer<typeof BrandKitAssetSchema>,
  base64: string,
): VisualAsset {
  const validated = validateBrandAsset(asset.mimeType, base64);
  if (
    !validated.valid ||
    validated.kind !== asset.kind ||
    validated.width !== asset.width ||
    validated.height !== asset.height ||
    brandAssetContentHash(base64) !== asset.contentHash
  )
    throw new Error("asset_missing");
  let visual: unknown;
  if (asset.kind === "svg-paths") {
    const source = decodeUtf8Base64(base64);
    const parsed = parseSafeSvg(source);
    if (!parsed.success) throw new Error("asset_invalid");
    visual = {
      id: asset.assetId,
      name: asset.name,
      width: asset.width,
      height: asset.height,
      kind: "svg-paths",
      paths: parsed.data.paths,
      license: asset.rightsNote,
      alt: asset.name,
    };
  } else {
    visual = {
      id: asset.assetId,
      name: asset.name,
      width: asset.width,
      height: asset.height,
      kind: "raster",
      mimeType: asset.mimeType,
      base64,
      license: asset.rightsNote,
      alt: asset.name,
    };
  }
  return VisualAssetSchema.parse(visual);
}
