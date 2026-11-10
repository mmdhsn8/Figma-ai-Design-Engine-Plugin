import { z } from "zod";
import { FigmaToolActionSchema } from "./figma-tools.js";
import {
  nativeTextContrastCorrection,
  type NativeVisualFinding,
  type NativeVisualNode,
} from "./native-visual-quality.js";

export const NATIVE_REPAIR_PIPELINE_VERSION = "native-quality-repair-v1";
export const NativeQualityFindingSchema = z
  .object({
    code: z.enum([
      "missing-ref",
      "invalid-geometry",
      "hidden-node",
      "empty-text",
      "clipped-child",
      "overlapping-auto-layout",
      "low-contrast",
      "viewport-mismatch",
      "missing-section",
      "insufficient-hierarchy",
      "undersized-target",
      "inconsistent-cards",
      "missing-native-fallback",
      "excessive-whitespace",
    ]),
    refs: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u)).max(20),
    expected: z.string().max(300),
    actual: z.string().max(1_000),
  })
  .strict();
export const NativeRepairDecisionSchema = z
  .object({
    findingKey: z.string().max(300),
    code: z.string().regex(/^[a-z-]+$/u),
    refs: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u)),
    eligible: z.boolean(),
    reason: z.string().regex(/^[a-z_]+$/u),
    action: FigmaToolActionSchema.refine(
      (action) =>
        (action.tool === "set_auto_layout" &&
          action.repairOverflow === true &&
          action.children.length === 0) ||
        (action.tool === "set_properties" &&
          Object.keys(action.properties).length === 1 &&
          action.properties.color !== undefined),
    ).optional(),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,100}$/u)
      .optional(),
    toolAllowedInVerifyingStage: z.boolean().optional(),
    dispatchGate: z
      .string()
      .regex(/^[a-z_]+$/u)
      .optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.eligible && !decision.action)
      context.addIssue({
        code: "custom",
        message: "An eligible repair needs a concrete native action.",
      });
  });
export const NativeRepairPlanSchema = z.array(NativeRepairDecisionSchema).max(24);
export const NativeQualityCoverageSchema = z.object({
  complete: z.literal(true),
  nodeCount: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
});
export const NativeVerificationResultSchema = z
  .object({
    repairPipelineVersion: z.literal(NATIVE_REPAIR_PIPELINE_VERSION),
    qualityFindings: z.array(NativeQualityFindingSchema).max(24),
    nativeRepairPlan: NativeRepairPlanSchema,
    qualityCoverage: NativeQualityCoverageSchema,
  })
  .superRefine((result, context) => {
    if (
      result.qualityCoverage.findingCount < result.qualityFindings.length ||
      (result.qualityCoverage.findingCount > 0 && !result.qualityFindings.length)
    )
      context.addIssue({
        code: "custom",
        message:
          "Complete coverage must include every counted finding or a nonempty bounded subset.",
      });
  });
export type NativeRepairDecision = z.infer<typeof NativeRepairDecisionSchema>;

export function planNativeQualityRepairs(
  nodes: NativeVisualNode[],
  findings: NativeVisualFinding[],
  palette: string[],
  taskScoped: boolean,
): NativeRepairDecision[] {
  const byRef = new Map<string, NativeVisualNode>();
  const parentByRef = new Map<string, NativeVisualNode>();
  const visit = (node: NativeVisualNode, parent?: NativeVisualNode) => {
    if (node.ref) {
      byRef.set(node.ref, node);
      if (parent) parentByRef.set(node.ref, parent);
    }
    node.children?.forEach((child) => visit(child, node));
  };
  nodes.forEach((node) => visit(node));
  const decisions = new Map<string, NativeRepairDecision>();
  for (const finding of findings) {
    const refs = finding.refs ?? (finding.ref ? [finding.ref] : []);
    const key = `${finding.code}:${[...refs].sort().join(",")}`;
    if (decisions.has(key)) continue;
    const decision: NativeRepairDecision = {
      findingKey: key,
      code: finding.code,
      refs,
      eligible: false,
      reason: "no_safe_native_strategy",
    };
    const node = byRef.get(refs[0] ?? "");
    const parent = parentByRef.get(refs[0] ?? "");
    if (finding.code === "clipped-child") {
      if (!taskScoped) decision.reason = "missing_task_scope";
      else if (!parent?.ref) decision.reason = "parent_reference_unavailable";
      else if (parent.ownedByTask === false || node?.ownedByTask === false)
        decision.reason = "unowned_content";
      else if (parent.layoutMode !== "VERTICAL" || node?.layoutPositioning === "ABSOLUTE")
        decision.reason = "intentional_or_unsupported_clip";
      else {
        decision.eligible = true;
        decision.reason = "native_hierarchy_measurement";
        decision.action = FigmaToolActionSchema.parse({
          tool: "set_auto_layout",
          ref: parent.ref,
          layout: { direction: "vertical" },
          repairOverflow: true,
        });
      }
    } else if (finding.code === "low-contrast" && node?.ref) {
      const correction = nativeTextContrastCorrection(nodes, node.ref, palette);
      decision.reason = node.ownedByTask === false ? "unowned_content" : correction.reason;
      if (correction.color && node.ownedByTask !== false) {
        decision.eligible = true;
        decision.action = FigmaToolActionSchema.parse({
          tool: "set_properties",
          ref: node.ref,
          properties: { color: correction.color },
        });
      }
    }
    decisions.set(key, decision);
  }
  return [...decisions.values()];
}
