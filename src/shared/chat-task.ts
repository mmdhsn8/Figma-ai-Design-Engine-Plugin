import { z } from "zod";
import { ModelIdSchema } from "./model-preference";
import { PinnedBrandKitSchema } from "./brand-kit";
import { PinnedDesignSkillsSchema } from "./design-skill";
import {
  NATIVE_REPAIR_PIPELINE_VERSION,
  NativeRepairPipelineVersionSchema,
  NativeRepairPlanSchema,
  NativeQualityCoverageSchema,
} from "./native-quality-repair.js";
import {
  ChatDesignBriefSchema,
  ChatTurnTimingSchema,
  PlannedPropertyEditSchema,
  ChatFunctionCallSchema,
  ChatLifecycleStateSchema,
  ChatInputItemSchema,
  CHAT_TOOL_NAMES,
} from "./chat-tools.js";
import {
  AutoLayoutRepairReportSchema,
  FigmaToolStateDiagnosticSchema,
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

export const SAFE_REFERENCE_CODES = new Set([
  "ambiguous",
  "ambiguous_alias",
  "checkpoint_registry_conflict",
  "inspection_required",
  "inspection_only_reference",
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
  ...SAFE_REFERENCE_CODES,
  "target_not_found",
  "target_ambiguous",
  "target_not_inspected",
  "reference_not_mutation_eligible",
  "edit_plan_missing",
  "edit_plan_invalid",
  "native_execution_blocked",
  "native_quality_unrepairable",
  "native_verification_invalid",
  "native_verification_capacity_exceeded",
  "native_property_verification_failed",
  "missing_creation_operation",
  "missing_reference_inspection",
  "invalid_required_reference",
  "local_tool_rate_limit",
  "reference_resolution",
  "native_operation_failed",
  "tool_state_too_large",
  "tool_state_record_limit",
  "tool_state_invalid_schema",
  "tool_state_corrupted_state",
  "tool_state_storage_unavailable",
  "checkpoint_load_failed",
  "checkpoint_save_failed",
  "checkpoint_timeout",
  "inspection_failed",
  "inspection_blocked",
  "missing_or_uninspected",
  "verification_failed",
  "inspection_required",
  "executor_contract_rejected",
  "native_api_failed",
  "native_batch_partial_commit",
  "native_operation_timeout",
  "response_invalid",
  "responses_transport_error",
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
      "overlap-analysis-limit",
      "low-contrast",
      "viewport-mismatch",
      "missing-section",
      "insufficient-hierarchy",
      "undersized-target",
      "inconsistent-cards",
      "missing-native-fallback",
      "excessive-whitespace",
      "type-mismatch",
      "parent-mismatch",
      "value-mismatch",
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

export const ChatTaskFailurePhaseSchema = z.enum([
  "state_loading",
  "state_migration",
  "state_persistence",
  "checkpoint",
  "inspection",
  "planning",
  "native_execution",
  "verification",
  "transport",
]);
export type ChatTaskFailurePhase = z.infer<typeof ChatTaskFailurePhaseSchema>;
export const ReadOnlyInspectionOutcomeSchema = z.enum([
  "COMPLETED",
  "PARTIAL",
  "NO_MATCH",
  "BLOCKED",
  "CANCELLED",
  "FAILED",
]);
const ChatEditTargetSchema = z
  .object({
    query: z.string().min(1).max(100),
    ref: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u),
    pageId: z.string().min(1).max(200),
    pageName: z.string().min(1).max(100).optional(),
    nodeId: z.string().min(1).max(200),
    parentId: z.string().min(1).max(200).optional(),
    type: z.string().min(1).max(40),
    name: z.string().min(1).max(100),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    verifiedRefs: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u))
      .min(1)
      .max(25),
    plannedRefs: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u))
      .min(1)
      .max(20)
      .optional(),
    nativeEvidence: z.string().max(16_000),
    discoveryOperationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
    inspectionOperationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  })
  .strict();
const ReadOnlyInspectionSummarySchema = z
  .object({
    pagesScanned: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    pagesAvailable: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    scope: z.enum(["all_accessible_pages", "requested_page", "exact_node"]).default("all_accessible_pages"),
    pagesRemaining: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    framesDiscovered: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    matchingFrames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    framesInspected: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    uninspectedFrames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    inaccessiblePages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    inaccessiblePageSamples: z.array(z.object({
      id: z.string().max(200),
      name: z.string().max(100),
      reason: z.string().max(100).optional(),
    }).strict()).max(24).default([]),
    complete: z.boolean().default(false),
    continuationAvailable: z.boolean().default(false),
    truncationReason: z.string().max(160).optional(),
    truncated: z.boolean(),
    nativeOperations: z.number().int().min(0).max(CHAT_TASK_MAX_READ_ONLY_OPERATIONS),
    repeatedOperations: z.number().int().min(0).max(CHAT_TASK_MAX_READ_ONLY_OPERATIONS),
    nativePerformance: z
      .object({
        pagesLoaded: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        loadedPageCacheEntries: z.number().int().min(0).max(64).default(0),
        trackedPageListeners: z.number().int().min(0).max(64).default(0),
        globalInvalidationFallback: z.boolean().default(false),
        discoveryCacheEntries: z.number().int().min(0).max(12).default(0),
        discoveryCacheBytes: z.number().int().min(0).max(10_000_000).default(0),
        nodesVisited: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        framesReturned: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        slices: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        nodesPerSliceBudget: z.number().int().min(1).max(10_000).default(128),
        pagesPerCheckpoint: z.number().int().min(1).max(10_000).default(32),
        pagesPerYield: z.number().int().min(1).max(10_000).default(4),
        maxNodesPerSliceObserved: z.number().int().min(0).max(10_000).default(0),
        targetSliceMs: z.number().int().min(1).max(10_000).default(35),
        hardSliceMs: z.number().int().min(1).max(60_000).default(100),
        averageSliceMs: z.number().int().min(0).max(86_400_000).default(0),
        maxSliceMs: z.number().int().min(0).max(86_400_000).default(0),
        pageLoadMs: z.number().int().min(0).max(86_400_000).default(0),
        scanElapsedMs: z.number().int().min(0).max(86_400_000).default(0),
        cacheHit: z.boolean().default(false),
        revalidatedAfterRestart: z.boolean().default(false),
        discoveryCacheHits: z.number().int().min(0).max(CHAT_TASK_MAX_READ_ONLY_OPERATIONS),
        discoveryCacheLookups: z.number().int().min(0).max(CHAT_TASK_MAX_READ_ONLY_OPERATIONS).default(0),
        discoveryCacheHitRate: z.number().min(0).max(1).default(0),
        nativeExecutionMs: z.number().int().min(0).max(86_400_000),
        resultSerializationMs: z.number().int().min(0).max(86_400_000),
        resultPayloadBytes: z.number().int().min(0).max(10_000_000),
        transferPayloadBytes: z.number().int().min(0).max(10_000_000),
        resultPayloadBytesPeak: z.number().int().min(0).max(10_000_000).default(0),
        transferPayloadBytesPeak: z.number().int().min(0).max(10_000_000).default(0),
        payloadSamples: z.number().int().min(0).max(CHAT_TASK_MAX_READ_ONLY_OPERATIONS).default(0),
        modelRequests: z.number().int().min(0).max(100),
        modelLatencyMs: z.number().int().min(0).max(86_400_000),
        modelInputBytes: z.number().int().min(0).max(10_000_000),
        uiRenderCommits: z.number().int().min(0).max(10_000),
        uiRenderDurationMs: z.number().int().min(0).max(86_400_000),
      })
      .strict()
      .default({
        pagesLoaded: 0,
        loadedPageCacheEntries: 0,
        trackedPageListeners: 0,
        globalInvalidationFallback: false,
        discoveryCacheEntries: 0,
        discoveryCacheBytes: 0,
        nodesVisited: 0,
        framesReturned: 0,
        slices: 0,
        nodesPerSliceBudget: 128,
        pagesPerCheckpoint: 32,
        pagesPerYield: 4,
        maxNodesPerSliceObserved: 0,
        targetSliceMs: 35,
        hardSliceMs: 100,
        averageSliceMs: 0,
        maxSliceMs: 0,
        pageLoadMs: 0,
        scanElapsedMs: 0,
        cacheHit: false,
        revalidatedAfterRestart: false,
        discoveryCacheHits: 0,
        discoveryCacheLookups: 0,
        discoveryCacheHitRate: 0,
        nativeExecutionMs: 0,
        resultSerializationMs: 0,
        resultPayloadBytes: 0,
        transferPayloadBytes: 0,
        resultPayloadBytesPeak: 0,
        transferPayloadBytesPeak: 0,
        payloadSamples: 0,
        modelRequests: 0,
        modelLatencyMs: 0,
        modelInputBytes: 0,
        uiRenderCommits: 0,
        uiRenderDurationMs: 0,
      }),
    canvasMutations: z.literal(0),
  })
  .strict();

export const ChatTaskSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    chatId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u).optional(),
    intent: z.enum(["create", "edit", "inspect", "explain", "continue"]).optional(),
    targetName: z.string().trim().min(1).max(100).optional(),
    editTarget: ChatEditTargetSchema.optional(),
    planningContinuations: z.number().int().min(0).max(1).optional(),
    designName: z.string().trim().min(1).max(100).optional(),
    referenceScope: z.literal("task-v1").optional(),
    documentId: z.string().min(1).max(300),
    accountScope: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    prompt: z.string().min(1).max(8_000),
    // Optional for legacy checkpoints. New executions persist the exact model
    // chosen at task start so retries cannot silently switch providers/models.
    model: ModelIdSchema.optional(),
    brandKit: PinnedBrandKitSchema.optional(),
    designSkills: PinnedDesignSkillsSchema.optional(),
    lifecycle: ChatLifecycleStateSchema.default("UNPLANNED"),
    inspectionOutcome: ReadOnlyInspectionOutcomeSchema.optional(),
    inspectionSummary: ReadOnlyInspectionSummarySchema.optional(),
    validationFeedback: z.string().max(7_500).optional(),
    editReferenceDiagnostic: z.string().max(500).optional(),
    brief: ChatDesignBriefSchema.optional(),
    context: z.array(ChatInputItemSchema).max(28),
    stages: z
      .array(
        z
          .object({
            title: z.string().min(1).max(160),
            goal: z.string().min(1).max(240).default("Complete the requested section."),
            pageId: z.string().min(1).max(200).optional(),
            logicalRefs: z
              .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u))
              .max(20)
              .default([]),
            completionCriteria: z.array(z.string().min(1).max(180)).max(5).default([]),
            propertyEdit: PlannedPropertyEditSchema.optional(),
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
            nativeRepairPlan: NativeRepairPlanSchema.optional(),
            nativeQualityCoverage: NativeQualityCoverageSchema.optional(),
            nativeRepairPipelineVersion: NativeRepairPipelineVersionSchema.optional(),
            completionReason: z
              .enum([
                "required_refs_and_native_verification_confirmed",
                "missing_required_refs",
                "pending_or_failed_mutations",
                "native_verification_pending",
                "native_verification_failed",
                "native_property_verification_failed",
                "missing_creation_operation",
                "missing_reference_inspection",
                "invalid_required_reference",
                "awaiting_completion_call",
                "verified_no_op",
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
    modelRoundTrace: z.array(z.object({
      round: z.number().int().min(1).max(100),
      lifecycle: ChatLifecycleStateSchema,
      outcome: z.enum(["done", "tool_calls", "tool_validation"]),
      tools: z.array(z.enum(CHAT_TOOL_NAMES)).max(10),
      validationCodes: z.array(z.string().regex(/^[A-Za-z0-9_]{1,80}$/u)).max(8),
      durationMs: z.number().int().min(0).max(600_000).optional(),
      inputBytes: z.number().int().min(0).max(64 * 1024).optional(),
      timing: ChatTurnTimingSchema.optional(),
    }).strict()).max(100).default([]),
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
          "verification",
          "executor_validation",
          "figma_runtime",
          "rate_limit",
          "timeout",
          "cancelled",
          "partial_commit",
          "ambiguous_recovery",
          "tool_state",
          "checkpoint_storage",
          "inspection",
          "transport",
        ]),
        code: z.string().max(80),
        phase: ChatTaskFailurePhaseSchema.optional(),
        cancellationSource: z.enum(["ui_abort", "native_batch_cancelled", "unspecified"]).optional(),
        committedOperations: z.number().int().nonnegative(),
        operationId: z.string().max(100).optional(),
        toolStateDiagnostic: FigmaToolStateDiagnosticSchema.optional(),
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

export function chatTaskRetryLabel(task: ChatTask): string {
  switch (task.failure?.phase) {
    case "state_loading":
    case "state_migration":
    case "state_persistence":
    case "checkpoint":
      return "Retry storage recovery";
    case "inspection":
      return "Retry inspection";
    case "planning":
      return "Retry planning";
    case "verification":
      return "Retry verification";
    case "native_execution":
      return "Retry failed stage";
    case "transport":
      return "Retry request";
    default:
      return task.status === "failed" ? "Retry failed stage" : "Resume saved task";
  }
}

export function chatTaskCommittedOperationCount(task: ChatTask): number {
  return mutationAccounting(task.ledger).confirmedMutations;
}

export function mutationAccounting(entries: ChatTask["ledger"]) {
  const counts = {
    attemptedMutations: 0,
    confirmedMutations: 0,
    rejectedMutations: 0,
    ambiguousMutations: 0,
    verifiedIdempotentReplays: 0,
  };
  for (const entry of entries) {
    if (chatTaskLedgerCategory(entry) !== "mutation" || entry.status === "pending") continue;
    const acknowledgement = entry.acknowledgementStatus;
    if (acknowledgement === "not_attempted" && entry.status !== "running") continue;
    counts.attemptedMutations++;
    if (
      entry.status === "completed" &&
      (acknowledgement === "confirmed_mutation" ||
        acknowledgement === "verified_idempotent_replay" ||
        acknowledgement === undefined)
    ) {
      if (entry.reused || acknowledgement === "verified_idempotent_replay")
        counts.verifiedIdempotentReplays++;
      else counts.confirmedMutations++;
    } else if (
      (entry.status === "failed" || entry.status === "repaired") &&
      acknowledgement === "rejected"
    ) {
      counts.rejectedMutations++;
    } else counts.ambiguousMutations++;
  }
  return counts;
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

export function chatTaskInspectedContinuationRefs(task: ChatTask, stageIndex: number): Set<string> {
  const pageId = task.stages[stageIndex]?.pageId;
  if (task.intent !== "continue" || !pageId || !task.targetName) return new Set();
  const roots = new Set<string>();
  const inspected = new Set<string>();
  for (const entry of task.ledger) {
    if (isCanvasMutationTool(entry.call.action.tool)) break;
    if (entry.status !== "completed" || entry.acknowledgementStatus !== "read_only") continue;
    try {
      const data = JSON.parse(entry.output ?? "{}").data;
      if (entry.call.action.tool === "get_document_context" && data?.discovery?.matchStatus === "unique") {
        for (const frame of data.frames ?? [])
          if (frame.pageId === pageId && frame.type === "FRAME" && typeof frame.ref === "string")
            roots.add(frame.ref);
      }
      if (entry.call.action.tool !== "inspect_nodes" || data?.pageId !== pageId) continue;
      const visit = (node: { ref?: string; children?: unknown[] }) => {
        if (typeof node.ref === "string") inspected.add(node.ref);
        for (const child of node.children ?? []) if (child && typeof child === "object") visit(child);
      };
      for (const node of data.nodes ?? [])
        if (roots.size === 1 && roots.has(node.ref)) visit(node);
    } catch {
      // An unreadable result cannot establish identity.
    }
  }
  return roots.size === 1 ? inspected : new Set();
}

export function chatTaskStageSatisfiedRefs(task: ChatTask, stageIndex: number): Set<string> {
  const stage = task.stages[stageIndex];
  if (!stage) return new Set();
  const nativeMutationRefs = new Set<string>();
  const deletedRefs = new Set<string>();
  for (const entry of task.ledger) {
    const action = entry.call.action;
    if (
      entry.status !== "completed" ||
      entry.reused ||
      entry.acknowledgementStatus !== "confirmed_mutation" ||
      !isCanvasMutationTool(action.tool) ||
      !("ref" in action)
    )
      continue;
    let logicalRef = action.ref;
    try {
      const output = JSON.parse(entry.output ?? "{}");
      if (typeof output.logicalRef === "string") logicalRef = output.logicalRef;
    } catch {
      // The stable action ref remains sufficient for legacy checkpoints.
    }
    if (action.tool === "delete_node") {
      nativeMutationRefs.delete(action.ref);
      nativeMutationRefs.delete(logicalRef);
      deletedRefs.add(action.ref);
      deletedRefs.add(logicalRef);
    } else if (task.intent !== "continue" || ["create_frame", "create_rectangle", "create_text"].includes(action.tool)) {
      nativeMutationRefs.add(action.ref);
      nativeMutationRefs.add(logicalRef);
      deletedRefs.delete(action.ref);
      deletedRefs.delete(logicalRef);
    }
  }
  const existingRefs = chatTaskInspectedContinuationRefs(task, stageIndex);
  for (const ref of deletedRefs) existingRefs.delete(ref);
  const target = task.intent === "edit" ? task.editTarget : undefined;
  if (target) {
    const planned = target.plannedRefs ? new Set(target.plannedRefs) : undefined;
    for (const ref of target.verifiedRefs)
      if ((!planned || planned.has(ref)) && !deletedRefs.has(ref)) existingRefs.add(ref);
  }
  return new Set(
    stage.logicalRefs.filter((ref) => nativeMutationRefs.has(ref) || existingRefs.has(ref)),
  );
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
  const satisfiedStageRefs = stage
    ? chatTaskStageSatisfiedRefs(task, task.stages.indexOf(stage))
    : new Set<string>();
  const remainingRequiredRefs = stage
    ? stage.logicalRefs.filter((ref) => !satisfiedStageRefs.has(ref)).length
    : 0;
  const completionReason = stage
    ? stage.completed
      ? (stage.completionReason ?? "required_refs_and_native_verification_confirmed")
      : (stage.completionReason ??
        (remainingRequiredRefs ||
        stageEntries.some(
          (entry) =>
            chatTaskLedgerCategory(entry) === "mutation" &&
            ["pending", "running", "failed"].includes(entry.status),
        )
          ? "pending_or_failed_mutations"
          : !stage.verified
            ? "native_verification_pending"
            : "awaiting_completion_call"))
    : task.lifecycle === "TASK_COMPLETED"
      ? ["inspect", "explain"].includes(task.intent ?? "")
        ? task.inspectionOutcome === "NO_MATCH"
          ? "read_only_inspection_no_match"
          : task.inspectionOutcome === "PARTIAL"
            ? "read_only_inspection_partial"
            : "read_only_inspection_confirmed"
        : "required_refs_and_native_verification_confirmed"
      : ["inspect", "explain"].includes(task.intent ?? "")
        ? task.inspectionOutcome
          ? "read_only_inspection_" + task.inspectionOutcome.toLocaleLowerCase()
          : "read_only_inspection_pending"
        : task.intent === "edit"
          ? task.failure?.code && SAFE_FAILURE_CODES.has(task.failure.code)
            ? task.failure.code
            : "edit_plan_missing"
          : "plan_not_saved";
  const stageCapacity = task.stages.map((item, index) => {
    const entries = task.ledger.filter((entry) => entry.stage === index);
    const satisfiedRefs = chatTaskStageSatisfiedRefs(task, index);
    const confirmedRefs = confirmedNodeRefs(entries);
    const remainingRequirements = item.logicalRefs.filter((ref) => !satisfiedRefs.has(ref)).length;
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
        : (item.completionReason ??
          (remainingRequirements || pendingOrFailed
            ? "pending_or_failed_mutations"
            : !item.verified
              ? "native_verification_pending"
              : "awaiting_completion_call")),
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
  const failureCategory = task.failure?.category ?? "none";
  const errorCode =
    task.failure?.code && SAFE_FAILURE_CODES.has(task.failure.code)
      ? task.failure.code
      : task.failure || task.status === "failed"
        ? "task_paused"
        : "none";
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
    repairPipelineVersion: NATIVE_REPAIR_PIPELINE_VERSION,
    ...(stage?.nativeRepairPipelineVersion
      ? { lastNativeRepairPipelineVersion: stage.nativeRepairPipelineVersion }
      : {}),
    taskId: task.id,
    ...(task.intent ? { intent: task.intent } : {}),
    ...(task.inspectionOutcome ? { inspectionOutcome: task.inspectionOutcome } : {}),
    ...(task.inspectionSummary ? { inspectionSummary: task.inspectionSummary } : {}),
    lifecycle: task.lifecycle,
    lifecycleTransitions: task.lifecycleTransitions,
    ...(stageIndex >= 0 ? { stageId: `stage-${stageIndex + 1}` } : {}),
    ...(operation ? { callId: operation.call.callId, tool: operation.call.action.tool } : {}),
    ...(operation?.call.action.tool === "get_operation_status"
      ? { lookupTargetOperationId: operation.call.action.operationId }
      : {}),
    ...(task.failure?.operationId ? { operationId: task.failure.operationId } : {}),
    ...(parenting ? { parenting } : {}),
    ...(partialCommitReconciliation ? { partialCommitReconciliation } : {}),
    failureCategory,
    errorCode,
    ...(task.failure?.phase ? { failurePhase: task.failure.phase } : {}),
    ...(task.failure?.cancellationSource
      ? { cancellationSource: task.failure.cancellationSource }
      : {}),
    ...(task.failure?.toolStateDiagnostic
      ? {
          toolStateDiagnostic: FigmaToolStateDiagnosticSchema.parse(
            task.failure.toolStateDiagnostic,
          ),
        }
      : {}),
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
    ...(task.editReferenceDiagnostic ? { editReferenceDiagnostic: task.editReferenceDiagnostic } : {}),
    stageCapacity,
    modelRounds: task.rounds,
    modelRoundTrace: task.modelRoundTrace,
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
            failedMutations: stageEntries.filter(
              (entry) => entry.status === "failed" && chatTaskLedgerCategory(entry) === "mutation",
            ).length,
            failedReadOnlyOperations: stageEntries.filter(
              (entry) => entry.status === "failed" && chatTaskLedgerCategory(entry) === "read_only",
            ).length,
            failedVerificationOperations: stageEntries.filter(
              (entry) =>
                entry.status === "failed" && chatTaskLedgerCategory(entry) === "verification",
            ).length,
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
              failedRules: [
                ...new Map(
                  stage.qualityFindings.map((finding) => [JSON.stringify(finding), finding]),
                ).values(),
              ],
              verificationHistory: stage.verificationHistory.map((verification) => ({
                ...verification,
                findings: [
                  ...new Map(
                    verification.findings.map((finding) => [JSON.stringify(finding), finding]),
                  ).values(),
                ],
              })),
              hierarchyRepairs: task.ledger
                .filter((entry) => entry.stage === stageIndex && entry.output)
                .flatMap((entry) => {
                  try {
                    const reports = AutoLayoutRepairReportSchema.array().safeParse(
                      JSON.parse(entry.output!).data?.overflowRepair,
                    );
                    return reports.success
                      ? [{ operationId: entry.operationId, containers: reports.data }]
                      : [];
                  } catch {
                    return [];
                  }
                }),
              repairOperationsAttempted: stage.repairOperationsAttempted,
              repairOperationsExecuted: stage.repairOperationsExecuted,
              repairFindingsResolved: stage.repairFindingsResolved ?? 0,
              repairVerificationPending: stage.repairVerificationPending ?? false,
              qualityRepairBlocked: stage.qualityRepairBlocked ?? false,
              repairsExecuted: stage.repairOperationsExecuted > 0,
              nativeRepairPlan: stage.nativeRepairPlan,
              nativeQualityCoverage: stage.nativeQualityCoverage,
              nativeRepairDispatches: task.ledger
                .filter(
                  (entry) =>
                    entry.stage === stageIndex &&
                    entry.qualityRepairAttempted &&
                    entry.call.callId.startsWith("native_repair_"),
                )
                .map((entry) => ({
                  operationId: entry.operationId,
                  tool: entry.call.action.tool,
                  ref: "ref" in entry.call.action ? entry.call.action.ref : undefined,
                  ...(entry.call.action.tool === "set_properties"
                    ? { color: entry.call.action.properties.color }
                    : {}),
                  status: entry.status,
                  acknowledgementStatus: entry.acknowledgementStatus,
                  executed:
                    entry.status === "completed" &&
                    entry.acknowledgementStatus === "confirmed_mutation" &&
                    !entry.reused,
                })),
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
