export type ProgramTextSizingMode = "fixed" | "hug" | "fill";
export type ProgramTextAutoResize = "height" | "width-and-height";

/**
 * Universal text keeps one content-sized vertical axis. A bounded horizontal
 * axis wraps and lets the text height grow; HUG/HUG uses Figma's no-wrap mode.
 */
export function programTextAutoResize(
  width: ProgramTextSizingMode,
  height: ProgramTextSizingMode,
): ProgramTextAutoResize | undefined {
  if (height !== "hug") return undefined;
  return width === "hug" ? "width-and-height" : "height";
}

export function nativeTextAutoResize(mode: ProgramTextAutoResize): "HEIGHT" | "WIDTH_AND_HEIGHT" {
  return mode === "width-and-height" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
}

/**
 * Conservative preflight estimate only. Figma's loaded-font layout and native
 * readback remain authoritative for actual dimensions.
 */
export function estimateProgramTextHeight(input: {
  text: string;
  fontSize: number;
  width: number;
}): number {
  const lineHeight = input.fontSize * 1.2;
  const width = input.width === Number.POSITIVE_INFINITY ? input.width : Math.max(1, input.width);
  const glyphAdvance = input.fontSize * 0.62;
  const lines = input.text.split("\n").reduce((sum, line) => {
    const glyphs = Array.from(line).length;
    return sum + Math.max(1, Math.ceil((glyphs * glyphAdvance) / width));
  }, 0);
  return Math.ceil(lines * lineHeight);
}

export function estimateProgramTextWidth(text: string, fontSize: number): number {
  const glyphAdvance = fontSize * 0.62;
  return Math.ceil(Math.max(0, ...text.split("\n").map((line) => Array.from(line).length * glyphAdvance)));
}
