import { describe, expect, it, vi } from "vitest";
import {
  DESIGN_ENGINE_PREFERENCE_ARCHIVE_KEY,
  DESIGN_ENGINE_PREFERENCE_KEY,
  DesignEnginePreferenceSchema,
} from "../src/shared/design-engine-preference";
import { handleDesignEnginePreferenceStorage } from "../src/plugin/design-engine-preference-storage";

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getAsync: vi.fn(async (key: string) => values.get(key)),
    setAsync: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
}

describe("persistent Design Engine preference", () => {
  it("defaults an empty install to Universal and keeps a saved Legacy selection across reloads", async () => {
    const storage = memoryStorage();
    await expect(
      handleDesignEnginePreferenceStorage(storage, {
        type: "load-design-engine-preference",
        requestId: "engine-load-empty",
      }),
    ).resolves.toMatchObject({ state: "empty" });

    await expect(
      handleDesignEnginePreferenceStorage(storage, {
        type: "save-design-engine-preference",
        requestId: "engine-save-legacy",
        selectedEngine: "legacy",
      }),
    ).resolves.toMatchObject({ success: true, selectedEngine: "legacy" });

    await expect(
      handleDesignEnginePreferenceStorage(storage, {
        type: "load-design-engine-preference",
        requestId: "engine-load-reopened",
      }),
    ).resolves.toMatchObject({ state: "valid", selectedEngine: "legacy" });
    expect(DesignEnginePreferenceSchema.safeParse(storage.values.get(DESIGN_ENGINE_PREFERENCE_KEY)).success).toBe(true);
  });

  it("archives invalid prior preference data before replacing it", async () => {
    const invalid = { version: 4, selectedEngine: "future", extension: "keep" };
    const storage = memoryStorage({ [DESIGN_ENGINE_PREFERENCE_KEY]: invalid });
    await expect(
      handleDesignEnginePreferenceStorage(
        storage,
        { type: "save-design-engine-preference", requestId: "engine-save-new", selectedEngine: "universal" },
        () => 1234,
      ),
    ).resolves.toMatchObject({ success: true });
    expect(storage.values.get(DESIGN_ENGINE_PREFERENCE_ARCHIVE_KEY)).toEqual({
      version: 1,
      entries: [{ archivedAt: 1234, value: invalid }],
    });
    expect(storage.values.get(DESIGN_ENGINE_PREFERENCE_KEY)).toEqual({ version: 1, selectedEngine: "universal" });
  });

  it("fails closed when the saved choice cannot be read or written", async () => {
    const unreadable = memoryStorage();
    unreadable.getAsync.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      handleDesignEnginePreferenceStorage(unreadable, {
        type: "load-design-engine-preference",
        requestId: "engine-load-error",
      }),
    ).resolves.toMatchObject({ state: "unavailable" });

    const unwritable = memoryStorage();
    unwritable.setAsync.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      handleDesignEnginePreferenceStorage(unwritable, {
        type: "save-design-engine-preference",
        requestId: "engine-save-error",
        selectedEngine: "legacy",
      }),
    ).resolves.toMatchObject({ success: false });
  });
});
