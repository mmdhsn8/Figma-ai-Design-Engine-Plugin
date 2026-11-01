import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";

export const OIDC_ISSUER = "https://auth.openai.com";
export const OIDC_DISCOVERY_URL = `${OIDC_ISSUER}/.well-known/openid-configuration`;
export const DYNAMIC_CLIENT_ENTRYPOINT = "dynamic_agent_client";
export const RESPONSES_RESOURCE = "https://api.openai.com/v1";
export const IDENTITY_SCOPES = ["openid", "profile", "email"] as const;
export const PLAN_USE_SCOPE = "chatgpt.tokens.use.direct";
export const REQUESTED_SCOPES = [
  ...IDENTITY_SCOPES,
  "offline_access",
  "resource.invoke",
  PLAN_USE_SCOPE,
].join(" ");

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export interface AuthorizationTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

export type CallbackResult =
  | { ok: true; code: string; clientId: string }
  | { ok: false; category: "consent_denied" | "callback_invalid" | "client_id_mismatch" };

export type IdTokenResult =
  | { ok: true; subject: string; expiresAt: number }
  | {
      ok: false;
      category: "id_token_invalid" | "id_token_expired" | "nonce_mismatch";
    };

export function createAuthorizationTransaction(
  clientId: string,
  redirectUri: string,
  now = Date.now(),
): AuthorizationTransaction {
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier: randomBytes(32).toString("base64url"),
    clientId,
    redirectUri,
    expiresAt: now + 5 * 60_000,
  };
}

export function createAuthorizationUrl(
  discovery: OidcDiscovery,
  transaction: AuthorizationTransaction,
  hostId: string,
): URL {
  assertTrustedHttpsUrl(discovery.authorization_endpoint);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", transaction.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", transaction.redirectUri);
  url.searchParams.set("scope", REQUESTED_SCOPES);
  url.searchParams.set("state", transaction.state);
  url.searchParams.set("nonce", transaction.nonce);
  url.searchParams.set("code_challenge", createCodeChallenge(transaction.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", RESPONSES_RESOURCE);
  url.searchParams.set("ext_agent_host_id", hostId);
  if (transaction.clientId === DYNAMIC_CLIENT_ENTRYPOINT) {
    url.searchParams.set("agent_name_hint", "Figma AI Design Engine");
  }
  return url;
}

export function createCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validateAuthorizationCallback(
  params: URLSearchParams,
  transaction: AuthorizationTransaction,
  savedClientId: string | undefined,
  now = Date.now(),
): CallbackResult {
  if (now > transaction.expiresAt) return { ok: false, category: "callback_invalid" };
  const state = params.get("state");
  if (!state || !safeStringEqual(state, transaction.state)) {
    return { ok: false, category: "callback_invalid" };
  }
  if (params.has("error")) {
    return params.get("error") === "access_denied"
      ? { ok: false, category: "consent_denied" }
      : { ok: false, category: "callback_invalid" };
  }
  const code = params.get("code");
  if (!code || code.length > 4_096) return { ok: false, category: "callback_invalid" };

  const returnedClientId = params.get("client_id");
  let clientId: string;
  if (transaction.clientId === DYNAMIC_CLIENT_ENTRYPOINT) {
    if (!isClientId(returnedClientId) || returnedClientId === DYNAMIC_CLIENT_ENTRYPOINT) {
      return { ok: false, category: "client_id_mismatch" };
    }
    clientId = returnedClientId;
  } else {
    if (!isClientId(savedClientId) || savedClientId !== transaction.clientId) {
      return { ok: false, category: "client_id_mismatch" };
    }
    if (returnedClientId && returnedClientId !== savedClientId) {
      return { ok: false, category: "client_id_mismatch" };
    }
    clientId = savedClientId;
  }
  return { ok: true, code, clientId };
}

export function isClientId(value: string | null | undefined): value is string {
  return Boolean(value && value.length <= 512 && /^[A-Za-z0-9._~-]+$/.test(value));
}

export function parseGrantedScopes(scope: unknown): Set<string> {
  if (typeof scope !== "string" || scope.length > 4_096) return new Set();
  return new Set(scope.trim().split(/\s+/u).filter(Boolean));
}

export function validateIdToken(
  idToken: string,
  jwks: unknown,
  expectedAudience: string,
  expectedNonce: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): IdTokenResult {
  if (idToken.length > 32_768) return { ok: false, category: "id_token_invalid" };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, category: "id_token_invalid" };

  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
      alg?: unknown;
      kid?: unknown;
    };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      iss?: unknown;
      aud?: unknown;
      exp?: unknown;
      nbf?: unknown;
      iat?: unknown;
      azp?: unknown;
      nonce?: unknown;
      sub?: unknown;
    };
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return { ok: false, category: "id_token_invalid" };
    }
    if (
      claims.iss !== OIDC_ISSUER ||
      !audienceIncludes(claims.aud, expectedAudience) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== expectedAudience)
    ) {
      return { ok: false, category: "id_token_invalid" };
    }
    if (
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= nowSeconds
    ) {
      return { ok: false, category: "id_token_expired" };
    }
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 30) {
      return { ok: false, category: "id_token_invalid" };
    }
    if (typeof claims.iat === "number" && claims.iat > nowSeconds + 60) {
      return { ok: false, category: "id_token_invalid" };
    }
    if (typeof claims.nonce !== "string" || !safeStringEqual(claims.nonce, expectedNonce)) {
      return { ok: false, category: "nonce_mismatch" };
    }
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512) {
      return { ok: false, category: "id_token_invalid" };
    }

    const keys = (jwks as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys)) return { ok: false, category: "id_token_invalid" };
    const jwk = keys.find(
      (candidate): candidate is NodeJsonWebKey & { kid?: string; use?: string; alg?: string } =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { kid?: unknown }).kid === header.kid,
    );
    if (
      !jwk ||
      jwk.kty !== "RSA" ||
      (jwk.use && jwk.use !== "sig") ||
      (jwk.alg && jwk.alg !== "RS256")
    ) {
      return { ok: false, category: "id_token_invalid" };
    }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = Buffer.from(parts[2], "base64url");
    const publicKey = createPublicKey({ key: jwk as NodeJsonWebKey, format: "jwk" });
    if (!verify("RSA-SHA256", signingInput, publicKey, signature)) {
      return { ok: false, category: "id_token_invalid" };
    }
    return { ok: true, subject: claims.sub, expiresAt: claims.exp };
  } catch {
    return { ok: false, category: "id_token_invalid" };
  }
}

export function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function assertTrustedHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("untrusted_endpoint");
  }
  return url;
}

function audienceIncludes(aud: unknown, expected: string): boolean {
  return aud === expected || (Array.isArray(aud) && aud.includes(expected));
}
