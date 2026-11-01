import { z } from "zod";
import { COMPANION_BASE_URL } from "../companion/config";

export const COMPANION_URL = COMPANION_BASE_URL;

const StatusSchema = z
  .object({
    companion: z.literal("connected"),
    auth: z.enum([
      "signed_out",
      "signing_in",
      "signed_in_no_plan",
      "scope_granted",
      "ready",
      "session_expired",
      "blocked",
    ]),
    authLabel: z.string().max(80),
    planUseAuthorized: z.boolean(),
    modelCount: z.number().int().nonnegative().max(100),
    safeMessage: z.string().max(80).optional(),
  })
  .strict();

const HealthSchema = z.object({ companion: z.literal("running") }).strict();
const PairingAttemptSchema = z
  .object({
    attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    expiresInMs: z.number().int().positive(),
    approvalOpened: z.boolean(),
  })
  .strict();
const PairingPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("approved"), sessionToken: z.string().min(32).max(128) }).strict(),
]);
const PairingActionSchema = z.object({ disconnected: z.literal(true) }).strict();
const PairingCancelSchema = z.object({ cancelled: z.literal(true) }).strict();
const ModelSchema = z
  .object({ slug: z.string().min(1).max(200), displayName: z.string().min(1).max(200) })
  .strict();
const ModelListSchema = z.object({ models: z.array(ModelSchema).max(100) }).passthrough();
const SmokeSchema = z
  .object({ success: z.literal(true), completed: z.literal(true), text: z.string().max(240) })
  .strict();
const DisconnectSchema = z
  .object({
    revocation: z.enum(["revoked", "revocation_failed", "not_available"]),
    registrationForgotten: z.boolean().optional(),
  })
  .passthrough();

export type CompanionStatus = z.infer<typeof StatusSchema>;
export type CompanionModel = z.infer<typeof ModelSchema>;
export type CompanionErrorCategory =
  | "pairing_busy"
  | "pairing_rate_limited"
  | "pairing_approval_unavailable"
  | "pairing_denied"
  | "pairing_expired"
  | "pairing_cancelled"
  | "pairing_replayed"
  | "system_browser_unavailable"
  | "browser_open_rate_limited"
  | "pairing_unavailable"
  | "pairing_failed"
  | "pairing_required"
  | "sign_in_already_pending"
  | "sign_in_timed_out"
  | "consent_denied"
  | "callback_invalid"
  | "client_id_mismatch"
  | "plan_use_scope_missing"
  | "plan_use_not_admitted"
  | "quota_or_rate_limit"
  | "session_expired"
  | "request_timed_out"
  | "request_cancelled"
  | "service_unavailable"
  | "connection_failed"
  | "model_not_verified_for_account"
  | "account_mismatch"
  | "public_client_unsupported"
  | "response_incomplete"
  | "response_too_large"
  | "request_rejected"
  | "registration_clear_failed"
  | "host_id_invalid"
  | "installation_store_invalid"
  | "unknown";

export class CompanionClientError extends Error {
  constructor(readonly category: CompanionErrorCategory) {
    super(category);
    this.name = "CompanionClientError";
  }
}

type Fetcher = typeof fetch;

export async function getCompanionHealth(fetcher: Fetcher = fetch): Promise<boolean> {
  const parsed = HealthSchema.safeParse(await request("/v1/health", undefined, undefined, fetcher));
  if (!parsed.success) throw new CompanionClientError("unknown");
  return true;
}

export async function requestLocalPairing(
  verifier: string,
  fetcher: Fetcher = fetch,
): Promise<{ attemptId: string; expiresInMs: number; approvalOpened: boolean }> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(verifier)) {
    throw new CompanionClientError("pairing_failed");
  }
  const body = await request("/v1/pairing/attempt", undefined, { verifier }, fetcher);
  const parsed = PairingAttemptSchema.safeParse(body);
  if (!parsed.success) throw new CompanionClientError("unknown");
  return parsed.data;
}

export async function pollLocalPairing(
  attemptId: string,
  verifier: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<{ status: "pending" } | { status: "approved"; sessionToken: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(attemptId) || !/^[A-Za-z0-9_-]{43}$/u.test(verifier)) {
    throw new CompanionClientError("pairing_failed");
  }
  const body = await request(
    "/v1/pairing/poll",
    undefined,
    { attemptId, verifier },
    fetcher,
    signal,
  );
  const parsed = PairingPollSchema.safeParse(body);
  if (!parsed.success) throw new CompanionClientError("unknown");
  return parsed.data;
}

export async function reopenLocalApproval(
  attemptId: string,
  verifier: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const body = await request("/v1/pairing/open", undefined, { attemptId, verifier }, fetcher);
  if (
    !z
      .object({ opened: z.literal(true) })
      .strict()
      .safeParse(body).success
  ) {
    throw new CompanionClientError("unknown");
  }
}

export async function cancelLocalPairing(
  attemptId: string,
  verifier: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const body = await request("/v1/pairing/cancel", undefined, { attemptId, verifier }, fetcher);
  if (!PairingCancelSchema.safeParse(body).success) throw new CompanionClientError("unknown");
}

export async function disconnectLocalSession(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const body = await request("/v1/pairing/disconnect", token, {}, fetcher);
  if (!PairingActionSchema.safeParse(body).success) throw new CompanionClientError("unknown");
}

export async function getCompanionStatus(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<CompanionStatus> {
  const body = await request("/v1/status", token, undefined, fetcher);
  const parsed = StatusSchema.safeParse(body);
  if (!parsed.success) throw new CompanionClientError("unknown");
  return parsed.data;
}

export async function startChatGPTSignIn(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<CompanionStatus> {
  const body = await request("/v1/auth/start", token, {}, fetcher);
  return parseStatus((body as { status?: unknown }).status);
}

export async function reopenChatGPTSignIn(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<CompanionStatus> {
  const body = await request("/v1/auth/open", token, {}, fetcher);
  return parseStatus((body as { status?: unknown }).status);
}

export async function discoverAuthorizedModels(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<CompanionModel[]> {
  const body = ModelListSchema.safeParse(await request("/v1/models", token, {}, fetcher));
  if (!body.success) throw new CompanionClientError("unknown");
  return body.data.models;
}

export async function runSmokeRequest(
  token: string,
  model: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const body = SmokeSchema.safeParse(await request("/v1/smoke", token, { model }, fetcher, signal));
  if (!body.success) throw new CompanionClientError("unknown");
  return body.data.text;
}

export async function disconnectChatGPT(token: string, fetcher: Fetcher = fetch): Promise<string> {
  const body = DisconnectSchema.safeParse(await request("/v1/disconnect", token, {}, fetcher));
  if (!body.success) throw new CompanionClientError("unknown");
  return body.data.revocation;
}

export async function switchChatGPTAccount(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const body = DisconnectSchema.safeParse(await request("/v1/account/switch", token, {}, fetcher));
  if (!body.success || body.data.registrationForgotten !== true) {
    throw new CompanionClientError("registration_clear_failed");
  }
  return body.data.revocation;
}

function parseStatus(value: unknown): CompanionStatus {
  const parsed = StatusSchema.safeParse(value);
  if (!parsed.success) throw new CompanionClientError("unknown");
  return parsed.data;
}

async function request(
  path: string,
  token: string | undefined,
  body: Record<string, unknown> | undefined,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${COMPANION_URL}${path}`, {
      method:
        body === undefined && (path === "/v1/status" || path === "/v1/health") ? "GET" : "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(signal ? { signal } : {}),
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    if (signal?.aborted) throw new CompanionClientError("request_cancelled");
    throw new CompanionClientError("connection_failed");
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new CompanionClientError("unknown");
  }
  if (!response.ok) {
    const category =
      typeof result === "object" &&
      result !== null &&
      typeof (result as { error?: unknown }).error === "string"
        ? mapError((result as { error: string }).error)
        : "unknown";
    throw new CompanionClientError(category);
  }
  return result;
}

function mapError(value: string): CompanionErrorCategory {
  const known: CompanionErrorCategory[] = [
    "pairing_busy",
    "pairing_rate_limited",
    "pairing_approval_unavailable",
    "pairing_denied",
    "pairing_expired",
    "pairing_cancelled",
    "pairing_replayed",
    "system_browser_unavailable",
    "browser_open_rate_limited",
    "pairing_unavailable",
    "pairing_failed",
    "pairing_required",
    "sign_in_already_pending",
    "sign_in_timed_out",
    "consent_denied",
    "callback_invalid",
    "client_id_mismatch",
    "plan_use_scope_missing",
    "plan_use_not_admitted",
    "quota_or_rate_limit",
    "session_expired",
    "request_timed_out",
    "request_cancelled",
    "service_unavailable",
    "connection_failed",
    "model_not_verified_for_account",
    "account_mismatch",
    "public_client_unsupported",
    "response_incomplete",
    "response_too_large",
    "request_rejected",
    "registration_clear_failed",
    "host_id_invalid",
    "installation_store_invalid",
  ];
  return known.includes(value as CompanionErrorCategory)
    ? (value as CompanionErrorCategory)
    : "unknown";
}
