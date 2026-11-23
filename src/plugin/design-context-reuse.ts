import type { ContextResource, DesignContextSnapshot } from "../shared/design-context";
import { componentResource, solidColor, solidPaint, styleResource, variableResource } from "./design-context";

export const CONTEXT_COMPONENT_KEY = "fad.design.fw2-component.v1";
export const NATIVE_MASTER_KEY = "fad.design.native-master-id.v1";
export type ContextReuseFinding = {
  code: string; path: string; message: string; severity: "warning";
};

type RectangleTarget = { width: number; height: number; cornerRadius?: number; fill: string; visual?: unknown; stroke?: unknown };
type FillTarget = SceneNode & GeometryMixin;
const same = (a: ContextResource | undefined, b: ContextResource) =>
  !!a && (Object.keys(b) as (keyof ContextResource)[]).every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key])) &&
  Object.keys(a).every((key) => key in b || a[key as keyof ContextResource] === undefined);
const sameRgb = (a: RGB, b: RGB) => Math.abs(a.r - b.r) <= 0.000001 &&
  Math.abs(a.g - b.g) <= 0.000001 && Math.abs(a.b - b.b) <= 0.000001;

export async function prepareContextReuse(api: PluginAPI, snapshot: DesignContextSnapshot | undefined, current: () => boolean) {
  const findings: ContextReuseFinding[] = [];
  const report = (code: string, message: string, id = "context") => {
    if (findings.length < 12 && !findings.some((f) => f.code === code && f.path === id))
      findings.push({ code, path: id, message, severity: "warning" });
  };
  const components = new Map<string, ComponentNode>();
  async function boundedLookup<T>(deadline: number, read: () => Promise<T>): Promise<T | undefined> {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !current()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(), new Promise<undefined>((resolve) => { timer = setTimeout(resolve, remaining); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const resources = snapshot?.resources.filter(({ origin }) => origin === "local") ?? [];
  const isInScope = (node: ComponentNode) => {
    if (node.removed || !current() || api.currentPage.id !== snapshot?.pageId) return false;
    let ancestor: BaseNode | null = node;
    let inSelection = false;
    for (let i = 0; ancestor && i <= 32; i++, ancestor = ancestor.parent) {
      if (snapshot?.roots.includes(ancestor.id)) inSelection = true;
      if (ancestor.type === "PAGE") return ancestor.id === snapshot?.pageId &&
        (snapshot.scope === "page" || inSelection);
    }
    return false;
  };
  const componentDeadline = Date.now() + 1_000;
  if (current()) for (const entry of resources.filter(({ shape }) => !!shape)) {
    try {
      const node = await boundedLookup(componentDeadline, () => api.getNodeByIdAsync(entry.id));
      if (node?.type === "COMPONENT" && isInScope(node) && same(componentResource(node), entry))
        components.set(entry.id, node);
    } catch { /* Report only if the plan actually asks for this resource. */ }
  }

  function resolveRectangle(spec: RectangleTarget): ComponentNode | undefined {
    if (spec.visual || spec.stroke) return;
    const shape = [spec.width, spec.height, spec.cornerRadius ?? 0, spec.fill.toUpperCase()];
    const matches = resources.filter((entry) => entry.shape && JSON.stringify(entry.shape) === JSON.stringify(shape));
    if (matches.length > 1) {
      report("fw2_component_ambiguous", "Several local components match this shape; retained the editable planned rectangle.");
      return;
    }
    const entry = matches[0];
    if (!entry) return;
    const node = components.get(entry.id);
    try {
      if (node && isInScope(node) && same(componentResource(node), entry) && typeof node.createInstance === "function") {
        const paint = solidPaint(node.fills);
        const hex = spec.fill;
        if (paint && sameRgb(paint.color, { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 })) return node;
      }
    } catch { /* A detached or unsupported host component is not reusable. */ }
    report("fw2_component_stale", "The local component moved, changed or became inaccessible; retained the editable planned rectangle.", entry.id);
  }

  function instantiateRectangle(spec: RectangleTarget) {
    const component = resolveRectangle(spec);
    if (!component) return;
    try {
      return { instance: component.createInstance(), masterId: component.id };
    } catch {
      report("fw2_component_unavailable", "Figma did not create the requested local instance; retained the editable planned rectangle.", component.id);
    }
  }

  async function bindFills(root: FrameNode, assertWriteScope: () => void) {
    if (!resources.some(({ kind, color }) => !!color && (kind === "PAINT" || kind === "VARIABLE"))) return 0;
    const queue: SceneNode[] = [root];
    const paintCache = new Map<string, Promise<BaseStyle | null>>();
    const variableCache = new Map<string, Promise<Variable | null>>();
    const deadline = Date.now() + 1_000;
    let confirmed = 0;
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]!;
      if (node.type === "INSTANCE") continue;
      if ("children" in node) for (const child of node.children) {
        if (queue.length === 200) break;
        queue.push(child);
      }
    }
    const withinRoot = (target: SceneNode) => {
      let cursor: BaseNode | null = target;
      for (let i = 0; cursor && i <= 16; i++, cursor = cursor.parent)
        if (cursor === root) return true;
      return false;
    };
    for (const node of queue) {
      if (node.type === "INSTANCE") continue;
      if (!("fills" in node) || node.removed) continue;
      const target = node as FillTarget;
      const color = solidColor(target.fills);
      if (!color) continue;
      const previous = target.fills as readonly SolidPaint[];
      const previousStyle = typeof target.fillStyleId === "string" ? target.fillStyleId : undefined;
      const requiredScope = target.type === "TEXT" ? "TEXT_FILL" : target.type === "FRAME" ? "FRAME_FILL" : "SHAPE_FILL";
      const variables = resources.filter((entry) => entry.kind === "VARIABLE" && entry.color === color &&
        (!entry.fillScopes || entry.fillScopes.some((scope) => scope === "ALL_SCOPES" || scope === "ALL_FILLS" || scope === requiredScope)));
      const styles = resources.filter((entry) => entry.kind === "PAINT" && entry.color === color);
      const preferred = target.fillStyleId ? styles : variables.length ? variables : styles;
      if (preferred.length !== 1) {
        if (preferred.length > 1) report("fw2_token_ambiguous", "Multiple local tokens matched; retained the planned fill.");
        continue;
      }
      const entry = preferred[0]!;
      const fail = () => report("fw2_token_unresolved", "The local token was stale, incompatible or unavailable; reuse was not confirmed.", entry.id);
      if (!current()) { fail(); continue; }
      let apply: (() => Promise<boolean>) | undefined;
      try {
        if (entry.kind === "PAINT" && typeof target.setFillStyleIdAsync === "function") {
          const style = await boundedLookup(deadline, () => {
            if (!paintCache.has(entry.id)) paintCache.set(entry.id, api.getStyleByIdAsync(entry.id));
            return paintCache.get(entry.id)!;
          });
          if (style && same(styleResource(style), entry) &&
            sameRgb(((style as PaintStyle).paints[0] as SolidPaint).color, previous[0]!.color)) apply = async () => {
            await target.setFillStyleIdAsync(style.id);
            const paint = solidPaint(target.fills);
            return target.fillStyleId === style.id && !!paint && sameRgb(paint.color, previous[0]!.color);
          };
        } else if (entry.kind === "VARIABLE" && api.variables?.setBoundVariableForPaint) {
          const variable = await boundedLookup(deadline, () => {
            if (!variableCache.has(entry.id)) variableCache.set(entry.id, api.variables.getVariableByIdAsync(entry.id));
            return variableCache.get(entry.id)!;
          });
          const collection = variable ? await boundedLookup(deadline, () => api.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)) : null;
          if (variable && collection && same(variableResource(variable, collection), entry)) apply = async () => {
            const resolved = variable.resolveForConsumer(target).value;
            if (!resolved || typeof resolved !== "object" || !("r" in resolved) ||
              !("fills" in target) || typeof target.fills === "symbol") return false;
            const paint = target.fills[0];
            if (paint?.type !== "SOLID" || !sameRgb(resolved, paint.color) ||
              ("a" in resolved && resolved.a !== 1)) return false;
            const bound = api.variables.setBoundVariableForPaint(paint, "color", variable);
            if (bound.boundVariables?.color?.id !== variable.id) return false;
            target.fills = [bound];
            const actual = target.fills[0] as SolidPaint | undefined;
            return actual?.boundVariables?.color?.id === variable.id;
          };
        }
      } catch { fail(); continue; }
      assertWriteScope();
      const paint = solidPaint(target.fills);
      if (!apply || !current() || target.removed || !withinRoot(target) || !paint ||
        target.fillStyleId !== previousStyle || !sameRgb(paint.color, previous[0]!.color)) { fail(); continue; }
      let linked = false;
      try { linked = await apply(); } catch { /* A rejected setter may have partially applied; check below. */ }
      assertWriteScope();
      if (!withinRoot(target) || target.removed) throw new Error("fw2_token_target_moved");
      if (linked) confirmed++;
      else {
        fail();
        if (target.fillStyleId !== previousStyle && previousStyle) await target.setFillStyleIdAsync(previousStyle);
        else if (target.fillStyleId !== previousStyle || JSON.stringify(target.fills) !== JSON.stringify(previous)) target.fills = previous;
        assertWriteScope();
        const restored = solidPaint(target.fills);
        if (target.fillStyleId !== previousStyle || !restored ||
          !sameRgb(restored.color, previous[0]!.color)) throw new Error("fw2_token_fallback_unverified");
      }
    }
    return confirmed;
  }
  if (!current()) report("fw2_context_stale", "The approved design context expired or changed; no contextual reuse was applied.");
  return { findings, resolveRectangle, instantiateRectangle, bindFills };
}
