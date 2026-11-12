import { z } from "zod";

export const ModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/u);

export const ModelPreferenceSchema = z
  .object({
    version: z.literal(1),
    selectedModel: ModelIdSchema,
  })
  .strict();

export const ModelPreferenceArchiveSchema = z
  .object({
    version: z.literal(1),
    entries: z
      .array(
        z
          .object({
            archivedAt: z.number().int().nonnegative(),
            value: z.unknown(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type ModelPreference = z.infer<typeof ModelPreferenceSchema>;

export function taskModelForExecution(
  pinnedModel: string | undefined,
  selectedModel: string,
): string {
  return pinnedModel || selectedModel;
}

export type ModelCatalogState =
  | "checking"
  | "companion_unavailable"
  | "authentication_required"
  | "session_expired"
  | "provider_unavailable"
  | "rate_limited"
  | "model_unavailable"
  | "model_unverified"
  | "ready"
  | "unknown_error";

export function modelCatalogState(input: {
  reachable: boolean;
  auth?: string;
  catalogLoaded: boolean;
  catalogError?: string | null;
  selectedModel: string;
  availableModels: string[];
  verifiedModel?: string;
}): ModelCatalogState {
  if (!input.reachable) return "companion_unavailable";
  if (input.catalogError === "quota_or_rate_limit") return "rate_limited";
  if (
    input.catalogError === "service_unavailable" ||
    input.catalogError === "request_timed_out" ||
    input.catalogError === "connection_failed"
  )
    return "provider_unavailable";
  if (input.auth === "session_expired") return "session_expired";
  if (input.catalogError === "session_expired") return "session_expired";
  if (
    input.catalogError === "model_not_verified_for_account" ||
    input.catalogError === "model_unavailable"
  )
    return "model_unavailable";
  if (!input.auth || input.auth === "signed_out" || input.auth === "signing_in")
    return input.auth === "signing_in" ? "checking" : "authentication_required";
  if (input.auth === "blocked" || input.auth === "signed_in_no_plan")
    return "authentication_required";
  if (
    input.catalogError === "plan_use_scope_missing" ||
    input.catalogError === "account_not_eligible"
  )
    return "authentication_required";
  if (input.catalogError) return "unknown_error";
  if (!input.catalogLoaded) return "checking";
  if (input.selectedModel && !input.availableModels.includes(input.selectedModel))
    return "model_unavailable";
  if (input.auth !== "ready") return "model_unverified";
  if (!input.selectedModel || input.verifiedModel !== input.selectedModel)
    return "model_unverified";
  return "ready";
}
