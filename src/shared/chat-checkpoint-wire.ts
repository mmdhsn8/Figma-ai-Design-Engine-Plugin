import { utf8Bytes } from "./generation-limits";

// Use the same JSON semantics before transport, on disk, and after read-back.
export function checkpointJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

export function checkpointHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return (left >>> 0).toString(16).padStart(8, "0") + (right >>> 0).toString(16).padStart(8, "0");
}

export function checkpointRevision(json: string) {
  return { hash: checkpointHash(json), bytes: utf8Bytes(json) };
}

export function traceCheckpoint(
  side: "ui" | "controller",
  event: string,
  requestId: string,
  details: Record<string, string | number | boolean | undefined> = {},
) {
  console.log(
    "[FAD_CHECKPOINT] " +
      JSON.stringify({
        version: 2,
        side,
        event,
        correlation: checkpointHash(requestId),
        atMs: Date.now(),
        ...details,
      }),
  );
}
