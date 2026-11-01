import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
  COMPANION_BIND_ADDRESSES,
  COMPANION_CALLBACK_PATH,
  COMPANION_HOSTNAME,
  COMPANION_OAUTH_HOST,
  COMPANION_PORT,
  COMPANION_UI_ORIGIN,
} from "./config.js";
import type { InstallationStore } from "./installation-store.js";
import {
  assertTrustedHttpsUrl,
  createAuthorizationTransaction,
  createAuthorizationUrl,
  DYNAMIC_CLIENT_ENTRYPOINT,
  OIDC_DISCOVERY_URL,
  OIDC_ISSUER,
  parseGrantedScopes,
  PLAN_USE_SCOPE,
  RESPONSES_RESOURCE,
  safeStringEqual,
  validateAuthorizationCallback,
  validateIdToken,
  type AuthorizationTransaction,
  type OidcDiscovery,
} from "./oauth.js";

const MAX_BODY_BYTES = 16 * 1_024;
const MAX_APPROVAL_BODY_BYTES = 2 * 1_024;
const NETWORK_TIMEOUT_MS = 45_000;
const PAIRING_ATTEMPT_TTL_MS = 90_000;
const PAIRING_SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_PAIRING_ATTEMPTS_PER_MINUTE = 5;
const MAX_PAIRING_POLL_REQUESTS = 180;
const STATUS_TEXT: Record<string, string> = {
  signed_out: "Signed out",
  signing_in: "Signing in",
  signed_in_no_plan: "Signed in; plan use not authorized",
  scope_granted: "Plan-use scope granted · live test pending",
  ready: "Ready for AI",
  session_expired: "Session expired",
  blocked: "Blocked or unsupported",
};

export type AuthStatus = keyof typeof STATUS_TEXT;

export interface CompanionStatus {
  companion: "connected";
  auth: AuthStatus;
  authLabel: string;
  planUseAuthorized: boolean;
  modelCount: number;
  safeMessage?: string;
}

export interface CompanionServerOptions {
  port?: number;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  installationStore: InstallationStore;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface CompanionServerHandle {
  port: number;
  close(): Promise<void>;
}

interface LiveSession {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  subject: string;
  scopes: Set<string>;
  expiresAt: number;
  models: AccountModel[];
}

export interface AccountModel {
  slug: string;
  displayName: string;
}

interface PendingAuthorization {
  transaction: AuthorizationTransaction;
  discovery: OidcDiscovery;
  timer: ReturnType<typeof setNodeTimeout>;
  authorizationUrl: string;
  browserOpenAttempts: number;
}

interface PairingAttempt {
  id: string;
  verifierHash: string;
  csrfToken: string;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired" | "completed";
  expiresAt: number;
  pollCount: number;
  openCount: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export function createCompanionServer(options: CompanionServerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.requestTimeoutMs ?? NETWORK_TIMEOUT_MS;
  const port = options.port ?? COMPANION_PORT;
  const pairingAttempts = new Map<string, PairingAttempt>();
  const sessionTokenHashes = new Map<string, number>();
  const pairingStartTimes: number[] = [];
  let authStatus: AuthStatus = "signed_out";
  let safeMessage: string | undefined;
  let liveSession: LiveSession | undefined;
  let pendingAuthorization: PendingAuthorization | undefined;
  let servers: Server[] = [];
  let actualPort = port;

  const status = (): CompanionStatus => ({
    companion: "connected",
    auth: authStatus,
    authLabel: STATUS_TEXT[authStatus],
    planUseAuthorized: Boolean(liveSession?.scopes.has(PLAN_USE_SCOPE)),
    modelCount: liveSession?.models.length ?? 0,
    ...(safeMessage ? { safeMessage } : {}),
  });

  const apiBase = () => `http://${COMPANION_HOSTNAME}:${actualPort}`;
  const redirectUri = () =>
    `http://${COMPANION_OAUTH_HOST}:${actualPort}${COMPANION_CALLBACK_PATH}`;

  async function start(): Promise<CompanionServerHandle> {
    if (servers.length > 0) throw new Error("companion_already_started");
    const started: Server[] = [];
    try {
      for (const address of COMPANION_BIND_ADDRESSES) {
        const instance = createRouteServer();
        const isFirstListener = started.length === 0;
        await listenOnLoopback(instance, address, started.length === 0 ? port : actualPort);
        started.push(instance);
        const listeningAddress = instance.address();
        if (!listeningAddress || typeof listeningAddress === "string") {
          throw new Error("companion_bind_failed");
        }
        if (isFirstListener) actualPort = listeningAddress.port;
        else if (listeningAddress.port !== actualPort) throw new Error("companion_bind_failed");
      }
      servers = started;
    } catch (error) {
      await Promise.all(started.map(closeServer));
      throw error;
    }
    return {
      port: actualPort,
      close: async () => close(),
    };
  }

  async function close(): Promise<void> {
    clearPendingAuthorization();
    pairingAttempts.clear();
    sessionTokenHashes.clear();
    pairingStartTimes.length = 0;
    liveSession = undefined;
    authStatus = "signed_out";
    const running = servers;
    servers = [];
    await Promise.all(running.map(closeServer));
  }

  function createRouteServer(): Server {
    return createServer((request, response) => {
      void route(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: "connection_failed" });
        else response.destroy();
      });
    });
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", apiBase());
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      await handleCallback(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/local-approval/") && request.method === "GET") {
      await handleApprovalPage(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/local-approval/") && request.method === "POST") {
      await handleApprovalDecision(request, response, url);
      return;
    }

    if (request.headers.host !== `${COMPANION_HOSTNAME}:${actualPort}`) {
      sendJson(response, 400, { error: "invalid_host" });
      return;
    }
    if (request.method === "OPTIONS") {
      if (!setCorsHeaders(request, response)) {
        sendJson(response, 403, { error: "origin_denied" });
        return;
      }
      response.writeHead(204, { "Access-Control-Max-Age": "300" });
      response.end();
      return;
    }
    if (!setCorsHeaders(request, response)) {
      sendJson(response, 403, { error: "origin_denied" });
      return;
    }

    if (url.pathname === "/v1/health" && request.method === "GET") {
      sendJson(response, 200, { companion: "running" });
      return;
    }
    if (url.pathname === "/v1/pairing/attempt" && request.method === "POST") {
      await handlePairingAttempt(request, response);
      return;
    }
    if (url.pathname === "/v1/pairing/poll" && request.method === "POST") {
      await handlePairingPoll(request, response);
      return;
    }
    if (url.pathname === "/v1/pairing/open" && request.method === "POST") {
      await handlePairingOpen(request, response);
      return;
    }
    if (url.pathname === "/v1/pairing/cancel" && request.method === "POST") {
      await handlePairingCancel(request, response);
      return;
    }
    if (!authorized(request)) {
      sendJson(response, 401, { error: "pairing_required" });
      return;
    }
    if (url.pathname === "/v1/status" && request.method === "GET") {
      sendJson(response, 200, status());
      return;
    }
    if (url.pathname === "/v1/pairing/disconnect" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok || !hasExactKeys(body.value, [])) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      const header = request.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        sessionTokenHashes.delete(hashSecret(header.slice(7)));
      }
      sendJson(response, 200, { disconnected: true });
      return;
    }
    if (url.pathname === "/v1/auth/start" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      await handleAuthStart(response);
      return;
    }
    if (url.pathname === "/v1/auth/open" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok || !hasExactKeys(body.value, [])) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      await handleAuthBrowserOpen(response);
      return;
    }
    if (url.pathname === "/v1/models" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      await handleModels(response);
      return;
    }
    if (url.pathname === "/v1/smoke" && request.method === "POST") {
      await handleSmoke(request, response);
      return;
    }
    if (url.pathname === "/v1/disconnect" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      await handleDisconnect(response, false);
      return;
    }
    if (url.pathname === "/v1/account/switch" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      await handleDisconnect(response, true);
      return;
    }
    request.resume();
    sendJson(response, 404, { error: "not_found" });
  }

  async function handlePairingAttempt(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const verifier =
      body.ok && hasExactKeys(body.value, ["verifier"]) ? body.value.verifier : undefined;
    if (typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(verifier)) {
      sendJson(response, 400, { error: "pairing_failed" });
      return;
    }

    prunePairingState();
    if (
      [...pairingAttempts.values()].some(
        (attempt) => attempt.status === "pending" || attempt.status === "approved",
      )
    ) {
      sendJson(response, 409, { error: "pairing_busy" });
      return;
    }

    const currentTime = now();
    while (pairingStartTimes.length && currentTime - pairingStartTimes[0]! >= 60_000) {
      pairingStartTimes.shift();
    }
    if (pairingStartTimes.length >= MAX_PAIRING_ATTEMPTS_PER_MINUTE) {
      sendJson(response, 429, { error: "pairing_rate_limited" });
      return;
    }
    pairingStartTimes.push(currentTime);

    const attempt: PairingAttempt = {
      id: randomBytes(32).toString("base64url"),
      verifierHash: hashSecret(verifier),
      csrfToken: randomBytes(32).toString("base64url"),
      status: "pending",
      expiresAt: currentTime + PAIRING_ATTEMPT_TTL_MS,
      pollCount: 0,
      openCount: 0,
    };
    pairingAttempts.set(attempt.id, attempt);
    const opened = await openApprovalPage(attempt);
    sendJson(response, 200, {
      attemptId: attempt.id,
      expiresInMs: PAIRING_ATTEMPT_TTL_MS,
      approvalOpened: opened,
    });
  }

  async function openApprovalPage(attempt: PairingAttempt): Promise<boolean> {
    attempt.openCount += 1;
    if (!options.openBrowser) return false;
    const approvalUrl = `http://${COMPANION_HOSTNAME}:${actualPort}/local-approval/${attempt.id}`;
    try {
      await options.openBrowser(approvalUrl);
      return true;
    } catch {
      return false;
    }
  }

  async function handlePairingPoll(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const validBody = body.ok && hasExactKeys(body.value, ["attemptId", "verifier"]);
    const attempt = validBody ? getAttempt(body.value.attemptId) : undefined;
    const verifier = validBody ? body.value.verifier : undefined;
    if (
      !attempt ||
      typeof verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(verifier) ||
      !safeStringEqual(attempt.verifierHash, hashSecret(verifier))
    ) {
      sendJson(response, 403, { error: "pairing_failed" });
      return;
    }
    attempt.pollCount += 1;
    if (attempt.pollCount > MAX_PAIRING_POLL_REQUESTS) {
      attempt.status = "cancelled";
      sendJson(response, 429, { error: "pairing_rate_limited" });
      return;
    }
    if (attempt.status === "pending") {
      sendJson(response, 200, { status: "pending" });
      return;
    }
    if (attempt.status === "approved") {
      const sessionToken = randomBytes(32).toString("base64url");
      sessionTokenHashes.set(hashSecret(sessionToken), now() + PAIRING_SESSION_TTL_MS);
      attempt.status = "completed";
      attempt.csrfToken = "";
      sendJson(response, 200, { status: "approved", sessionToken });
      return;
    }
    if (attempt.status === "denied") {
      sendJson(response, 403, { error: "pairing_denied" });
      return;
    }
    if (attempt.status === "cancelled") {
      sendJson(response, 403, { error: "pairing_cancelled" });
      return;
    }
    if (attempt.status === "expired") {
      sendJson(response, 410, { error: "pairing_expired" });
      return;
    }
    sendJson(response, 409, { error: "pairing_replayed" });
  }

  async function handlePairingCancel(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const validBody = body.ok && hasExactKeys(body.value, ["attemptId", "verifier"]);
    const attempt = validBody ? getAttempt(body.value.attemptId) : undefined;
    const verifier = validBody ? body.value.verifier : undefined;
    if (
      !attempt ||
      typeof verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(verifier) ||
      !safeStringEqual(attempt.verifierHash, hashSecret(verifier)) ||
      attempt.status !== "pending"
    ) {
      sendJson(response, 403, { error: "pairing_failed" });
      return;
    }
    attempt.status = "cancelled";
    attempt.csrfToken = "";
    sendJson(response, 200, { cancelled: true });
  }

  async function handlePairingOpen(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const validBody = body.ok && hasExactKeys(body.value, ["attemptId", "verifier"]);
    const attempt = validBody ? getAttempt(body.value.attemptId) : undefined;
    const verifier = validBody ? body.value.verifier : undefined;
    if (
      !attempt ||
      attempt.status !== "pending" ||
      typeof verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(verifier) ||
      !safeStringEqual(attempt.verifierHash, hashSecret(verifier))
    ) {
      sendJson(response, 403, { error: "pairing_failed" });
      return;
    }
    if (attempt.openCount >= 3) {
      sendJson(response, 429, { error: "pairing_rate_limited" });
      return;
    }
    const opened = await openApprovalPage(attempt);
    if (!opened) {
      sendJson(response, 503, { error: "pairing_approval_unavailable" });
      return;
    }
    sendJson(response, 200, { opened: true });
  }

  async function handleApprovalPage(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.headers.host !== `${COMPANION_HOSTNAME}:${actualPort}`) {
      sendApprovalHtml(response, 400, approvalMessagePage("This local approval link is invalid."));
      return;
    }
    const attempt = getAttempt(url.pathname.slice("/local-approval/".length));
    if (!attempt || attempt.status !== "pending") {
      sendApprovalHtml(
        response,
        410,
        approvalMessagePage("This approval request expired or was already handled."),
      );
      return;
    }
    sendApprovalHtml(response, 200, approvalFormPage(attempt.id, attempt.csrfToken));
  }

  async function handleApprovalDecision(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (
      request.headers.host !== `${COMPANION_HOSTNAME}:${actualPort}` ||
      request.headers.origin !== `http://${COMPANION_HOSTNAME}:${actualPort}` ||
      request.headers["sec-fetch-site"] !== "same-origin" ||
      request.headers["sec-fetch-mode"] !== "navigate"
    ) {
      request.resume();
      sendApprovalHtml(
        response,
        403,
        approvalMessagePage("The local approval request was rejected."),
      );
      return;
    }
    const attempt = getAttempt(url.pathname.slice("/local-approval/".length));
    const form = await readFormBody(request, MAX_APPROVAL_BODY_BYTES);
    if (
      !attempt ||
      attempt.status !== "pending" ||
      !form ||
      typeof form.get("csrf") !== "string" ||
      !safeStringEqual(attempt.csrfToken, form.get("csrf") ?? "")
    ) {
      sendApprovalHtml(
        response,
        403,
        approvalMessagePage("The local approval request was invalid or expired."),
      );
      return;
    }
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "deny") {
      sendApprovalHtml(response, 400, approvalMessagePage("Choose approve or deny to continue."));
      return;
    }
    attempt.status = decision === "approve" ? "approved" : "denied";
    attempt.csrfToken = "";
    sendApprovalHtml(
      response,
      200,
      approvalMessagePage(
        decision === "approve"
          ? "Local companion access was approved. Return to Figma; this did not sign you in to ChatGPT."
          : "Local companion access was denied. Return to Figma to retry if you initiated this request.",
      ),
    );
  }

  function getAttempt(value: unknown): PairingAttempt | undefined {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
    const attempt = pairingAttempts.get(value);
    if (attempt && attempt.status === "pending" && now() >= attempt.expiresAt) {
      attempt.status = "expired";
      attempt.csrfToken = "";
    }
    return attempt;
  }

  function prunePairingState(): void {
    const currentTime = now();
    for (const [id, attempt] of pairingAttempts) {
      if (attempt.status === "pending" && currentTime >= attempt.expiresAt) {
        attempt.status = "expired";
        attempt.csrfToken = "";
      }
      if (currentTime >= attempt.expiresAt + PAIRING_ATTEMPT_TTL_MS) pairingAttempts.delete(id);
    }
    for (const [tokenHash, expiresAt] of sessionTokenHashes) {
      if (currentTime >= expiresAt) sessionTokenHashes.delete(tokenHash);
    }
  }

  function authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    prunePairingState();
    const tokenHash = hashSecret(token);
    if (!sessionTokenHashes.has(tokenHash)) return false;
    sessionTokenHashes.set(tokenHash, now() + PAIRING_SESSION_TTL_MS);
    return true;
  }

  async function handleAuthStart(response: ServerResponse): Promise<void> {
    if (pendingAuthorization) {
      sendJson(response, 409, { error: "sign_in_already_pending" });
      return;
    }
    try {
      const metadata = await options.installationStore.load();
      const discovery = await loadDiscovery();
      validateDiscovery(discovery);
      const transaction = createAuthorizationTransaction(
        metadata.clientId ?? DYNAMIC_CLIENT_ENTRYPOINT,
        redirectUri(),
        now(),
      );
      const url = createAuthorizationUrl(discovery, transaction, metadata.extAgentHostId);
      const timer = setNodeTimeout(
        () => {
          clearPendingAuthorization();
          authStatus = "blocked";
          safeMessage = "sign_in_timed_out";
        },
        Math.max(0, transaction.expiresAt - now()),
      );
      pendingAuthorization = {
        transaction,
        discovery,
        timer,
        authorizationUrl: url.toString(),
        browserOpenAttempts: 0,
      };
      liveSession = undefined;
      authStatus = "signing_in";
      safeMessage = undefined;
      try {
        if (!options.openBrowser) throw new Error("system_browser_unavailable");
        pendingAuthorization.browserOpenAttempts += 1;
        await options.openBrowser(pendingAuthorization.authorizationUrl);
      } catch {
        safeMessage = "system_browser_unavailable";
      }
      sendJson(response, 200, { status: status() });
    } catch (error) {
      clearPendingAuthorization();
      authStatus = "blocked";
      safeMessage = classifyError(error);
      sendJson(response, 503, { error: safeMessage, status: status() });
    }
  }

  async function handleAuthBrowserOpen(response: ServerResponse): Promise<void> {
    const pending = pendingAuthorization;
    if (!pending || now() >= pending.transaction.expiresAt) {
      clearPendingAuthorization();
      authStatus = "blocked";
      safeMessage = "sign_in_timed_out";
      sendJson(response, 410, { error: "sign_in_timed_out", status: status() });
      return;
    }
    if (pending.browserOpenAttempts >= 3) {
      sendJson(response, 429, { error: "browser_open_rate_limited", status: status() });
      return;
    }
    pending.browserOpenAttempts += 1;
    try {
      if (!options.openBrowser) throw new Error("system_browser_unavailable");
      await options.openBrowser(pending.authorizationUrl);
      safeMessage = undefined;
      sendJson(response, 200, { status: status() });
    } catch {
      safeMessage = "system_browser_unavailable";
      sendJson(response, 503, { error: safeMessage, status: status() });
    }
  }

  async function handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.headers.host !== `${COMPANION_OAUTH_HOST}:${actualPort}`) {
      sendCallbackPage(response, "blocked");
      return;
    }
    const pending = pendingAuthorization;
    if (!pending) {
      sendCallbackPage(response, "expired");
      return;
    }
    clearPendingAuthorization();
    const metadata = await options.installationStore.load().catch(() => undefined);
    const result = validateAuthorizationCallback(
      url.searchParams,
      pending.transaction,
      metadata?.clientId,
      now(),
    );
    if (!result.ok) {
      authStatus = result.category === "consent_denied" ? "signed_out" : "blocked";
      safeMessage = result.category;
      sendCallbackPage(response, result.category === "consent_denied" ? "cancelled" : "blocked");
      return;
    }

    let receivedRefreshToken: string | undefined;
    try {
      const token = await exchangeCode(pending, result.code, result.clientId);
      if (typeof token.refresh_token === "string" && token.refresh_token.length <= 16_384) {
        receivedRefreshToken = token.refresh_token;
      }
      const discovery = pending.discovery;
      const jwksResponse = await fetchWithTimeout(discovery.jwks_uri);
      if (!jwksResponse.ok) throw new Error("jwks_unavailable");
      const jwks = await readJsonResponse(jwksResponse, 256 * 1_024, timeoutMs);
      if (typeof token.id_token !== "string") throw new Error("id_token_invalid");
      const identity = validateIdToken(
        token.id_token,
        jwks,
        result.clientId,
        pending.transaction.nonce,
        Math.floor(now() / 1_000),
      );
      if (!identity.ok) throw new Error(identity.category);
      if (!isAccessTokenResponse(token)) throw new Error("token_response_invalid");

      const scopes = parseGrantedScopes(token.scope);
      const subjectHash = createHash("sha256").update(identity.subject).digest("hex");
      if (metadata?.subjectHash && !safeDigestEqual(metadata.subjectHash, subjectHash)) {
        throw new Error("account_mismatch");
      }
      await options.installationStore.saveClientId(result.clientId, subjectHash);
      liveSession = {
        accessToken: token.access_token,
        ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
        clientId: result.clientId,
        subject: identity.subject,
        scopes,
        expiresAt: now() + token.expires_in * 1_000,
        models: [],
      };
      authStatus = scopes.has(PLAN_USE_SCOPE) ? "scope_granted" : "signed_in_no_plan";
      safeMessage = scopes.has(PLAN_USE_SCOPE) ? undefined : "plan_use_scope_missing";
      sendCallbackPage(response, "complete");
    } catch (error) {
      if (receivedRefreshToken) {
        await revokeRefreshToken(pending.discovery, result.clientId, receivedRefreshToken).catch(
          () => false,
        );
      }
      liveSession = undefined;
      const category = classifyError(error);
      authStatus = "blocked";
      safeMessage = category;
      sendCallbackPage(response, "blocked");
    }
  }

  async function handleModels(response: ServerResponse): Promise<void> {
    const session = await getAuthorizedSession();
    if (!session.ok) {
      sendJson(response, session.statusCode, { error: session.error, status: status() });
      return;
    }
    try {
      const result = await fetchWithTimeout(`${RESPONSES_RESOURCE}/models`, {
        headers: { Authorization: `Bearer ${session.value.accessToken}` },
      });
      if (!result.ok) {
        const category = classifyHttpStatus(result.status);
        applySessionHttpFailure(category);
        sendJson(response, result.status, { error: category, status: status() });
        return;
      }
      const body = (await readJsonResponse(result, 1_024 * 1_024, timeoutMs)) as {
        models?: unknown;
      };
      const models: AccountModel[] = Array.isArray(body.models)
        ? body.models
            .filter(
              (entry): entry is { slug: string; display_name: string; visibility: string } =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { slug?: unknown }).slug === "string" &&
                typeof (entry as { display_name?: unknown }).display_name === "string" &&
                (entry as { visibility?: unknown }).visibility === "list",
            )
            .map(({ slug, display_name }) => ({ slug, displayName: display_name }))
            .filter(({ slug, displayName }) => slug.length <= 200 && displayName.length <= 200)
            .slice(0, 100)
        : [];
      session.value.models = models;
      sendJson(response, 200, { models, status: status() });
    } catch (error) {
      const category = classifyError(error);
      if (category === "quota_or_rate_limit" || category === "plan_use_not_admitted") {
        authStatus = "scope_granted";
      }
      safeMessage = category;
      sendJson(response, 502, { error: category, status: status() });
    }
  }

  async function handleSmoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok || typeof body.value.model !== "string" || body.value.model.length > 200) {
      sendJson(response, 400, { error: "invalid_model" });
      return;
    }
    const session = await getAuthorizedSession();
    if (!session.ok) {
      sendJson(response, session.statusCode, { error: session.error, status: status() });
      return;
    }
    if (!session.value.models.some(({ slug }) => slug === body.value.model)) {
      sendJson(response, 400, { error: "model_not_verified_for_account" });
      return;
    }
    const clientAbort = new AbortController();
    const abortForClient = () => clientAbort.abort();
    const abortForClosedResponse = () => {
      if (!response.writableEnded) clientAbort.abort();
    };
    request.once("aborted", abortForClient);
    response.once("close", abortForClosedResponse);
    try {
      const result = await fetchWithTimeout(
        `${RESPONSES_RESOURCE}/responses`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.value.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: body.value.model,
            input: [{ role: "user", content: "Reply with exactly OK." }],
            store: false,
            stream: true,
          }),
        },
        clientAbort.signal,
      );
      if (!result.ok) {
        const category = classifyHttpStatus(result.status);
        applySessionHttpFailure(category);
        sendJson(response, result.status, { error: category, status: status() });
        return;
      }
      const completed = await readCompletedResponse(result, timeoutMs, clientAbort.signal);
      if (!completed) throw new Error("response_incomplete");
      authStatus = "ready";
      safeMessage = undefined;
      sendJson(response, 200, { success: true, completed: true, text: completed.slice(0, 240) });
    } catch (error) {
      if (request.aborted || response.destroyed) return;
      const category = classifyError(error);
      if (category === "quota_or_rate_limit" || category === "plan_use_not_admitted") {
        authStatus = "scope_granted";
      }
      safeMessage = category;
      sendJson(response, 502, { error: category, status: status() });
    } finally {
      request.off("aborted", abortForClient);
      response.off("close", abortForClosedResponse);
    }
  }

  async function handleDisconnect(
    response: ServerResponse,
    forgetRegistration: boolean,
  ): Promise<void> {
    clearPendingAuthorization();
    const session = liveSession;
    liveSession = undefined;
    authStatus = "signed_out";
    safeMessage = undefined;
    let revocation = "not_available";
    if (session?.refreshToken) {
      try {
        const discovery = await loadDiscovery();
        if (discovery.revocation_endpoint) {
          revocation = (await revokeRefreshToken(discovery, session.clientId, session.refreshToken))
            ? "revoked"
            : "revocation_failed";
        }
      } catch {
        revocation = "revocation_failed";
      }
    }
    if (forgetRegistration) {
      try {
        await options.installationStore.clearRegistration();
      } catch {
        sendJson(response, 500, {
          error: "registration_clear_failed",
          status: status(),
          revocation,
        });
        return;
      }
    }
    sendJson(response, 200, {
      status: status(),
      revocation,
      registrationForgotten: forgetRegistration,
    });
  }

  async function getAuthorizedSession(): Promise<
    { ok: true; value: LiveSession } | { ok: false; statusCode: number; error: string }
  > {
    if (!liveSession) return { ok: false, statusCode: 401, error: "signed_out" };
    if (!liveSession.scopes.has(PLAN_USE_SCOPE)) {
      return { ok: false, statusCode: 403, error: "plan_use_scope_missing" };
    }
    if (liveSession.expiresAt > now() + 60_000) return { ok: true, value: liveSession };
    if (!liveSession.refreshToken) {
      authStatus = "session_expired";
      safeMessage = "refresh_unavailable";
      return { ok: false, statusCode: 401, error: "session_expired" };
    }
    try {
      const metadata = await options.installationStore.load();
      const discovery = await loadDiscovery();
      validateDiscovery(discovery);
      const result = await fetchWithTimeout(discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: liveSession.refreshToken,
          client_id: metadata.clientId ?? liveSession.clientId,
          resource: RESPONSES_RESOURCE,
        }),
      });
      if (!result.ok) throw new Error(await classifyOAuthResponse(result));
      const token = (await readJsonResponse(result, 64 * 1_024, timeoutMs)) as TokenResponse;
      if (!isAccessTokenResponse(token)) throw new Error("token_response_invalid");
      const scopes =
        typeof token.scope === "string" ? parseGrantedScopes(token.scope) : liveSession.scopes;
      if (!scopes.has(PLAN_USE_SCOPE)) throw new Error("plan_use_scope_missing");
      liveSession = {
        ...liveSession,
        accessToken: token.access_token,
        ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
        scopes,
        expiresAt: now() + token.expires_in * 1_000,
      };
      authStatus = authStatus === "ready" ? "ready" : "scope_granted";
      safeMessage = undefined;
      return { ok: true, value: liveSession };
    } catch (error) {
      const category = classifyError(error);
      authStatus = category === "plan_use_scope_missing" ? "signed_in_no_plan" : "session_expired";
      safeMessage = category;
      liveSession = undefined;
      return { ok: false, statusCode: 401, error: category };
    }
  }

  async function exchangeCode(
    pending: PendingAuthorization,
    code: string,
    clientId: string,
  ): Promise<TokenResponse> {
    const endpoint = assertTrustedHttpsUrl(pending.discovery.token_endpoint);
    const result = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.transaction.redirectUri,
        client_id: clientId,
        code_verifier: pending.transaction.codeVerifier,
        resource: RESPONSES_RESOURCE,
      }),
    });
    if (!result.ok) throw new Error(await classifyOAuthResponse(result));
    return (await readJsonResponse(result, 64 * 1_024, timeoutMs)) as TokenResponse;
  }

  async function revokeRefreshToken(
    discovery: OidcDiscovery,
    clientId: string,
    refreshToken: string,
  ): Promise<boolean> {
    if (!discovery.revocation_endpoint) return false;
    const endpoint = assertTrustedHttpsUrl(discovery.revocation_endpoint);
    const result = await fetchWithTimeout(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    });
    return result.ok;
  }

  async function loadDiscovery(): Promise<OidcDiscovery> {
    const result = await fetchWithTimeout(OIDC_DISCOVERY_URL);
    if (!result.ok) throw new Error("discovery_unavailable");
    const discovery = (await readJsonResponse(result, 64 * 1_024, timeoutMs)) as OidcDiscovery;
    validateDiscovery(discovery);
    return discovery;
  }

  async function fetchWithTimeout(
    input: string | URL,
    init: RequestInit = {},
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setNodeTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      return await fetchImpl(input, { ...init, redirect: "error", signal: controller.signal });
    } finally {
      clearNodeTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  function applySessionHttpFailure(category: string): void {
    if (category === "session_expired" || category === "plan_use_scope_missing") {
      authStatus = category === "session_expired" ? "session_expired" : "signed_in_no_plan";
      safeMessage = category;
    }
  }

  function clearPendingAuthorization(): void {
    if (!pendingAuthorization) return;
    clearNodeTimeout(pendingAuthorization.timer);
    pendingAuthorization = undefined;
  }

  function setCorsHeaders(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers.origin !== COMPANION_UI_ORIGIN) return false;
    // Figma plugin UI iframes have an opaque "null" origin. Figma's docs require
    // an API reachable from the plugin iframe to permit wildcard ACAO. Cookies
    // are disabled; explicit local approval and per-session bearers authorize
    // privileged requests. Origin:null is not an identity assertion.
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.setHeader("Cache-Control", "no-store");
    return true;
  }

  return { start, close, getStatus: status };
}

function listenOnLoopback(server: Server, address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, address);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function validateDiscovery(discovery: OidcDiscovery): void {
  if (!discovery || discovery.issuer !== OIDC_ISSUER) throw new Error("discovery_invalid");
  assertTrustedHttpsUrl(discovery.authorization_endpoint);
  assertTrustedHttpsUrl(discovery.token_endpoint);
  assertTrustedHttpsUrl(discovery.jwks_uri);
  if (discovery.revocation_endpoint) assertTrustedHttpsUrl(discovery.revocation_endpoint);
  if (!discovery.response_types_supported?.includes("code")) {
    throw new Error("authorization_code_unsupported");
  }
  if (!discovery.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("pkce_s256_unsupported");
  }
  if (!discovery.grant_types_supported?.includes("authorization_code")) {
    throw new Error("authorization_code_unsupported");
  }
  if (!discovery.grant_types_supported.includes("refresh_token")) {
    throw new Error("refresh_unavailable");
  }
  if (!discovery.token_endpoint_auth_methods_supported?.includes("none")) {
    throw new Error("public_client_unsupported");
  }
  if (!discovery.id_token_signing_alg_values_supported?.includes("RS256")) {
    throw new Error("id_token_invalid");
  }
}

function isAccessTokenResponse(value: TokenResponse): value is TokenResponse & {
  access_token: string;
  expires_in: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.token_type === "string" &&
    value.token_type.toLowerCase() === "bearer" &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0 &&
    value.access_token.length <= 16_384 &&
    typeof value.expires_in === "number" &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0 &&
    value.expires_in <= 31 * 24 * 60 * 60
  );
}

function classifyHttpStatus(statusCode: number): string {
  if (statusCode === 401) return "session_expired";
  if (statusCode === 403) return "plan_use_not_admitted";
  if (statusCode === 429) return "quota_or_rate_limit";
  return statusCode >= 500 ? "service_unavailable" : "request_rejected";
}

async function classifyOAuthResponse(response: Response): Promise<string> {
  try {
    const body = await readJsonResponse(response, 16 * 1_024, NETWORK_TIMEOUT_MS);
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      const code = (body as { error: string }).error;
      if (code === "invalid_grant") return "session_expired";
      if (code === "invalid_client" || code === "unauthorized_client") return "client_id_mismatch";
      if (code === "access_denied") return "consent_denied";
    }
  } catch {
    // Use only the HTTP category when the remote error body is absent or invalid.
  }
  return classifyHttpStatus(response.status);
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(left)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const allowed = new Set([
    "discovery_unavailable",
    "discovery_invalid",
    "jwks_unavailable",
    "id_token_invalid",
    "id_token_expired",
    "nonce_mismatch",
    "token_response_invalid",
    "session_expired",
    "plan_use_scope_missing",
    "plan_use_not_admitted",
    "quota_or_rate_limit",
    "service_unavailable",
    "request_rejected",
    "response_incomplete",
    "refresh_unavailable",
    "authorization_code_unsupported",
    "pkce_s256_unsupported",
    "untrusted_endpoint",
    "request_timed_out",
    "response_too_large",
    "response_invalid",
    "system_browser_unavailable",
    "sign_in_timed_out",
    "account_mismatch",
    "request_cancelled",
    "public_client_unsupported",
    "host_id_invalid",
    "installation_store_invalid",
  ]);
  if (allowed.has(message)) return message;
  if (error instanceof Error && error.name === "AbortError") return "request_timed_out";
  return "connection_failed";
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    request.resume();
    return { ok: false };
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    return { ok: false };
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_BODY_BYTES) {
        request.resume();
        return { ok: false };
      }
      chunks.push(buffer);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readFormBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<URLSearchParams | undefined> {
  if (
    !request.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    request.resume();
    return undefined;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > maxBytes) {
        request.resume();
        return undefined;
      }
      chunks.push(buffer);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    return Array.from(form.keys()).length <= 2 ? form : undefined;
  } catch {
    return undefined;
  }
}

function approvalFormPage(attemptId: string, csrfToken: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Local companion approval</title>
    <style>
      body{font:16px system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#172033}
      h1{font-size:1.5rem}
      p{line-height:1.55}
      .notice{padding:1rem;background:#eff6ff;border-radius:.75rem}
      form{display:flex;gap:.75rem;margin-top:1.5rem}
      button{font:inherit;padding:.75rem 1rem;border:0;border-radius:.5rem;cursor:pointer}
      button[name=decision][value=approve]{background:#2563eb;color:white}
      button[name=decision][value=deny]{background:#e2e8f0;color:#172033}
    </style>
  </head>
  <body>
    <h1>Approve local companion access?</h1>
    <p class="notice">A local client is waiting to connect to this companion. This page cannot verify whether the request came from Figma AI Design Engine, another plugin, or another local program. Approve only if you just clicked <strong>Continue with ChatGPT</strong> in the Figma AI Design Engine plugin.</p>
    <p>This approval connects the plugin UI to the local companion only. It does not sign you in to ChatGPT or grant plan-use permission.</p>
    <form method="post" action="/local-approval/${attemptId}">
      <input type="hidden" name="csrf" value="${csrfToken}">
      <button type="submit" name="decision" value="approve">Approve local connection</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </body>
</html>`;
}

function approvalMessagePage(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Local companion</title>
    <style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#172033}p{line-height:1.55}</style>
  </head>
  <body>
    <h1>Figma AI Design Engine local companion</h1>
    <p>${message}</p>
    <p>You may close this tab and return to Figma.</p>
  </body>
</html>`;
}

function sendApprovalHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(html);
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sendCallbackPage(response: ServerResponse, result: string): void {
  const messages: Record<string, string> = {
    complete: "Sign-in response received. Return to the Figma plugin to check status.",
    cancelled: "Sign-in was cancelled. You may close this tab.",
    expired: "This sign-in attempt expired. Return to the local plugin and try again.",
    blocked: "Sign-in could not be verified. Return to the local plugin for a safe status.",
  };
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Figma AI Design Engine</title><p>${messages[result] ?? messages.blocked}</p>`,
  );
}

async function readCompletedResponse(
  response: Response,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const cancelReader = () => void reader.cancel();
  signal?.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let output = "";
  const deadline = Date.now() + timeoutMs;
  try {
    if (signal?.aborted) {
      await reader.cancel();
      throw new Error("request_cancelled");
    }
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel();
        throw new Error("request_timed_out");
      }
      const { value, done } = await readChunkWithTimeout(reader, remaining);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1_024) {
        await reader.cancel();
        throw new Error("response_incomplete");
      }
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split(/\r?\n\r?\n/u);
      buffer = records.pop() ?? "";
      for (const record of records) {
        const data = record
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: { type?: unknown; delta?: unknown; response?: unknown };
        try {
          event = JSON.parse(data) as typeof event;
        } catch {
          continue;
        }
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          output += event.delta;
        }
        if (event.type === "response.failed" || event.type === "error") {
          throw new Error(responseFailureCategory(event.response) ?? "response_incomplete");
        }
        if (event.type === "response.incomplete") throw new Error("response_incomplete");
        if (event.type === "response.completed") return output;
      }
    }
    return undefined;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
}

function responseFailureCategory(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const error = (response as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (code === "subscription_sharing_usage_limit_exceeded") return "quota_or_rate_limit";
  if (code === "subscription_sharing_usage_unavailable") return "plan_use_not_admitted";
  return undefined;
}

async function readJsonResponse(
  response: Response,
  maximumBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  const body = await readResponseText(response, maximumBytes, timeoutMs);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("response_invalid");
  }
}

async function readResponseText(
  response: Response,
  maximumBytes: number,
  timeoutMs: number,
): Promise<string> {
  if (!response.body) throw new Error("response_invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await reader.cancel();
      throw new Error("request_timed_out");
    }
    const { value, done } = await readChunkWithTimeout(reader, remaining);
    if (done) return output + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
}

async function readChunkWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number,
): Promise<StreamReadResult<T>> {
  let timer: ReturnType<typeof setNodeTimeout> | undefined;
  try {
    return (await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setNodeTimeout(() => reject(new Error("request_timed_out")), timeoutMs);
      }),
    ])) as StreamReadResult<T>;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearNodeTimeout(timer);
  }
}

type StreamReadResult<T> = { done: true; value?: undefined } | { done: false; value: T };
