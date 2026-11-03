import { describe, expect, it } from "vitest";
import {
  getInferenceEligibility,
  getInferenceStatusLabel,
  retainSelectedAccountModel,
} from "../src/ui/inference-eligibility";
import {
  runSmokeRequest,
  type CompanionModel,
  type CompanionStatus,
} from "../src/ui/companion-client";
import { navigationReducer } from "../src/ui/App";

const models: CompanionModel[] = [
  { slug: "gpt-6-luna", displayName: "GPT-6-Luna" },
  { slug: "other-model", displayName: "Other model" },
];

const verifiedStatus: CompanionStatus = {
  companion: "connected",
  auth: "ready",
  authLabel: "Ready",
  planUseAuthorized: true,
  modelCount: 2,
  inferenceVerifiedModel: "gpt-6-luna",
};

function eligibility(
  status: CompanionStatus | null = verifiedStatus,
  selectedModel = "gpt-6-luna",
  smokeInFlight = false,
) {
  return getInferenceEligibility({
    companionConnected: true,
    status,
    models,
    selectedModel,
    smokeInFlight,
  });
}

describe("model-specific inference eligibility", () => {
  it("enables generation after a real smoke-verification status for the selected account model", () => {
    expect(eligibility()).toEqual({ eligible: true, verifiedModel: "gpt-6-luna" });
  });

  it("uses the successful smoke response as the same authoritative Design-tab gate", async () => {
    const smoke = await runSmokeRequest("session-bearer", "gpt-6-luna", async () =>
      Response.json({
        success: true,
        completed: true,
        text: "OK",
        status: verifiedStatus,
      }),
    );
    expect(smoke.text).toBe("OK");
    expect(
      getInferenceEligibility({
        companionConnected: true,
        status: smoke.status ?? null,
        models,
        selectedModel: "gpt-6-luna",
        smokeInFlight: false,
      }),
    ).toEqual({ eligible: true, verifiedModel: "gpt-6-luna" });
  });

  it("preserves the same authoritative result when navigating between Settings and Design", () => {
    const settings = navigationReducer(
      { activeView: "design", settingsOpen: false },
      { type: "open-settings" },
    );
    const backToDesign = navigationReducer(settings, { type: "navigate", view: "design" });
    expect(backToDesign).toEqual({ activeView: "design", settingsOpen: false });
    expect(eligibility()).toEqual({ eligible: true, verifiedModel: "gpt-6-luna" });
  });

  it("retains authorization for the same account and exact model slug", () => {
    expect(eligibility(verifiedStatus, "gpt-6-luna").eligible).toBe(true);
    expect(eligibility(verifiedStatus, "other-model")).toMatchObject({
      eligible: false,
      reason: "different_model_verified",
    });
  });

  it("does not reset a smoke-tested selection when models are refreshed", () => {
    expect(retainSelectedAccountModel(models, "gpt-6-luna")).toBe("gpt-6-luna");
    expect(retainSelectedAccountModel(models, "removed-model")).toBe("gpt-6-luna");
    expect(retainSelectedAccountModel([...models].reverse(), "", "gpt-6-luna")).toBe("gpt-6-luna");
    expect(retainSelectedAccountModel([], "gpt-6-luna")).toBe("");
  });

  it("invalidates authorization after account switch or companion session restoration", () => {
    const switchedAccount: CompanionStatus = {
      ...verifiedStatus,
      auth: "signed_out",
      authLabel: "Signed out",
      planUseAuthorized: false,
      inferenceVerifiedModel: undefined,
    };
    const restoredSession: CompanionStatus = {
      ...verifiedStatus,
      auth: "scope_granted",
      authLabel: "Smoke test required",
      inferenceVerifiedModel: undefined,
    };
    expect(eligibility(switchedAccount)).toMatchObject({ eligible: false });
    expect(eligibility(restoredSession)).toMatchObject({
      eligible: false,
      reason: "smoke_test_required",
    });
  });

  it("does not trust a stale Ready label without model binding or a failed/in-flight smoke test", () => {
    const staleReady = { ...verifiedStatus, inferenceVerifiedModel: undefined };
    const staleEligibility = eligibility(staleReady);
    expect(staleEligibility).toMatchObject({
      eligible: false,
      reason: "verification_model_missing",
    });
    expect(getInferenceStatusLabel(staleReady, staleEligibility)).toBe(
      "Smoke-tested model not identified",
    );
    expect(eligibility({ ...verifiedStatus, auth: "scope_granted" })).toMatchObject({
      eligible: false,
      reason: "smoke_test_required",
    });
    expect(eligibility(verifiedStatus, "gpt-6-luna", true)).toMatchObject({
      eligible: false,
      reason: "smoke_test_in_progress",
    });
  });
});
