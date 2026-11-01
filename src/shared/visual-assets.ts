export interface EmbeddedImageInfo {
  valid: boolean;
  width: number;
  height: number;
  error?: string;
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index]);
    const b = alphabet.indexOf(value[index + 1]);
    const c = value[index + 2] === "=" ? 0 : alphabet.indexOf(value[index + 2]);
    const d = value[index + 3] === "=" ? 0 : alphabet.indexOf(value[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return undefined;
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < bytes.length) bytes[output++] = (word >> 16) & 0xff;
    if (output < bytes.length) bytes[output++] = (word >> 8) & 0xff;
    if (output < bytes.length) bytes[output++] = word & 0xff;
  }
  return bytes;
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const sof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let size: { width: number; height: number } | undefined;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (marker === 0xda) return size && length >= 6 ? size : undefined;
    if (sof.has(marker)) {
      if (length < 7) return undefined;
      size = {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return undefined;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte))
    return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let seenHeader = false;
  let seenData = false;
  let seenEnd = false;
  while (offset + 12 <= bytes.length) {
    const length =
      bytes[offset] * 2 ** 24 +
      bytes[offset + 1] * 2 ** 16 +
      bytes[offset + 2] * 2 ** 8 +
      bytes[offset + 3];
    const chunkEnd = offset + 12 + length;
    if (length > bytes.length || chunkEnd > bytes.length) return undefined;
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const expectedCrc =
      bytes[chunkEnd - 4] * 2 ** 24 +
      bytes[chunkEnd - 3] * 2 ** 16 +
      bytes[chunkEnd - 2] * 2 ** 8 +
      bytes[chunkEnd - 1];
    if (crc32(bytes, offset + 4, chunkEnd - 4) !== expectedCrc) return undefined;
    if (!seenHeader) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width =
        bytes[offset + 8] * 2 ** 24 +
        bytes[offset + 9] * 2 ** 16 +
        bytes[offset + 10] * 2 ** 8 +
        bytes[offset + 11];
      height =
        bytes[offset + 12] * 2 ** 24 +
        bytes[offset + 13] * 2 ** 16 +
        bytes[offset + 14] * 2 ** 8 +
        bytes[offset + 15];
      seenHeader = true;
    } else if (type === "IHDR") {
      return undefined;
    }
    if (type === "IDAT") seenData = true;
    offset = chunkEnd;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) return undefined;
      seenEnd = true;
      break;
    }
  }
  return seenHeader && seenData && seenEnd && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

export function inspectEmbeddedImage(base64: string, mimeType: string): EmbeddedImageInfo {
  const bytes = decodeBase64(base64);
  if (!bytes)
    return { valid: false, width: 0, height: 0, error: "Image bytes must be canonical base64." };
  if (bytes.length > 256 * 1_024) {
    return {
      valid: false,
      width: 0,
      height: 0,
      error: "Each embedded image is limited to 256 KiB.",
    };
  }
  let size: { width: number; height: number } | undefined;
  if (mimeType === "image/png") {
    size = readPngDimensions(bytes);
  } else if (
    mimeType === "image/gif" &&
    bytes.length >= 14 &&
    bytes.at(-1) === 0x3b &&
    String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")
  ) {
    size = { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  } else if (mimeType === "image/jpeg") {
    if (bytes.length >= 4 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
      size = readJpegDimensions(bytes);
    }
  }
  if (!size || size.width < 1 || size.height < 1) {
    return {
      valid: false,
      width: 0,
      height: 0,
      error: `Bytes are not a complete valid ${mimeType} image or their encoded structure/checksums are corrupt. Re-export the local image or replace it with a safe SVG/vector placeholder, then try again.`,
    };
  }
  if (size.width > 4_096 || size.height > 4_096) {
    return {
      valid: false,
      ...size,
      error: "Figma image fills support a maximum dimension of 4,096 px.",
    };
  }
  return { valid: true, ...size };
}

const COMMAND_ARITY: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };

/** Accepts only Figma's documented absolute path commands; limits coordinates and work. */
export function isFigmaPathData(value: string): boolean {
  if (!value || value.length > 8_192) return false;
  const compact = value.replace(/[\s,]+/g, "");
  const tokens = value.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g);
  if (!tokens || tokens.join("") !== compact || tokens.length > 2_048) return false;
  let cursor = 0;
  let commandCount = 0;
  while (cursor < tokens.length) {
    const command = tokens[cursor++];
    const arity = COMMAND_ARITY[command];
    if (arity === undefined) return false;
    commandCount++;
    const start = cursor;
    while (cursor < tokens.length && !/^[A-Za-z]$/.test(tokens[cursor])) {
      const coordinate = Number(tokens[cursor]);
      if (!Number.isFinite(coordinate) || Math.abs(coordinate) > 8_192) return false;
      cursor++;
    }
    const count = cursor - start;
    if (arity === 0 ? count !== 0 : count < arity || count % arity !== 0) return false;
    if (command === "M" && count !== 2) return false;
  }
  return commandCount >= 2 && tokens[0] === "M";
}

export function scaleFigmaPathData(data: string, scaleX: number, scaleY: number): string {
  if (!isFigmaPathData(data) || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
    throw new Error("Cannot scale invalid Figma vector path data.");
  }
  const tokens = data.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const result: string[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const command = tokens[cursor++];
    result.push(command);
    const arity = COMMAND_ARITY[command];
    let coordinate = 0;
    while (cursor < tokens.length && !/^[A-Za-z]$/.test(tokens[cursor])) {
      const scale = coordinate++ % 2 === 0 ? scaleX : scaleY;
      const value = Number(tokens[cursor++]) * scale;
      result.push(Number(value.toFixed(4)).toString());
      if (result.length > 4_096)
        throw new Error("Scaled vector path exceeds the supported complexity limit.");
    }
    if (arity === undefined) throw new Error("Unsupported Figma vector path command.");
  }
  return result.join(" ");
}

export interface SafeSvgPath {
  name?: string;
  data: string;
  fill: string;
}

export interface SafeSvgImport {
  width: number;
  height: number;
  paths: SafeSvgPath[];
}

function parseAttributes(source: string): Map<string, string> | undefined {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (source.slice(cursor, match.index).trim()) return undefined;
    if (attributes.has(match[1])) return undefined;
    attributes.set(match[1], match[2] ?? match[3] ?? "");
    cursor = (match.index ?? 0) + match[0].length;
  }
  return source.slice(cursor).trim() ? undefined : attributes;
}

function isSafeVectorName(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= 100 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || character === "/" || character === "\\";
    })
  );
}

/**
 * Parses an intentionally small offline SVG subset. Only root viewBox and direct path
 * children are accepted; scripts, CSS, transforms, URLs and external references fail closed.
 */
export function parseSafeSvg(
  source: string,
): { success: true; data: SafeSvgImport } | { success: false; error: string } {
  if (source.length > 50_000)
    return { success: false, error: "SVG files are limited to 50 KB of markup." };
  const withoutXml = source.replace(/^\s*<\?xml\s+[^?]*\?>\s*/i, "");
  const root = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i.exec(withoutXml);
  if (!root || /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<image\b|<use\b/i.test(source)) {
    return {
      success: false,
      error:
        "Use an SVG with one root and direct path children; active or external content is rejected.",
    };
  }
  const rootAttributes = parseAttributes(root[1]);
  if (
    !rootAttributes ||
    [...rootAttributes.keys()].some((key) => !["viewBox", "width", "height", "xmlns"].includes(key))
  ) {
    return {
      success: false,
      error: "SVG root supports only viewBox, width, height and xmlns attributes.",
    };
  }
  const viewBox = (rootAttributes.get("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox.length !== 4 ||
    viewBox[0] !== 0 ||
    viewBox[1] !== 0 ||
    !viewBox.every(Number.isFinite)
  ) {
    return {
      success: false,
      error: "SVG needs a viewBox starting at 0 0 with finite width and height.",
    };
  }
  const [minX, minY, width, height] = viewBox;
  void minX;
  void minY;
  if (width < 1 || height < 1 || width > 4_096 || height > 4_096) {
    return { success: false, error: "SVG viewBox dimensions must be between 1 and 4,096 px." };
  }
  const body = root[2];
  const paths: SafeSvgPath[] = [];
  let cursor = 0;
  const pathTag = /<path\b([^>]*)\/>/gi;
  for (const match of body.matchAll(pathTag)) {
    if (body.slice(cursor, match.index).trim()) {
      return { success: false, error: "SVG may contain only direct self-closing path elements." };
    }
    const attributes = parseAttributes(match[1]);
    if (!attributes || [...attributes.keys()].some((key) => !["d", "fill", "id"].includes(key))) {
      return {
        success: false,
        error:
          "SVG paths support only d, fill and id attributes; style and transforms are rejected.",
      };
    }
    const data = (attributes.get("d") ?? "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    const fill = attributes.get("fill") ?? "#000000";
    const name = attributes.get("id");
    if (
      !isFigmaPathData(data) ||
      !/^#[0-9a-fA-F]{6}$/.test(fill) ||
      (name !== undefined && !isSafeVectorName(name))
    ) {
      return {
        success: false,
        error: "SVG paths need supported absolute M/L/Q/C/Z data and a 6-digit hex fill.",
      };
    }
    paths.push({ name, data, fill });
    if (paths.length > 32)
      return { success: false, error: "SVG is limited to 32 editable vector paths." };
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (!paths.length || body.slice(cursor).trim()) {
    return { success: false, error: "SVG needs 1–32 supported path children and no other markup." };
  }
  if (paths.reduce((total, path) => total + path.data.length, 0) > 40_000) {
    return { success: false, error: "Combined SVG path data is limited to 40 KB." };
  }
  return { success: true, data: { width, height, paths } };
}

export function embeddedImageBytes(base64: string): Uint8Array {
  const bytes = decodeBase64(base64);
  if (!bytes) throw new Error("Image bytes must be canonical base64.");
  return bytes;
}
