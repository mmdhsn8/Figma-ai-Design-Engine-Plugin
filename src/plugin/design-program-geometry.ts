import { childBoundsInParent, GEOMETRY_EPSILON, NATIVE_GEOMETRY_VERSION, overflowByEdge, type GeometryRect } from "../shared/native-geometry";
import type { ComponentDefinitionSpec, DesignNode } from "../shared/schema";
import type { VisualAsset } from "../shared/visual-schema";
import { hasArabicScript, hasUnrenderableProgramText, PERSIAN_FONT_FAMILIES } from "../shared/program-text";

export const PROGRAM_TASK_KEY = "fad.design.program-task.v1";
export const PROGRAM_FINGERPRINT_KEY = "fad.design.program-fingerprint.v1";
export const PROGRAM_GEOMETRY_KEY = "fad.design.geometry-receipt.v1";

export type ProgramGeometryFinding = {
  code: string;
  nodeId: string;
  parentId?: string;
  expected?: GeometryRect;
  observed?: GeometryRect;
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
      const expected = node.getPluginData("fad.design.native-master-id.v1");
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

const align = { start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN", stretch: "MIN", baseline: "BASELINE" } as const;

function nativeType(spec: DesignNode, assets: readonly VisualAsset[]): string {
  if (spec.type === "image") return assets.find(({ id }) => id === spec.assetId)?.kind === "svg-paths" ? "FRAME" : "RECTANGLE";
  return spec.type === "instance" ? "INSTANCE" : spec.type.toUpperCase();
}

export function inspectProgramGeometry(
  root: FrameNode,
  options: { taskId: string; pageId: string; expected?: ExpectedScreen; requireOwnership?: boolean; checkReceipt?: boolean },
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
  const addToReceipt = (value: unknown) => {
    const serialized = JSON.stringify(value);
    for (let i = 0; i < serialized.length; i++) hash = Math.imul(hash ^ serialized.charCodeAt(i), 0x01000193);
  };
  const expected = options.expected;
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
    if (spec && (node.type !== nativeType(spec, expected!.assets) ||
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
    if (node.getPluginData("fad.touch-target") && (node.width < 44 - GEOMETRY_EPSILON || node.height < 44 - GEOMETRY_EPSILON))
      record("native_touch_target", node, parent);
    if (node.type === "TEXT" && (node.hasMissingFont === true ||
      (spec?.type === "text" && ((expected?.compareText && node.characters !== spec.text) ||
        (spec.textAlign && node.textAlignHorizontal !== spec.textAlign.toUpperCase()) ||
        (typeof spec.fontSize === "number" && node.fontSize !== spec.fontSize)))))
      record("native_text_mismatch", node, parent);
    if (node.type === "TEXT" && node.getPluginData("fad.design.program-text.v1") === "1") {
      if (hasUnrenderableProgramText(node.characters) ||
        !["HEIGHT", "WIDTH_AND_HEIGHT"].includes(node.textAutoResize) || node.textTruncation === "ENDING")
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
    addToReceipt([node.id, parent?.id, node.type, node.visible, relative, node.width, node.height, layout,
      node.getPluginData("fad.design.logical-ref"), node.getPluginData("fad.design.asset-id"),
      ...(node.type === "INSTANCE" ? [node.getPluginData("fad.design.component-id")] : []),
      node.type === "TEXT" ? [node.characters, node.fontName, node.fontSize, node.textAlignHorizontal, node.textAutoResize, node.textStyleId] : null,
      "fillStyleId" in node ? node.fillStyleId : null,
      "fills" in node && Array.isArray(node.fills) ? node.fills : null]);
    children.forEach((child, childIndex) => visit(child, plannedChildren?.[childIndex], node, childIndex, depth + 1));
  }
  visit(root, undefined, undefined, 0, 0);
  const receipt = `v1-${(hash >>> 0).toString(16)}`;
  if (options.checkReceipt && root.getPluginData(PROGRAM_GEOMETRY_KEY) !== receipt)
    record("native_content_changed", root);
  return { version: NATIVE_GEOMETRY_VERSION, coverage: incomplete ? "incomplete" : "complete", measuredNodes,
    durationMs: Math.max(0, Math.round(Date.now() - started)), findings, receipt };
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
