// Only task-owned flow containers may grow; viewport, FILL and decorative clipping remain explicit.
export function repairAutoLayoutHierarchy(
  target: SceneNode,
  taskId: string,
  markNativeMutation: () => void = () => {},
) {
  let root = target;
  while (
    root.parent &&
    root.parent.type !== "PAGE" &&
    root.parent.type !== "DOCUMENT" &&
    root.parent.getPluginData("fad.tool.task-id.v1") === taskId
  )
    root = root.parent as SceneNode;
  const repairs: Array<Record<string, unknown>> = [];
  const visit = (node: SceneNode): void => {
    if (node.getPluginData("fad.tool.task-id.v1") !== taskId) return;
    if (node.type !== "FRAME" && node.type !== "COMPONENT") return;
    for (const child of node.children) visit(child);
    if (node.layoutMode !== "VERTICAL") return;
    const children = node.children.filter(
      (child) =>
        child.visible &&
        (!("layoutPositioning" in child) || child.layoutPositioning !== "ABSOLUTE"),
    );
    if (!children.length) return;
    const requiredHeight =
      node.paddingTop +
      node.paddingBottom +
      children.reduce((height, child) => height + child.height, 0) +
      Math.max(0, children.length - 1) * node.itemSpacing;
    const requiredWidth =
      node.paddingLeft + node.paddingRight + Math.max(...children.map((child) => child.width));
    if (requiredHeight <= node.height + 0.001 && requiredWidth <= node.width + 0.001) return;
    const before = {
      width: node.width,
      height: node.height,
      primarySizing: node.primaryAxisSizingMode,
    };
    const fixedBoundary = node.parent?.type === "PAGE" || node.layoutSizingVertical === "FILL";
    const fillCycle = children.some(
      (child) =>
        ("layoutSizingVertical" in child && child.layoutSizingVertical === "FILL") ||
        ("layoutGrow" in child && child.layoutGrow > 0),
    );
    const foreignContent = children.some(
      (child) => child.getPluginData("fad.tool.task-id.v1") !== taskId,
    );
    const supported =
      !fixedBoundary && !fillCycle && !foreignContent && requiredWidth <= node.width + 0.001;
    if (
      supported &&
      requiredHeight > node.height + 0.001 &&
      node.primaryAxisSizingMode !== "AUTO"
    ) {
      markNativeMutation();
      node.primaryAxisSizingMode = "AUTO";
    }
    repairs.push({
      ref: node.getPluginData("fad.tool.logical-ref.v1"),
      parentRef:
        node.parent && node.parent.type !== "PAGE"
          ? node.parent.getPluginData("fad.tool.logical-ref.v1")
          : undefined,
      strategy: supported ? "hug-vertical-content" : "unsupported-preserve-layout",
      required: { width: requiredWidth, height: requiredHeight },
      before,
      after: { width: node.width, height: node.height, primarySizing: node.primaryAxisSizingMode },
      stopReason: fixedBoundary
        ? "fixed-viewport-or-fill-boundary"
        : fillCycle
          ? "primary-fill-cycle"
          : foreignContent
            ? "unowned-content"
            : requiredWidth > node.width + 0.001
              ? "cross-axis-overflow"
              : "native-remeasurement-required",
    });
  };
  visit(root);
  return repairs;
}
