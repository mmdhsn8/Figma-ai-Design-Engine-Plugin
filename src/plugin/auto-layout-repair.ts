// Repairs only task-owned flow content. Viewport dimensions and unowned layers stay fixed.
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
  const canFillCrossAxis = (child: SceneNode): boolean => {
    if (!("layoutSizingHorizontal" in child)) return false;
    if (child.type !== "TEXT") return true;
    const text = child as TextNode & {
      layoutSizingVertical: "FIXED" | "HUG" | "FILL";
    };
    return text.textAutoResize === "HEIGHT" && text.layoutSizingVertical === "HUG";
  };
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

    const measure = () => {
      const requiredHeight =
        node.paddingTop +
        node.paddingBottom +
        children.reduce((height, child) => height + child.height, 0) +
        Math.max(0, children.length - 1) * node.itemSpacing;
      const requiredWidth =
        node.paddingLeft + node.paddingRight + Math.max(...children.map((child) => child.width));
      return { width: requiredWidth, height: requiredHeight };
    };

    const requiredBefore = measure();
    if (requiredBefore.height <= node.height + 0.001 && requiredBefore.width <= node.width + 0.001)
      return;
    const intentionalVerticalScroll =
      node.clipsContent &&
      (node.overflowDirection === "VERTICAL" || node.overflowDirection === "BOTH");
    if (
      intentionalVerticalScroll &&
      requiredBefore.height > node.height + 0.001 &&
      requiredBefore.width <= node.width + 0.001
    )
      return;

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
    const availableWidth = node.width - node.paddingLeft - node.paddingRight;
    const crossAxisChildren = children.filter((child) => child.width > availableWidth + 0.001);
    const resizedChildren: string[] = [];
    const crossAxisSizingSupported =
      node.counterAxisSizingMode === "FIXED" &&
      !foreignContent &&
      crossAxisChildren.every(canFillCrossAxis);
    let didResizeChild = false;

    if (crossAxisSizingSupported) {
      for (const child of crossAxisChildren) {
        const autoChild = child as SceneNode & {
          layoutSizingHorizontal: "FIXED" | "HUG" | "FILL";
        };
        if (autoChild.layoutSizingHorizontal === "FILL") continue;
        markNativeMutation();
        autoChild.layoutSizingHorizontal = "FILL";
        didResizeChild = true;
        const ref = child.getPluginData("fad.tool.logical-ref.v1");
        if (ref) resizedChildren.push(ref);
      }
    }

    const requiredAfterCrossAxis = measure();
    const canGrowHeight = !fixedBoundary && !fillCycle && !foreignContent;
    const grewHeight =
      canGrowHeight &&
      requiredAfterCrossAxis.height > node.height + 0.001 &&
      node.primaryAxisSizingMode !== "AUTO";
    if (grewHeight) {
      markNativeMutation();
      node.primaryAxisSizingMode = "AUTO";
    }

    const requiredAfter = measure();
    const remainingCrossAxisOverflow = requiredAfter.width > node.width + 0.001;
    const remainingHeightOverflow = requiredAfter.height > node.height + 0.001;
    const changed = didResizeChild || grewHeight;
    const stopReason = remainingCrossAxisOverflow
      ? foreignContent
        ? "unowned-content"
        : "cross-axis-overflow"
      : remainingHeightOverflow
        ? fixedBoundary
          ? "fixed-viewport-or-fill-boundary"
          : fillCycle
            ? "primary-fill-cycle"
            : foreignContent
              ? "unowned-content"
              : "native-remeasurement-required"
        : changed
          ? "native-remeasurement-required"
          : "native-remeasurement-required";

    repairs.push({
      ref: node.getPluginData("fad.tool.logical-ref.v1"),
      parentRef:
        node.parent && node.parent.type !== "PAGE"
          ? node.parent.getPluginData("fad.tool.logical-ref.v1")
          : undefined,
      strategy: changed
        ? didResizeChild
          ? "fill-cross-axis-and-hug-vertical-content"
          : "hug-vertical-content"
        : "unsupported-preserve-layout",
      ...(resizedChildren.length ? { resizedChildren } : {}),
      required: requiredBefore,
      before,
      after: { width: node.width, height: node.height, primarySizing: node.primaryAxisSizingMode },
      stopReason,
    });
  };
  visit(root);
  return repairs;
}
