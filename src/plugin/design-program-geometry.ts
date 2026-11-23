import { childBoundsInParent, GEOMETRY_EPSILON, NATIVE_GEOMETRY_VERSION, overflowByEdge, type GeometryRect } from "../shared/native-geometry";
import type { ComponentDefinitionSpec, DesignNode } from "../shared/schema";
import type { VisualAsset } from "../shared/visual-schema";
import { hasArabicScript, hasUnrenderableProgramText, PERSIAN_FONT_FAMILIES } from "../shared/program-text";
import { CONTEXT_COMPONENT_KEY, NATIVE_MASTER_KEY } from "./design-context-reuse";
import { solidColor } from "./design-context";
import type { NativeLayoutExpectationV1, NativeSizingModeV1, NativeTextAutoResizeV1 } from "../shared/fw4-geometry";

export const PROGRAM_TASK_KEY = "fad.design.program-task.v1";
export const PROGRAM_FINGERPRINT_KEY = "fad.design.program-fingerprint.v1";
export const PROGRAM_GEOMETRY_KEY = "fad.design.geometry-receipt.v1";

export function canonicalProgramGeometryReceipt(value: string): string {
  return /^v1-[a-f0-9]{1,8}$/u.test(value) ? `v1-${value.slice(3).padStart(8, "0")}` : value;
}

export type ProgramGeometryFinding = {
  code: string;
  nodeId: string;
  parentId?: string;
  logicalRef?: string;
  expected?: GeometryRect;
  observed?: GeometryRect;
  expectedLayout?: { horizontalSizing: string; verticalSizing: string; textAutoResize?: string };
  observedLayout?: { horizontalSizing: string; verticalSizing: string; textAutoResize?: string };
};

export type ProgramGeometryReport = {
  version: typeof NATIVE_GEOMETRY_VERSION;
  coverage: "complete" | "incomplete";
  measuredNodes: number;
  durationMs: number;
  findings: ProgramGeometryFinding[];
};

/** Read native relationships through the async API required by dynamic-page manifests. */
export async function verifyProgramInstanceMasters(root: FrameNode): Promise<ProgramGeometryFinding[]> {
  const findings: ProgramGeometryFinding[] = [];
  const pending: SceneNode[] = [...root.children];
  let remaining = 300;
  while (pending.length && remaining-- > 0 && findings.length < 12) {
    const node = pending.pop()!;
    if (node.type === "INSTANCE") {
      const expected = node.getPluginData(NATIVE_MASTER_KEY);
      if (expected) {
        const actual = await node.getMainComponentAsync().catch(() => null);
        if (actual?.id !== expected)
          findings.push({ code: "native_instance_master_mismatch", nodeId: node.id, parentId: node.parent?.id });
      }
    }
    if ("children" in node) pending.push(...node.children);
  }
  return findings;
}

type ExpectedScreen = {
  width: number;
  height: number;
  scroll: boolean;
  children: readonly DesignNode[];
  assets: readonly VisualAsset[];
  compareText: boolean;
  components?: readonly ComponentDefinitionSpec[];
};

type LayoutSizingExpectation = {
  width: NativeSizingModeV1;
  height: NativeSizingModeV1;
  textAutoResize?: NativeTextAutoResizeV1;
};

function nativeSizingMode(mode: "fixed" | "hug" | "fill"): NativeSizingModeV1 {
  return mode.toUpperCase() as NativeSizingModeV1;
}

function actualLayoutSnapshot(node: SceneNode): { horizontalSizing: string; verticalSizing: string; textAutoResize?: string } | undefined {
  if (!("layoutSizingHorizontal" in node) || !("layoutSizingVertical" in node)) return undefined;
  return {
    horizontalSizing: String(node.layoutSizingHorizontal),
    verticalSizing: String(node.layoutSizingVertical),
    ...(node.type === "TEXT" ? { textAutoResize: String(node.textAutoResize) } : {}),
  };
}

function expectedLayoutSnapshot(expected: LayoutSizingExpectation): { horizontalSizing: string; verticalSizing: string; textAutoResize?: string } {
  return {
    horizontalSizing: expected.width,
    verticalSizing: expected.height,
    ...(expected.textAutoResize ? { textAutoResize: expected.textAutoResize } : {}),
  };
}

function isAutoLayoutParent(node: SceneNode | undefined): node is SceneNode & { layoutMode: string } {
  return Boolean(node && "layoutMode" in node && node.layoutMode !== "NONE");
}

const align = { start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN", stretch: "MIN", baseline: "BASELINE" } as const;

function nativeType(spec: DesignNode, assets: readonly VisualAsset[]): string {
  if (spec.type === "image") return assets.find(({ id }) => id === spec.assetId)?.kind === "svg-paths" ? "FRAME" : "RECTANGLE";
  return spec.type === "instance" ? "INSTANCE" : spec.type.toUpperCase();
}

export function inspectProgramGeometry(
  root: FrameNode,
  options: {
    taskId: string;
    pageId: string;
    expected?: ExpectedScreen;
    requireOwnership?: boolean;
    checkReceipt?: boolean;
    verifyLayoutSizing?: boolean;
    expectedLayout?: readonly NativeLayoutExpectationV1[];
  },
): ProgramGeometryReport & { receipt: string } {
  const started = Date.now();
  const findings: ProgramGeometryFinding[] = [];
  const append = (finding: ProgramGeometryFinding) => {
    if (findings.length < 12) findings.push(finding);
  };
  const visited = new Set<string>();
  let measuredNodes = 0;
  let incomplete = false;
  let hash = 0x811c9dc5;
  let legacyHash = 0x811c9dc5;
  const addToReceipt = (legacyValue: unknown, currentValue: unknown = legacyValue) => {
    const legacySerialized = JSON.stringify(legacyValue);
    for (let i = 0; i < legacySerialized.length; i++) legacyHash = Math.imul(legacyHash ^ legacySerialized.charCodeAt(i), 0x01000193);
    const serialized = JSON.stringify(currentValue);
    for (let i = 0; i < serialized.length; i++) hash = Math.imul(hash ^ serialized.charCodeAt(i), 0x01000193);
  };
  const expected = options.expected;
  const expectedLayoutByRef = new Map((options.expectedLayout ?? []).map((item) => [item.logicalRef, item]));
  const observedExpectedRefs = new Map<string, number>();
  const scroll = expected?.scroll ?? (root.overflowDirection === "VERTICAL");
  const record = (code: string, node: SceneNode, parent?: SceneNode, bounds?: { expected: GeometryRect; observed: GeometryRect }) =>
    append({ code, nodeId: node.id, ...(parent ? { parentId: parent.id } : {}), ...bounds });

  if (root.parent?.type !== "PAGE" || root.parent.id !== options.pageId)
    record("native_page_mismatch", root);
  if (expected && (Math.abs(root.width - expected.width) > GEOMETRY_EPSILON || Math.abs(root.height - expected.height) > GEOMETRY_EPSILON))
    record("native_viewport_mismatch", root, undefined, {
      expected: { x: 0, y: 0, width: expected.width, height: expected.height },
      observed: { x: 0, y: 0, width: root.width, height: root.height },
    });
  if (root.overflowDirection !== (scroll ? "VERTICAL" : "NONE") || (scroll && !root.clipsContent))
    record("native_scroll_mismatch", root);

  function visit(node: SceneNode, spec: DesignNode | undefined, parent: SceneNode | undefined, index: number, depth: number) {
    if (visited.size >= 300 || depth > 12 || visited.has(node.id)) {
      incomplete = true;
      record("native_coverage_incomplete", node, parent);
      return;
    }
    visited.add(node.id);
    const owner = node.getPluginData("fad.tool.task-id.v1");
    if ((owner && owner !== options.taskId) || (options.requireOwnership && owner !== options.taskId))
      record("native_ownership_conflict", node, parent);
    if (parent && node.parent?.id !== parent.id) record("native_parent_mismatch", node, parent);
    const contextualRectangle = spec?.type === "rectangle" && node.type === "INSTANCE" &&
      node.getPluginData(CONTEXT_COMPONENT_KEY) === "1" && Boolean(node.getPluginData(NATIVE_MASTER_KEY)) &&
      node.children.length === 0 && node.cornerRadius === (spec.cornerRadius ?? 0) &&
      typeof spec.fill === "string" && solidColor(node.fills) === spec.fill.toUpperCase();
    if (spec && ((!contextualRectangle && node.type !== nativeType(spec, expected!.assets)) ||
      ("logicalRef" in spec && spec.logicalRef !== node.getPluginData("fad.design.logical-ref"))))
      record("native_hierarchy_mismatch", node, parent);
    if (!node.absoluteTransform || !node.absoluteTransform.flat().every(Number.isFinite) ||
      !Number.isFinite(node.width) || !Number.isFinite(node.height)) {
      incomplete = true;
      record("native_measurement_unavailable", node, parent);
      return;
    }

    const local = parent ? childBoundsInParent(parent, node) : undefined;
    if (parent && !local) {
      incomplete = true;
      record("native_transform_unsupported", node, parent);
    } else {
      measuredNodes++;
    }
    if (parent && local) {
      const insets = "layoutMode" in parent && parent.layoutMode !== "NONE" &&
        (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE")
        ? { left: parent.paddingLeft, right: parent.paddingRight, top: parent.paddingTop, bottom: parent.paddingBottom }
        : undefined;
      const overflow = overflowByEdge(parent, local, insets);
      const svgCrop = parent.type === "FRAME" && parent.clipsContent && node.type === "VECTOR" &&
        Boolean(parent.getPluginData("fad.design.asset-id"));
      const verticalBody = scroll && parent === root && index === 0 && node.type === "FRAME";
      const expectedRect = { x: insets?.left ?? 0, y: insets?.top ?? 0, width: parent.width - (insets?.left ?? 0) - (insets?.right ?? 0), height: parent.height - (insets?.top ?? 0) - (insets?.bottom ?? 0) };
      if (!svgCrop && (overflow.left > GEOMETRY_EPSILON || overflow.right > GEOMETRY_EPSILON))
        record("native_horizontal_overflow", node, parent, { expected: expectedRect, observed: local });
      if (!svgCrop && (overflow.top > GEOMETRY_EPSILON || (!verticalBody && overflow.bottom > GEOMETRY_EPSILON)))
        record("native_vertical_overflow", node, parent, { expected: expectedRect, observed: local });
      // An absolute render AABB can be projected exactly only onto axis-aligned parent axes.
      // Text ink can extend past a fixed text box even when its content box passes containment.
      if (node.type === "TEXT" && !node.effects.some(({ visible }) => visible) &&
        parent.absoluteTransform[0][1] === 0 && parent.absoluteTransform[1][0] === 0) {
        const render = node.absoluteRenderBounds;
        if (render) {
          const ink = childBoundsInParent(parent, {
            width: render.width, height: render.height,
            absoluteTransform: [[1, 0, render.x], [0, 1, render.y]],
          });
          if (ink && Object.values(overflowByEdge(parent, ink)).some((amount) => amount > GEOMETRY_EPSILON))
            record("native_text_render_overflow", node, parent, { expected: { x: 0, y: 0, width: parent.width, height: parent.height }, observed: ink });
          if (!ink) {
            incomplete = true;
            record("native_text_bounds_unavailable", node, parent);
          }
        } else if (node.characters.trim() && node.getPluginData("fad.design.program-text.v1") === "1") {
          incomplete = true;
          record("native_text_bounds_unavailable", node, parent);
        }
      }
    }
    if (spec && "sizing" in spec && spec.sizing) {
      const sizing = spec.sizing;
      const bounds = [
        { actual: node.width, min: sizing.minWidth, max: sizing.maxWidth, fixed: sizing.width === "fixed" && "width" in spec ? spec.width : undefined },
        { actual: node.height, min: sizing.minHeight, max: sizing.maxHeight, fixed: sizing.height === "fixed" && "height" in spec && spec.type !== "text" && !(parent === root && scroll) ? spec.height : undefined },
      ];
      if (bounds.some(({ actual, min, max, fixed }) =>
        (min !== undefined && actual < min - GEOMETRY_EPSILON) ||
        (max !== undefined && actual > max + GEOMETRY_EPSILON) ||
        (typeof fixed === "number" && Math.abs(fixed - actual) > GEOMETRY_EPSILON)))
        record("native_size_mismatch", node, parent);
    }
    const verifyLayoutSizing = options.verifyLayoutSizing && Boolean(spec && "sizing" in spec && spec.sizing);
    const logicalRef = node.getPluginData("fad.design.logical-ref");
    const projectedExpectation = logicalRef ? expectedLayoutByRef.get(logicalRef) : undefined;
    const sizingExpectation: LayoutSizingExpectation | undefined = verifyLayoutSizing && spec && "sizing" in spec && spec.sizing
      ? {
          width: nativeSizingMode(spec.sizing.width),
          height: nativeSizingMode(spec.sizing.height),
          ...(spec.type === "text" && spec.textAutoResize === "width-and-height" ? { textAutoResize: "WIDTH_AND_HEIGHT" } :
            spec.type === "text" && spec.textAutoResize === "height" ? { textAutoResize: "HEIGHT" } : {}),
        }
      : projectedExpectation
        ? {
            width: projectedExpectation.horizontalSizing,
            height: projectedExpectation.verticalSizing,
            ...(projectedExpectation.textAutoResize ? { textAutoResize: projectedExpectation.textAutoResize } : {}),
          }
        : undefined;
    if (projectedExpectation && logicalRef) {
      observedExpectedRefs.set(logicalRef, (observedExpectedRefs.get(logicalRef) ?? 0) + 1);
      const actualParentRef = parent?.getPluginData("fad.design.logical-ref") ?? "";
      if (actualParentRef !== projectedExpectation.parentLogicalRef)
        append({ code: "native_layout_parent_mismatch", nodeId: node.id, parentId: parent?.id, logicalRef,
          expectedLayout: { horizontalSizing: projectedExpectation.horizontalSizing, verticalSizing: projectedExpectation.verticalSizing },
          ...(actualLayoutSnapshot(node) ? { observedLayout: actualLayoutSnapshot(node) } : {}) });
      if ((observedExpectedRefs.get(logicalRef) ?? 0) > 1)
        record("native_layout_reference_ambiguous", node, parent);
    }
    if (sizingExpectation) {
      const expectedSnapshot = expectedLayoutSnapshot(sizingExpectation);
      const actualSnapshot = actualLayoutSnapshot(node);
      const absolute = "layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE";
      if (absolute || !isAutoLayoutParent(parent)) {
        record("native_layout_parent_not_auto", node, parent);
      } else if (!actualSnapshot) {
        incomplete = true;
        append({ code: "native_layout_sizing_unavailable", nodeId: node.id, ...(parent ? { parentId: parent.id } : {}),
          ...(logicalRef ? { logicalRef } : {}), expectedLayout: expectedSnapshot });
      } else if (actualSnapshot.horizontalSizing !== expectedSnapshot.horizontalSizing ||
        actualSnapshot.verticalSizing !== expectedSnapshot.verticalSizing ||
        (expectedSnapshot.textAutoResize !== undefined && actualSnapshot.textAutoResize !== expectedSnapshot.textAutoResize)) {
        append({ code: "native_layout_sizing_mismatch", nodeId: node.id, ...(parent ? { parentId: parent.id } : {}),
          ...(logicalRef ? { logicalRef } : {}), expectedLayout: expectedSnapshot, observedLayout: actualSnapshot });
      }
    }
    if (node.getPluginData("fad.touch-target") && (node.width < 44 - GEOMETRY_EPSILON || node.height < 44 - GEOMETRY_EPSILON))
      record("native_touch_target", node, parent);
    if (node.type === "TEXT" && (node.hasMissingFont === true ||
      (spec?.type === "text" && ((expected?.compareText && node.characters !== spec.text) ||
        (spec.textAlign && node.textAlignHorizontal !== spec.textAlign.toUpperCase()) ||
        (typeof spec.fontSize === "number" && node.fontSize !== spec.fontSize)))))
      record("native_text_mismatch", node, parent);
    if (node.type === "TEXT" && node.getPluginData("fad.design.program-text.v1") === "1") {
      if (hasUnrenderableProgramText(node.characters) ||
        (!options.verifyLayoutSizing && !["HEIGHT", "WIDTH_AND_HEIGHT"].includes(node.textAutoResize)) || node.textTruncation === "ENDING")
        record("native_text_truncation_or_invalid", node, parent);
      if (hasArabicScript(node.characters) && (typeof node.fontName !== "object" ||
        !PERSIAN_FONT_FAMILIES.some((family) => family.toLowerCase() === (node.fontName as FontName).family.toLowerCase())))
        record("native_text_script_font", node, parent);
    }
    if (spec?.type === "frame" && spec.layout && node.type === "FRAME") {
      const layout = spec.layout;
      const mode = layout.mode === "horizontal" ? "HORIZONTAL" : "VERTICAL";
      if (node.layoutMode !== mode || (layout.wrap && node.layoutWrap !== "WRAP") ||
        node.primaryAxisAlignItems !== align[layout.primaryAxisAlign ?? "start"] ||
        node.counterAxisAlignItems !== align[layout.counterAxisAlign ?? "start"] ||
        node.itemSpacing !== (layout.gap ?? 0) ||
        node.paddingLeft !== (layout.padding?.left ?? 0) || node.paddingRight !== (layout.padding?.right ?? 0) ||
        node.paddingTop !== (layout.padding?.top ?? 0) || node.paddingBottom !== (layout.padding?.bottom ?? 0))
        record("native_layout_mismatch", node, parent);
    }
    if (spec?.type === "image") {
      const asset = expected!.assets.find(({ id }) => id === spec.assetId);
      if (node.getPluginData("fad.design.asset-id") !== spec.assetId ||
        (asset?.kind === "raster" && (node.type !== "RECTANGLE" || !Array.isArray(node.fills) || !node.fills.some((fill) => fill.type === "IMAGE" && fill.imageHash))) ||
        (asset?.kind === "svg-paths" && (node.type !== "FRAME" || node.children.length !== asset.paths.length || node.children.some((child) => child.type !== "VECTOR"))))
        record("native_asset_mismatch", node, parent);
    }
    const component = spec?.type === "instance"
      ? expected?.components?.find(({ id }) => id === spec.componentId)
      : undefined;
    if (spec?.type === "instance" && (!component || node.getPluginData("fad.design.component-id") !== spec.componentId ||
      Math.abs(node.width - component.width) > GEOMETRY_EPSILON || Math.abs(node.height - component.height) > GEOMETRY_EPSILON))
      record("native_component_mismatch", node, parent);

    const children = "children" in node ? node.children : [];
    const plannedChildren = node === root ? expected?.children : spec?.type === "frame" ? spec.children : component?.children;
    if (plannedChildren && children.length !== plannedChildren.length) record("native_hierarchy_mismatch", node, parent);
    const layout = "layoutMode" in node ? [node.layoutMode, node.layoutWrap, node.itemSpacing, node.paddingLeft, node.paddingRight, node.paddingTop, node.paddingBottom, node.clipsContent, "overflowDirection" in node ? node.overflowDirection : null] : null;
    const relative = local && [local.x, local.y, local.width, local.height].map((value) => Math.round(value * 1000));
    const stableRecord = [node.id, parent?.id, node.type, node.visible, relative, node.width, node.height, layout,
      node.getPluginData("fad.design.logical-ref"), node.getPluginData("fad.design.asset-id"),
      ...(node.type === "INSTANCE" ? [node.getPluginData("fad.design.component-id")] : []),
      node.type === "TEXT" ? [node.characters, node.fontName, node.fontSize, node.textAlignHorizontal, node.textAutoResize, node.textStyleId] : null,
      "fillStyleId" in node ? node.fillStyleId : null,
      "fills" in node && Array.isArray(node.fills) ? node.fills : null];
    const sizingRecord = [
      "layoutSizingHorizontal" in node ? String(node.layoutSizingHorizontal) : null,
      "layoutSizingVertical" in node ? String(node.layoutSizingVertical) : null,
    ];
    addToReceipt(stableRecord, [...stableRecord, sizingRecord]);
    children.forEach((child, childIndex) => visit(child, plannedChildren?.[childIndex], node, childIndex, depth + 1));
  }
  visit(root, undefined, undefined, 0, 0);
  for (const expectation of options.expectedLayout ?? []) {
    if (!observedExpectedRefs.has(expectation.logicalRef)) {
      incomplete = true;
      append({ code: "native_layout_expectation_missing", nodeId: root.id, logicalRef: expectation.logicalRef,
        expectedLayout: { horizontalSizing: expectation.horizontalSizing, verticalSizing: expectation.verticalSizing,
          ...(expectation.textAutoResize ? { textAutoResize: expectation.textAutoResize } : {}) } });
    }
  }
  const receiptHash = (hash >>> 0).toString(16);
  const receipt = `v1-${receiptHash}`;
  const legacyReceipt = `v1-${(legacyHash >>> 0).toString(16)}`;
  const storedReceipt = root.getPluginData(PROGRAM_GEOMETRY_KEY);
  // Existing builds may store the same 32-bit receipt with or without left padding.
  const canonicalStoredReceipt = canonicalProgramGeometryReceipt(storedReceipt);
  const storedMatchesLegacyReceipt = Boolean(options.checkReceipt && storedReceipt &&
    canonicalStoredReceipt === canonicalProgramGeometryReceipt(legacyReceipt));
  if (options.checkReceipt && canonicalStoredReceipt !== canonicalProgramGeometryReceipt(receipt) && !storedMatchesLegacyReceipt)
    record("native_content_changed", root);
  return { version: NATIVE_GEOMETRY_VERSION, coverage: incomplete ? "incomplete" : "complete", measuredNodes,
    durationMs: Math.max(0, Math.round(Date.now() - started)), findings, receipt: storedMatchesLegacyReceipt ? storedReceipt : receipt };
}

/**
 * Apply a single bounded correction pass to fresh, active-task nodes only.
 * The caller must re-read and checkpoint only after this function returns a clean report.
 */
export function convergeProgramLayoutSizing(
  root: FrameNode,
  options: {
    taskId: string;
    pageId: string;
    fingerprint: string;
    expected: ExpectedScreen;
    allowRepair: boolean;
    initialReport?: ProgramGeometryReport & { receipt: string };
    assertCurrentScope?: () => void;
  },
): { report: ProgramGeometryReport & { receipt: string }; attempts: number; repaired: number; readbacks: number; beforeCodes: string[] } {
  const inspectOptions = { taskId: options.taskId, pageId: options.pageId, expected: options.expected, verifyLayoutSizing: true };
  const before = options.initialReport ?? inspectProgramGeometry(root, inspectOptions);
  const beforeCodes = before.findings.map(({ code }) => code);
  if (!options.allowRepair || before.coverage !== "complete" || !before.findings.length ||
    before.findings.some(({ code }) => code !== "native_layout_sizing_mismatch"))
    return { report: before, attempts: 0, repaired: 0, readbacks: 0, beforeCodes };
  if (root.parent?.type !== "PAGE" || root.parent.id !== options.pageId ||
    root.getPluginData(PROGRAM_TASK_KEY) !== options.taskId ||
    root.getPluginData(PROGRAM_FINGERPRINT_KEY) !== options.fingerprint)
    return { report: before, attempts: 0, repaired: 0, readbacks: 0, beforeCodes };

  const expectedByRef = new Map<string, { spec: DesignNode; parentRef?: string }>();
  const collect = (nodes: readonly DesignNode[], parentRef?: string) => {
    for (const spec of nodes) {
      const ref = "logicalRef" in spec ? spec.logicalRef : undefined;
      if (ref) expectedByRef.set(ref, { spec, parentRef });
      if (spec.type === "frame") collect(spec.children, ref);
    }
  };
  collect(options.expected.children);
  const nativeById = new Map<string, SceneNode>();
  const stack: SceneNode[] = [...root.children];
  let visited = 0;
  while (stack.length && visited < 300) {
    const node = stack.pop()!;
    visited++;
    nativeById.set(node.id, node);
    if ("children" in node) stack.push(...node.children);
  }
  if (stack.length) return { report: before, attempts: 0, repaired: 0, readbacks: 0, beforeCodes };

  let attempts = 0;
  let repaired = 0;
  const repairFailures: ProgramGeometryFinding[] = [];
  for (const finding of before.findings) {
    const node = nativeById.get(finding.nodeId);
    const ref = node?.getPluginData("fad.design.logical-ref");
    const planned = ref ? expectedByRef.get(ref) : undefined;
    const parent = node?.parent;
    if (!node || !planned || !planned.spec.sizing || !parent ||
      (parent.type !== "FRAME" && parent.type !== "COMPONENT") || parent.layoutMode === "NONE" ||
      ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") ||
      (node.type !== "FRAME" && node.type !== "TEXT" && (planned.spec.sizing.width === "hug" || planned.spec.sizing.height === "hug")) ||
      !("layoutSizingHorizontal" in node) || !("layoutSizingVertical" in node))
      continue;
    const expectedHorizontal = nativeSizingMode(planned.spec.sizing.width);
    const expectedVertical = nativeSizingMode(planned.spec.sizing.height);
    if (node.layoutSizingHorizontal === expectedHorizontal && node.layoutSizingVertical === expectedVertical &&
      (planned.spec.type !== "text" || !planned.spec.textAutoResize || node.type !== "TEXT" ||
        node.textAutoResize === (planned.spec.textAutoResize === "width-and-height" ? "WIDTH_AND_HEIGHT" : "HEIGHT")))
      continue;
    options.assertCurrentScope?.();
    attempts++;
    let changed = false;
    try {
      if (node.layoutSizingHorizontal !== expectedHorizontal) {
        node.layoutSizingHorizontal = expectedHorizontal;
        changed = true;
      }
      if (node.layoutSizingVertical !== expectedVertical) {
        node.layoutSizingVertical = expectedVertical;
        changed = true;
      }
      const expectedTextAutoResize = planned.spec.type === "text" && planned.spec.textAutoResize
        ? planned.spec.textAutoResize === "width-and-height" ? "WIDTH_AND_HEIGHT" : "HEIGHT"
        : undefined;
      if (expectedTextAutoResize && node.type === "TEXT" && node.textAutoResize !== expectedTextAutoResize) {
        node.textAutoResize = expectedTextAutoResize;
        changed = true;
      }
      if (changed) repaired++;
    } catch {
      if (changed) repaired++;
      repairFailures.push({ code: "native_layout_convergence_failed", nodeId: node.id, parentId: parent.id,
        ...(ref ? { logicalRef: ref } : {}), expectedLayout: { horizontalSizing: expectedHorizontal, verticalSizing: expectedVertical,
          ...(planned.spec.type === "text" && planned.spec.textAutoResize ? {
            textAutoResize: planned.spec.textAutoResize === "width-and-height" ? "WIDTH_AND_HEIGHT" : "HEIGHT",
          } : {}) } });
    }
  }
  options.assertCurrentScope?.();
  const verified = inspectProgramGeometry(root, inspectOptions);
  const after = repairFailures.length
    ? { ...verified, findings: [...verified.findings, ...repairFailures].slice(0, 12) }
    : verified;
  return { report: after, attempts, repaired, readbacks: 1, beforeCodes };
}

/** One correction to the synthetic scroll body, driven by the measured native content extent. */
export function fitProgramScrollBody(root: FrameNode): boolean {
  const body = root.children[0];
  if (body?.type !== "FRAME" || body.children.length !== 1) return false;
  const bounds = childBoundsInParent(body, body.children[0]!);
  if (!bounds) return false;
  const height = bounds.y + bounds.height + body.paddingBottom;
  if (height <= body.height + GEOMETRY_EPSILON || height > 20_000) return false;
  body.resize(body.width, height);
  return true;
}
