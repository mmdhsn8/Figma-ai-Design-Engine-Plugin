import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_BIND_ADDRESSES } from "../src/companion/config.js";
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
const TEST_HOST_ID = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";

const openHandles: CompanionServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((handle) => handle.close()));
});

describe("loopback companion", () => {
  it("serves localhost on both resolved loopback address families", async () => {
    const harness = await createHarness();
    expect(COMPANION_BIND_ADDRESSES).toEqual(["127.0.0.1", "::1"]);

    for (const address of COMPANION_BIND_ADDRESSES) {
      const response = await requestLoopbackAddress(address, harness.handle.port);
      expect(response.statusCode).toBe(401);
      expect(response.allowOrigin).toBe("*");
    }
  });

  it("serves safe health and requires browser approval plus verifier proof for local pairing", async () => {
    const harness = await createHarness();
    const preflight = await fetch(`http://localhost:${harness.handle.port}/v1/pairing/attempt`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Private-Network": "true",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");

    const health = await request(harness.handle, "/v1/health", {});
    expect(await health.json()).toEqual({ companion: "running" });
    const originDenied = await request(harness.handle, "/v1/pairing/attempt", {
      body: { verifier: "A".repeat(43) },
      origin: "https://untrusted.example",
    });
    expect(originDenied.status).toBe(403);

    const unauthenticated = await request(harness.handle, "/v1/status", {});
    expect(unauthenticated.status).toBe(401);
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const stillPending = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(await stillPending.json()).toEqual({ status: "pending" });
    const approvalPage = await getApprovalPage(harness.handle, pairing.attemptId);
    expect(approvalPage.status).toBe(200);
    const html = await approvalPage.text();
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain("cannot verify whether the request came from Figma AI Design Engine");
    expect(html).not.toContain("sessionToken");
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1];
    expect(csrf).toBeDefined();

    const crossSiteApproval = await submitApproval(
      harness.handle,
      pairing.attemptId,
      csrf!,
      "approve",
      {
        origin: "null",
        omitFetchMetadata: true,
      },
    );
    expect(crossSiteApproval.status).toBe(403);
    expect(await crossSiteApproval.text()).toContain("opaque browser origin is allowed only");
    const invalidOrigin = await submitApproval(
      harness.handle,
      pairing.attemptId,
      csrf!,
      "approve",
      { origin: "https://untrusted.example" },
    );
    expect(invalidOrigin.status).toBe(403);
    expect(await invalidOrigin.text()).toContain("browser origin did not match");
    const missingCsrf = await submitApproval(harness.handle, pairing.attemptId, "wrong", "approve");
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.text()).toContain("approval proof was invalid");
    const approved = await submitApproval(harness.handle, pairing.attemptId, csrf!, "approve");
    expect(approved.status).toBe(200);
    const approvalReplay = await submitApproval(
      harness.handle,
      pairing.attemptId,
      csrf!,
      "approve",
    );
    expect(approvalReplay.status).toBe(410);
    expect(await approvalReplay.text()).toContain("Local companion access was already approved");

    const wrongProof = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier: "B".repeat(43) },
    });
    expect(wrongProof.status).toBe(403);
    const paired = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(paired.status).toBe(200);
    const pairingResult = (await paired.json()) as { status: string; sessionToken: string };
    expect(pairingResult.status).toBe("approved");
    expect(pairingResult.sessionToken).toHaveLength(43);

    const replay = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(replay.status).toBe(409);
    const connected = await request(harness.handle, "/v1/status", {
      token: pairingResult.sessionToken,
    });
    expect(connected.status).toBe(200);
    const body = (await connected.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ companion: "connected", auth: "signed_out" });
    expect(JSON.stringify(body)).not.toContain(pairingResult.sessionToken);

    const disconnected = await request(harness.handle, "/v1/pairing/disconnect", {
      token: pairingResult.sessionToken,
      body: {},
    });
    expect(await disconnected.json()).toEqual({ disconnected: true });
    expect(
      (await request(harness.handle, "/v1/status", { token: pairingResult.sessionToken })).status,
    ).toBe(401);
  });

  it("renders approval controls for an allowlisted opaque-origin top-level GET and rejects cross-site GET", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const unverifiedOpaqueNavigation = await getApprovalPage(harness.handle, pairing.attemptId, {
      origin: "null",
      omitFetchMetadata: true,
    });
    expect(unverifiedOpaqueNavigation.status).toBe(403);
    expect(await unverifiedOpaqueNavigation.text()).toContain(
      "opaque browser origin is allowed only",
    );

    const opaqueNavigation = await getApprovalPage(harness.handle, pairing.attemptId, {
      origin: "null",
      fetchSite: "none",
      fetchMode: "navigate",
      fetchDest: "document",
      fetchUser: "?1",
    });
    const form = await opaqueNavigation.text();
    expect(opaqueNavigation.status, form).toBe(200);
    expect(form).toContain('name="decision" value="approve"');
    expect(form).toContain('name="decision" value="deny"');

    const crossSiteNavigation = await getApprovalPage(harness.handle, pairing.attemptId, {
      origin: "https://untrusted.example",
      fetchSite: "cross-site",
      fetchMode: "navigate",
      fetchDest: "document",
    });
    expect(crossSiteNavigation.status).toBe(403);
    const rejected = await crossSiteNavigation.text();
    expect(rejected).toContain("marked this approval as cross-origin");
    expect(rejected).toContain("Safe diagnostic: Host=localhost; Origin=other;");
    expect(rejected).not.toContain("untrusted.example");
    expect(rejected).not.toContain(pairing.attemptId);
  });

  it("accepts a valid browser form when optional Fetch Metadata headers are omitted", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const page = await getApprovalPage(harness.handle, pairing.attemptId, {
      omitFetchMetadata: true,
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('name="decision" value="approve"');
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1];
    expect(csrf).toBeDefined();

    const approved = await submitApproval(harness.handle, pairing.attemptId, csrf!, "approve", {
      omitFetchMetadata: true,
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("Local companion access was approved");

    const paired = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(paired.status).toBe(200);
    expect(await paired.json()).toMatchObject({ status: "approved" });
  });

  it("accepts a user-initiated navigation metadata value with the CSRF proof", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const page = await getApprovalPage(harness.handle, pairing.attemptId);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";
    const approved = await submitApproval(harness.handle, pairing.attemptId, csrf, "approve", {
      fetchSite: "none",
    });
    expect(approved.status).toBe(200);
  });

  it("accepts Origin null only with allowlisted top-level navigation metadata and valid CSRF", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const page = await getApprovalPage(harness.handle, pairing.attemptId);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";

    const opaquePost = await submitApproval(harness.handle, pairing.attemptId, csrf, "approve", {
      origin: "null",
      fetchSite: "none",
      fetchUser: "?1",
    });
    expect(opaquePost.status).toBe(200);

    const paired = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(paired.status).toBe(200);
  });

  it("accepts a missing Origin only with the valid local form proof and rejects a non-document destination", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const page = await getApprovalPage(harness.handle, pairing.attemptId);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";

    const wrongDestination = await submitApproval(
      harness.handle,
      pairing.attemptId,
      csrf,
      "approve",
      { fetchDest: "iframe" },
    );
    expect(wrongDestination.status).toBe(403);
    expect(await wrongDestination.text()).toContain("not a top-level document navigation");
    const stillPending = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(await stillPending.json()).toEqual({ status: "pending" });

    const originlessPost = await submitApproval(
      harness.handle,
      pairing.attemptId,
      csrf,
      "approve",
      { omitOrigin: true, fetchSite: "none" },
    );
    expect(originlessPost.status).toBe(200);
  });

  it("keeps a rejected browser-context post pending so the same approval can be retried", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await beginPairing(harness.handle, verifier);
    const approvalUrl = harness.openedUrl;
    const page = await getApprovalPage(harness.handle, pairing.attemptId);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";
    const rejected = await submitApproval(harness.handle, pairing.attemptId, csrf, "approve", {
      fetchSite: "cross-site",
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toContain("marked this approval as cross-origin");

    const stillPending = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(await stillPending.json()).toEqual({ status: "pending" });
    const reopened = await request(harness.handle, "/v1/pairing/open", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(reopened.status).toBe(200);
    expect(harness.openedUrl).toBe(approvalUrl);

    const retried = await submitApproval(harness.handle, pairing.attemptId, csrf, "approve", {
      omitFetchMetadata: true,
    });
    expect(retried.status).toBe(200);
    const paired = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: pairing.attemptId, verifier },
    });
    expect(paired.status).toBe(200);
  });

  it.each(["127.0.0.1", "[::1]"])(
    "serves and accepts the approval form through the %s loopback host",
    async (host) => {
      const harness = await createHarness();
      const verifier = randomBytes(32).toString("base64url");
      const pairing = await beginPairing(harness.handle, verifier);
      const page = await getApprovalPage(harness.handle, pairing.attemptId, { host });
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain('name="decision" value="approve"');
      const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1];
      expect(csrf).toBeDefined();

      const approved = await submitApproval(harness.handle, pairing.attemptId, csrf!, "approve", {
        host,
        omitFetchMetadata: true,
      });
      expect(approved.status).toBe(200);
      const paired = await request(harness.handle, "/v1/pairing/poll", {
        body: { attemptId: pairing.attemptId, verifier },
      });
      expect(paired.status).toBe(200);
    },
  );

  it("rejects concurrent approval attempts and reports explicit denial and expiration", async () => {
    const harness = await createHarness();
    const firstVerifier = randomBytes(32).toString("base64url");
    const first = await beginPairing(harness.handle, firstVerifier);
    const second = await request(harness.handle, "/v1/pairing/attempt", {
      body: { verifier: randomBytes(32).toString("base64url") },
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "pairing_busy" });

    const firstHtml = await (await getApprovalPage(harness.handle, first.attemptId)).text();
    const firstCsrf = firstHtml.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";
    await submitApproval(harness.handle, first.attemptId, firstCsrf, "deny");
    const deniedPoll = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: first.attemptId, verifier: firstVerifier },
    });
    expect(deniedPoll.status).toBe(403);
    expect(await deniedPoll.json()).toMatchObject({ error: "pairing_denied" });
    const deniedPage = await getApprovalPage(harness.handle, first.attemptId);
    expect(await deniedPage.text()).toContain("Local companion access was denied");

    const expiringVerifier = randomBytes(32).toString("base64url");
    const expiring = await beginPairing(harness.handle, expiringVerifier);
    harness.advanceTime(91_000);
    const expiredPoll = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: expiring.attemptId, verifier: expiringVerifier },
    });
    expect(expiredPoll.status).toBe(410);
    expect(await expiredPoll.json()).toMatchObject({ error: "pairing_expired" });
    const expiredPage = await getApprovalPage(harness.handle, expiring.attemptId);
    expect(await expiredPage.text()).toContain("This local approval expired");
  });

  it("cancels pairing only with the matching verifier and invalidates sessions on companion restart", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const attempt = await beginPairing(harness.handle, verifier);
    const wrongCancel = await request(harness.handle, "/v1/pairing/cancel", {
      body: { attemptId: attempt.attemptId, verifier: randomBytes(32).toString("base64url") },
    });
    expect(wrongCancel.status).toBe(403);
    const cancel = await request(harness.handle, "/v1/pairing/cancel", {
      body: { attemptId: attempt.attemptId, verifier },
    });
    expect(cancel.status).toBe(200);
    const cancelledPoll = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: attempt.attemptId, verifier },
    });
    expect(cancelledPoll.status).toBe(403);
    expect(await cancelledPoll.json()).toMatchObject({ error: "pairing_cancelled" });
    const cancelledPage = await getApprovalPage(harness.handle, attempt.attemptId);
    expect(await cancelledPage.text()).toContain("This local approval was cancelled");

    const approvedVerifier = randomBytes(32).toString("base64url");
    const approvedAttempt = await beginPairing(harness.handle, approvedVerifier);
    const approvedPage = await getApprovalPage(harness.handle, approvedAttempt.attemptId);
    const approvedHtml = await approvedPage.text();
    const approvedCsrf = approvedHtml.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";
    await submitApproval(harness.handle, approvedAttempt.attemptId, approvedCsrf, "approve");
    const cancelBeforeDelivery = await request(harness.handle, "/v1/pairing/cancel", {
      body: { attemptId: approvedAttempt.attemptId, verifier: approvedVerifier },
    });
    expect(cancelBeforeDelivery.status).toBe(200);
    const cancelledBeforeDeliveryPoll = await request(harness.handle, "/v1/pairing/poll", {
      body: { attemptId: approvedAttempt.attemptId, verifier: approvedVerifier },
    });
    expect(await cancelledBeforeDeliveryPoll.json()).toMatchObject({ error: "pairing_cancelled" });

    const token = await harness.pair();
    await harness.handle.close();
    const restarted = createCompanionServer({
      port: 0,
      installationStore: harness.store,
    });
    const restartedHandle = await restarted.start();
    openHandles.push(restartedHandle);
    const oldTokenResponse = await request(restartedHandle, "/v1/status", { token });
    expect(oldTokenResponse.status).toBe(401);
  });

  it("rate limits approval attempts and rejects extra request properties", async () => {
    const harness = await createHarness();
    const extraProperty = await request(harness.handle, "/v1/pairing/attempt", {
      body: { verifier: randomBytes(32).toString("base64url"), clientName: "untrusted" },
    });
    expect(extraProperty.status).toBe(400);

    for (let index = 0; index < 5; index += 1) {
      const verifier = randomBytes(32).toString("base64url");
      const attempt = await beginPairing(harness.handle, verifier);
      await request(harness.handle, "/v1/pairing/cancel", {
        body: { attemptId: attempt.attemptId, verifier },
      });
    }
    const limited = await request(harness.handle, "/v1/pairing/attempt", {
      body: { verifier: randomBytes(32).toString("base64url") },
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "pairing_rate_limited" });
  });

  it("reopens the local approval page only for the originating proof", async () => {
    const harness = await createHarness();
    const verifier = randomBytes(32).toString("base64url");
    const attempt = await beginPairing(harness.handle, verifier);
    const openedAfterStart = harness.openedUrl;
    const wrongProof = await request(harness.handle, "/v1/pairing/open", {
      body: { attemptId: attempt.attemptId, verifier: randomBytes(32).toString("base64url") },
    });
    expect(wrongProof.status).toBe(403);
    const opened = await request(harness.handle, "/v1/pairing/open", {
      body: { attemptId: attempt.attemptId, verifier },
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ opened: true });
    expect(harness.openedUrl).toBe(openedAfterStart);
  });

  it("reports a failed system-browser launch and allows a user-triggered retry", async () => {
    let openCount = 0;
    const companion = createCompanionServer({
      port: 0,
      installationStore: {
        load: async () => ({ extAgentHostId: TEST_HOST_ID }),
        saveClientId: async () => undefined,
        clearRegistration: async () => undefined,
      },
      openBrowser: async () => {
        openCount += 1;
        if (openCount === 1) throw new Error("browser_unavailable");
      },
    });
    const handle = await companion.start();
    openHandles.push(handle);
    const verifier = randomBytes(32).toString("base64url");
    const started = await request(handle, "/v1/pairing/attempt", { body: { verifier } });
    expect(started.status).toBe(200);
    const attempt = (await started.json()) as { attemptId: string; approvalOpened: boolean };
    expect(attempt.approvalOpened).toBe(false);
    const retried = await request(handle, "/v1/pairing/open", {
      body: { attemptId: attempt.attemptId, verifier },
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ opened: true });
    expect(openCount).toBe(2);
  });

  it("keeps OAuth pending after a browser-launch failure and retries only on user request", async () => {
    const harness = await createHarness({ oauthBrowserFailures: 1 });
    const token = await harness.pair();
    const start = await request(harness.handle, "/v1/auth/start", { token, body: {} });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({
      status: {
        auth: "signing_in",
        safeMessage: "system_browser_unavailable",
      },
    });

    const retry = await request(harness.handle, "/v1/auth/open", { token, body: {} });
    expect(retry.status).toBe(200);
    const retryStatus = (await retry.json()) as { status: Record<string, unknown> };
    expect(retryStatus.status).toMatchObject({ auth: "signing_in" });
    expect(retryStatus.status).not.toHaveProperty("safeMessage");
    expect(new URL(harness.openedUrl as string).pathname).toBe("/api/accounts/authorize");
  });

  it("expires idle local bearers and extends them only while authenticated use continues", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    harness.advanceTime(14 * 60 * 1_000);
    expect((await request(harness.handle, "/v1/status", { token })).status).toBe(200);
    harness.advanceTime(14 * 60 * 1_000);
    expect((await request(harness.handle, "/v1/status", { token })).status).toBe(200);
    harness.advanceTime(16 * 60 * 1_000);
    expect((await request(harness.handle, "/v1/status", { token })).status).toBe(401);
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
    expect(authorization.searchParams.get("ext_agent_host_id")).toBe(TEST_HOST_ID);
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
    expect(reauthorization.searchParams.get("ext_agent_host_id")).toBe(TEST_HOST_ID);
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
    expect(JSON.parse(harness.storeSnapshot())).toMatchObject({ extAgentHostId: TEST_HOST_ID });
    expect(JSON.parse(harness.storeSnapshot())).not.toHaveProperty("clientId");
    expect(JSON.parse(harness.storeSnapshot())).not.toHaveProperty("subjectHash");

    harness.changeSubject("new-validated-account");
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    const freshRegistration = new URL(harness.openedUrl as string);
    expect(freshRegistration.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(freshRegistration.searchParams.get("ext_agent_host_id")).toBe(TEST_HOST_ID);
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

  it("rejects oversized pairing input and keeps account endpoints authenticated", async () => {
    const harness = await createHarness();
    const tooLarge = await request(harness.handle, "/v1/pairing/attempt", {
      body: { verifier: "x".repeat(20_000) },
    });
    expect(tooLarge.status).toBe(400);
    const models = await request(harness.handle, "/v1/models", { body: {} });
    expect(models.status).toBe(401);
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
    expect("pairingCode" in restarted).toBe(false);
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
    oauthBrowserFailures?: number;
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
    extAgentHostId: TEST_HOST_ID,
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
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.includes("/api/accounts/authorize")) {
        if ((options.oauthBrowserFailures ?? 0) > 0) {
          options.oauthBrowserFailures = (options.oauthBrowserFailures ?? 0) - 1;
          throw new Error("system_browser_unavailable");
        }
        authTransactionUrl = parsedUrl;
        authNonce = parsedUrl.searchParams.get("nonce") ?? "";
      }
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
      const verifier = randomBytes(32).toString("base64url");
      const attempt = await beginPairing(handle, verifier);
      const approvalPage = await getApprovalPage(handle, attempt.attemptId);
      const html = await approvalPage.text();
      const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";
      await submitApproval(handle, attempt.attemptId, csrf, "approve");
      const result = await request(handle, "/v1/pairing/poll", {
        body: { attemptId: attempt.attemptId, verifier },
      });
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
  return fetch(`http://localhost:${handle.port}${path}`, {
    method: options.body !== undefined ? "POST" : "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function beginPairing(
  handle: CompanionServerHandle,
  verifier: string,
): Promise<{ attemptId: string; expiresInMs: number }> {
  const response = await request(handle, "/v1/pairing/attempt", { body: { verifier } });
  expect(response.status).toBe(200);
  return (await response.json()) as { attemptId: string; expiresInMs: number };
}

async function getApprovalPage(
  handle: CompanionServerHandle,
  attemptId: string,
  options: {
    origin?: string;
    omitOrigin?: boolean;
    omitFetchMetadata?: boolean;
    host?: string;
    fetchSite?: string;
    fetchMode?: string;
    fetchDest?: string;
    fetchUser?: string;
  } = {},
): Promise<Response> {
  const requestHost = options.host ?? "localhost";
  const authority = `${requestHost}:${handle.port}`;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: requestHost === "[::1]" ? "::1" : requestHost,
        port: handle.port,
        path: `/local-approval/${attemptId}`,
        method: "GET",
        headers: {
          Host: authority,
          ...(options.omitOrigin ? {} : { Origin: options.origin ?? `http://${authority}` }),
          ...(options.omitFetchMetadata
            ? {}
            : {
                "Sec-Fetch-Site": options.fetchSite ?? "same-origin",
                "Sec-Fetch-Mode": options.fetchMode ?? "navigate",
                "Sec-Fetch-Dest": options.fetchDest ?? "document",
                ...(options.fetchUser ? { "Sec-Fetch-User": options.fetchUser } : {}),
              }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode,
              headers: incoming.headers as HeadersInit,
            }),
          );
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function submitApproval(
  handle: CompanionServerHandle,
  attemptId: string,
  csrf: string,
  decision: "approve" | "deny",
  options: {
    origin?: string;
    csrfHeader?: string;
    omitFetchMetadata?: boolean;
    omitOrigin?: boolean;
    host?: string;
    fetchSite?: string;
    fetchMode?: string;
    fetchDest?: string;
    fetchUser?: string;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams({ csrf: options.csrfHeader ?? csrf, decision }).toString();
  const requestHost = options.host ?? "localhost";
  const authority = `${requestHost}:${handle.port}`;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: requestHost === "[::1]" ? "::1" : requestHost,
        port: handle.port,
        path: `/local-approval/${attemptId}`,
        method: "POST",
        headers: {
          Host: authority,
          ...(options.omitOrigin ? {} : { Origin: options.origin ?? `http://${authority}` }),
          ...(options.omitFetchMetadata
            ? {}
            : {
                "Sec-Fetch-Site": options.fetchSite ?? "same-origin",
                "Sec-Fetch-Mode": options.fetchMode ?? "navigate",
                "Sec-Fetch-Dest": options.fetchDest ?? "document",
                ...(options.fetchUser ? { "Sec-Fetch-User": options.fetchUser } : {}),
              }),
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode,
              headers: incoming.headers as HeadersInit,
            }),
          );
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function requestLoopbackAddress(
  host: string,
  port: number,
): Promise<{ statusCode: number | undefined; allowOrigin: string | undefined }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host,
        port,
        path: "/v1/status",
        headers: { Host: `localhost:${port}`, Origin: "null" },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode,
            allowOrigin: response.headers["access-control-allow-origin"],
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
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
