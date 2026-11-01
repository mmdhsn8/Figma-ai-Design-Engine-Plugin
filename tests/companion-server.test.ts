import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OIDC_ISSUER,
  PLAN_USE_SCOPE,
  createCodeChallenge,
  type OidcDiscovery,
} from "../src/companion/oauth.js";
import { createCompanionServer, type CompanionServerHandle } from "../src/companion/server.js";

const discovery: OidcDiscovery = {
  issuer: OIDC_ISSUER,
  authorization_endpoint: `${OIDC_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${OIDC_ISSUER}/api/accounts/oauth/token`,
  revocation_endpoint: `${OIDC_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${OIDC_ISSUER}/.well-known/jwks.json`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
  id_token_signing_alg_values_supported: ["RS256"],
};

const openHandles: CompanionServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((handle) => handle.close()));
});

describe("loopback companion", () => {
  it("binds only to loopback and requires null-origin pairing with a one-time code", async () => {
    const harness = await createHarness();
    const preflight = await fetch(`http://127.0.0.1:${harness.handle.port}/v1/pair`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");

    const originDenied = await request(harness.handle, "/v1/pair", {
      body: { code: harness.handle.pairingCode },
      origin: "https://untrusted.example",
    });
    expect(originDenied.status).toBe(403);

    const unauthenticated = await request(harness.handle, "/v1/status", {});
    expect(unauthenticated.status).toBe(401);
    const failedPair = await request(harness.handle, "/v1/pair", { body: { code: "wrong" } });
    expect(failedPair.status).toBe(403);
    const paired = await request(harness.handle, "/v1/pair", {
      body: { code: harness.handle.pairingCode },
    });
    expect(paired.status).toBe(200);
    const pairing = (await paired.json()) as { sessionToken: string };
    expect(pairing.sessionToken).toHaveLength(43);

    const reusedPair = await request(harness.handle, "/v1/pair", {
      body: { code: harness.handle.pairingCode },
    });
    expect(reusedPair.status).toBe(403);
    const connected = await request(harness.handle, "/v1/status", { token: pairing.sessionToken });
    expect(connected.status).toBe(200);
    const body = (await connected.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ companion: "connected", auth: "signed_out" });
    expect(JSON.stringify(body)).not.toContain(pairing.sessionToken);
  });

  it("runs mocked PKCE authorization, checks granted plan scope, discovers models and streams a smoke response", async () => {
    const harness = await createHarness({
      scope: `openid profile email offline_access resource.invoke ${PLAN_USE_SCOPE}`,
    });
    const token = await harness.pair();
    const start = await request(harness.handle, "/v1/auth/start", { token, body: {} });
    expect(start.status).toBe(200);
    expect(harness.openedUrl).toBeDefined();
    const authorization = new URL(harness.openedUrl as string);
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("ext_agent_host_id")).toBe("host-12345678");
    const callback = new URL(`http://127.0.0.1:${harness.handle.port}/auth/callback`);
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("client_id", "issued-public-client");
    const callbackResponse = await fetch(callback);
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("Sign-in response received");
    const exchange = new URLSearchParams(harness.codeExchange as string);
    expect(exchange.get("client_id")).toBe("issued-public-client");
    expect(exchange.get("client_id")).not.toBe("dynamic_agent_client");
    expect(exchange.get("redirect_uri")).toBe(
      `http://127.0.0.1:${harness.handle.port}/auth/callback`,
    );
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorization.searchParams.get("code_challenge")).toBe(
      createCodeChallenge(exchange.get("code_verifier") ?? ""),
    );

    const statusResponse = await request(harness.handle, "/v1/status", { token });
    const status = (await statusResponse.json()) as Record<string, unknown>;
    expect(status).toMatchObject({ auth: "scope_granted", planUseAuthorized: true });
    expect(JSON.stringify(status)).not.toContain("access-secret");
    expect(JSON.stringify(status)).not.toContain("opaque-subject");

    const modelResponse = await request(harness.handle, "/v1/models", { token, body: {} });
    expect(modelResponse.status).toBe(200);
    const models = (await modelResponse.json()) as {
      models: Array<{ slug: string; displayName: string }>;
    };
    expect(models.models).toEqual([{ slug: "account-model", displayName: "Account Model" }]);
    expect(models.models.some((model) => model.slug === "hidden-model")).toBe(false);

    const smokeResponse = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(smokeResponse.status).toBe(200);
    expect(await smokeResponse.json()).toMatchObject({
      success: true,
      completed: true,
      text: "OK",
    });
    const liveStatus = await request(harness.handle, "/v1/status", { token });
    expect(await liveStatus.json()).toMatchObject({ auth: "ready", planUseAuthorized: true });
    const sent = harness.responsesRequest as { body: string; headers: HeadersInit };
    const payload = JSON.parse(sent.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      input: [{ role: "user", content: "Reply with exactly OK." }],
      store: false,
      stream: true,
    });
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload.model).toBe("account-model");
    expect(new Headers(sent.headers).get("authorization")).toBe("Bearer access-secret");
  });

  it("retains the issued client ID for reauthorization and blocks a different validated account", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    expect(JSON.parse(harness.storeSnapshot())).toMatchObject({ clientId: "issued-public-client" });

    await request(harness.handle, "/v1/disconnect", { token, body: {} });
    harness.changeSubject("different-validated-account");
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    const reauthorization = new URL(harness.openedUrl as string);
    expect(reauthorization.searchParams.get("client_id")).toBe("issued-public-client");
    expect(reauthorization.searchParams.get("ext_agent_host_id")).toBe("host-12345678");
    expect(reauthorization.searchParams.has("agent_name_hint")).toBe(false);

    const callback = new URL(`http://127.0.0.1:${harness.handle.port}/auth/callback`);
    callback.searchParams.set("state", reauthorization.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "different-account-code");
    const result = await fetch(callback);
    expect(await result.text()).toContain("could not be verified");
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({ auth: "blocked", safeMessage: "account_mismatch" });
    expect(JSON.parse(harness.storeSnapshot())).toMatchObject({ clientId: "issued-public-client" });
  });

  it("clears the account registration on explicit account switch while retaining the host ID", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);

    const switchResponse = await request(harness.handle, "/v1/account/switch", { token, body: {} });
    expect(switchResponse.status).toBe(200);
    expect(await switchResponse.json()).toMatchObject({ registrationForgotten: true });
    expect(JSON.parse(harness.storeSnapshot())).toMatchObject({ extAgentHostId: "host-12345678" });
    expect(JSON.parse(harness.storeSnapshot())).not.toHaveProperty("clientId");
    expect(JSON.parse(harness.storeSnapshot())).not.toHaveProperty("subjectHash");

    harness.changeSubject("new-validated-account");
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    const freshRegistration = new URL(harness.openedUrl as string);
    expect(freshRegistration.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(freshRegistration.searchParams.get("ext_agent_host_id")).toBe("host-12345678");
    expect(freshRegistration.searchParams.get("agent_name_hint")).toBe("Figma AI Design Engine");
    const callback = new URL(`http://127.0.0.1:${harness.handle.port}/auth/callback`);
    callback.searchParams.set("state", freshRegistration.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "new-account-code");
    callback.searchParams.set("client_id", "issued-public-client");
    await fetch(callback);
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({ auth: "scope_granted", planUseAuthorized: true });
  });

  it("maps a streamed plan-usage failure to a sanitized recovery category", async () => {
    const harness = await createHarness({ usageFailure: true });
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });
    const smoke = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(smoke.status).toBe(502);
    expect(await smoke.json()).toMatchObject({ error: "quota_or_rate_limit" });
  });

  it("cancels the upstream stream when the paired UI aborts the smoke request", async () => {
    const harness = await createHarness({ stalledStream: true });
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });

    const controller = new AbortController();
    const pending = request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
      signal: controller.signal,
    });
    await harness.waitForResponseStream();
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(harness.wasResponseStreamCancelled()).toBe(true));
  });

  it("distinguishes identity from direct plan-use scope and blocks model/inference requests", async () => {
    const harness = await createHarness({ scope: "openid profile email" });
    const token = await harness.pair();
    const start = await request(harness.handle, "/v1/auth/start", { token, body: {} });
    expect(start.status).toBe(200);
    await completeLogin(harness);
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({
      auth: "signed_in_no_plan",
      planUseAuthorized: false,
    });
    const models = await request(harness.handle, "/v1/models", { token, body: {} });
    expect(models.status).toBe(403);
    expect(harness.responsesRequest).toBeUndefined();
  });

  it("rejects oversized pairing input and does not expose an unauthenticated endpoint", async () => {
    const harness = await createHarness();
    const tooLarge = await request(harness.handle, "/v1/pair", {
      body: { code: "x".repeat(20_000) },
    });
    expect(tooLarge.status).toBe(403);
    const unknown = await request(harness.handle, "/private", {});
    expect(unknown.status).toBe(401);
  });

  it("rejects a callback replay after the one-time state has been consumed", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    const authorization = new URL(harness.openedUrl as string);
    const callback = new URL(`http://127.0.0.1:${harness.handle.port}/auth/callback`);
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "bad-state");
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("client_id", "issued-public-client");
    await fetch(callback);
    const replay = await fetch(callback);
    expect(await replay.text()).toContain("sign-in attempt expired");
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({ auth: "scope_granted", planUseAuthorized: true });
  });

  it("maps a revoked refresh credential to an expired-session state", async () => {
    const harness = await createHarness({ expiresIn: 2, refresh: true, refreshFailure: true });
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    harness.advanceTime(5_000);
    const models = await request(harness.handle, "/v1/models", { token, body: {} });
    expect(models.status).toBe(401);
    expect(await models.json()).toMatchObject({ error: "session_expired" });
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({ auth: "session_expired" });
  });

  it("handles consent denial only after checking the original state and makes no token request", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    const authorization = new URL(harness.openedUrl as string);
    const callback = new URL(`http://127.0.0.1:${harness.handle.port}/auth/callback`);
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
    callback.searchParams.set("error", "access_denied");
    await fetch(callback);
    expect(harness.codeExchange).toBeUndefined();
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({
      auth: "signed_out",
      safeMessage: "consent_denied",
    });
  });

  it("fails clearly if the local port is already occupied", async () => {
    const first = await createHarness();
    const second = createCompanionServer({
      port: first.handle.port,
      installationStore: first.store,
      fetchImpl: vi.fn(),
    });
    await expect(second.start()).rejects.toBeDefined();
    await first.handle.close();
    const restarted = await second.start();
    expect(restarted.port).toBe(first.handle.port);
    expect(restarted.pairingCode).not.toBe(first.handle.pairingCode);
    await restarted.close();
  });

  it("uses rotated refresh credentials only in memory", async () => {
    const harness = await createHarness({
      scope: `openid profile ${PLAN_USE_SCOPE}`,
      expiresIn: 2,
      refresh: true,
    });
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    harness.advanceTime(5_000);
    const models = await request(harness.handle, "/v1/models", { token, body: {} });
    expect(models.status).toBe(200);
    expect(harness.refreshRequest).toContain("refresh_token=refresh-old");
    expect(harness.storeSnapshot()).not.toContain("refresh-new");
    expect(harness.storeSnapshot()).not.toContain("access-rotated");
  });
});

async function createHarness(
  options: {
    scope?: string;
    expiresIn?: number;
    refresh?: boolean;
    refreshFailure?: boolean;
    usageFailure?: boolean;
    stalledStream?: boolean;
  } = {},
) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "local-test-key",
    use: "sig",
    alg: "RS256",
  };
  const storeData = {
    extAgentHostId: "host-12345678",
    clientId: undefined as string | undefined,
    subjectHash: undefined as string | undefined,
  };
  let openedUrl: string | undefined;
  let responsesRequest: { body: string; headers: HeadersInit } | undefined;
  let refreshRequest: string | undefined;
  let codeExchange: string | undefined;
  let markResponseStreamStarted = () => {};
  let responseStreamCancelled = false;
  const responseStreamStarted = new Promise<void>((resolve) => {
    markResponseStreamStarted = resolve;
  });
  let currentTime = Date.now();
  let authNonce = "";
  let authTransactionUrl: URL | undefined;
  let currentSubject = "opaque-subject";
  const store = {
    async load() {
      return { ...storeData };
    },
    async saveClientId(clientId: string, subjectHash?: string) {
      storeData.clientId = clientId;
      storeData.subjectHash = subjectHash;
    },
    async clearRegistration() {
      storeData.clientId = undefined;
      storeData.subjectHash = undefined;
    },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${OIDC_ISSUER}/.well-known/openid-configuration`) {
      return Response.json(discovery);
    }
    if (url === discovery.jwks_uri) return Response.json({ keys: [publicJwk] });
    if (url === discovery.token_endpoint) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type") === "refresh_token") {
        refreshRequest = form.toString();
        if (options.refreshFailure) {
          return Response.json(
            { error: "invalid_grant", error_description: "do not expose this text" },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: "access-rotated",
          refresh_token: "refresh-new",
          token_type: "Bearer",
          expires_in: 3_600,
          scope: options.scope ?? `openid profile ${PLAN_USE_SCOPE}`,
        });
      }
      codeExchange = form.toString();
      const clientId = form.get("client_id") ?? "issued-public-client";
      return Response.json({
        access_token: "access-secret",
        refresh_token: options.refresh ? "refresh-old" : undefined,
        token_type: "Bearer",
        id_token: createIdToken(keys.privateKey, clientId, authNonce, currentSubject),
        expires_in: options.expiresIn ?? 3_600,
        scope: options.scope ?? `openid profile email ${PLAN_USE_SCOPE}`,
      });
    }
    if (url === "https://api.openai.com/v1/models") {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== "Bearer access-secret" && authorization !== "Bearer access-rotated") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        models: [
          { slug: "account-model", display_name: "Account Model", visibility: "list" },
          { slug: "hidden-model", display_name: "Hidden Model", visibility: "private" },
        ],
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      responsesRequest = { body: String(init?.body ?? ""), headers: init?.headers ?? {} };
      if (options.stalledStream) {
        return new Response(
          new ReadableStream({
            start() {
              markResponseStreamStarted();
            },
            cancel() {
              responseStreamCancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (options.usageFailure) {
        return new Response(
          `data: ${JSON.stringify({
            type: "response.failed",
            response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({ error: "unexpected_test_request" }, { status: 500 });
  };
  const companion = createCompanionServer({
    port: 0,
    fetchImpl,
    installationStore: store,
    now: () => currentTime,
    openBrowser: async (url) => {
      openedUrl = url;
      authTransactionUrl = new URL(url);
      authNonce = authTransactionUrl.searchParams.get("nonce") ?? "";
    },
  });
  const handle = await companion.start();
  openHandles.push(handle);

  return {
    handle,
    store,
    get openedUrl() {
      return openedUrl;
    },
    get responsesRequest() {
      return responsesRequest;
    },
    get refreshRequest() {
      return refreshRequest;
    },
    get codeExchange() {
      return codeExchange;
    },
    async pair() {
      const result = await request(handle, "/v1/pair", { body: { code: handle.pairingCode } });
      return ((await result.json()) as { sessionToken: string }).sessionToken;
    },
    advanceTime(milliseconds: number) {
      currentTime += milliseconds;
    },
    changeSubject(subject: string) {
      currentSubject = subject;
    },
    storeSnapshot() {
      return JSON.stringify(storeData);
    },
    waitForResponseStream() {
      return responseStreamStarted;
    },
    wasResponseStreamCancelled() {
      return responseStreamCancelled;
    },
    async completeLogin(harness: { handle: CompanionServerHandle; openedUrl?: string }) {
      const authorization = authTransactionUrl ?? new URL(harness.openedUrl as string);
      const callback = new URL(`http://127.0.0.1:${handle.port}/auth/callback`);
      callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
      callback.searchParams.set("code", "test-code");
      callback.searchParams.set("client_id", "issued-public-client");
      await fetch(callback);
    },
  };
}

async function completeLogin(harness: Awaited<ReturnType<typeof createHarness>>) {
  await harness.completeLogin(harness);
}

async function request(
  handle: CompanionServerHandle,
  path: string,
  options: { token?: string; body?: unknown; origin?: string; signal?: AbortSignal },
): Promise<Response> {
  const headers = new Headers({ Origin: options.origin ?? "null" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: options.body !== undefined || path === "/v1/pair" ? "POST" : "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function createIdToken(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  aud: string,
  nonce: string,
  subject: string,
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "local-test-key", typ: "JWT" })}.${encode({
    iss: OIDC_ISSUER,
    aud,
    sub: subject,
    nonce,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}
