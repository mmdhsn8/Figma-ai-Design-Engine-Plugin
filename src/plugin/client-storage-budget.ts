import { utf8Bytes } from "../shared/generation-limits";

export type ClientStorageBudgetApi = Pick<PluginAPI["clientStorage"], "getAsync" | "keysAsync">;

const queues = new WeakMap<object, Promise<void>>();

function valueBytes(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error("storage_unavailable");
    return utf8Bytes(serialized);
  } catch {
    throw new Error("storage_unavailable");
  }
}

export function serializeClientStorage<T>(
  storage: object,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(storage) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(
    storage,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export async function measureClientStorage(
  storage: ClientStorageBudgetApi,
  replacements: Map<string, unknown> = new Map(),
  trackedPrefix?: string,
): Promise<{ totalBytes: number; trackedBytes: number }> {
  let keys: string[];
  try {
    keys = await storage.keysAsync();
  } catch {
    throw new Error("storage_unavailable");
  }

  const allKeys = new Set([...keys, ...replacements.keys()]);
  let totalBytes = 0;
  let trackedBytes = 0;
  for (const key of allKeys) {
    let value: unknown;
    if (replacements.has(key)) value = replacements.get(key);
    else {
      try {
        value = await storage.getAsync(key);
      } catch {
        throw new Error("storage_unavailable");
      }
      if (value === undefined) continue;
    }
    const entryBytes = utf8Bytes(key) + valueBytes(value);
    totalBytes += entryBytes;
    if (trackedPrefix && key.startsWith(trackedPrefix)) trackedBytes += entryBytes;
  }
  return { totalBytes, trackedBytes };
}
