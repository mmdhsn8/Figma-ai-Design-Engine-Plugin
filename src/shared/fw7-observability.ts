import { z } from "zod";

export const FW7_EVENT_STREAM_SCHEMA_VERSION = "fw7-event-stream-v1" as const;
export const FW7_EVENT_SCHEMA_VERSION = "fw7-event-v1" as const;
export const FW7_EVENT_RING_LIMIT = 256;
export const FW7_EVENT_RUN_LIMIT = 8;
export const FW7_EVENT_STREAM_BYTE_LIMIT = 1_048_576;

export const FW7_EVENT_COUNTER_NAMES = [
  "uiPluginDispatches",
  "pluginRequestsReceived",
  "pluginResponsesSent",
  "uiPluginAcksReceived",
  "figmaCreateCalls",
  "figmaObservedOperations",
  "figmaAppendCalls",
  "figmaResizeCalls",
  "figmaMetadataWrites",
  "figmaRemovalCalls",
  "figmaExportAsyncCalls",
  "nativeReadbackOperations",
  "checkpointStorageReads",
  "checkpointStorageWrites",
  "checkpointAcksSent",
  "providerRequests",
  "providerRetries",
  "providerResponses",
  "authorizationRefreshes",
  "visualReviewRequests",
  "visualReviewResponses",
  "cancellations",
] as const;

export const Fw7EventSchema = z.object({
  schemaVersion: z.literal(FW7_EVENT_SCHEMA_VERSION),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u),
  sequence: z.number().int().positive(),
  source: z.enum(["ui", "companion", "plugin"]),
  boundary: z.enum(["task-owner", "ui-plugin", "companion-provider", "figma-api", "checkpoint-owner", "visual-review"]),
  kind: z.enum([
    "task_started", "task_stopped", "task_completed",
    "bridge_dispatch", "bridge_request_received", "bridge_response_sent", "bridge_ack_received",
    "native_render_started", "native_render_result", "native_root_attached", "native_readback_started", "native_readback_result",
    "native_api_call", "checkpoint_read_started", "checkpoint_read_result", "checkpoint_write_started",
    "checkpoint_write_result", "checkpoint_ack", "provider_request_started", "provider_request_result", "session_refresh",
    "visual_capture_started", "visual_capture_result", "visual_review_request_started",
    "visual_review_result", "visual_repair_result", "resume_reconcile", "cancellation",
  ]),
  result: z.enum(["started", "received", "applied", "confirmed", "succeeded", "failed", "unverified", "cancelled", "unknown"]),
  stage: z.string().regex(/^[a-z][a-z0-9_.-]{0,48}$/u),
  operation: z.string().regex(/^[a-z][a-z0-9_.-]{0,64}$/u).optional(),
  attempt: z.number().int().positive().max(10).optional(),
  providerModel: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/u).optional(),
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u).optional(),
  taskGeneration: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u).optional(),
  screenId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u).optional(),
  requestIdHash: z.string().regex(/^[a-f0-9]{16}$/u).optional(),
  rootNodeHash: z.string().regex(/^[a-f0-9]{16}$/u).optional(),
  checkpointRevisionHash: z.string().regex(/^[a-f0-9]{16}$/u).optional(),
  checkpointBytes: z.number().int().nonnegative().max(1_048_576).optional(),
  observedCount: z.number().int().nonnegative().max(100_000).optional(),
  durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
  reasonCode: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/u).optional(),
  monotonicMs: z.number().finite().nonnegative().nullable(),
  wallClockMs: z.number().int().nonnegative(),
  timeOriginId: z.string().regex(/^[A-Za-z0-9_-]{8,48}$/u),
}).strict();

export const Fw7EventCounterSchema = z.object(Object.fromEntries(
  FW7_EVENT_COUNTER_NAMES.map((name) => [name, z.number().int().nonnegative().nullable()]),
) as unknown as Record<(typeof FW7_EVENT_COUNTER_NAMES)[number], z.ZodType<number | null>>).strict();

export const Fw7EventSourceSnapshotSchema = z.object({
  schemaVersion: z.literal(FW7_EVENT_STREAM_SCHEMA_VERSION),
  source: z.enum(["ui", "companion", "plugin"]),
  evidenceSource: z.literal("UNCLASSIFIED"),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u),
  buildId: z.string().regex(/^[A-Za-z0-9._:+-]{1,100}$/u),
  timeOriginId: z.string().regex(/^[A-Za-z0-9_-]{8,48}$/u),
  featureFlags: z.object({
    fw2: z.boolean().nullable(),
    fw3: z.boolean().nullable(),
    fw4: z.boolean().nullable(),
    fw5: z.boolean().nullable(),
    fw5b: z.boolean().nullable(),
    fw7: z.boolean().nullable(),
  }).strict(),
  eventCount: z.number().int().nonnegative(),
  droppedEventCount: z.number().int().nonnegative(),
  events: z.array(Fw7EventSchema).max(FW7_EVENT_RING_LIMIT),
  counters: Fw7EventCounterSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.events.some((event) => event.source !== snapshot.source || event.runId !== snapshot.runId || event.timeOriginId !== snapshot.timeOriginId))
    context.addIssue({ code: "custom", path: ["events"], message: "Event source, run, and clock origin must match the stream." });
  if (snapshot.eventCount !== snapshot.droppedEventCount + snapshot.events.length)
    context.addIssue({ code: "custom", path: ["eventCount"], message: "Event count must equal dropped events plus retained events." });
});

export type Fw7Event = z.infer<typeof Fw7EventSchema>;
export type Fw7EventCounter = (typeof FW7_EVENT_COUNTER_NAMES)[number];
export type Fw7EventCounters = z.infer<typeof Fw7EventCounterSchema>;
export type Fw7EventSourceSnapshot = z.infer<typeof Fw7EventSourceSnapshotSchema>;
export type Fw7EventInput = Omit<Fw7Event, "schemaVersion" | "sequence" | "source" | "runId" | "monotonicMs" | "wallClockMs" | "timeOriginId"> & {
  runId: string;
  counter?: Fw7EventCounter;
  counterDelta?: number;
  counterDeltas?: Partial<Record<Fw7EventCounter, number>>;
};

export type Fw7EventHubOptions = {
  source: Fw7Event["source"];
  enabled: boolean;
  buildId: string;
  featureFlags: Fw7EventSourceSnapshot["featureFlags"];
  observedCounters: Fw7EventCounter[];
  maxEvents?: number;
  maxRuns?: number;
  clock?: { monotonicNow?: () => number | undefined; wallNow?: () => number };
  log?: (event: Fw7Event) => void;
};

type RunState = {
  sequence: number;
  events: Fw7Event[];
  counters: Fw7EventCounters;
};

type EventClock = { monotonicNow?: () => number | undefined; wallNow: () => number };

function safeHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return (left >>> 0).toString(16).padStart(8, "0") + (right >>> 0).toString(16).padStart(8, "0");
}

function clockOrigin(source: string, now: number): string {
  return safeHash(`${source}:${now}:${Math.random()}`).slice(0, 20);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export class Fw7EventHub {
  private readonly runs = new Map<string, RunState>();
  private readonly timeOriginId: string;
  private readonly maxEvents: number;
  private readonly maxRuns: number;
  private readonly observed = new Set<Fw7EventCounter>();
  private readonly clock: EventClock;
  private droppedRuns = 0;

  constructor(private readonly options: Fw7EventHubOptions) {
    const now = (options.clock?.wallNow ?? Date.now)();
    this.timeOriginId = clockOrigin(options.source, now);
    this.maxEvents = Math.min(FW7_EVENT_RING_LIMIT, Math.max(1, options.maxEvents ?? FW7_EVENT_RING_LIMIT));
    this.maxRuns = Math.min(FW7_EVENT_RUN_LIMIT, Math.max(1, options.maxRuns ?? FW7_EVENT_RUN_LIMIT));
    options.observedCounters.forEach((counter) => this.observed.add(counter));
    this.clock = { monotonicNow: options.clock?.monotonicNow, wallNow: options.clock?.wallNow ?? Date.now };
  }

  record(input: Fw7EventInput): Fw7Event | undefined {
    if (!this.options.enabled) return undefined;
    const runId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(input.runId) ? input.runId : undefined;
    if (!runId) return undefined;
    let state = this.runs.get(runId);
    if (!state) {
      if (this.runs.size >= this.maxRuns) {
        this.runs.delete(this.runs.keys().next().value as string);
        this.droppedRuns++;
      }
      state = { sequence: 0, events: [], counters: Object.fromEntries(FW7_EVENT_COUNTER_NAMES.map((name) => [name, this.observed.has(name) ? 0 : null])) as Fw7EventCounters };
      this.runs.set(runId, state);
    }
    state.sequence++;
    const monotonicMs = this.clock.monotonicNow?.();
    const eventInput: Fw7Event = {
      schemaVersion: FW7_EVENT_SCHEMA_VERSION,
      runId,
      sequence: state.sequence,
      source: this.options.source,
      boundary: input.boundary,
      kind: input.kind,
      result: input.result,
      stage: input.stage,
      ...(input.operation ? { operation: input.operation } : {}),
  ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  ...(input.providerModel ? { providerModel: input.providerModel } : {}),
      ...(input.taskId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(input.taskId) ? { taskId: input.taskId } : {}),
      ...(input.taskGeneration && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(input.taskGeneration) ? { taskGeneration: input.taskGeneration } : {}),
      ...(input.screenId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(input.screenId) ? { screenId: input.screenId } : {}),
      ...(input.requestIdHash ? { requestIdHash: input.requestIdHash } : {}),
      ...(input.rootNodeHash ? { rootNodeHash: input.rootNodeHash } : {}),
      ...(input.checkpointRevisionHash ? { checkpointRevisionHash: input.checkpointRevisionHash } : {}),
      ...(input.checkpointBytes !== undefined ? { checkpointBytes: input.checkpointBytes } : {}),
      ...(input.observedCount !== undefined ? { observedCount: input.observedCount } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      monotonicMs: monotonicMs !== undefined && Number.isFinite(monotonicMs) && monotonicMs >= 0 ? monotonicMs : null,
      wallClockMs: this.clock.wallNow(),
      timeOriginId: this.timeOriginId,
    };
    const parsed = Fw7EventSchema.safeParse(eventInput);
    if (!parsed.success) return undefined;
    state.events.push(parsed.data);
    if (state.events.length > this.maxEvents) state.events.shift();
    const increment = (counter: string, rawDelta: unknown) => {
      if (!FW7_EVENT_COUNTER_NAMES.includes(counter as Fw7EventCounter) || state!.counters[counter as Fw7EventCounter] === null) return;
      const delta = Number.isInteger(rawDelta) && Number(rawDelta) > 0 && Number(rawDelta) <= 1_000 ? Number(rawDelta) : 1;
      const name = counter as Fw7EventCounter;
      state!.counters[name] = (state!.counters[name] ?? 0) + delta;
    };
    if (input.counter) increment(input.counter, input.counterDelta);
    for (const [counter, delta] of Object.entries(input.counterDeltas ?? {})) increment(counter, delta);
    if (parsed.data.kind === "native_api_call" && parsed.data.boundary === "figma-api") increment("figmaObservedOperations", 1);
    this.options.log?.(parsed.data);
    return parsed.data;
  }

  snapshot(runId?: string): Fw7EventSourceSnapshot[] {
    const entries = [...this.runs.entries()].filter(([id]) => !runId || id === runId);
    return entries.map(([id, state]) => ({
      schemaVersion: FW7_EVENT_STREAM_SCHEMA_VERSION,
      source: this.options.source,
      evidenceSource: "UNCLASSIFIED",
      runId: id,
      buildId: this.options.buildId,
      timeOriginId: this.timeOriginId,
      featureFlags: this.options.featureFlags,
      eventCount: state.sequence,
      droppedEventCount: state.sequence - state.events.length,
      events: [...state.events],
      counters: { ...state.counters },
    }));
  }

  diagnostics(): { droppedRunCount: number; bufferedRunCount: number } {
    return { droppedRunCount: this.droppedRuns, bufferedRunCount: this.runs.size };
  }
}

export function fw7CorrelationHash(value: string | undefined): string | undefined {
  return value ? safeHash(value) : undefined;
}

/** Stable, content-free correlation ID for a native render adoption receipt. */
export function nativeRenderReceiptId(input: {
  requestId: string;
  taskId: string;
  screenId: string;
  rootNodeId: string;
  operationIds: readonly string[];
}): string {
  return `nrr-${safeHash([input.requestId, input.taskId, input.screenId, input.rootNodeId, ...input.operationIds].join("\u0000"))}`;
}

export function exposeFw7DiagnosticsExport(
  target: Record<string, unknown>,
  exportEvents: () => Fw7EventSourceSnapshot[],
): void {
  Object.defineProperty(target, "__FW7_EXPORT_DIAGNOSTICS__", {
    configurable: true,
    enumerable: false,
    value: (runId?: string) => {
      const snapshots = exportEvents().filter((snapshot) => !runId || snapshot.runId === runId)
        .map((snapshot) => ({ ...snapshot, events: [...snapshot.events] }));
      const serialize = () => JSON.stringify({ schemaVersion: FW7_EVENT_STREAM_SCHEMA_VERSION, snapshots });
      let output = serialize();
      while (utf8ByteLength(output) > FW7_EVENT_STREAM_BYTE_LIMIT) {
        const largest = snapshots.reduce<Fw7EventSourceSnapshot | undefined>((current, snapshot) =>
          !current || snapshot.events.length > current.events.length ? snapshot : current, undefined);
        if (!largest?.events.length) return JSON.stringify({ schemaVersion: FW7_EVENT_STREAM_SCHEMA_VERSION, error: "export_too_large" });
        largest.events.shift();
        largest.droppedEventCount++;
        output = serialize();
      }
      return output;
    },
  });
}
