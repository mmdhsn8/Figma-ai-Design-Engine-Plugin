import { z } from "zod";
import { MAX_SCREEN_BYTES, utf8Bytes } from "./generation-limits.js";
export { MAX_SCREEN_BYTES, MAX_PROJECT_BYTES } from "./generation-limits.js";
import {
  createDesignPlan,
  DesignGenerationRequestSchema,
  validateGeneratedDesignResponse,
  type GeneratedDesign,
} from "./design-generation.js";

export const DraftIdentitySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/u);
export const DraftManifestSchema = z
  .object({
    version: z.literal(1),
    documentId: DraftIdentitySchema,
    generationId: DraftIdentitySchema,
    model: z.string().min(1).max(200),
    request: DesignGenerationRequestSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DraftManifest = z.infer<typeof DraftManifestSchema>;
export type SavedScreen = { design: GeneratedDesign; rendered: boolean; nodeId?: string };
export type SavedDraft = { manifest: DraftManifest; screens: SavedScreen[]; warnings: string[] };

export function validateDraftScreen(manifest: DraftManifest, value: unknown): GeneratedDesign {
  const plan = createDesignPlan(manifest.request);
  if (!plan.success) throw new Error("draft_plan_invalid");
  const raw = JSON.stringify(value);
  if (utf8Bytes(raw) > MAX_SCREEN_BYTES) throw new Error("draft_screen_too_large");
  const ids = (value as GeneratedDesign | null)?.screens?.map?.(({ id }) => id);
  if (!ids || ids.length !== 1) throw new Error("draft_screen_invalid");
  const screens = plan.data.screens.filter(({ id }) => ids.includes(id));
  const checked = validateGeneratedDesignResponse(raw, { ...plan.data, screens });
  if (!screens.length || !checked.success) throw new Error("draft_screen_invalid");
  return checked.data.design;
}
