import { z } from "zod";
import {
  ChatDesignBriefSchema,
  ChatFunctionCallSchema,
  ChatInputItemSchema,
} from "./chat-tools.js";

export const CHAT_TASK_MAX_OPERATIONS = 240;
export const CHAT_STAGE_MAX_OPERATIONS = 32;
export const CHAT_TASK_MAX_VALIDATION_CORRECTIONS = 2;
export const CHAT_TASK_MAX_BYTES = 512 * 1024;

const SAFE_REFERENCE_CODES = new Set([
  "ambiguous",
  "ambiguous_alias",
  "checkpoint_registry_conflict",
  "inspection_required",
  "missing_or_other_page",
  "missing_or_uninspected",
  "namespace_conflict",
  "ownership_conflict",
  "reserved_by_other_or_legacy_task",
  "stale",
  "type_or_parent_conflict",
  "unconfirmed_creation",
  "unregistered_existing_node",
]);
const SAFE_FAILURE_CODES = new Set([
  "local_tool_rate_limit",
  "reference_resolution",
  "native_operation_failed",
  "inspection_required",
  "executor_contract_rejected",
  "native_api_failed",
  "native_batch_partial_commit",
  "native_operation_timeout",
  "planning_failed",
  "tool_arguments_invalid",
  "no_progress_repeated_error",
  "planning_budget_exhausted",
  "task_paused",
  "pairing_busy",
  "pairing_rate_limited",
  "pairing_approval_unavailable",
  "pairing_denied",
  "pairing_expired",
  "pairing_cancelled",
  "pairing_replayed",
  "system_browser_unavailable",
  "browser_open_rate_limited",
  "pairing_unavailable",
  "pairing_failed",
  "pairing_required",
  "sign_in_already_pending",
  "sign_in_timed_out",
  "consent_denied",
  "callback_invalid",
  "client_id_mismatch",
  "plan_use_scope_missing",
  "plan_use_not_admitted",
  "account_not_eligible",
  "unsupported_capability",
  "route_not_supported",
  "responses_transport_error",
  "inference_not_verified",
  "inference_busy",
  "chat_request_invalid",
  "generation_busy",
  "generation_retry_limit",
  "invalid_design_request",
  "quota_or_rate_limit",
  "session_expired",
  "request_timed_out",
  "request_cancelled",
  "service_unavailable",
  "connection_failed",
  "model_not_verified_for_account",
  "account_mismatch",
  "public_client_unsupported",
  "response_incomplete",
  "response_invalid",
  "resource_exhausted",
  "response_too_large",
  "empty_response",
  "request_rejected",
  "registration_clear_failed",
  "host_id_invalid",
  "installation_store_invalid",
  "secure_storage_unavailable",
  "secure_storage_timeout",
  "credential_store_corrupt",
  "unknown",
]);
const SafeInspectionValidationIssueSchema = z
  .object({
    callId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    field: z.enum(["maxNodes", "depth"]),
    errorCode: z.enum([
      "too_big",
      "too_small",
      "invalid_type",
      "invalid_format",
      "custom",
      "schema_validation",
    ]),
    receivedType: z.enum(["null", "boolean", "number", "string", "array", "object"]).optional(),
    receivedNumber: z
      .string()
      .regex(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u)
      .max(40)
      .optional(),
  })
  .strict();

export const ChatTaskSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    referenceScope: z.literal("task-v1").optional(),
    documentId: z.string().min(1).max(300),
    prompt: z.string().min(1).max(8_000),
    validationFeedback: z.string().max(7_500).optional(),
    brief: ChatDesignBriefSchema.optional(),
    context: z.array(ChatInputItemSchema).max(28),
    stages: z
      .array(
        z
          .object({
            title: z.string().min(1).max(160),
            goal: z.string().min(1).max(240).default("Complete the requested section."),
            logicalRefs: z
              .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u))
              .max(20)
              .default([]),
            completionCriteria: z.array(z.string().min(1).max(180)).max(5).default([]),
            completed: z.boolean(),
            operations: z.number().int().min(0).max(CHAT_STAGE_MAX_OPERATIONS),
            rounds: z.number().int().min(0).max(8),
            qaAttempts: z.number().int().min(0).max(3).default(0),
            verificationOperations: z
              .number()
              .int()
              .min(0)
              .max(CHAT_STAGE_MAX_OPERATIONS)
              .default(0),
            verified: z.boolean().default(false),
          })
          .strict(),
      )
      .max(12),
    ledger: z
      .array(
        z
          .object({
            call: ChatFunctionCallSchema,
            operationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
            stage: z.number().int().min(0).max(11),
            status: z.enum(["pending", "running", "completed", "failed", "repaired"]),
            reused: z.boolean().optional(),
            output: z.string().max(8_000).optional(),
          })
          .strict(),
      )
      .max(CHAT_TASK_MAX_OPERATIONS),
    pending: z.array(ChatFunctionCallSchema).max(10),
    recent: z.array(ChatInputItemSchema).max(20),
    starts: z.array(z.number().int().nonnegative()).max(40),
    rounds: z.number().int().min(0).max(100),
    batches: z.number().int().min(0).max(1_000).default(0),
    lastResponseCalls: z.number().int().min(0).max(10).default(0),
    validationCorrections: z
      .number()
      .int()
      .min(0)
      .max(CHAT_TASK_MAX_VALIDATION_CORRECTIONS)
      .default(0),
    referenceCorrections: z.number().int().min(0).max(2).default(0),
    lastFailureSignature: z.string().max(2_000).optional(),
    lastFailureProgress: z.number().int().nonnegative().optional(),
    failure: z
      .object({
        category: z.enum([
          "model_schema",
          "planning",
          "executor_validation",
          "figma_runtime",
          "rate_limit",
          "timeout",
          "partial_commit",
          "ambiguous_recovery",
        ]),
        code: z.string().max(80),
        committedOperations: z.number().int().nonnegative(),
        operationId: z.string().max(100).optional(),
        inspectionIssues: z.array(SafeInspectionValidationIssueSchema).max(8).optional(),
      })
      .strict()
      .optional(),
    status: z.enum(["ready", "running", "stopped", "failed", "completed"]),
    text: z.string().max(8_000),
    error: z.string().max(500).optional(),
  })
  .strict();

export type ChatTask = z.infer<typeof ChatTaskSchema>;

export function chatTaskCommittedOperationCount(task: ChatTask): number {
  return task.ledger.filter(
    (entry) =>
      entry.status === "completed" && !entry.reused && isCanvasMutationTool(entry.call.action.tool),
  ).length;
}

export function chatTaskSafeDiagnostic(task: ChatTask): Record<string, unknown> {
  const operation = task.failure?.operationId
    ? task.ledger.find((entry) => entry.operationId === task.failure?.operationId)
    : undefined;
  let referenceResolution: Record<string, unknown> | undefined;
  if (operation?.output) {
    try {
      const data = JSON.parse(operation.output)?.data?.referenceResolution;
      if (data && typeof data.code === "string" && SAFE_REFERENCE_CODES.has(data.code))
        referenceResolution = {
          code: data.code,
          candidateCount:
            Number.isInteger(data.candidateCount) && data.candidateCount >= 0
              ? Math.min(data.candidateCount, 500)
              : Array.isArray(data.candidates)
                ? Math.min(data.candidates.length, 3)
                : 0,
        };
    } catch {
      referenceResolution = undefined;
    }
  }
  const stageIndex = operation?.stage ?? task.stages.findIndex((stage) => !stage.completed);
  const committedOperations =
    task.failure?.committedOperations ?? chatTaskCommittedOperationCount(task);
  const failureCategory = task.failure?.category ?? "planning";
  const errorCode =
    task.failure?.code && SAFE_FAILURE_CODES.has(task.failure.code)
      ? task.failure.code
      : "task_paused";
  const inspectionIssues = task.failure?.inspectionIssues?.flatMap((issue) => {
    const safeIssue = SafeInspectionValidationIssueSchema.safeParse(issue);
    return safeIssue.success ? [safeIssue.data] : [];
  });
  return {
    version: 1,
    taskId: task.id,
    ...(stageIndex >= 0 ? { stageId: `stage-${stageIndex + 1}` } : {}),
    ...(operation ? { callId: operation.call.callId, tool: operation.call.action.tool } : {}),
    ...(task.failure?.operationId ? { operationId: task.failure.operationId } : {}),
    failureCategory,
    errorCode,
    ...(referenceResolution ? { referenceResolution } : {}),
    ...(inspectionIssues?.length ? { inspectionIssues } : {}),
    committedOperations,
    modelRounds: task.rounds,
    nativeBatches: task.batches,
    retrySignature: `${failureCategory}:${errorCode}:stage-${stageIndex + 1}:committed-${committedOperations}`,
    correlationNote:
      "Request ID and batch ID are not stored in the checkpoint; collect sanitized boundary diagnostics separately.",
  };
}

export function isCanvasMutationTool(tool: string): boolean {
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

export function chatTaskProgress(task: ChatTask): string {
  const completed = task.stages.filter((stage) => stage.completed).length;
  const confirmed = chatTaskCommittedOperationCount(task);
  const stage = task.stages.find((item) => !item.completed);
  return `${completed}/${task.stages.length} stages completed · ${task.stages.length - completed} pending · ${confirmed} operations confirmed${stage ? ` · ${stage.title}` : ""}`;
}
