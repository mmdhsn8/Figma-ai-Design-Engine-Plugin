import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const collector = path.resolve("docs/figwright-integration/fw-07/collect-events.mjs");
const counterNames = ["uiPluginDispatches", "pluginRequestsReceived", "pluginResponsesSent", "uiPluginAcksReceived", "figmaCreateCalls", "figmaObservedOperations", "figmaAppendCalls", "figmaResizeCalls", "figmaMetadataWrites", "figmaRemovalCalls", "figmaExportAsyncCalls", "nativeReadbackOperations", "checkpointStorageReads", "checkpointStorageWrites", "checkpointAcksSent", "providerRequests", "providerRetries", "providerResponses", "authorizationRefreshes", "visualReviewRequests", "visualReviewResponses", "cancellations"];
const flags = { fw2: false, fw3: false, fw4: false, fw5: false, fw5b: false, fw7: true };

function fixture() {
  const events = [1, 2, 3, 4].map((sequence) => ({
    schemaVersion: "fw7-event-v1", runId: "fw7-test-run", sequence, source: "ui", boundary: "task-owner",
    kind: sequence === 1 ? "task_started" : "native_readback_result", result: sequence === 1 ? "started" : "confirmed",
    stage: sequence === 1 ? "universal" : "native_readback", monotonicMs: sequence * 10, wallClockMs: 1_800_000_000_000 + sequence,
    timeOriginId: "clockoriginui", ...(sequence > 1 ? { durationMs: sequence - 1, observedCount: 2 } : {}),
  }));
  return {
    manifest: {
      schemaVersion: "fw7-run-manifest-v1", runId: "operator-run-1", fixtureId: "F1", source: "FAKE_RUNTIME", runStatus: "PASS",
      startedAtUtc: "2026-11-23T07:00:00.000Z", expectedScreenCount: 1,
      buildIds: { ui: "test-build", companion: null, plugin: null }, modelProviderSlug: null,
      liveAuthorization: "NOT_GRANTED", providerAuthorization: "NOT_REQUIRED",
      authorizedFileLabel: "Fake runtime", authorizedPageLabel: "Synthetic page", fileIdHash: null, pageIdHash: null,
      featureFlags: flags, imageConsent: { capture: "NOT_APPLICABLE", externalTransmission: "NOT_APPLICABLE" }, notes: [],
    },
    events: {
      schemaVersion: "fw7-event-stream-v1",
      snapshots: [{ schemaVersion: "fw7-event-stream-v1", source: "ui", evidenceSource: "UNCLASSIFIED", runId: "fw7-test-run", buildId: "test-build", timeOriginId: "clockoriginui", featureFlags: flags, eventCount: 4, droppedEventCount: 0, events, counters: Object.fromEntries(counterNames.map((name) => [name, name === "uiPluginDispatches" ? 1 : null])) }],
    },
  };
}

function inTempFiles(files: Record<string, unknown>, run: (paths: Record<string, string>) => void) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, "fw7-collector-test-"));
  try {
    const paths = Object.fromEntries(Object.entries(files).map(([name, data]) => {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
      return [name, filePath];
    }));
    run(paths);
  } finally {
    const resolved = path.resolve(directory);
    const relative = path.relative(tempRoot, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

describe("FW-7 acceptance event collector", () => {
  it("validates bounded streams, leaves unobserved counters null, and limits p95 to three samples", () => {
    const sample = fixture();
    inTempFiles({ "manifest.json": sample.manifest, "events.json": sample.events }, (files) => {
      const output = execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8" });
      const report = JSON.parse(output) as { validation: string; countersBySource: { plugin: Record<string, number | null> }; durations: Array<{ sampleCount: number; medianMs: number | null; p95Ms: number | null }> };
      expect(report.validation).toBe("PASS");
      expect(report.countersBySource.plugin.providerRequests).toBeNull();
      expect(report.durations).toContainEqual(expect.objectContaining({ source: "ui", stage: "native_readback", sampleCount: 3, medianMs: 2, p95Ms: 3 }));
    });
  });

  it("rejects contradictory Stop-to-Completed transitions and unknown event fields", () => {
    const sample = fixture();
    const snapshot = sample.events.snapshots[0]!;
    snapshot.events[1] = { ...snapshot.events[1]!, kind: "task_stopped", result: "cancelled" };
    snapshot.events[2] = { ...snapshot.events[2]!, kind: "task_completed", result: "confirmed" };
    inTempFiles({ "manifest.json": sample.manifest, "events.json": sample.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });

    const invalid = fixture();
    (invalid.events.snapshots[0]!.events[0] as Record<string, unknown>).rawPrompt = "must never be exported";
    inTempFiles({ "manifest.json": invalid.manifest, "events.json": invalid.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });
  });

  it("requires live-file, provider, and image-capture authorization in the manifest", () => {
    const unauthorizedLive = fixture();
    unauthorizedLive.manifest.source = "LIVE_DESKTOP";
    unauthorizedLive.manifest.liveAuthorization = "NOT_GRANTED";
    unauthorizedLive.manifest.authorizedFileLabel = "Disposable test file";
    unauthorizedLive.manifest.authorizedPageLabel = "Acceptance page";
    Object.assign(unauthorizedLive.manifest, { fileIdHash: "1234567890abcdef", pageIdHash: "fedcba0987654321" });
    inTempFiles({ "manifest.json": unauthorizedLive.manifest, "events.json": unauthorizedLive.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });

    const providerWithoutConsent = fixture();
    providerWithoutConsent.manifest.providerAuthorization = "NOT_GRANTED";
    providerWithoutConsent.events.snapshots[0]!.source = "companion";
    providerWithoutConsent.events.snapshots[0]!.events = [];
    providerWithoutConsent.events.snapshots[0]!.eventCount = 0;
    providerWithoutConsent.events.snapshots[0]!.counters.providerRequests = 1;
    inTempFiles({ "manifest.json": providerWithoutConsent.manifest, "events.json": providerWithoutConsent.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });

    const captureWithoutConsent = fixture();
    captureWithoutConsent.events.snapshots[0]!.counters.figmaExportAsyncCalls = 1;
    inTempFiles({ "manifest.json": captureWithoutConsent.manifest, "events.json": captureWithoutConsent.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });

    const protectedPage = fixture();
    Object.assign(protectedPage.manifest, {
      source: "LIVE_DESKTOP", liveAuthorization: "GRANTED", authorizedFileLabel: "Disposable file",
      authorizedPageLabel: "Test Shop - Phase 1 Storefront", fileIdHash: "1234567890abcdef", pageIdHash: "fedcba0987654321",
    });
    inTempFiles({ "manifest.json": protectedPage.manifest, "events.json": protectedPage.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });

    const reviewWithoutTransmissionConsent = fixture();
    reviewWithoutTransmissionConsent.manifest.providerAuthorization = "GRANTED";
    const companionSnapshot = reviewWithoutTransmissionConsent.events.snapshots[0]!;
    companionSnapshot.source = "companion";
    companionSnapshot.events = [];
    companionSnapshot.eventCount = 0;
    companionSnapshot.counters.providerRequests = 1;
    companionSnapshot.counters.visualReviewRequests = 1;
    inTempFiles({ "manifest.json": reviewWithoutTransmissionConsent.manifest, "events.json": reviewWithoutTransmissionConsent.events }, (files) => {
      expect(() => execFileSync(process.execPath, [collector, "validate-events", "--manifest", files["manifest.json"]!, "--events", files["events.json"]!], { encoding: "utf8", stdio: "pipe" })).toThrow();
    });
  });
});
