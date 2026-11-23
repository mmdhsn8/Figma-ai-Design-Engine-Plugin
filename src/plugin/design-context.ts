import {
  CONTEXT_LIMITS as limits, ContextNodeSchema, ContextResourceSchema, FW2_FEATURE, contextDigest, contextHash,
  contextFits, parseContextSnapshot, type ContextFailure, type ContextMetadata,
  type ContextResource, type DesignContextSnapshot,
} from "../shared/design-context";

export class ContextReadError extends Error {
  constructor(readonly code: ContextFailure) { super(code); }
}

export function colorHex(color: RGB): string {
  return "#" + [color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function solidPaint(paints: readonly Paint[] | symbol): SolidPaint | undefined {
  if (typeof paints === "symbol" || paints.length !== 1) return;
  const paint = paints[0];
  if (paint?.type !== "SOLID" || paint.visible === false || (paint.opacity ?? 1) !== 1 ||
    (paint.blendMode && paint.blendMode !== "NORMAL") || paint.boundVariables?.color) return;
  return paint;
}

export function solidColor(paints: readonly Paint[] | symbol): string | undefined {
  const paint = solidPaint(paints);
  return paint && colorHex(paint.color);
}

function roleHint(name: string | undefined, component = false): ContextResource["roleHint"] {
  // Report only an allowlisted hint, never the canvas label (which can contain private data).
  const match = name?.slice(0, 96).toLowerCase().match(component
    ? /\b(button|card|navigation|badge|icon|input)\b/u
    : /\b(primary|accent|surface|background|border|text|success|warning|error)\b/u);
  return match?.[1] as ContextResource["roleHint"];
}

export function componentResource(node: ComponentNode | ComponentSetNode): ContextResource {
  const color = solidColor(node.fills);
  const variant = node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET" ? node.variantProperties : null;
  const variantKeys = variant ? Object.keys(variant).sort() : [];
  const variantSignature = variantKeys.length && variantKeys.length <= 8 &&
    variantKeys.every((key) => key.length < 80 && (variant?.[key]?.length ?? 0) < 80)
    ? contextHash(JSON.stringify(variantKeys.map((key) => [key, variant?.[key]]))) : undefined;
  // Only exact, content-free silhouettes can replace a planned rectangle without bypassing contrast/text QA.
  const shape = node.type === "COMPONENT" && !node.remote && node.visible && !node.removed &&
    node.children.length === 0 && node.layoutMode === "NONE" && node.opacity === 1 &&
    ["NORMAL", "PASS_THROUGH"].includes(node.blendMode) && node.strokes.length === 0 && node.effects.length === 0 &&
    !node.isMask && !node.clipsContent && !node.fillStyleId && !node.strokeStyleId && !node.effectStyleId &&
    !Object.keys(node.boundVariables ?? {}).length && !node.reactions?.length && node.cornerSmoothing === 0 &&
    (node.parent?.type !== "COMPONENT_SET" || !!variantSignature) && Object.values(node.componentPropertyDefinitions ?? {}).every(({ type }) => type === "VARIANT") &&
    typeof node.cornerRadius === "number" && color
    ? [node.width, node.height, node.cornerRadius, color] as const : undefined;
  return {
    id: node.id, kind: node.type, origin: node.remote ? "remote" : "local",
    key: node.key || undefined, parentId: node.parent?.id,
    variantSetId: node.parent?.type === "COMPONENT_SET" ? node.parent.id : undefined,
    variantSignature,
    roleHint: node.remote ? undefined : roleHint(node.name, true),
    size: [node.width, node.height], ...(shape ? { shape: [...shape] } : {}),
  };
}

export function styleResource(style: BaseStyle): ContextResource | undefined {
  switch (style.type) {
    case "PAINT": case "TEXT": case "EFFECT": case "GRID": {
      const common = { id: style.id, kind: style.type, key: style.key || undefined, origin: style.remote ? "remote" as const : "local" as const };
      if (style.remote) return common;
      if (style.type === "PAINT") return { ...common, color: solidColor((style as PaintStyle).paints), roleHint: roleHint(style.name) };
      if (style.type === "TEXT") {
        const { family, style: weight } = (style as TextStyle).fontName;
        return { ...common, font: [family.slice(0, 64), weight.slice(0, 40)] };
      }
      return common;
    }
  }
}

export function variableResource(host: Variable, collection: VariableCollection): ContextResource {
  const modes = collection.modes.slice(0, 8).map(({ modeId }) => modeId);
  const value = host.valuesByMode[collection.defaultModeId];
  const local = !host.remote && !collection.remote;
  const color = local && host.resolvedType === "COLOR" && collection.modes.length === 1 &&
    value && typeof value === "object" && "r" in value && (!("a" in value) || value.a === 1) ? colorHex(value) : undefined;
  const filled = new Set<VariableScope>(["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL"]);
  const fillScopes = (host.scopes ?? []).filter((scope): scope is NonNullable<ContextResource["fillScopes"]>[number] => filled.has(scope)).sort();
  return {
    id: host.id, kind: "VARIABLE", origin: local ? "local" : "remote",
    key: host.key || undefined, collectionId: collection.id, modes, valueType: host.resolvedType, color,
    numberValue: local && collection.modes.length === 1 && typeof value === "number" ? value : undefined,
    fillScopes: local && color && host.scopes?.length ? fillScopes : undefined,
    roleHint: local ? roleHint(host.name) : undefined,
  };
}

function pickIds(values: readonly unknown[], max: number): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))].slice(0, max);
}

function summarize(node: SceneNode, order: number, depth: number) {
  const styleIds = pickIds(["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "gridStyleId"].map(
    (field) => (node as unknown as Record<string, unknown>)[field],
  ), 4);
  const variableIds: string[] = [];
  for (const binding of Object.values("boundVariables" in node ? node.boundVariables ?? {} : {})) {
    for (const alias of (Array.isArray(binding) ? binding.slice(0, 8) : [binding])) {
      if (alias && "id" in alias && typeof alias.id === "string" && !variableIds.includes(alias.id))
        variableIds.push(alias.id);
      if (variableIds.length === 8) break;
    }
    if (variableIds.length === 8) break;
  }
  const isText = node.type === "TEXT";
  const characters = isText ? node.characters : "";
  return ContextNodeSchema.safeParse({
    id: node.id, type: node.type, parentId: node.parent?.id ?? null, order, depth,
    bounds: [node.x, node.y, node.width, node.height], visible: node.visible,
    ...(styleIds.length ? { styleIds } : {}), ...(variableIds.length ? { variableIds } : {}),
    ...("clipsContent" in node ? { clip: node.clipsContent } : {}),
    ...("layoutMode" in node ? {
      layout: node.layoutMode,
      spacing: [node.itemSpacing, node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].every(Number.isFinite)
        ? [node.itemSpacing, node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft] : undefined,
    } : {}),
    ...("layoutSizingHorizontal" in node && node.layoutSizingHorizontal && node.layoutSizingVertical
      ? { sizing: [node.layoutSizingHorizontal, node.layoutSizingVertical] } : {}),
    ...(isText ? { text: {
      length: characters.length,
      directionHint: /[\u0590-\u08ff]/u.test(characters.slice(0, 256)) ? "rtl" : "unknown",
      align: node.textAlignHorizontal,
      font: typeof node.fontName === "object" ? [node.fontName.family.slice(0, 64), node.fontName.style.slice(0, 40)] : undefined,
      size: typeof node.fontSize === "number" ? node.fontSize : undefined, missingFont: node.hasMissingFont,
    } } : {}),
  });
}

export async function captureDesignContext(
  api: PluginAPI, scope: ContextMetadata["scope"],
  options: { stillCurrent?: () => boolean; cancelled?: () => boolean; catalog?: boolean } = {},
): Promise<DesignContextSnapshot> {
  const started = Date.now();
  const page = api.currentPage;
  const roots = scope === "page" ? page.children : page.selection;
  const rootSample = roots.slice(0, limits.roots);
  const identity = rootSample.map(({ id }) => id);
  const reasons = new Set<ContextMetadata["reasons"][number]>();
  let omitted = 0;
  const omit = (reason: ContextMetadata["reasons"][number], count = 1) => { reasons.add(reason); omitted += count; };
  const withinTime = () => {
    if (options.cancelled?.()) throw new ContextReadError("CANCELLED");
    if (api.currentPage.id !== page.id || options.stillCurrent?.() === false) throw new ContextReadError("STALE");
    if (scope !== "page" && (page.selection.length !== roots.length || identity.some((id, i) => page.selection[i]?.id !== id)))
      throw new ContextReadError("STALE");
    return Date.now() - started < limits.timeMs;
  };
  if (roots.length > rootSample.length) omit("ROOTS", roots.length - rootSample.length);
  const metadata: ContextMetadata = {
    schemaVersion: 1, feature: FW2_FEATURE, method: "figma-plugin-api", scope,
    pageId: page.id, documentKey: api.fileKey || undefined, roots: identity,
    nodes: [], resources: [], coverage: "complete", reasons: [], omitted: 0,
  };
  const resourceIds = new Set<string>();
  const addResource = (item: ContextResource | undefined) => {
    if (!item || resourceIds.has(item.id)) return;
    resourceIds.add(item.id);
    const valid = ContextResourceSchema.safeParse(item);
    if (!valid.success) { omit("UNSUPPORTED"); return; }
    if (metadata.resources.length === limits.resources) { omit("RESOURCES"); return; }
    metadata.resources.push(valid.data);
    if (!contextFits({ ...metadata, capturedAt: started, digest: "ctx1-00000000" })) {
      metadata.resources.pop();
      omit("BYTES");
    }
  };
  const pending = rootSample.map((node, order) => ({ node, parentId: node.parent?.id, order, depth: 0 })).reverse();
  const seen = new Set<string>();
  const styles = new Set<string>();
  const variables = new Set<string>();
  const instances: Array<{ node: InstanceNode; record: ContextMetadata["nodes"][number] }> = [];
  while (pending.length) {
    if (!withinTime()) { omit("TIME", pending.length); break; }
    if (seen.size === limits.nodes) { omit("NODES", pending.length); break; }
    const { node, parentId, order, depth } = pending.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (seen.size % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!withinTime()) { omit("TIME", pending.length + 1); break; }
    if (node.removed || !node.parent) { omit("UNAVAILABLE"); continue; }
    let boundary: BaseNode | null = node.parent;
    for (let i = 0; boundary && boundary.id !== page.id && boundary.type !== "PAGE" && i < 32; i++)
      boundary = boundary.parent;
    if (boundary?.id !== page.id || node.parent.id !== parentId) { omit("STALE"); continue; }
    const record = summarize(node, order, depth);
    if (!record.success) { omit("UNSUPPORTED"); continue; }
    metadata.nodes.push(record.data);
    if (!contextFits({ ...metadata, capturedAt: started, digest: "ctx1-00000000" })) {
      metadata.nodes.pop();
      omit("BYTES", pending.length + 1);
      break;
    }
    record.data.styleIds?.forEach((id) => styles.add(id));
    record.data.variableIds?.forEach((id) => variables.add(id));
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      try { addResource(componentResource(node)); } catch { omit("UNSUPPORTED"); }
    }
    if (node.type === "INSTANCE") instances.push({ node, record: record.data });
    // Instances may be backed by foreign masters: do not enumerate their expanded descendants.
    if (node.type !== "INSTANCE" && "children" in node && node.children.length) {
      const count = depth < limits.depth ? Math.min(node.children.length, limits.nodes - seen.size - pending.length) : 0;
      if (count < node.children.length) omit(depth < limits.depth ? "NODES" : "DEPTH", node.children.length - count);
      for (let i = count - 1; i >= 0; i--) pending.push({ node: node.children[i]!, parentId: node.id, order: i, depth: depth + 1 });
    } else if (node.type === "INSTANCE") reasons.add("UNSUPPORTED");
  }

  async function optional<T>(read: (() => Promise<T>) | undefined, consume: (value: T) => void) {
    if (!withinTime()) { omit("TIME"); return; }
    if (!read) { reasons.add("UNSUPPORTED"); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ContextReadError("TIMEOUT")), Math.max(1, limits.timeMs - (Date.now() - started))); }),
      ]);
      if (withinTime()) consume(value);
      else omit("TIME");
    } catch (error) {
      if (error instanceof ContextReadError && error.code !== "TIMEOUT") throw error;
      omit(error instanceof ContextReadError ? "TIME" : "UNAVAILABLE");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  for (const { node, record } of instances.slice(0, 4)) {
    await optional(node.getMainComponentAsync?.bind(node), (master) => {
      if (!master) { omit("UNAVAILABLE"); return; }
      if (/^[a-z0-9:;_.@/-]{1,160}$/iu.test(master.id)) record.mainComponentId = master.id;
      // Don't read foreign master structure or appearance, even if a selected instance references it.
      if (master.remote) addResource({ id: master.id, key: master.key, kind: "COMPONENT", origin: "remote" });
    });
  }
  if (instances.length > 4) omit("RESOURCES", instances.length - 4);
  const lookupStyles = [...styles].slice(0, 8);
  if (styles.size > lookupStyles.length) omit("RESOURCES", styles.size - lookupStyles.length);
  for (const id of lookupStyles)
    await optional(api.getStyleByIdAsync && (() => api.getStyleByIdAsync(id)), (style) =>
      style ? addResource(styleResource(style)) : omit("UNAVAILABLE"));
  const localVariables = new Map<string, Variable>();
  const lookupVariables = [...variables].slice(0, 8);
  if (variables.size > lookupVariables.length) omit("RESOURCES", variables.size - lookupVariables.length);
  for (const id of lookupVariables)
    await optional(api.variables?.getVariableByIdAsync && (() => api.variables.getVariableByIdAsync(id)), (item) =>
      item ? localVariables.set(item.id, item) : omit("UNAVAILABLE"));
  if (scope === "page" && options.catalog) {
    // Host catalog arrays are file-wide and unpaginated, so require a separate explicit catalog clause.
    for (const read of [api.getLocalPaintStylesAsync, api.getLocalTextStylesAsync, api.getLocalEffectStylesAsync, api.getLocalGridStylesAsync])
      await optional(read?.bind(api), (items: BaseStyle[]) => {
        if (items.length > 4) omit("RESOURCES", items.length - 4);
        items.slice(0, 4).forEach((style) => addResource(styleResource(style)));
      });
    await optional(api.variables?.getLocalVariablesAsync?.bind(api.variables), (items) => {
      if (items.length > 6) omit("RESOURCES", items.length - 6);
      items.slice(0, 6).forEach((item) => localVariables.set(item.id, item));
    });
  }
  for (const item of localVariables.values())
    await optional(api.variables?.getVariableCollectionByIdAsync && (() => api.variables.getVariableCollectionByIdAsync(item.variableCollectionId)),
      (collection) => {
        if (!collection) { omit("UNAVAILABLE"); return; }
        if (collection.modes.length > 8) omit("RESOURCES", collection.modes.length - 8);
        addResource(variableResource(item, collection));
      });
  withinTime();
  metadata.resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const seal = () => {
    metadata.reasons = [...reasons].sort();
    metadata.omitted = omitted;
    metadata.coverage = omitted ? "truncated" : reasons.size ? "sampled" : "complete";
    return { ...metadata, capturedAt: started, digest: contextDigest(metadata) };
  };
  let snapshot = seal();
  while (!contextFits(snapshot) && (metadata.resources.length || metadata.nodes.length)) {
    if (metadata.resources.length) metadata.resources.pop();
    else metadata.nodes.pop();
    omit("BYTES");
    snapshot = seal();
  }
  const valid = parseContextSnapshot(snapshot);
  if (!valid) throw new ContextReadError("INVALID");
  return valid;
}
