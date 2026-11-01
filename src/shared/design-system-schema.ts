import { z } from "zod";

export const MAX_DESIGN_SYSTEM_TOKEN_COUNT = 200;

export interface TokenReference {
  token: string;
}

export const TokenReferenceSchema: z.ZodType<TokenReference> = z
  .object({ token: z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*){1,7}$/) })
  .strict();

export const tokenNameSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*){1,7}$/);
export const tokenColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const TokenColorValueSchema = z.union([tokenColorSchema, TokenReferenceSchema]);
export const TokenNumberValueSchema = z.union([
  z.number().finite().min(0).max(10_000),
  TokenReferenceSchema,
]);
const spacingValueSchema = z.union([z.number().finite().min(0).max(1_000), TokenReferenceSchema]);
const radiusValueSchema = z.union([z.number().finite().min(0).max(5_000), TokenReferenceSchema]);
const borderWidthValueSchema = z.union([
  z.number().finite().min(0.25).max(100),
  TokenReferenceSchema,
]);
const fontSizeValueSchema = z.union([z.number().finite().min(1).max(512), TokenReferenceSchema]);
const lineHeightValueSchema = z.union([
  z.number().finite().min(1).max(1_000),
  TokenReferenceSchema,
]);
const letterSpacingValueSchema = z.union([
  z.number().finite().min(-1_000).max(1_000),
  TokenReferenceSchema,
]);

export type TokenColorValue = z.infer<typeof TokenColorValueSchema>;
export type TokenNumberValue = z.infer<typeof TokenNumberValueSchema>;

const fontStyleSchema = z.string().trim().min(1).max(100);
const typographyTokenSchema = z
  .object({
    fontFamily: z.string().trim().min(1).max(100),
    fontStyle: fontStyleSchema.optional(),
    fontWeight: z.number().int().min(100).max(900).multipleOf(100).optional(),
    fontSize: fontSizeValueSchema,
    lineHeight: lineHeightValueSchema.optional(),
    letterSpacing: letterSpacingValueSchema.optional(),
    textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
    textDecoration: z.enum(["none", "underline", "strikethrough"]).optional(),
  })
  .strict()
  .refine((value) => value.fontStyle !== undefined || value.fontWeight !== undefined, {
    message: "Specify fontStyle or fontWeight.",
  });

const spacingSchema = z
  .object({
    scale: z.array(z.number().finite().min(0).max(1_000)).max(64),
    aliases: z.record(tokenNameSchema, spacingValueSchema).default({}),
  })
  .strict();

const radiiSchema = z
  .object({
    scale: z.array(z.number().finite().min(0).max(5_000)).max(64),
    aliases: z.record(tokenNameSchema, radiusValueSchema).default({}),
  })
  .strict();

const borderSchema = z
  .object({
    width: borderWidthValueSchema,
    color: TokenColorValueSchema,
  })
  .strict();

export const DesignSystemTokensSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
    name: z.string().trim().min(1).max(100),
    version: z.string().trim().min(1).max(40).optional(),
    colors: z.record(tokenNameSchema, TokenColorValueSchema).default({}),
    typography: z.record(tokenNameSchema, typographyTokenSchema).default({}),
    spacing: spacingSchema.optional(),
    radii: radiiSchema.optional(),
    borders: z.record(tokenNameSchema, borderSchema).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    const tokenCount =
      Object.keys(value.colors).length +
      Object.keys(value.typography).length +
      (value.spacing?.scale.length ?? 0) +
      Object.keys(value.spacing?.aliases ?? {}).length +
      (value.radii?.scale.length ?? 0) +
      Object.keys(value.radii?.aliases ?? {}).length +
      Object.keys(value.borders).length;
    if (tokenCount > MAX_DESIGN_SYSTEM_TOKEN_COUNT) {
      context.addIssue({
        code: "custom",
        message: `Design system has ${tokenCount} tokens; the limit is ${MAX_DESIGN_SYSTEM_TOKEN_COUNT}.`,
        path: [],
      });
    }
  });

export type DesignSystemTokens = z.infer<typeof DesignSystemTokensSchema>;

export function isTokenReference(value: unknown): value is TokenReference {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).token === "string" &&
    Object.keys(value).length === 1
  );
}
