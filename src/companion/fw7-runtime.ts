import { Fw7EventHub, exposeFw7DiagnosticsExport } from "../shared/fw7-observability.js";

const flag = (name: string, enabledValue: string): boolean | null => {
  const value = process.env[name];
  return value === undefined ? null : value === enabledValue;
};
const fw5Enabled = flag("VITE_FW5_VISUAL_QA", "fw5-visual-qa-v1");
export const FW7_DIAGNOSTICS_ENABLED = process.env.FW7_DIAGNOSTICS === "fw7-diagnostics-v1";

export const fw7Telemetry = new Fw7EventHub({
  source: "companion",
  enabled: FW7_DIAGNOSTICS_ENABLED,
  buildId: process.env.FW7_BUILD_ID || "companion-source-unknown",
  featureFlags: {
    fw2: flag("VITE_FW2_CONTEXT", "fw2-context-v1"),
    fw3: flag("VITE_FW3_NATIVE_BATCH", "fw3-native-batch-v1"),
    fw4: flag("VITE_FW4_GEOMETRY", "fw4-geometry-v1"),
    fw5: fw5Enabled,
    fw5b: fw5Enabled === null ? null : fw5Enabled &&
      ["review", "review+bounded-repair"].includes(process.env.VITE_FW5_VISUAL_QA_MODE ?? ""),
    fw7: FW7_DIAGNOSTICS_ENABLED,
  },
  observedCounters: ["providerRequests", "providerRetries", "providerResponses", "authorizationRefreshes", "visualReviewRequests", "visualReviewResponses"],
  clock: { monotonicNow: () => typeof performance?.now === "function" ? performance.now() : undefined },
  log: (event) => console.info("[FW7_EVENT] " + JSON.stringify(event)),
});

if (FW7_DIAGNOSTICS_ENABLED)
  exposeFw7DiagnosticsExport(globalThis as unknown as Record<string, unknown>, () => fw7Telemetry.snapshot());
