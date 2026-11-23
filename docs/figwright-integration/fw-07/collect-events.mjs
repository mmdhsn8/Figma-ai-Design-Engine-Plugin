#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const MAX_BYTES = 1_048_576;
const SOURCES = ["ui", "companion", "plugin"];
const EVIDENCE = new Set(["LIVE_DESKTOP", "LOCAL_STUB", "FAKE_RUNTIME", "STATIC_ANALYSIS"]);
const FIXTURES = new Set(["F0", "F1", "F3", "F10", "FH", "FE"]);
const FLAGS = ["fw2", "fw3", "fw4", "fw5", "fw5b", "fw7"];
const COUNTERS = ["uiPluginDispatches", "pluginRequestsReceived", "pluginResponsesSent", "uiPluginAcksReceived", "figmaCreateCalls", "figmaObservedOperations", "figmaAppendCalls", "figmaResizeCalls", "figmaMetadataWrites", "figmaRemovalCalls", "figmaExportAsyncCalls", "nativeReadbackOperations", "checkpointStorageReads", "checkpointStorageWrites", "checkpointAcksSent", "providerRequests", "providerRetries", "providerResponses", "authorizationRefreshes", "visualReviewRequests", "visualReviewResponses", "cancellations"];
const EVENT_KEYS = ["schemaVersion", "runId", "sequence", "source", "boundary", "kind", "result", "stage", "operation", "attempt", "providerModel", "taskId", "taskGeneration", "screenId", "requestIdHash", "rootNodeHash", "checkpointRevisionHash", "checkpointBytes", "observedCount", "durationMs", "reasonCode", "monotonicMs", "wallClockMs", "timeOriginId"];
const REQUIRED_EVENT_KEYS = new Set(["schemaVersion", "runId", "sequence", "source", "boundary", "kind", "result", "stage", "monotonicMs", "wallClockMs", "timeOriginId"]);
const forbiddenKey = /(prompt|responseBody|cookie|credential|api.?key|access.?token|refresh.?token|account.?id|payload|png|imageData|layerText)/i;

function fail(message) { throw new Error(message); }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, allowed, label) {
  if (!plainObject(value)) fail(`${label} must be an object.`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) fail(`${label} contains unsupported field(s): ${extra.join(", ")}.`);
}
function safeKeys(value, at = "$") {
  if (Array.isArray(value)) return value.forEach((entry, index) => safeKeys(entry, `${at}[${index}]`));
  if (!plainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) fail(`Sensitive or raw-content key is disallowed at ${at}.${key}.`);
    safeKeys(child, `${at}.${key}`);
  }
}
function boundedText(value, pattern, label, max = 200) {
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) fail(`${label} is invalid.`);
}
function nullableString(value, pattern, label, max = 200) {
  if (value !== null) boundedText(value, pattern, label, max);
}

function validateManifest(manifest) {
  const allowed = new Set(["schemaVersion", "runId", "fixtureId", "source", "runStatus", "startedAtUtc", "expectedScreenCount", "buildIds", "modelProviderSlug", "liveAuthorization", "providerAuthorization", "authorizedFileLabel", "authorizedPageLabel", "fileIdHash", "pageIdHash", "featureFlags", "imageConsent", "notes"]);
  exactKeys(manifest, allowed, "manifest");
  if (manifest.schemaVersion !== "fw7-run-manifest-v1") fail("Unsupported manifest schemaVersion.");
  boundedText(manifest.runId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u, "manifest.runId", 120);
  if (!FIXTURES.has(manifest.fixtureId)) fail("manifest.fixtureId is unknown.");
  if (!EVIDENCE.has(manifest.source)) fail("manifest.source must be a declared evidence source.");
  if (!new Set(["UNSTARTED", "RUNNING", "PASS", "FAIL", "BLOCKED", "PARTIAL"]).has(manifest.runStatus)) fail("manifest.runStatus is invalid.");
  if (!new Set(["NOT_GRANTED", "GRANTED"]).has(manifest.liveAuthorization)) fail("manifest.liveAuthorization must be explicit.");
  if (!new Set(["NOT_REQUIRED", "NOT_GRANTED", "GRANTED"]).has(manifest.providerAuthorization)) fail("manifest.providerAuthorization must be explicit.");
  if (typeof manifest.startedAtUtc !== "string" || !Number.isFinite(Date.parse(manifest.startedAtUtc))) fail("manifest.startedAtUtc must be an ISO date string.");
  if (new Date(manifest.startedAtUtc).toISOString() !== manifest.startedAtUtc) fail("manifest.startedAtUtc must use canonical ISO UTC form.");
  if (!Number.isInteger(manifest.expectedScreenCount) || manifest.expectedScreenCount < 0 || manifest.expectedScreenCount > 10) fail("manifest.expectedScreenCount must be in 0..10.");
  if (!plainObject(manifest.buildIds)) fail("manifest.buildIds is required.");
  exactKeys(manifest.buildIds, new Set(SOURCES), "manifest.buildIds");
  for (const source of SOURCES) nullableString(manifest.buildIds[source], /^[A-Za-z0-9._:+-]{1,100}$/u, `manifest.buildIds.${source}`, 100);
  nullableString(manifest.modelProviderSlug, /^[A-Za-z0-9._:/-]{1,200}$/u, "manifest.modelProviderSlug", 200);
  nullableString(manifest.authorizedFileLabel, /^[A-Za-z0-9 ._-]{1,80}$/u, "manifest.authorizedFileLabel", 80);
  nullableString(manifest.authorizedPageLabel, /^[A-Za-z0-9 ._-]{1,80}$/u, "manifest.authorizedPageLabel", 80);
  if ([manifest.authorizedFileLabel, manifest.authorizedPageLabel].some((label) => typeof label === "string" && /test\s*shop|phase\s*1\s*storefront/i.test(label))) fail("Protected Test Shop material cannot be a live run fixture.");
  nullableString(manifest.fileIdHash, /^[a-f0-9]{16,64}$/u, "manifest.fileIdHash", 64);
  nullableString(manifest.pageIdHash, /^[a-f0-9]{16,64}$/u, "manifest.pageIdHash", 64);
  if (!plainObject(manifest.featureFlags)) fail("manifest.featureFlags is required.");
  exactKeys(manifest.featureFlags, new Set(FLAGS), "manifest.featureFlags");
  for (const flag of FLAGS) if (manifest.featureFlags[flag] !== null && typeof manifest.featureFlags[flag] !== "boolean") fail(`manifest.featureFlags.${flag} must be boolean or null.`);
  if (!plainObject(manifest.imageConsent)) fail("manifest.imageConsent is required.");
  exactKeys(manifest.imageConsent, new Set(["capture", "externalTransmission"]), "manifest.imageConsent");
  const consent = new Set(["NOT_APPLICABLE", "NOT_GRANTED", "GRANTED"]);
  if (!consent.has(manifest.imageConsent.capture) || !consent.has(manifest.imageConsent.externalTransmission)) fail("manifest.imageConsent values are invalid.");
  if (!Array.isArray(manifest.notes) || manifest.notes.length > 20 || manifest.notes.some((note) => typeof note !== "string" || note.length > 240)) fail("manifest.notes must contain at most 20 short strings.");
  safeKeys(manifest);
  return manifest;
}

function validateEvent(event, snapshot, previousSequence) {
  exactKeys(event, new Set(EVENT_KEYS), "event");
  for (const key of REQUIRED_EVENT_KEYS) if (!(key in event)) fail(`event.${key} is required.`);
  if (event.schemaVersion !== "fw7-event-v1") fail("Unsupported event schemaVersion.");
  boundedText(event.runId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u, "event.runId", 120);
  if (!Number.isInteger(event.sequence) || event.sequence <= previousSequence) fail("Event sequence must be positive and strictly increasing within a source run.");
  if (event.source !== snapshot.source || event.runId !== snapshot.runId || event.timeOriginId !== snapshot.timeOriginId) fail("Event source, runId, or clock origin differs from its snapshot.");
  const boundaries = new Set(["task-owner", "ui-plugin", "companion-provider", "figma-api", "checkpoint-owner", "visual-review"]);
  const kinds = new Set(["task_started", "task_stopped", "task_completed", "bridge_dispatch", "bridge_request_received", "bridge_response_sent", "bridge_ack_received", "native_render_started", "native_render_result", "native_root_attached", "native_readback_started", "native_readback_result", "native_api_call", "checkpoint_read_started", "checkpoint_read_result", "checkpoint_write_started", "checkpoint_write_result", "checkpoint_ack", "provider_request_started", "provider_request_result", "session_refresh", "visual_capture_started", "visual_capture_result", "visual_review_request_started", "visual_review_result", "visual_repair_result", "resume_reconcile", "cancellation"]);
  const results = new Set(["started", "received", "applied", "confirmed", "succeeded", "failed", "unverified", "cancelled", "unknown"]);
  if (!boundaries.has(event.boundary) || !kinds.has(event.kind) || !results.has(event.result)) fail("event boundary, kind, or result is invalid.");
  boundedText(event.stage, /^[a-z][a-z0-9_.-]{0,48}$/u, "event.stage", 49);
  for (const [field, regex, limit] of [["operation", /^[a-z][a-z0-9_.-]{0,64}$/u, 65], ["providerModel", /^[A-Za-z0-9._:/-]{1,200}$/u, 200], ["taskId", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u, 120], ["taskGeneration", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u, 120], ["screenId", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u, 80], ["requestIdHash", /^[a-f0-9]{16}$/u, 16], ["rootNodeHash", /^[a-f0-9]{16}$/u, 16], ["checkpointRevisionHash", /^[a-f0-9]{16}$/u, 16], ["reasonCode", /^[A-Za-z0-9_.:-]{1,80}$/u, 80]]) {
    if (event[field] !== undefined) boundedText(event[field], regex, `event.${field}`, limit);
  }
  for (const field of ["attempt", "checkpointBytes", "observedCount", "wallClockMs"]) if (event[field] !== undefined && (!Number.isInteger(event[field]) || event[field] < (field === "attempt" ? 1 : 0))) fail(`event.${field} must be a nonnegative integer.`);
  for (const field of ["durationMs"]) if (event[field] !== undefined && (!Number.isFinite(event[field]) || event[field] < 0)) fail(`event.${field} must be finite and nonnegative.`);
  if (event.attempt !== undefined && event.attempt > 10) fail("event.attempt exceeds 10.");
  if (event.checkpointBytes !== undefined && event.checkpointBytes > MAX_BYTES) fail("event.checkpointBytes exceeds the export limit.");
  if (event.observedCount !== undefined && event.observedCount > 100_000) fail("event.observedCount exceeds the event limit.");
  if (event.monotonicMs !== null && (!Number.isFinite(event.monotonicMs) || event.monotonicMs < 0)) fail("event.monotonicMs must be null or nonnegative.");
  if (!Number.isInteger(event.wallClockMs) || event.wallClockMs < 0) fail("event.wallClockMs must be a nonnegative integer.");
  boundedText(event.timeOriginId, /^[A-Za-z0-9_-]{8,48}$/u, "event.timeOriginId", 48);
  safeKeys(event);
  return event.sequence;
}

function validateSnapshot(snapshot) {
  const allowed = new Set(["schemaVersion", "source", "evidenceSource", "runId", "buildId", "timeOriginId", "featureFlags", "eventCount", "droppedEventCount", "events", "counters"]);
  exactKeys(snapshot, allowed, "snapshot");
  if (snapshot.schemaVersion !== "fw7-event-stream-v1" || !SOURCES.includes(snapshot.source) || snapshot.evidenceSource !== "UNCLASSIFIED") fail("Snapshot header is invalid.");
  boundedText(snapshot.runId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u, "snapshot.runId", 120);
  boundedText(snapshot.buildId, /^[A-Za-z0-9._:+-]{1,100}$/u, "snapshot.buildId", 100);
  boundedText(snapshot.timeOriginId, /^[A-Za-z0-9_-]{8,48}$/u, "snapshot.timeOriginId", 48);
  if (!plainObject(snapshot.featureFlags)) fail("snapshot.featureFlags is required.");
  exactKeys(snapshot.featureFlags, new Set(FLAGS), "snapshot.featureFlags");
  for (const flag of FLAGS) if (snapshot.featureFlags[flag] !== null && typeof snapshot.featureFlags[flag] !== "boolean") fail(`snapshot.featureFlags.${flag} must be boolean or null.`);
  if (!Number.isInteger(snapshot.eventCount) || snapshot.eventCount < 0 || !Number.isInteger(snapshot.droppedEventCount) || snapshot.droppedEventCount < 0) fail("Snapshot event counts are invalid.");
  if (!Array.isArray(snapshot.events) || snapshot.events.length > 256 || snapshot.eventCount !== snapshot.droppedEventCount + snapshot.events.length) fail("Snapshot event bounds/accounting are invalid.");
  if (!plainObject(snapshot.counters)) fail("snapshot.counters is required.");
  exactKeys(snapshot.counters, new Set(COUNTERS), "snapshot.counters");
  for (const counter of COUNTERS) {
    const value = snapshot.counters[counter];
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100_000)) fail(`snapshot.counters.${counter} must be null or a bounded integer.`);
  }
  let sequence = 0;
  for (const event of snapshot.events) sequence = validateEvent(event, snapshot, sequence);
  safeKeys(snapshot);
  return snapshot;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(manifest, snapshots) {
  const unique = new Set();
  for (const snapshot of snapshots) {
    const key = `${snapshot.source}|${snapshot.runId}`;
    if (unique.has(key)) fail(`Duplicate source/run snapshot: ${key}.`);
    unique.add(key);
    const declaredBuild = manifest.buildIds[snapshot.source];
    if (declaredBuild !== null && declaredBuild !== snapshot.buildId) fail(`Build identity mismatch for ${snapshot.source}.`);
  }
  const countersBySource = Object.fromEntries(SOURCES.map((source) => {
    const rows = snapshots.filter((snapshot) => snapshot.source === source);
    return [source, Object.fromEntries(COUNTERS.map((name) => {
      const values = rows.map((row) => row.counters[name]);
      return [name, values.length && values.every((value) => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null];
    }))];
  }));
  if (manifest.source === "LIVE_DESKTOP" && manifest.liveAuthorization !== "GRANTED") fail("LIVE_DESKTOP collection requires recorded authorization for an identified disposable page.");
  if (manifest.source === "LIVE_DESKTOP" && (!manifest.authorizedFileLabel || !manifest.authorizedPageLabel || !manifest.fileIdHash || !manifest.pageIdHash)) fail("LIVE_DESKTOP collection requires disposable file/page labels and redacted ID hashes.");
  const providerCount = snapshots.reduce((sum, snapshot) => sum + (snapshot.counters.providerRequests ?? 0) + (snapshot.counters.visualReviewRequests ?? 0), 0);
  const reviewCount = snapshots.reduce((sum, snapshot) => sum + (snapshot.counters.visualReviewRequests ?? 0), 0);
  const captureCount = snapshots.reduce((sum, snapshot) => sum + (snapshot.counters.figmaExportAsyncCalls ?? 0) + snapshot.events.filter((event) => event.kind === "visual_capture_started").length, 0);
  if (providerCount > 0 && manifest.providerAuthorization !== "GRANTED") fail("Observed provider requests require recorded provider authorization.");
  if (captureCount > 0 && manifest.imageConsent.capture !== "GRANTED") fail("Observed visual capture requires recorded capture consent.");
  if (reviewCount > 0 && manifest.imageConsent.externalTransmission !== "GRANTED") fail("Visual review provider requests require separate image transmission consent.");
  const origins = [...new Set(snapshots.map((snapshot) => snapshot.timeOriginId))];
  const byTask = new Map();
  for (const snapshot of snapshots) for (const event of snapshot.events) {
    if (!["task_started", "task_stopped", "task_completed"].includes(event.kind)) continue;
    const key = `${snapshot.source}|${event.taskId ?? event.runId}`;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(event);
  }
  const contradictions = [];
  for (const [task, events] of byTask) {
    let state = "unknown";
    for (const event of events) {
      if (event.kind === "task_started") {
        if (state === "active" || state === "completed") contradictions.push({ task, sequence: event.sequence, kind: event.kind, previous: state });
        state = "active";
      } else if (event.kind === "task_stopped") {
        if (state === "stopped" || state === "completed") contradictions.push({ task, sequence: event.sequence, kind: event.kind, previous: state });
        state = "stopped";
      } else {
        if (state === "stopped" || state === "completed") contradictions.push({ task, sequence: event.sequence, kind: event.kind, previous: state });
        state = "completed";
      }
    }
  }
  if (contradictions.length) fail(`Contradictory task transitions: ${JSON.stringify(contradictions.slice(0, 8))}`);
  const durationGroups = new Map();
  for (const snapshot of snapshots) for (const event of snapshot.events) if (event.durationMs !== undefined) {
    const key = `${snapshot.source}|${snapshot.timeOriginId}|${event.stage}`;
    if (!durationGroups.has(key)) durationGroups.set(key, { source: snapshot.source, timeOriginId: snapshot.timeOriginId, stage: event.stage, values: [] });
    durationGroups.get(key).values.push(event.durationMs);
  }
  const durations = [...durationGroups.values()].map(({ source, timeOriginId, stage, values }) => {
    const enough = values.length >= 3;
    return { source, timeOriginId, stage, sampleCount: values.length, medianMs: enough ? median(values) : null,
      p95Ms: enough ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null,
      reason: enough ? null : "INSUFFICIENT_SAMPLE" };
  });
  return {
    schemaVersion: "fw7-event-report-v1", runId: manifest.runId, fixtureId: manifest.fixtureId,
    evidenceSource: manifest.source, runStatus: manifest.runStatus, buildIds: manifest.buildIds,
    featureFlags: manifest.featureFlags, snapshotCount: snapshots.length,
    eventCount: snapshots.reduce((sum, snapshot) => sum + snapshot.eventCount, 0),
    sourcesSeen: [...new Set(snapshots.map((snapshot) => snapshot.source))], clockOrigins: origins,
    crossSourceClockSynchronization: origins.length <= 1 ? "single_origin" : "UNSYNCHRONIZED; do not subtract cross-origin timestamps",
    countersBySource, durations,
    limitations: ["No cross-process latency is calculated.", "A counter is null when its source did not observe it.", "Snapshots are local diagnostics and are not proof of Figma Desktop execution."],
  };
}

function parseOptions(args) {
  const output = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) fail(`Invalid option near ${key}.`);
    output[key.slice(2)] = args[++i];
  }
  return output;
}
function readBoundedJson(file) {
  const resolved = path.resolve(process.cwd(), file);
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_BYTES) fail(`Input exceeds ${MAX_BYTES} bytes: ${resolved}`);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "validate-events" && command !== "collect-events") {
    process.stdout.write("FW-7 local event collector\n  validate-events --manifest <file.json> --events <export.json> [--out <artifact.json>]\n");
    return;
  }
  const options = parseOptions(args);
  if (!options.manifest || !options.events) fail("Pass --manifest and --events.");
  const manifest = validateManifest(readBoundedJson(options.manifest));
  const input = readBoundedJson(options.events);
  exactKeys(input, new Set(["schemaVersion", "snapshots"]), "event export");
  if (input.schemaVersion !== "fw7-event-stream-v1" || !Array.isArray(input.snapshots)) fail("Event export header is invalid.");
  const snapshots = input.snapshots.map(validateSnapshot);
  const report = summarize(manifest, snapshots);
  const artifact = { schemaVersion: "fw7-collected-artifact-v1", collectedAtUtc: new Date().toISOString(), manifest, report, snapshots };
  const serialized = JSON.stringify(artifact, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) fail("Collected artifact exceeds the 1 MiB bound; export fewer source runs.");
  if (options.out) {
    const outputPath = path.resolve(process.cwd(), options.out);
    if (fs.existsSync(outputPath)) fail(`Refusing to overwrite existing artifact: ${outputPath}`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized, { flag: "wx" });
    process.stdout.write(JSON.stringify({ validation: "PASS", artifact: outputPath, runId: manifest.runId, evidenceSource: manifest.source, snapshots: snapshots.length, events: report.eventCount }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ validation: "PASS", runId: manifest.runId, evidenceSource: manifest.source, snapshots: snapshots.length, events: report.eventCount, countersBySource: report.countersBySource, durations: report.durations }) + "\n");
  }
}

main();
