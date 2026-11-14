import { z } from "zod";
import {
  MAX_SCREEN_BYTES,
  MAX_SECTION_BYTES,
  MAX_SECTION_NODES,
  utf8Bytes,
} from "./generation-limits.js";
export { MAX_SCREEN_BYTES, MAX_PROJECT_BYTES } from "./generation-limits.js";
import {
  createDesignPlan,
  DesignGenerationRequestSchema,
  generatedSectionLayoutFits,
  validateGeneratedDesignResponse,
  createDesignSections,
  type GeneratedDesign,
} from "./design-generation.js";
import {
  GenerationTransactionSchema,
  createGenerationTransaction,
  type GenerationTransaction,
  validateGenerationTransaction,
} from "./generation-transaction.js";
import { PinnedBrandKitSchema } from "./brand-kit.js";
import { PinnedDesignSkillsSchema } from "./design-skill.js";

export const DraftIdentitySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/u);
export const DraftManifestSchema = z
  .object({
    version: z.literal(1),
    documentId: DraftIdentitySchema,
    generationId: DraftIdentitySchema,
    model: z.string().min(1).max(200),
    request: DesignGenerationRequestSchema,
    brandKit: PinnedBrandKitSchema.optional(),
    designSkills: PinnedDesignSkillsSchema.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DraftManifest = z.infer<typeof DraftManifestSchema>;
export type SavedScreen = { design: GeneratedDesign; rendered: boolean; nodeId?: string };
export type SavedSection = {
  transaction: GenerationTransaction;
  design: GeneratedDesign;
  rendered: boolean;
  nodeId?: string;
};
export type SavedDraft = {
  manifest: DraftManifest;
  screens: SavedScreen[];
  transactions: SavedSection[];
  warnings: string[];
};

export function validateDraftScreen(manifest: DraftManifest, value: unknown): GeneratedDesign {
  const plan = createDesignPlan(manifest.request, manifest.brandKit, manifest.designSkills);
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

export function validateDraftSection(
  manifest: DraftManifest,
  transactionValue: unknown,
  value: unknown,
): { transaction: GenerationTransaction; design: GeneratedDesign } {
  const transaction = GenerationTransactionSchema.parse(transactionValue);
  const design = validateDraftScreen(manifest, value);
  if (utf8Bytes(JSON.stringify(design)) > MAX_SECTION_BYTES)
    throw new Error("draft_section_1MiB_limit");
  const screen = design.screens[0]!;
  const plan = createDesignPlan(manifest.request, manifest.brandKit, manifest.designSkills);
  if (!plan.success) throw new Error("draft_plan_invalid");
  const plannedScreen = plan.data.screens.find(({ id }) => id === screen.id);
  const section = createDesignSections(plan.data).find(({ id }) => id === transaction.section_id);
  if (
    !plannedScreen ||
    !section ||
    screen.children.length !== 1 ||
    screen.children[0]!.type !== "frame" ||
    screen.children[0]!.width > plannedScreen.width - 40 ||
    screen.children[0]!.height > (plannedScreen.devicePreset === "mobile" ? 210 : 240) ||
    !generatedSectionLayoutFits(screen.children[0]!)
  )
    throw new Error("draft_section_root_invalid");
  let nodeCount = 0;
  const count = (nodes: GeneratedDesign["screens"][number]["children"]) => {
    for (const node of nodes) {
      if (++nodeCount > MAX_SECTION_NODES) throw new Error("draft_section_250_nodes_limit");
      count(node.children);
    }
  };
  count(screen.children);
  const checked = validateGenerationTransaction(transaction, {
    generationId: manifest.generationId,
    documentScope: manifest.documentId,
    screenId: screen.id,
    sectionId: section.id,
    design,
  });
  const rebuilt = createGenerationTransaction({
    generationId: manifest.generationId,
    documentScope: manifest.documentId,
    screenId: screen.id,
    sectionId: section.id,
    transactionId: checked.transaction_id,
    design,
  });
  if (JSON.stringify(checked) !== JSON.stringify(rebuilt))
    throw new Error("draft_section_contract_mismatch");
  return { transaction: checked, design };
}
