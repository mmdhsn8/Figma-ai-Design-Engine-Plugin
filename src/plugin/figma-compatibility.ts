import {
  FigmaToolCompatibilityFailureSchema,
  FigmaToolCompatibilityNormalizationSchema,
  type FigmaToolAction,
} from "../shared/figma-tools";

type CreateAction = Extract<
  FigmaToolAction,
  { tool: "create_frame" | "create_text" | "create_rectangle" }
>;
type CreateTextAction = Extract<FigmaToolAction, { tool: "create_text" }>;
type AutoLayoutAction = Extract<FigmaToolAction, { tool: "set_auto_layout" }>;
type PropertiesAction = Extract<FigmaToolAction, { tool: "set_properties" }>;
type ParentingAction = Extract<FigmaToolAction, { tool: "append_child" | "reparent_node" }>;
type ContainerNode = PageNode | FrameNode | ComponentNode;
type CompatibilityNormalization = ReturnType<
  typeof FigmaToolCompatibilityNormalizationSchema.parse
>;
type CompatibilityFailure = ReturnType<typeof FigmaToolCompatibilityFailureSchema.parse>;
type CompatibilityCode = CompatibilityFailure["code"];
type CompatibilityFieldPath = CompatibilityFailure["fieldPath"];
type ParentingDecision =
  | "ready"
  | "already_parented"
  | "rejected_parent"
  | "rejected_cycle"
  | "rejected_non_root"
  | "rejected_stale_or_ambiguous";

export class FigmaCompatibilityError extends Error {
  constructor(
    readonly diagnostic: CompatibilityFailure,
    message: string,
  ) {
    super(message);
  }
}

function reject(
  action: FigmaToolAction,
  code: CompatibilityCode,
  fieldPath: CompatibilityFieldPath,
  message: string,
  options: {
    nodeType?: string;
    parent?: BaseNode;
    permittedRemediations: CompatibilityFailure["permittedRemediations"];
  },
): never {
  const parent = options.parent;
  throw new FigmaCompatibilityError(
    FigmaToolCompatibilityFailureSchema.parse({
      toolName: action.tool,
      nodeType:
        options.nodeType ??
        (action.tool === "create_text"
          ? "TEXT"
          : action.tool === "create_frame"
            ? "FRAME"
            : action.tool === "create_rectangle"
              ? "RECTANGLE"
              : "OTHER"),
      code,
      fieldPath,
      ...(parent &&
      (parent.type === "PAGE" || parent.type === "FRAME" || parent.type === "COMPONENT")
        ? {
            parentType: parent.type,
            parentLayoutMode:
              parent.type === "PAGE" ? "NONE" : (parent as FrameNode | ComponentNode).layoutMode,
          }
        : {}),
      permittedRemediations: options.permittedRemediations,
    }),
    message,
  );
}

function textSizingFailure(
  action: CreateTextAction,
  code: "fill_parent_bounds_unavailable" | "text_sizing_requires_auto_layout",
  fieldPath: "action.horizontalSizing" | "action.verticalSizing" | "action.textAutoResize",
  parent: ContainerNode,
): never {
  const parentLayoutMode = parent.type === "PAGE" ? "NONE" : parent.layoutMode;
  const permittedRemediations =
    code === "fill_parent_bounds_unavailable"
      ? ["use_explicit_fixed_size" as const]
      : ["establish_auto_layout_before_creation" as const];
  const diagnostic = FigmaToolCompatibilityFailureSchema.parse({
    toolName: action.tool,
    nodeType: "TEXT",
    code,
    fieldPath,
    parentType: parent.type,
    parentLayoutMode,
    permittedRemediations,
  });
  const message =
    code === "fill_parent_bounds_unavailable"
      ? `Cannot safely normalize ${fieldPath}=FILL for TEXT under ${parent.type}(layoutMode=${parentLayoutMode}); use an explicit fixed size or create the text inside a bounded frame.`
      : `Cannot preserve the requested ${fieldPath} sizing under ${parent.type}(layoutMode=${parentLayoutMode}); establish Auto Layout before creating the text.`;
  throw new FigmaCompatibilityError(diagnostic, message);
}

function normalization(
  value: Parameters<typeof FigmaToolCompatibilityNormalizationSchema.parse>[0],
): CompatibilityNormalization {
  return FigmaToolCompatibilityNormalizationSchema.parse(value);
}

export function requireCreationParent(action: CreateAction, parent: BaseNode): ContainerNode {
  if (parent.type === "PAGE" || parent.type === "FRAME" || parent.type === "COMPONENT")
    return parent;
  reject(
    action,
    "unsupported_parent_type",
    "action.parent",
    "The parent must be the current page, a frame, or a component.",
    { nodeType: parent.type, permittedRemediations: ["use_compatible_parent"] },
  );
}

export function validateCreationPosition(
  action: Extract<CreateAction, { tool: "create_frame" | "create_rectangle" }>,
): void {
  if ((action.x === undefined) === (action.y === undefined)) return;
  reject(
    action,
    "invalid_position",
    action.x === undefined ? "action.x" : "action.y",
    "Set both x and y for explicit placement, or omit both to use safe canvas placement.",
    { permittedRemediations: ["use_supported_property"] },
  );
}

export function requirePaintStyle(action: CreateAction, available: boolean): void {
  if (action.tool !== "create_text" && action.paintStyleId && !available)
    reject(
      action,
      "style_not_found",
      "action.paintStyleId",
      "The requested paint token is not present in this document's local styles.",
      {
        nodeType: action.tool === "create_frame" ? "FRAME" : "RECTANGLE",
        permittedRemediations: ["select_available_local_style"],
      },
    );
}

export function normalizeTextSizingForParent(
  action: CreateTextAction,
  parent: ContainerNode,
): { action: CreateTextAction; normalizations: CompatibilityNormalization[] } {
  const parentLayoutMode = parent.type === "PAGE" ? "NONE" : parent.layoutMode;
  if (parentLayoutMode !== "NONE") return { action, normalizations: [] };

  const wantsVerticalFill = action.verticalSizing === "FILL";
  const wantsHorizontalHug = action.horizontalSizing === "HUG";
  const wantsVerticalHug = action.verticalSizing === "HUG";
  if (wantsVerticalFill && wantsHorizontalHug)
    textSizingFailure(
      action,
      "text_sizing_requires_auto_layout",
      "action.horizontalSizing",
      parent,
    );
  if (wantsHorizontalHug && action.verticalSizing === "FIXED")
    textSizingFailure(
      action,
      "text_sizing_requires_auto_layout",
      "action.horizontalSizing",
      parent,
    );
  if ((wantsHorizontalHug || wantsVerticalHug) && action.textAutoResize === "TRUNCATE")
    textSizingFailure(
      action,
      "text_sizing_requires_auto_layout",
      wantsHorizontalHug ? "action.horizontalSizing" : "action.verticalSizing",
      parent,
    );

  const size = { ...action.size };
  const normalizations: CompatibilityNormalization[] = [];
  let horizontalSizing = action.horizontalSizing;
  let verticalSizing = action.verticalSizing;
  const normalizeAxis = (axis: "horizontal" | "vertical") => {
    const fieldPath = `action.${axis}Sizing` as const;
    const dimension = axis === "horizontal" ? "width" : "height";
    const requested = axis === "horizontal" ? horizontalSizing : verticalSizing;
    if (requested !== "FILL") return;
    const resolvedDimension = parent.type === "PAGE" ? size[dimension] : parent[dimension];
    if (!Number.isFinite(resolvedDimension) || resolvedDimension < 1 || resolvedDimension > 20_000)
      textSizingFailure(action, "fill_parent_bounds_unavailable", fieldPath, parent);
    size[dimension] = resolvedDimension;
    if (axis === "horizontal") horizontalSizing = "FIXED";
    else verticalSizing = "FIXED";
    normalizations.push(
      normalization({
        toolName: "create_text",
        nodeType: "TEXT",
        fieldPath,
        requested: "FILL",
        applied: "FIXED",
        reason:
          parent.type === "PAGE"
            ? "page_root_uses_explicit_geometry"
            : "non_auto_layout_parent_uses_content_box",
        parentType: parent.type,
        parentLayoutMode,
        resolvedDimension,
      }),
    );
  };
  normalizeAxis("horizontal");
  normalizeAxis("vertical");

  const textAutoResize =
    action.textAutoResize === "TRUNCATE"
      ? action.textAutoResize
      : wantsHorizontalHug && wantsVerticalHug
        ? "WIDTH_AND_HEIGHT"
        : wantsVerticalHug
          ? "HEIGHT"
          : "NONE";
  if (textAutoResize !== action.textAutoResize)
    normalizations.push(
      normalization({
        toolName: "create_text",
        nodeType: "TEXT",
        fieldPath: "action.textAutoResize",
        requested: action.textAutoResize,
        applied: textAutoResize,
        reason:
          wantsHorizontalHug || wantsVerticalHug
            ? "hug_sizing_uses_native_text_resize"
            : "fixed_geometry_requires_native_text_resize",
        parentType: parent.type,
        parentLayoutMode,
      }),
    );

  return {
    action: { ...action, size, horizontalSizing, verticalSizing, textAutoResize },
    normalizations,
  };
}

export function normalizeAutoLayout(
  action: AutoLayoutAction,
  target: SceneNode,
  children: Array<{ rule: AutoLayoutAction["children"][number]; node: SceneNode }>,
): {
  layout: AutoLayoutAction["layout"];
  children: Array<{
    rule: AutoLayoutAction["children"][number];
    node: SceneNode;
    horizontal?: "FIXED" | "HUG" | "FILL";
    vertical?: "FIXED" | "HUG" | "FILL";
  }>;
  normalizedStretchRefs: string[];
  normalizations: CompatibilityNormalization[];
} {
  if (target.type !== "FRAME" && target.type !== "COMPONENT")
    reject(
      action,
      "unsupported_target_type",
      "action.ref" as CompatibilityFieldPath,
      "Auto Layout can only be set on a frame or component.",
      { nodeType: target.type, permittedRemediations: ["use_compatible_parent"] },
    );
  if (action.layout.counterAlign === "BASELINE" && action.layout.direction !== "horizontal")
    reject(
      action,
      "invalid_layout_rules",
      "action.layout.counterAlign",
      "Baseline counter-axis alignment is only valid for horizontal Auto Layout.",
      { nodeType: target.type, permittedRemediations: ["use_supported_property"] },
    );
  if (new Set(action.children.map(({ ref }) => ref)).size !== action.children.length)
    reject(
      action,
      "invalid_layout_rules",
      "action.children.ref",
      "Auto Layout child rules must use unique logical references.",
      { nodeType: target.type, permittedRemediations: ["use_supported_property"] },
    );
  if (children.length !== action.children.length)
    reject(
      action,
      "invalid_layout_rules",
      "action.children",
      "Every Auto Layout child rule must resolve to one current native node.",
      { nodeType: target.type, permittedRemediations: ["inspect_current_parent"] },
    );

  const childRules = children.map(({ rule, node }) => {
    if (node.parent?.id !== target.id)
      reject(
        action,
        "invalid_layout_rules",
        "action.children.ref",
        `“${rule.ref}” is not a direct child of “${action.ref}”.`,
        { nodeType: target.type, permittedRemediations: ["inspect_current_parent"] },
      );
    const horizontal =
      action.layout.direction === "vertical" && rule.align === "STRETCH" ? "FILL" : rule.horizontal;
    const vertical =
      action.layout.direction === "horizontal" && rule.align === "STRETCH" ? "FILL" : rule.vertical;
    const supportsHug =
      node.type === "TEXT" ||
      ((node.type === "FRAME" || node.type === "COMPONENT") && node.layoutMode !== "NONE");
    if ((horizontal === "HUG" || vertical === "HUG") && !supportsHug)
      reject(
        action,
        "unsupported_hug_target",
        "action.children",
        `HUG sizing requires editable text or an Auto Layout frame (${rule.ref}).`,
        { nodeType: node.type, permittedRemediations: ["establish_auto_layout_before_creation"] },
      );
    return { rule, node, horizontal, vertical };
  });

  const verticalLayout = action.layout.direction === "vertical";
  const unlistedChildren = (target as FrameNode | ComponentNode).children.filter(
    (node) =>
      !childRules.some((child) => child.node.id === node.id) &&
      (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE"),
  );
  const primaryFill =
    unlistedChildren.some(
      (node) =>
        "layoutSizingVertical" in node &&
        (verticalLayout ? node.layoutSizingVertical : node.layoutSizingHorizontal) === "FILL",
    ) ||
    childRules.some(
      ({ rule }) =>
        rule.grow === 1 || (verticalLayout ? rule.vertical : rule.horizontal) === "FILL",
    );
  const counterFill =
    unlistedChildren.some(
      (node) =>
        "layoutSizingVertical" in node &&
        (verticalLayout ? node.layoutSizingHorizontal : node.layoutSizingVertical) === "FILL",
    ) ||
    childRules.some(
      ({ rule }) =>
        rule.align === "STRETCH" || (verticalLayout ? rule.horizontal : rule.vertical) === "FILL",
    );
  const layout = {
    ...action.layout,
    primarySizing: primaryFill
      ? ("FIXED" as const)
      : (action.layout.primarySizing ??
        (target.parent?.type !== "PAGE" && verticalLayout ? "AUTO" : "FIXED")),
    counterSizing: counterFill ? ("FIXED" as const) : action.layout.counterSizing,
  };
  const normalizedStretchRefs = childRules
    .filter(
      ({ rule, horizontal, vertical }) =>
        rule.align === "STRETCH" ||
        (horizontal !== rule.horizontal && rule.horizontal !== undefined) ||
        (vertical !== rule.vertical && rule.vertical !== undefined),
    )
    .map(({ rule }) => rule.ref);
  const normalizations: CompatibilityNormalization[] = [];
  if (action.layout.primarySizing && layout.primarySizing !== action.layout.primarySizing)
    normalizations.push(
      normalization({
        toolName: "set_auto_layout",
        nodeType: target.type,
        fieldPath: "action.layout.primarySizing",
        requested: action.layout.primarySizing,
        applied: layout.primarySizing,
        reason: "fill_child_requires_fixed_parent_axis",
        affectedRefs: childRules
          .filter(
            ({ rule }) =>
              rule.grow === 1 || (verticalLayout ? rule.vertical : rule.horizontal) === "FILL",
          )
          .map(({ rule }) => rule.ref),
      }),
    );
  if (layout.counterSizing !== action.layout.counterSizing)
    normalizations.push(
      normalization({
        toolName: "set_auto_layout",
        nodeType: target.type,
        fieldPath: "action.layout.counterSizing",
        requested: action.layout.counterSizing,
        applied: layout.counterSizing,
        reason: "fill_child_requires_fixed_parent_axis",
        affectedRefs: childRules
          .filter(
            ({ rule }) =>
              rule.align === "STRETCH" ||
              (verticalLayout ? rule.horizontal : rule.vertical) === "FILL",
          )
          .map(({ rule }) => rule.ref),
      }),
    );
  if (normalizedStretchRefs.length)
    normalizations.push(
      normalization({
        toolName: "set_auto_layout",
        nodeType: target.type,
        fieldPath: "action.children.sizing",
        requested: "FIXED",
        applied: "FILL",
        reason: "stretch_child_uses_fill_sizing",
        affectedRefs: normalizedStretchRefs,
      }),
    );

  return { layout, children: childRules, normalizedStretchRefs, normalizations };
}

export function validateSetProperties(
  action: PropertiesAction,
  target: SceneNode,
  capabilities: {
    paintStyleAvailable: boolean;
    textStyleAvailable: boolean;
  },
): void {
  const properties = action.properties;
  if (properties.fill !== undefined && properties.paintStyleId !== undefined)
    reject(
      action,
      "conflicting_style_properties",
      "action.properties.paintStyleId",
      "Choose either a literal fill color or an existing paint token in one operation.",
      { nodeType: target.type, permittedRemediations: ["remove_conflicting_property"] },
    );
  if (
    properties.textStyleId &&
    [
      properties.fontSize,
      properties.color,
      properties.fontFamily,
      properties.fontStyle,
      properties.lineHeight,
      properties.letterSpacing,
      properties.align,
      properties.textAutoResize,
    ].some((entry) => entry !== undefined)
  )
    reject(
      action,
      "conflicting_style_properties",
      "action.properties.textStyleId",
      "Choose an existing text style or explicit typography changes in one operation.",
      { nodeType: target.type, permittedRemediations: ["remove_conflicting_property"] },
    );
  const changesText =
    properties.text !== undefined ||
    properties.fontSize !== undefined ||
    properties.color !== undefined ||
    properties.align !== undefined ||
    properties.fontFamily !== undefined ||
    properties.fontStyle !== undefined ||
    properties.lineHeight !== undefined ||
    properties.letterSpacing !== undefined ||
    properties.textAutoResize !== undefined;
  if (changesText && target.type !== "TEXT")
    reject(
      action,
      "unsupported_property",
      "action.properties.text",
      "Text properties can only target an editable text node.",
      { nodeType: target.type, permittedRemediations: ["use_supported_property"] },
    );
  const unsupported = (condition: boolean, fieldPath: CompatibilityFieldPath, message: string) => {
    if (condition)
      reject(action, "unsupported_property", fieldPath, message, {
        nodeType: target.type,
        permittedRemediations: ["use_supported_property"],
      });
  };
  unsupported(
    properties.width !== undefined && !("resize" in target),
    "action.properties.width",
    "This node type does not support width changes.",
  );
  unsupported(
    properties.height !== undefined && !("resize" in target),
    "action.properties.height",
    "This node type does not support height changes.",
  );
  unsupported(
    (properties.fill !== undefined || properties.paintStyleId !== undefined) &&
      !("fills" in target),
    properties.paintStyleId !== undefined
      ? "action.properties.paintStyleId"
      : "action.properties.fill",
    "This node type does not support a fill color.",
  );
  unsupported(
    (properties.stroke !== undefined || properties.strokeWeight !== undefined) &&
      !("strokes" in target),
    "action.properties.stroke",
    "This node type does not support a stroke.",
  );
  unsupported(
    properties.cornerRadius !== undefined && !("cornerRadius" in target),
    "action.properties.cornerRadius",
    "This node type does not support corner radii.",
  );
  unsupported(
    properties.opacity !== undefined && !("opacity" in target),
    "action.properties.opacity",
    "This Figma node does not support opacity on this platform.",
  );
  unsupported(
    properties.shadow !== undefined && !("effects" in target),
    "action.properties.shadow",
    "This Figma node does not support effects on this platform.",
  );
  if (properties.paintStyleId && !capabilities.paintStyleAvailable)
    reject(
      action,
      "style_not_found",
      "action.properties.paintStyleId",
      "The requested paint token is not present in this document's local styles.",
      { nodeType: target.type, permittedRemediations: ["select_available_local_style"] },
    );
  if (properties.textStyleId && target.type !== "TEXT")
    reject(
      action,
      "unsupported_target_type",
      "action.properties.textStyleId",
      "Text styles can only be applied to editable text.",
      { nodeType: target.type, permittedRemediations: ["use_supported_property"] },
    );
  if (properties.textStyleId && !capabilities.textStyleAvailable)
    reject(
      action,
      "style_not_found",
      "action.properties.textStyleId",
      "The requested text token is not present in this document's local styles.",
      { nodeType: target.type, permittedRemediations: ["select_available_local_style"] },
    );
}

export function requireDeleteConsent(
  action: Extract<FigmaToolAction, { tool: "delete_node" }>,
  valid: boolean,
): void {
  if (!valid)
    reject(
      action,
      "delete_consent_required",
      "action.consentToken",
      "Deletion requires a fresh, matching user confirmation for this logical reference.",
      { nodeType: "OTHER", permittedRemediations: ["request_delete_consent"] },
    );
}

export function decideParentingCompatibility(
  action: ParentingAction,
  child: SceneNode,
  parent: SceneNode,
  options: { expectedSourceParentId?: string; recovery?: boolean } = {},
): ParentingDecision {
  if (parent.type !== "FRAME" && parent.type !== "COMPONENT") return "rejected_parent";
  if (child.id === parent.id) return "rejected_cycle";
  let ancestor: BaseNode | null = parent;
  while (ancestor && ancestor.type !== "PAGE") {
    if (ancestor.id === child.id) return "rejected_cycle";
    ancestor = ancestor.parent;
  }
  if (child.parent?.id === parent.id) return "already_parented";
  if (options.recovery) {
    const sourceUnchanged =
      options.expectedSourceParentId !== undefined &&
      child.parent?.id === options.expectedSourceParentId;
    const legacyRootAppend =
      !options.expectedSourceParentId &&
      action.tool === "append_child" &&
      child.parent?.type === "PAGE";
    return sourceUnchanged || legacyRootAppend ? "ready" : "rejected_stale_or_ambiguous";
  }
  if (action.tool === "append_child" && child.parent?.type !== "PAGE") return "rejected_non_root";
  if (
    action.tool === "reparent_node" &&
    (!options.expectedSourceParentId || child.parent?.id !== options.expectedSourceParentId)
  )
    return "rejected_stale_or_ambiguous";
  return "ready";
}

export const figmaCompatibilityEngine = {
  decideParentingCompatibility,
  normalizeAutoLayout,
  normalizeTextSizingForParent,
  requireDeleteConsent,
  requireCreationParent,
  requirePaintStyle,
  validateCreationPosition,
  validateSetProperties,
};
