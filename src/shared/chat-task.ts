import { z } from "zod";
import {
  ChatDesignBriefSchema,
  ChatFunctionCallSchema,
  ChatLifecycleStateSchema,
  ChatInputItemSchema,
} from "./chat-tools.js";
import {
  FigmaToolAcknowledgementSchema,
  FigmaToolParentingDiagnosticSchema,
} from "./figma-tools.js";

export const CHAT_TASK_MAX_MUTATIONS = 240;
export const CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS = 32;
export const CHAT_TASK_MAX_READ_ONLY_OPERATIONS = 240;
export const CHAT_TASK_MAX_VERIFICATION_OPERATIONS = 36;
export const CHAT_TASK_MAX_LEDGER_ENTRIES =
  CHAT_TASK_MAX_MUTATIONS +
  CHAT_TASK_MAX_READ_ONLY_OPERATIONS +
  CHAT_TASK_MAX_VERIFICATION_OPERATIONS;
export const CHAT_TASK_MAX_VALIDATION_CORRECTIONS = 2;
export const CHAT_TASK_MAX_BYTES = 512 * 1024;

const ChatRoundBreakdownSchema = z
  .object({
    prePlan: z.number().int().min(0).max(100).default(0),
    planning: z.number().int().min(0).max(100).default(0),
    execution: z.number().int().min(0).max(100).default(0),
    inspection: z.number().int().min(0).max(100).default(0),
    completion: z.number().int().min(0).max(100).default(0),
    correction: z.number().int().min(0).max(100).default(0),
    continuation: z.number().int().min(0).max(100).default(0),
    modelRetries: z.number().int().min(0).max(200).default(0),
  })
  .strict();

const emptyRoundBreakdown = () => ({
  prePlan: 0,
  planning: 0,
  execution: 0,
  inspection: 0,
  completion: 0,
  correction: 0,
  continuation: 0,
  modelRetries: 0,
});

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
const ChatStructuralFindingSchema = z
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
export const ChatRequestDiagnosticSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    requestStartedAtMs: z.number().int().nonnegative().optional(),
    requestPhase: z
      .enum(["upstream_headers", "upstream_stream", "companion_http", "companion_sse"])
      .optional(),
    outcome: z.enum([
      "completed",
      "failed",
      "incomplete",
      "stream_ended_without_terminal",
      "timed_out",
      "cancelled",
      "invalid_event",
      "resource_exhausted",
      "transport_error",
      "http_error",
    ]),
    timeoutKind: z.enum(["headers", "idle", "overall"]).optional(),
    timeoutSource: z
      .enum(["upstream_headers", "upstream_inactivity", "overall_deadline"])
      .optional(),
    terminationReason: z
      .enum([
        "upstream_inactivity",
        "upstream_header_timeout",
        "overall_deadline",
        "local_network_interruption",
        "upstream_transport_interruption",
        "user_cancelled",
        "http_failure",
        "stream_eof",
        "response_completed",
        "upstream_response_failed",
        "upstream_response_incomplete",
        "invalid_event",
        "transport_error",
      ])
      .optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    headersMs: z.number().int().nonnegative().optional(),
    idleMs: z.number().int().nonnegative().optional(),
    lastEvent: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/u)
      .optional(),
    lastEventAtMs: z.number().int().nonnegative().optional(),
    lastEventAgeMs: z.number().int().nonnegative().optional(),
    lastDeltaAgeMs: z.number().int().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,100}$/u)
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
    lifecycle: ChatLifecycleStateSchema.default("UNPLANNED"),
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
            estimatedMutations: z.number().int().min(1).max(CHAT_TASK_MAX_MUTATIONS).default(1),
            completed: z.boolean(),
            operations: z.number().int().min(0).max(CHAT_TASK_MAX_MUTATIONS),
            readOnlyOperations: z
              .number()
              .int()
              .min(0)
              .max(CHAT_TASK_MAX_READ_ONLY_OPERATIONS)
              .default(0),
            segments: z
              .array(
                z
                  .object({
                    index: z.number().int().min(0).max(7),
                    mutationCount: z
                      .number()
                      .int()
                      .min(0)
                      .max(CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS),
                    confirmedMutations: z
                      .number()
                      .int()
                      .min(0)
                      .max(CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS),
                    attemptedMutations: z
                      .number()
                      .int()
                      .min(0)
                      .max(CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS)
                      .default(0),
                    rejectedMutations: z
                      .number()
                      .int()
                      .min(0)
                      .max(CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS)
                      .default(0),
                    ambiguousMutations: z
                      .number()
                      .int()
                      .min(0)
                      .max(CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS)
                      .default(0),
                    verifiedIdempotentReplays: z
                      .number()
                      .int()
                      .min(0)
                      .max(CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS)
                      .default(0),
                    status: z.enum(["pending", "active", "confirmed"]),
                  })
                  .strict(),
              )
              .max(8)
              .default([]),
            rounds: z.number().int().min(0).max(100),
            roundBreakdown: ChatRoundBreakdownSchema.optional(),
            qaAttempts: z.number().int().min(0).max(3).default(0),
            verificationOperations: z
              .number()
              .int()
              .min(0)
              .max(CHAT_TASK_MAX_VERIFICATION_OPERATIONS)
              .default(0),
            verified: z.boolean().default(false),
            verificationHistory: z
              .array(
                z
                  .object({
                    attempt: z.number().int().min(1).max(CHAT_TASK_MAX_VERIFICATION_OPERATIONS),
                    findings: z.array(ChatStructuralFindingSchema).max(24),
                    repairOperationIds: z
                      .array(z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u))
                      .max(10)
                      .optional(),
                  })
                  .strict(),
              )
              .max(CHAT_TASK_MAX_VERIFICATION_OPERATIONS)
              .default([]),
            qualityFindings: z.array(ChatStructuralFindingSchema).max(24).default([]),
            repairOperationsExecuted: z
              .number()
              .int()
              .min(0)
              .max(CHAT_TASK_MAX_MUTATIONS)
              .default(0),
            repairOperationsAttempted: z
              .number()
              .int()
              .min(0)
              .max(CHAT_TASK_MAX_MUTATIONS)
              .default(0),
            repairFindingsResolved: z.number().int().min(0).max(CHAT_TASK_MAX_MUTATIONS).optional(),
            repairVerificationPending: z.boolean().optional(),
            pendingRepairOperationId: z
              .string()
              .regex(/^[A-Za-z0-9_-]{8,100}$/u)
              .optional(),
            qualityRepairBlocked: z.boolean().optional(),
            pendingQualityProbeOperationId: z
              .string()
              .regex(/^[A-Za-z0-9_-]{8,100}$/u)
              .optional(),
            awaitingQualityRepair: z.boolean().default(false),
            completionReason: z
              .enum([
                "required_refs_and_native_verification_confirmed",
                "missing_required_refs",
                "pending_or_failed_mutations",
                "native_verification_pending",
                "native_verification_failed",
                "awaiting_completion_call",
              ])
              .optional(),
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
            category: z.enum(["mutation", "read_only", "verification"]).optional(),
            acknowledgementStatus: FigmaToolAcknowledgementSchema.optional(),
            segment: z.number().int().min(0).max(7).optional(),
            qualityRepairAttempted: z.boolean().optional(),
            reused: z.boolean().optional(),
            output: z.string().max(8_000).optional(),
          })
          .strict(),
      )
      .max(CHAT_TASK_MAX_LEDGER_ENTRIES),
    pending: z.array(ChatFunctionCallSchema).max(10),
    recent: z.array(ChatInputItemSchema).max(20),
    starts: z.array(z.number().int().nonnegative()).max(40),
    rounds: z.number().int().min(0).max(100),
    roundBreakdown: ChatRoundBreakdownSchema.default(emptyRoundBreakdown),
    batches: z.number().int().min(0).max(1_000).default(0),
    lifecycleTransitions: z.number().int().min(0).max(100).default(0),
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
          "cancelled",
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
    lastRequestDiagnostic: ChatRequestDiagnosticSchema.optional(),
    status: z.enum(["ready", "running", "stopped", "failed", "completed"]),
    text: z.string().max(8_000),
    error: z.string().max(500).optional(),
  })
  .strict();

export type ChatTask = z.infer<typeof ChatTaskSchema>;

export type ChatRoundKind = Exclude<keyof ChatTask["roundBreakdown"], "modelRetries">;

export function chatTaskCommittedOperationCount(task: ChatTask): number {
  return mutationAccounting(task.ledger).confirmedMutations;
}

export function mutationAccounting(entries: ChatTask["ledger"]) {
  const mutations = entries.filter((entry) => chatTaskLedgerCategory(entry) === "mutation");
  return {
    attemptedMutations: mutations.filter(
      (entry) =>
        ["running", "completed", "failed", "repaired"].includes(entry.status) &&
        entry.acknowledgementStatus !== "not_attempted",
    ).length,
    confirmedMutations: mutations.filter(
      (entry) =>
        entry.status === "completed" &&
        !entry.reused &&
        entry.acknowledgementStatus !== "verified_idempotent_replay" &&
        entry.acknowledgementStatus !== "ambiguous" &&
        entry.acknowledgementStatus !== "rejected" &&
        entry.acknowledgementStatus !== "not_attempted" &&
        entry.acknowledgementStatus !== "read_only",
    ).length,
    rejectedMutations: mutations.filter(
      (entry) =>
        (entry.status === "failed" || entry.status === "repaired") &&
        entry.acknowledgementStatus === "rejected",
    ).length,
    ambiguousMutations: mutations.filter(
      (entry) => entry.status === "running" || entry.acknowledgementStatus === "ambiguous",
    ).length,
    verifiedIdempotentReplays: mutations.filter(
      (entry) =>
        (entry.status === "completed" || entry.status === "repaired") &&
        (entry.reused || entry.acknowledgementStatus === "verified_idempotent_replay"),
    ).length,
  };
}

export function chatTaskLedgerCategory(
  entry: ChatTask["ledger"][number],
): "mutation" | "read_only" | "verification" {
  if (entry.category) return entry.category;
  if (isCanvasMutationTool(entry.call.action.tool)) return "mutation";
  return /-qa-\d+-\d+$/u.test(entry.operationId) ? "verification" : "read_only";
}

function confirmedNodeRefs(entries: ChatTask["ledger"]): Set<string> {
  const refs = new Set<string>();
  for (const entry of entries) {
    if (
      entry.status !== "completed" ||
      entry.reused ||
      !isCanvasMutationTool(entry.call.action.tool) ||
      !("ref" in entry.call.action)
    )
      continue;
    if (entry.call.action.tool === "delete_node") refs.delete(entry.call.action.ref);
    else refs.add(entry.call.action.ref);
  }
  return refs;
}

export function chatTaskCapacityUsage(task: ChatTask) {
  const categories = task.ledger.map(chatTaskLedgerCategory);
  const confirmedRefs = confirmedNodeRefs(task.ledger);
  return {
    mutationCapacity: CHAT_TASK_MAX_MUTATIONS,
    mutations: categories.filter((category) => category === "mutation").length,
    confirmedMutations: chatTaskCommittedOperationCount(task),
    readOnlyOperations: categories.filter((category) => category === "read_only").length,
    verificationOperations: categories.filter((category) => category === "verification").length,
    ledgerEntries: task.ledger.length,
    ledgerCapacity: CHAT_TASK_MAX_LEDGER_ENTRIES,
    confirmedNodes: confirmedRefs.size,
  };
}

export function chatTaskSafeDiagnostic(task: ChatTask): Record<string, unknown> {
  const operation = task.failure?.operationId
    ? task.ledger.find((entry) => entry.operationId === task.failure?.operationId)
    : undefined;
  const parentingEntry =
    operation &&
    (operation.call.action.tool === "append_child" ||
      operation.call.action.tool === "reparent_node")
      ? operation
      : [...task.ledger]
          .reverse()
          .find(
            (entry) =>
              (entry.call.action.tool === "append_child" ||
                entry.call.action.tool === "reparent_node") &&
              Boolean(entry.output),
          );
  let referenceResolution: Record<string, unknown> | undefined;
  let parenting: z.infer<typeof FigmaToolParentingDiagnosticSchema> | undefined;
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
  if (parentingEntry?.output) {
    try {
      const parentingResult = FigmaToolParentingDiagnosticSchema.safeParse(
        JSON.parse(parentingEntry.output)?.data?.parenting,
      );
      if (parentingResult.success) parenting = parentingResult.data;
    } catch {
      parenting = undefined;
    }
  }
  const stageIndex = operation?.stage ?? task.stages.findIndex((stage) => !stage.completed);
  const stage = stageIndex >= 0 ? task.stages[stageIndex] : undefined;
  const stageEntries = stage ? task.ledger.filter((entry) => entry.stage === stageIndex) : [];
  const capacity = chatTaskCapacityUsage(task);
  const mutationCounts = mutationAccounting(task.ledger);
  const segmentEntries = new Map<string, ChatTask["ledger"]>();
  for (const entry of task.ledger) {
    if (chatTaskLedgerCategory(entry) !== "mutation") continue;
    const key = `${entry.stage}:${entry.segment ?? 0}`;
    const entries = segmentEntries.get(key) ?? [];
    entries.push(entry);
    segmentEntries.set(key, entries);
  }
  const confirmedSegmentTotal = [...segmentEntries.values()].reduce(
    (sum, entries) => sum + mutationAccounting(entries).confirmedMutations,
    0,
  );
  const confirmedStageRefs = confirmedNodeRefs(stageEntries);
  const remainingRequiredRefs = stage
    ? stage.logicalRefs.filter((ref) => !confirmedStageRefs.has(ref)).length
    : 0;
  const completionReason = stage
    ? stage.completed
      ? (stage.completionReason ?? "required_refs_and_native_verification_confirmed")
      : remainingRequiredRefs
        ? "missing_required_refs"
        : stageEntries.some(
              (entry) =>
                chatTaskLedgerCategory(entry) === "mutation" &&
                ["pending", "running", "failed"].includes(entry.status),
            )
          ? "pending_or_failed_mutations"
          : !stage.verified
            ? (stage.completionReason ?? "native_verification_pending")
            : "awaiting_completion_call"
    : task.lifecycle === "TASK_COMPLETED"
      ? "required_refs_and_native_verification_confirmed"
      : "missing_required_refs";
  const stageCapacity = task.stages.map((item, index) => {
    const entries = task.ledger.filter((entry) => entry.stage === index);
    const confirmedRefs = confirmedNodeRefs(entries);
    const remainingRequirements = item.logicalRefs.filter((ref) => !confirmedRefs.has(ref)).length;
    const pendingOrFailed = entries.some(
      (entry) =>
        chatTaskLedgerCategory(entry) === "mutation" &&
        ["pending", "running", "failed"].includes(entry.status),
    );
    return {
      stageId: `stage-${index + 1}`,
      mutationUsage: entries.filter((entry) => chatTaskLedgerCategory(entry) === "mutation").length,
      confirmedMutations: mutationAccounting(entries).confirmedMutations,
      readOnlyOperations: entries.filter((entry) => chatTaskLedgerCategory(entry) === "read_only")
        .length,
      verificationOperations: entries.filter(
        (entry) => chatTaskLedgerCategory(entry) === "verification",
      ).length,
      confirmedNodes: confirmedRefs.size,
      remainingRequirements,
      completionReason: item.completed
        ? (item.completionReason ?? "required_refs_and_native_verification_confirmed")
        : remainingRequirements
          ? "missing_required_refs"
          : pendingOrFailed
            ? "pending_or_failed_mutations"
            : !item.verified
              ? (item.completionReason ?? "native_verification_pending")
              : "awaiting_completion_call",
      segments: item.segments.map(
        ({
          index: segment,
          mutationCount,
          confirmedMutations,
          attemptedMutations,
          rejectedMutations,
          ambiguousMutations,
          verifiedIdempotentReplays,
          status,
        }) => ({
          index: segment,
          mutationCount,
          confirmedMutations,
          attemptedMutations,
          rejectedMutations,
          ambiguousMutations,
          verifiedIdempotentReplays,
          status,
        }),
      ),
    };
  });
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
  const partialCommitReconciliation = parentingEntry
    ? {
        operationId: parentingEntry.operationId,
        acknowledgementStatus: parentingEntry.acknowledgementStatus ?? "unknown",
        result:
          parenting?.decision === "reconciled_commit"
            ? "committed_after_interruption"
            : parenting?.decision === "reconciled_noop"
              ? "verified_idempotent_noop"
              : parentingEntry.acknowledgementStatus === "ambiguous"
                ? "inspection_required"
                : parentingEntry.acknowledgementStatus === "confirmed_mutation"
                  ? "acknowledged_commit"
                  : parentingEntry.acknowledgementStatus === "rejected"
                    ? "rejected_without_move"
                    : "not_reconciled",
      }
    : undefined;
  return {
    version: 1,
    taskId: task.id,
    lifecycle: task.lifecycle,
    lifecycleTransitions: task.lifecycleTransitions,
    ...(stageIndex >= 0 ? { stageId: `stage-${stageIndex + 1}` } : {}),
    ...(operation ? { callId: operation.call.callId, tool: operation.call.action.tool } : {}),
    ...(task.failure?.operationId ? { operationId: task.failure.operationId } : {}),
    ...(parenting ? { parenting } : {}),
    ...(partialCommitReconciliation ? { partialCommitReconciliation } : {}),
    failureCategory,
    errorCode,
    ...(referenceResolution ? { referenceResolution } : {}),
    ...(inspectionIssues?.length ? { inspectionIssues } : {}),
    ...(task.lastRequestDiagnostic
      ? { lastRequestDiagnostic: ChatRequestDiagnosticSchema.parse(task.lastRequestDiagnostic) }
      : {}),
    committedOperations,
    capacity,
    mutationAccounting: mutationCounts,
    taskSegmentCountConsistency: {
      taskConfirmedMutations: chatTaskCommittedOperationCount(task),
      segmentConfirmedMutations: confirmedSegmentTotal,
      consistent: chatTaskCommittedOperationCount(task) === confirmedSegmentTotal,
    },
    completionReason,
    stageCapacity,
    modelRounds: task.rounds,
    modelRequests: task.rounds + task.roundBreakdown.modelRetries,
    roundBreakdown: task.roundBreakdown,
    nativeBatches: task.batches,
    ...(stage
      ? {
          activeStageProgress: {
            modelRounds: stage.rounds,
            roundBreakdown: stage.roundBreakdown ?? emptyRoundBreakdown(),
            requiredRefs: stage.logicalRefs.length,
            remainingRequiredRefs,
            estimatedMutations: stage.estimatedMutations,
            remainingEstimatedMutations: Math.max(
              0,
              stage.estimatedMutations - mutationAccounting(stageEntries).confirmedMutations,
            ),
            confirmedMutations: mutationAccounting(stageEntries).confirmedMutations,
            pendingOperations: stageEntries.filter(
              (entry) => entry.status === "pending" || entry.status === "running",
            ).length,
            pendingMutations: stageEntries.filter(
              (entry) =>
                chatTaskLedgerCategory(entry) === "mutation" &&
                (entry.status === "pending" || entry.status === "running"),
            ).length,
            failedOperations: stageEntries.filter((entry) => entry.status === "failed").length,
            mutationCapacityPerSegment: CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS,
            segments: stage.segments.map(
              ({
                index,
                mutationCount,
                confirmedMutations,
                attemptedMutations,
                rejectedMutations,
                ambiguousMutations,
                verifiedIdempotentReplays,
                status,
              }) => ({
                index,
                mutationCount,
                confirmedMutations,
                attemptedMutations,
                rejectedMutations,
                ambiguousMutations,
                verifiedIdempotentReplays,
                status,
              }),
            ),
            completionReason,
            structuralQuality: {
              verificationAttempts: stage.verificationOperations,
              failedRules: stage.qualityFindings,
              verificationHistory: stage.verificationHistory,
              repairOperationsAttempted: stage.repairOperationsAttempted,
              repairOperationsExecuted: stage.repairOperationsExecuted,
              repairFindingsResolved: stage.repairFindingsResolved ?? 0,
              repairVerificationPending: stage.repairVerificationPending ?? false,
              qualityRepairBlocked: stage.qualityRepairBlocked ?? false,
              repairsExecuted: stage.repairOperationsExecuted > 0,
            },
          },
        }
      : {}),
    retrySignature: `${failureCategory}:${errorCode}:stage-${stageIndex + 1}:committed-${committedOperations}`,
    correlationNote:
      "The last request ID and sanitized timeout/network boundary diagnostics are checkpointed; no prompts, credentials or raw responses are included.",
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
  const usage = chatTaskCapacityUsage(task);
  return `${completed}/${task.stages.length} stages completed · ${task.stages.length - completed} pending · ${confirmed} mutations confirmed · ${usage.readOnlyOperations} read-only${stage ? ` · ${stage.title}` : ""}`;
}
