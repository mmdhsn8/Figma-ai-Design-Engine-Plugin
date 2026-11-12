import { ModelPreferenceArchiveSchema, ModelPreferenceSchema } from "../shared/model-preference";
import type { UIToPluginMessage } from "../shared/messages";
import type { PluginToUIMessage } from "../shared/messages";

export const MODEL_PREFERENCE_KEY = "fad.model-preference.v1";
export const MODEL_PREFERENCE_ARCHIVE_KEY = "fad.model-preference-preserved.v1";
let writeQueue: Promise<void> = Promise.resolve();

type Storage = {
  getAsync(key: string): Promise<unknown>;
  setAsync(key: string, value: unknown): Promise<void>;
};

type ModelPreferenceRequest = Extract<
  UIToPluginMessage,
  { type: "load-model-preference" | "save-model-preference" }
>;

export async function handleModelPreferenceStorage(
  storage: Storage,
  message: ModelPreferenceRequest,
  now = Date.now(),
): Promise<PluginToUIMessage> {
  if (message.type === "load-model-preference") {
    try {
      const saved = await storage.getAsync(MODEL_PREFERENCE_KEY);
      if (saved === undefined)
        return { type: "model-preference-loaded", requestId: message.requestId, state: "empty" };
      const parsed = ModelPreferenceSchema.safeParse(saved);
      return parsed.success
        ? {
            type: "model-preference-loaded",
            requestId: message.requestId,
            state: "valid",
            selectedModel: parsed.data.selectedModel,
          }
        : { type: "model-preference-loaded", requestId: message.requestId, state: "invalid" };
    } catch {
      return {
        type: "model-preference-loaded",
        requestId: message.requestId,
        state: "unavailable",
      };
    }
  }

  const preference = ModelPreferenceSchema.safeParse({
    version: 1,
    selectedModel: message.selectedModel,
  });
  if (!preference.success)
    return { type: "model-preference-saved", requestId: message.requestId, success: false };

  const write = writeQueue.then(async () => {
    try {
      const existing = await storage.getAsync(MODEL_PREFERENCE_KEY);
      if (existing !== undefined && !ModelPreferenceSchema.safeParse(existing).success) {
        const archived = await storage.getAsync(MODEL_PREFERENCE_ARCHIVE_KEY);
        const parsedArchive =
          archived === undefined
            ? { version: 1 as const, entries: [] }
            : ModelPreferenceArchiveSchema.parse(archived);
        if (parsedArchive.entries.length >= 8) return false;
        const nextArchive = ModelPreferenceArchiveSchema.parse({
          version: 1,
          entries: [...parsedArchive.entries, { archivedAt: now, value: existing }],
        });
        await storage.setAsync(MODEL_PREFERENCE_ARCHIVE_KEY, nextArchive);
      }
      await storage.setAsync(MODEL_PREFERENCE_KEY, preference.data);
      return true;
    } catch {
      return false;
    }
  });
  writeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  try {
    return {
      type: "model-preference-saved",
      requestId: message.requestId,
      success: await write,
    };
  } catch {
    return { type: "model-preference-saved", requestId: message.requestId, success: false };
  }
}
