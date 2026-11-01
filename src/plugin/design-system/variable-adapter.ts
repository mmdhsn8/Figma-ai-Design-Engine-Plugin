export interface VariableCapabilityReport {
  availableInTypings: boolean;
  enabled: false;
  fallback: string;
}

/**
 * Starter variable creation is deliberately not invoked until it has been tested in the target
 * Figma Desktop context. API presence in typings alone does not prove an account/file capability.
 */
export function inspectVariableCapability(variableApi: unknown): VariableCapabilityReport {
  const api = variableApi as { createVariableCollection?: unknown } | undefined;
  const availableInTypings = typeof api?.createVariableCollection === "function";
  return {
    availableInTypings,
    enabled: false,
    fallback: availableInTypings
      ? "Starter variable creation has not been verified in Figma Desktop; numeric spacing and radius tokens are resolved values, not live variable bindings."
      : "The current Figma editor does not expose variable creation; spacing and radius tokens are resolved values.",
  };
}
