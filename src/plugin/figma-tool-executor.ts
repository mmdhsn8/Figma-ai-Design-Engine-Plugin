import { z } from "zod";
import {
  AutoLayoutRepairReportSchema,
  FigmaToolAcknowledgementSchema,
  FigmaToolCompatibilityFailureSchema,
  FigmaToolCompatibilityNormalizationSchema,
  FigmaToolParentingDiagnosticSchema,
  FigmaToolStateDiagnosticSchema,
  type FigmaToolAction,
  type FigmaToolBatch,
  type FigmaToolOperation,
  type FigmaToolParentingDiagnostic,
} from "../shared/figma-tools";
import { FigmaCompatibilityError, figmaCompatibilityEngine } from "./figma-compatibility";
import { createProgressiveDiscoveryScanner } from "./document-discovery";
import { repairAutoLayoutHierarchy } from "./auto-layout-repair";
import {
  auditNativeSection,
  MAX_NATIVE_QUALITY_SCAN_DEPTH,
  MAX_NATIVE_QUALITY_SCAN_NODES,
  MAX_NATIVE_QUALITY_OVERLAP_PAIRS,
  type NativeVisualNode,
} from "../shared/native-visual-quality";
import {
  planNativeQualityRepairs,
  NATIVE_REPAIR_PIPELINE_VERSION,
} from "../shared/native-quality-repair";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import { utf8Bytes } from "../shared/generation-limits";
import { planCanvasPlacements } from "./canvas-placement";
import { placeTopLevelNode, readTopLevelCanvasObstacles } from "./figma-canvas-adapter";

const STORAGE_PREFIX = "fad.figma-tools.v1";
const REF_PLUGIN_KEY = "fad.tool.logical-ref.v1";
const OP_PLUGIN_KEY = "fad.tool.operation-id.v1";
const FINGERPRINT_PLUGIN_KEY = "fad.tool.operation-fingerprint.v1";
const CREATION_READBACK_KEY = "fad.tool.creation-readback.v1";
const TASK_PLUGIN_KEY = "fad.tool.task-id.v1";
const DESIGN_NAME_PLUGIN_KEY = "fad.design.name.v1";
const DESIGN_CHAT_PLUGIN_KEY = "fad.design.chat-id.v1";
const DESIGN_TASK_PLUGIN_KEY = "fad.design.task-id.v1";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const OPERATION_TIMEOUT_MS = 10_000;
const ReferenceCandidateSchema = z
  .object({
    canonicalRef: z.string().max(80),
    provenance: z.literal("current_task_alias"),
  })
  .strict();

const StoredStateDataSchema = z
  .object({
    refs: z.record(
      z.string().max(80),
      z
        .object({
          nodeId: z.string().max(100),
          pageId: z.string().max(200),
          parentId: z.string().max(100).optional(),
          nodeType: z.string().max(20).optional(),
          creationFingerprint: z.string().length(32).optional(),
          taskId: z.string().max(60).optional(),
          alias: z.string().max(80).optional(),
          creationOperationId: z.string().max(100).optional(),
          inspectedByTaskId: z.string().max(60).optional(),
          inspectionOnly: z.boolean().optional(),
          existingTarget: z.boolean().optional(),
          ownershipFingerprint: z.string().length(32).optional(),
        })
        .strict(),
    ),
    operations: z.record(
      z.string().max(100),
      z
        .object({
          operationId: z.string().max(100),
          taskId: z.string().max(60).optional(),
          creationRef: z.string().max(80).optional(),
          idempotencyKey: z.string().max(120),
          fingerprint: z.string().length(32),
          status: z.enum(["running", "completed", "failed"]),
          updatedAt: z.number().int().nonnegative(),
          parentingSourceParentId: z.string().max(100).optional(),
          parentingTargetParentId: z.string().max(100).optional(),
          result: z
            .object({
              operationId: z.string().max(100),
              success: z.boolean(),
              replayed: z.boolean(),
              acknowledgementStatus: FigmaToolAcknowledgementSchema.optional(),
              logicalRef: z.string().max(80).optional(),
              summary: z.string().max(300).optional(),
              error: z.string().max(400).optional(),
              data: z
                .object({
                  reused: z.boolean().optional(),
                  overflowRepair: z.array(AutoLayoutRepairReportSchema).optional(),
                  parenting: FigmaToolParentingDiagnosticSchema.optional(),
                  compatibilityNormalizations: z
                    .array(FigmaToolCompatibilityNormalizationSchema)
                    .max(3)
                    .optional(),
                  compatibilityFailure: FigmaToolCompatibilityFailureSchema.optional(),
                  toolStateDiagnostic: FigmaToolStateDiagnosticSchema.optional(),
                  referenceResolution: z
                    .object({
                      code: z.string().max(60),
                      ref: z.string().max(80),
                      stage: z.literal("reference_resolution"),
                      alternatives: z.array(z.string().max(150)).max(3),
                      candidates: z.array(ReferenceCandidateSchema).max(3).optional(),
                      candidateCount: z
                        .number()
                        .int()
                        .min(0)
                        .max(Number.MAX_SAFE_INTEGER)
                        .optional(),
                    })
                    .strict()
                    .optional(),
                })
                .strict()
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

const StoredStateV1Schema = StoredStateDataSchema.extend({ version: z.literal(1) }).strict();
const StoredStateV2Schema = StoredStateDataSchema.extend({ version: z.literal(2) }).strict();
const StoredOperationResultDataSchema = z
  .object({
    reused: z.boolean().optional(),
    overflowRepair: z.array(AutoLayoutRepairReportSchema).optional(),
    parenting: FigmaToolParentingDiagnosticSchema.optional(),
    compatibilityNormalizations: z
      .array(FigmaToolCompatibilityNormalizationSchema)
      .max(3)
      .optional(),
    compatibilityFailure: FigmaToolCompatibilityFailureSchema.optional(),
    toolStateDiagnostic: FigmaToolStateDiagnosticSchema.optional(),
    referenceResolution: z
      .object({
        code: z.string().max(60),
        ref: z.string().max(80),
        stage: z.literal("reference_resolution"),
        alternatives: z.array(z.string().max(150)).max(3),
        candidates: z.array(ReferenceCandidateSchema).max(3).optional(),
        candidateCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const StoredStateV3Schema = z
  .object({
    version: z.literal(3),
    refs: z.record(
      z.string().max(80),
      z.union([
        z.tuple([
          z.string().max(100),
          z.string().max(200),
          z.string().max(100).nullable(),
          z.string().max(20).nullable(),
          z.string().length(32).nullable(),
          z.string().max(60).nullable(),
          z.string().max(80).nullable(),
          z.string().max(100).nullable(),
          z.string().max(60).nullable(),
        ]),
        z.tuple([
          z.string().max(100),
          z.string().max(200),
          z.string().max(100).nullable(),
          z.string().max(20).nullable(),
          z.string().length(32).nullable(),
          z.string().max(60).nullable(),
          z.string().max(80).nullable(),
          z.string().max(100).nullable(),
          z.string().max(60).nullable(),
          z.literal(true),
        ]),
        z.tuple([
          z.string().max(100),
          z.string().max(200),
          z.string().max(100).nullable(),
          z.string().max(20).nullable(),
          z.string().length(32).nullable(),
          z.string().max(60).nullable(),
          z.string().max(80).nullable(),
          z.string().max(100).nullable(),
          z.string().max(60).nullable(),
          z.literal(true).nullable(),
          z.literal(true).nullable(),
          z.string().length(32).nullable(),
        ]),
      ]),
    ),
    operations: z.record(
      z.string().max(100),
      z.tuple([
        z.string().max(100),
        z.string().max(120),
        z.string().length(32),
        z.enum(["running", "completed", "failed"]),
        z.number().int().nonnegative(),
        z.string().max(60).nullable(),
        z.string().max(80).nullable(),
        z.string().max(100).nullable(),
        z.string().max(100).nullable(),
        z
          .tuple([
            z.string().max(100),
            z.boolean(),
            z.boolean(),
            FigmaToolAcknowledgementSchema.nullable(),
            z.string().max(80).nullable(),
            StoredOperationResultDataSchema.nullable(),
            z.string().max(400).nullable(),
            z.string().max(300).nullable(),
          ])
          .nullable(),
      ]),
    ),
  })
  .strict();
const StoredStateSchema = z.discriminatedUnion("version", [
  StoredStateV1Schema,
  StoredStateV2Schema,
  StoredStateV3Schema,
]);

type StoredState = z.infer<typeof StoredStateV2Schema>;
type StoredOperationResult = NonNullable<StoredState["operations"][string]["result"]>;
type ToolStateDiagnostic = z.infer<typeof FigmaToolStateDiagnosticSchema>;

class ToolStateError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ToolStateDiagnostic,
  ) {
    super(message);
  }
}

function expandStoredState(state: z.infer<typeof StoredStateSchema>): StoredState {
  if (state.version === 1 || state.version === 2)
    return StoredStateV2Schema.parse({ ...state, version: 2 });
  return StoredStateV2Schema.parse({
    version: 2,
    refs: Object.fromEntries(
      Object.entries(state.refs).map(([ref, values]) => [
        ref,
        {
          nodeId: values[0],
          pageId: values[1],
          ...(values[2] !== null ? { parentId: values[2] } : {}),
          ...(values[3] !== null ? { nodeType: values[3] } : {}),
          ...(values[4] !== null ? { creationFingerprint: values[4] } : {}),
          ...(values[5] !== null ? { taskId: values[5] } : {}),
          ...(values[6] !== null ? { alias: values[6] } : {}),
          ...(values[7] !== null ? { creationOperationId: values[7] } : {}),
          ...(values[8] !== null ? { inspectedByTaskId: values[8] } : {}),
          ...((values as readonly unknown[])[9] === true ? { inspectionOnly: true } : {}),
          ...((values as readonly unknown[])[10] === true ? { existingTarget: true } : {}),
          ...(typeof (values as readonly unknown[])[11] === "string"
            ? { ownershipFingerprint: (values as readonly unknown[])[11] as string }
            : {}),
        },
      ]),
    ),
    operations: Object.fromEntries(
      Object.entries(state.operations).map(([operationKey, values]) => {
        const [
          operationId,
          idempotencyKey,
          fingerprint,
          status,
          updatedAt,
          taskId,
          creationRef,
          parentingSourceParentId,
          parentingTargetParentId,
          resultValues,
        ] = values;
        const result = resultValues
          ? {
              operationId: resultValues[0],
              success: resultValues[1],
              replayed: resultValues[2],
              ...(resultValues[3] !== null ? { acknowledgementStatus: resultValues[3] } : {}),
              ...(resultValues[4] !== null ? { logicalRef: resultValues[4] } : {}),
              ...(resultValues[5] ? { data: resultValues[5] } : {}),
              ...(resultValues[6] !== null ? { error: resultValues[6] } : {}),
              ...(resultValues[7] !== null ? { summary: resultValues[7] } : {}),
            }
          : undefined;
        return [
          operationKey,
          {
            operationId,
            idempotencyKey,
            fingerprint,
            status,
            updatedAt,
            ...(taskId !== null ? { taskId } : {}),
            ...(creationRef !== null ? { creationRef } : {}),
            ...(parentingSourceParentId !== null ? { parentingSourceParentId } : {}),
            ...(parentingTargetParentId !== null ? { parentingTargetParentId } : {}),
            ...(result ? { result } : {}),
          },
        ];
      }),
    ),
  });
}

function compactStoredState(state: StoredState) {
  return StoredStateV3Schema.parse({
    version: 3,
    refs: Object.fromEntries(
      Object.entries(state.refs).map(([ref, entry]) => [
        ref,
        [
          entry.nodeId,
          entry.pageId,
          entry.parentId ?? null,
          entry.nodeType ?? null,
          entry.creationFingerprint ?? null,
          entry.taskId ?? null,
          entry.alias ?? null,
          entry.creationOperationId ?? null,
          entry.inspectedByTaskId ?? null,
          ...(entry.inspectionOnly ? [true] : []),
          ...(entry.existingTarget || entry.ownershipFingerprint
            ? [entry.inspectionOnly ? true : null, entry.existingTarget ? true : null, entry.ownershipFingerprint ?? null]
            : []),
        ],
      ]),
    ),
    operations: Object.fromEntries(
      Object.entries(state.operations).map(([operationKey, entry]) => [
        operationKey,
        [
          entry.operationId,
          entry.idempotencyKey,
          entry.fingerprint,
          entry.status,
          entry.updatedAt,
          entry.taskId ?? null,
          entry.creationRef ?? null,
          entry.parentingSourceParentId ?? null,
          entry.parentingTargetParentId ?? null,
          entry.result
            ? [
                entry.result.operationId,
                entry.result.success,
                entry.result.replayed,
                entry.result.acknowledgementStatus ?? null,
                entry.result.logicalRef ?? null,
                entry.result.data ?? null,
                entry.result.error ?? null,
                entry.result.summary ?? null,
              ]
            : null,
        ],
      ]),
    ),
  });
}

function toolStateError(
  category: ToolStateDiagnostic["category"],
  location: ToolStateDiagnostic["location"],
  schemaVersion: number | null,
): ToolStateError {
  const diagnostic = FigmaToolStateDiagnosticSchema.parse({
    category,
    location,
    schemaVersion:
      schemaVersion !== null && schemaVersion >= 1 && schemaVersion <= 3 ? schemaVersion : null,
    serializedBytes: null,
  });
  const message =
    category === "storage_unavailable"
      ? "Figma plugin storage could not read or save tool state; the previous saved state was preserved."
      : category === "invalid_schema"
        ? "Saved Figma tool state has an unsupported or invalid schema; existing data was preserved."
        : "Saved Figma tool state could not be read safely; existing data was preserved.";
  return new ToolStateError(message, diagnostic);
}

export function downgradeStoredToolStateForRollback(input: unknown) {
  const state = expandStoredState(StoredStateSchema.parse(input));
  const operations = Object.fromEntries(
    Object.entries(state.operations).map(([id, operation]) => {
      if (!operation.result?.data) return [id, operation];
      const data = Object.fromEntries(
        Object.entries(operation.result.data).filter(
          ([key]) => key !== "compatibilityFailure" && key !== "compatibilityNormalizations",
        ),
      );
      const result = { ...operation.result };
      if (Object.keys(data).length) result.data = data;
      else delete result.data;
      return [
        id,
        {
          ...operation,
          result,
        },
      ];
    }),
  );
  return StoredStateV1Schema.parse({ ...state, version: 1, operations });
}

type OperationResult = {
  operationId: string;
  success: boolean;
  replayed: boolean;
  acknowledgementStatus?: z.infer<typeof FigmaToolAcknowledgementSchema>;
  logicalRef?: string;
  summary?: string;
  data?: Record<string, unknown>;
  error?: string;
};
type ToolSend = (message: PluginToUIMessage) => void;
type ToolLayout = Extract<FigmaToolAction, { tool: "set_auto_layout" }>["layout"];

class ReferenceResolutionError extends Error {
  constructor(
    readonly code: string,
    readonly ref: string,
    readonly candidates: z.infer<typeof ReferenceCandidateSchema>[] = [],
    readonly candidateCount = candidates.length,
  ) {
    super(
      `Reference resolution ${code} for “${ref}”. Inspect a candidate canonical ref or the current selection before editing; do not recreate uncertain nodes.`,
    );
  }
}

class ParentingOperationError extends Error {
  constructor(
    message: string,
    readonly diagnostic: FigmaToolParentingDiagnostic,
    readonly referenceResolution?: OperationResult["data"],
  ) {
    super(message);
  }
}

function isCreation(
  action: FigmaToolAction,
): action is Extract<
  FigmaToolAction,
  { tool: "create_frame" | "create_text" | "create_rectangle" }
> {
  return (
    action.tool === "create_frame" ||
    action.tool === "create_text" ||
    action.tool === "create_rectangle"
  );
}

function referenceFailure(operationId: string, error: ReferenceResolutionError): OperationResult {
  return {
    operationId,
    success: false,
    replayed: false,
    acknowledgementStatus: "rejected",
    error: error.message.slice(0, 400),
    data: {
      referenceResolution: {
        code: error.code,
        ref: error.ref,
        stage: "reference_resolution",
        alternatives: error.candidates.length
          ? [
              "inspect_nodes one listed canonical ref at a time",
              "use set_properties only after inspection confirms the intended node",
              "do not create a replacement",
            ]
          : [
              "inspect_nodes with selection:true, then use its returned canonical ref",
              "get_operation_status with the original operation ID before retrying",
              "do not create a replacement",
            ],
        ...(error.candidates.length ? { candidates: error.candidates } : {}),
        ...(error.candidateCount ? { candidateCount: error.candidateCount } : {}),
      },
    },
  };
}

function isParentingAction(
  action: FigmaToolAction,
): action is Extract<FigmaToolAction, { tool: "append_child" | "reparent_node" }> {
  return action.tool === "append_child" || action.tool === "reparent_node";
}

function parentCategory(
  parent: BaseNode | null | undefined,
): "page_root" | "frame" | "component" | "other" | "detached" | "unknown" {
  if (!parent) return "detached";
  if (parent.type === "PAGE") return "page_root";
  if (parent.type === "FRAME") return "frame";
  if (parent.type === "COMPONENT") return "component";
  return "other";
}

function parentingDiagnostic(
  operationId: string,
  action: Extract<FigmaToolAction, { tool: "append_child" | "reparent_node" }>,
  sourceLogicalRef: string,
  targetLogicalRef: string,
  sourceParent: BaseNode | null | undefined,
  expectedParent: BaseNode | null | undefined,
  actualParent: BaseNode | null | undefined,
  decision: FigmaToolParentingDiagnostic["decision"],
  acknowledgementStatus: FigmaToolParentingDiagnostic["acknowledgementStatus"],
): FigmaToolParentingDiagnostic {
  return FigmaToolParentingDiagnosticSchema.parse({
    operationId,
    toolName: action.tool,
    sourceLogicalRef,
    targetLogicalRef,
    sourceParentCategory: parentCategory(sourceParent),
    expectedParentCategory:
      expectedParent?.type === "FRAME"
        ? "frame"
        : expectedParent?.type === "COMPONENT"
          ? "component"
          : "unknown",
    actualParentCategory: parentCategory(actualParent),
    decision,
    acknowledgementStatus,
  });
}

function resolveTaskAction(
  state: StoredState,
  operation: FigmaToolOperation,
  recoverMissingTaskRef?: (taskId: string, ref: string) => string | undefined,
): FigmaToolAction {
  const taskId = operation.taskId!;
  const action = operation.action;
  const confirmed = (ref: string, entry: StoredState["refs"][string], inspecting: boolean) => {
    if (
      !inspecting &&
      entry.taskId &&
      (!entry.creationOperationId ||
        state.operations[entry.creationOperationId]?.status !== "completed")
    )
      throw new ReferenceResolutionError("unconfirmed_creation", ref);
  };
  const resolve = (ref: string, inspecting = false): string => {
    const own = Object.entries(state.refs).filter(
      ([, entry]) => entry.taskId === taskId && entry.alias === ref,
    );
    if (own.length > 1)
      throw new ReferenceResolutionError(
        "ambiguous",
        ref,
        own.slice(0, 3).map(([canonicalRef]) => ({
          canonicalRef,
          provenance: "current_task_alias",
        })),
        own.length,
      );
    const entry = state.refs[ref];
    if (own.length === 1) {
      // A task-owned alias is authoritative; a page-global literal may be another inspected node.
      confirmed(own[0]![0], own[0]![1], inspecting);
      return own[0]![0];
    }
    if (!entry) {
      const recoveredRef = recoverMissingTaskRef?.(taskId, ref);
      const recovered = recoveredRef ? state.refs[recoveredRef] : undefined;
      if (!recoveredRef || !recovered)
        throw new ReferenceResolutionError("missing_or_uninspected", ref);
      confirmed(recoveredRef, recovered, inspecting);
      return recoveredRef;
    }
    if (entry.taskId !== taskId && entry.inspectedByTaskId !== taskId) {
      const recoveredRef = recoverMissingTaskRef?.(taskId, ref);
      const recovered = recoveredRef ? state.refs[recoveredRef] : undefined;
      if (recoveredRef && recovered) {
        confirmed(recoveredRef, recovered, inspecting);
        return recoveredRef;
      }
    }
    if (!inspecting && entry.taskId !== taskId && entry.inspectedByTaskId !== taskId)
      throw new ReferenceResolutionError("inspection_required", ref);
    confirmed(ref, entry, inspecting);
    return ref;
  };
  if (isCreation(action)) {
    const owned = state.refs[action.ref];
    const ref =
      owned?.taskId === taskId ? action.ref : `task-${fingerprint(`${taskId}:${action.ref}`)}`;
    const reservation = state.refs[ref];
    if (
      operation.expectedCreationOperationId &&
      (!reservation || reservation.creationOperationId !== operation.expectedCreationOperationId)
    )
      throw new ReferenceResolutionError("checkpoint_registry_conflict", ref);
    if (
      reservation &&
      (reservation.taskId !== taskId || (reservation.alias !== action.ref && action.ref !== ref))
    )
      throw new ReferenceResolutionError("namespace_conflict", ref);
    if (
      Object.values(state.operations).some(
        (saved) =>
          saved.taskId === taskId &&
          saved.creationRef === ref &&
          saved.operationId !== operation.operationId &&
          (saved.status === "running" || saved.result?.acknowledgementStatus === "ambiguous"),
      )
    )
      throw new ReferenceResolutionError("unconfirmed_creation", ref);
    return {
      ...action,
      ref,
      parent:
        action.parent.kind === "node"
          ? { kind: "node", ref: resolve(action.parent.ref) }
          : action.parent,
    };
  }
  if (action.tool === "inspect_nodes")
    return { ...action, refs: action.refs.map((ref) => resolve(ref, true)) };
  if (action.tool === "set_auto_layout")
    return {
      ...action,
      ref: resolve(action.ref),
      children: action.children.map((child) => ({ ...child, ref: resolve(child.ref) })),
    };
  if (action.tool === "append_child")
    return { ...action, childRef: resolve(action.childRef), parentRef: resolve(action.parentRef) };
  if (action.tool === "reparent_node")
    return { ...action, ref: resolve(action.ref), parentRef: resolve(action.parentRef) };
  if (action.tool === "set_properties" && action.backgroundRootRef)
    return { ...action, ref: resolve(action.ref), backgroundRootRef: resolve(action.backgroundRootRef, true) };
  if ("ref" in action) return { ...action, ref: resolve(action.ref) };
  return action;
}

function isMutatingAction(tool: FigmaToolAction["tool"]): boolean {
  return [
    "create_frame",
    "create_text",
    "create_rectangle",
    "set_auto_layout",
    "set_properties",
    "append_child",
    "reparent_node",
    "delete_node",
  ].includes(tool);
}

function color(hex: string): RGB {
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function shadowEffect(shadow: {
  color: string;
  opacity: number;
  offsetX: number;
  offsetY: number;
  radius: number;
  spread: number;
}): Effect {
  return {
    type: "DROP_SHADOW",
    color: { ...color(shadow.color), a: shadow.opacity },
    offset: { x: shadow.offsetX, y: shadow.offsetY },
    radius: shadow.radius,
    spread: shadow.spread,
    visible: true,
    blendMode: "NORMAL",
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function actionFingerprint(action: FigmaToolAction): string {
  return fingerprint(stableJson(action));
}

function fingerprint(input: string): string {
  const hashes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex++)
      hashes[hashIndex] = Math.imul(hashes[hashIndex]! ^ code, 16777619) >>> 0;
  }
  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function existingNodeOwnershipFingerprint(node: SceneNode | null): string | undefined {
  if (!node) return undefined;
  const ownershipKeys = [
    "fad.tool.task-id.v1",
    "fad.design.task-id.v1",
    "fad.design.chat-id.v1",
    "fad.design.name.v1",
    "fad.generation.commit",
    "fad.multi-screen.batch-id",
    "fad.multi-screen.screen-id",
    "fad.tool.operation-id.v1",
  ];
  const values = ownershipKeys.map((key) => node.getPluginData(key));
  if (!values.some(Boolean)) return undefined;
  return fingerprint(JSON.stringify(values));
}

function belongsToPage(node: BaseNode, page: PageNode): boolean {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current?.id === page.id;
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${timeoutMs} ms; no further operation was started.`),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function summarizeNode(node: SceneNode, ref?: string) {
  const solidPaint = (paints: readonly Paint[] | PluginAPI["mixed"]): SolidPaint | undefined => {
    if (!Array.isArray(paints)) return undefined;
    return paints.find((item): item is SolidPaint => item.type === "SOLID");
  };
  const colorHex = (paint: SolidPaint | undefined): string | undefined => {
    if (!paint) return undefined;
    return `#${[paint.color.r, paint.color.g, paint.color.b]
      .map((channel) =>
        Math.round(channel * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`.toUpperCase();
  };
  const singleVisibleSolid = (
    paints: readonly Paint[] | PluginAPI["mixed"],
  ): SolidPaint | undefined => {
    if (!Array.isArray(paints)) return undefined;
    const visible = paints.filter((paint) => paint.visible !== false);
    if (visible.length !== 1 || visible[0]?.type !== "SOLID") return undefined;
    const paint = visible[0] as SolidPaint;
    return paint.blendMode === undefined || paint.blendMode === "NORMAL" ? paint : undefined;
  };
  const bounds = node.absoluteBoundingBox;
  const opacity = "opacity" in node ? (node as SceneNode & BlendMixin).opacity : undefined;
  const strokeWeight =
    "strokeWeight" in node ? (node as SceneNode & GeometryMixin).strokeWeight : undefined;
  const fillPaint = singleVisibleSolid("fills" in node ? node.fills : []);
  const strokePaint = solidPaint("strokes" in node ? node.strokes : []);
  const textPaint = node.type === "TEXT" ? singleVisibleSolid(node.fills) : undefined;
  const fillColor = colorHex(fillPaint);
  const strokeColor = colorHex(strokePaint);
  const textColor = colorHex(textPaint);
  const frame = node.type === "FRAME" || node.type === "COMPONENT" ? node : undefined;
  const textNode = node.type === "TEXT" ? node : undefined;
  const fontName =
    textNode && typeof textNode.fontName === "object" ? textNode.fontName : undefined;
  const lineHeight =
    textNode && typeof textNode.lineHeight === "object" ? textNode.lineHeight : undefined;
  const letterSpacing =
    textNode && typeof textNode.letterSpacing === "object" ? textNode.letterSpacing : undefined;
  const effects = "effects" in node && Array.isArray(node.effects) ? node.effects : [];
  const dropShadows = effects.filter((effect) => effect.type === "DROP_SHADOW" && effect.visible !== false);
  const singleDropShadow = dropShadows.length === 1 ? dropShadows[0] : undefined;
  return {
    ...(ref ? { ref } : {}),
    type: node.type,
    name: node.name.slice(0, 100),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
    locked: node.locked,
    ...(bounds
      ? {
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        }
      : {}),
    ...(fillColor && fillPaint
      ? {
          fill: fillColor,
          fillRGB: { r: fillPaint.color.r, g: fillPaint.color.g, b: fillPaint.color.b },
          fillOpacity: fillPaint.opacity ?? 1,
        }
      : {}),
    ...( "fillStyleId" in node && typeof node.fillStyleId === "string"
      ? { fillStyleId: node.fillStyleId }
      : {}),
    ...(strokeColor ? { stroke: strokeColor } : {}),
    ...(typeof opacity === "number" ? { opacity } : {}),
    ...(typeof strokeWeight === "number" ? { strokeWeight } : {}),
    ...("cornerRadius" in node && typeof node.cornerRadius === "number"
      ? { cornerRadius: node.cornerRadius }
      : {}),
    ...(node.type === "TEXT" ? { text: node.characters.slice(0, 120) } : {}),
    ...(textNode && typeof textNode.textAutoResize === "string"
      ? { textAutoResize: textNode.textAutoResize }
      : {}),
    ...(textNode && typeof textNode.textStyleId === "string"
      ? { textStyleId: textNode.textStyleId }
      : {}),
    ...(fontName ? { fontFamily: fontName.family, fontStyle: fontName.style } : {}),
    ...(lineHeight && lineHeight.unit === "PIXELS" ? { lineHeight: lineHeight.value } : {}),
    ...(letterSpacing && letterSpacing.unit === "PIXELS"
      ? { letterSpacing: letterSpacing.value }
      : {}),
    ...(node.type === "TEXT" && typeof node.fontSize === "number"
      ? {
          fontSize: node.fontSize,
          ...(typeof node.textAlignHorizontal === "string"
            ? { textAlignHorizontal: node.textAlignHorizontal }
            : {}),
          ...(textColor && textPaint
            ? {
                textColor,
                textColorRGB: {
                  r: textPaint.color.r,
                  g: textPaint.color.g,
                  b: textPaint.color.b,
                },
                textColorOpacity: textPaint.opacity ?? 1,
              }
            : {}),
        }
      : {}),
    ...(singleDropShadow
      ? {
          shadow: {
            color: `#${[singleDropShadow.color.r, singleDropShadow.color.g, singleDropShadow.color.b]
              .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
              .join("")}`.toUpperCase(),
            opacity: singleDropShadow.color.a,
            offsetX: singleDropShadow.offset.x,
            offsetY: singleDropShadow.offset.y,
            radius: singleDropShadow.radius,
            spread: singleDropShadow.spread,
          },
        }
      : {}),
    ...(frame
      ? {
          layout: frame.layoutMode.toLowerCase(),
          layoutMode: frame.layoutMode,
          itemSpacing: frame.itemSpacing,
          padding: {
            top: frame.paddingTop,
            right: frame.paddingRight,
            bottom: frame.paddingBottom,
            left: frame.paddingLeft,
          },
          primaryAxisSizingMode: frame.primaryAxisSizingMode,
          counterAxisSizingMode: frame.counterAxisSizingMode,
          primaryAxisAlignItems: frame.primaryAxisAlignItems,
          counterAxisAlignItems: frame.counterAxisAlignItems,
          clipsContent: frame.clipsContent,
          childCount: frame.children.length,
        }
      : {}),
    ...(node.absoluteTransform
      ? {
          absoluteTransform: node.absoluteTransform.map((row) => [...row]) as [
            [number, number, number],
            [number, number, number],
          ],
        }
      : {}),
    ...("layoutSizingHorizontal" in node
      ? { layoutSizingHorizontal: node.layoutSizingHorizontal }
      : {}),
    ...("layoutSizingVertical" in node ? { layoutSizingVertical: node.layoutSizingVertical } : {}),
    ...("layoutPositioning" in node ? { layoutPositioning: node.layoutPositioning } : {}),
  };
}

function creationReadback(node: SceneNode): string {
  return fingerprint(
    JSON.stringify([
      node.id,
      node.parent?.id,
      summarizeNode(node),
      node.type === "TEXT" ? node.characters : null,
    ]),
  );
}

// Figma stores children from back to front. Use render bounds for potential
// occluders, and require a provably opaque, axis-aligned background surface.
function resolveVisibleBackground(root: FrameNode): SceneNode | undefined {
  const bounds = root.absoluteBoundingBox;
  const axisAligned = (node: SceneNode) => {
    const [[a, b], [c, d]] = node.absoluteTransform;
    return a > 0 && d > 0 && Math.abs(b) < 0.001 && Math.abs(c) < 0.001;
  };
  const opaque = (node: SceneNode) => {
    if (!("fills" in node) || !Array.isArray(node.fills)) return false;
    const paints = node.fills.filter((paint) => paint.visible !== false);
    const paint = paints[0];
    return paints.length === 1 && paint?.type === "SOLID" &&
      (paint.opacity ?? 1) === 1 && (!paint.blendMode || paint.blendMode === "NORMAL") &&
      (!("opacity" in node) || node.opacity === 1) &&
      (!("blendMode" in node) || node.blendMode === "NORMAL" || node.blendMode === "PASS_THROUGH");
  };
  for (let node: BaseNode | null = root; node && node.type !== "PAGE"; node = node.parent) {
    if (("visible" in node && !node.visible) || ("opacity" in node && node.opacity !== 1))
      return undefined;
  }
  if (!bounds || !bounds.width || !bounds.height || !axisAligned(root) ||
      root.children.length > 24 || root.children.some((node) => "isMask" in node && node.isMask))
    return undefined;
  const layers = root.children.filter((node) => node.visible && (!("opacity" in node) || node.opacity > 0));
  const covers = (box: Rect) => box.x <= bounds.x && box.y <= bounds.y &&
    box.x + box.width >= bounds.x + bounds.width && box.y + box.height >= bounds.y + bounds.height;
  const boxes: Rect[] = [];
  let candidate: SceneNode = root;
  for (const node of [...layers].reverse()) {
    const box = node.absoluteBoundingBox;
    const render = ("absoluteRenderBounds" in node ? node.absoluteRenderBounds : undefined) ?? box;
    if (!render) return undefined;
    if (box && covers(box)) {
      if (node.type !== "RECTANGLE" || !axisAligned(node) || !opaque(node) || node.cornerRadius !== 0)
        return undefined;
      candidate = node;
      break;
    }
    boxes.push(render);
  }
  if (!opaque(candidate)) return undefined;
  // Find a positive-area patch outside all foreground render bounds.
  const edges = (start: number, end: number, values: number[]) =>
    [start, ...values.filter((v) => v > start && v < end), end].sort((a, b) => a - b);
  const xs = edges(bounds.x, bounds.x + bounds.width, boxes.flatMap((b) => [b.x, b.x + b.width]));
  const ys = edges(bounds.y, bounds.y + bounds.height, boxes.flatMap((b) => [b.y, b.y + b.height]));
  return xs.some((x, i) => i > 0 && x > xs[i - 1]! && ys.some((y, j) => {
    if (!j || y <= ys[j - 1]!) return false;
    const px = (x + xs[i - 1]!) / 2;
    const py = (y + ys[j - 1]!) / 2;
    return !boxes.some((b) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height);
  })) ? candidate : undefined;
}

function directChildren(node: SceneNode): readonly SceneNode[] {
  return "children" in node ? node.children : [];
}

function randomToken(): string {
  const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function")
    throw new Error("Secure random values are unavailable; deletion consent cannot be issued.");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomLocalRef(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function compactResult(result: OperationResult): StoredOperationResult {
  const overflowRepair = AutoLayoutRepairReportSchema.array().safeParse(
    result.data?.overflowRepair,
  );
  const data = {
    ...(overflowRepair.success ? { overflowRepair: overflowRepair.data } : {}),
    ...(result.data?.reused ? { reused: true } : {}),
    ...(result.data?.parenting
      ? { parenting: FigmaToolParentingDiagnosticSchema.parse(result.data.parenting) }
      : {}),
    ...(Array.isArray(result.data?.compatibilityNormalizations)
      ? {
          compatibilityNormalizations: result.data.compatibilityNormalizations.map(
            (item: unknown) => FigmaToolCompatibilityNormalizationSchema.parse(item),
          ),
        }
      : {}),
    ...(result.data?.compatibilityFailure
      ? {
          compatibilityFailure: FigmaToolCompatibilityFailureSchema.parse(
            result.data.compatibilityFailure,
          ),
        }
      : {}),
    ...(result.data?.toolStateDiagnostic
      ? {
          toolStateDiagnostic: FigmaToolStateDiagnosticSchema.parse(
            result.data.toolStateDiagnostic,
          ),
        }
      : {}),
    ...(result.data?.referenceResolution
      ? {
          referenceResolution: result.data.referenceResolution as NonNullable<
            StoredOperationResult["data"]
          >["referenceResolution"],
        }
      : {}),
  };
  return {
    operationId: result.operationId,
    success: result.success,
    replayed: result.replayed,
    ...(result.acknowledgementStatus
      ? { acknowledgementStatus: result.acknowledgementStatus }
      : {}),
    ...(result.logicalRef ? { logicalRef: result.logicalRef } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(Object.keys(data).length ? { data } : {}),
  };
}

function boundResults(results: OperationResult[]): void {
  while (utf8Bytes(JSON.stringify(results) ?? "") > MAX_RESULT_BYTES) {
    let largest: OperationResult | undefined;
    let largestBytes = 0;
    for (const result of results) {
      if (!result.data) continue;
      const size = utf8Bytes(JSON.stringify(result.data) ?? "");
      if (size > largestBytes) {
        largest = result;
        largestBytes = size;
      }
    }
    if (!largest) return;
    delete largest.data;
    largest.summary = `${largest.summary ?? "Operation completed."} Detailed output omitted to stay within the response-size limit.`;
  }
}

export function createFigmaToolExecutor(
  api: PluginAPI,
  send: ToolSend,
  options: { operationTimeoutMs?: number } = {},
) {
  const operationTimeoutMs =
    Number.isSafeInteger(options.operationTimeoutMs) && options.operationTimeoutMs! > 0
      ? Math.min(options.operationTimeoutMs!, OPERATION_TIMEOUT_MS)
      : OPERATION_TIMEOUT_MS;
  const timed = <T>(promise: Promise<T>, label: string): Promise<T> =>
    withTimeout(promise, label, operationTimeoutMs);
  let queue: Promise<void> = Promise.resolve();
  let pendingBatches = 0;
  const cancellation = new Map<string, { cancelled: boolean; pauseRequested: boolean }>();
  const deleteConsents = new Map<string, { token: string; ref: string; expiresAt: number }>();
  const startedOperations: number[] = [];
  let pendingStateWrite: Promise<void> | undefined;
  type DiscoverySnapshot = {
    pages: Array<{ id: string; name: string; current: boolean }>;
    frames: Array<Record<string, unknown>>;
    discovery: Record<string, unknown>;
  };
  const progressiveScanner = createProgressiveDiscoveryScanner(api);

  const documentPageKey = (
    pageId = api.currentPage.id,
    initializeDocumentIdentity = true,
  ): string => {
    let documentId = api.root.getPluginData("fad.document-id");
    if (!documentId && initializeDocumentIdentity) {
      documentId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      api.root.setPluginData("fad.document-id", documentId);
    }
    const fileId = api.fileKey ?? documentId ?? api.root.id;
    return `${STORAGE_PREFIX}:${fileId}:${pageId.replaceAll(":", "_")}`;
  };

  const writeStoredState = async (
    state: z.infer<typeof StoredStateV3Schema>,
    pageId: string,
    initializeDocumentIdentity = true,
  ): Promise<void> => {
    try {
      if (pendingStateWrite) throw new Error("A previous tool state write is still settling.");
      const write = api.clientStorage.setAsync(
        documentPageKey(pageId, initializeDocumentIdentity),
        state,
      );
      pendingStateWrite = write;
      const settled = () => {
        if (pendingStateWrite === write) pendingStateWrite = undefined;
      };
      void write.then(settled, settled);
      await timed(write, "Tool state save");
    } catch {
      throw toolStateError("storage_unavailable", "save", 3);
    }
  };

  const loadState = async (
    pageId = api.currentPage.id,
    readOnlyInspection = false,
  ): Promise<StoredState> => {
    let raw: unknown;
    try {
      if (pendingStateWrite) throw new Error("A previous tool state write is still settling.");
      raw = await timed(
        api.clientStorage.getAsync(documentPageKey(pageId, !readOnlyInspection)),
        "Tool state read",
      );
    } catch {
      throw toolStateError("storage_unavailable", "load", null);
    }
    if (raw === undefined) return { version: 2, refs: {}, operations: {} };
    const schemaVersion =
      raw && typeof raw === "object" && "version" in raw && typeof raw.version === "number"
        ? raw.version
        : null;
    let parsed: ReturnType<typeof StoredStateSchema.safeParse>;
    try {
      parsed = StoredStateSchema.safeParse(raw);
    } catch {
      throw toolStateError("corrupted_state", "load", schemaVersion);
    }
    if (!parsed.success) throw toolStateError("invalid_schema", "load", schemaVersion);
    return expandStoredState(parsed.data);
  };

  const saveState = async (
    state: StoredState,
    pageId = api.currentPage.id,
    readOnlyInspection = false,
  ): Promise<void> =>
    writeStoredState(compactStoredState(state), pageId, !readOnlyInspection);

  const assertTaskPageScope = (documentId: string, pageId: string): void => {
    const localDocumentId = api.root.getPluginData("fad.document-id");
    const fileId = api.fileKey ?? localDocumentId;
    const activeDocumentId = fileId ? `${fileId}-${pageId.replaceAll(":", "_")}` : undefined;
    if (api.currentPage.id !== pageId || activeDocumentId !== documentId)
      throw new Error(
        "The active Figma document or page changed. Reopen this task before inspecting it.",
      );
  };

  const inspectTaskNativeNodes = async (
    message: Extract<UIToPluginMessage, { type: "task-native-inspect" }>,
  ) => {
    const pageId = api.currentPage.id;
    assertTaskPageScope(message.documentId, pageId);
    const state = await loadState(pageId);
    assertTaskPageScope(message.documentId, pageId);
    const owned = api.currentPage.findAll(
      (node) => node.getPluginData(TASK_PLUGIN_KEY) === message.taskId,
    );
    const visibleNodes = owned.slice(0, 500);
    const ownedIds = new Set(visibleNodes.map(({ id }) => id));
    const nodes = visibleNodes.map((node) => {
      const savedRef = node.getPluginData(REF_PLUGIN_KEY);
      const refEntry = savedRef ? state.refs[savedRef] : undefined;
      const frame = node as SceneNode & {
        layoutMode?: string;
        itemSpacing?: number;
        paddingTop?: number;
        paddingRight?: number;
        paddingBottom?: number;
        paddingLeft?: number;
        primaryAxisSizingMode?: string;
        counterAxisSizingMode?: string;
      };
      const hasLayout = typeof frame.layoutMode === "string";
      return {
        id: node.id,
        ...(node.parent && ownedIds.has(node.parent.id) ? { parentId: node.parent.id } : {}),
        ...(savedRef &&
        refEntry?.nodeId === node.id &&
        refEntry.pageId === pageId &&
        refEntry.taskId === message.taskId
          ? { ref: refEntry.alias ?? savedRef }
          : {}),
        name: node.name.slice(0, 100),
        type: node.type,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        visible: node.visible,
        ...(hasLayout
          ? {
              layoutMode: frame.layoutMode,
              ...(typeof frame.itemSpacing === "number" ? { itemSpacing: frame.itemSpacing } : {}),
              ...(typeof frame.paddingTop === "number" &&
              typeof frame.paddingRight === "number" &&
              typeof frame.paddingBottom === "number" &&
              typeof frame.paddingLeft === "number"
                ? {
                    padding: {
                      top: frame.paddingTop,
                      right: frame.paddingRight,
                      bottom: frame.paddingBottom,
                      left: frame.paddingLeft,
                    },
                  }
                : {}),
              ...(typeof frame.primaryAxisSizingMode === "string"
                ? { primaryAxisSizingMode: frame.primaryAxisSizingMode }
                : {}),
              ...(typeof frame.counterAxisSizingMode === "string"
                ? { counterAxisSizingMode: frame.counterAxisSizingMode }
                : {}),
            }
          : {}),
      };
    });
    const unresolvedRefs: Array<{
      ref: string;
      status: "missing" | "stale" | "ambiguous" | "unavailable";
    }> = [];
    for (const ref of new Set(message.refs)) {
      const matches = Object.entries(state.refs).filter(
        ([canonicalRef, entry]) => canonicalRef === ref || entry.alias === ref,
      );
      const owned = matches.filter(([, entry]) => entry.taskId === message.taskId);
      if (owned.length > 1) {
        unresolvedRefs.push({ ref, status: "ambiguous" });
        continue;
      }
      const [canonicalRef, entry] = owned[0] ?? [];
      if (!entry) {
        unresolvedRefs.push({ ref, status: matches.length ? "unavailable" : "missing" });
        continue;
      }
      if (entry.pageId !== pageId) {
        unresolvedRefs.push({ ref, status: "missing" });
        continue;
      }
      try {
        const node = await resolveRef(state, canonicalRef!, pageId);
        if (node.getPluginData(TASK_PLUGIN_KEY) !== message.taskId)
          unresolvedRefs.push({ ref, status: "unavailable" });
      } catch (error) {
        const code = error instanceof ReferenceResolutionError ? error.code : "stale";
        const staleNode = code === "stale" ? await api.getNodeByIdAsync(entry.nodeId) : undefined;
        unresolvedRefs.push({
          ref,
          status:
            code === "ambiguous"
              ? "ambiguous"
              : code === "missing_or_other_page"
                ? "missing"
                : code === "stale" && !staleNode
                  ? "missing"
                  : "stale",
        });
      }
    }
    assertTaskPageScope(message.documentId, pageId);
    return { nodes, unresolvedRefs, truncated: owned.length > visibleNodes.length };
  };

  const focusTaskNativeNodes = async (
    message: Extract<UIToPluginMessage, { type: "task-native-focus" }>,
  ): Promise<string[]> => {
    const pageId = api.currentPage.id;
    assertTaskPageScope(message.documentId, pageId);
    const nodes = await Promise.all(message.nodeIds.map((id) => api.getNodeByIdAsync(id)));
    assertTaskPageScope(message.documentId, pageId);
    if (
      nodes.some(
        (node) =>
          !node ||
          !("type" in node) ||
          node.type === "DOCUMENT" ||
          node.type === "PAGE" ||
          !belongsToPage(node, api.currentPage) ||
          (node as SceneNode).getPluginData(TASK_PLUGIN_KEY) !== message.taskId,
      )
    )
      throw new Error("A selected layer is missing, stale, or not owned by this task.");
    const sceneNodes = nodes as SceneNode[];
    if (message.mode === "select") api.currentPage.selection = sceneNodes;
    api.viewport.scrollAndZoomIntoView(sceneNodes);
    assertTaskPageScope(message.documentId, pageId);
    return sceneNodes.map(({ id }) => id);
  };

  const resolveRef = async (
    state: StoredState,
    ref: string,
    pageId = api.currentPage.id,
    allowParentChange = false,
    allowInspectionOnly = false,
  ): Promise<SceneNode> => {
    if (api.currentPage.id !== pageId)
      throw new Error(
        "Figma page changed during the operation; no node was targeted on the new page.",
      );
    const entry = state.refs[ref];
    const creationFingerprint =
      entry?.creationFingerprint ??
      (entry?.creationOperationId
        ? state.operations[entry.creationOperationId]?.fingerprint
        : undefined);
    if (!entry || entry.pageId !== pageId)
      throw new ReferenceResolutionError("missing_or_other_page", ref);
    if (entry.inspectionOnly && !allowInspectionOnly)
      throw new ReferenceResolutionError("inspection_only_reference", ref);
    const node = await timed(api.getNodeByIdAsync(entry.nodeId), "Node reference lookup");
    if (
      api.currentPage.id !== pageId ||
      !node ||
      !("type" in node) ||
      node.type === "DOCUMENT" ||
      node.type === "PAGE" ||
      (entry.existingTarget &&
        (!entry.ownershipFingerprint ||
          existingNodeOwnershipFingerprint(node as SceneNode) !== entry.ownershipFingerprint)) ||
      !belongsToPage(node, api.currentPage) ||
      (!entry.inspectionOnly && !entry.existingTarget && (node as SceneNode).getPluginData(REF_PLUGIN_KEY) !== ref) ||
      (!allowParentChange && entry.parentId && (node as SceneNode).parent?.id !== entry.parentId) ||
      (entry.nodeType && (node as SceneNode).type !== entry.nodeType) ||
      (creationFingerprint &&
        (node as SceneNode).getPluginData(FINGERPRINT_PLUGIN_KEY) !== creationFingerprint) ||
      (entry.taskId && (node as SceneNode).getPluginData(TASK_PLUGIN_KEY) !== entry.taskId) ||
      (entry.creationOperationId &&
        (node as SceneNode).getPluginData(OP_PLUGIN_KEY) !== entry.creationOperationId)
    )
      throw new ReferenceResolutionError("stale", ref);
    if (
      !entry.inspectionOnly &&
      !entry.existingTarget &&
      api.currentPage.findAll((candidate) => candidate.getPluginData(REF_PLUGIN_KEY) === ref)
        .length !== 1
    )
      throw new ReferenceResolutionError("ambiguous", ref);
    return node as SceneNode;
  };

  const resolveParent = async (
    state: StoredState,
    parent: Extract<FigmaToolAction, { tool: "create_frame" }>["parent"],
    pageId: string,
  ): Promise<BaseNode> => {
    if (api.currentPage.id !== pageId)
      throw new Error(
        "Figma page changed during the operation; no node was targeted on the new page.",
      );
    if (parent.kind === "page") return api.currentPage;
    return resolveRef(state, parent.ref, pageId);
  };

  const resolveParentingTargets = async (
    state: StoredState,
    action: Extract<FigmaToolAction, { tool: "append_child" | "reparent_node" }>,
    pageId: string,
  ) => {
    const childRef = action.tool === "append_child" ? action.childRef : action.ref;
    const child = await resolveRef(state, childRef, pageId, true);
    const parent = await resolveRef(state, action.parentRef, pageId);
    return { child, parent, childRef };
  };

  const registerLogicalRef = (
    state: StoredState,
    node: SceneNode,
    pageId: string,
    taskId?: string,
    inspectionOnly = false,
  ): string => {
    const referencePage = api.root.children.find((page) => page.id === pageId);
    const crossPageTarget = !inspectionOnly && api.currentPage.id !== pageId;
    const ownershipFingerprint = !inspectionOnly ? existingNodeOwnershipFingerprint(node) : undefined;
    const persistentExisting = Object.entries(state.refs).find(
      ([, entry]) =>
        entry.nodeId === node.id && entry.pageId === pageId && entry.inspectionOnly !== true,
    );
    const existingTarget = crossPageTarget || persistentExisting?.[1].existingTarget === true;
    if (
      !referencePage ||
      !belongsToPage(node, referencePage) ||
      (existingTarget && !ownershipFingerprint)
    )
      throw new Error(
        "Cross-page target has no verified ownership metadata; no node was tagged or inspected.",
      );
    const inspectionExisting = inspectionOnly
      ? Object.entries(state.refs).find(
          ([, entry]) =>
            entry.nodeId === node.id && entry.pageId === pageId && entry.inspectionOnly === true,
        )
      : undefined;
    const existing = inspectionOnly ? inspectionExisting : persistentExisting;
    if (existing) {
      if (
        existing[1].existingTarget
          ? existing[1].ownershipFingerprint !== ownershipFingerprint
          : !existing[1].inspectionOnly && node.getPluginData(REF_PLUGIN_KEY) !== existing[0]
      )
        throw new ReferenceResolutionError("stale", existing[0]);
      if (
        !existing[1].inspectionOnly &&
        !existing[1].existingTarget &&
        api.currentPage.findAll(
          (candidate) => candidate.getPluginData(REF_PLUGIN_KEY) === existing[0],
        ).length !== 1
      )
        throw new ReferenceResolutionError("ambiguous", existing[0]);
      if (taskId) existing[1].inspectedByTaskId = taskId;
      existing[1].parentId = node.parent?.id;
      existing[1].nodeType = node.type;
      return existing[0];
    }
    const storedRef = node.getPluginData(REF_PLUGIN_KEY);
    if (storedRef && state.refs[storedRef])
      throw new ReferenceResolutionError("ambiguous", storedRef);
    if (
      storedRef &&
      api.currentPage.findAll((candidate) => candidate.getPluginData(REF_PLUGIN_KEY) === storedRef)
        .length !== 1
    )
      throw new ReferenceResolutionError("ambiguous", storedRef);
    const ref =
      storedRef && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u.test(storedRef) && !state.refs[storedRef]
        ? storedRef
        : `${inspectionOnly ? "inspection" : "inspected"}-${randomLocalRef()}`;
    if (!inspectionOnly && !existingTarget) node.setPluginData(REF_PLUGIN_KEY, ref);
    state.refs[ref] = {
      nodeId: node.id,
      pageId,
      parentId: node.parent?.id,
      nodeType: node.type,
      ...(inspectionOnly ? { inspectionOnly: true } : {}),
      ...(existingTarget && ownershipFingerprint ? { existingTarget: true, ownershipFingerprint } : {}),
      ...(taskId ? { inspectedByTaskId: taskId } : {}),
    };
    return ref;
  };

  const discoverDocumentFrames = async (
    state: StoredState,
    isCancelled: () => boolean = () => false,
    inspectionOnlyRefs = false,
    query?: string,
    taskId?: string,
    requestedPageId?: string,
    isPauseRequested: () => boolean = () => false,
    reportProgress: (message: string) => void = () => undefined,
  ): Promise<DiscoverySnapshot> =>
    progressiveScanner({
      api,
      documentKey: api.fileKey ?? api.root.id,
      query,
      taskId,
      pageId: requestedPageId,
      inspectionOnly: inspectionOnlyRefs,
      isCancelled,
      isPauseRequested,
      progress: reportProgress,
      loadState: async (pageId, readOnly) =>
        pageId === api.currentPage.id
          ? (state as unknown as Record<string, unknown>)
          : ((await loadState(pageId, readOnly)) as unknown as Record<string, unknown>),
      saveState: async (saved, pageId, readOnly) =>
        saveState(saved as unknown as StoredState, pageId, readOnly),
      registerInspectionRef: (saved, node, pageId, currentTaskId, inspectionOnly) =>
        registerLogicalRef(
          saved as unknown as StoredState,
          node,
          pageId,
          currentTaskId,
          inspectionOnly === true,
        ),
    });
  const loadFont = async (requested: FontName): Promise<{ font: FontName; fallback: boolean }> => {
    const fonts = await timed(api.listAvailableFontsAsync(), "Font discovery");
    const available = fonts
      .map(({ fontName }) => fontName)
      .sort((a, b) => `${a.family}/${a.style}`.localeCompare(`${b.family}/${b.style}`));
    const candidates = [requested, { family: "Inter", style: "Regular" }, available[0]].filter(
      (font): font is FontName => Boolean(font),
    );
    const selected = candidates.find((candidate) =>
      available.some((font) => font.family === candidate.family && font.style === candidate.style),
    );
    if (!selected) throw new Error("No available font can be loaded for editable text.");
    await timed(api.loadFontAsync(selected), "Font loading");
    return {
      font: selected,
      fallback: selected.family !== requested.family || selected.style !== requested.style,
    };
  };

  const actionResult = async (
    state: StoredState,
    operation: FigmaToolOperation,
    pageId: string,
    markNativeMutation: () => void,
    requestedAction: FigmaToolAction = operation.action,
    isCancelled: () => boolean = () => false,
    isPauseRequested: () => boolean = () => false,
    reportProgress: (message: string) => void = () => undefined,
  ): Promise<{
    summary: string;
    logicalRef?: string;
    data?: Record<string, unknown>;
    replayed?: boolean;
    acknowledgementStatus?: OperationResult["acknowledgementStatus"];
  }> => {
    if (api.currentPage.id !== pageId)
      throw new Error(
        "Figma page changed during the operation; no node was targeted on the new page.",
      );
    const action = operation.action;
    if (action.tool === "get_document_context") {
      const pageName = api.currentPage.name;
      const currentPageId = api.currentPage.id;
      const selection = action.readOnlyInspection === false
        ? []
        : api.currentPage.selection.slice(0, 10).map((node) => summarizeNode(node));
      const [paintStyles, textStyles, variables, collections] =
        (action.offset ?? 0) === 0
          ? await Promise.all([
              timed(api.getLocalPaintStylesAsync(), "Paint token lookup"),
              timed(api.getLocalTextStylesAsync(), "Text token lookup"),
              timed(api.variables.getLocalVariablesAsync(), "Local variable token lookup"),
              timed(api.variables.getLocalVariableCollectionsAsync(), "Variable collection lookup"),
            ])
          : [[], [], [], []];
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed while reading context; no other page was inspected.");
      const discovery = await discoverDocumentFrames(
        state,
        isCancelled,
        action.readOnlyInspection === true,
        action.query,
        operation.taskId,
        action.pageId,
        isPauseRequested,
        reportProgress,
      );
      const query = action.query?.trim();
      const discoveryData = discovery.discovery;
      const totalMatches =
        typeof discoveryData.matchCount === "number" ? discoveryData.matchCount : discovery.frames.length;
      const matchStatus =
        typeof discoveryData.matchStatus === "string" ? discoveryData.matchStatus : "not_queried";
      const publicFrames = discovery.frames.map((frame) => ({
        pageId: frame.pageId,
        pageName: frame.pageName,
        ...(frame.ref ? { ref: frame.ref } : {}),
        ...(frame.nodeId ? { nodeId: frame.nodeId } : {}),
        type: frame.type,
        name: frame.name,
        ...(frame.parentName ? { parentName: frame.parentName } : {}),
        depth: frame.depth,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        visible: frame.visible,
        locked: frame.locked,
        editable: frame.editable,
        ...(frame.projectName ? { projectName: frame.projectName } : {}),
        ...(frame.taskId ? { taskId: frame.taskId } : {}),
        ...(frame.ownerTaskId ? { ownerTaskId: frame.ownerTaskId } : {}),
        ...(frame.chatId ? { chatId: frame.chatId } : {}),
        ...(frame.generationId ? { generationId: frame.generationId } : {}),
        ...(frame.screenId ? { screenId: frame.screenId } : {}),
        ...(frame.nativeInspected === true
          ? { nativeInspected: true, nativeInspection: frame.nativeInspection }
          : {}),
      }));
      const collectionNames = new Map(
        collections.map(({ id, name, defaultModeId }) => [id, { name, defaultModeId }]),
      );
      const variableTokens = variables.slice(0, 20).map((variable) => {
        const collection = collectionNames.get(variable.variableCollectionId);
        const value = collection ? variable.valuesByMode[collection.defaultModeId] : undefined;
        const colorValue =
          value && typeof value === "object" && "r" in value && "g" in value && "b" in value
            ? `#${[value.r, value.g, value.b]
                .map((channel) =>
                  Math.round(Number(channel) * 255)
                    .toString(16)
                    .padStart(2, "0"),
                )
                .join("")}`
            : undefined;
        return {
          id: variable.id,
          name: variable.name.slice(0, 100),
          type: variable.resolvedType,
          ...(collection ? { collection: collection.name.slice(0, 100) } : {}),
          ...((colorValue ??
          (typeof value === "string" || typeof value === "number" ? value : undefined) !==
            undefined)
            ? { value: colorValue ?? value }
            : {}),
        };
      });
      const returnedMatchCount = publicFrames.length;
      const summary = query
        ? `Query “${query.slice(0, 100)}” matched ${totalMatches} frame/component target(s) (${matchStatus}); scanned ${String(discoveryData.pagesVisited ?? 0)}/${String(discoveryData.pagesAvailable ?? 0)} pages${discoveryData.truncated === true ? " with partial coverage" : " completely"}.`
        : `Discovered ${String(discoveryData.framesDiscovered ?? 0)} frame/component target(s) across ${String(discoveryData.pagesVisited ?? 0)} scanned page(s)${discoveryData.truncated === true ? " with partial coverage" : " completely"}.`;
      const data: Record<string, unknown> = {
        document: { id: api.fileKey ?? api.root.getPluginData("fad.document-id") },
        page: { id: currentPageId, name: pageName },
        pages: discovery.pages,
        frames: publicFrames,
        discovery: {
          ...discovery.discovery,
          ...(query ? { query, matchStatus, matchCount: totalMatches } : {}),
          returnedFrameCount: returnedMatchCount,
          offset: 0,
        },
        viewport: { center: api.viewport.center },
        selection: selection.slice(0, 3),
        logicalReferences: action.readOnlyInspection === false
          ? []
          : Object.entries(state.refs)
              .slice(0, 12)
              .map(([ref, entry]) => ({
            ref,
            ...(entry.taskId ? { taskId: entry.taskId, alias: entry.alias } : {}),
            instruction:
              "Historical page ref; inspect before an explicit edit. It is not a requirement for a new design.",
              })),
        tokens: {
          paintStyles: paintStyles
            .slice(0, 8)
            .map(({ id, name }) => ({ id, name: name.slice(0, 80) })),
          textStyles: textStyles
            .slice(0, 8)
            .map(({ id, name }) => ({ id, name: name.slice(0, 80) })),
          variables: variableTokens.slice(0, 8),
        },
      };
      const response = () => JSON.stringify({ summary, data });
      const serializationStarted = Date.now();
      while (utf8Bytes(response()) > 7_000) {
        const tokens = data.tokens as {
          paintStyles: unknown[];
          textStyles: unknown[];
          variables: unknown[];
        };
        if (tokens.variables.length) tokens.variables.pop();
        else if (tokens.paintStyles.length) tokens.paintStyles.pop();
        else if (tokens.textStyles.length) tokens.textStyles.pop();
        else if ((data.logicalReferences as unknown[]).length)
          (data.logicalReferences as unknown[]).pop();
        else if ((data.selection as unknown[]).length) (data.selection as unknown[]).pop();
        else if ((data.frames as unknown[]).length) {
          (data.frames as unknown[]).pop();
          data.discovery = {
            ...(data.discovery as Record<string, unknown>),
            sampleFramesTruncated: true,
            returnedFrameCount: (data.frames as unknown[]).length,
          };
        } else if ((data.pages as unknown[]).length > 1) (data.pages as unknown[]).pop();
        else break;
      }
      (data.discovery as Record<string, unknown>).serializationMs = Math.max(
        0,
        Date.now() - serializationStarted,
      );
      return { summary, data };
    }
    if (action.tool === "inspect_nodes") {
      const roots = action.refs.length
        ? await Promise.all(
            action.refs.map((ref) =>
              resolveRef(
                state,
                ref,
                pageId,
                action.readOnlyInspection !== true,
                action.readOnlyInspection === true,
              ),
            ),
          )
        : api.currentPage.selection;
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed while resolving inspection targets.");
      if (action.purpose === "background_verification") {
        const background = roots[0]?.type === "FRAME" ? resolveVisibleBackground(roots[0]) : undefined;
        const nodes = roots.map((node, index) => summarizeNode(node, action.refs[index]));
        if (!background) return {
          summary: "The effective screen background could not be established.",
          data: { pageId, nodes },
        };
        const root = roots[0]!;
        const ref = background === root ? action.refs[0]! : registerLogicalRef(
          state, background, pageId, operation.taskId, action.readOnlyInspection === true,
        );
        const evidence = summarizeNode(background, ref);
        return {
          summary: "Read the effective screen background.",
          data: {
            pageId, nodes: nodes.some((node) => node.ref === ref) ? nodes : [...nodes, evidence],
            visualBackground: { rootRef: action.refs[0], rootNodeId: root.id, ref,
              nodeId: background.id, type: background.type, fill: evidence.fill },
          },
        };
      }
      if (action.purpose === "structural_verification") {
        let nodeCount = 0;
        let truncated = false;
        let overlapPairs = 0;
        const snapshot = async (
          node: SceneNode,
          depth: number,
        ): Promise<NativeVisualNode | undefined> => {
          if (nodeCount >= MAX_NATIVE_QUALITY_SCAN_NODES) {
            truncated = true;
            return undefined;
          }
          nodeCount++;
          const ref = registerLogicalRef(
            state,
            node,
            pageId,
            operation.taskId,
            action.readOnlyInspection === true,
          );
          const output = {
            ...summarizeNode(node, ref),
            ownedByTask: Boolean(
              operation.taskId && node.getPluginData(TASK_PLUGIN_KEY) === operation.taskId,
            ),
            children: [],
          } as NativeVisualNode;
          if (depth >= MAX_NATIVE_QUALITY_SCAN_DEPTH) {
            if (directChildren(node).length) truncated = true;
            return output;
          }
          const children = directChildren(node);
          if (node.type === "FRAME" || node.type === "COMPONENT") {
            const frame = node as FrameNode | ComponentNode;
            if (frame.layoutMode === "VERTICAL" || frame.layoutMode === "HORIZONTAL") {
              const pairCount = (children.length * (children.length - 1)) / 2;
              if (overlapPairs + pairCount > MAX_NATIVE_QUALITY_OVERLAP_PAIRS) {
                truncated = true;
                return output;
              }
              overlapPairs += pairCount;
            }
          }
          for (const child of children) {
            if (nodeCount >= MAX_NATIVE_QUALITY_SCAN_NODES) {
              truncated = true;
              break;
            }
            const childSnapshot = await snapshot(child, depth + 1);
            if (childSnapshot) output.children!.push(childSnapshot);
            if (nodeCount % 64 === 0)
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (truncated) break;
          }
          return output;
        };
        const qualityRoots = roots.map((node) => {
          while (
            operation.taskId &&
            node.parent &&
            node.parent.type !== "PAGE" &&
            node.parent.type !== "DOCUMENT" &&
            node.parent.getPluginData(TASK_PLUGIN_KEY) === operation.taskId
          )
            node = node.parent as SceneNode;
          return node;
        });
        const rootIds = new Set(qualityRoots.map((node) => node.id));
        const independentRoots = [
          ...new Map(qualityRoots.map((node) => [node.id, node])).values(),
        ].filter((node) => {
          let ancestor = node.parent;
          while (ancestor && ancestor.type !== "PAGE" && ancestor.type !== "DOCUMENT") {
            if (rootIds.has(ancestor.id)) return false;
            ancestor = ancestor.parent;
          }
          return true;
        });
        // Full native QA returns compact findings without expanding raw-node exposure limits.
        const nodes: NativeVisualNode[] = [];
        for (const root of independentRoots) {
          const snapshotRoot = await snapshot(root, 0);
          if (snapshotRoot) nodes.push(snapshotRoot);
          if (truncated) break;
        }
        const findings = truncated ? [] : auditNativeSection(nodes, action.refs);
        const incompleteCoverage =
          truncated || findings.some((finding) => finding.code === "overlap-analysis-limit");
        // Keep the full tree private to the native QA pass, but return one compact native value
        // summary per explicitly requested ref so the task controller can verify mutations.
        const verifiedRoots = roots.slice(0, action.maxNodes).map((node, index) => {
          const ref = registerLogicalRef(
            state,
            node,
            pageId,
            operation.taskId,
            action.readOnlyInspection === true,
          );
          // The evidence is tied to the exact requested reference. A stable stored ref may
          // differ from an approved task alias, so returning it here would make valid native
          // evidence appear missing to the controller.
          return summarizeNode(node, action.refs[index] ?? ref);
        });
        return {
          summary: `Verified ${nodeCount} native layers; ${findings.length} structural finding(s).`,
          data: {
            pageId,
            repairPipelineVersion: NATIVE_REPAIR_PIPELINE_VERSION,
            nodes: verifiedRoots,
            nativeIdentities: roots.slice(0, action.maxNodes).map((node, index) => ({
              ref: action.refs[index], nodeId: node.id, parentId: node.parent?.id, type: node.type,
            })),
            frameBackgrounds: Object.fromEntries(roots.flatMap((root, index) => {
              if (root.type !== "FRAME") return [];
              const effective = resolveVisibleBackground(root);
              return [[action.refs[index], effective === root ? "root" : effective ? "covered" : "unknown"]];
            })),
            qualityCoverage: {
              complete: !incompleteCoverage,
              truncated: incompleteCoverage,
              nodeCount,
              findingCount: findings.length,
            },
            qualityFindings: findings.slice(0, 24).map((finding) => ({
              code: finding.code,
              refs: finding.refs ?? (finding.ref ? [finding.ref] : []),
              expected: finding.expected.slice(0, 300),
              actual: finding.actual.slice(0, 1_000),
            })),
            nativeRepairPlan: planNativeQualityRepairs(
              nodes,
              findings.slice(0, 24),
              action.palette ?? [],
              Boolean(operation.taskId),
            ),
          },
        };
      }
      const summariesById = new Map<string, Record<string, unknown>>();
      const result: Array<Record<string, unknown>> = [];
      const queue: Array<{ node: SceneNode; depth: number; summary: Record<string, unknown> }> = [];
      const add = (node: SceneNode, depth: number): Record<string, unknown> | undefined => {
        const existing = summariesById.get(node.id);
        if (existing) return existing;
        if (result.length >= action.maxNodes) return undefined;
        const ref = registerLogicalRef(
          state,
          node,
          pageId,
          operation.taskId,
          action.readOnlyInspection === true,
        );
        const summary = summarizeNode(node, ref) as Record<string, unknown>;
        summariesById.set(node.id, summary);
        result.push(summary);
        queue.push({ node, depth, summary });
        return summary;
      };
      const rootNodes = roots
        .slice(0, action.maxNodes)
        .map((node) => add(node, 0))
        .filter((node): node is Record<string, unknown> => Boolean(node));
      for (let cursor = 0; cursor < queue.length && result.length < action.maxNodes; cursor++) {
        const current = queue[cursor]!;
        if (current.depth >= action.depth) continue;
        const children = directChildren(current.node)
          .slice(0, action.maxNodes - result.length)
          .map((child) => add(child, current.depth + 1))
          .filter((child): child is Record<string, unknown> => Boolean(child));
        if (children.length) current.summary.children = children;
      }
      return {
        summary: `Inspected ${result.length} node(s) within depth ${action.depth}.`,
        data: { pageId, nodes: rootNodes },
      };
    }
    if (
      action.tool === "create_frame" ||
      action.tool === "create_rectangle" ||
      action.tool === "create_text"
    ) {
      if (!state.refs[action.ref] && operation.expectedCreationOperationId)
        throw new ReferenceResolutionError("checkpoint_registry_conflict", action.ref);
      if (state.refs[action.ref]) {
        const entry = state.refs[action.ref]!;
        const legacyTask =
          !operation.taskId &&
          operation.expectedCreationOperationId &&
          operation.operationId.match(/^(.+)-op-\d+$/u)?.[1];
        const legacyOwned =
          legacyTask && operation.expectedCreationOperationId?.startsWith(`${legacyTask}-op-`);
        if ((!operation.taskId || entry.taskId !== operation.taskId) && !legacyOwned)
          throw new ReferenceResolutionError("reserved_by_other_or_legacy_task", action.ref);
        const existing = await resolveRef(state, action.ref, pageId);
        const creationId =
          entry.creationOperationId ??
          (legacyOwned ? operation.expectedCreationOperationId : undefined);
        const creation = creationId ? state.operations[creationId] : undefined;
        if (
          !creation ||
          creation.status !== "completed" ||
          !creation.result?.success ||
          existing.getPluginData(OP_PLUGIN_KEY) !== creationId ||
          (operation.taskId && existing.getPluginData(TASK_PLUGIN_KEY) !== operation.taskId) ||
          existing.getPluginData(FINGERPRINT_PLUGIN_KEY) !== creation.fingerprint
        )
          throw new ReferenceResolutionError("unconfirmed_creation", action.ref);
        const expectedType =
          action.tool === "create_frame"
            ? "FRAME"
            : action.tool === "create_text"
              ? "TEXT"
              : "RECTANGLE";
        const parent = figmaCompatibilityEngine.requireCreationParent(
          action,
          await resolveParent(state, action.parent, pageId),
        );
        if (existing.type !== expectedType || existing.parent?.id !== parent.id)
          throw new ReferenceResolutionError("type_or_parent_conflict", action.ref);
        return {
          replayed: true,
          logicalRef: action.ref,
          summary:
            "Reused the confirmed task node without changing it. Use set_properties for explicit edits.",
          data: {
            reused: true,
            creationOperationId: creationId,
            node: summarizeNode(existing, action.ref),
          },
        };
      }
      if (
        api.currentPage.findAll((node) => node.getPluginData(REF_PLUGIN_KEY) === action.ref).length
      )
        throw new ReferenceResolutionError("unregistered_existing_node", action.ref);
      const parent = figmaCompatibilityEngine.requireCreationParent(
        action,
        await resolveParent(state, action.parent, pageId),
      );
      if (action.tool !== "create_text") figmaCompatibilityEngine.validateCreationPosition(action);
      const paintStyle =
        action.tool !== "create_text" && action.paintStyleId
          ? (await timed(api.getLocalPaintStylesAsync(), "Paint token lookup")).find(
              ({ id }) => id === action.paintStyleId,
            )
          : undefined;
      figmaCompatibilityEngine.requirePaintStyle(action, Boolean(paintStyle));
      const x = "x" in action ? action.x : undefined;
      const y = "y" in action ? action.y : undefined;
      const isPageParent = parent.type === "PAGE";
      const placement =
        isPageParent && (x === undefined || y === undefined)
          ? planCanvasPlacements(
              [{ id: action.ref, width: action.size.width, height: action.size.height }],
              readTopLevelCanvasObstacles(api.currentPage),
            )[0]
          : undefined;
      let created: SceneNode;
      let fontFallback: boolean | undefined;
      let createdNode: SceneNode | undefined;
      let actualParent: PageNode | FrameNode | ComponentNode = parent;
      let textAction: Extract<FigmaToolAction, { tool: "create_text" }> | undefined;
      let compatibilityNormalizations: ReturnType<
        typeof FigmaToolCompatibilityNormalizationSchema.parse
      >[] = [];
      try {
        if (action.tool === "create_text") {
          const loaded = await loadFont({ family: action.font.family, style: action.font.style });
          if (api.currentPage.id !== pageId)
            throw new Error("Figma page changed while loading the font; text was not created.");
          actualParent = figmaCompatibilityEngine.requireCreationParent(
            action,
            await resolveParent(state, action.parent, pageId),
          );
          const normalized = figmaCompatibilityEngine.normalizeTextSizingForParent(
            action,
            actualParent,
          );
          textAction = normalized.action;
          compatibilityNormalizations = normalized.normalizations;
          fontFallback = loaded.fallback;
          markNativeMutation();
          const text = api.createText();
          createdNode = text;
          text.setPluginData(REF_PLUGIN_KEY, action.ref);
          text.setPluginData(OP_PLUGIN_KEY, operation.operationId);
          text.setPluginData(FINGERPRINT_PLUGIN_KEY, actionFingerprint(action));
          text.name = action.name;
          text.fontName = loaded.font;
          text.fontSize = action.fontSize;
          text.characters = action.text;
          text.fills = [{ type: "SOLID", color: color(action.color ?? "#1F2937") }];
          text.textAlignHorizontal =
            action.align ?? (action.direction === "RTL" ? "RIGHT" : "LEFT");
          if (action.lineHeight !== undefined)
            text.lineHeight = { unit: "PIXELS", value: action.lineHeight };
          if (action.letterSpacing !== undefined)
            text.letterSpacing = { unit: "PIXELS", value: action.letterSpacing };
          text.resize(textAction.size.width, textAction.size.height);
          text.textAutoResize = textAction.textAutoResize;
        } else if (action.tool === "create_frame") {
          markNativeMutation();
          const frame = api.createFrame();
          createdNode = frame;
          frame.setPluginData(REF_PLUGIN_KEY, action.ref);
          frame.setPluginData(OP_PLUGIN_KEY, operation.operationId);
          frame.setPluginData(FINGERPRINT_PLUGIN_KEY, actionFingerprint(action));
          frame.name = action.name;
          frame.resize(action.size.width, action.size.height);
          frame.fills = action.fill ? [{ type: "SOLID", color: color(action.fill) }] : [];
          frame.strokes = action.stroke ? [{ type: "SOLID", color: color(action.stroke) }] : [];
          if (action.strokeWeight !== undefined) frame.strokeWeight = action.strokeWeight;
          frame.cornerRadius = action.cornerRadius;
          if (action.opacity !== undefined) frame.opacity = action.opacity;
          if (action.shadow) frame.effects = [shadowEffect(action.shadow)];
          if (action.clipsContent !== undefined) frame.clipsContent = action.clipsContent;
          if (paintStyle)
            await timed(frame.setFillStyleIdAsync(paintStyle.id), "Paint token apply");
          if (action.autoLayout)
            applyLayout(frame, action.autoLayout, action.parent.kind === "node");
        } else {
          markNativeMutation();
          const rectangle = api.createRectangle();
          createdNode = rectangle;
          rectangle.setPluginData(REF_PLUGIN_KEY, action.ref);
          rectangle.setPluginData(OP_PLUGIN_KEY, operation.operationId);
          rectangle.setPluginData(FINGERPRINT_PLUGIN_KEY, actionFingerprint(action));
          rectangle.name = action.name;
          rectangle.resize(action.size.width, action.size.height);
          rectangle.fills = action.fill ? [{ type: "SOLID", color: color(action.fill) }] : [];
          rectangle.strokes = action.stroke ? [{ type: "SOLID", color: color(action.stroke) }] : [];
          rectangle.strokeWeight = action.strokeWeight;
          rectangle.cornerRadius = action.cornerRadius;
          if (action.opacity !== undefined) rectangle.opacity = action.opacity;
          if (action.shadow) rectangle.effects = [shadowEffect(action.shadow)];
          if (paintStyle)
            await timed(rectangle.setFillStyleIdAsync(paintStyle.id), "Paint token apply");
        }
        created = createdNode!;
        if (operation.taskId) {
          created.setPluginData(TASK_PLUGIN_KEY, operation.taskId);
          if (action.parent.kind === "page") {
            created.setPluginData(DESIGN_TASK_PLUGIN_KEY, operation.taskId);
            if (operation.chatId) created.setPluginData(DESIGN_CHAT_PLUGIN_KEY, operation.chatId);
            if (operation.designName)
              created.setPluginData(DESIGN_NAME_PLUGIN_KEY, operation.designName);
          }
        }
        const isActualPageParent = actualParent.type === "PAGE";
        if (!isActualPageParent) actualParent.appendChild(created);
        if (isActualPageParent && placement)
          placeTopLevelNode(
            created,
            { x: created.x, y: created.y, width: created.width, height: created.height },
            placement,
          );
        else if (x !== undefined && y !== undefined) {
          created.x = x;
          created.y = y;
        }
        if (
          action.tool === "create_text" &&
          !isActualPageParent &&
          (actualParent.type === "FRAME" || actualParent.type === "COMPONENT") &&
          actualParent.layoutMode !== "NONE"
        ) {
          const child = created as TextNode;
          const verticalLayout = actualParent.layoutMode === "VERTICAL";
          if (verticalLayout) {
            if (textAction!.horizontalSizing === "FILL")
              actualParent.counterAxisSizingMode = "FIXED";
            if (textAction!.verticalSizing === "FILL") actualParent.primaryAxisSizingMode = "FIXED";
          } else {
            if (textAction!.horizontalSizing === "FILL")
              actualParent.primaryAxisSizingMode = "FIXED";
            if (textAction!.verticalSizing === "FILL") actualParent.counterAxisSizingMode = "FIXED";
          }
          child.layoutSizingHorizontal = textAction!.horizontalSizing;
          child.layoutSizingVertical = textAction!.verticalSizing;
        }
        created.setPluginData(CREATION_READBACK_KEY, creationReadback(created));
      } catch (error) {
        createdNode?.remove();
        throw error;
      }
      state.refs[action.ref] = {
        nodeId: created.id,
        pageId,
        parentId: created.parent?.id,
        nodeType: created.type,
        creationFingerprint: actionFingerprint(action),
        ...(operation.taskId
          ? { taskId: operation.taskId, creationOperationId: operation.operationId }
          : {}),
      };
      const summary = `${action.tool === "create_text" ? "Editable text" : action.tool === "create_frame" ? "Frame" : "Rectangle"} “${created.name}” created.`;
      return {
        summary: fontFallback
          ? `${summary} Requested font unavailable; used ${(created as TextNode).fontName as FontName}.`
          : summary,
        logicalRef: action.ref,
        data: {
          node: summarizeNode(created, action.ref),
          ...(fontFallback ? { fontFallback: true } : {}),
          ...(compatibilityNormalizations.length ? { compatibilityNormalizations } : {}),
        },
      };
    }
    if (action.tool === "set_auto_layout") {
      const node = await resolveRef(state, action.ref, pageId);
      const childNodes = await Promise.all(
        action.children.map(async (rule) => ({
          rule,
          node: await resolveRef(state, rule.ref, pageId),
        })),
      );
      const compatible = figmaCompatibilityEngine.normalizeAutoLayout(action, node, childNodes);
      if (
        action.repairOverflow &&
        (!operation.taskId || node.getPluginData(TASK_PLUGIN_KEY) !== operation.taskId)
      )
        throw new Error(
          "Hierarchy repair requires a current task-owned frame; external nodes are unchanged.",
        );
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed before Auto Layout was applied.");
      if (action.repairOverflow) {
        let changed = false;
        const overflowRepair = repairAutoLayoutHierarchy(node, operation.taskId!, () => {
          changed = true;
          markNativeMutation();
        });
        return {
          summary: changed
            ? "Grew undersized task-owned vertical containers using native HUG; fresh structural verification is required."
            : "No safe hierarchy sizing change was available; existing layout was preserved. Inspect remaining findings and repair stop reasons.",
          ...(!changed
            ? { replayed: true, acknowledgementStatus: "verified_idempotent_replay" as const }
            : {}),
          data: { overflowRepair, ...(!changed ? { reused: true } : {}) },
        };
      }
      markNativeMutation();
      applyLayout(node as FrameNode | ComponentNode, compatible.layout);
      for (const { rule, node: child, horizontal, vertical } of compatible.children) {
        const autoChild = child as SceneNode & AutoLayoutChildrenMixin & LayoutMixin;
        if (rule.align) autoChild.layoutAlign = rule.align;
        if (rule.grow !== undefined) autoChild.layoutGrow = rule.grow;
        if (horizontal) autoChild.layoutSizingHorizontal = horizontal;
        if (vertical) autoChild.layoutSizingVertical = vertical;
      }
      return {
        summary: compatible.normalizedStretchRefs.length
          ? `Auto Layout set; stretch sizing was normalized for ${compatible.normalizedStretchRefs.join(", ")}.`
          : compatible.normalizations.length
            ? "Auto Layout set; parent sizing was normalized to fixed where FILL/stretch children require it."
            : `Auto Layout set to ${compatible.layout.direction.toLowerCase()} with ${childNodes.length} child rule(s).`,
        data: {
          direction: compatible.layout.direction.toLowerCase(),
          normalizedStretchRefs: compatible.normalizedStretchRefs,
          normalizedPrimarySizing: compatible.normalizations.some(
            ({ fieldPath }) => fieldPath === "action.layout.primarySizing",
          ),
          normalizedCounterSizing: compatible.normalizations.some(
            ({ fieldPath }) => fieldPath === "action.layout.counterSizing",
          ),
          ...(compatible.normalizations.length
            ? { compatibilityNormalizations: compatible.normalizations }
            : {}),
        },
      };
    }
    if (action.tool === "set_properties") {
      if (action.backgroundRootRef) {
        const root = await resolveRef(state, action.backgroundRootRef, pageId, true);
        const effective = root.type === "FRAME" ? resolveVisibleBackground(root) : undefined;
        if (!effective || effective.id !== (await resolveRef(state, action.ref, pageId)).id)
          throw new Error("The visible background changed since inspection. Reinspect before editing.");
      }
      const node = await resolveRef(state, action.ref, pageId);
      const properties = action.properties;
      const changesText =
        properties.text !== undefined ||
        properties.fontSize !== undefined ||
        properties.color !== undefined ||
        properties.align !== undefined ||
        properties.fontFamily !== undefined ||
        properties.fontStyle !== undefined ||
        properties.lineHeight !== undefined ||
        properties.letterSpacing !== undefined ||
        properties.textAutoResize !== undefined;
      const paintStyle = properties.paintStyleId
        ? (await timed(api.getLocalPaintStylesAsync(), "Paint token lookup")).find(
            ({ id }) => id === properties.paintStyleId,
          )
        : undefined;
      const textStyle = properties.textStyleId
        ? (await timed(api.getLocalTextStylesAsync(), "Text token lookup")).find(
            ({ id }) => id === properties.textStyleId,
          )
        : undefined;
      figmaCompatibilityEngine.validateSetProperties(action, node, {
        paintStyleAvailable: Boolean(paintStyle),
        textStyleAvailable: Boolean(textStyle),
      });
      const currentFont = node.type === "TEXT" ? (node as TextNode).fontName : undefined;
      const currentFontName =
        currentFont === undefined || currentFont === api.mixed
          ? undefined
          : (currentFont as FontName);
      const loadedFont =
        changesText && !textStyle
          ? await loadFont({
              family: properties.fontFamily ?? currentFontName?.family ?? "Inter",
              style: properties.fontStyle ?? currentFontName?.style ?? "Regular",
            })
          : undefined;
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed before properties were updated.");
      markNativeMutation();
      if (properties.name !== undefined) node.name = properties.name;
      if (properties.visible !== undefined) node.visible = properties.visible;
      if (properties.width !== undefined || properties.height !== undefined)
        (node as SceneNode & { resize: (width: number, height: number) => void }).resize(
          properties.width ?? node.width,
          properties.height ?? node.height,
        );
      if (properties.fill !== undefined) {
        (node as SceneNode & { fills: readonly Paint[] }).fills = [
          { type: "SOLID", color: color(properties.fill) },
        ];
      }
      if (properties.stroke !== undefined) {
        (node as GeometryMixin).strokes = [{ type: "SOLID", color: color(properties.stroke) }];
      }
      if (properties.strokeWeight !== undefined)
        (node as GeometryMixin).strokeWeight = properties.strokeWeight;
      if (properties.cornerRadius !== undefined)
        (node as SceneNode & CornerMixin).cornerRadius = properties.cornerRadius;
      if (properties.opacity !== undefined)
        (node as SceneNode & BlendMixin).opacity = properties.opacity;
      if (properties.shadow !== undefined) {
        const target = node as SceneNode & BlendMixin;
        target.effects = [
          ...target.effects.filter((effect) => effect.type !== "DROP_SHADOW"),
          shadowEffect(properties.shadow),
        ];
      }
      if (paintStyle)
        await timed(
          (node as GeometryMixin).setFillStyleIdAsync(paintStyle.id),
          "Paint token apply",
        );
      if (textStyle)
        await timed((node as TextNode).setTextStyleIdAsync(textStyle.id), "Text token apply");
      if (changesText) {
        const text = node as TextNode;
        if (loadedFont) text.fontName = loadedFont.font;
        if (properties.text !== undefined) text.characters = properties.text;
        if (properties.fontSize !== undefined) text.fontSize = properties.fontSize;
        if (properties.color !== undefined)
          text.fills = [{ type: "SOLID", color: color(properties.color) }];
        if (properties.align !== undefined) text.textAlignHorizontal = properties.align;
        if (properties.lineHeight !== undefined)
          text.lineHeight = { unit: "PIXELS", value: properties.lineHeight };
        if (properties.letterSpacing !== undefined)
          text.letterSpacing = { unit: "PIXELS", value: properties.letterSpacing };
        if (properties.textAutoResize !== undefined)
          text.textAutoResize = properties.textAutoResize;
      }
      return {
        summary: `Updated only the requested properties on “${node.name}”.`,
        logicalRef: action.ref,
        data: { node: summarizeNode(node, action.ref) },
      };
    }
    if (isParentingAction(action)) {
      const logicalSource = isParentingAction(requestedAction)
        ? requestedAction.tool === "append_child"
          ? requestedAction.childRef
          : requestedAction.ref
        : action.tool === "append_child"
          ? action.childRef
          : action.ref;
      const logicalTarget = isParentingAction(requestedAction)
        ? requestedAction.parentRef
        : action.parentRef;
      let child: SceneNode;
      let parentNode: SceneNode;
      let canonicalChildRef: string;
      const referenceError = (error: ReferenceResolutionError): never => {
        const diagnostic = parentingDiagnostic(
          operation.operationId,
          action,
          logicalSource,
          logicalTarget,
          undefined,
          undefined,
          undefined,
          "rejected_stale_or_ambiguous",
          "rejected",
        );
        throw new ParentingOperationError(
          error.message,
          diagnostic,
          referenceFailure(operation.operationId, error).data,
        );
      };
      try {
        ({
          child,
          parent: parentNode,
          childRef: canonicalChildRef,
        } = await resolveParentingTargets(state, action, pageId));
      } catch (error) {
        if (error instanceof ReferenceResolutionError) referenceError(error);
        throw error;
      }
      const sourceParent = child.parent;
      const diagnostic = (
        decision: FigmaToolParentingDiagnostic["decision"],
        acknowledgementStatus: FigmaToolParentingDiagnostic["acknowledgementStatus"],
        actualParent: BaseNode | null | undefined = child.parent,
      ) =>
        parentingDiagnostic(
          operation.operationId,
          action,
          logicalSource,
          logicalTarget,
          sourceParent,
          parentNode,
          actualParent,
          decision,
          acknowledgementStatus,
        );
      const savedParentId =
        action.tool === "reparent_node" ? state.refs[action.ref]?.parentId : undefined;
      const parentingDecision = figmaCompatibilityEngine.decideParentingCompatibility(
        action,
        child,
        parentNode,
        { expectedSourceParentId: savedParentId },
      );
      if (parentingDecision === "already_parented") {
        const parent = parentNode as FrameNode | ComponentNode;
        const parenting = diagnostic("already_parented", "verified_idempotent_replay");
        return {
          summary: `“${child.name}” is already a child of “${parent.name}”; no move was made.`,
          logicalRef: canonicalChildRef,
          replayed: true,
          acknowledgementStatus: "verified_idempotent_replay",
          data: { reused: true, parenting },
        };
      }
      if (parentingDecision !== "ready") {
        const messages = {
          rejected_parent: "The parent must be a current-page frame or component.",
          rejected_cycle: "Reparenting would create a parent-child cycle.",
          rejected_non_root:
            "append_child only accepts a node currently at the page root; use reparent_node for an intentional move.",
          rejected_stale_or_ambiguous:
            "The node's parent changed outside a confirmed operation; inspect its current parent before reparenting.",
        } as const;
        throw new ParentingOperationError(
          messages[parentingDecision],
          diagnostic(
            parentingDecision,
            parentingDecision === "rejected_stale_or_ambiguous" ? "ambiguous" : "rejected",
          ),
        );
      }
      const parent = parentNode as FrameNode | ComponentNode;
      try {
        markNativeMutation();
        parent.appendChild(child);
      } catch {
        if (child.parent?.id !== parent.id)
          throw new ParentingOperationError(
            "Figma did not confirm the requested parent change; inspect the node before retrying.",
            diagnostic(
              "native_error",
              child.parent?.id === sourceParent?.id ? "rejected" : "ambiguous",
            ),
          );
      }
      if (child.parent?.id !== parent.id)
        throw new ParentingOperationError(
          "Figma did not confirm the requested parent change; inspect the node before retrying.",
          diagnostic("native_error", "ambiguous"),
        );
      const parenting = diagnostic(
        action.tool === "append_child" ? "appended" : "reparented",
        "confirmed_mutation",
        child.parent,
      );
      return {
        summary: `“${child.name}” is now a child of “${parent.name}”.`,
        logicalRef: canonicalChildRef,
        acknowledgementStatus: "confirmed_mutation",
        data: { parenting },
      };
    }
    if (action.tool === "delete_node") {
      const consent = deleteConsents.get(action.consentToken);
      figmaCompatibilityEngine.requireDeleteConsent(
        action,
        Boolean(
          consent &&
          consent.token === action.consentToken &&
          consent.ref === action.ref &&
          consent.expiresAt >= Date.now(),
        ),
      );
      deleteConsents.delete(action.consentToken);
      const node = await resolveRef(state, action.ref, pageId);
      const subtreeIds = new Set<string>([node.id]);
      const collect = (child: SceneNode): void =>
        directChildren(child).forEach((nested) => {
          subtreeIds.add(nested.id);
          collect(nested);
        });
      collect(node);
      markNativeMutation();
      node.remove();
      return {
        summary: `Deleted “${node.name}” and its ${subtreeIds.size - 1} descendant(s) after scoped confirmation.`,
      };
    }
    throw new Error("Unsupported Figma tool.");
  };

  const applyLayout = (
    frame: FrameNode | ComponentNode,
    layout: ToolLayout,
    nested = frame.parent?.type !== "PAGE",
  ) => {
    frame.layoutMode = layout.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    frame.primaryAxisSizingMode =
      layout.primarySizing ?? (nested && layout.direction === "vertical" ? "AUTO" : "FIXED");
    frame.counterAxisSizingMode = layout.counterSizing;
    frame.primaryAxisAlignItems = layout.primaryAlign;
    frame.counterAxisAlignItems = layout.counterAlign;
    frame.itemSpacing = layout.gap;
    frame.paddingTop = layout.padding.top;
    frame.paddingRight = layout.padding.right;
    frame.paddingBottom = layout.padding.bottom;
    frame.paddingLeft = layout.padding.left;
  };

  const recoverTaskReference = (
    state: StoredState,
    taskId: string,
    ref: string,
    pageId: string,
  ): string | undefined => {
    if (api.currentPage.id !== pageId) return undefined;
    const possibleRefs = new Set([ref, `task-${fingerprint(`${taskId}:${ref}`)}`]);
    const recovered: Array<{
      ref: string;
      node: SceneNode;
      operationId: string;
      fingerprint: string;
    }> = [];
    for (const canonicalRef of possibleRefs) {
      const taggedNodes = api.currentPage.findAll(
        (node) => node.getPluginData(REF_PLUGIN_KEY) === canonicalRef,
      );
      if (taggedNodes.length > 1)
        throw new ReferenceResolutionError(
          "ambiguous",
          ref,
          [{ canonicalRef, provenance: "current_task_alias" }],
          taggedNodes.length,
        );
      const node = taggedNodes[0];
      if (
        !node ||
        node.getPluginData(TASK_PLUGIN_KEY) !== taskId ||
        !belongsToPage(node, api.currentPage)
      )
        continue;
      const operationId = node.getPluginData(OP_PLUGIN_KEY);
      const nodeFingerprint = node.getPluginData(FINGERPRINT_PLUGIN_KEY);
      const creation = operationId ? state.operations[operationId] : undefined;
      if (
        !operationId ||
        !nodeFingerprint ||
        api.currentPage.findAll(
          (candidate) => candidate.getPluginData(OP_PLUGIN_KEY) === operationId,
        ).length !== 1 ||
        !creation ||
        creation.status !== "completed" ||
        creation.taskId !== taskId ||
        creation.creationRef !== canonicalRef ||
        creation.fingerprint !== nodeFingerprint ||
        !creation.result?.success ||
        creation.result.logicalRef !== canonicalRef ||
        !["FRAME", "TEXT", "RECTANGLE"].includes(node.type)
      )
        continue;
      recovered.push({ ref: canonicalRef, node, operationId, fingerprint: nodeFingerprint });
    }
    if (recovered.length > 1)
      throw new ReferenceResolutionError(
        "ambiguous",
        ref,
        recovered.slice(0, 3).map(({ ref: canonicalRef }) => ({
          canonicalRef,
          provenance: "current_task_alias" as const,
        })),
        recovered.length,
      );
    const match = recovered[0];
    if (!match) return undefined;
    const alias = match.ref === ref ? undefined : ref;
    state.refs[match.ref] = {
      nodeId: match.node.id,
      pageId,
      parentId: match.node.parent?.id,
      nodeType: match.node.type,
      creationFingerprint: match.fingerprint,
      taskId,
      ...(alias ? { alias } : {}),
      creationOperationId: match.operationId,
    };
    return match.ref;
  };

  const executeOperation = async (
    state: StoredState,
    operation: FigmaToolOperation,
    pageId: string,
    isCancelled: () => boolean = () => false,
    isPauseRequested: () => boolean = () => false,
    reportProgress: (message: string) => void = () => undefined,
  ): Promise<OperationResult> => {
    const requestedAction = operation.action;
    if (requestedAction.tool === "get_operation_status") {
      const targetId = requestedAction.operationId;
      const saved = Object.hasOwn(state.operations, targetId)
        ? state.operations[targetId]
        : undefined;
      const scoped = saved?.taskId === operation.taskId ? saved : undefined;
      return {
        operationId: operation.operationId,
        success: true,
        replayed: false,
        acknowledgementStatus: "read_only",
        data: {
          operationId: targetId,
          status: scoped?.status ?? "unknown",
          ...(scoped ? { updatedAt: scoped.updatedAt } : {}),
          ...(scoped?.result ? { result: scoped.result } : {}),
        },
      };
    }
    const readOnlyInspection =
      (requestedAction.tool === "get_document_context" || requestedAction.tool === "inspect_nodes") &&
      requestedAction.readOnlyInspection === true;
    const alias = isCreation(operation.action) ? operation.action.ref : undefined;
    const requestedFingerprint = actionFingerprint(requestedAction);
    const original = state.operations[operation.operationId];
    if (
      original?.status === "failed" &&
      (original.result?.acknowledgementStatus === "rejected" ||
        original.result?.acknowledgementStatus === "not_attempted") &&
      original.fingerprint === requestedFingerprint &&
      original.taskId === operation.taskId &&
      original.idempotencyKey === operation.idempotencyKey
    )
      return { ...original.result, replayed: true };
    if (operation.reconcileOnly && original?.taskId !== operation.taskId && original)
      return {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        acknowledgementStatus: "ambiguous",
        error: "The saved operation does not belong to the current task.",
      };
    const persistPreflightRejection = async (result: OperationResult) => {
      if (
        isMutatingAction(requestedAction.tool) &&
        !operation.reconcileOnly &&
        !original &&
        !Object.values(state.operations).some(
          (saved) => saved.idempotencyKey === operation.idempotencyKey,
        )
      ) {
        state.operations[operation.operationId] = {
          operationId: operation.operationId,
          idempotencyKey: operation.idempotencyKey,
          ...(operation.taskId ? { taskId: operation.taskId } : {}),
          fingerprint: requestedFingerprint,
          status: "failed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId, readOnlyInspection);
      }
      if (operation.reconcileOnly)
        return { ...result, acknowledgementStatus: "ambiguous" as const };
      return result;
    };
    if (operation.taskId) {
      try {
        operation = {
          ...operation,
          action: resolveTaskAction(state, operation, (taskId, ref) =>
            recoverTaskReference(state, taskId, ref, pageId),
          ),
        };
      } catch (error) {
        if (!(error instanceof ReferenceResolutionError)) throw error;
        const result = referenceFailure(operation.operationId, error);
        if (!isParentingAction(requestedAction)) return persistPreflightRejection(result);
        const sourceLogicalRef =
          requestedAction.tool === "append_child" ? requestedAction.childRef : requestedAction.ref;
        const parenting = FigmaToolParentingDiagnosticSchema.parse({
          operationId: operation.operationId,
          toolName: requestedAction.tool,
          sourceLogicalRef,
          targetLogicalRef: requestedAction.parentRef,
          sourceParentCategory: "unknown",
          expectedParentCategory: "unknown",
          actualParentCategory: "unknown",
          decision: "rejected_stale_or_ambiguous",
          acknowledgementStatus: "rejected",
        });
        return persistPreflightRejection({ ...result, data: { ...result.data, parenting } });
      }
    }
    if (api.currentPage.id !== pageId)
      return {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        acknowledgementStatus: "rejected",
        error: "Figma page changed during the batch; no operation was applied to the new page.",
      };
    const fingerprint = actionFingerprint(operation.action);
    const priorByKey = Object.values(state.operations).find(
      (saved) => saved.idempotencyKey === operation.idempotencyKey,
    );
    const prior = state.operations[operation.operationId] ?? priorByKey;
    if (prior) {
      if (
        prior.operationId !== operation.operationId ||
        prior.taskId !== operation.taskId ||
        prior.fingerprint !== fingerprint ||
        prior.idempotencyKey !== operation.idempotencyKey
      )
        return {
          operationId: operation.operationId,
          success: false,
          replayed: true,
          acknowledgementStatus: operation.reconcileOnly ? "ambiguous" : "rejected",
          error: "Operation ID or idempotency key was already used with different input.",
        };
      if (
        prior.status === "completed" &&
        prior.result &&
        operation.taskId &&
        isCreation(operation.action)
      ) {
        try {
          const node = await resolveRef(state, operation.action.ref, pageId);
          if (node.getPluginData(TASK_PLUGIN_KEY) !== operation.taskId)
            throw new ReferenceResolutionError("ownership_conflict", operation.action.ref);
        } catch (error) {
          if (!(error instanceof ReferenceResolutionError)) throw error;
          const result = referenceFailure(operation.operationId, error);
          return operation.reconcileOnly
            ? { ...result, acknowledgementStatus: "ambiguous" }
            : result;
        }
      }
      const refreshNativeVerification =
        operation.action.tool === "inspect_nodes" &&
        operation.action.purpose !== undefined;
      const retryReadOnlyInspection =
        (operation.action.tool === "inspect_nodes" ||
          operation.action.tool === "get_document_context") &&
        prior.status !== "completed";
      if (prior.status === "completed" && prior.result && !refreshNativeVerification)
        return {
          ...(prior.result as unknown as OperationResult),
          replayed: true,
          acknowledgementStatus:
            prior.result.acknowledgementStatus ??
            (prior.result.success
              ? prior.result.data?.reused
                ? "verified_idempotent_replay"
                : isMutatingAction(operation.action.tool)
                  ? "confirmed_mutation"
                  : "read_only"
              : "rejected"),
        };
      let resumeParenting = false;
      if (
        isParentingAction(operation.action) &&
        (prior.status === "running" ||
          (prior.status === "failed" && prior.result?.acknowledgementStatus === "ambiguous"))
      ) {
        const recoveryAction = operation.action;
        const requestedParentingAction = isParentingAction(requestedAction)
          ? requestedAction
          : recoveryAction;
        const sourceLogicalRef =
          requestedParentingAction.tool === "append_child"
            ? requestedParentingAction.childRef
            : requestedParentingAction.ref;
        const targetLogicalRef = requestedParentingAction.parentRef;
        const persistParentingRecovery = async (result: OperationResult) => {
          prior.status = result.success ? "completed" : "failed";
          prior.updatedAt = Date.now();
          prior.result = compactResult(result);
          if (result.success) {
            const childRef =
              recoveryAction.tool === "append_child" ? recoveryAction.childRef : recoveryAction.ref;
            const childEntry = state.refs[childRef];
            const targetEntry = state.refs[recoveryAction.parentRef];
            if (childEntry && targetEntry) childEntry.parentId = targetEntry.nodeId;
          }
          await saveState(state, pageId, readOnlyInspection);
          return result;
        };
        try {
          const { child, parent } = await resolveParentingTargets(state, operation.action, pageId);
          const canonicalChildRef =
            operation.action.tool === "append_child"
              ? operation.action.childRef
              : operation.action.ref;
          const parentingDecision = figmaCompatibilityEngine.decideParentingCompatibility(
            operation.action,
            child,
            parent,
            { expectedSourceParentId: prior.parentingSourceParentId, recovery: true },
          );
          if (parentingDecision === "rejected_parent" || parentingDecision === "rejected_cycle") {
            const decision = parentingDecision;
            const diagnostic = parentingDiagnostic(
              operation.operationId,
              operation.action,
              sourceLogicalRef,
              targetLogicalRef,
              child.parent,
              parent,
              child.parent,
              decision,
              "rejected",
            );
            return persistParentingRecovery({
              operationId: operation.operationId,
              success: false,
              replayed: true,
              acknowledgementStatus: "rejected",
              error:
                decision === "rejected_parent"
                  ? "The parent must be a current-page frame or component."
                  : "Reparenting would create a parent-child cycle.",
              data: { parenting: diagnostic },
            });
          }
          if (parentingDecision === "already_parented") {
            const committedBeforeInterruption =
              Boolean(prior.parentingSourceParentId) && prior.parentingSourceParentId !== parent.id;
            const acknowledgementStatus = committedBeforeInterruption
              ? "confirmed_mutation"
              : "verified_idempotent_replay";
            const diagnostic = parentingDiagnostic(
              operation.operationId,
              operation.action,
              sourceLogicalRef,
              targetLogicalRef,
              child.parent,
              parent,
              child.parent,
              committedBeforeInterruption ? "reconciled_commit" : "reconciled_noop",
              acknowledgementStatus,
            );
            const result: OperationResult = {
              operationId: operation.operationId,
              success: true,
              replayed: true,
              acknowledgementStatus,
              logicalRef: canonicalChildRef,
              summary:
                "The saved parenting operation was reconciled against the current native parent.",
              data: {
                ...(acknowledgementStatus === "verified_idempotent_replay" ? { reused: true } : {}),
                parenting: diagnostic,
              },
            };
            return persistParentingRecovery(result);
          }
          if (parentingDecision === "ready" && !operation.reconcileOnly) resumeParenting = true;
          else {
            const diagnostic = parentingDiagnostic(
              operation.operationId,
              operation.action,
              sourceLogicalRef,
              targetLogicalRef,
              child.parent,
              parent,
              child.parent,
              "rejected_stale_or_ambiguous",
              "ambiguous",
            );
            return persistParentingRecovery({
              operationId: operation.operationId,
              success: false,
              replayed: true,
              acknowledgementStatus: "ambiguous",
              error:
                "The node is neither at its saved source nor its intended parent; inspect the current canvas before retrying.",
              data: { parenting: diagnostic },
            });
          }
        } catch (error) {
          if (!(error instanceof ReferenceResolutionError)) throw error;
          const failed = referenceFailure(operation.operationId, error);
          const diagnostic = parentingDiagnostic(
            operation.operationId,
            operation.action,
            sourceLogicalRef,
            targetLogicalRef,
            undefined,
            undefined,
            undefined,
            "rejected_stale_or_ambiguous",
            "rejected",
          );
          return persistParentingRecovery({
            ...failed,
            replayed: true,
            acknowledgementStatus: "ambiguous",
            data: {
              ...failed.data,
              parenting: { ...diagnostic, acknowledgementStatus: "ambiguous" },
            },
          });
        }
      }
      if (prior.status === "failed" && prior.result)
        if (
          !resumeParenting &&
          !retryReadOnlyInspection &&
          !(prior.result.acknowledgementStatus === "ambiguous" && isCreation(operation.action))
        )
          return {
            ...(prior.result as unknown as OperationResult),
            replayed: true,
            acknowledgementStatus:
              prior.result.acknowledgementStatus ??
              (prior.result.success ? "confirmed_mutation" : "rejected"),
          };
      if (
        (prior.status === "running" ||
          (prior.status === "failed" && prior.result?.acknowledgementStatus === "ambiguous")) &&
        (operation.action.tool === "create_frame" ||
          operation.action.tool === "create_rectangle" ||
          operation.action.tool === "create_text")
      ) {
        const creationRef = operation.action.ref;
        const candidates = api.currentPage.findAll(
          (node) => node.getPluginData(OP_PLUGIN_KEY) === operation.operationId,
        );
        const recovered = candidates.length === 1 ? candidates[0] : undefined;
        const expectedType =
          operation.action.tool === "create_frame"
            ? "FRAME"
            : operation.action.tool === "create_text"
              ? "TEXT"
              : "RECTANGLE";
        let expectedParentId: string | undefined;
        if (recovered) {
          try {
            expectedParentId = (await resolveParent(state, operation.action.parent, pageId)).id;
          } catch {
            expectedParentId = undefined;
          }
        }
        if (
          recovered &&
          expectedParentId &&
          recovered.type === expectedType &&
          recovered.parent?.id === expectedParentId &&
          (!state.refs[operation.action.ref] ||
            state.refs[operation.action.ref]!.nodeId === recovered.id) &&
          api.currentPage.findAll((node) => node.getPluginData(REF_PLUGIN_KEY) === creationRef)
            .length === 1 &&
          (!operation.taskId || recovered.getPluginData(TASK_PLUGIN_KEY) === operation.taskId) &&
          recovered.getPluginData(REF_PLUGIN_KEY) === operation.action.ref &&
          recovered.getPluginData(FINGERPRINT_PLUGIN_KEY) === fingerprint &&
          recovered.getPluginData(CREATION_READBACK_KEY) === creationReadback(recovered)
        ) {
          state.refs[operation.action.ref] = {
            nodeId: recovered.id,
            pageId,
            parentId: recovered.parent?.id,
            nodeType: recovered.type,
            creationFingerprint: fingerprint,
            ...(operation.taskId
              ? { taskId: operation.taskId, alias, creationOperationId: operation.operationId }
              : {}),
          };
          const result: OperationResult = {
            operationId: operation.operationId,
            success: true,
            replayed: true,
            acknowledgementStatus: "confirmed_mutation",
            logicalRef: operation.action.ref,
            summary: `Recovered completed creation “${recovered.name}”.`,
            data: { node: summarizeNode(recovered, operation.action.ref) },
          };
          state.operations[operation.operationId] = {
            ...prior,
            status: "completed",
            updatedAt: Date.now(),
            result: compactResult(result),
          };
          await saveState(state, pageId, readOnlyInspection);
          return result;
        }
        const result: OperationResult = {
          operationId: operation.operationId,
          success: false,
          replayed: true,
          acknowledgementStatus: "ambiguous",
          error:
            "The operation was interrupted; inspect the canvas before retrying with a new operation ID.",
        };
        state.operations[operation.operationId] = {
          ...prior,
          status: "failed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId, readOnlyInspection);
        return result;
      }
      if (
        prior.status === "running" &&
        !resumeParenting &&
        !refreshNativeVerification &&
        !retryReadOnlyInspection
      ) {
        const result: OperationResult = {
          operationId: operation.operationId,
          success: false,
          replayed: true,
          acknowledgementStatus: "ambiguous",
          error:
            "The operation was interrupted and may have partially applied; inspect the canvas before retrying with a new operation ID.",
        };
        state.operations[operation.operationId] = {
          ...prior,
          status: "failed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId, readOnlyInspection);
        return result;
      }
    }
    if (
      !prior &&
      (operation.action.tool === "create_frame" ||
        operation.action.tool === "create_rectangle" ||
        operation.action.tool === "create_text")
    ) {
      const creationRef = operation.action.ref;
      const candidates = api.currentPage.findAll(
        (node) => node.getPluginData(OP_PLUGIN_KEY) === operation.operationId,
      );
      if (candidates.length > 1)
        return {
          ...referenceFailure(
            operation.operationId,
            new ReferenceResolutionError("ambiguous", operation.action.ref),
          ),
          acknowledgementStatus: "ambiguous",
        };
      const recovered = candidates[0];
      if (recovered) {
        const expectedType =
          operation.action.tool === "create_frame"
            ? "FRAME"
            : operation.action.tool === "create_text"
              ? "TEXT"
              : "RECTANGLE";
        let expectedParentId: string | undefined;
        try {
          expectedParentId = (await resolveParent(state, operation.action.parent, pageId)).id;
        } catch {
          expectedParentId = undefined;
        }
        if (
          !expectedParentId ||
          recovered.type !== expectedType ||
          recovered.parent?.id !== expectedParentId ||
          (state.refs[operation.action.ref] &&
            state.refs[operation.action.ref]!.nodeId !== recovered.id) ||
          api.currentPage.findAll((node) => node.getPluginData(REF_PLUGIN_KEY) === creationRef)
            .length !== 1 ||
          (operation.taskId && recovered.getPluginData(TASK_PLUGIN_KEY) !== operation.taskId) ||
          recovered.getPluginData(REF_PLUGIN_KEY) !== operation.action.ref ||
          recovered.getPluginData(FINGERPRINT_PLUGIN_KEY) !== fingerprint ||
          recovered.getPluginData(CREATION_READBACK_KEY) !== creationReadback(recovered)
        )
          return {
            operationId: operation.operationId,
            success: false,
            replayed: true,
            acknowledgementStatus: "ambiguous",
            error: "This operation ID is already attached to a different native node.",
          };
        state.refs[operation.action.ref] = {
          nodeId: recovered.id,
          pageId,
          parentId: recovered.parent?.id,
          nodeType: recovered.type,
          creationFingerprint: fingerprint,
          ...(operation.taskId
            ? { taskId: operation.taskId, alias, creationOperationId: operation.operationId }
            : {}),
        };
        const result: OperationResult = {
          operationId: operation.operationId,
          success: true,
          replayed: true,
          acknowledgementStatus: "confirmed_mutation",
          logicalRef: operation.action.ref,
          summary: `Recovered prior creation “${recovered.name}”.`,
        };
        state.operations[operation.operationId] = {
          operationId: operation.operationId,
          idempotencyKey: operation.idempotencyKey,
          ...(operation.taskId
            ? { taskId: operation.taskId, creationRef: operation.action.ref }
            : {}),
          fingerprint,
          status: "completed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId, readOnlyInspection);
        return result;
      }
    }
    if (operation.reconcileOnly)
      return {
        operationId: operation.operationId,
        success: false,
        replayed: true,
        acknowledgementStatus: "ambiguous",
        error:
          "No terminal outcome or matching native readback exists. Inspect the original target before continuing.",
      };
    const now = Date.now();
    while (startedOperations.length && startedOperations[0]! < now - 60_000)
      startedOperations.shift();
    if (startedOperations.length >= 40)
      return {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        acknowledgementStatus: "not_attempted",
        error: "Local tool rate limit reached; wait one minute and retry with a new operation ID.",
      };
    startedOperations.push(now);
    const parentingChildRef =
      operation.action.tool === "append_child"
        ? operation.action.childRef
        : operation.action.tool === "reparent_node"
          ? operation.action.ref
          : undefined;
    const parentingSourceParentId =
      isParentingAction(operation.action) && prior?.parentingSourceParentId === undefined
        ? state.refs[parentingChildRef!]?.parentId
        : prior?.parentingSourceParentId;
    const parentingTargetParentId =
      isParentingAction(operation.action) && prior?.parentingTargetParentId === undefined
        ? state.refs[operation.action.parentRef]?.nodeId
        : prior?.parentingTargetParentId;
    state.operations[operation.operationId] = {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      ...(operation.taskId ? { taskId: operation.taskId } : {}),
      ...(operation.taskId && isCreation(operation.action)
        ? { creationRef: operation.action.ref }
        : {}),
      fingerprint,
      status: "running",
      updatedAt: now,
      ...(parentingSourceParentId ? { parentingSourceParentId } : {}),
      ...(parentingTargetParentId ? { parentingTargetParentId } : {}),
    };
    try {
      await saveState(state, pageId, readOnlyInspection);
    } catch (error) {
      return {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        acknowledgementStatus: "not_attempted",
        error: (error instanceof Error
          ? `Operation intent was not confirmed in storage; no native mutation was started. ${error.message}`
          : "Operation intent was not confirmed in storage; no native mutation was started."
        ).slice(0, 400),
        ...(error instanceof ToolStateError
          ? { data: { toolStateDiagnostic: error.diagnostic } }
          : {}),
      };
    }
    let result: OperationResult;
    let nativeMutationStarted = false;
    let successfulOutput: Awaited<ReturnType<typeof actionResult>> | undefined;
    try {
      const output = await actionResult(
        state,
        operation,
        pageId,
        () => {
          nativeMutationStarted = true;
        },
        requestedAction,
        isCancelled,
        isPauseRequested,
        reportProgress,
      );
      successfulOutput = output;
      result = {
        operationId: operation.operationId,
        success: true,
        replayed: false,
        acknowledgementStatus:
          output.acknowledgementStatus ??
          (isMutatingAction(operation.action.tool)
            ? output.replayed && output.data?.reused
              ? "verified_idempotent_replay"
              : "confirmed_mutation"
            : "read_only"),
        ...output,
      };
      if (operation.taskId && isCreation(operation.action)) {
        const entry = state.refs[operation.action.ref];
        if (entry) entry.alias ??= alias;
      }
      if (
        !result.replayed &&
        [
          "create_frame",
          "create_text",
          "create_rectangle",
          "set_auto_layout",
          "set_properties",
          "append_child",
          "reparent_node",
          "delete_node",
        ].includes(operation.action.tool)
      )
        api.commitUndo();
      if (isParentingAction(operation.action)) {
        const childRef =
          operation.action.tool === "append_child"
            ? operation.action.childRef
            : operation.action.ref;
        const childEntry = state.refs[childRef];
        const parentEntry = state.refs[operation.action.parentRef];
        if (childEntry && parentEntry) childEntry.parentId = parentEntry.nodeId;
      }
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed before the operation status was saved.");
      state.operations[operation.operationId] = {
        ...state.operations[operation.operationId]!,
        status: "completed",
        updatedAt: Date.now(),
        result: compactResult(result),
      };
      await saveState(state, pageId, readOnlyInspection);
    } catch (error) {
      result = {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        acknowledgementStatus:
          error instanceof FigmaCompatibilityError
            ? "rejected"
            : error instanceof ParentingOperationError
              ? error.diagnostic.acknowledgementStatus
              : error instanceof ReferenceResolutionError ||
                  !isMutatingAction(operation.action.tool)
                ? "rejected"
                : nativeMutationStarted
                  ? "ambiguous"
                  : "rejected",
        error: (error instanceof Error ? error.message : "Figma operation failed safely.").slice(
          0,
          400,
        ),
        ...(error instanceof ToolStateError
          ? {
              data: {
                ...(successfulOutput?.data?.parenting
                  ? {
                      parenting: FigmaToolParentingDiagnosticSchema.parse({
                        ...successfulOutput.data.parenting,
                        decision: "native_error",
                        acknowledgementStatus: "ambiguous",
                      }),
                    }
                  : {}),
                toolStateDiagnostic: error.diagnostic,
              },
            }
          : error instanceof ParentingOperationError
            ? {
                data: {
                  ...(error.referenceResolution ?? {}),
                  parenting: error.diagnostic,
                },
              }
            : error instanceof ReferenceResolutionError
              ? { data: referenceFailure(operation.operationId, error).data }
              : error instanceof FigmaCompatibilityError
                ? { data: { compatibilityFailure: error.diagnostic } }
                : successfulOutput?.data?.parenting
                  ? {
                      data: {
                        parenting: FigmaToolParentingDiagnosticSchema.parse({
                          ...successfulOutput.data.parenting,
                          decision: "native_error",
                          acknowledgementStatus: "ambiguous",
                        }),
                      },
                    }
                  : {}),
      };
      // A failed outcome write leaves the previous durable intent available for recovery.
      if (error instanceof ToolStateError) return result;
      state.operations[operation.operationId] = {
        ...state.operations[operation.operationId]!,
        status: "failed",
        updatedAt: Date.now(),
        result: compactResult(result),
      };
      await saveState(state, pageId, readOnlyInspection);
    }
    return result;
  };

  const executeBatch = async (
    batch: FigmaToolBatch,
    token: { cancelled: boolean; pauseRequested: boolean },
  ): Promise<void> => {
    const results: OperationResult[] = [];
    const committedOperationIds: string[] = [];
    const partialOperationIds: string[] = [];
    const originalPage = api.currentPage;
    let activePageId = originalPage.id;
    let currentOperation: FigmaToolOperation | undefined;
    const sendResult = (success: boolean, cancelled: boolean) => {
      const message = () => ({
        type: "tool-result" as const,
        protocolVersion: 1 as const,
        batchId: batch.batchId,
        success,
        cancelled,
        committedOperationIds,
        partialOperationIds,
        results: results.slice(0, 10),
      });
      let transferPayloadBytes = 0;
      let resultMessage = message();
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const result of resultMessage.results) {
          if (!result.data) continue;
          const profiling = result.data.profiling;
          result.data.profiling = {
            ...(profiling && typeof profiling === "object"
              ? profiling as Record<string, unknown>
              : {}),
            transferPayloadBytes,
          };
        }
        resultMessage = message();
        const nextBytes = utf8Bytes(JSON.stringify(resultMessage));
        if (nextBytes === transferPayloadBytes) break;
        transferPayloadBytes = nextBytes;
      }
      send(resultMessage);
    };
    try {
      const pageId = originalPage.id;
      const parsed = JSON.stringify(batch);
      const duplicatedIds =
        new Set(batch.operations.map(({ operationId }) => operationId)).size !==
        batch.operations.length;
      const duplicatedKeys =
        new Set(batch.operations.map(({ idempotencyKey }) => idempotencyKey)).size !==
        batch.operations.length;
      if (!parsed || utf8Bytes(parsed) > MAX_PAYLOAD_BYTES || duplicatedIds || duplicatedKeys) {
        send({
          type: "tool-result",
          protocolVersion: 1,
          batchId: batch.batchId,
          success: false,
          cancelled: false,
          committedOperationIds: [],
          partialOperationIds: [],
          results: batch.operations.map((operation, index) => ({
            operationId: operation.operationId,
            success: false,
            replayed: false,
            acknowledgementStatus: index === 0 ? "rejected" : "not_attempted",
            error:
              index === 0
                ? duplicatedIds || duplicatedKeys
                  ? "Operation IDs and idempotency keys must be unique within a batch."
                  : "Tool batch exceeds the 64 KiB safety limit."
                : "Not attempted because the batch failed validation.",
          })),
        });
        return;
      }
      for (const [index, operation] of batch.operations.entries()) {
        if (token.cancelled) break;
        if (operation.documentId) assertTaskPageScope(operation.documentId, pageId);
        send({
          type: "tool-progress",
          protocolVersion: 1,
          batchId: batch.batchId,
          operationId: operation.operationId,
          index,
          total: batch.operations.length,
          status: "running",
          message: `Running ${operation.action.tool.replaceAll("_", " ")}…`,
        });
        if (api.currentPage.id !== activePageId)
          throw new Error(
            "The active Figma page changed before the next operation; nothing else was applied.",
          );
        const requestedPageId = "pageId" in operation.action ? operation.action.pageId : undefined;
        const operationPageId =
          operation.action.tool === "get_document_context" ? pageId : requestedPageId ?? pageId;
        const targetPage = api.root.children.find(({ id }) => id === operationPageId);
        if (!targetPage)
          throw new Error("The requested page is not available in this Figma document.");
        if (
          api.currentPage.id !== operationPageId &&
          operation.action.tool !== "get_operation_status"
        ) {
          try {
            await timed(api.setCurrentPageAsync(targetPage), "Target page load");
          } catch (error) {
            if (api.currentPage.id === operationPageId) activePageId = operationPageId;
            throw error;
          }
          if (api.currentPage.id !== operationPageId)
            throw new Error("Figma did not activate the target page; no operation was started.");
          activePageId = operationPageId;
        }
        const readOnlyInspection =
          operation.action.tool === "get_operation_status" ||
          ((operation.action.tool === "get_document_context" ||
            operation.action.tool === "inspect_nodes") &&
            operation.action.readOnlyInspection === true);
        const state = await loadState(operationPageId, readOnlyInspection);
        currentOperation = operation;
        const nativeStartedAt = Date.now();
        const result = await executeOperation(
          state,
          operation,
          operationPageId,
          () => token.cancelled,
          () => token.pauseRequested,
          (message) =>
            send({
              type: "tool-progress",
              protocolVersion: 1,
              batchId: batch.batchId,
              operationId: operation.operationId,
              index,
              total: batch.operations.length,
              status: "running",
              message: message.slice(0, 300),
            }),
        );
        const nativeExecutionMs = Math.max(0, Date.now() - nativeStartedAt);
        const resultSerializationStartedAt = Date.now();
        const resultPayloadBytes = utf8Bytes(JSON.stringify(result));
        const resultSerializationMs = Math.max(0, Date.now() - resultSerializationStartedAt);
        result.data = {
          ...(result.data ?? {}),
          profiling: {
            nativeExecutionMs,
            resultSerializationMs,
            resultPayloadBytes,
          },
        };
        currentOperation = undefined;
        results.push(result);
        boundResults(results);
        if (
          isMutatingAction(operation.action.tool) &&
          result.acknowledgementStatus === "confirmed_mutation"
        )
          committedOperationIds.push(operation.operationId);
        if (isMutatingAction(operation.action.tool) && result.acknowledgementStatus === "ambiguous")
          partialOperationIds.push(operation.operationId);
        send({
          type: "tool-progress",
          protocolVersion: 1,
          batchId: batch.batchId,
          operationId: operation.operationId,
          index,
          total: batch.operations.length,
          status: token.cancelled ? "cancelled" : result.success ? "completed" : "failed",
          message: token.cancelled
            ? "Cancelled; no further native operations will be scheduled."
            : result.success
              ? (result.summary ?? "Operation completed.")
              : (result.error ?? "Operation failed."),
          ...(result.logicalRef ? { logicalRef: result.logicalRef } : {}),
        });
        if (!result.success) break;
      }
      const cancelled = token.cancelled;
      const nextIndex = results.length;
      if (cancelled && nextIndex < batch.operations.length) {
        const operation = batch.operations[nextIndex]!;
        send({
          type: "tool-progress",
          protocolVersion: 1,
          batchId: batch.batchId,
          operationId: operation.operationId,
          index: nextIndex,
          total: batch.operations.length,
          status: "cancelled",
          message: "Cancelled before this operation; earlier commits remain on the canvas.",
        });
      }
      for (const operation of batch.operations.slice(nextIndex))
        results.push({
          operationId: operation.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "not_attempted",
          error: cancelled
            ? "Not attempted because the batch was cancelled before this operation."
            : "Not attempted because an earlier operation failed; confirmed work was retained.",
        });
      // Preserve the untouched tail if the UI never receives the batch acknowledgement.
      // Existing outcomes always win, including when this was a reconciliation batch.
      if (
        nextIndex < batch.operations.length &&
        api.currentPage.id === activePageId &&
        !results.some(({ error }) => error?.startsWith("Local tool rate limit reached"))
      ) {
        const skipped = batch.operations
          .slice(nextIndex)
          .filter(
            (operation) =>
              operation.taskId &&
              !operation.reconcileOnly &&
              isMutatingAction(operation.action.tool) &&
              (!("pageId" in operation.action) ||
                !operation.action.pageId ||
                operation.action.pageId === pageId),
          );
        if (skipped.length) {
          try {
            const state = await loadState(pageId);
            let changed = false;
            for (const operation of skipped) {
              if (
                state.operations[operation.operationId] ||
                Object.values(state.operations).some(
                  (entry) => entry.idempotencyKey === operation.idempotencyKey,
                )
              )
                continue;
              state.operations[operation.operationId] = {
                operationId: operation.operationId,
                idempotencyKey: operation.idempotencyKey,
                taskId: operation.taskId!,
                fingerprint: actionFingerprint(operation.action),
                status: "failed",
                updatedAt: Date.now(),
                result: compactResult(
                  results.find((item) => item.operationId === operation.operationId)!,
                ),
              };
              changed = true;
            }
            if (changed) await saveState(state, pageId);
          } catch {
            // An unrecorded tail stays uncertain if the acknowledgement is also lost.
          }
        }
      }
      sendResult(
        !cancelled &&
          results.length === batch.operations.length &&
          results.every(({ success }) => success),
        cancelled,
      );
    } catch (error) {
      const operation = currentOperation ?? batch.operations[results.length];
      const acknowledgementStatus = currentOperation
        ? isMutatingAction(currentOperation.action.tool)
          ? "ambiguous"
          : "read_only"
        : "not_attempted";
      if (currentOperation && acknowledgementStatus === "ambiguous")
        partialOperationIds.push(currentOperation.operationId);
      if (operation)
        results.push({
          operationId: operation.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus,
          error: (error instanceof Error ? error.message : "Tool batch failed safely.").slice(
            0,
            400,
          ),
          ...(error instanceof ToolStateError
            ? { data: { toolStateDiagnostic: error.diagnostic } }
            : {}),
        });
      for (const notAttempted of batch.operations.slice(results.length))
        results.push({
          operationId: notAttempted.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "not_attempted",
          error: "Not attempted after the batch stopped before this operation.",
        });
      boundResults(results);
      sendResult(false, token.cancelled);
    } finally {
      if (activePageId !== originalPage.id && api.currentPage.id === activePageId) {
        try {
          await timed(api.setCurrentPageAsync(originalPage), "Restore original page");
        } catch {
          // Do not override a later user page change or turn a committed operation into a retry.
        }
      }
    }
  };

  return async (
    message: Extract<
      UIToPluginMessage,
      {
        type:
          | "tool-execute"
          | "tool-cancel"
          | "tool-pause"
          | "tool-delete-consent"
          | "task-native-inspect"
          | "task-native-focus";
      }
    >,
  ): Promise<void> => {
    if (message.type === "task-native-inspect") {
      try {
        const result = await inspectTaskNativeNodes(message);
        send({
          type: "task-native-inspection-result",
          requestId: message.requestId,
          success: true,
          taskId: message.taskId,
          ...result,
        });
      } catch (error) {
        send({
          type: "task-native-inspection-result",
          requestId: message.requestId,
          success: false,
          taskId: message.taskId,
          error: (error instanceof Error
            ? error.message
            : "Native layers could not be read."
          ).slice(0, 500),
          ...(error instanceof ToolStateError ? { toolStateDiagnostic: error.diagnostic } : {}),
        });
      }
      return;
    }
    if (message.type === "task-native-focus") {
      try {
        const nodeIds = await focusTaskNativeNodes(message);
        send({
          type: "task-native-focus-result",
          requestId: message.requestId,
          success: true,
          nodeIds,
        });
      } catch (error) {
        send({
          type: "task-native-focus-result",
          requestId: message.requestId,
          success: false,
          error: (error instanceof Error
            ? error.message
            : "The task layer could not be focused."
          ).slice(0, 500),
        });
      }
      return;
    }
    if (message.type === "tool-cancel") {
      const active = cancellation.get(message.batchId);
      if (active) active.cancelled = true;
      return;
    }
    if (message.type === "tool-pause") {
      const active = cancellation.get(message.batchId);
      if (active) active.pauseRequested = true;
      return;
    }
    if (message.type === "tool-delete-consent") {
      try {
        const pageId = api.currentPage.id;
        const state = await loadState(pageId);
        await resolveRef(state, message.ref, pageId);
        if (message.confirmation !== `DELETE ${message.ref}`)
          throw new Error(
            `Type “DELETE ${message.ref}” to confirm deleting this node and all descendants.`,
          );
        const token = randomToken();
        deleteConsents.set(token, { token, ref: message.ref, expiresAt: Date.now() + 120_000 });
        send({
          type: "tool-delete-consent-result",
          protocolVersion: 1,
          requestId: message.requestId,
          success: true,
          consentToken: token,
          message: `Deletion of “${message.ref}” and descendants is authorized once for two minutes.`,
        });
      } catch (error) {
        send({
          type: "tool-delete-consent-result",
          protocolVersion: 1,
          requestId: message.requestId,
          success: false,
          message: (error instanceof Error
            ? error.message
            : "Deletion consent could not be issued."
          ).slice(0, 300),
          ...(error instanceof ToolStateError ? { toolStateDiagnostic: error.diagnostic } : {}),
        });
      }
      return;
    }
    if (pendingBatches >= 4) {
      send({
        type: "tool-result",
        protocolVersion: 1,
        batchId: message.batchId,
        success: false,
        cancelled: false,
        committedOperationIds: [],
        partialOperationIds: [],
        results: message.operations.map((operation, index) => ({
          operationId: operation.operationId,
          success: false,
          replayed: false,
          acknowledgementStatus: "not_attempted",
          error:
            index === 0
              ? "The local tool queue is full; try again after the current batch completes."
              : "Not attempted because the local tool queue is full.",
        })),
      });
      return;
    }
    const token = { cancelled: false, pauseRequested: false };
    cancellation.set(message.batchId, token);
    pendingBatches++;
    const next = queue
      .then(() => executeBatch(message, token))
      .finally(() => {
        cancellation.delete(message.batchId);
        pendingBatches--;
      });
    queue = next.catch(() => undefined);
    await next;
  };
}
