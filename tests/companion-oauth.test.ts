import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertTrustedHttpsUrl,
  createAuthorizationTransaction,
  createAuthorizationUrl,
  createCodeChallenge,
  DYNAMIC_CLIENT_ENTRYPOINT,
  OIDC_ISSUER,
  parseGrantedScopes,
  PLAN_USE_SCOPE,
  REQUESTED_SCOPES,
  validateAuthorizationCallback,
  validateIdToken,
  type OidcDiscovery,
} from "../src/companion/oauth.js";

const discovery: OidcDiscovery = {
  issuer: OIDC_ISSUER,
  authorization_endpoint: `${OIDC_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${OIDC_ISSUER}/api/accounts/oauth/token`,
  revocation_endpoint: `${OIDC_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${OIDC_ISSUER}/.well-known/jwks.json`,
};
const TEST_HOST_ID = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";

describe("Sign in with ChatGPT OAuth contract helpers", () => {
  it("creates PKCE S256, state, nonce, resource and documented dynamic registration fields", () => {
    const transaction = createAuthorizationTransaction(
      DYNAMIC_CLIENT_ENTRYPOINT,
      "http://127.0.0.1:1455/auth/callback",
      1_000,
    );
    const url = createAuthorizationUrl(discovery, transaction, TEST_HOST_ID);

    expect(url.toString()).toContain("https://auth.openai.com/api/accounts/authorize?");
    expect(url.searchParams.get("client_id")).toBe(DYNAMIC_CLIENT_ENTRYPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("scope")).toBe(REQUESTED_SCOPES);
    expect(url.searchParams.get("agent_name_hint")).toBe("Figma AI Design Engine");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(TEST_HOST_ID);
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("state")).toBe(transaction.state);
    expect(url.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(transaction.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(transaction.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get("code_challenge")).toBe(
      createCodeChallenge(transaction.codeVerifier),
    );
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        "agent_name_hint",
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "ext_agent_host_id",
        "nonce",
        "redirect_uri",
        "resource",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
  });

  it("rejects a missing or malformed host identifier instead of constructing an auth URL", () => {
    const transaction = createAuthorizationTransaction(
      DYNAMIC_CLIENT_ENTRYPOINT,
      "http://127.0.0.1:1455/auth/callback",
    );
    expect(() => createAuthorizationUrl(discovery, transaction, "")).toThrow("host_id_invalid");
    expect(() =>
      createAuthorizationUrl(discovery, transaction, "123e4567-e89b-42d3-a456-426614174000"),
    ).toThrow("host_id_invalid");
    expect(() => createAuthorizationUrl(discovery, transaction, "urn:uuid:not-a-uuid")).toThrow(
      "host_id_invalid",
    );
  });

  it("uses an issued client ID on reauthorization and omits initial-registration hints", () => {
    const transaction = createAuthorizationTransaction(
      "oaiapp_issued_public_client",
      "http://127.0.0.1:1455/auth/callback",
    );
    const url = createAuthorizationUrl(discovery, transaction, TEST_HOST_ID);

    expect(url.searchParams.get("client_id")).toBe("oaiapp_issued_public_client");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("ext_agent_host_id")).toBe(TEST_HOST_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
  });

  it("accepts only state-matched callbacks and the issued client ID", () => {
    const transaction = createAuthorizationTransaction(
      DYNAMIC_CLIENT_ENTRYPOINT,
      "http://127.0.0.1:1455/auth/callback",
      1_000,
    );
    const mismatch = new URLSearchParams({
      state: "wrong",
      code: "auth-code",
      client_id: "issued-client",
    });
    const valid = new URLSearchParams({
      state: transaction.state,
      code: "auth-code",
      client_id: "issued-client",
    });
    const missingClient = new URLSearchParams({ state: transaction.state, code: "auth-code" });

    expect(validateAuthorizationCallback(mismatch, transaction, undefined, 2_000)).toEqual({
      ok: false,
      category: "callback_invalid",
    });
    expect(validateAuthorizationCallback(missingClient, transaction, undefined, 2_000)).toEqual({
      ok: false,
      category: "client_id_mismatch",
    });
    expect(validateAuthorizationCallback(valid, transaction, undefined, 2_000)).toEqual({
      ok: true,
      code: "auth-code",
      clientId: "issued-client",
    });
    expect(validateAuthorizationCallback(valid, transaction, undefined, 400_000)).toEqual({
      ok: false,
      category: "callback_invalid",
    });
  });

  it("rejects consent denial and a mismatched retained client ID", () => {
    const transaction = createAuthorizationTransaction(
      "known-client",
      "http://127.0.0.1:1455/auth/callback",
      1_000,
    );
    const denied = new URLSearchParams({ error: "access_denied", state: transaction.state });
    const deniedWithWrongState = new URLSearchParams({ error: "access_denied", state: "wrong" });
    const changed = new URLSearchParams({
      state: transaction.state,
      code: "auth-code",
      client_id: "other-client",
    });
    expect(validateAuthorizationCallback(denied, transaction, "known-client", 2_000)).toEqual({
      ok: false,
      category: "consent_denied",
    });
    expect(
      validateAuthorizationCallback(deniedWithWrongState, transaction, "known-client", 2_000),
    ).toEqual({
      ok: false,
      category: "callback_invalid",
    });
    expect(validateAuthorizationCallback(changed, transaction, "known-client", 2_000)).toEqual({
      ok: false,
      category: "client_id_mismatch",
    });
  });

  it("uses only actually granted scope strings", () => {
    expect(parseGrantedScopes(`openid profile ${PLAN_USE_SCOPE}`).has(PLAN_USE_SCOPE)).toBe(true);
    expect(parseGrantedScopes("openid profile email").has(PLAN_USE_SCOPE)).toBe(false);
    expect(parseGrantedScopes(null).size).toBe(0);
  });

  it("rejects OAuth endpoints outside the discovered official HTTPS host", () => {
    expect(() => assertTrustedHttpsUrl("https://auth.openai.com.attacker.example/token")).toThrow(
      "untrusted_endpoint",
    );
    expect(() => assertTrustedHttpsUrl("https://auth.openai.com:444/token")).toThrow(
      "untrusted_endpoint",
    );
  });

  it("validates ID-token RS256 signature, issuer, audience, expiry and nonce", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = {
      ...publicKey.export({ format: "jwk" }),
      kid: "test-key",
      use: "sig",
      alg: "RS256",
    };
    const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
    const payload = encode({
      iss: OIDC_ISSUER,
      aud: "issued-client",
      sub: "opaque-subject",
      nonce: "one-time-nonce",
      exp: 2_000,
      nbf: 1_000,
    });
    const input = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
    const token = `${input}.${signature}`;
    const keys = { keys: [jwk] };

    expect(validateIdToken(token, keys, "issued-client", "one-time-nonce", 1_500)).toEqual({
      ok: true,
      subject: "opaque-subject",
      expiresAt: 2_000,
    });
    expect(validateIdToken(token, keys, "wrong-client", "one-time-nonce", 1_500)).toMatchObject({
      ok: false,
      category: "id_token_invalid",
    });
    expect(validateIdToken(token, keys, "issued-client", "wrong-nonce", 1_500)).toMatchObject({
      ok: false,
      category: "nonce_mismatch",
    });
    expect(validateIdToken(token, keys, "issued-client", "one-time-nonce", 2_001)).toMatchObject({
      ok: false,
      category: "id_token_expired",
    });
    expect(
      validateIdToken(`${input}.invalid`, keys, "issued-client", "one-time-nonce", 1_500),
    ).toMatchObject({
      ok: false,
      category: "id_token_invalid",
    });
  });
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
