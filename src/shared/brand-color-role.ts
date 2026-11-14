import { z } from "zod";

export const BrandColorRoleSchema = z.enum([
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "text",
  "mutedText",
  "border",
  "success",
  "warning",
  "error",
]);

export type BrandColorRole = z.infer<typeof BrandColorRoleSchema>;
