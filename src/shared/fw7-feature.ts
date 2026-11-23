export const FW7_DIAGNOSTICS_FEATURE = "fw7-diagnostics-v1" as const;
export const FW7_DIAGNOSTICS_ENABLED = import.meta.env.VITE_FW7_DIAGNOSTICS === FW7_DIAGNOSTICS_FEATURE;
export const FW7_BUILD_ID = import.meta.env.VITE_FW7_BUILD_ID || "source-unknown";

const flag = (name: string, enabledValue: string): boolean | null => {
  const value = import.meta.env[name];
  return typeof value === "string" ? value === enabledValue : null;
};

const fw5Enabled = flag("VITE_FW5_VISUAL_QA", "fw5-visual-qa-v1");

export const FW7_FEATURE_FLAGS = {
  fw2: flag("VITE_FW2_CONTEXT", "fw2-context-v1"),
  fw3: flag("VITE_FW3_NATIVE_BATCH", "fw3-native-batch-v1"),
  fw4: flag("VITE_FW4_GEOMETRY", "fw4-geometry-v1"),
  fw5: fw5Enabled,
  fw5b: fw5Enabled === null ? null : fw5Enabled &&
    ["review", "review+bounded-repair"].includes(import.meta.env.VITE_FW5_VISUAL_QA_MODE ?? ""),
  fw7: FW7_DIAGNOSTICS_ENABLED,
} as const;
