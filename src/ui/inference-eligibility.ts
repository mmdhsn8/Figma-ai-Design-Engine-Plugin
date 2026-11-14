import type { CompanionModel, CompanionStatus } from "./companion-client";

export type InferenceEligibilityReason =
  | "companion_unavailable"
  | "connection_status_missing"
  | "plan_use_not_authorized"
  | "smoke_test_in_progress"
  | "models_not_loaded"
  | "model_not_selected"
  | "model_not_account_visible"
  | "smoke_test_required"
  | "verification_model_missing"
  | "different_model_verified";

export type InferenceEligibility =
  | { eligible: true; verifiedModel: string }
  | { eligible: false; reason: InferenceEligibilityReason; message: string };

export function retainSelectedAccountModel(
  models: CompanionModel[],
  selectedModel: string,
  verifiedModel?: string,
): string {
  // Existing conversation and saved user choices remain authoritative even if
  // the refreshed catalog no longer contains them. The caller can then show
  // an unavailable state and let the user choose explicitly.
  if (selectedModel) return selectedModel;
  if (verifiedModel && models.some(({ slug }) => slug === verifiedModel)) return verifiedModel;
  return "";
}

export function getInferenceStatusLabel(
  status: CompanionStatus | null,
  eligibility: InferenceEligibility,
): string {
  if (eligibility.eligible) return "Ready for AI";
  if (eligibility.reason === "smoke_test_in_progress") return "Responses smoke test in progress";
  if (!status) return eligibility.message;
  if (status.auth !== "ready") return status.authLabel;
  if (eligibility.reason === "verification_model_missing")
    return "Smoke-tested model not identified";
  if (eligibility.reason === "different_model_verified") return "Another model was smoke-tested";
  if (eligibility.reason === "models_not_loaded") return "Load models to resume";
  if (eligibility.reason === "model_not_selected") return "Select a model";
  return "Inference verification incomplete";
}

export function getInferenceEligibility(input: {
  companionConnected: boolean;
  status: CompanionStatus | null;
  models: CompanionModel[];
  selectedModel: string;
  smokeInFlight: boolean;
}): InferenceEligibility {
  if (!input.companionConnected) {
    return {
      eligible: false,
      reason: "companion_unavailable",
      message: "Connect to the local companion in Settings.",
    };
  }
  if (!input.status) {
    return {
      eligible: false,
      reason: "connection_status_missing",
      message: "Refresh the local companion status in Settings.",
    };
  }
  if (!input.status.planUseAuthorized) {
    return {
      eligible: false,
      reason: "plan_use_not_authorized",
      message: "Complete ChatGPT sign-in and grant direct plan-use permission.",
    };
  }
  if (input.smokeInFlight) {
    return {
      eligible: false,
      reason: "smoke_test_in_progress",
      message: "The selected model's Responses smoke test is still running.",
    };
  }
  if (!input.models.length) {
    return {
      eligible: false,
      reason: "models_not_loaded",
      message: "Load the account-visible model list in Settings.",
    };
  }
  if (!input.selectedModel) {
    return {
      eligible: false,
      reason: "model_not_selected",
      message: "Select an account-visible model.",
    };
  }
  const selected = input.models.find(({ slug }) => slug === input.selectedModel);
  if (!selected) {
    return {
      eligible: false,
      reason: "model_not_account_visible",
      message: "The selected model is not in this account's current model list. Reload models.",
    };
  }
  if (input.status.auth !== "ready") {
    return {
      eligible: false,
      reason: "smoke_test_required",
      message: `Run the fixed Responses smoke test for ${selected.displayName} in Settings.`,
    };
  }
  const verifiedModel = input.status.inferenceVerifiedModel;
  if (!verifiedModel) {
    return {
      eligible: false,
      reason: "verification_model_missing",
      message:
        "The companion reports Ready but did not identify the smoke-tested model. Restart/update npm run companion, reload the plugin, and run the smoke test again.",
    };
  }
  if (verifiedModel !== selected.slug) {
    const verified =
      input.models.find(({ slug }) => slug === verifiedModel)?.displayName ?? verifiedModel;
    return {
      eligible: false,
      reason: "different_model_verified",
      message: `The smoke test verified ${verified}, not ${selected.displayName}. Run it for the selected model.`,
    };
  }
  return { eligible: true, verifiedModel };
}
