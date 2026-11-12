import {
  ChatFunctionCallSchema,
  parseResponsesFunctionCalls,
  modelPlanStages,
  CHAT_PLAN_VERSION,
  chatFunctionToolsForState,
  type ChatLifecycleState,
  type ChatInputItem,
} from "../shared/chat-tools";
import {
  FigmaToolBatchSchema,
  INSPECT_NODES_LIMITS,
  FigmaToolOperationSchema,
  FigmaToolStateDiagnosticSchema,
  type FigmaToolStateDiagnostic,
  type FigmaToolAction,
  type FigmaToolOperation,
} from "../shared/figma-tools";
import { type PluginToUIMessage } from "../shared/messages";
import { utf8Bytes } from "../shared/generation-limits";
import {
  auditNativeSection,
  NativeVisualNodeSchema,
  type NativeVisualFinding,
} from "../shared/native-visual-quality";
import {
  CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS,
  CHAT_TASK_MAX_BYTES,
  CHAT_TASK_MAX_LEDGER_ENTRIES,
  CHAT_TASK_MAX_MUTATIONS,
  CHAT_TASK_MAX_READ_ONLY_OPERATIONS,
  CHAT_TASK_MAX_VERIFICATION_OPERATIONS,
  CHAT_TASK_MAX_VALIDATION_CORRECTIONS,
  ChatRequestDiagnosticSchema,
  SAFE_REFERENCE_CODES,
  type ChatTaskFailurePhase,
  ChatTaskSchema,
  chatTaskCapacityUsage,
  chatTaskCommittedOperationCount,
  chatTaskLedgerCategory,
  chatTaskStageSatisfiedRefs,
  chatTaskInspectedContinuationRefs,
  mutationAccounting,
  isCanvasMutationTool,
  type ChatRoundKind,
  type ChatTask,
} from "../shared/chat-task";
import type { AuthorizedChatTurn } from "./companion-client";
import {
  NativeVerificationResultSchema,
  planNativeQualityRepairs,
  type NativeRepairDecision,
} from "../shared/native-quality-repair";

type Result = Extract<PluginToUIMessage, { type: "tool-result" }>;
type Dependencies = {
  model(input: ChatInputItem[], lifecycle: ChatLifecycleState): Promise<AuthorizedChatTurn>;
  execute(operations: FigmaToolOperation[]): Promise<Result>;
  save(task: ChatTask): Promise<void>;
  progress(message: string): void;
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function safeRequestDiagnostic(error: unknown) {
  if (!error || typeof error !== "object" || !("diagnostic" in error)) return undefined;
  const value = error.diagnostic;
  if (!value || typeof value !== "object") return undefined;
  const diagnostic = value as Record<string, unknown>;
  const requestId = diagnostic.requestId;
  const outcome = diagnostic.outcome;
  if (typeof requestId !== "string" || typeof outcome !== "string") return undefined;
  const safe: Record<string, unknown> = { requestId, outcome };
  for (const key of [
    "requestStartedAtMs",
    "requestPhase",
    "timeoutKind",
    "timeoutSource",
    "terminationReason",
    "elapsedMs",
    "headersMs",
    "idleMs",
    "lastEvent",
    "lastEventAtMs",
    "lastEventAgeMs",
    "lastDeltaAgeMs",
    "httpStatus",
    "errorCode",
  ])
    if (diagnostic[key] !== undefined) safe[key] = diagnostic[key];
  const parsed = ChatRequestDiagnosticSchema.safeParse(safe);
  return parsed.success ? parsed.data : undefined;
}

function toolStateFailureCode(category: FigmaToolStateDiagnostic["category"]) {
  return {
    state_too_large: "tool_state_too_large",
    record_limit: "tool_state_record_limit",
    invalid_schema: "tool_state_invalid_schema",
    corrupted_state: "tool_state_corrupted_state",
    storage_unavailable: "tool_state_storage_unavailable",
  }[category];
}

export function waitForChatCapacity(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new Error("Stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

const roundBreakdown = () => ({
  prePlan: 0,
  planning: 0,
  execution: 0,
  inspection: 0,
  completion: 0,
  correction: 0,
  continuation: 0,
  modelRetries: 0,
});

function roundKind(turn: AuthorizedChatTurn): ChatRoundKind {
  if (turn.kind === "tool_validation") return "correction";
  if (turn.kind === "done") return "continuation";
  if (turn.calls.some((call) => call.action.tool === "plan_canvas_task")) return "planning";
  if (turn.calls.some((call) => call.action.tool === "complete_canvas_stage")) return "completion";
  if (
    turn.calls.every(
      (call) => call.action.tool === "get_document_context" || call.action.tool === "inspect_nodes",
    )
  )
    return "inspection";
  return "execution";
}

function estimatedStageMutations(logicalRefs: string[]): number {
  return Math.min(CHAT_TASK_MAX_MUTATIONS, Math.max(1, logicalRefs.length * 3));
}

function syncCapacityAccounting(task: ChatTask): void {
  for (const entry of task.ledger) entry.category ??= chatTaskLedgerCategory(entry);
  for (let stageIndex = 0; stageIndex < task.stages.length; stageIndex++) {
    const stage = task.stages[stageIndex]!;
    const entries = task.ledger.filter((entry) => entry.stage === stageIndex);
    const mutations = entries.filter((entry) => entry.category === "mutation");
    mutations.forEach((entry, index) => {
      entry.segment ??= Math.floor(index / CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS);
    });
    stage.operations = mutations.length;
    stage.readOnlyOperations = entries.filter((entry) => entry.category === "read_only").length;
    stage.verificationOperations = entries.filter(
      (entry) => entry.category === "verification",
    ).length;
    if (
      task.intent !== "edit" &&
      stage.estimatedMutations === 1 &&
      stage.logicalRefs.length > 1
    )
      stage.estimatedMutations = estimatedStageMutations(stage.logicalRefs);
    const segmentCount = Math.max(
      1,
      Math.ceil(
        Math.max(stage.completed ? mutations.length : stage.estimatedMutations, mutations.length) /
          CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS,
      ),
    );
    let priorConfirmed = true;
    stage.segments = Array.from({ length: segmentCount }, (_, index) => {
      const segmentMutations = mutations.filter((entry) => entry.segment === index);
      const accounting = mutationAccounting(segmentMutations);
      const settledMutations = segmentMutations.filter(
        (entry) =>
          entry.status === "repaired" ||
          (entry.status === "completed" &&
            entry.acknowledgementStatus !== "ambiguous" &&
            entry.acknowledgementStatus !== "rejected" &&
            entry.acknowledgementStatus !== "not_attempted"),
      ).length;
      const confirmed =
        segmentMutations.length > 0 &&
        settledMutations === segmentMutations.length &&
        (segmentMutations.length === CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS ||
          stage.completed ||
          mutations.some((entry) => entry.segment === index + 1));
      const status = confirmed ? "confirmed" : priorConfirmed ? "active" : "pending";
      priorConfirmed &&= confirmed;
      return {
        index,
        mutationCount: segmentMutations.length,
        ...accounting,
        status,
      };
    });
  }
}

type ReadOnlyDiscovery = {
  query?: string;
  offset: number;
  pageId?: string;
  discovery: Record<string, unknown>;
  pages: Array<Record<string, unknown>>;
  frames: Array<Record<string, unknown>>;
  ledgerIndex: number;
};

function normalizeInspectionQuery(query?: string): string {
  return query?.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() ?? "";
}

function stableFingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function inspectionActionKey(action: FigmaToolAction): string | undefined {
  if (action.tool === "get_document_context")
    return JSON.stringify([
      "get_document_context",
      normalizeInspectionQuery(action.query),
      action.offset ?? 0,
      action.readOnlyInspection === true,
    ]);
  if (action.tool === "inspect_nodes")
    return JSON.stringify([
      "inspect_nodes",
      action.pageId ?? "",
      [...action.refs].sort(),
      action.selection,
      action.depth,
      action.maxNodes,
      action.readOnlyInspection === true,
    ]);
  return undefined;
}

function inspectionResultFingerprint(entry: ChatTask["ledger"][number]): string | undefined {
  try {
    const payload = JSON.parse(entry.output ?? "{}");
    if (entry.call.action.tool === "get_document_context")
      return stableFingerprint({
        success: payload.success,
        data: payload.data
          ? {
              pages: payload.data.pages,
              frames: payload.data.frames,
              discovery: payload.data.discovery,
            }
          : undefined,
        error: payload.success ? undefined : payload.error,
      });
    if (entry.call.action.tool === "inspect_nodes")
      return stableFingerprint({
        success: payload.success,
        pageId: payload.data?.pageId,
        nodes: payload.data?.nodes,
        error: payload.success ? undefined : payload.error,
      });
  } catch {
    return undefined;
  }
  return undefined;
}

// Keep the latest bounded discovery run and verified identities in the durable task ledger.
function readOnlyCheckpoint(task: ChatTask) {
  const inspected = new Map<string, Record<string, unknown>>();
  const attemptedRefs = new Set<string>();
  const failedRefs = new Set<string>();
  const runs = new Map<string, ReadOnlyDiscovery[]>();
  const actionResults = new Map<string, string>();
  let repeatedOperations = 0;
  let contextFailures = 0;
  let inspectFailures = 0;
  for (const [ledgerIndex, entry] of task.ledger.entries()) {
    const action = entry.call.action;
    if (action.tool !== "get_document_context" && action.tool !== "inspect_nodes") continue;
    const actionKey = inspectionActionKey(action);
    const resultFingerprint = inspectionResultFingerprint(entry);
    if (actionKey && resultFingerprint) {
      const prior = actionResults.get(actionKey);
      if (prior === resultFingerprint) repeatedOperations++;
      actionResults.set(actionKey, resultFingerprint);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(entry.output ?? "{}");
    } catch {
      // A malformed native result cannot count as evidence or semantic progress.
    }
    if (action.tool === "inspect_nodes")
      for (const ref of action.refs)
        attemptedRefs.add(JSON.stringify([action.pageId ?? "", ref]));
    if (entry.status !== "completed" || payload.success !== true || !payload.data) {
      if (action.tool === "get_document_context") contextFailures++;
      else {
        inspectFailures++;
        for (const ref of action.refs)
          failedRefs.add(JSON.stringify([action.pageId ?? "", ref]));
      }
      continue;
    }
    const data = payload.data as Record<string, unknown>;
    if (action.tool === "get_document_context") {
      if (!Array.isArray(data.frames) || !data.discovery || typeof data.discovery !== "object") continue;
      const page = data.page as { id?: string } | undefined;
      const query = action.query?.trim();
      const offset = action.offset ?? 0;
      const queryKey = normalizeInspectionQuery(query);
      const run = runs.get(queryKey) ?? [];
      const discovery = data.discovery as Record<string, unknown>;
      const item: ReadOnlyDiscovery = {
        ...(query ? { query } : {}),
        offset,
        ...(typeof page?.id === "string" ? { pageId: page.id } : {}),
        discovery,
        pages: Array.isArray(data.pages)
          ? data.pages.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
          : [],
        frames: data.frames.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))),
        ledgerIndex,
      };
      if (offset === 0) {
        runs.set(queryKey, [item]);
      } else {
        const previous = run.at(-1);
        if (previous && previous.discovery.nextOffset === offset) {
          run.push(item);
          runs.set(queryKey, run);
        }
      }
    } else {
      const pageId =
        action.pageId ?? (typeof data.pageId === "string" ? data.pageId : undefined);
      if (!pageId || !Array.isArray(data.nodes)) continue;
      for (const node of data.nodes) {
        if (
          !node ||
          typeof node.ref !== "string" ||
          typeof node.name !== "string" ||
          ![node.x, node.y, node.width, node.height].every(Number.isFinite) ||
          node.width <= 0 ||
          node.height <= 0
        )
          continue;
        inspected.set(JSON.stringify([pageId, node.ref]), node);
      }
    }
  }
  const discoveries = [...runs.values()].flat();
  const frames = new Map<string, Record<string, unknown>>();
  for (const discovery of discoveries) {
    for (const frame of discovery.frames) {
      if (typeof frame.pageId !== "string" || typeof frame.name !== "string") continue;
      const identity =
        typeof frame.ref === "string"
          ? frame.ref
          : JSON.stringify([frame.name, frame.type, frame.x, frame.y, frame.width, frame.height]);
      frames.set(JSON.stringify([frame.pageId, identity]), frame);
    }
  }
  const results: Array<Record<string, unknown> & { verified: boolean; inspectionAttempted: boolean }> = [
    ...frames.entries(),
  ].map(([, frame]) => {
    const pageId = String(frame.pageId);
    const inspectionKey = JSON.stringify([pageId, frame.ref]);
    const node = typeof frame.ref === "string" ? inspected.get(inspectionKey) : undefined;
    const sameSnapshot =
      node &&
      (["type", "x", "y", "width", "height"] as const).every(
        (field) => frame[field] === undefined || node[field] === undefined || frame[field] === node[field],
      );
    const nativeInspected = frame.nativeInspected === true;
    return {
      ...Object.fromEntries(
        ["ref", "pageId", "pageName", "name", "type", "x", "y", "width", "height", "parentName", "depth", "editable"]
          .filter((field) => frame[field] !== undefined)
          .map((field) => [field, frame[field]]),
      ),
      ...(sameSnapshot
        ? Object.fromEntries(
            ["name", "type", "x", "y", "width", "height", "layoutMode"]
              .filter((field) => node?.[field] !== undefined)
              .map((field) => [field, node?.[field]]),
          )
        : {}),
      ...(nativeInspected ? { nativeInspected: true } : {}),
      verified: Boolean(sameSnapshot || nativeInspected),
      inspectionAttempted:
        typeof frame.ref === "string" && attemptedRefs.has(JSON.stringify([pageId, frame.ref])),
    };
  });
  const latestByQuery = new Map<string, ReadOnlyDiscovery[]>();
  for (const [queryKey, run] of runs) latestByQuery.set(queryKey, run);
  const pendingOffsets = [...latestByQuery.values()].flatMap((run) => {
    const latest = run.at(-1);
    if (!latest || typeof latest.discovery.nextOffset !== "number") return [];
    const nextOffset = latest.discovery.nextOffset;
    return run.some((item) => item.offset === nextOffset)
      ? []
      : [{ query: latest.query, offset: nextOffset }];
  });
  return {
    discoveries,
    frames: results,
    pages: [...new Map(
      discoveries.flatMap(({ pages: pageSummaries }) =>
        pageSummaries.flatMap((page) => typeof page.id === "string" ? [[page.id, page] as const] : []),
      ),
    ).values()],
    pendingOffsets,
    uninspectedRefs: results
      .filter((frame) => typeof frame.ref === "string" && !frame.verified)
      .map((frame) => ({
        ref: frame.ref,
        pageId: frame.pageId,
        attempted: frame.inspectionAttempted,
        failed: failedRefs.has(JSON.stringify([frame.pageId, frame.ref])),
      })),
    contextFailures,
    inspectFailures,
    repeatedOperations,
    attemptedRefs,
    failedRefs,
  };
}

const MAX_AUTONOMOUS_INSPECTION_OPERATIONS = 48;
const AUTONOMOUS_INSPECTION_REFS_PER_CALL = INSPECT_NODES_LIMITS.refs;

type ReadOnlyCheckpoint = ReturnType<typeof readOnlyCheckpoint>;
type ReadOnlyTerminalOutcome = "COMPLETED" | "PARTIAL" | "NO_MATCH" | "BLOCKED" | "FAILED";
type ReadOnlyPlan =
  | { action: FigmaToolAction; progress: string }
  | { paused: true; reason: string }
  | { outcome: ReadOnlyTerminalOutcome; reason?: string };

function framesForDiscoveryRun(
  checkpoint: ReadOnlyCheckpoint,
  queryKey: string,
): Array<Record<string, unknown> & { verified: boolean; inspectionAttempted: boolean }> {
  const identities = new Set(
    checkpoint.discoveries
      .filter((discovery) => normalizeInspectionQuery(discovery.query) === queryKey)
      .flatMap((discovery) =>
        discovery.frames.flatMap((frame) =>
          typeof frame.pageId !== "string"
            ? []
            : [
                JSON.stringify([
                  frame.pageId,
                  typeof frame.ref === "string"
                    ? frame.ref
                    : JSON.stringify([
                        frame.name,
                        frame.type,
                        frame.x,
                        frame.y,
                        frame.width,
                        frame.height,
                      ]),
                ]),
              ],
        ),
      ),
  );
  return checkpoint.frames.filter((frame) =>
    identities.has(
      JSON.stringify([
        frame.pageId,
        typeof frame.ref === "string"
          ? frame.ref
          : JSON.stringify([frame.name, frame.type, frame.x, frame.y, frame.width, frame.height]),
      ]),
    ),
  );
}

function nextReadOnlyOperation(
  task: ChatTask,
  checkpoint: ReadOnlyCheckpoint,
  options: { forceFreshDiscovery: boolean; initialLedgerLength: number },
): ReadOnlyPlan {
  const query = task.targetName?.trim() || undefined;
  const queryKey = normalizeInspectionQuery(query);
  const run = checkpoint.discoveries.filter(
    (discovery) => normalizeInspectionQuery(discovery.query) === queryKey,
  );
  const newOffsetZeroAttempt = task.ledger.some((entry, index) => {
    const action = entry.call.action;
    return (
      index >= options.initialLedgerLength &&
      action.tool === "get_document_context" &&
      normalizeInspectionQuery(action.query) === queryKey &&
      (action.offset ?? 0) === 0
    );
  });
  if (options.forceFreshDiscovery && !newOffsetZeroAttempt)
    return {
      action: { tool: "get_document_context", ...(query ? { query } : {}), readOnlyInspection: true },
      progress: "Resuming the saved progressive discovery cursor and revalidating accessible pages…",
    };
  if (
    options.forceFreshDiscovery &&
    newOffsetZeroAttempt &&
    !run.some(({ ledgerIndex }) => ledgerIndex >= options.initialLedgerLength)
  ) {
    const priorEvidence = framesForDiscoveryRun(checkpoint, queryKey).some((frame) => frame.verified);
    return {
      outcome: priorEvidence ? "PARTIAL" : "BLOCKED",
      reason: "Fresh discovery could not be verified while resuming the saved inspection.",
    };
  }

  if (!run.length) {
    const failedInitialDiscovery = task.ledger.some((entry) => {
      const action = entry.call.action;
      return (
        action.tool === "get_document_context" &&
        normalizeInspectionQuery(action.query) === queryKey &&
        (action.offset ?? 0) === 0 &&
        entry.status === "failed"
      );
    });
    if (!failedInitialDiscovery)
      return {
        action: { tool: "get_document_context", ...(query ? { query } : {}), readOnlyInspection: true },
        progress: "Starting a progressive scan of all accessible pages…",
      };
    return { outcome: "BLOCKED", reason: "The initial bounded document discovery failed." };
  }

  const currentFrames = framesForDiscoveryRun(checkpoint, queryKey);
  const targets = currentFrames
    .filter(
      (frame) =>
        typeof frame.ref === "string" &&
        typeof frame.pageId === "string" &&
        !frame.verified &&
        !frame.inspectionAttempted,
    )
    .sort(
      (left, right) =>
        String(left.pageId).localeCompare(String(right.pageId)) ||
        String(left.name).localeCompare(String(right.name)) ||
        String(left.ref).localeCompare(String(right.ref)),
    );
  if (targets.length) {
    const first = targets[0]!;
    const pageId = String(first.pageId);
    const refs = targets
      .filter((frame) => frame.pageId === pageId)
      .slice(0, AUTONOMOUS_INSPECTION_REFS_PER_CALL)
      .map((frame) => String(frame.ref));
    return {
      action: {
        tool: "inspect_nodes",
        pageId,
        readOnlyInspection: true,
        refs,
        selection: false,
        depth: INSPECT_NODES_LIMITS.depth.default,
        maxNodes: INSPECT_NODES_LIMITS.maxNodes.default,
      },
      progress:
        "Inspecting " +
        refs.length +
        " discovered frame" +
        (refs.length === 1 ? "" : "s") +
        " on " +
        String(first.pageName ?? pageId) +
        "…",
    };
  }

  const latest = run.at(-1)!;
  if (latest.discovery.paused === true)
    return { paused: true, reason: "The native scan paused at a saved slice boundary." };
  const nextOffset = latest.discovery.nextOffset;
  if (typeof nextOffset === "number") {
    if (nextOffset <= latest.offset)
      return {
        outcome: "PARTIAL",
        reason: "The legacy discovery offset did not advance.",
      };
    const offsetAttempted = task.ledger.some((entry) => {
      const action = entry.call.action;
      return (
        action.tool === "get_document_context" &&
        normalizeInspectionQuery(action.query) === queryKey &&
        action.offset === nextOffset
      );
    });
    if (!offsetAttempted)
      return {
        action: {
          tool: "get_document_context",
          ...(query ? { query } : {}),
          offset: nextOffset,
          readOnlyInspection: true,
        },
        progress: "Reading the next matching frame window at offset " + nextOffset + "…",
      };
  }

  const failedAtCursor =
    typeof nextOffset === "number" &&
    task.ledger.some((entry) => {
      const action = entry.call.action;
      return (
        action.tool === "get_document_context" &&
        normalizeInspectionQuery(action.query) === queryKey &&
        action.offset === nextOffset &&
        entry.status === "failed"
      );
    });
  const discoveryTruncated = run.some(({ discovery }) =>
    discovery.truncated === true ||
    discovery.complete === false ||
    (typeof discovery.pagesVisited === "number" &&
      discovery.pagesVisited === 0 &&
      typeof discovery.pagesAvailable === "number" &&
      discovery.pagesAvailable > 0) ||
    (typeof discovery.pagesRemaining === "number" && discovery.pagesRemaining > 0),
  );
  const hasUninspectable = currentFrames.some(
    (frame) => typeof frame.ref !== "string" && frame.nativeInspected !== true,
  );
  const hasUninspected = currentFrames.some((frame) => !frame.verified);
  const inspectionFailures = task.ledger.filter(
    (entry) => {
      const action = entry.call.action;
      return (
        action.tool === "inspect_nodes" &&
        entry.status === "failed" &&
        action.refs.some((ref) =>
          currentFrames.some((frame) => frame.ref === ref && frame.pageId === action.pageId),
        )
      );
    },
  ).length;
  if (
    discoveryTruncated ||
    failedAtCursor ||
    hasUninspectable ||
    hasUninspected ||
    inspectionFailures > 0
  )
    return {
      outcome:
        inspectionFailures > 0 && !currentFrames.some((frame) => frame.verified)
          ? "FAILED"
          : currentFrames.some((frame) => frame.verified)
            ? "PARTIAL"
            : "BLOCKED",
      reason: discoveryTruncated
        ? "Progressive discovery stopped before the requested accessible scope was complete" +
          (typeof latest.discovery.truncationReason === "string"
            ? " (" + latest.discovery.truncationReason.replaceAll("_", " ") + ")."
            : ".")
        : failedAtCursor
          ? "A later discovery window could not be read."
          : hasUninspectable
            ? "Some discovered frames have no safe logical reference."
            : "One or more discovered frames could not be verified natively.",
    };

  const nativeInspection =
    latest.discovery.nativeInspection && typeof latest.discovery.nativeInspection === "object"
      ? (latest.discovery.nativeInspection as Record<string, unknown>)
      : undefined;
  if (
    !discoveryTruncated &&
    nativeInspection?.complete === true &&
    typeof nativeInspection.framesInspected === "number" &&
    typeof nativeInspection.framesExpected === "number" &&
    nativeInspection.framesInspected === nativeInspection.framesExpected
  )
    return {
      outcome: nativeInspection.framesExpected === 0 ? "NO_MATCH" : "COMPLETED",
    };
  if (currentFrames.length === 0) {
    const lastDiscovery = latest.discovery;
    if (typeof lastDiscovery.matchCount === "number" && lastDiscovery.matchCount > 0)
      return { outcome: "PARTIAL", reason: "Matching targets were found, but no bounded native inspection sample could be retained." };
    if (lastDiscovery.complete === true && lastDiscovery.truncated !== true)
      return { outcome: "NO_MATCH" };
    return { outcome: "PARTIAL", reason: "The requested scope was not fully scanned." };
  }
  const nativeReadOnlyOperations = task.ledger.filter(
    (entry) =>
      entry.call.action.tool === "get_document_context" ||
      entry.call.action.tool === "inspect_nodes",
  ).length;
  if (nativeReadOnlyOperations >= MAX_AUTONOMOUS_INSPECTION_OPERATIONS)
    return {
      outcome: currentFrames.some((frame) => frame.verified) ? "PARTIAL" : "BLOCKED",
      reason:
        "The " +
        MAX_AUTONOMOUS_INSPECTION_OPERATIONS +
        "-operation autonomous inspection budget was reached.",
    };
  return { outcome: "COMPLETED" };
}

function readOnlyInspectionSummary(
  task: ChatTask,
  checkpoint: ReadOnlyCheckpoint,
): NonNullable<ChatTask["inspectionSummary"]> {
  const queryKey = normalizeInspectionQuery(task.targetName);
  const run = checkpoint.discoveries.filter(
    (discovery) => normalizeInspectionQuery(discovery.query) === queryKey,
  );
  const frames = framesForDiscoveryRun(checkpoint, queryKey);
  const discoveries = run.map(({ discovery }) => discovery);
  const pages = [
    ...new Map(
      run.flatMap(({ pages: pageSummaries }) =>
        pageSummaries.flatMap((page) =>
          typeof page.id === "string" ? [[page.id, page] as const] : [],
        ),
      ),
    ).values(),
  ];
  const latest = discoveries.at(-1);
  const latestNativeInspection =
    latest?.nativeInspection && typeof latest.nativeInspection === "object"
      ? (latest.nativeInspection as Record<string, unknown>)
      : undefined;
  const reportedFrameCount = discoveries.reduce(
    (max, discovery) =>
      Math.max(
        max,
        typeof discovery.framesDiscovered === "number"
          ? discovery.framesDiscovered
          : typeof discovery.matchCount === "number"
            ? discovery.matchCount
            : 0,
      ),
    0,
  );
  const pagesScanned = discoveries.reduce(
    (max, discovery) =>
      Math.max(max, typeof discovery.pagesVisited === "number" ? discovery.pagesVisited : 0),
    pages.length,
  );
  const pagesAvailable = discoveries.reduce(
    (max, discovery) =>
      Math.max(max, typeof discovery.pagesAvailable === "number" ? discovery.pagesAvailable : 0),
    pages.length,
  );
  const nativeResults = task.ledger.flatMap((entry) => {
    if (entry.call.action.tool !== "get_document_context" && entry.call.action.tool !== "inspect_nodes")
      return [];
    try {
      const payload = JSON.parse(entry.output ?? "{}");
      return payload && typeof payload === "object" ? [payload as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  const sumProfile = (field: string) =>
    nativeResults.reduce((total, result) => {
      const profiling = result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>).profiling
        : undefined;
      const value = profiling && typeof profiling === "object"
        ? (profiling as Record<string, unknown>)[field]
        : undefined;
      return total + (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);
    }, 0);
  const profileValues = (field: string) =>
    nativeResults.flatMap((result) => {
      const profiling = result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>).profiling
        : undefined;
      const value = profiling && typeof profiling === "object"
        ? (profiling as Record<string, unknown>)[field]
        : undefined;
      return typeof value === "number" && Number.isFinite(value) ? [Math.max(0, value)] : [];
    });
  const resultPayloadSizes = profileValues("resultPayloadBytes");
  const transferPayloadSizes = profileValues("transferPayloadBytes");
  const discoveryPerformance = run.reduce(
    (total, { discovery, frames: resultFrames }) => {
      if (discovery.cacheHit !== true) {
        total.pagesLoaded += typeof discovery.pagesVisited === "number" ? Math.max(0, discovery.pagesVisited) : 0;
        total.nodesVisited += typeof discovery.nodesVisited === "number" ? Math.max(0, discovery.nodesVisited) : 0;
      } else total.discoveryCacheHits++;
      total.framesReturned += resultFrames.length;
      return total;
    },
    { pagesLoaded: 0, nodesVisited: 0, framesReturned: 0, discoveryCacheHits: 0 },
  );
  const modelTrace = task.modelRoundTrace ?? [];
  const uiRenderProfile =
    typeof window !== "undefined"
      ? (window as Window & { __fadUiRenderProfile?: { commits?: number; actualDurationMs?: number } })
          .__fadUiRenderProfile
      : undefined;
  return {
    pagesScanned,
    pagesAvailable: Math.max(0, pagesAvailable),
    scope:
      latest?.scope === "exact_node" || latest?.scope === "requested_page"
        ? latest.scope
        : "all_accessible_pages",
    pagesRemaining: Math.max(
      0,
      typeof latest?.pagesRemaining === "number" ? latest.pagesRemaining : pagesAvailable - pagesScanned,
    ),
    framesDiscovered: Math.max(reportedFrameCount, frames.length),
    matchingFrames: discoveries.reduce(
        (max, discovery) =>
          Math.max(max, typeof discovery.matchCount === "number" ? discovery.matchCount : 0),
        task.targetName ? 0 : frames.length,
    ),
    framesInspected:
      typeof latestNativeInspection?.framesInspected === "number"
        ? latestNativeInspection.framesInspected
        : frames.filter((frame) => frame.verified).length,
    uninspectedFrames: Math.max(
      0,
      (typeof latestNativeInspection?.framesExpected === "number"
        ? latestNativeInspection.framesExpected
        : discoveries.reduce(
            (max, discovery) =>
              Math.max(max, typeof discovery.matchCount === "number" ? discovery.matchCount : 0),
            0,
          )) -
        (typeof latestNativeInspection?.framesInspected === "number"
          ? latestNativeInspection.framesInspected
          : frames.filter((frame) => frame.verified).length),
    ),
    inaccessiblePages: typeof latest?.inaccessiblePages === "number" ? latest.inaccessiblePages : 0,
    inaccessiblePageSamples: Array.isArray(latest?.inaccessiblePageSamples)
      ? latest.inaccessiblePageSamples.flatMap((page) =>
          page && typeof page === "object" && typeof (page as Record<string, unknown>).id === "string"
            ? [{
                id: String((page as Record<string, unknown>).id).slice(0, 200),
                name: typeof (page as Record<string, unknown>).name === "string"
                  ? String((page as Record<string, unknown>).name).slice(0, 100)
                  : "",
                ...(typeof (page as Record<string, unknown>).reason === "string"
                  ? { reason: String((page as Record<string, unknown>).reason).slice(0, 100) }
                  : {}),
              }]
            : [],
        ).slice(0, 24)
      : [],
    complete: latest?.complete === true && latest.truncated !== true,
    continuationAvailable: latest?.continuationAvailable === true,
    ...(typeof latest?.truncationReason === "string" ? { truncationReason: latest.truncationReason.slice(0, 160) } : {}),
    truncated:
      discoveries.some(
        (discovery) =>
          discovery.truncated === true ||
          discovery.complete === false,
      ) ||
      checkpoint.pendingOffsets.length > 0,
    nativeOperations: Math.min(
      CHAT_TASK_MAX_READ_ONLY_OPERATIONS,
      task.ledger.filter(
        (entry) =>
          entry.call.action.tool === "get_document_context" ||
          entry.call.action.tool === "inspect_nodes",
      ).length,
    ),
    repeatedOperations: Math.min(
      CHAT_TASK_MAX_READ_ONLY_OPERATIONS,
      checkpoint.repeatedOperations,
    ),
    nativePerformance: {
      pagesLoaded:
        discoveryPerformance.pagesLoaded,
      loadedPageCacheEntries: typeof latest?.loadedPageCacheEntries === "number" ? latest.loadedPageCacheEntries : 0,
      trackedPageListeners: typeof latest?.trackedPageListeners === "number" ? latest.trackedPageListeners : 0,
      globalInvalidationFallback: latest?.globalInvalidationFallback === true,
      discoveryCacheEntries: typeof latest?.discoveryCacheEntries === "number" ? latest.discoveryCacheEntries : 0,
      discoveryCacheBytes: typeof latest?.discoveryCacheBytes === "number" ? latest.discoveryCacheBytes : 0,
      nodesVisited: discoveryPerformance.nodesVisited,
      framesReturned:
        typeof latest?.framesReturned === "number" ? latest.framesReturned : discoveryPerformance.framesReturned,
      slices: typeof latest?.sliceCount === "number" ? latest.sliceCount : 0,
      nodesPerSliceBudget: typeof latest?.nodesPerSliceBudget === "number" ? latest.nodesPerSliceBudget : 128,
      pagesPerCheckpoint: typeof latest?.pagesPerCheckpoint === "number" ? latest.pagesPerCheckpoint : 32,
      pagesPerYield: typeof latest?.pagesPerYield === "number" ? latest.pagesPerYield : 4,
      maxNodesPerSliceObserved:
        typeof latest?.maxNodesPerSliceObserved === "number" ? latest.maxNodesPerSliceObserved : 0,
      targetSliceMs: typeof latest?.targetSliceMs === "number" ? latest.targetSliceMs : 35,
      hardSliceMs: typeof latest?.hardSliceMs === "number" ? latest.hardSliceMs : 100,
      averageSliceMs: typeof latest?.averageSliceMs === "number" ? latest.averageSliceMs : 0,
      maxSliceMs: typeof latest?.maxSliceMs === "number" ? latest.maxSliceMs : 0,
      pageLoadMs: run.reduce(
        (total, { discovery }) => total + (discovery.cacheHit === true ? 0 : typeof discovery.pageLoadMs === "number" ? discovery.pageLoadMs : 0),
        0,
      ),
      scanElapsedMs: run.reduce(
        (total, { discovery }) => total + (discovery.cacheHit === true ? 0 : typeof discovery.scanElapsedMs === "number" ? discovery.scanElapsedMs : 0),
        0,
      ),
      cacheHit: latest?.cacheHit === true,
      revalidatedAfterRestart: latest?.revalidatedAfterRestart === true,
      discoveryCacheHits: Math.min(
        CHAT_TASK_MAX_READ_ONLY_OPERATIONS,
        discoveryPerformance.discoveryCacheHits,
      ),
      discoveryCacheLookups: Math.min(
        CHAT_TASK_MAX_READ_ONLY_OPERATIONS,
        typeof latest?.cacheLookups === "number" ? latest.cacheLookups : run.length,
      ),
      discoveryCacheHitRate:
        typeof latest?.cacheHitRate === "number"
          ? latest.cacheHitRate
          : run.length ? discoveryPerformance.discoveryCacheHits / run.length : 0,
      nativeExecutionMs: Math.min(86_400_000, sumProfile("nativeExecutionMs")),
      resultSerializationMs: Math.min(86_400_000, sumProfile("resultSerializationMs")),
      resultPayloadBytes: Math.min(10_000_000, sumProfile("resultPayloadBytes")),
      transferPayloadBytes: Math.min(10_000_000, sumProfile("transferPayloadBytes")),
      resultPayloadBytesPeak: Math.min(10_000_000, Math.max(0, ...resultPayloadSizes)),
      transferPayloadBytesPeak: Math.min(10_000_000, Math.max(0, ...transferPayloadSizes)),
      payloadSamples: Math.min(CHAT_TASK_MAX_READ_ONLY_OPERATIONS, Math.max(resultPayloadSizes.length, transferPayloadSizes.length)),
      modelRequests: Math.min(100, task.rounds + (task.roundBreakdown?.modelRetries ?? 0)),
      modelLatencyMs: Math.min(
        86_400_000,
        modelTrace.reduce((total, round) => total + (round.durationMs ?? 0), 0),
      ),
      modelInputBytes: Math.min(
        10_000_000,
        modelTrace.reduce((total, round) => total + (round.inputBytes ?? 0), 0),
      ),
      uiRenderCommits: Math.min(
        10_000,
        Number.isFinite(uiRenderProfile?.commits) ? Math.max(0, Math.round(uiRenderProfile!.commits!)) : 0,
      ),
      uiRenderDurationMs: Math.min(
        86_400_000,
        Number.isFinite(uiRenderProfile?.actualDurationMs)
          ? Math.max(0, Math.round(uiRenderProfile!.actualDurationMs!))
          : 0,
      ),
    },
    canvasMutations: 0,
  };
}

function readOnlyInspectionReport(
  task: ChatTask,
  checkpoint: ReadOnlyCheckpoint,
  outcome: NonNullable<ChatTask["inspectionOutcome"]>,
  reason?: string,
): string {
  const summary = task.inspectionSummary ?? readOnlyInspectionSummary(task, checkpoint);
  const queryKey = normalizeInspectionQuery(task.targetName);
  const run = checkpoint.discoveries.filter(
    (discovery) => normalizeInspectionQuery(discovery.query) === queryKey,
  );
  const verified = framesForDiscoveryRun(checkpoint, queryKey).filter((frame) => frame.verified);
  const pages = [
    ...new Map(
      run.flatMap(({ pages: pageSummaries }) =>
        pageSummaries.flatMap((page) =>
          typeof page.id === "string" ? [[page.id, page] as const] : [],
        ),
      ),
    ).values(),
  ]
    .map((page) => {
      const name = typeof page.name === "string" ? page.name : "";
      const id = typeof page.id === "string" ? page.id : "";
      return name && id ? name + " (" + id + ")" : name || id;
    })
    .filter(Boolean);
  const statusText: Record<typeof outcome, string> = {
    COMPLETED: "Complete across the requested accessible scope",
    PARTIAL: "Partial; some of the requested scope could not be verified",
    NO_MATCH: "Complete search; no matching frames were found",
    BLOCKED: "Blocked; required discovery or native evidence was unavailable",
    CANCELLED: "Cancelled",
    FAILED: "Failed; native inspection could not be completed",
  };
  const lines = [
    "Inspection status: " + statusText[outcome] + ".",
    "Search scope: " + summary.scope.replaceAll("_", " ") + ".",
    "Pages scanned: " +
      summary.pagesScanned +
      (summary.pagesAvailable > summary.pagesScanned
        ? " of " + summary.pagesAvailable + " available"
        : "") +
      ".",
    "Frames discovered: " + summary.framesDiscovered + ".",
    "Matching frames: " + summary.matchingFrames + ".",
    "Frames inspected natively: " + summary.framesInspected + ".",
    "Frames not inspected: " + summary.uninspectedFrames + ".",
    "Scan coverage: " + (summary.complete ? "complete" : "partial") +
      (summary.pagesRemaining ? "; " + summary.pagesRemaining + " pages remain" : "") +
      (summary.inaccessiblePages ? "; " + summary.inaccessiblePages + " page(s) were inaccessible" : "") +
      (summary.continuationAvailable ? "; a saved continuation is available" : "") + ".",
    "Inspection work: " + summary.nativeOperations + " native operations; " +
      summary.nativePerformance.pagesLoaded + " pages loaded; " +
      summary.nativePerformance.nodesVisited + " nodes visited; " +
      summary.nativePerformance.slices + " slices (maximum " +
      summary.nativePerformance.maxNodesPerSliceObserved + "/" +
      summary.nativePerformance.nodesPerSliceBudget + " work units per slice; average " + summary.nativePerformance.averageSliceMs +
      " ms, maximum " + summary.nativePerformance.maxSliceMs + " ms; yield at least every " +
      summary.nativePerformance.pagesPerYield + " pages and checkpoint every " +
      summary.nativePerformance.pagesPerCheckpoint + " pages); " +
      summary.nativePerformance.scanElapsedMs + " ms in traversal; " +
      summary.nativePerformance.pageLoadMs + " ms loading pages; " +
      summary.nativePerformance.nativeExecutionMs + " ms native execution; " +
      summary.nativePerformance.resultPayloadBytes + " result bytes; " +
      summary.nativePerformance.transferPayloadBytes + " transfer bytes.",
    "Discovery cache: " + summary.nativePerformance.discoveryCacheHits + "/" +
      summary.nativePerformance.discoveryCacheLookups + " hits (" +
      Math.round(summary.nativePerformance.discoveryCacheHitRate * 100) + "% hit rate); " +
      "revalidated after restart: " + (summary.nativePerformance.revalidatedAfterRestart ? "yes." : "no."),
    "Resident discovery memory: " + summary.nativePerformance.loadedPageCacheEntries + "/64 tracked loaded-page IDs; " +
      summary.nativePerformance.trackedPageListeners + "/64 page listeners; " +
      summary.nativePerformance.discoveryCacheEntries + "/12 cursors (" +
      summary.nativePerformance.discoveryCacheBytes + " bytes); global invalidation fallback " +
      (summary.nativePerformance.globalInvalidationFallback ? "active." : "inactive."),
    "Payload sizes: peak " + summary.nativePerformance.resultPayloadBytesPeak + " result bytes and " +
      summary.nativePerformance.transferPayloadBytesPeak + " transfer bytes across " +
      summary.nativePerformance.payloadSamples + " native replies.",
    "Model requests: " + summary.nativePerformance.modelRequests + "; " +
      summary.nativePerformance.modelLatencyMs + " ms total Companion/model time; " +
      summary.nativePerformance.modelInputBytes + " input bytes.",
    "UI rendering: " + summary.nativePerformance.uiRenderCommits + " React commits; " +
      summary.nativePerformance.uiRenderDurationMs + " ms aggregate render time.",
  ];
  if (pages.length)
    lines.push(
      "Pages visited" + (pages.length < summary.pagesScanned ? " (sample)" : "") + ": " +
        pages.join(", ") + ".",
    );
  if (summary.inaccessiblePageSamples.length)
    lines.push(
      "Inaccessible page sample: " +
        summary.inaccessiblePageSamples
          .map(({ name, id, reason }) => `${name || id} (${id}${reason ? ", " + reason.replaceAll("_", " ") : ""})`)
          .join(", ") +
        ".",
    );
  if (verified.length) {
    lines.push("Verified frames:");
    for (const frame of verified.slice(0, 60)) {
      const page =
        typeof frame.pageName === "string" ? frame.pageName : String(frame.pageId ?? "Unknown page");
      const name = typeof frame.name === "string" ? frame.name.slice(0, 80) : "Unnamed frame";
      const geometry = [frame.width, frame.height].every(Number.isFinite)
        ? Math.round(Number(frame.width)) + " × " + Math.round(Number(frame.height))
        : "dimensions unavailable";
      const location = [frame.x, frame.y].every(Number.isFinite)
        ? " at (" + Math.round(Number(frame.x)) + ", " + Math.round(Number(frame.y)) + ")"
        : "";
      const line = "• " + page + " / " + name + " — " + geometry + location + ".";
      if (lines.join("\n").length + line.length > 7_400) {
        lines.push("Additional verified frames omitted from this short report: " + (verified.length - lines.length + 6) + ".");
        break;
      }
      lines.push(line);
    }
  }
  if (summary.truncated)
    lines.push("Coverage is partial; the report does not claim an exhaustive scan.");
  if (summary.truncationReason)
    lines.push("Scan stop reason: " + summary.truncationReason.replaceAll("_", " ") + ".");
  if (summary.nativePerformance.revalidatedAfterRestart)
    lines.push("A previous executor cursor was stale, so accessible pages were revalidated from the start.");
  if (reason) lines.push("Limitation: " + reason.slice(0, 300));
  lines.push("Canvas mutations: 0.");
  return lines.join("\n").slice(0, 8_000);
}

function autonomousInspectionCall(task: ChatTask, action: FigmaToolAction) {
  const { tool, ...args } = action;
  return parseResponsesFunctionCalls([
    {
      type: "function_call",
      call_id: "readonly_" + task.id + "_" + (task.ledger.length + 1) + "_" + (task.rounds + 1),
      name: tool,
      arguments: JSON.stringify(args),
    },
  ])[0]!;
}

function autonomousEditTargetCall(task: ChatTask, action: FigmaToolAction) {
  const { tool, ...args } = action;
  return parseResponsesFunctionCalls([
    {
      type: "function_call",
      call_id: EDIT_TARGET_CALL_PREFIX + task.id + "_" + (task.ledger.length + 1) + "_" + (task.rounds + 1),
      name: tool,
      arguments: JSON.stringify(args),
    },
  ])[0]!;
}

const EDIT_TARGET_CALL_PREFIX = "edit_target_";

function editTargetQuery(task: ChatTask): string | undefined {
  if (task.targetName?.trim()) return task.targetName.trim().slice(0, 100);
  const stopWords = new Set([
    "a", "an", "the", "existing", "design", "redesign", "improve", "update", "change",
    "make", "better", "please", "of", "for", "in", "on", "page", "screen", "frame",
    "safhe", "safheye", "ro", "behtar", "kon", "konid", "tarahi", "tarahie", "design", "ye",
    "یک", "را", "رو", "بهتر", "کن", "کنید", "طراحی", "صفحه", "موجود", "فعلی", "لطفا", "برای",
  ]);
  const terms = task.prompt
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1 && !stopWords.has(term))
    .slice(-8);
  const query = terms.join(" ").trim();
  return query ? query.slice(0, 100) : undefined;
}

function ledgerPayload(entry: ChatTask["ledger"][number]): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(entry.output ?? "{}");
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function inspectEvidenceTree(nodes: unknown[]): {
  verifiedRefs: string[];
  nativeEvidence: string;
  root?: Record<string, unknown>;
} {
  const fields = [
    "ref", "type", "name", "x", "y", "width", "height", "visible", "locked", "fill", "stroke",
    "opacity", "cornerRadius", "text", "fontSize", "textColor", "textAlignHorizontal", "fontFamily",
    "fontStyle", "lineHeight", "letterSpacing", "layoutMode", "itemSpacing", "paddingTop",
    "paddingRight", "paddingBottom", "paddingLeft",
  ];
  const rows: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, parentRef?: string) => {
    if (rows.length >= 25 || !value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const row = Object.fromEntries(fields.filter((field) => node[field] !== undefined).map((field) => [field, node[field]]));
    if (parentRef) row.parentRef = parentRef;
    rows.push(row);
    if (Array.isArray(node.children))
      for (const child of node.children) visit(child, typeof node.ref === "string" ? node.ref : parentRef);
  };
  for (const node of nodes) visit(node);
  return {
    verifiedRefs: [...new Set(rows.flatMap((row) => typeof row.ref === "string" ? [row.ref] : []))].slice(0, 25),
    nativeEvidence: JSON.stringify(rows).slice(0, 16_000),
    ...(nodes[0] && typeof nodes[0] === "object" && !Array.isArray(nodes[0])
      ? { root: nodes[0] as Record<string, unknown> }
      : {}),
  };
}

function editTargetFromInspection(
  task: ChatTask,
  entry: ChatTask["ledger"][number],
  resultData: Record<string, unknown>,
): NonNullable<ChatTask["editTarget"]> | undefined {
  if (entry.call.action.tool !== "inspect_nodes" || entry.call.action.refs.length !== 1) return undefined;
  const ref = entry.call.action.refs[0]!;
  const actionPageId = entry.call.action.pageId;
  const saved = task.editTarget?.ref === ref && task.editTarget.pageId === actionPageId ? task.editTarget : undefined;
  const discoveryEntry = [...task.ledger].reverse().find((candidate) => {
    if (candidate.status !== "completed" || candidate.call.action.tool !== "get_document_context") return false;
    const query = saved?.query ?? editTargetQuery(task);
    return normalizeInspectionQuery(candidate.call.action.query) === normalizeInspectionQuery(query);
  });
  const discoveryPayload = discoveryEntry ? ledgerPayload(discoveryEntry) : undefined;
  const discoveryData = discoveryPayload?.data && typeof discoveryPayload.data === "object"
    ? discoveryPayload.data as Record<string, unknown>
    : undefined;
  const discoverySummary = discoveryData?.discovery && typeof discoveryData.discovery === "object"
    ? discoveryData.discovery as Record<string, unknown>
    : undefined;
  const exactNameCount = discoverySummary?.exactNameMatchCount;
  const frame = saved
    ? { ...saved }
    : (Array.isArray(discoveryData?.frames)
        ? discoveryData.frames.find((candidate) => candidate && typeof candidate === "object" &&
            (candidate as Record<string, unknown>).ref === ref &&
            (candidate as Record<string, unknown>).pageId === actionPageId &&
            (exactNameCount !== 1 || typeof (candidate as Record<string, unknown>).name === "string" &&
              normalizeInspectionQuery(String((candidate as Record<string, unknown>).name)) === normalizeInspectionQuery(String(discoverySummary?.query ?? task.targetName ?? ""))))
        : undefined) as Record<string, unknown> | undefined;
  const roots = Array.isArray(resultData.nodes) ? resultData.nodes : [];
  const inspected = inspectEvidenceTree(roots);
  const root = inspected.root;
  if (
    !frame || !root || root.ref !== ref || resultData.pageId !== actionPageId ||
    !inspected.verifiedRefs.includes(ref) ||
    (typeof frame.nodeId !== "string" && typeof saved?.nodeId !== "string") ||
    (typeof frame.type === "string" && frame.type !== root.type) ||
    (typeof frame.name === "string" && frame.name !== root.name) ||
    !["x", "y", "width", "height"].every((field) => {
      const before = frame[field];
      const after = root[field];
      return typeof before !== "number" || typeof after === "number" && Math.abs(before - after) < 0.01;
    })
  ) return undefined;
  const discoveryId = discoveryEntry?.operationId ?? saved?.discoveryOperationId;
  if (!discoveryId) return undefined;
  return {
    query: saved?.query ?? String(discoveryData?.discovery && typeof discoveryData.discovery === "object"
      ? (discoveryData.discovery as Record<string, unknown>).query ?? editTargetQuery(task) ?? task.targetName ?? ""
      : editTargetQuery(task) ?? task.targetName ?? "").slice(0, 100),
    ref,
    pageId: actionPageId ?? saved?.pageId ?? "",
    ...(typeof frame.pageName === "string" ? { pageName: frame.pageName.slice(0, 100) } : saved?.pageName ? { pageName: saved.pageName } : {}),
    nodeId: typeof frame.nodeId === "string" ? frame.nodeId : saved!.nodeId,
    ...(typeof frame.parentNodeId === "string" ? { parentId: frame.parentNodeId } : saved?.parentId ? { parentId: saved.parentId } : {}),
    type: String(root.type ?? frame.type ?? "FRAME"),
    name: String(root.name ?? frame.name ?? "Target frame").slice(0, 100),
    x: Number(root.x),
    y: Number(root.y),
    width: Number(root.width),
    height: Number(root.height),
    verifiedRefs: inspected.verifiedRefs,
    ...(saved?.plannedRefs ? { plannedRefs: saved.plannedRefs } : {}),
    nativeEvidence: inspected.nativeEvidence,
    discoveryOperationId: discoveryId,
    inspectionOperationId: entry.operationId,
  };
}

type EditTargetOperation =
  | { action: FigmaToolAction; progress: string }
  | { ready: true }
  | { blocked: true; code: "target_not_found" | "target_ambiguous" | "target_not_inspected" | "reference_not_mutation_eligible"; reason: string };

function nextEditTargetOperation(
  task: ChatTask,
  options: { forceFresh: boolean; initialLedgerLength: number },
): EditTargetOperation {
  const query = task.editTarget?.query ?? editTargetQuery(task);
  if (!query)
    return { blocked: true, code: "target_not_found", reason: "Name the existing frame or screen to edit; no selection was used as a fallback." };
  if (!task.targetName) task.targetName = query;
  if (task.editTarget) {
    const inspection = task.ledger.find((entry) => entry.operationId === task.editTarget!.inspectionOperationId);
    const verified = inspection?.status === "completed" && ledgerPayload(inspection)?.success === true;
    const freshInspection = task.ledger.some((entry, index) => index >= options.initialLedgerLength &&
      entry.call.callId.startsWith(EDIT_TARGET_CALL_PREFIX) && entry.call.action.tool === "inspect_nodes" &&
      entry.status === "completed" && ledgerPayload(entry)?.success === true);
    if (options.forceFresh && !freshInspection)
      return {
        action: {
          tool: "inspect_nodes", pageId: task.editTarget.pageId, refs: [task.editTarget.ref],
          selection: false, depth: INSPECT_NODES_LIMITS.depth.max, maxNodes: INSPECT_NODES_LIMITS.maxNodes.max,
          readOnlyInspection: false,
        },
        progress: "Revalidating the saved edit target and its native hierarchy…",
      };
    if (!verified && !freshInspection)
      return { blocked: true, code: "target_not_inspected", reason: "The discovered target has no successful native inspection checkpoint." };
    return { ready: true };
  }

  const contexts = task.ledger.filter((entry) => {
    const action = entry.call.action;
    return action.tool === "get_document_context" && action.readOnlyInspection !== true &&
      (action.offset ?? 0) === 0 && normalizeInspectionQuery(action.query) === normalizeInspectionQuery(query);
  });
  const freshContext = contexts.some((entry) => task.ledger.indexOf(entry) >= options.initialLedgerLength &&
    entry.status === "completed" && ledgerPayload(entry)?.success === true);
  if (options.forceFresh && !freshContext)
    return {
      action: { tool: "get_document_context", query, readOnlyInspection: false },
      progress: "Resuming the progressive scan and revalidating the named edit target…",
    };
  const context = [...contexts].reverse().find((entry) => entry.status === "completed" && ledgerPayload(entry)?.success === true);
  if (!context) {
    if (contexts.some((entry) => entry.status === "failed"))
      return { blocked: true, code: "target_not_found", reason: "Figma could not complete discovery for the requested existing target." };
    return {
      action: { tool: "get_document_context", query, readOnlyInspection: false },
      progress: "Progressively discovering the named existing frame across accessible pages…",
    };
  }
  const payload = ledgerPayload(context)!;
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : undefined;
  const discovery = data?.discovery && typeof data.discovery === "object" ? data.discovery as Record<string, unknown> : {};
  if (discovery.paused === true || discovery.truncated === true || discovery.complete !== true ||
      (typeof discovery.pagesRemaining === "number" && discovery.pagesRemaining > 0))
    return { blocked: true, code: "target_not_inspected", reason: "Target discovery paused or reached a scan limit before full accessible-page coverage; the edit was not planned." };
  const matchStatus = discovery.matchStatus;
  if (matchStatus === "ambiguous" || (typeof discovery.matchCount === "number" && discovery.matchCount > 1 && discovery.exactNameMatchCount !== 1))
    return { blocked: true, code: "target_ambiguous", reason: `“${query}” matches multiple existing frames. Specify which frame to edit; nothing was changed.` };
  if (matchStatus === "no_match" || discovery.matchCount === 0)
    return { blocked: true, code: "target_not_found", reason: `No existing frame matched “${query}” across the completed accessible-page scan. No replacement was created.` };
  if (matchStatus === "uneditable")
    return { blocked: true, code: "reference_not_mutation_eligible", reason: "The matching frame was discovered but could not be promoted to a safe mutation-eligible reference." };
  const frames = Array.isArray(data?.frames) ? data.frames.filter((frame) => frame && typeof frame === "object") as Array<Record<string, unknown>> : [];
  const exactNameUnique = discovery.exactNameMatchCount === 1;
  const matchingFrames = frames.filter((item) => typeof item.ref === "string" && typeof item.nodeId === "string" && typeof item.pageId === "string");
  const frame = (exactNameUnique
    ? matchingFrames.find((item) => normalizeInspectionQuery(String(item.name ?? "")) === normalizeInspectionQuery(query))
    : matchingFrames[0]);
  if (matchStatus !== "unique" ||
      (discovery.matchCount !== 1 && discovery.exactNameMatchCount !== 1) ||
      !frame)
    return { blocked: true, code: "target_not_found", reason: "A unique, safely referenced existing frame was not established by discovery." };
  if (frame.editable !== true || !["FRAME", "COMPONENT", "COMPONENT_SET"].includes(String(frame.type)))
    return { blocked: true, code: "reference_not_mutation_eligible", reason: "The discovered target is not a verified editable frame/component." };
  const ref = String(frame.ref);
  const pageId = String(frame.pageId);
  const inspections = task.ledger.filter((entry) => entry.call.action.tool === "inspect_nodes" &&
    entry.call.action.readOnlyInspection !== true && entry.call.action.pageId === pageId &&
    entry.call.action.refs.includes(ref));
  const inspection = [...inspections].reverse().find((entry) => entry.status === "completed" && ledgerPayload(entry)?.success === true);
  if (!inspection) {
    if (inspections.some((entry) => entry.status === "failed"))
      return { blocked: true, code: "target_not_inspected", reason: "Native inspection could not verify the discovered target. No edit plan or mutation was created." };
    return {
      action: {
        tool: "inspect_nodes", pageId, refs: [ref], selection: false,
        depth: INSPECT_NODES_LIMITS.depth.max, maxNodes: INSPECT_NODES_LIMITS.maxNodes.max,
        readOnlyInspection: false,
      },
      progress: `Inspecting “${String(frame.name ?? query).slice(0, 80)}” and its native hierarchy before planning…`,
    };
  }
  return { blocked: true, code: "target_not_inspected", reason: "Native inspection completed but did not produce durable verified target evidence." };
}

function editMutationBlocker(
  task: ChatTask,
  calls: Array<{ action: FigmaToolAction }>,
  reservations?: string[],
): string | undefined {
  const target = task.editTarget;
  if (!target) return "target_not_inspected: the edit target is not checkpointed.";
  const allowed = new Set((target.plannedRefs ?? []).filter((ref) => target.verifiedRefs.includes(ref)));
  const occupied = new Set(target.verifiedRefs);
  const created = new Set<string>();
  const nonContainerRefs = new Set<string>();
  for (const entry of task.ledger) {
    const action = entry.call.action;
    if (
      entry.status === "completed" && !entry.reused && entry.acknowledgementStatus === "confirmed_mutation" &&
      ["create_frame", "create_text", "create_rectangle"].includes(action.tool) &&
      "parent" in action && action.parent.kind === "node" &&
      (allowed.has(action.parent.ref) || created.has(action.parent.ref)) &&
      (!action.pageId || action.pageId === target.pageId) && "ref" in action
    ) {
      created.add(action.ref);
      if (action.tool !== "create_frame") nonContainerRefs.add(action.ref);
      try {
        const ref: unknown = JSON.parse(entry.output ?? "{}").logicalRef;
        if (typeof ref === "string") {
          created.add(ref);
          if (action.tool !== "create_frame") nonContainerRefs.add(ref);
        }
      } catch {
        // The action alias remains available from the confirmed checkpoint.
      }
    }
  }
  for (const ref of created) occupied.add(ref);
  const stage = task.stages.find((item) => !item.completed);
  if (!stage) return "native_execution_blocked: no saved edit stage is active.";
  const stageRefs = new Set(stage.logicalRefs);
  const additions: string[] = [];
  const otherStageRefs = new Set(task.stages.filter((item) => item !== stage).flatMap((item) => item.logicalRefs));
  const inScope = (ref: string) => allowed.has(ref) || created.has(ref);
  for (const { action } of calls) {
    if (!isCanvasMutationTool(action.tool)) continue;
    if (action.tool === "set_properties") {
      const propertiesKey = JSON.stringify(
        Object.entries(action.properties).sort(([first], [second]) => first.localeCompare(second)),
      );
      const alreadyConfirmed = task.ledger.some((entry) => {
        const prior = entry.call.action;
        if (
          entry.status !== "completed" ||
          entry.reused ||
          entry.acknowledgementStatus !== "confirmed_mutation" ||
          prior.tool !== "set_properties" ||
          prior.ref !== action.ref ||
          (prior.pageId ?? target.pageId) !== (action.pageId ?? target.pageId)
        )
          return false;
        return JSON.stringify(
          Object.entries(prior.properties).sort(([first], [second]) => first.localeCompare(second)),
        ) === propertiesKey;
      });
      if (alreadyConfirmed)
        return `duplicate_confirmed_operation: The exact property update for ${action.ref} is already confirmed in the saved ledger. Do not replay it; request fresh stage verification or continue only with a different outstanding requirement.`;
    }
    if ("pageId" in action && action.pageId && action.pageId !== target.pageId)
      return "native_execution_blocked: edit operations must remain on the verified target page.";
    if (action.tool === "create_frame" || action.tool === "create_text" || action.tool === "create_rectangle") {
      if (occupied.has(action.ref) || created.has(action.ref) || /^task-/iu.test(action.ref))
        return `edit_plan_invalid: Creation ref ${action.ref} already identifies a layer or is reserved for native identity. Reuse an existing layer through an edit or supply a fresh alias.`;
      if (action.parent.kind !== "node")
        return `native_execution_blocked: Creation ref ${action.ref} has a page parent. Use the approved existing frame ${target.ref} or an authorized nested parent.`;
      if (action.tool === "create_frame" && action.name.trim().toLowerCase() === target.name.trim().toLowerCase())
        return `native_execution_blocked: Creation ref ${action.ref} duplicates the existing screen name. Edit the approved screen ${target.ref} in place.`;
      if (nonContainerRefs.has(action.parent.ref))
        return `edit_plan_invalid: Creation ref ${action.ref} has a non-container parent ${action.parent.ref}. Use a frame or reusable container as its parent.`;
      if (!inScope(action.parent.ref))
        return `edit_plan_invalid: Creation ref ${action.ref} uses unresolved parent ${action.parent.ref}. Put its parent creation earlier in the batch or use an approved existing container.`;
      if (!stageRefs.has(action.ref)) {
        if (!reservations || stage.propertyEdit || otherStageRefs.has(action.ref) ||
            new Set([target.ref, ...stageRefs, action.ref]).size > INSPECT_NODES_LIMITS.refs)
          return `edit_plan_invalid: Creation ref ${action.ref} cannot be reserved in this stage. Use a declared unused alias or reduce the stage's new layers.`;
        stageRefs.add(action.ref);
        additions.push(action.ref);
      }
      created.add(action.ref);
      if (action.tool !== "create_frame") nonContainerRefs.add(action.ref);
      continue;
    }
    if (action.tool === "set_properties" || action.tool === "set_auto_layout") {
      if (!inScope(action.ref) || !stageRefs.has(action.ref))
        return `native_execution_blocked: Ref ${action.ref} is outside the approved scope or absent from this stage. Use a verified planned ref or a reserved creation alias.`;
      if (action.tool === "set_auto_layout" && action.children.some((child) => !inScope(child.ref) || !stageRefs.has(child.ref)))
        return "native_execution_blocked: Auto Layout child sizing must use verified or task-created refs listed in the saved stage.";
      continue;
    }
    if (action.tool === "append_child") {
      if (!inScope(action.childRef) || !stageRefs.has(action.childRef) || !inScope(action.parentRef))
        return "native_execution_blocked: append_child may only connect planned refs inside the verified target subtree.";
      continue;
    }
    if (action.tool === "reparent_node") {
      if (action.ref === target.ref || !inScope(action.ref) || !stageRefs.has(action.ref) || !inScope(action.parentRef))
        return "native_execution_blocked: reparenting must stay within the verified target subtree and cannot move its root.";
    }
  }
  reservations?.push(...additions);
  return undefined;
}

function editCompletionReport(task: ChatTask): string | undefined {
  const target = task.editTarget;
  if (!target) return undefined;
  const confirmed = task.ledger.filter((entry) =>
    entry.status === "completed" && !entry.reused &&
    isCanvasMutationTool(entry.call.action.tool) &&
    entry.acknowledgementStatus === "confirmed_mutation",
  );
  if (!confirmed.length) return undefined;
  const changes = confirmed.slice(0, 24).map(({ call }) => {
    const action = call.action;
    if (action.tool === "set_properties") {
      const values = Object.entries(action.properties)
        .filter(([key]) => key !== "shadow")
        .map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(", ");
      return `Verified ${action.ref}: ${values || Object.keys(action.properties).join(", ")}.`;
    }
    if (action.tool === "set_auto_layout")
      return `Set ${action.layout.direction} Auto Layout on ${action.ref}.`;
    if (action.tool === "create_frame" || action.tool === "create_text" || action.tool === "create_rectangle")
      return `Added ${action.tool.replace("create_", "")} “${action.name}” inside ${action.parent.kind === "node" ? action.parent.ref : "the page"}.`;
    if (action.tool === "append_child") return `Appended ${action.childRef} to ${action.parentRef}.`;
    if (action.tool === "reparent_node") return `Moved ${action.ref} inside ${action.parentRef}.`;
    return `Applied ${action.tool}.`;
  });
  const lines = [
    `Completed the edit of “${target.name}” on ${target.pageName ?? target.pageId}.`,
    `Existing root reference ${target.ref} was preserved and included in native verification.`,
    "Verified native changes:",
    ...changes.map((change) => `- ${change}`),
    `Confirmed canvas mutations: ${confirmed.length}. No page-root replacement was created.`,
  ];
  return lines.join("\n").slice(0, 8_000);
}

type NativePropertyCheck = {
  ref: string;
  property: string;
  expected: unknown;
  actual: unknown;
};

function nativePropertyChecks(
  task: ChatTask,
  stageIndex: number,
  nodes: Parameters<typeof auditNativeSection>[0],
  knownRef: (ref: string) => string,
  planned?: Extract<FigmaToolAction, { tool: "set_properties" }>,
): NativePropertyCheck[] {
  const byRef = new Map<string, (typeof nodes)[number]>();
  const visit = (node: (typeof nodes)[number]) => {
    if (node.ref) byRef.set(node.ref, node);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  const checks: NativePropertyCheck[] = [];
  const actions = planned ? [planned] : task.ledger.flatMap((entry) => {
    const action = entry.call.action;
    return entry.stage === stageIndex && entry.status === "completed" && !entry.reused &&
      entry.acknowledgementStatus === "confirmed_mutation" && action.tool === "set_properties"
      ? [action] : [];
  });
  for (const action of actions) {
    const ref = knownRef(action.ref);
    const node = byRef.get(ref);
    const expectedProperties = action.properties;
    const evidenceFields: Partial<Record<keyof typeof expectedProperties, keyof (typeof nodes)[number]>> = {
      name: "name",
      fill: "fill",
      paintStyleId: "fillStyleId",
      visible: "visible",
      width: "width",
      height: "height",
      text: "text",
      fontSize: "fontSize",
      color: "textColor",
      textStyleId: "textStyleId",
      fontFamily: "fontFamily",
      fontStyle: "fontStyle",
      align: "textAlignHorizontal",
      lineHeight: "lineHeight",
      letterSpacing: "letterSpacing",
      textAutoResize: "textAutoResize",
      stroke: "stroke",
      strokeWeight: "strokeWeight",
      cornerRadius: "cornerRadius",
      opacity: "opacity",
      shadow: "shadow",
    };
    for (const [property, expected] of Object.entries(expectedProperties)) {
      if (expected === undefined) continue;
      const evidenceField = evidenceFields[property as keyof typeof expectedProperties];
      const actual = node && evidenceField ? node[evidenceField] : undefined;
      const normalizedExpected =
        typeof expected === "string" && ["fill", "color", "stroke"].includes(property)
          ? expected.toLocaleUpperCase("en-US")
          : expected;
      const normalizedActual =
        typeof actual === "string" && ["fill", "textColor", "stroke"].includes(evidenceField ?? "")
          ? actual.toLocaleUpperCase("en-US")
          : actual;
      checks.push({
        ref,
        property,
        expected: normalizedExpected,
        actual: normalizedActual,
      });
    }
  }
  return checks;
}

function nativePropertyMismatches(checks: NativePropertyCheck[]): NativePropertyCheck[] {
  const equalValue = (expected: unknown, actual: unknown): boolean => {
    if (typeof expected === "number" && typeof actual === "number")
      return Math.abs(expected - actual) <= 0.01;
    if (
      expected && actual &&
      typeof expected === "object" && typeof actual === "object" &&
      !Array.isArray(expected) && !Array.isArray(actual)
    ) {
      const expectedEntries = Object.entries(expected);
      return expectedEntries.length === Object.keys(actual).length &&
        expectedEntries.every(([key, value]) => equalValue(value, (actual as Record<string, unknown>)[key]));
    }
    return actual !== undefined && actual === expected;
  };
  return checks.filter(({ expected, actual }) => {
    return !equalValue(expected, actual);
  });
}

function compactReadOnlyEvidence(checkpoint: ReadOnlyCheckpoint) {
  const discoveryFields = [
    "pagesVisited",
    "pagesAvailable",
    "scope",
    "pagesRemaining",
    "pagesLoaded",
    "nodesVisited",
    "nodesVisitedTotal",
    "inspectionNodesVisited",
    "framesDiscovered",
    "framesInspected",
    "framesReturned",
    "nativeInspection",
    "truncated",
    "complete",
    "continuationAvailable",
    "truncationReason",
    "inaccessiblePages",
    "inaccessiblePageSamples",
    "sliceCount",
    "nodesPerSliceBudget",
    "pagesPerCheckpoint",
    "pagesPerYield",
    "maxNodesPerSliceObserved",
    "targetSliceMs",
    "hardSliceMs",
    "averageSliceMs",
    "maxSliceMs",
    "pageLoadMs",
    "scanElapsedMs",
    "loadedPageCacheEntries",
    "trackedPageListeners",
    "globalInvalidationFallback",
    "discoveryCacheEntries",
    "discoveryCacheBytes",
    "matchStatus",
    "matchCount",
    "offset",
    "returnedFrameCount",
    "nextOffset",
    "cacheHit",
    "cacheLookups",
    "cacheHits",
    "cacheHitRate",
    "resumedCursors",
    "revalidatedAfterRestart",
  ];
  const frameFields = [
    "ref",
    "pageId",
    "pageName",
    "name",
    "type",
    "x",
    "y",
    "width",
    "height",
    "editable",
    "verified",
    "inspectionAttempted",
    "nativeInspected",
    "nativeInspection",
  ];
  return {
    discoveries: checkpoint.discoveries.map(({ query, offset, pageId, discovery }) => ({
      ...(query ? { query } : {}),
      offset,
      ...(pageId ? { pageId } : {}),
      discovery: Object.fromEntries(
        discoveryFields
          .filter((field) => discovery[field] !== undefined)
          .map((field) => [field, discovery[field]]),
      ),
    })),
    pages: checkpoint.pages.map(({ id, name, current }) => ({ id, name, current })),
    frames: checkpoint.frames.map((frame) =>
      Object.fromEntries(
        frameFields
          .filter((field) => frame[field] !== undefined)
          .map((field) => [field, frame[field]]),
      ),
    ),
    pendingOffsets: checkpoint.pendingOffsets,
    uninspectedRefs: checkpoint.uninspectedRefs.slice(0, 60),
    repeatedOperations: checkpoint.repeatedOperations,
  };
}

// Only complete call/output pairs survive compaction; the durable ledger is the source of truth.
export function chatTaskInput(task: ChatTask): ChatInputItem[] {
  syncCapacityAccounting(task);
  const capacity = chatTaskCapacityUsage(task);
  const confirmed = task.ledger
    .filter((entry) => entry.status === "completed" || entry.status === "failed")
    .map(({ call, operationId, status, stage, output, acknowledgementStatus }) => {
      const action = call.action;
      return {
        operationId,
        status,
        stage,
        ...(acknowledgementStatus ? { acknowledgementStatus } : {}),
        tool: action.tool,
        ...(output ? { logicalRef: JSON.parse(output).logicalRef } : {}),
        ...("ref" in action ? { ref: action.ref } : {}),
        ...("name" in action ? { name: action.name } : {}),
        ...(status === "failed" ? { error: JSON.parse(output ?? "{}").error } : {}),
      };
    });
  let editNativeEvidence: unknown = [];
  if (task.editTarget) {
    try {
      editNativeEvidence = JSON.parse(task.editTarget.nativeEvidence);
    } catch {
      editNativeEvidence = [];
    }
  }
  const state = JSON.stringify({
    taskId: task.id,
    ...(task.chatId ? { chatId: task.chatId } : {}),
    ...(task.intent ? { intent: task.intent } : {}),
    ...(task.targetName ? { targetName: task.targetName } : {}),
    ...(task.editTarget
      ? {
          editTarget: {
            query: task.editTarget.query,
            ref: task.editTarget.ref,
            pageId: task.editTarget.pageId,
            type: task.editTarget.type,
            name: task.editTarget.name,
            x: task.editTarget.x,
            y: task.editTarget.y,
            width: task.editTarget.width,
            height: task.editTarget.height,
            verifiedRefs: task.editTarget.verifiedRefs,
            inspectionVerified: true,
            nativeEvidence: editNativeEvidence,
            ...(task.editTarget.plannedRefs ? { plannedRefs: task.editTarget.plannedRefs } : {}),
          },
        }
      : {}),
    ...(task.designName ? { designName: task.designName } : {}),
    ...(["inspect", "explain"].includes(task.intent ?? "")
      ? { readOnlyInspection: compactReadOnlyEvidence(readOnlyCheckpoint(task)) } : {}),
    brief: task.brief,
    planVersion: CHAT_PLAN_VERSION,
    stages: modelPlanStages(task.stages),
    execution: {
      completedStageIndexes: task.stages.flatMap((stage, index) =>
        stage.completed ? [index] : [],
      ),
      activeStageIndex: task.stages.findIndex((stage) => !stage.completed),
      mutationCapacity: capacity.mutationCapacity,
      mutationUsage: capacity.mutations,
      readOnlyOperations: capacity.readOnlyOperations,
      verificationOperations: capacity.verificationOperations,
      activeSegment:
        task.stages
          .find((stage) => !stage.completed)
          ?.segments.find(({ status }) => status === "active")?.index ?? null,
      mutationCapacityPerSegment: CHAT_EXECUTION_SEGMENT_MAX_MUTATIONS,
    },
    confirmed: ["inspect", "explain"].includes(task.intent ?? "") ? [] : confirmed,
    referencePolicy:
      "Intent is checkpointed: inspect/explain are read-only; create/edit/continue require a saved plan and native verification. New designs use fresh task-local refs. Edit/continue require document discovery plus successful native inspection and must not create a new page-root layer. For edits use the exact logicalRef and pageId returned by successful inspection; never guess refs, page IDs, or native node IDs. Repeated confirmed creation reuses its node without re-styling it.",
  });
  const summaries: ChatInputItem[] = [];
  for (let index = 0; index < state.length; index += 7_500)
    summaries.push({
      role: "assistant",
      content: `Confirmed task checkpoint (${index / 7_500 + 1}): ${state.slice(index, index + 7_500)}`,
    });
  let input: ChatInputItem[] = [
    ...task.context,
    { role: "user", content: task.prompt },
    ...summaries,
    ...(task.validationFeedback
      ? [{ role: "user" as const, content: task.validationFeedback }]
      : []),
    ...task.recent,
  ];
  if (utf8Bytes(JSON.stringify(input)) > 56 * 1024) {
    const calls = task.recent.filter((item) => "type" in item && item.type === "function_call");
    const outputs = task.recent.filter(
      (item) => "type" in item && item.type === "function_call_output",
    );
    if (
      calls.length &&
      calls.every((call) => outputs.some((item) => item.call_id === call.call_id))
    ) {
      const results = JSON.stringify(outputs);
      const compact: ChatInputItem[] = [];
      for (let index = 0; index < results.length; index += 7_500)
        compact.push({
          role: "assistant",
          content: `Confirmed tool results: ${results.slice(index, index + 7_500)}`,
        });
      input = [
        ...task.context,
        { role: "user", content: task.prompt },
        ...summaries,
        ...(task.validationFeedback
          ? [{ role: "user" as const, content: task.validationFeedback }]
          : []),
        ...compact,
      ];
    }
  }
  if (input.length > 40 || utf8Bytes(JSON.stringify(input)) > 56 * 1024)
    throw new Error(
      "Task context reached its bounded capacity. Committed work is saved; inspect the canvas before continuing in a new chat.",
    );
  return input;
}

type SafeQualityFinding = {
  code: NativeVisualFinding["code"];
  refs: string[];
  expected: string;
  actual: string;
};

function safeQualityFindings(
  findings: ReturnType<typeof auditNativeSection>,
): SafeQualityFinding[] {
  const safe = findings.map((finding) => ({
    code: finding.code,
    refs: [...(finding.refs ?? (finding.ref ? [finding.ref] : []))].sort(),
    expected: finding.expected.slice(0, 300),
    actual: finding.actual.slice(0, 1_000),
  }));
  return [...new Map(safe.map((finding) => [JSON.stringify(finding), finding])).values()].slice(
    0,
    24,
  );
}

function qualityFindingKey(finding: SafeQualityFinding): string {
  return `${finding.code}:${[...finding.refs].sort().join(",")}`;
}

function qualityFailureSignature(findings: SafeQualityFinding[]): string {
  return findings
    .map((finding) => {
      let measurement = finding.actual;
      try {
        const actual = JSON.parse(finding.actual);
        if (finding.code === "clipped-child")
          measurement = `${actual.parentRef ?? ""}:${Math.round(actual.overflow * 1_000) / 1_000}`;
        if (finding.code === "overlapping-auto-layout") measurement = String(actual.overlapArea);
      } catch {
        /* Non-geometric findings use their measured text. */
      }
      return `${qualityFindingKey(finding)}:${measurement}`;
    })
    .sort()
    .join("|");
}

function qualityMeasurementImproved(
  before: SafeQualityFinding,
  after: SafeQualityFinding,
): boolean {
  if (before.code === "low-contrast") {
    const priorRatio = Number.parseFloat(before.actual);
    const nextRatio = Number.parseFloat(after.actual);
    return Number.isFinite(priorRatio) && Number.isFinite(nextRatio) && nextRatio > priorRatio;
  }
  if (before.code === "clipped-child") {
    try {
      const priorOverflow = JSON.parse(before.actual).overflow;
      const nextOverflow = JSON.parse(after.actual).overflow;
      return (
        Number.isFinite(priorOverflow) &&
        Number.isFinite(nextOverflow) &&
        nextOverflow < priorOverflow
      );
    } catch {
      return false;
    }
  }
  if (before.code === "overlapping-auto-layout") {
    try {
      const priorArea = JSON.parse(before.actual).overlapArea;
      const nextArea = JSON.parse(after.actual).overlapArea;
      return Number.isFinite(priorArea) && Number.isFinite(nextArea) && nextArea < priorArea;
    } catch {
      return false;
    }
  }
  return false;
}

function hasQualityProgress(before: SafeQualityFinding[], after: SafeQualityFinding[]): boolean {
  const overflow = (findings: SafeQualityFinding[]) =>
    findings.reduce((total, finding) => {
      if (finding.code !== "clipped-child") return total;
      try {
        return total + (Number(JSON.parse(finding.actual).overflow) || 0);
      } catch {
        return total;
      }
    }, 0);
  if (overflow(after) > overflow(before) + 0.001) return false;
  const beforeKeys = new Set(before.map(qualityFindingKey));
  if (
    after.some(
      (finding) => finding.code === "clipped-child" && !beforeKeys.has(qualityFindingKey(finding)),
    )
  )
    return false;
  const afterByKey = new Map(after.map((finding) => [qualityFindingKey(finding), finding]));
  return before.some((finding) => {
    const next = afterByKey.get(qualityFindingKey(finding));
    return !next || qualityMeasurementImproved(finding, next);
  });
}

export async function runChatTask(task: ChatTask, deps: Dependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? waitForChatCapacity;
  const knownRef = (ref: string): string => {
    const entry = task.ledger.find(
      (item) =>
        item.status === "completed" &&
        "ref" in item.call.action &&
        item.call.action.ref === ref &&
        item.output,
    );
    const logicalRef: unknown = entry?.output ? JSON.parse(entry.output).logicalRef : undefined;
    return typeof logicalRef === "string" ? logicalRef : ref;
  };
  const check = () => {
    if (deps.signal.aborted) throw new Error("Stopped");
  };
  const transition = (lifecycle: ChatLifecycleState) => {
    if (task.lifecycle === lifecycle) return;
    task.lifecycle = lifecycle;
    task.lifecycleTransitions++;
  };
  const guardRepeatedFailure = (signature: string) => {
    signature = signature.slice(0, 2_000);
    const progress =
      chatTaskCommittedOperationCount(task) + task.stages.filter((stage) => stage.completed).length;
    if (task.lastFailureSignature === signature && task.lastFailureProgress === progress)
      throw new Error(
        `no_progress_repeated_error: ${signature.slice(0, 260)}. The same failure repeated without a new canvas commit or completed stage. Inspect the safe diagnostic; automatic correction stopped.`,
      );
    task.lastFailureSignature = signature;
    task.lastFailureProgress = progress;
  };
  const save = async () => {
    syncCapacityAccounting(task);
    if (utf8Bytes(JSON.stringify(task)) > CHAT_TASK_MAX_BYTES)
      throw new Error(
        "Task checkpoint reached its 512 KiB safety budget. Canvas changes are retained; no further batch was started.",
      );
    const parsed = ChatTaskSchema.safeParse(task);
    if (!parsed.success)
      throw new Error(
        "Task checkpoint reached its safety budget or contains invalid state. Canvas changes are retained; no further batch was started.",
      );
    await deps.save(parsed.data);
  };
  const stopEdit = async (
    code: string,
    reason: string,
    phase: ChatTaskFailurePhase = "planning",
  ) => {
    task.pending = [];
    task.recent = [];
    task.status = "failed";
    task.error = reason.slice(0, 500);
    task.text = reason.slice(0, 8_000);
    task.failure = {
      category: "planning",
      phase,
      code,
      committedOperations: chatTaskCommittedOperationCount(task),
    };
    await save();
  };
  const palette = () =>
    Object.values(task.brief?.palette ?? {}).filter(
      (value): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value),
    );
  const recordRepairPlan = (stageIndex: number, proposals: NativeRepairDecision[]) => {
    const allowed = chatFunctionToolsForState("VERIFYING_STAGE").map(({ name }) => name);
    task.stages[stageIndex]!.nativeRepairPlan = proposals.map((decision) => {
      const action = decision.action;
      if (!action)
        return {
          ...decision,
          toolAllowedInVerifyingStage:
            decision.code === "clipped-child"
              ? allowed.includes("set_auto_layout")
              : decision.code === "low-contrast"
                ? allowed.includes("set_properties")
                : false,
          dispatchGate: "eligibility",
        };
      const toolAllowedInVerifyingStage = allowed.some((name) => name === action.tool);
      let prior = task.ledger.find(
        (entry) =>
          entry.stage === stageIndex &&
          entry.qualityRepairAttempted &&
          entry.status === "completed" &&
          JSON.stringify(entry.call.action) === JSON.stringify(action),
      );
      if (prior) {
        const verified = task.stages[stageIndex]!.verificationHistory.find((verification) =>
          verification.repairOperationIds?.includes(prior!.operationId),
        );
        if (
          verified &&
          !verified.findings.some((finding) => qualityFindingKey(finding) === decision.findingKey)
        )
          prior = undefined;
      }
      let reason = decision.reason;
      if (prior) {
        reason = "native_strategy_no_progress";
        try {
          const reports = JSON.parse(prior.output ?? "{}").data?.overflowRepair;
          const blocked =
            Array.isArray(reports) &&
            reports.find((report) => report.strategy === "unsupported-preserve-layout");
          if (
            blocked &&
            typeof blocked.stopReason === "string" &&
            /^[a-z-]+$/u.test(blocked.stopReason)
          )
            reason = blocked.stopReason.replaceAll("-", "_");
        } catch {
          /* Invalid native reports are not dispatch instructions. */
        }
      }
      return {
        ...decision,
        toolAllowedInVerifyingStage,
        ...(prior
          ? {
              eligible: false,
              reason,
              operationId: prior.operationId,
              dispatchGate: "strategy_already_verified",
            }
          : !toolAllowedInVerifyingStage
            ? {
                eligible: false,
                reason: "verification_tool_not_allowed",
                dispatchGate: "tool_permission",
              }
            : {}),
      };
    });
  };
  const readVerification = (
    stageIndex: number,
    data: Record<string, unknown> | undefined,
    nodes: Parameters<typeof auditNativeSection>[0],
    refs: string[],
  ) => {
    const native = NativeVerificationResultSchema.safeParse(data);
    if (data && "qualityFindings" in data && !native.success)
      throw new Error(
        "native_verification_invalid: Native structural verification returned invalid or incomplete coverage; no repair was scheduled.",
      );
    if (native.success && !native.data.qualityCoverage.complete) {
      task.stages[stageIndex]!.nativeQualityCoverage = native.data.qualityCoverage;
      task.stages[stageIndex]!.nativeRepairPipelineVersion = native.data.repairPipelineVersion;
      throw new Error(
        `native_verification_capacity_exceeded: Native QA inspected ${native.data.qualityCoverage.nodeCount} nodes but reached its bounded scan limit; no completion or repair was allowed. Reduce the target scope and resume after fresh inspection.`,
      );
    }
    task.stages[stageIndex]!.nativeQualityCoverage = native.success
      ? native.data.qualityCoverage
      : undefined;
    task.stages[stageIndex]!.nativeRepairPipelineVersion = native.success
      ? native.data.repairPipelineVersion
      : undefined;
    const findings: NativeVisualFinding[] = native.success
      ? native.data.qualityFindings.map((finding) => ({
          ...finding,
          message: "Measured native structural finding.",
        }))
      : auditNativeSection(nodes, refs);
    const proposals = native.success
      ? native.data.nativeRepairPlan
      : planNativeQualityRepairs(nodes, findings, palette(), Boolean(task.referenceScope));
    for (const proposal of proposals) {
      const finding = findings.find(
        (item) =>
          item.code === proposal.code &&
          JSON.stringify([...(item.refs ?? (item.ref ? [item.ref] : []))].sort()) ===
            JSON.stringify([...proposal.refs].sort()),
      );
      let valid = Boolean(finding);
      if (proposal.action?.tool === "set_properties")
        valid =
          valid && proposal.code === "low-contrast" && proposal.action.ref === proposal.refs[0];
      if (proposal.action?.tool === "set_auto_layout") {
        try {
          valid =
            valid &&
            proposal.code === "clipped-child" &&
            proposal.action.ref === JSON.parse(finding!.actual).parentRef;
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        proposal.eligible = false;
        proposal.reason = "repair_target_not_verified";
        proposal.dispatchGate = "finding_identity";
      }
    }
    recordRepairPlan(stageIndex, proposals);
    return findings;
  };
  const executePlannedPropertyStage = async (): Promise<"advance" | "complete" | undefined> => {
    if (task.intent !== "edit" || task.pending.length) return;
    const stageIndex = task.stages.findIndex((item) => !item.completed);
    const stage = task.stages[stageIndex];
    const target = task.editTarget;
    if (!stage) return;

    // Older checkpoints have no executable action. Recognize the exact legacy
    // verification-only contract without treating prose as write authorization.
    const legacyFill = /^Confirm native root fill exactly equals (#[0-9a-f]{6}) without mutations\.$/iu
      .exec(stage.goal)?.[1];
    const verificationOnly = !stage.propertyEdit && Boolean(
      legacyFill && stage.completionCriteria.length === 1 &&
      stage.completionCriteria[0] === `Native fill of existing root frame is ${legacyFill}; no mutation performed.`,
    );
    const planned = stage.propertyEdit ?? (verificationOnly && target && legacyFill
      ? { tool: "set_properties" as const, ref: target.ref, properties: { fill: legacyFill } }
      : undefined);
    if (!planned) return;
    activePhase = "verification";
    if (!target || (stage.pageId ?? target.pageId) !== target.pageId ||
      (planned.pageId ?? target.pageId) !== target.pageId ||
      !target.plannedRefs?.includes(planned.ref) ||
      !stage.logicalRefs.includes(planned.ref) ||
      stage.logicalRefs.some((ref) => !target.plannedRefs?.includes(ref) || !target.verifiedRefs.includes(ref)))
      throw new Error("invalid_required_reference: Property stage is outside the inspected edit plan.");

    const visual = planned.properties.fill !== undefined && target.type === "FRAME" && planned.ref === target.ref;
    let action = { ...planned, pageId: target.pageId };
    const mutations = task.ledger.filter((entry) =>
      entry.stage === stageIndex && isCanvasMutationTool(entry.call.action.tool) && !entry.reused);
    const matches = (entry: ChatTask["ledger"][number]) => {
      const prior = entry.call.action;
      return prior.tool === "set_properties" && knownRef(prior.ref) === knownRef(action.ref) &&
        JSON.stringify(Object.entries(prior.properties).sort()) ===
          JSON.stringify(Object.entries(action.properties).sort());
    };
    const capacity = chatTaskCapacityUsage(task);
    if (capacity.verificationOperations >= CHAT_TASK_MAX_VERIFICATION_OPERATIONS ||
        task.ledger.length >= CHAT_TASK_MAX_LEDGER_ENTRIES || task.batches >= 1_000)
      throw new Error("native_verification_invalid: Property verification capacity exhausted.");

    const refs = [...new Set([target.ref, ...stage.logicalRefs])];
    const id = `${task.id}-property-check-${task.ledger.length + 1}`;
    const call = parseResponsesFunctionCalls([{
      type: "function_call", call_id: id, name: "inspect_nodes",
      arguments: JSON.stringify({ pageId: target.pageId, refs, selection: false,
        depth: 1, maxNodes: 25, purpose: visual ? "background_verification" : "structural_verification" }),
    }])[0]!;
    const entry: ChatTask["ledger"][number] = {
      call, operationId: id, stage: stageIndex, status: "running", category: "verification",
    };
    check();
    transition("VERIFYING_STAGE");
    task.ledger.push(entry);
    task.batches++;
    await save();
    deps.progress(`Checking native property values for ${stage.title}…`);
    const result = await deps.execute([FigmaToolOperationSchema.parse({
      operationId: id, idempotencyKey: `chat:${id}`,
      ...(task.referenceScope ? { taskId: task.id } : {}),
      ...(task.chatId ? { chatId: task.chatId } : {}),
      action: call.action,
    })]);
    check();
    const item = result.results.length === 1 ? result.results[0] : undefined;
    const nodes = NativeVisualNodeSchema.array().max(25).safeParse(item?.data?.nodes);
    if (!result.success || !item?.success || item.operationId !== id ||
        item.data?.pageId !== target.pageId || !nodes.success ||
        refs.some((ref) => !nodes.data.some((node) => node.ref && knownRef(node.ref) === knownRef(ref)))) {
      entry.status = "failed";
      entry.output = JSON.stringify({ success: false, error: item?.error });
      await save();
      throw new Error(`missing_reference_inspection: ${item?.error ?? "Native evidence did not resolve all property stage refs on the approved page."}`);
    }
    let backgroundNodeId: string | undefined;
    if (visual) {
      const proof = item.data?.visualBackground as Record<string, unknown> | undefined;
      const node = nodes.data.find((candidate) => candidate.ref === proof?.ref);
      if (!proof || proof.rootNodeId !== target.nodeId || proof.rootRef !== knownRef(target.ref) ||
          typeof proof.nodeId !== "string" || !node?.ref || !node.fill || proof.fill !== node.fill ||
          (node.ref !== knownRef(target.ref) && node.type !== "RECTANGLE") ||
          (node.ref !== knownRef(target.ref) && Object.keys(planned.properties).length !== 1)) {
        entry.status = "failed";
        entry.output = JSON.stringify({ success: false, visualOutcomeVerified: false });
        await save();
        throw new Error("native_property_verification_failed: The visible background could not be verified on the approved frame.");
      }
      backgroundNodeId = proof.nodeId;
      action = { ...action, ref: node.ref, backgroundRootRef: target.ref };
    }
    if (mutations.some((entry) => !matches(entry) || entry.status !== "completed" ||
        entry.acknowledgementStatus !== "confirmed_mutation"))
      throw new Error("native_verification_invalid: Saved mutations require reconciliation before this property stage can continue.");
    const checks = nativePropertyChecks(task, stageIndex, nodes.data, knownRef, action);
    const differences = nativePropertyMismatches(checks);
    entry.status = "completed";
    entry.acknowledgementStatus = "read_only";
    entry.output = JSON.stringify({
      success: true, propertyVerificationConfirmed: !differences.length,
      verifiedNoOp: !mutations.length && !differences.length,
      ...(visual ? { visualOutcomeVerified: !differences.length, backgroundNodeId } : {}),
      checks: checks.map(({ ref, property, actual }) => ({
        ref, property, available: actual !== undefined,
        ...(property === "fill" ? { actual } : {}),
      })),
    });
    if (differences.length) {
      await save();
      if (verificationOnly || mutations.length || differences.some((item) => item.actual === undefined))
        throw new Error(`native_property_verification_failed: ${differences.map(({ property, actual }) =>
          `${property} ${actual === undefined ? "unavailable" : "differs"}`).join(", ")} on ${action.ref}.`);
      if (visual && action.ref !== target.ref) {
        if (target.verifiedRefs.length >= 25 && !target.verifiedRefs.includes(action.ref) ||
            (target.plannedRefs?.length ?? 0) >= 20 && !target.plannedRefs?.includes(action.ref) ||
            stage.logicalRefs.length >= 20 && !stage.logicalRefs.includes(action.ref))
          throw new Error("invalid_required_reference: No room to checkpoint the verified background ref.");
        target.verifiedRefs = [...new Set([...target.verifiedRefs, action.ref])];
        target.plannedRefs = [...new Set([...(target.plannedRefs ?? []), action.ref])];
        stage.logicalRefs = [...new Set([...stage.logicalRefs, action.ref])];
      }
      const { tool, ...args } = action;
      const blocker = editMutationBlocker(task, [{ action }]);
      if (blocker) throw new Error(blocker);
      const setter = parseResponsesFunctionCalls([{
        type: "function_call", call_id: `${id}-write`, name: tool, arguments: JSON.stringify(args),
      }])[0]!;
      task.pending = [setter];
      transition("EXECUTING_STAGE");
      await save();
      return "advance";
    }

    stage.verified = true;
    stage.completed = true;
    stage.completionReason = mutations.length ? "required_refs_and_native_verification_confirmed" : "verified_no_op";
    transition("STAGE_COMPLETED");
    if (task.stages.every((item) => item.completed)) {
      task.status = "completed";
      task.text = task.stages.map((item) =>
        `${item.title}: ${item.completionReason === "verified_no_op" ? "Verified no-op" : visual ? "Verified visible background edit" : "Verified native edit"}.`).join("\n") +
        `\nConfirmed canvas mutations: ${chatTaskCommittedOperationCount(task)}.`;
      task.recent = [];
      delete task.failure;
      transition("TASK_COMPLETED");
      await save();
      return "complete";
    }
    await save();
    return "advance";
  };

  const reconcileSavedEditOnResume = async (): Promise<void> => {
    if (task.intent !== "edit") return;
    activePhase = "verification";
    const stageIndex = task.stages.findIndex((stage) => !stage.completed);
    const stage = task.stages[stageIndex];
    const target = task.editTarget;
    if (!stage || !target || stage.propertyEdit) return;
    const confirmedMutations = task.ledger.filter(
      (entry) =>
        entry.stage === stageIndex &&
        entry.status === "completed" &&
        !entry.reused &&
        entry.acknowledgementStatus === "confirmed_mutation" &&
        isCanvasMutationTool(entry.call.action.tool),
    );
    if (!confirmedMutations.length) return;

    const verifiedTargetRefs = new Set(target.verifiedRefs.map(knownRef));
    const plannedTargetRefs = new Set((target.plannedRefs ?? []).map(knownRef));
    const invalidExistingRefs = stage.logicalRefs.filter(
      (ref) => verifiedTargetRefs.has(knownRef(ref)) && !plannedTargetRefs.has(knownRef(ref)),
    );
    if (invalidExistingRefs.length) {
      stage.completionReason = "invalid_required_reference";
      throw new Error(
        `invalid_required_reference: Saved edit stage references verified native nodes outside its approved target set: ${invalidExistingRefs.join(", ")}. The confirmed mutation is retained.`,
      );
    }
    const satisfied = chatTaskStageSatisfiedRefs(task, stageIndex);
    const missingCreations = stage.logicalRefs.filter(
      (ref) =>
        !satisfied.has(ref) &&
        !(plannedTargetRefs.has(knownRef(ref)) && !verifiedTargetRefs.has(knownRef(ref))),
    );
    if (missingCreations.length) return;

    const refs = [
      ...new Set([
        target.ref,
        ...stage.logicalRefs,
        ...confirmedMutations.flatMap((entry) =>
          entry.call.action.tool === "set_properties" ? [entry.call.action.ref] : [],
        ),
      ]),
    ];
    if (!refs.length || refs.length > INSPECT_NODES_LIMITS.refs)
      throw new Error(
        "invalid_required_reference: Saved edit refs exceed the bounded native resume-verification limit. No mutation was replayed.",
      );
    const capacity = chatTaskCapacityUsage(task);
    if (
      capacity.verificationOperations >= CHAT_TASK_MAX_VERIFICATION_OPERATIONS ||
      task.ledger.length >= CHAT_TASK_MAX_LEDGER_ENTRIES
    )
      throw new Error(
        "native_verification_invalid: No bounded verification capacity is available to reconcile the saved edit. The confirmed mutation is retained.",
      );
    const verificationNumber = stage.verificationOperations + 1;
    const call = parseResponsesFunctionCalls([
      {
        type: "function_call",
        call_id: `${task.id}_resume_verify_${stageIndex + 1}_${verificationNumber}`,
        name: "inspect_nodes",
        arguments: JSON.stringify({
          pageId: target.pageId,
          refs,
          selection: false,
          depth: 4,
          maxNodes: 25,
          purpose: "structural_verification",
          palette: palette(),
        }),
      },
    ])[0]!;
    const entry: ChatTask["ledger"][number] = {
      call,
      operationId: `${task.id}-resume-qa-${stageIndex + 1}-${verificationNumber}`,
      stage: stageIndex,
      status: "pending",
      category: "verification",
    };
    task.ledger.push(entry);
    stage.qaAttempts = Math.min(3, stage.qaAttempts + 1);
    const operation = FigmaToolOperationSchema.parse({
      operationId: entry.operationId,
      idempotencyKey: `chat:${entry.operationId}`,
      taskId: task.id,
      ...(task.chatId ? { chatId: task.chatId } : {}),
      ...(task.designName ? { designName: task.designName } : {}),
      action: call.action,
    });
    check();
    entry.status = "running";
    task.starts = task.starts.filter((started) => started > now() - 60_100);
    task.starts.push(now());
    task.batches++;
    activePhase = "verification";
    await save();
    deps.progress(`Reconciling the saved ${stage.title} against current native Figma values…`);
    const result = await deps.execute([operation]);
    const native =
      result.results.length === 1 && result.results[0]!.operationId === entry.operationId
        ? result.results[0]
        : undefined;
    if (!result.success || !native?.success) {
      entry.status = "failed";
      entry.acknowledgementStatus = native?.acknowledgementStatus ?? "read_only";
      entry.output = JSON.stringify({
        success: false,
        error: native?.error ?? "Figma did not confirm resume inspection.",
      });
      await save();
      throw new Error(
        native?.error ?? "Figma did not confirm native resume inspection; saved changes were not replayed.",
      );
    }
    const parsedNodes = NativeVisualNodeSchema.array().max(25).safeParse(native.data?.nodes);
    if (!parsedNodes.success) {
      entry.status = "failed";
      entry.acknowledgementStatus = "read_only";
      entry.output = JSON.stringify({ success: false, error: "Invalid native resume evidence." });
      await save();
      throw new Error(
        "native_verification_invalid: Figma returned invalid native resume evidence; the saved mutation was not replayed.",
      );
    }
    const observedRefs = new Set(
      parsedNodes.data.flatMap((node) => (node.ref ? [knownRef(node.ref)] : [])),
    );
    const missingRefs = refs.map(knownRef).filter((ref) => !observedRefs.has(ref));
    if (missingRefs.length) {
      entry.status = "completed";
      entry.acknowledgementStatus = "read_only";
      entry.output = JSON.stringify({ success: false, missingInspectionRefs: missingRefs });
      stage.completionReason = "missing_reference_inspection";
      await save();
      throw new Error(
        `missing_reference_inspection: Resume verification could not find ${missingRefs.join(", ")}; the confirmed mutation was not replayed.`,
      );
    }
    const propertyChecks = nativePropertyChecks(task, stageIndex, parsedNodes.data, knownRef);
    const backgrounds = native.data?.frameBackgrounds as Record<string, unknown> | undefined;
    if (backgrounds && backgrounds[knownRef(target.ref)] !== "root" &&
        propertyChecks.some((item) => item.ref === knownRef(target.ref) && item.property === "fill"))
      throw new Error("native_property_verification_failed: The confirmed frame fill is not established as the visible background.");
    const propertyMismatches = nativePropertyMismatches(propertyChecks);
    const findings = readVerification(
      stageIndex,
      native.data,
      parsedNodes.data,
      refs.map(knownRef),
    );
    entry.status = "completed";
    entry.acknowledgementStatus = "read_only";
    entry.output = JSON.stringify({
      success: propertyMismatches.length === 0 && findings.length === 0,
      inspectedNodes: parsedNodes.data.length,
      findingCount: findings.length,
      verifiedPropertyCount: propertyChecks.length,
      propertyVerificationConfirmed: propertyMismatches.length === 0 && propertyChecks.length > 0,
      ...(propertyMismatches.length
        ? {
            propertyMismatches: propertyMismatches.slice(0, 12).map(({ ref, property, actual }) => ({
              ref,
              property,
              observation: actual === undefined ? "unavailable" : "different",
            })),
          }
        : {}),
    });
    if (propertyMismatches.length) {
      stage.verified = false;
      stage.completionReason = "native_property_verification_failed";
      await save();
      throw new Error(
        `native_property_verification_failed: The saved edit's native value does not match its confirmed operation (${propertyMismatches
          .slice(0, 5)
          .map(({ ref, property }) => `${ref}.${property}`)
          .join(", ")}). The confirmed mutation was not replayed.`,
      );
    }
    const inspectedPlannedRefs = refs
      .map(knownRef)
      .filter((ref) => plannedTargetRefs.has(ref));
    target.verifiedRefs = [...new Set([...target.verifiedRefs, ...inspectedPlannedRefs])].slice(0, 25);
    stage.qualityFindings = safeQualityFindings(findings);
    stage.verificationHistory.push({
      attempt: verificationNumber,
      findings: stage.qualityFindings,
    });
    stage.verified = findings.length === 0;
    stage.awaitingQualityRepair = findings.length > 0;
    stage.completionReason = findings.length
      ? "native_verification_failed"
      : "awaiting_completion_call";
    if (findings.length) {
      task.recent.push({
        role: "user",
        content: `Resume inspection completed. Native structure findings remain: ${findings
          .slice(0, 6)
          .map((finding) => `${finding.code} on ${(finding.refs ?? (finding.ref ? [finding.ref] : [])).join(",")}`)
          .join("; ")}. Do not repeat confirmed mutations.`,
      });
    } else {
      task.recent.push({
        role: "user",
        content: `Resume inspection verified ${propertyChecks.length} native property value(s) for the already-confirmed edit. Do not replay those operations; continue only genuine outstanding work or complete the stage.`,
      });
    }
    task.recent = task.recent.slice(-20);
    syncCapacityAccounting(task);
    await save();
  };
  const failUnavailableRepair = (stageIndex: number): never => {
    const stage = task.stages[stageIndex]!;
    stage.qualityRepairBlocked = true;
    task.failure = {
      category: "verification",
      phase: "verification",
      code: "native_quality_unrepairable",
      committedOperations: chatTaskCommittedOperationCount(task),
    };
    throw new Error(
      `native_quality_unrepairable: ${(stage.nativeRepairPlan ?? []).map((decision) => `${decision.code}/${decision.refs.join(",")}: ${decision.reason} (${decision.dispatchGate ?? "eligibility"})`).join("; ")}. Existing nodes are retained; inspect the repair plan and native before/after measurements.`,
    );
  };
  const inspectAfterQualityRepair = async (
    stageIndex: number,
    resumeBlockedRepair = false,
  ): Promise<void> => {
    const stage = task.stages[stageIndex];
    if (!stage || (!stage.repairVerificationPending && !resumeBlockedRepair)) return;
    transition("VERIFYING_STAGE");
    activePhase = "verification";
    const repairOperationId = stage.pendingRepairOperationId;
    if (stage.repairVerificationPending && !repairOperationId)
      throw new Error("A confirmed repair is missing its checkpointed operation identity.");
    const operationId = repairOperationId
      ? `${task.id}-qa-repair-${stageIndex + 1}-${repairOperationId.split("-op-").at(-1)}`
      : (stage.pendingQualityProbeOperationId ??= `${task.id}-qa-probe-${stageIndex + 1}-${stage.verificationHistory.length + 1}`);
    const callId = operationId.replaceAll("-", "_");
    let entry = task.ledger.find((item) => item.operationId === operationId);
    if (!entry) {
      const refs = (
        stage.logicalRefs.length
          ? stage.logicalRefs
          : task.ledger
              .filter((item) => item.stage === stageIndex && "ref" in item.call.action)
              .map((item) => ("ref" in item.call.action ? item.call.action.ref : ""))
      )
        .map(knownRef)
        .filter(Boolean)
        .slice(0, 20);
      const capacity = chatTaskCapacityUsage(task);
      if (
        !refs.length ||
        capacity.verificationOperations >= CHAT_TASK_MAX_VERIFICATION_OPERATIONS ||
        task.ledger.length >= CHAT_TASK_MAX_LEDGER_ENTRIES
      )
        throw new Error(
          "No bounded verification capacity is available after the confirmed repair; committed work remains.",
        );
      const call = parseResponsesFunctionCalls([
        {
          type: "function_call",
          call_id: callId,
          name: "inspect_nodes",
          arguments: JSON.stringify({
            ...(stage.pageId ? { pageId: stage.pageId } : {}),
            refs,
            selection: false,
            depth: 4,
            maxNodes: 25,
            purpose: "structural_verification",
            palette: palette(),
          }),
        },
      ])[0]!;
      entry = {
        call,
        operationId,
        stage: stageIndex,
        status: "pending",
        category: "verification",
      };
      task.ledger.push(entry);
    }
    const operation = FigmaToolOperationSchema.parse({
      operationId,
      idempotencyKey: `chat:${operationId}`,
      ...(task.referenceScope ? { taskId: task.id } : {}),
      ...(task.chatId ? { chatId: task.chatId } : {}),
      ...(task.designName ? { designName: task.designName } : {}),
      action: entry.call.action,
    });
    let verificationResult: Result | undefined;
    let result: Result["results"][number] | undefined;
    let rateRetries = 0;
    while (true) {
      check();
      task.starts = task.starts.filter((started) => started > now() - 60_100);
      if (task.starts.length >= 36) {
        deps.progress("Waiting for local canvas capacity before post-repair verification…");
        await wait(Math.max(1, task.starts[0]! + 60_100 - now()), deps.signal);
        continue;
      }
      if (task.batches >= 1_000)
        throw new Error("The saved batch limit was reached before post-repair verification.");
      entry.status = "running";
      task.starts.push(now());
      task.batches++;
      await save();
      deps.progress(`Re-reading ${stage.title} after the confirmed repair…`);
      activePhase = "verification";
      verificationResult = await deps.execute([operation]);
      result =
        verificationResult.results.length === 1 &&
        verificationResult.results[0]!.operationId === operationId
          ? verificationResult.results[0]
          : undefined;
      if (
        !verificationResult.success &&
        result &&
        !result.success &&
        /Local tool rate limit reached/u.test(result.error ?? "")
      ) {
        entry.status = "pending";
        entry.acknowledgementStatus = "not_attempted";
        await save();
        if (++rateRetries > 2)
          throw new Error(
            "Local capacity is still busy. Resume after one minute; the confirmed repair remains saved.",
          );
        await wait(60_100, deps.signal);
        continue;
      }
      break;
    }
    if (!verificationResult?.success || !result?.success) {
      entry.status = "failed";
      entry.acknowledgementStatus = result?.acknowledgementStatus ?? "not_attempted";
      entry.output = JSON.stringify({
        success: false,
        error: result?.error ?? "Figma did not confirm post-repair inspection.",
      });
      await save();
      throw new Error(
        result?.error ?? "Figma did not confirm post-repair inspection; the repair remains saved.",
      );
    }
    const parsedNodes = NativeVisualNodeSchema.array().max(25).safeParse(result.data?.nodes);
    if (!parsedNodes.success) {
      entry.status = "failed";
      entry.output = JSON.stringify({
        success: false,
        error: "The post-repair inspection returned invalid geometry data.",
      });
      await save();
      throw new Error(
        "The post-repair inspection returned invalid geometry; committed changes remain.",
      );
    }
    const before = [
      ...new Map(
        stage.qualityFindings.map((finding) => [JSON.stringify(finding), finding]),
      ).values(),
    ];
    const expectedRefs =
      entry.call.action.tool === "inspect_nodes"
        ? entry.call.action.refs.map(knownRef)
        : stage.logicalRefs.map(knownRef);
    const findings = readVerification(stageIndex, result.data, parsedNodes.data, expectedRefs);
    const after = safeQualityFindings(findings);
    const improved = after.length === 0 || hasQualityProgress(before, after);
    const eligibleNativeRepair =
      stage.nativeRepairPlan?.some((decision) => decision.eligible) ?? false;
    const afterKeys = new Set(after.map(qualityFindingKey));
    stage.repairFindingsResolved = Math.min(
      CHAT_TASK_MAX_MUTATIONS,
      (stage.repairFindingsResolved ?? 0) +
        before.filter((finding) => !afterKeys.has(qualityFindingKey(finding))).length,
    );
    entry.status = "completed";
    entry.acknowledgementStatus = "read_only";
    entry.output = JSON.stringify({
      success: true,
      repairVerification: {
        operationId: repairOperationId,
        beforeCount: before.length,
        afterCount: after.length,
        before: before.slice(0, 2),
        after: after.slice(0, 2),
        progressed: improved,
        resolvedFindingCount: before.filter((finding) => !afterKeys.has(qualityFindingKey(finding)))
          .length,
      },
    });
    stage.repairVerificationPending = false;
    delete stage.pendingRepairOperationId;
    stage.qualityFindings = after;
    stage.verified = after.length === 0;
    stage.awaitingQualityRepair = after.length > 0;
    stage.completionReason = after.length
      ? "native_verification_failed"
      : "awaiting_completion_call";
    syncCapacityAccounting(task);
    stage.verificationHistory.push({
      attempt: Math.max(1, stage.verificationOperations),
      findings: after,
      ...(repairOperationId ? { repairOperationIds: [repairOperationId] } : {}),
    });
    if (improved || eligibleNativeRepair) {
      delete task.lastFailureSignature;
      delete task.lastFailureProgress;
      task.recent.push({
        role: "user",
        content: repairOperationId
          ? `Fresh native verification after repair operation ${repairOperationId}. Before: ${JSON.stringify(before)}. After: ${JSON.stringify(after)}. Continue only with unresolved findings; do not repeat a repair whose measured result did not improve.`
          : `Fresh native verification on Resume. Before: ${JSON.stringify(before)}. After: ${JSON.stringify(after)}. Continue only with unresolved findings; do not repeat a repair whose measured result did not improve.`,
      });
      task.recent = task.recent.slice(-20);
    }
    delete stage.pendingQualityProbeOperationId;
    stage.qualityRepairBlocked = !improved && !eligibleNativeRepair;
    await save();
    if (
      !improved &&
      !eligibleNativeRepair &&
      stage.nativeRepairPlan?.some(
        (decision) => decision.code === "clipped-child" || decision.code === "low-contrast",
      )
    )
      failUnavailableRepair(stageIndex);
    if (!improved && !eligibleNativeRepair)
      throw new Error(
        `no_progress_repeated_error: structural_repair_no_progress after ${operationId}; before and after measurements are unchanged or worse. Further model repairs were stopped until a fresh native measurement changes.`,
      );
    transition("EXECUTING_STAGE");
  };
  const output = (callId: string, payload: unknown): ChatInputItem => ({
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(payload),
  });
  let editBatchCorrections = 0;
  const wasRetry =
    task.status === "failed" || task.status === "stopped" || task.status === "running";
  const initialLedgerLength = task.ledger.length;
  const readOnly = () => task.intent === "inspect" || task.intent === "explain";
  let activePhase: ChatTaskFailurePhase = readOnly() ? "inspection" : task.stages.length ? "native_execution" : "planning";
  syncCapacityAccounting(task);
  if (readOnly()) transition("INSPECTING");
  else if (!task.stages.length)
    transition(
      task.intent === "edit"
        ? wasRetry
          ? "EDIT_TARGETING"
          : task.editTarget
            ? "EDIT_PLANNING"
            : "UNPLANNED"
        : "UNPLANNED",
    );
  else if (task.stages.every((stage) => stage.completed))
    transition(task.status === "completed" ? "TASK_COMPLETED" : "STAGE_COMPLETED");
  else if (task.lifecycle === "UNPLANNED")
    transition(
      task.ledger.some(
        (entry) => entry.status === "completed" && isCanvasMutationTool(entry.call.action.tool),
      )
        ? "EXECUTING_STAGE"
        : "PLAN_SAVED",
    );
  if (task.status === "failed") {
    const stage = task.stages.find((item) => !item.completed);
    if (stage) {
      stage.qaAttempts = 0;
      stage.verified = false;
    }
  }
  const retryQualityStage = task.stages.findIndex(
    (stage) =>
      !stage.completed &&
      !stage.repairVerificationPending &&
      !stage.qualityRepairBlocked &&
      (stage.awaitingQualityRepair || stage.completionReason === "native_verification_failed") &&
      (task.lifecycle === "VERIFYING_STAGE" ||
        task.failure?.phase === "verification" ||
        task.failure?.code === "no_progress_repeated_error"),
  );
  task.status = "running";
  delete task.error;
  delete task.failure;
  try {
    await save();
    if (wasRetry && task.intent === "edit") await reconcileSavedEditOnResume();
    const unfinished = task.stages.findIndex((stage) => !stage.completed);
    if (!task.pending.length && task.stages[unfinished]?.completionReason === "missing_creation_operation" &&
        chatTaskInspectedContinuationRefs(task, unfinished).size > 0) {
      task.pending = parseResponsesFunctionCalls([{
        type: "function_call", call_id: `${task.id}_resume_stage`,
        name: "complete_canvas_stage", arguments: JSON.stringify({ summary: "Reconcile the saved stage against native evidence." }),
      }]);
      await save();
    }
    if (
      retryQualityStage >= 0 &&
      !task.pending.some((call) => isCanvasMutationTool(call.action.tool))
    ) {
      task.stages[retryQualityStage]!.awaitingQualityRepair = true;
      await inspectAfterQualityRepair(retryQualityStage, true);
    }
    while (true) {
      check();
      if (task.intent === "edit" && task.stages.length === 0) {
        const controllerPending = task.pending.some((call) => call.callId.startsWith(EDIT_TARGET_CALL_PREFIX));
        if (!controllerPending) {
          const editStep = nextEditTargetOperation(task, {
            forceFresh: wasRetry,
            initialLedgerLength,
          });
          if ("blocked" in editStep) {
            await stopEdit(editStep.code, editStep.reason, "planning");
            return;
          }
          if ("action" in editStep) {
            transition("EDIT_TARGETING");
            activePhase = "inspection";
            for (const pending of task.pending) {
              const entry = task.ledger.find((candidate) => candidate.call.callId === pending.callId);
              if (!entry || !["pending", "running"].includes(entry.status)) continue;
              entry.status = "failed";
              entry.acknowledgementStatus = "not_attempted";
              entry.output = JSON.stringify({
                success: false,
                acknowledgementStatus: "not_attempted",
                error: "The deterministic edit controller must verify the target before accepting model planning or native work.",
              });
            }
            const scheduled = autonomousEditTargetCall(task, editStep.action);
            task.pending = [scheduled];
            task.recent = [scheduled.functionCall];
            await save();
            deps.progress(editStep.progress);
            continue;
          }
          transition("EDIT_PLANNING");
        }
      }
      if (readOnly()) {
        const conflictingIntent = task.pending.find(
          (call) =>
            call.action.tool === "classify_canvas_intent" &&
            (call.action.intent !== task.intent ||
              Boolean(call.action.targetName && call.action.targetName !== task.targetName)),
        );
        if (conflictingIntent)
          throw new Error("Canvas intent is already checkpointed and cannot be changed.");
        const inspection = readOnlyCheckpoint(task);
        const plan = nextReadOnlyOperation(task, inspection, {
          forceFreshDiscovery: wasRetry,
          initialLedgerLength,
        });
        if ("paused" in plan) {
          task.pending = [];
          task.inspectionOutcome = "PARTIAL";
          task.inspectionSummary = readOnlyInspectionSummary(task, inspection);
          task.text = readOnlyInspectionReport(task, inspection, "PARTIAL", plan.reason);
          task.status = "stopped";
          task.error = plan.reason;
          delete task.failure;
          task.recent = [];
          await save();
          return;
        } else if ("action" in plan) {
          const planKey = inspectionActionKey(plan.action);
          const trackedPending = task.pending.find((pending) => {
            const ledgerEntry = task.ledger.find((entry) => entry.call.callId === pending.callId);
            return (
              ledgerEntry &&
              ["pending", "running"].includes(ledgerEntry.status) &&
              (pending.action.tool === "get_document_context" ||
                pending.action.tool === "inspect_nodes") &&
              inspectionActionKey(pending.action) === planKey
            );
          });
          const matchingPending =
            trackedPending ??
            task.pending.find(
              (pending) =>
                (pending.action.tool === "get_document_context" ||
                  pending.action.tool === "inspect_nodes") &&
                inspectionActionKey(pending.action) === planKey,
            );
          for (const pending of task.pending) {
            if (pending.callId === matchingPending?.callId) continue;
            const ledgerEntry = task.ledger.find((entry) => entry.call.callId === pending.callId);
            if (!ledgerEntry) continue;
            if (ledgerEntry.status === "pending" || ledgerEntry.status === "running") {
              ledgerEntry.status = "failed";
              ledgerEntry.acknowledgementStatus = "not_attempted";
              ledgerEntry.output = JSON.stringify({
                success: false,
                acknowledgementStatus: "not_attempted",
                error: "Not scheduled; the deterministic inspection controller selected the next required operation.",
              });
            }
          }
          const scheduled = matchingPending ?? autonomousInspectionCall(task, plan.action);
          const changed =
            task.pending.length !== 1 || task.pending[0]?.callId !== scheduled.callId;
          task.pending = [scheduled];
          if (!matchingPending) task.recent = [scheduled.functionCall];
          if (changed || !matchingPending) await save();
          deps.progress(plan.progress);
          if (changed || !matchingPending) continue;
        } else {
          task.pending = [];
          task.inspectionOutcome = plan.outcome;
          task.inspectionSummary = readOnlyInspectionSummary(task, inspection);
          if (chatTaskCommittedOperationCount(task) !== 0)
            throw new Error("Read-only inspection recorded a canvas mutation; completion was refused.");
          task.text = readOnlyInspectionReport(task, inspection, plan.outcome, plan.reason);
          if (["COMPLETED", "PARTIAL", "NO_MATCH"].includes(plan.outcome)) {
            transition("TASK_COMPLETED");
            task.status = "completed";
            delete task.error;
            if (plan.outcome !== "PARTIAL") delete task.failure;
          } else {
            task.status = "failed";
            task.failure ??= {
              category: "inspection",
              phase: "inspection",
              code: plan.outcome === "BLOCKED" ? "inspection_blocked" : "inspection_failed",
              committedOperations: 0,
            };
            task.error = task.text.slice(0, 500);
          }
          task.recent = [];
          await save();
          return;
        }
      }
      const propertyStage = await executePlannedPropertyStage();
      if (propertyStage === "complete") return;
      if (propertyStage === "advance") continue;
      const repairVerificationStage = task.stages.findIndex(
        (stage) => stage.repairVerificationPending,
      );
      if (repairVerificationStage >= 0) await inspectAfterQualityRepair(repairVerificationStage);
      const blockedRepairStage = task.stages.findIndex((stage) => stage.qualityRepairBlocked);
      if (blockedRepairStage >= 0) await inspectAfterQualityRepair(blockedRepairStage, true);
      const correctionStageIndex = task.stages.findIndex(
        (stage) => !stage.completed && stage.awaitingQualityRepair,
      );
      const correctionStage = task.stages[correctionStageIndex];
      if (
        correctionStage &&
        (!task.pending.length ||
          task.pending.every((call) => call.action.tool === "complete_canvas_stage"))
      ) {
        const decision = correctionStage.nativeRepairPlan?.find(
          (candidate) => candidate.eligible && candidate.action,
        );
        if (decision?.action) {
          const capacity = chatTaskCapacityUsage(task);
          if (
            capacity.mutations >= CHAT_TASK_MAX_MUTATIONS ||
            task.ledger.length >= CHAT_TASK_MAX_LEDGER_ENTRIES
          ) {
            decision.eligible = false;
            decision.reason = "repair_capacity_exhausted";
            decision.dispatchGate = "existing_capacity";
            failUnavailableRepair(correctionStageIndex);
          }
          for (const pending of task.pending)
            task.recent.push(
              output(pending.callId, {
                success: false,
                instruction: "Native correction is scheduled before stage completion.",
              }),
            );
          const callId = `native_repair_${task.id}_${task.ledger.length + 1}`;
          const { tool, ...args } = decision.action;
          const call = parseResponsesFunctionCalls([
            { type: "function_call", call_id: callId, name: tool, arguments: JSON.stringify(args) },
          ])[0]!;
          decision.dispatchGate = "scheduled";
          decision.operationId = `${task.id}-op-${task.ledger.length + 1}`;
          task.pending = [call];
          task.recent.push(call.functionCall);
          transition("EXECUTING_STAGE");
          await save();
        } else if (
          correctionStage.nativeRepairPlan?.some(
            (candidate) =>
              (candidate.code === "clipped-child" || candidate.code === "low-contrast") &&
              candidate.reason !== "intentional_or_unsupported_clip",
          )
        )
          failUnavailableRepair(correctionStageIndex);
      }
      if (task.pending.length) {
        const calls = task.pending;
        const intentCalls = calls.filter(
          (call) => call.action.tool === "classify_canvas_intent",
        );
        if (intentCalls.length) {
          if (calls.length !== 1 || intentCalls.length !== 1)
            throw new Error("Canvas intent must be classified alone before other canvas tools.");
          const call = intentCalls[0]!;
          if (call.action.tool !== "classify_canvas_intent")
            throw new Error("The intent classifier returned an invalid tool action.");
          const replayed = task.intent === call.action.intent &&
            (!call.action.targetName || call.action.targetName === task.targetName);
          if ((task.intent || task.stages.length) && !replayed)
            throw new Error("Canvas intent is already checkpointed and cannot be changed.");
          task.intent = call.action.intent;
          if (call.action.targetName) task.targetName = call.action.targetName;
          if (readOnly()) {
            transition("INSPECTING");
            activePhase = "inspection";
          } else if (task.intent === "edit") {
            transition("EDIT_TARGETING");
            activePhase = "inspection";
          }
          task.recent.push(
            output(call.callId, {
              success: true,
              replayed,
                intent: task.intent,
                ...(task.targetName ? { targetName: task.targetName } : {}),
              instruction:
                task.intent === "inspect" || task.intent === "explain"
                  ? "Use bounded document discovery and read-only node inspection only; do not plan or mutate."
                  : task.intent === "create"
                    ? "Optionally read document context, then save one create plan before any native changes."
                    : "Discover and inspect the existing target first; plan only targeted edits and never create a replacement root.",
            }),
          );
          task.pending = [];
          await save();
          continue;
        }
        if (readOnly() && calls.some(({ action }) =>
          action.tool !== "get_document_context" && action.tool !== "inspect_nodes"))
          throw new Error("Read-only intent permits discovery and inspection only; no plan or mutation was executed.");
        if (
          calls.some((call) => call.action.tool === "get_document_context") &&
          calls.length !== 1
        ) {
          task.recent.push(
            ...calls.map((call) =>
              output(call.callId, {
                success: false,
                error:
                  "Read document context alone before requesting more context or planning changes.",
              }),
            ),
          );
          task.pending = [];
          await save();
          continue;
        }
        const planning = calls.filter(
          (call) =>
            call.action.tool === "plan_canvas_task" || call.action.tool === "complete_canvas_stage",
        );
        if (planning.length) {
          if (calls.length !== 1) {
            task.recent.push(
              ...calls.map((call) =>
                output(call.callId, {
                  success: false,
                  error:
                    "Call planning or stage completion alone, separately from native changes. None of these calls were executed.",
                }),
              ),
            );
            task.pending = [];
            await save();
            continue;
          }
          const call = planning[0]!;
          const action = call.action;
          const reusingSavedPlan = action.tool === "plan_canvas_task" && task.stages.length > 0;
          activePhase = action.tool === "complete_canvas_stage" ? "verification" : "planning";
          try {
            if (action.tool === "plan_canvas_task") {
              if (
                (task.intent && !["create", "edit", "continue"].includes(task.intent)) ||
                (!task.intent && !task.stages.length)
              )
                throw new Error(
                  "A canvas plan requires a checkpointed create, edit, or continue intent. Inspect/explain requests remain read-only.",
                );
              if (
                (task.intent === "edit" || task.intent === "continue") &&
                !task.ledger.some(
                  (entry) =>
                    entry.status === "completed" &&
                    entry.call.action.tool === "get_document_context",
                )
              )
                throw new Error(
                  "Edit/continue is blocked until bounded document discovery confirms the existing target. No new frame was created.",
                );
              if (task.intent === "edit" && !reusingSavedPlan) {
                const target = task.editTarget;
                if (!target)
                  throw new Error("target_not_inspected: the controller did not save verified native target evidence.");
                const targetRefs = action.targetRefs ?? [];
                const uniqueTargetRefs = new Set(targetRefs);
                if (
                  !targetRefs.includes(target.ref) ||
                  uniqueTargetRefs.size !== targetRefs.length ||
                  targetRefs.some((ref) => !target.verifiedRefs.includes(ref)) ||
                  action.stages.some((stage) => stage.pageId && stage.pageId !== target.pageId) ||
                  action.stages.some((stage) => stage.logicalRefs.length > 19 ||
                    new Set(stage.logicalRefs).size !== stage.logicalRefs.length ||
                    stage.logicalRefs.some((ref) => /^task-/iu.test(ref) && !target.verifiedRefs.includes(ref))) ||
                  action.stages.some((stage) =>
                    stage.logicalRefs.some((ref) => target.verifiedRefs.includes(ref) && !targetRefs.includes(ref)),
                  )
                )
                  throw new Error(
                    "edit_plan_invalid: include the existing root in targetRefs, use only natively inspected target refs, keep each stage at 19 or fewer refs for root verification, and keep every edit stage on the verified target page.",
                  );
                target.plannedRefs = targetRefs;
              }
              if (task.intent === "continue") {
                const discovery = [...task.ledger].reverse().find(
                  (entry) =>
                    entry.status === "completed" &&
                    entry.call.action.tool === "get_document_context",
                );
                if (!discovery)
                  throw new Error(
                    "Edit/continue requires completed bounded document discovery before planning.",
                  );
                let discoveryDecision: string | undefined;
                let discoveryData: Record<string, unknown> | undefined;
                try {
                  discoveryData = JSON.parse(discovery?.output ?? "{}").data;
                  discoveryDecision = (discoveryData?.discovery as { matchStatus?: string } | undefined)
                    ?.matchStatus;
                } catch {
                  // Malformed or missing discovery is blocked below.
                }
                const discoveryQuery =
                  discovery.call.action.tool === "get_document_context"
                    ? discovery.call.action.query
                    : undefined;
                const namedTarget = discoveryQuery ?? task.targetName;
                if (
                  (namedTarget &&
                    !["unique"].includes(discoveryDecision ?? ""))
                )
                  throw new Error(
                    discoveryDecision === "ambiguous"
                      ? `“${namedTarget}” matches multiple existing frames. Ask the user which one to edit, or repeat discovery with a more specific target name; no plan or canvas changes were made.`
                      : discoveryDecision === "no_match"
                        ? `No existing frame matched “${namedTarget}”. Report that no target was found; do not create a replacement frame.`
                        : discoveryDecision === "no_match_truncated"
                          ? `No match for “${namedTarget}” was found in the bounded scan, which was truncated. Ask for a more specific page/frame or report the discovery limit; do not create a replacement.`
                          : discoveryDecision === "uneditable"
                            ? "The unique matching node has no safe logical reference. Ask the user to select another editable frame or resolve its stale/ambiguous reference; do not guess or recreate it."
                          : "Edit/continue requires a unique discovery match for the named target before planning. Refine the query or ask the user which frame to edit.",
                  );
                if (namedTarget) {
                  const target = (discoveryData?.frames as Array<Record<string, unknown>> | undefined)
                    ?.find((frame) => typeof frame.ref === "string");
                  const currentPageId = (discoveryData?.page as { id?: string } | undefined)?.id;
                  const inspectedTarget = target
                    ? task.ledger.some((entry) => {
                        if (
                          entry.status !== "completed" ||
                          entry.call.action.tool !== "inspect_nodes" ||
                          !entry.call.action.refs.includes(target.ref as string) ||
                          (entry.call.action.pageId ?? currentPageId) !== target.pageId
                        )
                          return false;
                        try {
                          const nodes = JSON.parse(entry.output ?? "{}").data?.nodes;
                          return (
                            Array.isArray(nodes) &&
                            nodes.some((node) => node?.ref === target.ref)
                          );
                        } catch {
                          return false;
                        }
                      })
                    : false;
                  if (!inspectedTarget)
                    throw new Error(
                      "Inspect the uniquely matched frame using its returned logical ref and exact pageId before planning the edit. No canvas changes were made.",
                    );
                } else {
                  const selected = Array.isArray(discoveryData?.selection)
                    ? discoveryData.selection.length > 0
                    : false;
                  if (!selected)
                    throw new Error(
                      "No selected target was present. Repeat discovery with the exact project/screen name or ask the user which existing frame to edit; do not guess.",
                    );
                  if (!task.ledger.some((entry) => {
                    if (
                      entry.status !== "completed" ||
                      entry.call.action.tool !== "inspect_nodes"
                    )
                      return false;
                    try {
                      const output = JSON.parse(entry.output ?? "{}");
                      return Array.isArray(output.data?.nodes) && output.data.nodes.length > 0;
                    } catch {
                      return false;
                    }
                  }))
                    throw new Error(
                      "Edit/continue is blocked until a non-empty native inspection confirms the selected existing target. No new frame was created.",
                    );
                }
              }
              if (action.designName) task.designName = action.designName;
              if (!task.stages.length) {
                const contextEntry = [...task.ledger].reverse().find(
                  (entry) =>
                    entry.status === "completed" &&
                    entry.call.action.tool === "get_document_context",
                );
                let contextPageId: string | undefined;
                try {
                  contextPageId = JSON.parse(contextEntry?.output ?? "{}").data?.page?.id;
                } catch {
                  // A missing page ID leaves the plan explicitly unscoped.
                }
                const inspectedPageIds = new Set(
                  task.ledger.flatMap((entry) =>
                    entry.status === "completed" &&
                    entry.call.action.tool === "inspect_nodes" &&
                    (entry.call.action.pageId ?? contextPageId)
                      ? [entry.call.action.pageId ?? contextPageId!]
                      : [],
                  ),
                );
                const inspectedPageId =
                  inspectedPageIds.size === 1 ? [...inspectedPageIds][0] : undefined;
                task.brief = action.brief;
                task.stages = action.stages.map((planned) => ({
                  ...planned,
                  ...(!planned.pageId && task.intent === "edit" && task.editTarget
                    ? { pageId: task.editTarget.pageId }
                    : {}),
                  ...(!planned.pageId && task.intent !== "create" && inspectedPageId
                    && task.intent !== "edit"
                    ? { pageId: inspectedPageId }
                    : {}),
                  estimatedMutations:
                    planned.estimatedMutations ??
                    (task.intent === "edit" ? 1 : estimatedStageMutations(planned.logicalRefs)),
                  completed: false,
                  operations: 0,
                  readOnlyOperations: 0,
                  segments: [],
                  rounds: 0,
                  roundBreakdown: roundBreakdown(),
                  qaAttempts: 0,
                  verificationOperations: 0,
                  verified: false,
                  verificationHistory: [],
                  qualityFindings: [],
                  repairOperationsExecuted: 0,
                  repairOperationsAttempted: 0,
                  repairFindingsResolved: 0,
                  repairVerificationPending: false,
                  awaitingQualityRepair: false,
                }));
                transition("PLAN_SAVED");
              }
            } else if (action.tool === "complete_canvas_stage") {
              const stage = task.stages.find((item) => !item.completed);
              const stageIndex = stage ? task.stages.indexOf(stage) : -1;
              transition("VERIFYING_STAGE");
              await save();
              for (const operationId of action.resolvedOperationIds) {
                const failedIndex = task.ledger.findIndex(
                  (entry) => entry.operationId === operationId && entry.status === "failed",
                );
                const failed = task.ledger[failedIndex];
                if (!failed || !stage || failed.stage !== stageIndex)
                  throw new Error("The repair references an unknown failed operation.");
                const failedAction = failed.call.action;
                const repair = task.ledger.slice(failedIndex + 1).some((entry) => {
                  const repairAction = entry.call.action;
                  if (
                    entry.status !== "completed" ||
                    entry.stage !== failed.stage ||
                    repairAction.tool !== failedAction.tool
                  )
                    return false;
                  if (
                    "ref" in failedAction &&
                    (!("ref" in repairAction) ||
                      knownRef(repairAction.ref) !== knownRef(failedAction.ref))
                  )
                    return false;
                  if (
                    failedAction.tool === "set_properties" &&
                    repairAction.tool === "set_properties"
                  ) {
                    const properties = repairAction.properties;
                    return Object.entries(failedAction.properties).every(
                      ([key, value]) =>
                        JSON.stringify(properties[key as keyof typeof properties]) ===
                        JSON.stringify(value),
                    );
                  }
                  return true;
                });
                if (!repair)
                  throw new Error(
                    "A failed operation needs a confirmed same-tool, same-ref repair before the stage can finish.",
                  );
                failed.status = "repaired";
              }
              if (
                !stage ||
                task.ledger.some(
                  (entry) =>
                    entry.stage === stageIndex &&
                    isCanvasMutationTool(entry.call.action.tool) &&
                    entry.status !== "completed" &&
                    entry.status !== "repaired",
                )
              ) {
                if (stage) stage.completionReason = "pending_or_failed_mutations";
                throw new Error(
                  "A stage cannot complete with failed or unconfirmed operations. Inspect and repair the failed stage.",
                );
              }
              const confirmedStageMutations = task.ledger.filter(
                (entry) =>
                  entry.stage === stageIndex &&
                  entry.status === "completed" &&
                  !entry.reused &&
                  isCanvasMutationTool(entry.call.action.tool),
              );
              if (!confirmedStageMutations.length) {
                stage.completionReason = "pending_or_failed_mutations";
                throw new Error(
                  "No native operations were confirmed for this stage; it cannot be marked complete.",
                );
              }
              const target = task.intent === "edit" ? task.editTarget : undefined;
              const verifiedTargetRefs = new Set(target?.verifiedRefs.map(knownRef) ?? []);
              const plannedTargetRefs = target?.plannedRefs
                ? new Set(target.plannedRefs.map(knownRef))
                : undefined;
              const invalidExistingRefs = stage.logicalRefs.filter((ref) =>
                verifiedTargetRefs.has(knownRef(ref)) &&
                plannedTargetRefs &&
                !plannedTargetRefs.has(knownRef(ref)),
              );
              if (invalidExistingRefs.length) {
                stage.completionReason = "invalid_required_reference";
                throw new Error(
                  `invalid_required_reference: Saved edit stage references existing native targets outside the verified plan: ${invalidExistingRefs.join(", ")}. The confirmed mutation is retained; inspect and replan this stage before continuing.`,
                );
              }
              const satisfiedRefs = chatTaskStageSatisfiedRefs(task, stageIndex);
              const satisfiedRefKeys = new Set([...satisfiedRefs].map(knownRef));
              const requiresInspection = stage.logicalRefs.filter(
                (ref) =>
                  target !== undefined &&
                  plannedTargetRefs?.has(knownRef(ref)) &&
                  !verifiedTargetRefs.has(knownRef(ref)),
              );
              const missingCreationRefs = stage.logicalRefs.filter(
                (ref) =>
                  !satisfiedRefKeys.has(knownRef(ref)) &&
                  !requiresInspection.some((pendingRef) => knownRef(pendingRef) === knownRef(ref)),
              );
              if (missingCreationRefs.length) {
                stage.completionReason = "missing_creation_operation";
                throw new Error(
                  `missing_creation_operation: The saved stage still requires native creation of ${missingCreationRefs.join(", ")}. Existing verified edit targets may be reused without mutation; create only genuinely new required refs, then complete the stage again.`,
                );
              }
              const reusedContinuation = chatTaskInspectedContinuationRefs(task, stageIndex);
              const offPlanCreations = reusedContinuation.size ? confirmedStageMutations.flatMap((entry) => {
                const action = entry.call.action;
                return (action.tool === "create_frame" || action.tool === "create_text" || action.tool === "create_rectangle") &&
                  !stage.logicalRefs.some((ref) => knownRef(ref) === knownRef(action.ref)) ? [knownRef(action.ref)] : [];
              }) : [];
              const hasConfirmedPropertyEdit =
                task.intent === "edit" &&
                confirmedStageMutations.some((entry) => entry.call.action.tool === "set_properties");
              const propertyVerificationPersisted = task.ledger.some((entry) => {
                if (
                  entry.stage !== stageIndex ||
                  entry.category !== "verification" ||
                  entry.status !== "completed"
                )
                  return false;
                try {
                  return JSON.parse(entry.output ?? "{}").propertyVerificationConfirmed === true;
                } catch {
                  return false;
                }
              });
              if (!stage.verified || offPlanCreations.length || (hasConfirmedPropertyEdit && !propertyVerificationPersisted)) {
                if (stage.qaAttempts >= 3) {
                  stage.completionReason = "native_verification_failed";
                  throw new Error(
                    "Structural quality still fails after three bounded checks. Retry the failed stage after reviewing its findings.",
                  );
                }
                const attempt = stage.qaAttempts + 1;
                const verificationNumber = stage.verificationOperations + 1;
                const refs = offPlanCreations.length
                  ? [...new Set([...stage.logicalRefs, ...offPlanCreations])]
                  : stage.logicalRefs.length
                  ? task.intent === "edit" && task.editTarget
                    ? [
                        ...new Set([
                          task.editTarget.ref,
                          ...stage.logicalRefs,
                          ...confirmedStageMutations.flatMap((entry) =>
                            entry.call.action.tool === "set_properties" ? [entry.call.action.ref] : [],
                          ),
                        ]),
                      ]
                    : stage.logicalRefs
                  : task.ledger
                      .filter((entry) => entry.stage === stageIndex && "ref" in entry.call.action)
                      .map((entry) => ("ref" in entry.call.action ? entry.call.action.ref : ""))
                      .filter(Boolean)
                      .slice(0, 20);
                if (refs.length > INSPECT_NODES_LIMITS.refs)
                  throw new Error("invalid_required_reference: The saved stage exceeds the bounded native verification scope.");
                const inspection = parseResponsesFunctionCalls([
                  {
                    type: "function_call",
                    call_id: `${task.id}_qa_${stageIndex + 1}_${verificationNumber}`,
                    name: "inspect_nodes",
                    arguments: JSON.stringify({
                      ...(stage.pageId ? { pageId: stage.pageId } : {}),
                      refs,
                      selection: false,
                      depth: 4,
                      maxNodes: 25,
                      purpose: "structural_verification",
                      palette: palette(),
                    }),
                  },
                ])[0]!;
                let inspectionEntry = task.ledger.find(
                  (entry) =>
                    entry.stage === stageIndex &&
                    entry.call.action.tool === "inspect_nodes" &&
                    (entry.status === "pending" || entry.status === "running"),
                );
                if (!inspectionEntry) {
                  const capacity = chatTaskCapacityUsage(task);
                  if (
                    capacity.verificationOperations >= CHAT_TASK_MAX_VERIFICATION_OPERATIONS ||
                    task.ledger.length >= CHAT_TASK_MAX_LEDGER_ENTRIES ||
                    !refs.length
                  )
                    throw new Error(
                      "No bounded logical refs are available for required stage verification; committed work remains. Inspect or retry the stage.",
                    );
                  inspectionEntry = {
                    call: inspection,
                    operationId: `${task.id}-qa-${stageIndex + 1}-${verificationNumber}`,
                    stage: stageIndex,
                    status: "pending",
                    category: "verification",
                  };
                  task.ledger.push(inspectionEntry);
                  stage.qaAttempts = attempt;
                }
                const inspectionOperation = FigmaToolOperationSchema.parse({
                  operationId: inspectionEntry.operationId,
                  idempotencyKey: `chat:${inspectionEntry.operationId}`,
                  ...(task.referenceScope ? { taskId: task.id } : {}),
                  ...(task.chatId ? { chatId: task.chatId } : {}),
                  ...(task.designName ? { designName: task.designName } : {}),
                  action: inspection.action,
                });
                let inspectionResult: Result;
                let result: Result["results"][number] | undefined;
                let rateRetries = 0;
                while (true) {
                  check();
                  task.starts = task.starts.filter((started) => started > now() - 60_100);
                  if (task.starts.length >= 36) {
                    deps.progress(
                      "Waiting for local canvas capacity; committed changes remain visible…",
                    );
                    await wait(Math.max(1, task.starts[0]! + 60_100 - now()), deps.signal);
                    continue;
                  }
                  if (task.batches >= 1_000)
                    throw new Error(
                      "The saved batch limit was reached before section verification.",
                    );
                  inspectionEntry.status = "running";
                  task.starts.push(now());
                  task.batches++;
                  await save();
                  deps.progress(`Reviewing ${stage.title} geometry and editable layers…`);
                  activePhase = "verification";
                  inspectionResult = await deps.execute([inspectionOperation]);
                  result =
                    inspectionResult.results.length === 1 &&
                    inspectionResult.results[0]!.operationId === inspectionEntry.operationId
                      ? inspectionResult.results[0]
                      : undefined;
                  if (
                    !inspectionResult.success &&
                    result &&
                    !result.success &&
                    /Local tool rate limit reached/u.test(result.error ?? "")
                  ) {
                    inspectionEntry.status = "pending";
                    await save();
                    if (++rateRetries > 2)
                      throw new Error(
                        "Local capacity is still busy. Resume after one minute; no confirmed work will be repeated.",
                      );
                    deps.progress(
                      "Figma local rate limit reached; waiting one minute before retrying the same verification ID…",
                    );
                    await wait(60_100, deps.signal);
                    continue;
                  }
                  break;
                }
                if (!inspectionResult.success || !result?.success) {
                  inspectionEntry.status = "failed";
                  inspectionEntry.output = JSON.stringify({
                    success: false,
                    error: result?.error ?? "Figma did not confirm the section inspection.",
                  });
                  await save();
                  throw new Error(
                    result?.error ??
                      "Figma did not confirm the section inspection; committed changes remain.",
                  );
                }
                const parsedNodes = NativeVisualNodeSchema.array()
                  .max(25)
                  .safeParse(result.data?.nodes);
                if (!parsedNodes.success) {
                  inspectionEntry.status = "failed";
                  inspectionEntry.output = JSON.stringify({
                    success: false,
                    error: "The bounded inspection returned invalid geometry data.",
                  });
                  await save();
                  throw new Error(
                    "The bounded section inspection returned invalid geometry; committed changes remain.",
                  );
                }
                const inspectedRootRefs = new Set(
                  parsedNodes.data.flatMap((node) => node.ref ? [knownRef(node.ref)] : []),
                );
                const missingInspectionRefs = refs
                  .map(knownRef)
                  .filter((ref) => !inspectedRootRefs.has(ref));
                if (missingInspectionRefs.length) {
                  inspectionEntry.status = "completed";
                  inspectionEntry.acknowledgementStatus = "read_only";
                  inspectionEntry.output = JSON.stringify({
                    success: false,
                    inspectedNodes: parsedNodes.data.length,
                    missingInspectionRefs,
                  });
                  stage.completionReason = "missing_reference_inspection";
                  await save();
                  throw new Error(
                    `missing_reference_inspection: Native verification did not return evidence for ${missingInspectionRefs.join(", ")}. The confirmed mutation remains; the stage was not marked complete.`,
                  );
                }
                if (target) {
                  const inspectedPlannedRefs = refs
                    .map(knownRef)
                    .filter((ref) => plannedTargetRefs?.has(ref));
                  target.verifiedRefs = [
                    ...new Set([...target.verifiedRefs, ...inspectedPlannedRefs]),
                  ].slice(0, 25);
                }
                if (offPlanCreations.length) {
                  inspectionEntry.status = "completed";
                  inspectionEntry.acknowledgementStatus = "read_only";
                  inspectionEntry.output = JSON.stringify({
                    success: true, planMismatch: true, refs: refs.map(knownRef),
                    identities: result.data?.nativeIdentities,
                  });
                  stage.verified = false;
                  stage.completionReason = "invalid_required_reference";
                  await save();
                  throw new Error("invalid_required_reference: Fresh native inspection confirmed the existing refs and saved additions, but the additions are outside the saved enhancement specification. Review the remaining design work before authorizing a revised plan.");
                }
                const verifiedRefs = refs.map(knownRef);
                const findings = readVerification(
                  stageIndex,
                  result.data,
                  parsedNodes.data,
                  verifiedRefs,
                );
                const safeFindings = safeQualityFindings(findings);
                inspectionEntry.status = "completed";
                inspectionEntry.acknowledgementStatus = "read_only";
                const propertyChecks =
                  task.intent === "edit"
                    ? nativePropertyChecks(task, stageIndex, parsedNodes.data, knownRef)
                    : [];
                const backgrounds = result.data?.frameBackgrounds as Record<string, unknown> | undefined;
                if (target && backgrounds && backgrounds[knownRef(target.ref)] !== "root" &&
                    propertyChecks.some((item) => item.ref === knownRef(target.ref) && item.property === "fill")) {
                  stage.verified = false;
                  stage.completionReason = "native_property_verification_failed";
                  inspectionEntry.output = JSON.stringify({ success: false, visualOutcomeVerified: false });
                  throw new Error("native_property_verification_failed: The confirmed frame fill is not established as the visible background.");
                }
                const propertyMismatches = nativePropertyMismatches(propertyChecks);
                inspectionEntry.output = JSON.stringify({
                  success: propertyMismatches.length === 0,
                  inspectedNodes: parsedNodes.data.length,
                  findingCount: findings.length,
                  findings: findings.slice(0, 12),
                  verifiedPropertyCount: propertyChecks.length,
                  propertyVerificationConfirmed:
                    propertyMismatches.length === 0 && propertyChecks.length > 0,
                  ...(propertyMismatches.length
                    ? {
                        propertyMismatches: propertyMismatches.slice(0, 12).map(({ ref, property, actual }) => ({
                          ref,
                          property,
                          observation: actual === undefined ? "unavailable" : "different",
                        })),
                      }
                    : {}),
                });
                if (propertyMismatches.length) {
                  stage.verified = false;
                  stage.completionReason = "native_property_verification_failed";
                  await save();
                  throw new Error(
                    `native_property_verification_failed: Native values did not match the confirmed edit for ${propertyMismatches
                      .slice(0, 5)
                      .map(({ ref, property, actual }) =>
                        `${ref}.${property} (${actual === undefined ? "native value unavailable" : "native value differs from the requested value"})`,
                      )
                      .join("; ")}. The confirmed mutation is retained; it was not replayed.`,
                  );
                }
                if (hasQualityProgress(stage.qualityFindings, safeFindings)) {
                  delete task.lastFailureSignature;
                  delete task.lastFailureProgress;
                }
                stage.qualityFindings = safeFindings;
                stage.verificationHistory.push({
                  attempt: verificationNumber,
                  findings: safeFindings,
                });
                if (findings.length) {
                  stage.verified = false;
                  stage.completionReason = "native_verification_failed";
                  stage.awaitingQualityRepair = true;
                  if (!stage.nativeRepairPlan?.some((decision) => decision.eligible)) {
                    if (
                      stage.nativeRepairPlan?.some(
                        (decision) =>
                          (decision.code === "clipped-child" || decision.code === "low-contrast") &&
                          (decision.reason !== "intentional_or_unsupported_clip" ||
                            stage.verificationHistory.length > 1),
                      )
                    )
                      failUnavailableRepair(stageIndex);
                    guardRepeatedFailure(
                      `structural_quality:${qualityFailureSignature(safeFindings)}`,
                    );
                  }
                  transition("EXECUTING_STAGE");
                  task.recent.push(
                    output(call.callId, {
                      success: false,
                      stage: stage.title,
                      inspectedNodes: parsedNodes.data.length,
                      qualityFindings: findings.slice(0, 12),
                      instruction:
                        "The local runner dispatches eligible native hierarchy and contrast corrections, then re-inspects. Do not recreate nodes or duplicate repairs. Unsupported conditions remain visible with their eligibility gates.",
                    }),
                  );
                  task.pending = [];
                  await save();
                  continue;
                }
                stage.verified = true;
                stage.awaitingQualityRepair = false;
              }
              stage.completed = true;
              stage.completionReason = "required_refs_and_native_verification_confirmed";
              delete task.lastFailureSignature;
              delete task.lastFailureProgress;
              transition("STAGE_COMPLETED");
              if (task.intent === "edit" && task.stages.every((item) => item.completed)) {
                const report = editCompletionReport(task);
                if (!report)
                  throw new Error(
                    "native_verification_invalid: The verified edit did not produce a safe completion report.",
                  );
                task.text = report;
                task.pending = [];
                task.status = "completed";
                delete task.failure;
                task.recent = [];
                transition("TASK_COMPLETED");
                await save();
                return;
              }
            }
            task.recent.push(
              output(call.callId, {
                success: true,
                ...(reusingSavedPlan ? { canonicalPlanReused: true } : {}),
                ...(call.normalizedPlanningMetadata
                  ? {
                      normalization:
                        "planning_runtime_metadata_ignored; runtime state is locally initialized",
                    }
                  : {}),
                planVersion: CHAT_PLAN_VERSION,
                stages: modelPlanStages(task.stages),
                instruction:
                  "The plan is saved. Do not replan. Execute only the next unfinished stage using native tools.",
                nextStage: task.stages.find((stage) => !stage.completed)?.title ?? null,
              }),
            );
          } catch (error) {
            if (action.tool === "plan_canvas_task" && task.intent === "edit" && !reusingSavedPlan) {
              const message = error instanceof Error ? error.message : "The edit plan was rejected by the safety validator.";
              const code = message.startsWith("target_not_inspected")
                ? "target_not_inspected"
                : message.startsWith("reference_not_mutation_eligible")
                  ? "reference_not_mutation_eligible"
                  : "edit_plan_invalid";
              await stopEdit(code, message.replace(/^edit_plan_invalid:\s*/u, ""), "planning");
              return;
            }
            if (
              error instanceof Error &&
              (error.message.startsWith("no_progress_repeated_error") ||
                error.message.startsWith("native_quality_unrepairable") ||
                error.message.startsWith("native_verification_invalid") ||
                error.message.startsWith("native_property_verification_failed") ||
                error.message.startsWith("missing_reference_inspection") ||
                error.message.startsWith("invalid_required_reference"))
            )
              throw error;
            if (task.stages.length && task.lifecycle === "VERIFYING_STAGE")
              transition("EXECUTING_STAGE");
            if (error instanceof Error && error.message.startsWith("missing_creation_operation:")) {
              const progress = chatTaskCommittedOperationCount(task);
              if (task.lastFailureSignature === error.message && task.lastFailureProgress === progress)
                throw error;
              task.lastFailureSignature = error.message;
              task.lastFailureProgress = progress;
            } else guardRepeatedFailure(
              `planning:${error instanceof Error ? error.message : "stage_not_confirmed"}`,
            );
            task.recent.push(
              output(call.callId, {
                success: false,
                error: error instanceof Error ? error.message : "Stage not confirmed.",
              }),
            );
          }
          task.pending = [];
          await save();
          continue;
        }

        const stageIndex = task.stages.findIndex((stage) => !stage.completed);
        const prePlanReadOnly =
          stageIndex < 0 &&
          calls.every(
            (call) =>
              call.action.tool === "get_document_context" || call.action.tool === "inspect_nodes",
          );
        if (stageIndex < 0 && !prePlanReadOnly) {
          task.recent.push(
            ...calls.map((call) =>
              output(call.callId, {
                success: false,
                error:
                  "No active stage. Call plan_canvas_task alone before any canvas operations, or respond with completion if all stages are already confirmed. Nothing was executed.",
              }),
            ),
          );
          task.pending = [];
          await save();
          continue;
        }
        const stage = stageIndex >= 0 ? task.stages[stageIndex] : undefined;
        if (stage) {
          const actionPageIds = new Set(
            calls.flatMap((call) =>
              "pageId" in call.action && call.action.pageId ? [call.action.pageId] : [],
            ),
          );
          if (actionPageIds.size > 1)
            throw new Error(
              "Each saved stage must target one Figma page; split cross-page edits into separate ordered stages.",
            );
          const actionPageId = [...actionPageIds][0];
          if (stage.pageId && actionPageId && stage.pageId !== actionPageId)
            throw new Error("A stage operation targets a different page from its saved target.");
          if (!stage.pageId && actionPageId) stage.pageId = actionPageId;
        }
        const newCalls = calls.filter(
          (call) => !task.ledger.some((entry) => entry.call.callId === call.callId),
        );
        const capacity = chatTaskCapacityUsage(task);
        const newMutations = newCalls.filter((call) =>
          isCanvasMutationTool(call.action.tool),
        ).length;
        const newReadOnly = newCalls.length - newMutations;
        if (capacity.mutations + newMutations > CHAT_TASK_MAX_MUTATIONS)
          throw new Error(
            `Task mutation capacity reached: ${capacity.mutations}/${CHAT_TASK_MAX_MUTATIONS} scheduled mutations. Confirmed work is retained; continue the remaining requirements in a new task without recreating existing nodes.`,
          );
        if (capacity.readOnlyOperations + newReadOnly > CHAT_TASK_MAX_READ_ONLY_OPERATIONS)
          throw new Error(
            `Task read-only capacity reached: ${capacity.readOnlyOperations}/${CHAT_TASK_MAX_READ_ONLY_OPERATIONS} inspections. Mutation capacity was not consumed; confirmed work is retained.`,
          );
        if (task.ledger.length + newCalls.length > CHAT_TASK_MAX_LEDGER_ENTRIES)
          throw new Error(
            `Task checkpoint ledger reached ${task.ledger.length}/${CHAT_TASK_MAX_LEDGER_ENTRIES} entries. Confirmed work is retained; no further call was scheduled.`,
          );
        for (const call of calls) {
          const prior = task.ledger.find((entry) => entry.call.callId === call.callId);
          if (prior) {
            if (JSON.stringify(prior.call.action) !== JSON.stringify(call.action))
              throw new Error("A reused call ID changed its action; execution was refused.");
            continue;
          }
          let reusedInspection: (typeof task.ledger)[number] | undefined;
          if (call.action.tool === "inspect_nodes") {
            for (let index = task.ledger.length - 1; index >= 0; index--) {
              const candidate = task.ledger[index]!;
              if (
                candidate.stage !== Math.max(0, stageIndex) ||
                candidate.status !== "completed" ||
                candidate.call.action.tool !== "inspect_nodes" ||
                JSON.stringify(candidate.call.action) !== JSON.stringify(call.action)
              )
                continue;
              const changed = task.ledger
                .slice(index + 1)
                .some(
                  (entry) =>
                    entry.status === "completed" &&
                    !entry.reused &&
                    isCanvasMutationTool(entry.call.action.tool),
                );
              if (!changed) reusedInspection = candidate;
              break;
            }
          }
          if (reusedInspection) {
            guardRepeatedFailure(`inspection:no_state_change:${JSON.stringify(call.action)}`);
            task.ledger.push({
              call,
              operationId: `${task.id}-op-${task.ledger.length + 1}`,
              stage: Math.max(0, stageIndex),
              status: "completed",
              category: "read_only",
              reused: true,
              output: reusedInspection.output,
            });
            continue;
          }
          task.ledger.push({
            call,
            operationId: `${task.id}-op-${task.ledger.length + 1}`,
            stage: Math.max(0, stageIndex),
            status: "pending",
            category: isCanvasMutationTool(call.action.tool) ? "mutation" : "read_only",
          });
          if (stage && isCanvasMutationTool(call.action.tool)) {
            transition("EXECUTING_STAGE");
          }
        }
        await save();
        let rateRetries = 0;
        let referenceCorrection = false;
        let continueAfterPrePlanReadOnly = false;
        while (true) {
          check();
          const remaining = calls
            .map((call) => task.ledger.find((entry) => entry.call.callId === call.callId)!)
            .filter((entry) => entry.status === "pending" || entry.status === "running");
          if (!remaining.length) break;
          const segment = remaining[0]?.segment;
          let entries = remaining.filter((entry) => entry.segment === segment).slice(0, 10);
          if (task.stages[remaining[0]!.stage]?.awaitingQualityRepair && entries.length > 1)
            entries = entries.slice(0, 1);
          const operationsFor = () =>
            entries.map(({ call, operationId }) => {
              const ref = "ref" in call.action ? call.action.ref : undefined;
              const original =
                ref &&
                ["create_frame", "create_text", "create_rectangle"].includes(call.action.tool)
                  ? task.ledger.find(
                      (entry) =>
                        entry.operationId !== operationId &&
                        entry.status === "completed" &&
                        !entry.reused &&
                        "ref" in entry.call.action &&
                        entry.call.action.ref === ref &&
                        ["create_frame", "create_text", "create_rectangle"].includes(
                          entry.call.action.tool,
                        ),
                    )
                  : undefined;
              const action =
                stage?.pageId && "pageId" in call.action
                  ? { ...call.action, pageId: call.action.pageId ?? stage.pageId }
                  : call.action;
              return {
                operationId,
                idempotencyKey: `chat:${operationId}`,
                ...(task.referenceScope ? { taskId: task.id } : {}),
                ...(task.chatId ? { chatId: task.chatId } : {}),
                ...(task.designName ? { designName: task.designName } : {}),
                ...(original ? { expectedCreationOperationId: original.operationId } : {}),
                action,
              };
            });
          while (
            entries.length > 1 &&
            utf8Bytes(
              JSON.stringify({
                type: "tool-execute",
                protocolVersion: 1,
                batchId: "chat-batch-placeholder",
                operations: operationsFor(),
              }),
            ) >
              48 * 1024
          )
            entries = entries.slice(0, -1);
          const batch = FigmaToolBatchSchema.parse({
            type: "tool-execute",
            protocolVersion: 1,
            batchId: "chat-batch-placeholder",
            operations: operationsFor(),
          });
          if (utf8Bytes(JSON.stringify(batch)) > 60 * 1024)
            throw new Error("One operation exceeds the safe batch byte budget; it was not sent.");
          task.starts = task.starts.filter((started) => started > now() - 60_100);
          if (task.starts.length + entries.length > 36) {
            deps.progress("Waiting for local canvas capacity; confirmed changes remain visible…");
            await wait(Math.max(1, task.starts[0]! + 60_100 - now()), deps.signal);
            continue;
          }
          entries.forEach((entry) => {
            entry.status = "running";
            task.starts.push(now());
            const stage = task.stages[entry.stage];
            if (entry.category === "mutation" && stage) stage.verified = false;
            if (
              entry.category === "mutation" &&
              stage?.awaitingQualityRepair &&
              !entry.qualityRepairAttempted
            ) {
              entry.qualityRepairAttempted = true;
              stage.repairOperationsAttempted++;
            }
          });
          task.batches++;
          await save();
          const activeReadOnlyAction = entries[0]?.call.action;
          deps.progress(
            stage
              ? "Applying " +
                  stage.title +
                  " · " +
                  chatTaskCommittedOperationCount(task) +
                  " canvas operations confirmed…"
              : activeReadOnlyAction?.tool === "get_document_context"
                ? "Scanning accessible pages and frame window " +
                  (activeReadOnlyAction.offset ?? 0) +
                  "…"
                : activeReadOnlyAction?.tool === "inspect_nodes"
                  ? "Inspecting " +
                    activeReadOnlyAction.refs.length +
                    " frame(s) on " +
                    (activeReadOnlyAction.pageId ?? "the current page") +
                    "…"
                  : "Reading the bounded document context…",
          );
          activePhase = entries.some((entry) => entry.category === "verification")
            ? "verification"
            : calls.every(
                  (call) =>
                    call.action.tool === "get_document_context" ||
                    call.action.tool === "inspect_nodes" ||
                    call.action.tool === "get_operation_status",
                )
              ? "inspection"
              : "native_execution";
          const result = await deps.execute(batch.operations);
          if (
            result.results.some(
              (item) => !entries.some((entry) => entry.operationId === item.operationId),
            )
          )
            throw new Error("Figma returned results for an unexpected operation; task paused.");
          if (
            new Set(result.results.map((item) => item.operationId)).size !==
              result.results.length ||
            result.results.length !== entries.length ||
            (result.success &&
              entries.some(
                (entry) =>
                  !result.results.some(
                    (item) => item.operationId === entry.operationId && item.success,
                  ),
              ))
          )
            throw new Error(
              "Figma returned incomplete or duplicate confirmations; task paused for reconciliation.",
            );
          const resultById = new Map(result.results.map((item) => [item.operationId, item]));
          const expectedCommitted = entries
            .filter((entry) => {
              const item = resultById.get(entry.operationId);
              return (
                isCanvasMutationTool(entry.call.action.tool) &&
                item?.acknowledgementStatus === "confirmed_mutation"
              );
            })
            .map((entry) => entry.operationId)
            .sort();
          const expectedPartial = entries
            .filter(
              (entry) =>
                isCanvasMutationTool(entry.call.action.tool) &&
                resultById.get(entry.operationId)?.acknowledgementStatus === "ambiguous",
            )
            .map((entry) => entry.operationId)
            .sort();
          const acknowledgementsValid = entries.every((entry) => {
            const item = resultById.get(entry.operationId);
            if (!item?.acknowledgementStatus) return false;
            if (isCanvasMutationTool(entry.call.action.tool))
              return item.success
                ? item.acknowledgementStatus === "confirmed_mutation" ||
                    item.acknowledgementStatus === "verified_idempotent_replay"
                : ["rejected", "ambiguous", "not_attempted"].includes(item.acknowledgementStatus);
            return ["read_only", "rejected", "not_attempted"].includes(
              item.acknowledgementStatus,
            );
          });
          if (
            !acknowledgementsValid ||
            JSON.stringify([...result.committedOperationIds].sort()) !==
              JSON.stringify(expectedCommitted) ||
            JSON.stringify([...result.partialOperationIds].sort()) !==
              JSON.stringify(expectedPartial)
          )
            throw new Error(
              "Figma returned inconsistent mutation acknowledgements; inspect the canvas before retrying.",
            );
          let limited = false;
          let failed = false;
          for (const entry of entries) {
            const item = result.results.find((item) => item.operationId === entry.operationId);
            if (!item) {
              entry.status = "pending";
              continue;
            }
            if (!item.success && /Local tool rate limit reached/u.test(item.error ?? "")) {
              entry.status = "pending";
              entry.acknowledgementStatus = "not_attempted";
              limited = true;
              continue;
            }
            entry.acknowledgementStatus = item.acknowledgementStatus;
            for (const decision of task.stages[entry.stage]?.nativeRepairPlan ?? [])
              if (decision.operationId === entry.operationId)
                decision.dispatchGate = item.success
                  ? item.acknowledgementStatus === "confirmed_mutation"
                    ? "native_confirmed"
                    : "native_noop"
                  : "native_rejected";
            entry.status =
              item.acknowledgementStatus === "not_attempted"
                ? "pending"
                : item.success
                  ? "completed"
                  : "failed";
            if (item.data?.reused === true) entry.reused = true;
            if (
              item.success &&
              entry.category === "mutation" &&
              task.stages[entry.stage]?.awaitingQualityRepair &&
              (item.acknowledgementStatus === "confirmed_mutation" ||
                item.acknowledgementStatus === "verified_idempotent_replay")
            ) {
              const stage = task.stages[entry.stage]!;
              if (item.acknowledgementStatus === "confirmed_mutation" && !entry.reused)
                stage.repairOperationsExecuted++;
              stage.repairVerificationPending = true;
              stage.pendingRepairOperationId = entry.operationId;
            }
            const payload = {
              success: item.success,
              acknowledgementStatus: item.acknowledgementStatus,
              logicalRef: item.logicalRef,
              summary: item.summary,
              error: item.error,
              data: item.data,
            };
            if (
              task.intent === "edit" &&
              entry.call.callId.startsWith(EDIT_TARGET_CALL_PREFIX) &&
              entry.call.action.tool === "inspect_nodes" &&
              item.success && item.data
            ) {
              const verifiedTarget = editTargetFromInspection(task, entry, item.data);
              if (verifiedTarget) task.editTarget = verifiedTarget;
            }
            entry.output = JSON.stringify(payload);
            if (entry.output.length > 7_500) {
              const nodes = item.data?.nodes;
              if (entry.call.action.tool === "inspect_nodes" && Array.isArray(nodes)) {
                const compactEvidence = inspectEvidenceTree(nodes).nativeEvidence;
                entry.output = JSON.stringify({
                  ...payload,
                  data: {
                    pageId: item.data?.pageId,
                    nodes: JSON.parse(compactEvidence),
                  },
                });
              } else if (entry.call.action.tool === "get_document_context") {
                const source = item.data ?? {};
                const discovery = source.discovery as Record<string, unknown> | undefined;
                const frameFields = [
                  "pageId",
                  "pageName",
                  "ref",
                  "nodeId",
                  "parentNodeId",
                  "type",
                  "name",
                  "x",
                  "y",
                  "width",
                  "height",
                  "parentName",
                  "depth",
                  "editable",
                  "visible",
                  "locked",
                  "nativeInspected",
                  "nativeInspection",
                  "projectName",
                ];
                const compactData = () => ({
                  ...(source.document ? { document: source.document } : {}),
                  ...(source.page ? { page: source.page } : {}),
                  pages: Array.isArray(source.pages)
                    ? source.pages.slice(0, 12).map((page) => {
                        if (!page || typeof page !== "object") return {};
                        const item = page as Record<string, unknown>;
                        return Object.fromEntries(
                          ["id", "name", "current"]
                            .filter((key) => item[key] !== undefined)
                            .map((key) => [key, item[key]]),
                        );
                      })
                    : [],
                  frames: Array.isArray(source.frames)
                    ? source.frames.slice(0, 8).map((frame) =>
                        frame && typeof frame === "object"
                          ? Object.fromEntries(
                              frameFields
                                .filter((field) => (frame as Record<string, unknown>)[field] !== undefined)
                                .map((field) => [field, (frame as Record<string, unknown>)[field]]),
                            )
                          : {},
                      )
                    : [],
                  discovery: discovery
                    ? Object.fromEntries(
                        [
                          "pagesVisited",
                          "pagesAvailable",
                          "scope",
                          "pagesRemaining",
                          "pagesLoaded",
                          "nodesVisited",
                          "nodesVisitedTotal",
                          "inspectionNodesVisited",
                          "framesDiscovered",
                          "framesInspected",
                          "framesReturned",
                          "nativeInspection",
                          "truncated",
                          "complete",
                          "continuationAvailable",
                          "truncationReason",
                          "inaccessiblePages",
                          "sliceCount",
                          "nodesPerSliceBudget",
                          "maxNodesPerSliceObserved",
                          "targetSliceMs",
                          "hardSliceMs",
                          "averageSliceMs",
                          "maxSliceMs",
                          "scanElapsedMs",
                          "pageLoadMs",
                          "cacheHit",
                          "cacheAgeMs",
                          "query",
                          "matchStatus",
                          "matchCount",
                          "exactNameMatchCount",
                          "returnedFrameCount",
                          "offset",
                          "sampleFramesTruncated",
                          "revalidatedAfterRestart",
                          "issues",
                        ]
                          .filter((field) => discovery[field] !== undefined)
                          .map((field) => [field, discovery[field]]),
                      )
                    : {},
                  ...(source.tokens ? { tokens: source.tokens } : {}),
                  ...(source.profiling ? { profiling: source.profiling } : {}),
                });
                const compactPayload = { ...payload, data: compactData() };
                while (
                  utf8Bytes(JSON.stringify(compactPayload)) > 7_500 &&
                  Array.isArray(compactPayload.data.frames) &&
                  compactPayload.data.frames.length > 1
                ) {
                  compactPayload.data.frames.pop();
                  const nextDiscovery = compactPayload.data.discovery;
                  if (nextDiscovery && typeof nextDiscovery === "object")
                    compactPayload.data.discovery = {
                      ...(nextDiscovery as Record<string, unknown>),
                      sampleFramesTruncated: true,
                      returnedFrameCount: compactPayload.data.frames.length,
                    };
                }
                entry.output = JSON.stringify(compactPayload);
              }
            }
            if (entry.output.length > 7_500)
              entry.output = JSON.stringify({ ...payload, data: undefined });
            failed ||= !item.success && item.acknowledgementStatus !== "not_attempted";
          }
          if (!failed && !limited) delete task.failure;
          await save();
          const repairVerificationStage = entries.find(
            (entry) => task.stages[entry.stage]?.repairVerificationPending,
          )?.stage;
          if (repairVerificationStage !== undefined)
            await inspectAfterQualityRepair(repairVerificationStage);
          check();
          if (limited) {
            task.failure = {
              category: "rate_limit",
              code: "local_tool_rate_limit",
              committedOperations: chatTaskCommittedOperationCount(task),
              operationId: entries[0]!.operationId,
            };
            if (++rateRetries > 2)
              throw new Error(
                "Local capacity is still busy. Resume after one minute; no confirmed work will be repeated.",
              );
            deps.progress(
              "Figma local rate limit reached; waiting one minute before retrying the same operation IDs…",
            );
            await wait(60_100, deps.signal);
            continue;
          }
          const stateFailureResult = result.results.find((item) => item.data?.toolStateDiagnostic);
          const stateDiagnostic = FigmaToolStateDiagnosticSchema.safeParse(
            stateFailureResult?.data?.toolStateDiagnostic,
          );
          if (stateDiagnostic.success) {
            const diagnostic = stateDiagnostic.data;
            task.failure = {
              category: "tool_state",
              code: toolStateFailureCode(diagnostic.category),
              phase:
                diagnostic.location === "migration"
                  ? "state_migration"
                  : diagnostic.location === "save"
                    ? "state_persistence"
                    : "state_loading",
              committedOperations: chatTaskCommittedOperationCount(task),
              ...(stateFailureResult ? { operationId: stateFailureResult.operationId } : {}),
              toolStateDiagnostic: diagnostic,
            };
          }
          const canContinueAfterPrePlanReadOnly =
            prePlanReadOnly &&
            calls.length > 0 &&
            !stateDiagnostic.success &&
            result.results.some((item) => !item.success);
          if (canContinueAfterPrePlanReadOnly) {
            for (const call of calls) {
              const entry = task.ledger.find((item) => item.call.callId === call.callId);
              if (!entry) continue;
              task.recent.push(
                output(call.callId, {
                  ...JSON.parse(entry.output ?? "{}"),
                  operationId: entry.operationId,
                  note: readOnly()
                    ? "Read-only discovery/inspection failed. No canvas mutation was attempted. Retry only the exact accessible target or report the inspection failure; never plan, reclassify intent, or invent verified results."
                    : "Optional pre-planning context/inspection failed; no canvas mutation was attempted. For a new design, plan with fresh task-local refs and ignore unrelated history. For an edit, use only refs from a successful inspection; retry the named target or explain why it cannot be resolved.",
                }),
              );
            }
            task.pending = [];
            await save();
            continueAfterPrePlanReadOnly = true;
            break;
          }
          if (failed) {
            const failedResult = result.results.find((item) => !item.success);
            const referenceResolution = failedResult?.data?.referenceResolution;
            const referenceResolutionCode =
              referenceResolution &&
              typeof referenceResolution === "object" &&
              "code" in referenceResolution
                ? referenceResolution.code
                : undefined;
            const hasReferenceResolutionFailure = Boolean(referenceResolution);
            const safeReferenceResolutionCode =
              typeof referenceResolutionCode === "string" &&
              SAFE_REFERENCE_CODES.has(referenceResolutionCode)
                ? referenceResolutionCode
                : undefined;
            if (!stateDiagnostic.success)
              task.failure = {
                category: hasReferenceResolutionFailure
                  ? "inspection"
                  : /rate limit/iu.test(failedResult?.error ?? "")
                    ? "rate_limit"
                    : /timed out/iu.test(failedResult?.error ?? "")
                      ? "timeout"
                      : /interrupted|reconcil|unconfirmed/iu.test(failedResult?.error ?? "")
                        ? "ambiguous_recovery"
                        : result.committedOperationIds.length ||
                            chatTaskCommittedOperationCount(task)
                          ? "partial_commit"
                          : activePhase === "inspection"
                            ? "inspection"
                            : /invalid|safety limit|must be unique|does not support|can only|requires|must use/iu.test(
                                  failedResult?.error ?? "",
                                )
                              ? "executor_validation"
                              : "figma_runtime",
                phase: hasReferenceResolutionFailure ? "inspection" : activePhase,
                code: hasReferenceResolutionFailure
                  ? "reference_resolution"
                  : activePhase === "inspection"
                    ? "inspection_failed"
                    : "native_operation_failed",
                committedOperations: chatTaskCommittedOperationCount(task),
                ...(failedResult ? { operationId: failedResult.operationId } : {}),
              };
            const failure = task.failure;
            if (!stateDiagnostic.success && failure)
              failure.code =
                safeReferenceResolutionCode ??
                {
                  ambiguous_recovery: "inspection_required",
                  rate_limit: "local_tool_rate_limit",
                  timeout: "native_operation_timeout",
                  cancelled: "request_cancelled",
                  partial_commit: "native_batch_partial_commit",
                  executor_validation: "executor_contract_rejected",
                  figma_runtime: "native_api_failed",
                  planning: "planning_failed",
                  verification: "verification_failed",
                  model_schema: "tool_arguments_invalid",
                  tool_state: "tool_state_invalid_schema",
                  checkpoint_storage: "checkpoint_save_failed",
                  inspection: "inspection_failed",
                  transport: "responses_transport_error",
                }[failure.category];
            for (const call of calls) {
              const entry = task.ledger.find((entry) => entry.call.callId === call.callId)!;
              if (entry.status === "pending") {
                entry.status = "failed";
                entry.acknowledgementStatus = "not_attempted";
                entry.output = JSON.stringify({
                  success: false,
                  acknowledgementStatus: "not_attempted",
                  error:
                    "Not attempted because an earlier operation failed. Repair the dependency and issue this action again with a new call ID.",
                  operationId: entry.operationId,
                });
              }
            }
            await save();
          }
          if (
            failed &&
            task.referenceCorrections < 2 &&
            result.results.some((item) => item.data?.referenceResolution)
          ) {
            guardRepeatedFailure(
              `reference:${JSON.stringify(result.results.flatMap((item) => (item.data?.referenceResolution ? [item.data.referenceResolution] : [])))}`,
            );
            task.referenceCorrections++;
            referenceCorrection = true;
            await save();
            break;
          }
          if (failed || (!result.success && !result.cancelled))
            throw new Error(
              result.results.find((item) => !item.success)?.error ??
                "Figma did not confirm this batch. Retry reconciles the same IDs; inspect possible partial changes.",
            );
          if (result.cancelled) throw new Error("Stopped between native operations.");
        }
        if (continueAfterPrePlanReadOnly) continue;
        const failed = calls.some(
          (call) =>
            task.ledger.find((entry) => entry.call.callId === call.callId)?.status === "failed",
        );
        if (failed && !wasRetry && !referenceCorrection)
          throw new Error(
            "The current stage has a failed operation. Retry Failed Stage to inspect and repair it; earlier changes are retained.",
          );
        for (const call of calls) {
          const entry = task.ledger.find((entry) => entry.call.callId === call.callId)!;
          task.recent.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({
              ...JSON.parse(entry.output ?? "{}"),
              operationId: entry.operationId,
              ...(prePlanReadOnly
                ? {
                  planningGuidance:
                      readOnly()
                        ? "Continue read-only discovery/inspection using exact refs and pageIds. Follow nextOffset for remaining matches. Once the returned frames are verified, report their names, locations and limits and finish with prose. No mutation plan is needed or allowed; do not classify intent again."
                        : "This was pre-planning read-only context. Continue to plan_canvas_task now. New designs need only fresh task-local aliases; edits must use exact refs returned by successful inspection.",
                  }
                : {}),
              ...(call.normalizedInspectionParameters && call.action.tool === "inspect_nodes"
                ? {
                    normalization: {
                      maxNodes: call.action.maxNodes,
                      depth: call.action.depth,
                      note: "Read-only inspection bounds were clamped locally; the 25-node exposure limit is unchanged.",
                    },
                  }
                : {}),
            }),
          });
        }
        task.pending = [];
        await save();
        continue;
      }
      check();
      const current = task.stages.find((stage) => !stage.completed);
      if (task.rounds >= 100)
        throw new Error(
          "The model-round budget was reached before the task could progress. Confirmed canvas work is retained; inspect the original planning or inspection failure before retrying.",
        );
      deps.progress(
        current
          ? `Continuing saved stage ${current.title}…`
          : task.stages.length
            ? "Checking completion against Figma confirmations…"
             : readOnly() ? "Inspecting existing canvas frames…" : "Planning bounded canvas stages…",
       );
      activePhase = readOnly() ? "inspection" : task.stages.length ? "native_execution" : "planning";
      const input = chatTaskInput(task);
      let turn: AuthorizedChatTurn | undefined;
      let turnDurationMs = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const modelStarted = now();
          turn = await deps.model(input, task.lifecycle);
          turnDurationMs = Math.max(0, now() - modelStarted);
          break;
        } catch (error) {
          if (
            deps.signal.aborted ||
            !(
              error &&
              typeof error === "object" &&
              "category" in error &&
              (error.category === "quota_or_rate_limit" || error.category === "inference_busy")
            ) ||
            attempt === 2
          )
            throw error;
          deps.progress("Model capacity is busy; waiting before continuing the saved stage…");
          task.roundBreakdown.modelRetries++;
          if (current) {
            current.roundBreakdown ??= roundBreakdown();
            current.roundBreakdown.modelRetries++;
          }
          await save();
          await wait(60_100 * (attempt + 1), deps.signal);
        }
      }
      if (!turn) throw new Error("No completed model response was received.");
      check();
      const hadPlan = task.stages.length > 0;
      task.rounds++;
      if (!hadPlan) task.roundBreakdown.prePlan++;
      const kind = roundKind(turn);
      task.roundBreakdown[kind]++;
      task.modelRoundTrace.push({
        round: task.rounds,
        lifecycle: task.lifecycle,
        outcome: turn.kind,
        tools: turn.kind === "tool_calls" ? turn.calls.map(({ name }) => name) : [],
        validationCodes: turn.kind === "tool_validation" ? turn.issues.slice(0, 8).map(({ errorCode }) => errorCode) : [],
        durationMs: turnDurationMs,
        ...(turn.timing ? { timing: turn.timing } : {}),
        inputBytes: utf8Bytes(JSON.stringify(input)),
      });
      if (current) {
        current.rounds++;
        current.roundBreakdown ??= roundBreakdown();
        current.roundBreakdown[kind]++;
      }
      if (turn.kind === "tool_validation") {
        const inspectionIssues = turn.issues.flatMap((issue) => {
          if (issue.toolName !== "inspect_nodes" || !issue.callId) return [];
          const field = issue.fieldPaths.includes("arguments.maxNodes")
            ? ("maxNodes" as const)
            : issue.fieldPaths.includes("arguments.depth")
              ? ("depth" as const)
              : undefined;
          if (!field) return [];
          const allowedErrorCodes = [
            "too_big",
            "too_small",
            "invalid_type",
            "invalid_format",
            "custom",
            "schema_validation",
          ] as const;
          const errorCode = allowedErrorCodes.includes(
            issue.errorCode as (typeof allowedErrorCodes)[number],
          )
            ? (issue.errorCode as (typeof allowedErrorCodes)[number])
            : "schema_validation";
          return [
            {
              callId: issue.callId,
              field,
              errorCode,
              ...(issue.receivedType ? { receivedType: issue.receivedType } : {}),
              ...(issue.receivedNumber ? { receivedNumber: issue.receivedNumber } : {}),
            },
          ];
        });
        task.failure = {
          category: "model_schema",
          code: "tool_arguments_invalid",
          committedOperations: chatTaskCommittedOperationCount(task),
          ...(inspectionIssues.length ? { inspectionIssues: inspectionIssues.slice(0, 8) } : {}),
        };
        guardRepeatedFailure(
          `model_schema:${JSON.stringify(turn.issues.map(({ toolName, stage, errorCode, fieldPaths }) => ({ toolName, stage, errorCode, fieldPaths })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))}`,
        );
        const details = turn.issues
          .slice(0, 8)
          .map((issue) => {
            const inspectionField =
              issue.toolName === "inspect_nodes"
                ? issue.fieldPaths.find(
                    (path) => path === "arguments.maxNodes" || path === "arguments.depth",
                  )
                : undefined;
            if (inspectionField) {
              const isMaxNodes = inspectionField === "arguments.maxNodes";
              const parameter = isMaxNodes ? "maxNodes" : "depth";
              const bounds = isMaxNodes
                ? INSPECT_NODES_LIMITS.maxNodes
                : INSPECT_NODES_LIMITS.depth;
              const received = issue.receivedType
                ? ` Received type ${issue.receivedType}${issue.receivedNumber ? ` (${issue.receivedNumber})` : ""}; no type conversion is performed.`
                : "";
              return `inspect_nodes${issue.callId ? ` (${issue.callId})` : ""}: arguments.${parameter} must be an integer from ${bounds.min}–${bounds.max} (omitted defaults to ${bounds.default}); finite numeric values outside that range are clamped locally, while invalid types and in-range fractions are rejected.${received}`;
            }
            if (issue.stage === "call_set" && issue.errorCode === "too_many_calls")
              return "tool-call set: one Responses reply contained more than 10 function calls; the whole reply was discarded before execution. Split the remaining work across replies, with at most 10 calls in each.";
            if (issue.stage === "call_set")
              return `tool-call set: ${issue.errorCode} at ${issue.fieldPaths.slice(0, 4).join(", ")}`;
            if (issue.errorCode === "unsupported_wrapper")
              return "model response: unsupported function-call wrapper; embedded calls were discarded and not executed.";
            return `${issue.toolName ?? "unknown tool"}${issue.callId ? ` (${issue.callId})` : ""}: ${issue.stage}/${issue.errorCode} at ${issue.fieldPaths
              .slice(0, 4)
              .map((path) => path.slice(0, 100))
              .join(", ")}`;
          })
          .join("; ");
        task.lastResponseCalls = 0;
        if (task.validationCorrections >= CHAT_TASK_MAX_VALIDATION_CORRECTIONS)
          throw new Error(
            `The model returned invalid canvas calls after ${CHAT_TASK_MAX_VALIDATION_CORRECTIONS} targeted corrections (${details.slice(0, 220)}). No calls from the rejected response were executed; ${retainedCanvasChanges(task)}.`,
          );
        task.validationCorrections++;
        task.validationFeedback =
          `The entire previous tool-call response was discarded before execution. Correct the listed fields and continue only the current unfinished stage from the saved checkpoint. Never regenerate a completed stage or repeat an operation already recorded as committed. Validation details: ${details}`.slice(
            0,
            7_500,
          );
        deps.progress(
          `Rejected model tool call${turn.issues.length === 1 ? "" : "s"} (${turn.issues
            .slice(0, 3)
            .map(({ toolName, stage, errorCode, fieldPaths }) =>
              stage === "call_set"
                ? `tool-call set: ${errorCode}`
                : `${toolName ?? "unknown"}: ${fieldPaths[0] ?? "arguments"}`,
            )
            .join(
              "; ",
            )}); none from this response executed. ${retainedCanvasChanges(task)} Requesting a bounded correction…`,
        );
        await save();
        continue;
      }
      if (turn.kind === "done") {
        delete task.validationFeedback;
        task.lastResponseCalls = 0;
        if (readOnly()) {
          const evidence = readOnlyCheckpoint(task);
          const lastDiscovery = evidence.discoveries.at(-1)?.discovery;
          const nativeInspection =
            lastDiscovery?.nativeInspection && typeof lastDiscovery.nativeInspection === "object"
              ? (lastDiscovery.nativeInspection as Record<string, unknown>)
              : undefined;
          if (
            !evidence.discoveries.length ||
            evidence.pendingOffsets.length ||
            evidence.uninspectedRefs.length ||
            (lastDiscovery?.complete === true && nativeInspection?.complete !== true)
          )
            throw new Error("Read-only inspection needs complete progressive coverage and verified native evidence before reporting success.");
        }
        if (task.intent === "edit" && !task.stages.length) {
          if (task.editTarget && (task.planningContinuations ?? 0) < 1) {
            task.planningContinuations = (task.planningContinuations ?? 0) + 1;
            transition("EDIT_PLANNING");
            task.recent = [{
              role: "user",
              content: "Your target is already discovered and natively inspected. Save the edit plan now by calling plan_canvas_task alone. Include targetRefs with the existing root ref and only the inspected refs you intend to modify. Keep every stage on the verified target page, preserve the root, and include actionable native mutations. Do not respond with final prose yet.",
            }];
            await save();
            continue;
          }
          await stopEdit(
            "edit_plan_missing",
            task.editTarget
              ? "The edit plan was not saved after one bounded planning continuation. The existing frame was inspected and no canvas changes were made."
              : "The edit request stopped before a verified target and plan were available. No canvas changes were made.",
            "planning",
          );
          return;
        }
        if (
          ["create", "edit", "continue"].includes(task.intent ?? "") &&
          !task.stages.length
        )
          throw new Error(
            `${task.intent} request has no saved canvas plan; it cannot be reported as completed. Retry the request so its native work can be planned.`,
          );
        if (task.stages.some((stage) => !stage.completed)) {
          guardRepeatedFailure("continuation:done_before_stages_complete");
          task.recent = [
            {
              role: "user",
              content:
                "Continue the current unfinished stage. Do not omit any planned content or claim completion. Call complete_canvas_stage only after its canvas operations are confirmed, then execute the next stage.",
            },
          ];
          await save();
          continue;
        }
        if (task.intent === "edit") {
          const report = editCompletionReport(task);
          if (!report) {
            await stopEdit(
              "native_execution_blocked",
              "No confirmed native edits were recorded, so the existing design cannot be reported as improved.",
              "verification",
            );
            return;
          }
          task.text = report;
        } else task.text = turn.text.slice(0, 8_000);
        transition("TASK_COMPLETED");
        task.status = "completed";
        delete task.failure;
        task.recent = [];
        await save();
        return;
      }
      delete task.validationFeedback;
      delete task.failure;
      const calls = turn.calls.map((rawCall) => {
        const call = ChatFunctionCallSchema.parse(rawCall);
        if (
          task.targetName &&
          call.action.tool === "get_document_context" &&
          !call.action.query
        )
          return {
            ...call,
            action: { ...call.action, query: task.targetName },
          };
        return call;
      });
      if (!calls.length || calls.length > 10)
        throw new Error("The model returned an invalid bounded stage.");
      const continuationStage = task.stages.findIndex((stage) => !stage.completed);
      const continuationRefs = chatTaskInspectedContinuationRefs(task, continuationStage);
      if (continuationRefs.size && calls.some(({ action }) =>
        (action.tool === "create_frame" || action.tool === "create_text" || action.tool === "create_rectangle") &&
        (!task.stages[continuationStage]?.logicalRefs.includes(action.ref) ||
          continuationRefs.has(action.ref) || action.parent.kind === "page"))) {
        await stopEdit("invalid_required_reference",
          "New layers in an existing design must use declared new refs and stay inside the existing screen.", "planning");
        return;
      }
      const reservations: string[] = [];
      if (task.intent === "edit" && task.stages.length && calls.some(({ action }) => isCanvasMutationTool(action.tool))) {
        const mutationCalls = calls.filter(({ action }) => isCanvasMutationTool(action.tool));
        const blocker = editMutationBlocker(
          task,
          mutationCalls as unknown as Array<{ action: FigmaToolAction }>,
          reservations,
        );
        if (blocker) {
          if (blocker.startsWith("duplicate_confirmed_operation")) {
            guardRepeatedFailure(`edit_duplicate_mutation:${blocker}`);
            for (const call of calls)
              task.recent.push(
                output(call.callId, {
                  success: false,
                  error: blocker.replace(/^duplicate_confirmed_operation:\s*/u, ""),
                  instruction:
                    "The already-confirmed native update was not replayed. Use the saved operation and fresh native verification to finish or identify a different unresolved change.",
                }),
              );
            task.pending = [];
            await save();
            continue;
          }
          const message = blocker.replace(/^[a-z_]+:\s*/u, "");
          const code = blocker.startsWith("edit_plan_invalid") ? "edit_plan_invalid" : "native_execution_blocked";
          task.editReferenceDiagnostic = message.slice(0, 500);
          if (code === "edit_plan_invalid" && editBatchCorrections++ < 2) {
            task.validationFeedback = `The entire batch was rejected before dispatch. ${message} Return a corrected batch in dependency order. Keep the existing frame and use the saved aliases for previously confirmed nodes.`;
            task.recent = [];
            await save();
            continue;
          }
          await stopEdit(code, message, "native_execution");
          return;
        }
      }
      if (task.intent === "edit" || task.intent === "continue") {
        const rootCreation = calls.find(
          ({ action }) =>
            ["create_frame", "create_text", "create_rectangle"].includes(action.tool) &&
            "parent" in action &&
            action.parent.kind === "page",
        );
        if (rootCreation)
          throw new Error(
            "Edit/continue intent cannot create a new page-root layer. Inspect and modify the verified existing frame; if no target exists, report the discovery blocker instead.",
          );
      }
      const awaitingRepair = task.stages.find((stage) => !stage.completed)?.awaitingQualityRepair;
      if (
        awaitingRepair &&
        calls.some((call) => isCanvasMutationTool(call.action.tool)) &&
        calls.length > 1
      ) {
        guardRepeatedFailure("quality_repair_requires_fresh_single_mutation_check");
        task.recent.push({
          role: "user",
          content:
            "Structural repair calls must contain exactly one native mutation and no other calls so the runner can re-inspect Figma immediately. Return only one targeted mutation for a currently listed ref.",
        });
        task.recent = task.recent.slice(-20);
        await save();
        continue;
      }
      const stage = task.stages.find((item) => !item.completed);
      if (stage && reservations.length) stage.logicalRefs.push(...reservations);
      task.pending = calls;
      task.lastResponseCalls = calls.length;
      task.recent = calls.map((call) => call.functionCall);
      await save();
    }
  } catch (error) {
    const transportCategory =
      error && typeof error === "object" && "category" in error ? String(error.category) : "";
    const isCancelled =
      deps.signal.aborted ||
      transportCategory === "request_cancelled" ||
      (error instanceof Error &&
        /^(?:Stopped|Stopped between native operations)/u.test(error.message));
    task.status = isCancelled ? "stopped" : "failed";
    task.error = isCancelled
      ? task.intent === "edit"
        ? "Edit cancelled. Verified target evidence and any confirmed native changes are retained."
        : "Inspection cancelled. Saved read-only evidence is retained."
      : (error instanceof Error ? error.message : "Stage failed safely.").slice(0, 500);
    if (readOnly() && isCancelled) {
      const checkpoint = readOnlyCheckpoint(task);
      task.inspectionOutcome = "CANCELLED";
      task.inspectionSummary = readOnlyInspectionSummary(task, checkpoint);
      task.text = readOnlyInspectionReport(
        task,
        checkpoint,
        "CANCELLED",
        "The request stopped before the remaining native inspection work completed.",
      );
    }
    if (task.intent === "edit" && isCancelled)
      task.text = `${task.error} Confirmed canvas mutations: ${chatTaskCommittedOperationCount(task)}. Resume to reconcile the saved edit checkpoint.`;
    const isTransportFailure =
      transportCategory === "responses_transport_error" ||
      transportCategory === "connection_failed" ||
      transportCategory === "service_unavailable";
    const requestDiagnostic = safeRequestDiagnostic(error);
    if (requestDiagnostic) task.lastRequestDiagnostic = requestDiagnostic;
    const checkpointCode =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    const thrownStateDiagnostic =
      error && typeof error === "object" && "diagnostic" in error
        ? FigmaToolStateDiagnosticSchema.safeParse(error.diagnostic)
        : undefined;
    if (thrownStateDiagnostic?.success) {
      const diagnostic = thrownStateDiagnostic.data;
      task.failure ??= {
        category: "tool_state",
        code: toolStateFailureCode(diagnostic.category),
        phase:
          diagnostic.location === "migration"
            ? "state_migration"
            : diagnostic.location === "save"
              ? "state_persistence"
              : "state_loading",
        committedOperations: chatTaskCommittedOperationCount(task),
        toolStateDiagnostic: diagnostic,
      };
    }
    const checkpointFailure = transportCategory === "checkpoint_storage";
    const phase = checkpointFailure
      ? "checkpoint"
      : isCancelled
        ? activePhase
        : transportCategory
          ? "transport"
          : activePhase;
    if (!task.failure || transportCategory || isCancelled)
      task.failure = {
        category: checkpointFailure
          ? "checkpoint_storage"
          : isCancelled
            ? "cancelled"
          : isTransportFailure
            ? "transport"
            : transportCategory === "quota_or_rate_limit" || transportCategory === "inference_busy"
              ? "rate_limit"
              : transportCategory === "request_timed_out" ||
                    /timed out|timeout/iu.test(task.error)
                  ? "timeout"
                  : transportCategory === "response_invalid"
                    ? "model_schema"
                    : /validation|Zod|bounded stage|invalid request/iu.test(task.error)
                      ? "executor_validation"
                      : /interrupted|reconcil|Lost.*result|Lost.*acknowledgement/iu.test(task.error)
                        ? "ambiguous_recovery"
                        : activePhase === "verification"
                          ? "verification"
                          : activePhase === "inspection"
                            ? "inspection"
                            : "planning",
        phase,
        code:
          isCancelled
            ? "request_cancelled"
            : checkpointFailure && checkpointCode && /^[a-z_]{1,80}$/u.test(checkpointCode)
            ? checkpointCode
            : /^[a-z_]{1,80}$/u.test(transportCategory)
              ? transportCategory
              : task.error.startsWith("native_verification_invalid")
                ? "native_verification_invalid"
                : task.error.startsWith("native_verification_capacity_exceeded")
                  ? "native_verification_capacity_exceeded"
                : task.error.startsWith("missing_creation_operation")
                  ? "missing_creation_operation"
                : task.error.startsWith("native_property_verification_failed")
                  ? "native_property_verification_failed"
                  : task.error.startsWith("missing_reference_inspection")
                    ? "missing_reference_inspection"
                    : task.error.startsWith("invalid_required_reference")
                      ? "invalid_required_reference"
                : task.error.startsWith("no_progress_repeated_error")
                  ? "no_progress_repeated_error"
                  : task.error.startsWith("Initial planning budget reached")
                    ? "planning_budget_exhausted"
                    : activePhase === "inspection"
                      ? "inspection_failed"
                      : activePhase === "verification"
                        ? "verification_failed"
                        : activePhase === "planning"
                          ? "planning_failed"
                          : "task_paused",
        committedOperations: chatTaskCommittedOperationCount(task),
        ...(isCancelled
          ? {
              cancellationSource: deps.signal.aborted
                ? "ui_abort"
                : transportCategory === "request_cancelled"
                  ? "unspecified"
                  : "native_batch_cancelled",
            }
          : {}),
      };
    if (task.error.startsWith("no_progress_repeated_error"))
      task.failure.code = "no_progress_repeated_error";
    if (!checkpointFailure) {
      try {
        await save();
      } catch {
        // Keep the original failure in memory when its checkpoint cannot be written.
      }
    }
    throw error;
  }
}

function retainedCanvasChanges(task: ChatTask): string {
  const count = chatTaskCommittedOperationCount(task);
  return count
    ? `${count} previously committed canvas operation${count === 1 ? " is" : "s are"} retained.`
    : "No canvas operations were committed before this response.";
}
