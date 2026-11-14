import { describe, expect, it, vi } from "vitest";
import {
  ModelReadinessConsent,
  ModelReadinessRequests,
  MODEL_CATALOG_TTL_MS,
  modelCatalogIsFresh,
  modelReadinessPhase,
  shouldAutomaticallyDiscoverModels,
} from "../src/ui/model-readiness";
import {
  getInferenceEligibility,
  retainSelectedAccountModel,
} from "../src/ui/inference-eligibility";
import type { CompanionModel, CompanionStatus } from "../src/ui/companion-client";
import { taskModelForExecution } from "../src/shared/model-preference";

const models: CompanionModel[] = [
  { slug: "gpt-6-luna", displayName: "GPT-6-Luna" },
  { slug: "other-model", displayName: "Other model" },
];

function status(
  auth: CompanionStatus["auth"] = "scope_granted",
  inferenceVerifiedModel?: string,
): CompanionStatus {
  return {
    companion: "connected",
    auth,
    authLabel: auth,
    planUseAuthorized: auth === "scope_granted" || auth === "ready",
    modelCount: 2,
    sessionId: "session-nonce-1234567890",
    ...(inferenceVerifiedModel ? { inferenceVerifiedModel } : {}),
  };
}

function phase(input: {
  status?: CompanionStatus | null;
  discovery?: "idle" | "loading" | "loaded" | "empty" | "error";
  models?: CompanionModel[];
  selectedModel?: string;
  connected?: boolean;
  smokeInFlight?: boolean;
}) {
  const resolvedStatus = input.status === undefined ? status() : input.status;
  const resolvedModels = input.models ?? models;
  const selectedModel = input.selectedModel ?? "gpt-6-luna";
  const eligibility = getInferenceEligibility({
    companionConnected: input.connected ?? true,
    status: resolvedStatus,
    models: resolvedModels,
    selectedModel,
    smokeInFlight: input.smokeInFlight ?? false,
  });
  return modelReadinessPhase({
    connected: input.connected ?? true,
    status: resolvedStatus,
    discovery: input.discovery ?? "loaded",
    models: resolvedModels,
    selectedModel,
    smokeInFlight: input.smokeInFlight ?? false,
    eligibility,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("automatic model readiness state machine", () => {
  it("reproduces connected-but-unloaded Chat and advances automatically after a fresh catalog", () => {
    expect(phase({ discovery: "idle", models: [] })).toBe("discovering_models");
    expect(
      shouldAutomaticallyDiscoverModels({
        connected: true,
        status: status(),
        preferenceLoaded: true,
        discovery: "idle",
      }),
    ).toBe(true);
    expect(phase({ discovery: "loaded" })).toBe("awaiting_test_consent");
    expect(phase({ status: status("ready", "gpt-6-luna") })).toBe("ready");
  });

  it("starts without a Settings navigation prerequisite", () => {
    const startup = {
      connected: true,
      status: status(),
      preferenceLoaded: true,
      discovery: "idle" as const,
    };
    expect(shouldAutomaticallyDiscoverModels(startup)).toBe(true);
  });

  it("does not discover before the saved model preference has loaded", () => {
    expect(
      shouldAutomaticallyDiscoverModels({
        connected: true,
        status: status(),
        preferenceLoaded: false,
        discovery: "idle",
      }),
    ).toBe(false);
  });

  it("requires a reachable connection and authorized account before discovery", () => {
    expect(
      shouldAutomaticallyDiscoverModels({
        connected: false,
        status: status(),
        preferenceLoaded: true,
        discovery: "idle",
      }),
    ).toBe(false);
    expect(
      shouldAutomaticallyDiscoverModels({
        connected: true,
        status: status("signed_in_no_plan"),
        preferenceLoaded: true,
        discovery: "idle",
      }),
    ).toBe(false);
  });

  it("does not treat transport-only Connected as account or model readiness", () => {
    expect(phase({ status: null })).toBe("connecting");
    expect(phase({ status: null, discovery: "loaded" })).toBe("connecting");
  });

  it("keeps unauthorized accounts blocked without a smoke test", () => {
    expect(phase({ status: status("signed_in_no_plan") })).toBe("authentication_required");
    expect(phase({ status: status("session_expired") })).toBe("blocked");
  });

  it("does not choose the first provider model when no explicit preference exists", () => {
    expect(retainSelectedAccountModel(models, "")).toBe("");
  });

  it("preserves a saved model even when it is absent from the current catalog", () => {
    expect(retainSelectedAccountModel(models, "removed-model")).toBe("removed-model");
    expect(phase({ selectedModel: "removed-model" })).toBe("model_unavailable");
  });

  it("does not fall back when the selected model is missing from the account catalog", () => {
    expect(retainSelectedAccountModel(models, "removed-model", "gpt-6-luna")).toBe("removed-model");
    expect(phase({ models: [models[1]!], selectedModel: "gpt-6-luna" })).toBe("model_unavailable");
  });

  it("requires explicit model selection when neither a preference nor verified model exists", () => {
    expect(phase({ selectedModel: "" })).toBe("model_selection_required");
  });

  it("does not offer smoke verification for a model outside the fresh account catalog", () => {
    expect(phase({ models: [], selectedModel: "gpt-6-luna" })).toBe("model_unavailable");
  });

  it("requires one-time consent for a catalog-visible but unverified model", () => {
    expect(phase({ status: status("scope_granted") })).toBe("awaiting_test_consent");
  });

  it("does not mark a different model ready from the current verification", () => {
    expect(phase({ status: status("ready", "other-model") })).toBe("awaiting_test_consent");
  });

  it("reports verification in progress until the scoped smoke request completes", () => {
    expect(phase({ status: status("scope_granted"), smokeInFlight: true })).toBe("verifying");
  });

  it("keeps discovery errors retryable and catalog failures out of Ready", () => {
    expect(phase({ discovery: "error" })).toBe("retryable_error");
    expect(phase({ discovery: "empty", models: [] })).toBe("model_unavailable");
  });

  it("requires a fresh catalog and exact session/model verification for Ready", () => {
    expect(phase({ discovery: "idle", status: status("ready", "gpt-6-luna") })).toBe(
      "discovering_models",
    );
    expect(phase({ status: status("ready") })).toBe("awaiting_test_consent");
    expect(phase({ status: status("ready", "gpt-6-luna") })).toBe("ready");
  });

  it("reuses a still-live task pin without changing it to the new global preference", () => {
    expect(taskModelForExecution("pinned-model", "new-default")).toBe("pinned-model");
  });
});

describe("scoped readiness requests and consent", () => {
  it("deduplicates catalog discovery across startup, Chat, Settings, and reconnect callers", async () => {
    const requests = new ModelReadinessRequests();
    const result = deferred<string[]>();
    const execute = vi.fn(() => result.promise);
    const first = requests.runCatalog("session-A", execute);
    const second = requests.runCatalog("session-A", execute);
    expect(execute).toHaveBeenCalledTimes(1);
    result.resolve(["gpt-6-luna"]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { current: true, value: ["gpt-6-luna"] },
      { current: true, value: ["gpt-6-luna"] },
    ]);
  });

  it("deduplicates concurrent smoke tests for the same exact session and model", async () => {
    const requests = new ModelReadinessRequests();
    const result = deferred<string>();
    const execute = vi.fn(() => result.promise);
    const first = requests.runSmoke("session-A:gpt-6-luna", execute);
    const second = requests.runSmoke("session-A:gpt-6-luna", execute);
    expect(execute).toHaveBeenCalledTimes(1);
    result.resolve("verified");
    await expect(Promise.all([first, second])).resolves.toEqual([
      { current: true, value: "verified" },
      { current: true, value: "verified" },
    ]);
  });

  it("aborts and fences a stale account catalog after account A changes to B", async () => {
    const requests = new ModelReadinessRequests();
    const oldResult = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    const oldRequest = requests.runCatalog("session-A", (signal) => {
      oldSignal = signal;
      return oldResult.promise;
    });
    requests.invalidate();
    const newRequest = requests.runCatalog("session-B", async () => "account B");
    expect(oldSignal?.aborted).toBe(true);
    oldResult.resolve("account A");
    await expect(oldRequest).resolves.toMatchObject({ current: false, value: "account A" });
    await expect(newRequest).resolves.toMatchObject({ current: true, value: "account B" });
  });

  it("aborts a model X smoke when a new model Y request replaces its scope", async () => {
    const requests = new ModelReadinessRequests();
    const oldResult = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    const oldRequest = requests.runSmoke("session-A:model-X", (signal) => {
      oldSignal = signal;
      return oldResult.promise;
    });
    const newRequest = requests.runSmoke("session-A:model-Y", async () => "model Y");
    expect(oldSignal?.aborted).toBe(true);
    oldResult.resolve("model X");
    await expect(oldRequest).resolves.toMatchObject({ current: false, value: "model X" });
    await expect(newRequest).resolves.toMatchObject({ current: true, value: "model Y" });
  });

  it("does not surface a stale canceled request error after its account/model scope changes", async () => {
    const requests = new ModelReadinessRequests();
    const oldResult = deferred<string>();
    const oldRequest = requests.runSmoke("session-A:model-X", () => oldResult.promise);
    const newRequest = requests.runSmoke("session-A:model-Y", async () => "model Y");
    oldResult.reject(new Error("old model error"));
    await expect(oldRequest).resolves.toMatchObject({
      current: false,
      error: expect.any(Error),
    });
    await expect(newRequest).resolves.toMatchObject({ current: true, value: "model Y" });
  });

  it("deduplicates consent for a session/model but requests it for another model or session", () => {
    const consent = new ModelReadinessConsent();
    expect(consent.shouldPrompt("session-A:gpt-6-luna")).toBe(true);
    expect(consent.shouldPrompt("session-A:gpt-6-luna")).toBe(false);
    expect(consent.shouldPrompt("session-A:other-model")).toBe(true);
    expect(consent.shouldPrompt("session-B:gpt-6-luna")).toBe(true);
  });

  it("allows only one bounded explicit retry after a failed smoke attempt", () => {
    const consent = new ModelReadinessConsent();
    expect(consent.beginSmoke("session-A:gpt-6-luna")).toBe(1);
    expect(consent.canOfferOneRetry("session-A:gpt-6-luna")).toBe(true);
    expect(consent.beginSmoke("session-A:gpt-6-luna")).toBe(2);
    expect(consent.canOfferOneRetry("session-A:gpt-6-luna")).toBe(false);
  });

  it("clears remembered consent and attempts when the session is invalidated", () => {
    const consent = new ModelReadinessConsent();
    consent.shouldPrompt("session-A:gpt-6-luna");
    consent.accept("session-A:gpt-6-luna");
    consent.beginSmoke("session-A:gpt-6-luna");
    consent.clear();
    expect(consent.shouldPrompt("session-A:gpt-6-luna")).toBe(true);
    expect(consent.canOfferOneRetry("session-A:gpt-6-luna")).toBe(false);
  });

  it("expires the nonpersistent account-visible catalog after its bounded TTL", () => {
    const now = 10_000;
    expect(modelCatalogIsFresh(now, now + MODEL_CATALOG_TTL_MS - 1)).toBe(true);
    expect(modelCatalogIsFresh(now, now + MODEL_CATALOG_TTL_MS)).toBe(false);
    expect(modelCatalogIsFresh(null, now)).toBe(false);
  });

  it("keeps catalog discovery and smoke verification as separate operations", async () => {
    const requests = new ModelReadinessRequests();
    const catalog = requests.runCatalog("session-A", async () => "catalog");
    const smoke = requests.runSmoke("session-A:gpt-6-luna", async () => "smoke");
    await expect(catalog).resolves.toMatchObject({ current: true, value: "catalog" });
    await expect(smoke).resolves.toMatchObject({ current: true, value: "smoke" });
  });
});
