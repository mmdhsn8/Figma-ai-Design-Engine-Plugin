import { describe, expect, it, vi } from "vitest";
import {
  MODEL_PREFERENCE_ARCHIVE_KEY,
  MODEL_PREFERENCE_KEY,
  handleModelPreferenceStorage,
} from "../src/plugin/model-preference-storage";
import {
  ModelPreferenceSchema,
  modelCatalogState,
  taskModelForExecution,
} from "../src/shared/model-preference";

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

describe("versioned account-model preference storage", () => {
  it("loads an empty preference and persists a validated selection for plugin reopen", async () => {
    const storage = memoryStorage();
    await expect(
      handleModelPreferenceStorage(storage, { type: "load-model-preference", requestId: "load-1" }),
    ).resolves.toMatchObject({ state: "empty" });
    await expect(
      handleModelPreferenceStorage(storage, {
        type: "save-model-preference",
        requestId: "save-1",
        selectedModel: "provider/model-v2",
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      handleModelPreferenceStorage(storage, { type: "load-model-preference", requestId: "load-2" }),
    ).resolves.toMatchObject({ state: "valid", selectedModel: "provider/model-v2" });
    expect(storage.values.get(MODEL_PREFERENCE_KEY)).toEqual({
      version: 1,
      selectedModel: "provider/model-v2",
    });
  });

  it("preserves corrupt or future-version bytes before an explicit replacement", async () => {
    const futureRecord = { version: 9, selectedModel: "provider/model-future", extra: "retained" };
    const storage = memoryStorage({ [MODEL_PREFERENCE_KEY]: futureRecord });
    await expect(
      handleModelPreferenceStorage(storage, { type: "load-model-preference", requestId: "load-3" }),
    ).resolves.toMatchObject({ state: "invalid" });
    expect(storage.values.get(MODEL_PREFERENCE_KEY)).toBe(futureRecord);
    await expect(
      handleModelPreferenceStorage(
        storage,
        { type: "save-model-preference", requestId: "save-2", selectedModel: "provider/model-v3" },
        1234,
      ),
    ).resolves.toMatchObject({ success: true });
    expect(storage.values.get(MODEL_PREFERENCE_ARCHIVE_KEY)).toEqual({
      version: 1,
      entries: [{ archivedAt: 1234, value: futureRecord }],
    });
    expect(storage.values.get(MODEL_PREFERENCE_KEY)).toEqual({
      version: 1,
      selectedModel: "provider/model-v3",
    });
  });

  it("fails closed when damaged bytes cannot be archived or storage writes fail", async () => {
    const corrupt = { version: 1, selectedModel: "invalid id" };
    const storage = memoryStorage({ [MODEL_PREFERENCE_KEY]: corrupt });
    storage.setAsync.mockImplementation(async (key: string) => {
      if (key === MODEL_PREFERENCE_ARCHIVE_KEY) throw new Error("quota");
    });
    await expect(
      handleModelPreferenceStorage(storage, {
        type: "save-model-preference",
        requestId: "save-3",
        selectedModel: "provider/model-v4",
      }),
    ).resolves.toMatchObject({ success: false });
    expect(storage.values.get(MODEL_PREFERENCE_KEY)).toBe(corrupt);
    expect(
      ModelPreferenceSchema.safeParse({ version: 1, selectedModel: "invalid id" }).success,
    ).toBe(false);
  });

  it("serializes rapid selections so the latest acknowledged choice wins", async () => {
    const storage = memoryStorage();
    const results = await Promise.all([
      handleModelPreferenceStorage(storage, {
        type: "save-model-preference",
        requestId: "save-4",
        selectedModel: "provider/model-a",
      }),
      handleModelPreferenceStorage(storage, {
        type: "save-model-preference",
        requestId: "save-5",
        selectedModel: "provider/model-b",
      }),
    ]);
    expect(
      results.every((result) => result.type === "model-preference-saved" && result.success),
    ).toBe(true);
    expect(storage.values.get(MODEL_PREFERENCE_KEY)).toEqual({
      version: 1,
      selectedModel: "provider/model-b",
    });
  });
});

describe("canonical connection and model readiness states", () => {
  const connected = {
    reachable: true,
    auth: "ready",
    catalogLoaded: true,
    selectedModel: "provider/model-a",
    availableModels: ["provider/model-a"],
    verifiedModel: "provider/model-a",
  };

  it("keeps Companion reachability separate from account and inference readiness", () => {
    expect(modelCatalogState({ ...connected, reachable: false })).toBe("companion_unavailable");
    expect(modelCatalogState({ ...connected, auth: "signed_out" })).toBe("authentication_required");
    expect(modelCatalogState({ ...connected, auth: "session_expired" })).toBe("session_expired");
    expect(modelCatalogState({ ...connected, auth: "scope_granted" })).toBe("model_unverified");
  });

  it("reports provider failures, rate limiting, removed models, and verified readiness", () => {
    expect(modelCatalogState({ ...connected, catalogError: "quota_or_rate_limit" })).toBe(
      "rate_limited",
    );
    expect(modelCatalogState({ ...connected, catalogError: "service_unavailable" })).toBe(
      "provider_unavailable",
    );
    expect(modelCatalogState({ ...connected, availableModels: ["provider/model-b"] })).toBe(
      "model_unavailable",
    );
    expect(modelCatalogState(connected)).toBe("ready");
  });

  it("does not call an unverified or absent catalog ready", () => {
    expect(modelCatalogState({ ...connected, catalogLoaded: false })).toBe("checking");
    expect(modelCatalogState({ ...connected, verifiedModel: "provider/model-b" })).toBe(
      "model_unverified",
    );
    expect(
      modelCatalogState({
        ...connected,
        selectedModel: "",
        availableModels: [],
        verifiedModel: undefined,
      }),
    ).toBe("model_unverified");
  });
});

describe("task model continuity", () => {
  it("keeps the task checkpoint model across preference changes and only binds legacy tasks at explicit resume", () => {
    expect(taskModelForExecution("provider/model-at-start", "provider/new-default")).toBe(
      "provider/model-at-start",
    );
    expect(taskModelForExecution(undefined, "provider/chosen-for-legacy-resume")).toBe(
      "provider/chosen-for-legacy-resume",
    );
  });
});
