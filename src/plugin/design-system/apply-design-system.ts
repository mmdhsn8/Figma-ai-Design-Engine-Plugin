import type { DesignSpec } from "../../shared/schema";
import { MAX_DESIGN_SYSTEM_TOKEN_COUNT } from "../../shared/design-system-schema";

export interface DesignSystemDryRun {
  namespace: string;
  name: string;
  colors: number;
  typography: number;
  spacing: number;
  radii: number;
  borders: number;
  components: number;
  plannedPaintStyles: number;
  plannedTextStyles: number;
  plannedMasters: number;
  fallbacks: string[];
  message: string;
}

export function planDesignSystemApply(spec: DesignSpec): DesignSystemDryRun | undefined {
  const system = spec.designSystem;
  if (!system) return undefined;
  const colors = Object.keys(system.colors).length;
  const typography = Object.keys(system.typography).length;
  const spacing =
    (system.spacing?.scale.length ?? 0) + Object.keys(system.spacing?.aliases ?? {}).length;
  const radii = (system.radii?.scale.length ?? 0) + Object.keys(system.radii?.aliases ?? {}).length;
  const borders = Object.keys(system.borders).length;
  const components = system.components?.length ?? 0;
  const tokenCount = colors + typography + spacing + radii + borders;
  const fallbacks = [
    "Spacing, radius and border-width values resolve to numbers; they are not live variable bindings.",
    "Native component properties are not exposed as configurable variant properties; state-specific buttons are separate masters.",
  ];
  return {
    namespace: system.namespace,
    name: system.name,
    colors,
    typography,
    spacing,
    radii,
    borders,
    components,
    plannedPaintStyles: colors,
    plannedTextStyles: typography,
    plannedMasters: components,
    fallbacks,
    message: `Dry run: up to ${colors} paint styles, ${typography} text styles, and ${components} component masters (${tokenCount}/${MAX_DESIGN_SYSTEM_TOKEN_COUNT} tokens). Existing owned assets will be reused; only explicit safe style updates are applied.`,
  };
}
