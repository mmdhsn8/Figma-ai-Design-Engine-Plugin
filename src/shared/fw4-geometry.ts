import type { DesignProgramV1, DesignProgramNode } from "./design-program";
import { DESIGN_PROGRAM_LIMITS } from "./design-program";
import { nativeTextAutoResize, programTextAutoResize } from "./program-text-layout";
import { z } from "zod";

export const FW4_GEOMETRY_FEATURE = "fw4-geometry-v1" as const;
export const FW4_GEOMETRY_ENABLED = import.meta.env.VITE_FW4_GEOMETRY === FW4_GEOMETRY_FEATURE;
export const FW4_GEOMETRY_NODE_LIMIT = DESIGN_PROGRAM_LIMITS.nodes + 1;

export type NativeSizingModeV1 = "FIXED" | "HUG" | "FILL";
export type NativeTextAutoResizeV1 = "HEIGHT" | "WIDTH_AND_HEIGHT";

/** Redacted expectation derived from the saved DesignProgramV1, without user copy or paint data. */
export type NativeLayoutExpectationV1 = {
  logicalRef: string;
  parentLogicalRef: string;
  horizontalSizing: NativeSizingModeV1;
  verticalSizing: NativeSizingModeV1;
  textAutoResize?: NativeTextAutoResizeV1;
};

export const NativeLayoutExpectationV1Schema = z.object({
  logicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
  parentLogicalRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
  horizontalSizing: z.enum(["FIXED", "HUG", "FILL"]),
  verticalSizing: z.enum(["FIXED", "HUG", "FILL"]),
  textAutoResize: z.enum(["HEIGHT", "WIDTH_AND_HEIGHT"]).optional(),
}).strict();

const nativeSizing = (mode: "fixed" | "hug" | "fill"): NativeSizingModeV1 => mode.toUpperCase() as NativeSizingModeV1;
const programRef = (programId: string, screenId: string, nodeId: string) => `${programId}.${screenId}.${nodeId}`.slice(0, 120);

/**
 * Build a bounded, text-free readback contract for one checkpointed screen.
 * The projection mirrors the stable refs and sizing choices made by the native adapter.
 */
export function projectNativeLayoutExpectations(
  program: DesignProgramV1,
  screenId: string,
): NativeLayoutExpectationV1[] {
  const screen = program.screens.find((candidate) => candidate.id === screenId);
  if (!screen) return [];
  const contentRef = programRef(program.id, screen.id, "content");
  const expectations: NativeLayoutExpectationV1[] = [{
    logicalRef: contentRef,
    parentLogicalRef: `${screen.id}.root`,
    horizontalSizing: "FIXED",
    verticalSizing: "FIXED",
  }];
  let overflowed = false;
  const append = (node: DesignProgramNode, parentLogicalRef: string) => {
    if (expectations.length >= FW4_GEOMETRY_NODE_LIMIT) {
      overflowed = true;
      return;
    }
    const logicalRef = programRef(program.id, screen.id, node.id);
    expectations.push({
      logicalRef,
      parentLogicalRef,
      horizontalSizing: nativeSizing(node.width.mode),
      verticalSizing: nativeSizing(node.height.mode),
      ...(node.type === "text" && programTextAutoResize(node.width.mode, node.height.mode) ? {
        textAutoResize: nativeTextAutoResize(programTextAutoResize(node.width.mode, node.height.mode)!),
      } : {}),
    });
    if (node.type === "container") node.children.forEach((child) => append(child, logicalRef));
  };
  append(screen.root, contentRef);
  if (overflowed || new Set(expectations.map(({ logicalRef }) => logicalRef)).size !== expectations.length)
    return [];
  return expectations;
}
