import { deflateSync } from "node:zlib";

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const data = Buffer.concat([typeBytes, Buffer.from(payload)]);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  Buffer.from(payload).copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(data), chunk.length - 4);
  typeBytes.copy(chunk, 4);
  return chunk;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8; // 8-bit channels
header[9] = 6; // RGBA

const onePixelPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", header),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
  pngChunk("IEND", new Uint8Array()),
]);

export const ONE_PIXEL_PNG = onePixelPng.toString("base64");

export function crc32ForPngChunk(bytes: Uint8Array): number {
  return pngCrc32(bytes);
}
