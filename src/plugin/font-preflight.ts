import { isTokenReference } from "../shared/design-system-schema";
import type { DesignNode, DesignSpec } from "../shared/schema";
import type { MultiScreenSpec } from "../shared/multi-screen-schema";

export interface FontRequirement {
  family: string;
  style: string;
}

export interface AvailableFontName {
  family: string;
  style: string;
}

function styleForWeight(weight: number | undefined): string | undefined {
  if (weight === undefined) return undefined;
  const styles: Record<number, string> = {
    100: "Thin",
    200: "Extra Light",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "Semi Bold",
    700: "Bold",
    800: "Extra Bold",
    900: "Black",
  };
  return styles[weight];
}

function visitText(
  nodes: readonly DesignNode[],
  callback: (node: Extract<DesignNode, { type: "text" }>) => void,
): void {
  for (const node of nodes) {
    if (node.type === "text") callback(node);
    else if (node.type === "frame") visitText(node.children, callback);
  }
}

function componentDefinitions(spec: DesignSpec | MultiScreenSpec) {
  if ("screens" in spec) {
    return [...(spec.components ?? []), ...(spec.designSystem?.components ?? [])];
  }
  return [...(spec.document.components ?? []), ...(spec.designSystem?.components ?? [])];
}

export function collectFontRequirements(spec: DesignSpec | MultiScreenSpec): FontRequirement[] {
  const requirements = new Map<string, FontRequirement>();
  const add = (family: string, style: string) =>
    requirements.set(`${family}\u0000${style}`, { family, style });
  const typography = spec.designSystem?.typography ?? {};
  for (const token of Object.values(typography)) {
    add(token.fontFamily, token.fontStyle ?? styleForWeight(token.fontWeight) ?? "Regular");
  }
  const visit = (nodes: readonly DesignNode[]) => {
    visitText(nodes, (node) => {
      const token = isTokenReference(node.textStyle) ? typography[node.textStyle.token] : undefined;
      add(
        node.fontFamily ?? token?.fontFamily ?? "Inter",
        node.fontStyle ?? token?.fontStyle ?? styleForWeight(token?.fontWeight) ?? "Regular",
      );
    });
  };
  if ("screens" in spec) spec.screens.forEach((screen) => visit(screen.children));
  else visit(spec.document.children);
  for (const component of componentDefinitions(spec)) visit(component.children);
  return [...requirements.values()].sort((first, second) =>
    `${first.family}\u0000${first.style}`.localeCompare(
      `${second.family}\u0000${second.style}`,
      "en-US",
    ),
  );
}

export function unavailableFontWarnings(
  requirements: readonly FontRequirement[],
  available: readonly AvailableFontName[],
): string[] {
  const keys = new Set(available.map(({ family, style }) => `${family}\u0000${style}`));
  const warnings = requirements
    .filter(({ family, style }) => !keys.has(`${family}\u0000${style}`))
    .map(
      ({ family, style }) =>
        `Font “${family} ${style}” is unavailable in this Figma editor; generation will try Inter Regular and report any fallback.`,
    );
  if (
    requirements.some(({ family, style }) => !keys.has(`${family}\u0000${style}`)) &&
    !keys.has("Inter\u0000Regular")
  ) {
    warnings.push(
      "Inter Regular fallback is also unavailable; text generation may stop until a usable font is available.",
    );
  }
  return warnings;
}
