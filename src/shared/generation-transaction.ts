import { z } from "zod";
import { type GeneratedDesign } from "./design-generation.js";
import { MAX_SECTION_NODES } from "./generation-limits.js";

const Identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,300}$/u);

export const GenerationTransactionSchema = z
  .object({
    protocol_version: z.literal(1),
    generation_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    document_scope: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    screen_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
    section_id: z.enum(["identity", "primary", "supporting"]),
    transaction_id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    sequence: z.number().int().min(0).max(2),
    parent_node_id: Identity,
    dependencies: z.array(Identity).max(1),
    idempotency_key: Identity,
    operation: z
      .object({
        type: z.literal("append-section"),
        node_id: Identity,
        node_ids: z.array(Identity).min(1).max(MAX_SECTION_NODES),
      })
      .strict(),
    section_completed: z.literal(true),
    screen_completed: z.boolean(),
  })
  .strict();

export type GenerationTransaction = z.infer<typeof GenerationTransactionSchema>;
export const DESIGN_SECTION_IDS = ["identity", "primary", "supporting"] as const;

export function generationIdempotencyKey(
  generationId: string,
  screenId: string,
  sectionId: string,
): string {
  return `fad:v1:${generationId}:${screenId}:${sectionId}`;
}

export function generationSectionNodeIds(
  screen: GeneratedDesign["screens"][number],
  sectionId: GenerationTransaction["section_id"],
): string[] {
  const ids: string[] = [];
  const visit = (node: GeneratedDesign["screens"][number]["children"][number], path: number[]) => {
    ids.push(
      path.length === 0
        ? `section:${screen.id}:${sectionId}`
        : `node:${screen.id}:${sectionId}:${path.join(".")}`,
    );
    node.children.forEach((child, index) => visit(child, [...path, index]));
  };
  screen.children.forEach((node, index) =>
    visit(node, screen.children.length === 1 ? [] : [index]),
  );
  return ids;
}

export function createGenerationTransaction(input: {
  generationId: string;
  documentScope: string;
  screenId: string;
  sectionId: GenerationTransaction["section_id"];
  transactionId: string;
  design: GeneratedDesign;
}): GenerationTransaction {
  const { generationId, documentScope, screenId, sectionId, transactionId, design } = input;
  const screen = design.screens[0];
  if (
    !screen ||
    screen.id !== screenId ||
    design.screens.length !== 1 ||
    screen.children.length !== 1
  )
    throw new Error("section_transaction_requires_one_screen_root");
  const sections = DESIGN_SECTION_IDS;
  const sequence = sections.indexOf(sectionId);
  if (sequence < 0) throw new Error("section_transaction_invalid_section");
  const previous = sequence ? sections[sequence - 1]! : undefined;
  const key = generationIdempotencyKey(generationId, screenId, sectionId);
  return GenerationTransactionSchema.parse({
    protocol_version: 1,
    generation_id: generationId,
    document_scope: documentScope,
    screen_id: screenId,
    section_id: sectionId,
    transaction_id: transactionId,
    sequence,
    parent_node_id: `screen:${screenId}`,
    dependencies: previous ? [generationIdempotencyKey(generationId, screenId, previous)] : [],
    idempotency_key: key,
    operation: {
      type: "append-section",
      node_id: `section:${screenId}:${sectionId}`,
      node_ids: generationSectionNodeIds(screen, sectionId),
    },
    section_completed: true,
    screen_completed: sequence === sections.length - 1,
  });
}

export function validateGenerationTransaction(
  input: unknown,
  expected: {
    generationId: string;
    documentScope: string;
    screenId: string;
    sectionId: GenerationTransaction["section_id"];
    design: GeneratedDesign;
  },
): GenerationTransaction {
  const transaction = GenerationTransactionSchema.parse(input);
  const rebuilt = createGenerationTransaction({
    ...expected,
    transactionId: transaction.transaction_id,
  });
  if (JSON.stringify(transaction) !== JSON.stringify(rebuilt))
    throw new Error("section_transaction_contract_mismatch");
  return transaction;
}

export function plannedSectionSequence(sectionId: string): number | undefined {
  const sequence = DESIGN_SECTION_IDS.indexOf(sectionId as (typeof DESIGN_SECTION_IDS)[number]);
  return sequence < 0 ? undefined : sequence;
}
