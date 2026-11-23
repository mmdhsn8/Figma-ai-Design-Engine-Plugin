import { FW7_BUILD_ID, FW7_DIAGNOSTICS_ENABLED, FW7_FEATURE_FLAGS } from "../shared/fw7-feature";
import { Fw7EventHub, exposeFw7DiagnosticsExport } from "../shared/fw7-observability";

export const fw7Telemetry = new Fw7EventHub({
  source: "ui",
  enabled: FW7_DIAGNOSTICS_ENABLED,
  buildId: FW7_BUILD_ID,
  featureFlags: FW7_FEATURE_FLAGS,
  observedCounters: ["uiPluginDispatches", "uiPluginAcksReceived", "cancellations"],
  clock: { monotonicNow: () => typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : undefined },
  log: (event) => console.info("[FW7_EVENT] " + JSON.stringify(event)),
});

if (FW7_DIAGNOSTICS_ENABLED)
  exposeFw7DiagnosticsExport(globalThis as unknown as Record<string, unknown>, () => fw7Telemetry.snapshot());
