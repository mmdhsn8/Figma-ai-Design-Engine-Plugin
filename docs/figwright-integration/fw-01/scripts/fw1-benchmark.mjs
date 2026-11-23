#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const fixturesDir = path.join(rootDir, "fixtures");
const runsDir = path.join(rootDir, "runs");
const fixtureIds = ["F0", "F1", "F3", "F10", "FH", "FE"];
const statuses = new Set(["PASS", "FAIL", "BLOCKED", "PARTIAL"]);
const variants = new Set(["ours", "figwright"]);
const notMeasured = "NOT MEASURED";
const forbiddenKey = /(prompt|response|cookie|credential|api.?key|access.?token|refresh.?token|account.?id|payload)/i;

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertSafeKeys(value, at = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeKeys(entry, at + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) fail("Sensitive or raw-payload key is disallowed at " + at + "." + key);
    assertSafeKeys(child, at + "." + key);
  }
}

function checkFixtures() {
  const checked = [];
  for (const fixtureId of fixtureIds) {
    const filePath = path.join(fixturesDir, fixtureId + ".json");
    if (!fs.existsSync(filePath)) fail("Missing fixture " + fixtureId + ".json");
    const fixture = readJson(filePath);
    if (fixture.fixtureId !== fixtureId) fail("Fixture ID mismatch in " + fixtureId + ".json");
    if (!Number.isInteger(fixture.requestedScreenCount) || fixture.requestedScreenCount < 0)
      fail("Invalid requestedScreenCount in " + fixtureId + ".json");
    if (!Array.isArray(fixture.screenRoles)) fail("screenRoles must be an array in " + fixtureId + ".json");
    if (fixture.screenRoles.length !== fixture.requestedScreenCount)
      fail("Requested screen count and role count differ in " + fixtureId + ".json");
    if (fixture.requestedScreenCount > 0 && typeof fixture.brief !== "string")
      fail("A screen fixture must contain its synthetic brief in " + fixtureId + ".json");
    checked.push({
      fixtureId,
      requestedScreenCount: fixture.requestedScreenCount,
      roleCount: fixture.screenRoles.length,
    });
  }
  return checked;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) fail("Expected an option, received " + key);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail("Missing value for " + key);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function metricDefaults() {
  return {
    setupMs: notMeasured,
    providerLatencyMs: notMeasured,
    planningMs: notMeasured,
    checkpointPersistenceMs: notMeasured,
    nativeExecutionMs: notMeasured,
    verificationMs: notMeasured,
    screenshotAndReviewMs: notMeasured,
    timeToFirstConfirmedEditableScreenMs: notMeasured,
    totalWallClockMs: notMeasured,
    providerCalls: notMeasured,
    providerRounds: notMeasured,
    mcpToolCalls: notMeasured,
    nativeBatches: notMeasured,
    nativeNodeCount: notMeasured,
    nativeComponentInstances: notMeasured,
    completedQaCoverage: notMeasured,
    recovery: notMeasured,
  };
}

function getRunOutputPath(value) {
  if (!value) fail("Pass --out with a JSON file under this FW-1 runs directory.");
  const outputPath = path.resolve(process.cwd(), value);
  const relative = path.relative(runsDir, outputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    fail("Run files must be placed inside " + runsDir);
  if (path.extname(outputPath).toLowerCase() !== ".json")
    fail("Run output must use the .json extension.");
  if (fs.existsSync(outputPath)) fail("Refusing to overwrite an existing run file: " + outputPath);
  return outputPath;
}

function commandNewRun(options) {
  const fixtureId = options.fixture;
  const variant = options.variant;
  if (!fixtureIds.includes(fixtureId)) fail("Unknown fixture ID: " + fixtureId);
  if (!variants.has(variant)) fail("--variant must be ours or figwright.");
  const fixture = readJson(path.join(fixturesDir, fixtureId + ".json"));
  const identities = readJson(path.join(rootDir, "build-identities.json"));
  const local = identities.primaryRepository;
  const upstream = identities.figwright;
  const outputPath = getRunOutputPath(options.out);
  const run = {
    schemaVersion: "fw1-run-v1",
    runId: randomUUID(),
    fixtureId,
    variant,
    status: "BLOCKED",
    principalFailureCategory: "MANUAL_OR_ENVIRONMENT_BLOCKER",
    evidenceLevel: notMeasured,
    startedAtUtc: "NOT STARTED",
    metadata: {
      codeRevision: local.commit,
      pluginBuildSha256: variant === "ours"
        ? local.artifacts.find((artifact) => artifact.path === "dist/plugin.js").sha256
        : upstream.releaseCommit,
      mcpVersion: variant === "figwright" ? upstream.mcpPackageVersion : "NOT APPLICABLE",
      modelProviderSlug: options.model ?? notMeasured,
      authorizedFileLabel: notMeasured,
      authorizedPageLabel: notMeasured,
      pluginRegistrationVerified: false,
      selectedModelVerified: false,
    },
    locale: fixture.locale,
    viewport: fixture.viewport,
    requestedScreenCount: fixture.requestedScreenCount,
    screenRoles: fixture.screenRoles,
    metrics: metricDefaults(),
    events: [],
    screens: fixture.screenRoles.map((screenId, index) => ({
      order: index + 1,
      screenId,
      rootNodeId: notMeasured,
      rootEvidence: notMeasured,
      nativeNodeCount: notMeasured,
      nativeComponentInstanceCount: notMeasured,
      geometryQa: notMeasured,
      qaCoverage: notMeasured,
      screenshotPath: notMeasured,
      humanVisualScore: "NOT REVIEWED",
    })),
    notes: [
      "Template only; no model call or Figma operation was made.",
      "Replace NOT MEASURED only with directly observed, sanitized evidence.",
    ],
  };
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(run, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: "CREATED", runId: run.runId, path: outputPath }) + "\n");
}

function assertRun(run) {
  if (!run || run.schemaVersion !== "fw1-run-v1") fail("Unsupported or missing run schemaVersion.");
  if (typeof run.runId !== "string" || !run.runId) fail("runId is required.");
  if (!fixtureIds.includes(run.fixtureId)) fail("Unknown fixtureId in run.");
  if (!variants.has(run.variant)) fail("variant must be ours or figwright.");
  if (!statuses.has(run.status)) fail("status must be PASS, FAIL, BLOCKED, or PARTIAL.");
  if (!Array.isArray(run.events) || !Array.isArray(run.screens)) fail("events and screens must be arrays.");
  if (!run.metrics || typeof run.metrics !== "object") fail("metrics object is required.");
  assertSafeKeys(run);
  const rootIds = run.screens
    .filter((screen) => screen.rootEvidence === "CONFIRMED_LIVE")
    .map((screen) => screen.rootNodeId);
  if (rootIds.some((id) => typeof id !== "string" || id === notMeasured))
    fail("A live-confirmed root must include its inspected native node ID.");
  if (new Set(rootIds).size !== rootIds.length)
    fail("Duplicate live-confirmed root IDs were found; preserve the run and mark it failed.");
  return run;
}

function confirmedLiveRoots(run) {
  return run.screens.filter((screen) =>
    screen.rootEvidence === "CONFIRMED_LIVE" &&
    typeof screen.rootNodeId === "string" &&
    screen.rootNodeId !== notMeasured
  ).length;
}

function commandValidateRun(filePath) {
  const run = assertRun(readJson(path.resolve(process.cwd(), filePath)));
  process.stdout.write(JSON.stringify({
    validation: "PASS",
    runId: run.runId,
    fixtureId: run.fixtureId,
    variant: run.variant,
    status: run.status,
    requestedScreens: run.requestedScreenCount,
    confirmedLiveRoots: confirmedLiveRoots(run),
    metrics: run.metrics,
  }, null, 2) + "\n");
}

function commandAggregate(options) {
  const fixtureFilter = options.fixture;
  const variantFilter = options.variant;
  if (fixtureFilter && !fixtureIds.includes(fixtureFilter)) fail("Unknown fixture ID: " + fixtureFilter);
  if (variantFilter && !variants.has(variantFilter)) fail("--variant must be ours or figwright.");
  const records = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter((name) => name.toLowerCase().endsWith(".json"))
    : [];
  const runs = records.map((name) => assertRun(readJson(path.join(runsDir, name))));
  const selected = runs.filter((run) =>
    (!fixtureFilter || run.fixtureId === fixtureFilter) &&
    (!variantFilter || run.variant === variantFilter)
  );
  const groups = new Map();
  for (const run of selected) {
    const model = run.metadata?.modelProviderSlug ?? notMeasured;
    const key = [run.fixtureId, run.variant, model].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const output = Array.from(groups.entries()).map(([key, group]) => {
    const successfulLive = group.filter((run) => run.status === "PASS" && run.evidenceLevel === "LIVE");
    const samples = successfulLive
      .map((run) => run.metrics.totalWallClockMs)
      .filter((value) => Number.isFinite(value));
    let timingSummary = "INSUFFICIENT SAMPLE";
    if (samples.length >= 3) {
      const sorted = [...samples].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      timingSummary = { medianMs: median, rangeMs: [sorted[0], sorted[sorted.length - 1]], sampleCount: samples.length };
    }
    return {
      group: key,
      runCount: group.length,
      runStatuses: group.map((run) => ({ runId: run.runId, status: run.status, evidenceLevel: run.evidenceLevel })),
      successfulLiveTimingSamples: samples,
      medianAndRange: timingSummary,
      p95: "NOT REPORTED",
      p99: "NOT REPORTED",
    };
  });
  process.stdout.write(JSON.stringify({ groups: output }, null, 2) + "\n");
}

async function commandSpan(options) {
  const filePath = options.run;
  const label = options.label;
  if (!filePath || !label) fail("Pass --run and --label.");
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const run = assertRun(readJson(resolvedPath));
  const startWall = new Date().toISOString();
  const start = process.hrtime.bigint();
  process.stdout.write("Timer armed for " + label + ". Press Enter when this stage ends.\n");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => input.once("line", resolve));
  input.close();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  const endWall = new Date().toISOString();
  run.events.push({
    sequence: run.events.length + 1,
    eventId: randomUUID(),
    correlationId: run.runId,
    processCorrelationId: randomUUID(),
    stage: options.stage ?? "manual",
    event: label,
    outcome: "OBSERVED",
    timingSource: "process.hrtime.bigint",
    startWallClockUtc: startWall,
    endWallClockUtc: endWall,
    elapsedMs,
    source: "HARNESS_TIMER",
  });
  fs.writeFileSync(resolvedPath, JSON.stringify(run, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId: run.runId, label, elapsedMs }) + "\n");
}

function help() {
  process.stdout.write(
    "FW-1 local collector\n" +
    "  diagnostics-only\n" +
    "  new-run --fixture F1 --variant ours --out docs/figwright-integration/fw-01/runs/F1-ours-001.json [--model provider/model-slug]\n" +
    "  span --run docs/figwright-integration/fw-01/runs/F1-ours-001.json --label task.total --stage native-execution\n" +
    "  validate-run docs/figwright-integration/fw-01/runs/F1-ours-001.json\n" +
    "  aggregate [--fixture F1] [--variant ours]\n"
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") return help();
  if (command === "diagnostics-only") {
    const fixtures = checkFixtures();
    process.stdout.write(JSON.stringify({
      status: "PASS",
      mode: "diagnostics-only",
      fixturesValidated: fixtures.length,
      fixtures,
      networkRequests: 0,
      providerCalls: 0,
      figmaReads: 0,
      figmaWrites: 0,
      filesWritten: 0,
    }, null, 2) + "\n");
    return;
  }
  if (command === "new-run") return commandNewRun(parseOptions(args));
  if (command === "validate-run") {
    if (args.length !== 1) fail("Pass exactly one run JSON path.");
    return commandValidateRun(args[0]);
  }
  if (command === "aggregate") return commandAggregate(parseOptions(args));
  if (command === "span") return commandSpan(parseOptions(args));
  fail("Unknown command: " + command);
}

main().catch((error) => {
  process.stderr.write("FW-1 collector error: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
