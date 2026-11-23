import { describe, expect, it, vi } from "vitest";
import {
  Fw7EventHub,
  Fw7EventSchema,
  Fw7EventSourceSnapshotSchema,
  exposeFw7DiagnosticsExport,
} from "../src/shared/fw7-observability";

const flags = { fw2: false, fw3: false, fw4: false, fw5: false, fw5b: false, fw7: true };
const counters = ["figmaCreateCalls", "nativeReadbackOperations"] as const;

describe("FW-7 event contract", () => {
  it("keeps disabled diagnostics inert and creates no export hook", () => {
    const hub = new Fw7EventHub({ source: "plugin", enabled: false, buildId: "test-build", featureFlags: flags, observedCounters: [...counters] });
    expect(hub.record({ runId: "task-12345678", boundary: "figma-api", kind: "native_api_call", stage: "render", result: "started", counter: "figmaCreateCalls" })).toBeUndefined();
    expect(hub.snapshot()).toEqual([]);
    const target: Record<string, unknown> = {};
    expect(Object.prototype.hasOwnProperty.call(target, "__FW7_EXPORT_DIAGNOSTICS__")).toBe(false);
    exposeFw7DiagnosticsExport(target, () => hub.snapshot());
    expect(typeof target.__FW7_EXPORT_DIAGNOSTICS__).toBe("function");
  });

  it("reports observed zero separately from unobserved and bounds the event ring", () => {
    let tick = 0;
    const hub = new Fw7EventHub({ source: "plugin", enabled: true, buildId: "test-build", featureFlags: flags, observedCounters: [...counters], maxEvents: 2,
      clock: { monotonicNow: () => tick++, wallNow: () => 1_800_000_000_000 } });
    for (let index = 0; index < 3; index++) hub.record({ runId: "task-12345678", boundary: "figma-api", kind: "native_api_call", stage: "render", result: "started", counter: "figmaCreateCalls" });
    const snapshot = Fw7EventSourceSnapshotSchema.parse(hub.snapshot()[0]);
    expect(snapshot.eventCount).toBe(3);
    expect(snapshot.droppedEventCount).toBe(1);
    expect(snapshot.events.map(({ sequence }) => sequence)).toEqual([2, 3]);
    expect(snapshot.counters.figmaCreateCalls).toBe(3);
    expect(snapshot.counters.nativeReadbackOperations).toBe(0);
    expect(snapshot.counters.providerRequests).toBeNull();
  });

  it("rejects unknown fields and unsafe correlation text", () => {
    const hub = new Fw7EventHub({ source: "plugin", enabled: true, buildId: "test-build", featureFlags: flags, observedCounters: [...counters] });
    const event = hub.record({ runId: "task-12345678", boundary: "figma-api", kind: "native_api_call", stage: "render", result: "started", rootNodeHash: "not-a-hash" });
    expect(event).toBeUndefined();
    expect(() => Fw7EventSchema.parse({ schemaVersion: "fw7-event-v1", unknown: "x" })).toThrow();
  });

  it("uses null monotonic time when unavailable and keeps exports byte bounded", () => {
    const hub = new Fw7EventHub({ source: "ui", enabled: true, buildId: "test-build", featureFlags: flags, observedCounters: [],
      clock: { monotonicNow: () => undefined, wallNow: () => 1_800_000_000_000 } });
    hub.record({ runId: "task-12345678", boundary: "task-owner", kind: "task_started", stage: "run", result: "started" });
    expect(hub.snapshot()[0]?.events[0]?.monotonicMs).toBeNull();
    const target: Record<string, unknown> = {};
    exposeFw7DiagnosticsExport(target, () => hub.snapshot());
    const exportFn = target.__FW7_EXPORT_DIAGNOSTICS__ as () => string;
    expect(exportFn().length).toBeLessThanOrEqual(1_048_576);
    expect(JSON.parse(exportFn()).snapshots).toHaveLength(1);
  });

  it("runs in the plugin sandbox without Intl", () => {
    const hub = new Fw7EventHub({ source: "plugin", enabled: true, buildId: "test-build", featureFlags: flags, observedCounters: [] });
    vi.stubGlobal("Intl", undefined);
    try {
      hub.record({ runId: "task-12345678", boundary: "figma-api", kind: "native_readback_result", stage: "native_readback", result: "confirmed" });
      expect(Fw7EventSourceSnapshotSchema.parse(hub.snapshot()[0]).events).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
