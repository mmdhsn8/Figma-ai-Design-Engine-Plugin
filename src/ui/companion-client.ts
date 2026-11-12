import { ChatTurnTimingSchema } from "../shared/chat-tools";
import { z } from "zod";
import { COMPANION_BASE_URL } from "../companion/config";
import { MAX_SCREEN_BYTES } from "../shared/generation-limits";
import type { DesignGenerationRequest, GenerationRepairTarget } from "../shared/design-generation";
import type { DesignSection } from "../shared/design-generation";
import { MAX_SECTION_BYTES } from "../shared/generation-limits";
import {
  ChatFunctionCallValidationIssueSchema,
  ChatFunctionCallSchema,
  ChatInputItemSchema,
  type ChatLifecycleState,
  type ChatFunctionCall,
  type ChatFunctionCallValidationIssue,
  type ChatInputItem,
} from "../shared/chat-tools";

export const COMPANION_URL = COMPANION_BASE_URL;
const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 20_000;
const SMOKE_REQUEST_TIMEOUT_MS = 180_000;

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
    inferenceVerifiedModel: z.string().min(1).max(200).optional(),
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
  z
    .object({
      status: z.literal("approved"),
      sessionToken: z.string().min(32).max(128),
      restoreTicket: z.string().max(12_000).optional(),
      restoreAvailable: z.boolean(),
    })
    .strict(),
]);
const PairingRestoreSchema = z.object({ sessionToken: z.string().min(32).max(128) }).strict();
const PairingActionSchema = z.object({ disconnected: z.literal(true) }).strict();
const PairingCancelSchema = z.object({ cancelled: z.literal(true) }).strict();
const ModelSchema = z
  .object({ slug: z.string().min(1).max(200), displayName: z.string().min(1).max(200) })
  .strict();
const ModelListSchema = z
  .object({ models: z.array(ModelSchema).max(100), status: StatusSchema.optional() })
  .passthrough();
export const InferenceDiagnosticSchema = z
  .object({
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,100}$/u)
      .optional(),
    requestStartedAtMs: z.number().int().nonnegative().optional(),
    lastEventAtMs: z.number().int().nonnegative().optional(),
    requestPhase: z
      .enum(["upstream_headers", "upstream_stream", "companion_http", "companion_sse"])
      .optional(),
    terminationReason: z
      .enum([
        "upstream_inactivity",
        "upstream_header_timeout",
        "overall_deadline",
        "local_network_interruption",
        "upstream_transport_interruption",
        "user_cancelled",
        "http_failure",
        "stream_eof",
        "response_completed",
        "upstream_response_failed",
        "upstream_response_incomplete",
        "invalid_event",
        "transport_error",
      ])
      .optional(),
    timeoutSource: z
      .enum(["upstream_headers", "upstream_inactivity", "overall_deadline"])
      .optional(),
    model: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:/-]+$/u),
    stage: z.enum(["http", "stream"]),
    outcome: z.enum([
      "completed",
      "failed",
      "incomplete",
      "stream_ended_without_terminal",
      "timed_out",
      "cancelled",
      "invalid_event",
      "resource_exhausted",
      "transport_error",
      "http_error",
    ]),
    httpStatus: z.number().int().min(100).max(599).optional(),
    terminalEvent: z.literal("response.completed").optional(),
    lastEvent: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/u)
      .optional(),
    eventCount: z.number().int().nonnegative().optional(),
    responseBytes: z.number().int().nonnegative().optional(),
    generatedBytes: z.number().int().nonnegative().optional(),
    timeoutKind: z.enum(["headers", "idle", "overall"]).optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    headersMs: z.number().int().nonnegative().optional(),
    firstDeltaMs: z.number().int().nonnegative().optional(),
    idleMs: z.number().int().nonnegative().optional(),
    lastEventAgeMs: z.number().int().nonnegative().optional(),
    lastDeltaAgeMs: z.number().int().nonnegative().optional(),
    errorCode: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,100}$/u)
      .optional(),
    errorParam: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,100}$/u)
      .optional(),
    incompleteReason: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,100}$/u)
      .optional(),
    responseStatus: z
      .string()
      .regex(/^[A-Za-z0-9_.:/-]{1,200}$/u)
      .optional(),
    outputItemTypes: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/u))
      .max(20)
      .optional(),
    outputItemCount: z.number().int().nonnegative().optional(),
    functionCallCount: z.number().int().nonnegative().optional(),
    chatState: z
      .enum([
        "tool_calls",
        "text",
        "refusal",
        "empty",
        "incomplete",
        "failed",
        "invalid_tool_calls",
      ])
      .optional(),
  })
  .strict();
const SmokeSchema = z
  .object({
    success: z.literal(true),
    completed: z.literal(true),
    text: z.string().max(240),
    status: StatusSchema.optional(),
    diagnostic: InferenceDiagnosticSchema.optional(),
  })
  .strict();
const DisconnectSchema = z
  .object({
    revocation: z.enum(["revoked", "revocation_failed", "not_available"]),
    registrationForgotten: z.boolean().optional(),
  })
  .passthrough();

export type CompanionStatus = z.infer<typeof StatusSchema>;
export type CompanionModel = z.infer<typeof ModelSchema>;
export type InferenceDiagnostic = z.infer<typeof InferenceDiagnosticSchema>;
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
  | "account_not_eligible"
  | "unsupported_capability"
  | "route_not_supported"
  | "responses_transport_error"
  | "inference_not_verified"
  | "inference_busy"
  | "chat_request_invalid"
  | "generation_busy"
  | "generation_retry_limit"
  | "invalid_design_request"
  | "quota_or_rate_limit"
  | "session_expired"
  | "request_timed_out"
  | "request_cancelled"
  | "service_unavailable"
  | "connection_failed"
  | "model_not_verified_for_account"
  | "account_mismatch"
  | "account_not_eligible"
  | "unsupported_capability"
  | "route_not_supported"
  | "public_client_unsupported"
  | "response_incomplete"
  | "response_invalid"
  | "resource_exhausted"
  | "response_too_large"
  | "empty_response"
  | "request_rejected"
  | "registration_clear_failed"
  | "host_id_invalid"
  | "installation_store_invalid"
  | "secure_storage_unavailable"
  | "secure_storage_timeout"
  | "credential_store_corrupt"
  | "unknown";

export class CompanionClientError extends Error {
  constructor(
    readonly category: CompanionErrorCategory,
    readonly diagnostic?: InferenceDiagnostic,
    readonly validationIssues?: string[],
    readonly safeMessage?: string,
  ) {
    super(category);
    this.name = "CompanionClientError";
  }
}

export type AuthorizedChatTurn = (
  | { kind: "done"; text: string }
  | { kind: "tool_validation"; issues: ChatFunctionCallValidationIssue[] }
  | {
      kind: "tool_calls";
      calls: ChatFunctionCall[];
      functionCallItems: Extract<ChatInputItem, { type: "function_call" }>[];
      text: string;
    }) & { timing?: z.infer<typeof ChatTurnTimingSchema> };

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
): Promise<
  | { status: "pending" }
  | {
      status: "approved";
      sessionToken: string;
      restoreTicket?: string;
      restoreAvailable: boolean;
    }
> {
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

export async function restoreLocalSession(
  ticket: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!/^FADP1T:[A-Za-z0-9+/]+=*$/u.test(ticket) || ticket.length > 12_000) {
    throw new CompanionClientError("pairing_failed");
  }
  const parsed = PairingRestoreSchema.safeParse(
    await request("/v1/pairing/restore", undefined, { ticket }, fetcher),
  );
  if (!parsed.success) throw new CompanionClientError("unknown");
  return parsed.data.sessionToken;
}

export async function restoreLocalCompanionSession(
  ticket: string,
  fetcher: Fetcher = fetch,
): Promise<{ token: string; status: CompanionStatus }> {
  const token = await restoreLocalSession(ticket, fetcher);
  const status = await getCompanionStatus(token, fetcher);
  return { token, status };
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
  signal?: AbortSignal,
): Promise<CompanionModel[]> {
  return (await discoverAuthorizedModelCatalog(token, fetcher, signal)).models;
}

export async function discoverAuthorizedModelCatalog(
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<{ models: CompanionModel[]; status?: CompanionStatus }> {
  const body = ModelListSchema.safeParse(await request("/v1/models", token, {}, fetcher, signal));
  if (!body.success) throw new CompanionClientError("unknown");
  return {
    models: body.data.models,
    ...(body.data.status ? { status: body.data.status } : {}),
  };
}

export async function runSmokeRequest(
  token: string,
  model: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<{ text: string; status?: CompanionStatus; diagnostic?: InferenceDiagnostic }> {
  const body = SmokeSchema.safeParse(
    await request("/v1/smoke", token, { model }, fetcher, signal, SMOKE_REQUEST_TIMEOUT_MS),
  );
  if (!body.success) throw new CompanionClientError("unknown");
  return {
    text: body.data.text,
    ...(body.data.status ? { status: body.data.status } : {}),
    ...(body.data.diagnostic ? { diagnostic: body.data.diagnostic } : {}),
  };
}

export async function generateAuthorizedDesign(
  token: string,
  requestId: string,
  model: string,
  designRequest: DesignGenerationRequest,
  repairIssues: string[] = [],
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  screenIds?: string[],
  onIncompleteStreamRetry?: () => void,
  repairTargets?: GenerationRepairTarget[],
  onMetrics?: (metrics: Record<string, number>) => void,
  onLiveProgress?: (diagnostic: InferenceDiagnostic) => void,
  section?: Pick<DesignSection, "id" | "sequence">,
): Promise<string> {
  let retriedIncompleteStream = false;
  let polling = true;
  let pollBusy = false;
  const timer = onLiveProgress
    ? setInterval(() => {
        if (pollBusy) return;
        pollBusy = true;
        void fetchResponse(
          `/v1/progress?requestId=${encodeURIComponent(requestId)}`,
          token,
          undefined,
          fetcher,
          signal,
        )
          .then((response) => readLimitedJson(response, signal))
          .then((body) => {
            const parsed = InferenceDiagnosticSchema.safeParse(
              isRecord(body) ? body.progress : undefined,
            );
            if (polling && parsed.success) onLiveProgress(parsed.data);
          })
          .catch(() => undefined)
          .finally(() => {
            pollBusy = false;
          });
      }, 1000)
    : undefined;
  try {
    while (true) {
      if (signal?.aborted) throw new CompanionClientError("request_cancelled");
      try {
        const response = await fetchResponse(
          "/v1/design",
          token,
          {
            requestId,
            model,
            request: designRequest,
            ...(repairIssues.length ? { repairIssues } : {}),
            ...(screenIds ? { screenIds } : {}),
            ...(repairTargets?.length ? { repairTargets } : {}),
            ...(section ? { section } : {}),
          },
          fetcher,
          signal,
        );
        if (!response.ok) throwResponseError(await readLimitedJson(response, signal));
        const declaredBytes = Number(response.headers.get("x-fad-response-bytes"));
        if (declaredBytes > (section ? MAX_SECTION_BYTES : MAX_SCREEN_BYTES)) {
          await response.body?.cancel().catch(() => undefined);
          throw new CompanionClientError("response_too_large");
        }
        if (
          response.headers.get("x-fad-request-id") !== requestId ||
          response.headers.get("x-fad-model") !== model ||
          response.headers.get("x-fad-completed") !== "response.completed" ||
          !Number.isSafeInteger(declaredBytes) ||
          declaredBytes < 1 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new CompanionClientError("response_incomplete");
        }
        const text = await readGeneratedDesignText(response, declaredBytes, signal);
        const metrics: Record<string, number> = {};
        for (const [key, header] of Object.entries({
          headersMs: "x-fad-headers-ms",
          firstDeltaMs: "x-fad-first-delta-ms",
          upstreamMs: "x-fad-inference-ms",
          streamBytes: "x-fad-stream-bytes",
          generatedBytes: "x-fad-response-bytes",
        })) {
          const value = response.headers.get(header);
          if (value !== null && Number.isFinite(Number(value))) metrics[key] = Number(value);
        }
        if (metrics.upstreamMs && metrics.generatedBytes !== undefined)
          metrics.generatedBytesPerSecond = Math.round(
            (metrics.generatedBytes * 1000) / metrics.upstreamMs,
          );
        onMetrics?.(metrics);
        return text;
      } catch (error) {
        if (retriedIncompleteStream || signal?.aborted || !isRetryableStreamInterruption(error)) {
          throw error;
        }
        retriedIncompleteStream = true;
        onIncompleteStreamRetry?.();
        if (signal?.aborted) throw new CompanionClientError("request_cancelled");
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new CompanionClientError("request_cancelled"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, 250);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    }
  } finally {
    polling = false;
    if (timer) clearInterval(timer);
  }
}

export async function streamAuthorizedChat(
  token: string,
  requestId: string,
  model: string,
  input: ChatInputItem[],
  lifecycle: ChatLifecycleState,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  onDelta?: (delta: string) => void,
  onProgress?: (elapsedMs: number) => void,
): Promise<AuthorizedChatTurn> {
  const startedAt = performance.now();
  const requestStartedAtMs = Date.now();
  let response: Response;
  try {
    response = await fetchResponse(
      "/v1/chat",
      token,
      { requestId, model, input, lifecycle },
      fetcher,
      signal,
    );
  } catch (error) {
    if (error instanceof CompanionClientError && error.diagnostic) throw error;
    const cancelled =
      signal?.aborted ||
      (error instanceof CompanionClientError && error.category === "request_cancelled");
    throw new CompanionClientError(
      cancelled ? "request_cancelled" : "connection_failed",
      chatTransportDiagnostic(
        requestId,
        model,
        requestStartedAtMs,
        startedAt,
        "companion_http",
        cancelled ? "user_cancelled" : "local_network_interruption",
        cancelled ? "cancelled" : "transport_error",
      ),
    );
  }
  if (!response.ok) {
    const body = await readLimitedJson(response, signal);
    throwResponseError(body);
  }
  if (
    response.headers.get("x-fad-request-id") !== requestId ||
    response.headers.get("x-fad-model") !== model ||
    !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new CompanionClientError("response_incomplete");
  }
  return readAuthorizedChatStream(
    response,
    requestId,
    model,
    startedAt,
    requestStartedAtMs,
    signal,
    onDelta,
    onProgress,
  );
}

async function readAuthorizedChatStream(
  response: Response,
  requestId: string,
  model: string,
  startedAt: number,
  requestStartedAtMs: number,
  signal?: AbortSignal,
  onDelta?: (delta: string) => void,
  onProgress?: (elapsedMs: number) => void,
): Promise<AuthorizedChatTurn> {
  if (!response.body) throw new CompanionClientError("response_incomplete");
  const companionHeadersMs = Math.min(600_000, Math.round(performance.now() - startedAt));
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancelReader, { once: true });
  let buffer = "";
  let bytes = 0;
  const processFrame = (frame: string): AuthorizedChatTurn | undefined => {
    let eventName = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (field === "event") eventName = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n")) as unknown;
    } catch {
      throw new CompanionClientError("response_invalid");
    }
    if (!isRecord(payload) || payload.requestId !== requestId)
      throw new CompanionClientError("response_incomplete");
    if (eventName === "delta") {
      const parsed = z
        .object({ requestId: z.string(), delta: z.string().max(16_000) })
        .strict()
        .safeParse(payload);
      if (!parsed.success) throw new CompanionClientError("response_invalid");
      onDelta?.(parsed.data.delta);
      return undefined;
    }
    if (eventName === "progress") {
      const parsed = z
        .object({
          requestId: z.string(),
          elapsedMs: z.number().int().nonnegative(),
          eventCount: z.number().int().nonnegative(),
          requestPhase: z.enum(["upstream_headers", "upstream_stream"]).optional(),
          lastEvent: z
            .string()
            .regex(/^[A-Za-z0-9_.-]{1,100}$/u)
            .optional(),
          lastEventAtMs: z.number().int().nonnegative().optional(),
        })
        .strict()
        .safeParse(payload);
      if (!parsed.success) throw new CompanionClientError("response_invalid");
      onProgress?.(parsed.data.elapsedMs);
      return undefined;
    }
    if (eventName === "tool_validation") {
      const parsed = z
        .object({
          requestId: z.string(),
          issues: z.array(ChatFunctionCallValidationIssueSchema).min(1).max(8),
          timing: ChatTurnTimingSchema.optional(),
        })
        .strict()
        .safeParse(payload);
      if (!parsed.success) throw new CompanionClientError("response_invalid");
      return { kind: "tool_validation", issues: parsed.data.issues, ...(parsed.data.timing ? { timing: { ...parsed.data.timing, companionHeadersMs } } : {}) };
    }
    if (eventName === "tool_calls") {
      const parsed = z
        .object({
          requestId: z.string(),
          calls: z.array(ChatFunctionCallSchema).min(1).max(10),
          timing: ChatTurnTimingSchema.optional(),
          functionCallItems: z.array(ChatInputItemSchema).min(1).max(10),
          text: z
            .string()
            .max(256 * 1024)
            .optional(),
        })
        .strict()
        .safeParse(payload);
      if (
        !parsed.success ||
        parsed.data.functionCallItems.some(
          (item) => !("type" in item) || item.type !== "function_call",
        ) ||
        parsed.data.calls.length !== parsed.data.functionCallItems.length ||
        parsed.data.calls.some((call, index) => {
          const item = parsed.data.functionCallItems[index];
          return (
            !item ||
            !("type" in item) ||
            item.type !== "function_call" ||
            item.call_id !== call.callId ||
            item.name !== call.name ||
            item.arguments !== call.functionCall.arguments
          );
        })
      )
        throw new CompanionClientError("response_invalid");
      return {
        kind: "tool_calls",
        calls: parsed.data.calls,
        functionCallItems: parsed.data.functionCallItems as Extract<
          ChatInputItem,
          { type: "function_call" }
        >[],
        text: parsed.data.text ?? "",
        ...(parsed.data.timing ? { timing: { ...parsed.data.timing, companionHeadersMs } } : {}),
      };
    }
    if (eventName === "done") {
      const parsed = z
        .object({ requestId: z.string(), text: z.string().max(256 * 1024), timing: ChatTurnTimingSchema.optional() })
        .strict()
        .safeParse(payload);
      if (!parsed.success) throw new CompanionClientError("response_invalid");
      return { kind: "done", text: parsed.data.text, ...(parsed.data.timing ? { timing: { ...parsed.data.timing, companionHeadersMs } } : {}) };
    }
    if (eventName === "error") {
      const parsed = z
        .object({
          requestId: z.string(),
          error: z.string().max(100),
          message: z.string().max(300),
          diagnostic: InferenceDiagnosticSchema.optional(),
        })
        .strict()
        .safeParse(payload);
      if (!parsed.success) throw new CompanionClientError("response_invalid");
      if (parsed.data.diagnostic?.requestId && parsed.data.diagnostic.requestId !== requestId)
        throw new CompanionClientError("response_invalid");
      throw new CompanionClientError(
        mapError(parsed.data.error),
        parsed.data.diagnostic,
        undefined,
        parsed.data.message,
      );
    }
    throw new CompanionClientError("response_invalid");
  };
  try {
    while (true) {
      if (signal?.aborted)
        throw new CompanionClientError(
          "request_cancelled",
          chatTransportDiagnostic(
            requestId,
            model,
            requestStartedAtMs,
            startedAt,
            "companion_sse",
            "user_cancelled",
            "cancelled",
          ),
        );
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new CompanionClientError("response_too_large");
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const delimiter = /\r?\n\r?\n/u.exec(buffer);
        if (!delimiter || delimiter.index === undefined) break;
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        const terminal = processFrame(frame);
        if (terminal) return terminal;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const terminal = processFrame(buffer);
      if (terminal) return terminal;
    }
    if (signal?.aborted)
      throw new CompanionClientError(
        "request_cancelled",
        chatTransportDiagnostic(
          requestId,
          model,
          requestStartedAtMs,
          startedAt,
          "companion_sse",
          "user_cancelled",
          "cancelled",
        ),
      );
    throw new CompanionClientError(
      "response_incomplete",
      chatTransportDiagnostic(
        requestId,
        model,
        requestStartedAtMs,
        startedAt,
        "companion_sse",
        "stream_eof",
        "stream_ended_without_terminal",
      ),
    );
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CompanionClientError) throw error;
    const cancelled = signal?.aborted;
    throw new CompanionClientError(
      cancelled ? "request_cancelled" : "connection_failed",
      chatTransportDiagnostic(
        requestId,
        model,
        requestStartedAtMs,
        startedAt,
        "companion_sse",
        cancelled ? "user_cancelled" : "local_network_interruption",
        cancelled ? "cancelled" : "transport_error",
      ),
    );
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isRetryableStreamInterruption(error: unknown): error is CompanionClientError {
  if (!(error instanceof CompanionClientError) || error.diagnostic?.stage !== "stream")
    return false;
  return (
    (error.category === "response_incomplete" &&
      error.diagnostic.outcome === "stream_ended_without_terminal") ||
    (error.category === "request_timed_out" &&
      error.diagnostic.outcome === "timed_out" &&
      error.diagnostic.timeoutKind === "idle")
  );
}

function chatTransportDiagnostic(
  requestId: string,
  model: string,
  requestStartedAtMs: number,
  startedAt: number,
  requestPhase: "companion_http" | "companion_sse",
  terminationReason: "local_network_interruption" | "user_cancelled" | "stream_eof",
  outcome: "transport_error" | "cancelled" | "stream_ended_without_terminal",
): InferenceDiagnostic {
  return InferenceDiagnosticSchema.parse({
    model: /^[A-Za-z0-9._:/-]{1,200}$/u.test(model) ? model : "unavailable",
    requestId,
    requestStartedAtMs,
    requestPhase,
    terminationReason,
    stage: requestPhase === "companion_http" ? "http" : "stream",
    outcome,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });
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
  timeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (signal?.aborted) throw new CompanionClientError("request_cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  let result: unknown;
  try {
    response = await fetchResponse(path, token, body, fetcher, controller.signal);
    result = await readLimitedJson(response, controller.signal);
  } catch (error) {
    if (signal?.aborted) throw new CompanionClientError("request_cancelled");
    if (timedOut) throw new CompanionClientError("request_timed_out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
  if (!response.ok) throwResponseError(result);
  return result;
}

async function fetchResponse(
  path: string,
  token: string | undefined,
  body: Record<string, unknown> | undefined,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Response> {
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
  return response;
}

function throwResponseError(result: unknown): never {
  const error = isRecord(result) && typeof result.error === "string" ? result.error : "unknown";
  const safeMessage =
    isRecord(result) && typeof result.message === "string" && result.message.length <= 300
      ? result.message
      : undefined;
  const issues =
    isRecord(result) && result.issues !== undefined
      ? z.array(z.string().min(1).max(240)).max(8).safeParse(result.issues)
      : undefined;
  const diagnostic =
    isRecord(result) && result.diagnostic !== undefined
      ? InferenceDiagnosticSchema.safeParse(result.diagnostic)
      : undefined;
  throw new CompanionClientError(
    mapError(error),
    diagnostic?.success ? diagnostic.data : undefined,
    issues?.success ? issues.data : undefined,
    safeMessage,
  );
}

async function readGeneratedDesignText(
  response: Response,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) throw new CompanionClientError("response_incomplete");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let byteLength = 0;
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new CompanionClientError("request_cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > expectedBytes) throw new CompanionClientError("response_incomplete");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    if (signal?.aborted) throw new CompanionClientError("request_cancelled");
    if (byteLength !== expectedBytes) throw new CompanionClientError("response_incomplete");
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CompanionClientError) throw error;
    if (signal?.aborted) throw new CompanionClientError("request_cancelled");
    throw new CompanionClientError("response_incomplete");
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
    "account_not_eligible",
    "unsupported_capability",
    "route_not_supported",
    "responses_transport_error",
    "inference_not_verified",
    "inference_busy",
    "chat_request_invalid",
    "generation_busy",
    "generation_retry_limit",
    "invalid_design_request",
    "quota_or_rate_limit",
    "session_expired",
    "request_timed_out",
    "request_cancelled",
    "service_unavailable",
    "connection_failed",
    "model_not_verified_for_account",
    "account_mismatch",
    "account_not_eligible",
    "unsupported_capability",
    "route_not_supported",
    "public_client_unsupported",
    "response_incomplete",
    "response_invalid",
    "resource_exhausted",
    "response_too_large",
    "empty_response",
    "request_rejected",
    "registration_clear_failed",
    "host_id_invalid",
    "installation_store_invalid",
    "secure_storage_unavailable",
    "secure_storage_timeout",
    "credential_store_corrupt",
  ];
  return known.includes(value as CompanionErrorCategory)
    ? (value as CompanionErrorCategory)
    : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLimitedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const maximumBytes = 1_100_000;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new CompanionClientError("response_too_large");
  }
  if (!response.body) throw new CompanionClientError("unknown");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new CompanionClientError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof CompanionClientError) throw error;
    if (signal?.aborted) throw new CompanionClientError("request_cancelled");
    throw new CompanionClientError("unknown");
  } finally {
    reader.releaseLock();
  }
}
