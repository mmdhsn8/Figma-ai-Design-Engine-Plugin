import type { MultiScreenProgressMessage, MultiScreenRenderResultMessage } from "./messages";
import { orderMultiScreenItems, type MultiScreenSpec } from "./multi-screen-schema";

export interface MultiScreenPreview {
  id: string;
  name: string;
  estimatedNodeCount: number;
  sharedAssetSummary: string;
  screens: Array<{
    id: string;
    name: string;
    group?: string;
    devicePreset?: string;
    width: number;
    height: number;
  }>;
}

export function createMultiScreenPreview(
  batch: MultiScreenSpec,
  estimatedNodeCount: number,
): MultiScreenPreview {
  return {
    id: batch.id,
    name: batch.name,
    estimatedNodeCount,
    sharedAssetSummary: batch.designSystem
      ? `Design system “${batch.designSystem.namespace}” is resolved once; its owned styles and component masters are reused for every screen. Each batch import creates new screen frames.`
      : "No designSystem section is declared. Each batch import creates new screen frames; existing content is not updated.",
    screens: orderMultiScreenItems(batch.screens).map((screen) => ({
      id: screen.id,
      name: screen.name,
      group: screen.group,
      devicePreset: screen.devicePreset,
      width: screen.width,
      height: screen.height,
    })),
  };
}

export function multiScreenProgressText(progress: MultiScreenProgressMessage): string {
  const attempted = progress.status === "started" ? progress.index - 1 : progress.index;
  const action =
    progress.status === "started"
      ? "Working on"
      : progress.status === "generated"
        ? "Generated"
        : "Failed";
  return `${action}: ${progress.screenName} (${progress.screenId}) · ${attempted} of ${progress.total} attempted.`;
}

export function multiScreenResultLines(result: MultiScreenRenderResultMessage): string[] {
  return [
    `${result.createdNodeCount} native nodes created · ${result.estimatedNodeCount} nodes estimated · ${result.gap} px gap · ${result.maxRowWidth} px row width.`,
    `${result.counts.frames} frames · ${result.counts.texts} text · ${result.counts.rectangles} rectangles · ${(result.counts.ellipses ?? 0) + (result.counts.vectors ?? 0)} editable vector/ellipse shapes · ${result.counts.images ?? 0} image fills · ${result.counts.instances} instances.`,
    ...result.screens
      .filter((screen) => screen.status === "failed")
      .map((screen) => `${screen.id}: ${screen.error ?? "Generation failed."}`),
    ...result.warnings,
  ];
}
