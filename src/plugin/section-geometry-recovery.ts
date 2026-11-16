import type { GenerationTransaction } from "../shared/generation-transaction";
import type { NativeDesignVerification } from "./native-design-verification";

/** One bounded adjustment of a committed section's fixed vertical text container. */
export function expandClippedSectionTextParent(
  root: FrameNode,
  transaction: GenerationTransaction,
  verification: NativeDesignVerification,
  maxSectionHeight: number,
): (() => void) | undefined {
  if (verification.truncated || verification.rootNodeId !== root.id) return;
  if (root.getPluginData("fad.multi-screen.batch-id") !== transaction.generation_id ||
      root.getPluginData("fad.multi-screen.screen-id") !== transaction.screen_id) return;
  const findings = verification.findings.filter(({ code }) => code === "clipped-child");
  const ref = findings[0]?.ref;
  if (findings.length !== 1 || !ref) return;
  const sections = root.children.filter((node) =>
    node.type === "FRAME" &&
    node.getPluginData("fad.generation.transaction.key") === transaction.idempotency_key &&
    node.getPluginData("fad.generation.semantic-id") === transaction.operation.node_id,
  );
  const section = sections[0];
  if (sections.length !== 1 || section?.type !== "FRAME") return;
  const matches = section.findAll((node) => node.getPluginData("fad.design.logical-ref") === ref);
  const child = matches[0];
  const parent = child?.parent;
  if (matches.length !== 1 || child?.type !== "TEXT" || parent?.type !== "FRAME" ||
      parent.layoutMode !== "VERTICAL" || parent.primaryAxisSizingMode !== "FIXED" ||
      parent.primaryAxisAlignItems !== "MIN" || !parent.clipsContent ||
      parent.overflowDirection !== "NONE" ||
      child.textAutoResize !== "HEIGHT" ||
      !transaction.operation.node_ids.includes(parent.getPluginData("fad.generation.semantic-id")) ||
      !transaction.operation.node_ids.includes(child.getPluginData("fad.generation.semantic-id")) ||
      parent.children.some((node) => !("layoutPositioning" in node) ||
        node.layoutPositioning === "ABSOLUTE" ||
        ("layoutSizingVertical" in node && node.layoutSizingVertical === "FILL"))) return;
  const [[a, c, x], [b, d, y]] = child.relativeTransform;
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      a !== 1 || d !== 1 || b !== 0 || c !== 0 ||
      x < 0 || y < 0 || x + child.width > parent.width ||
      y + child.height <= parent.height) return;
  const width = parent.width;
  const height = parent.height;
  const horizontalSizing = parent.layoutSizingHorizontal;
  const nextHeight = Math.ceil(y + child.height + parent.paddingBottom);
  const growth = nextHeight - height;
  if (!Number.isFinite(growth) || growth <= 0 || growth > 32 ||
      section.height + growth > maxSectionHeight ||
      (parent.maxHeight != null && nextHeight > parent.maxHeight)) return;
  const resize = (targetHeight: number) => {
    parent.resize(width, targetHeight);
    if (parent.layoutSizingHorizontal !== horizontalSizing)
      parent.layoutSizingHorizontal = horizontalSizing;
  };
  resize(nextHeight);
  return () => resize(height);
}
