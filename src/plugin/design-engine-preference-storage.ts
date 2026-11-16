import {
  DesignEnginePreferenceArchiveSchema,
  DesignEnginePreferenceSchema,
  DESIGN_ENGINE_PREFERENCE_ARCHIVE_KEY,
  DESIGN_ENGINE_PREFERENCE_KEY,
  type DesignEngine,
} from "../shared/design-engine-preference";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";

let writeQueue: Promise<void> = Promise.resolve();

type Storage = {
  getAsync(key: string): Promise<unknown>;
  setAsync(key: string, value: unknown): Promise<void>;
};

type Request = Extract<UIToPluginMessage, { type: "load-design-engine-preference" | "save-design-engine-preference" }>;

export async function handleDesignEnginePreferenceStorage(
  storage: Storage,
  message: Request,
  now = Date.now,
): Promise<PluginToUIMessage> {
  if (message.type === "load-design-engine-preference") {
    try {
      const stored = await storage.getAsync(DESIGN_ENGINE_PREFERENCE_KEY);
      if (stored === undefined)
        return { type: "design-engine-preference-loaded", requestId: message.requestId, state: "empty" };
      const parsed = DesignEnginePreferenceSchema.safeParse(stored);
      return parsed.success
        ? { type: "design-engine-preference-loaded", requestId: message.requestId, state: "valid", selectedEngine: parsed.data.selectedEngine }
        : { type: "design-engine-preference-loaded", requestId: message.requestId, state: "invalid" };
    } catch {
      return { type: "design-engine-preference-loaded", requestId: message.requestId, state: "unavailable" };
    }
  }

  const selectedEngine: DesignEngine = message.selectedEngine;
  const write = writeQueue.then(async () => {
    try {
      const existing = await storage.getAsync(DESIGN_ENGINE_PREFERENCE_KEY);
      if (existing !== undefined && !DesignEnginePreferenceSchema.safeParse(existing).success) {
        const storedArchive = await storage.getAsync(DESIGN_ENGINE_PREFERENCE_ARCHIVE_KEY);
        const archive = storedArchive === undefined
          ? { version: 1 as const, entries: [] }
          : DesignEnginePreferenceArchiveSchema.parse(storedArchive);
        if (archive.entries.length >= 8) return false;
        const nextArchive = DesignEnginePreferenceArchiveSchema.parse({
          version: 1,
          entries: [...archive.entries, { archivedAt: now(), value: existing }],
        });
        await storage.setAsync(DESIGN_ENGINE_PREFERENCE_ARCHIVE_KEY, nextArchive);
      }
      await storage.setAsync(DESIGN_ENGINE_PREFERENCE_KEY, { version: 1, selectedEngine });
      return true;
    } catch {
      return false;
    }
  });
  writeQueue = write.then(() => undefined, () => undefined);
  const success = await write.catch(() => false);
  return {
    type: "design-engine-preference-saved",
    requestId: message.requestId,
    success,
    ...(success ? { selectedEngine } : {}),
  };
}
