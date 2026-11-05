export const MAX_SCREEN_BYTES = 8 * 1024 * 1024;
export const MAX_SECTION_BYTES = 1024 * 1024;
export const MAX_SECTION_NODES = 250;
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
export const MAX_GENERATED_NODES = 100_000;

// Also runs in Figma's controller, which does not provide browser TextEncoder.
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
