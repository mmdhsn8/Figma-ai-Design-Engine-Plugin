import type { ResolvedComponentDefinition } from "./token-resolver";

export const COMPONENT_OWNER_KEY = "fad.design-system.component";
export const COMPONENT_FINGERPRINT_KEY = "fad.design-system.component-fingerprint";

export interface ComponentRegistryPage {
  findAll(predicate: (node: SceneNode) => boolean): SceneNode[];
}

export interface ExistingComponentRegistry {
  byComponentId: Map<string, ComponentNode>;
  byStableKey: Map<string, ComponentNode>;
  warnings: string[];
}

export function componentStableId(designSystemId: string, key: string): string {
  return `design-system:${designSystemId}:component:${key}`;
}

export function componentDefinitionFingerprint(definition: ResolvedComponentDefinition): string {
  return JSON.stringify({
    id: definition.id,
    key: definition.key,
    name: definition.name,
    width: definition.width,
    height: definition.height,
    background: definition.background,
    stroke: definition.stroke,
    cornerRadius: definition.cornerRadius,
    cornerRadii: definition.cornerRadii,
    layout: definition.layout,
    sizing: definition.sizing,
    variant: definition.variant,
    children: definition.children,
  });
}

export function readOwnedComponents(
  page: ComponentRegistryPage,
  designSystemId: string,
  definitions: ResolvedComponentDefinition[],
): ExistingComponentRegistry {
  const byComponentId = new Map<string, ComponentNode>();
  const byStableKey = new Map<string, ComponentNode>();
  const warnings: string[] = [];
  const ownedNodes = page.findAll(
    (node): node is ComponentNode =>
      node.type === "COMPONENT" &&
      node
        .getPluginData(COMPONENT_OWNER_KEY)
        .startsWith(`design-system:${designSystemId}:component:`),
  );

  for (const definition of definitions) {
    const stableId = componentStableId(designSystemId, definition.key ?? definition.id);
    const matches = ownedNodes.filter(
      (node) => node.getPluginData(COMPONENT_OWNER_KEY) === stableId,
    );
    const component = matches[0] as ComponentNode | undefined;
    if (matches.length > 1) {
      warnings.push(
        `Multiple owned masters were found for “${definition.key ?? definition.id}”; the first was reused and duplicates were left untouched.`,
      );
    }
    if (component) {
      byComponentId.set(definition.id, component);
      byStableKey.set(definition.key ?? definition.id, component);
    }
  }
  return { byComponentId, byStableKey, warnings };
}

export function markOwnedComponent(
  component: ComponentNode,
  designSystemId: string,
  definition: ResolvedComponentDefinition,
): void {
  component.setPluginData(
    COMPONENT_OWNER_KEY,
    componentStableId(designSystemId, definition.key ?? definition.id),
  );
  component.setPluginData(COMPONENT_FINGERPRINT_KEY, componentDefinitionFingerprint(definition));
}
