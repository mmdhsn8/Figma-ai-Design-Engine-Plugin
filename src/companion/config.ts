/** Shared loopback configuration for the Figma UI and local companion. */
export const COMPANION_HOSTNAME = "localhost";
/** SIWC requires the OAuth redirect URI to use 127.0.0.1, not localhost. */
export const COMPANION_OAUTH_HOST = "127.0.0.1";
export const COMPANION_PORT = 1_455;
export const COMPANION_BASE_URL = `http://${COMPANION_HOSTNAME}:${COMPANION_PORT}`;
export const COMPANION_CALLBACK_PATH = "/auth/callback";
export const COMPANION_DEV_DOMAIN = COMPANION_BASE_URL;
export const COMPANION_BIND_ADDRESSES = ["127.0.0.1", "::1"] as const;
export const COMPANION_UI_ORIGIN = "null";
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const MAX_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_STREAM_OVERALL_TIMEOUT_MS = 5 * 60_000;
export const MAX_STREAM_OVERALL_TIMEOUT_MS = 10 * 60_000;

export function configuredTimeoutMs(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? Math.min(parsed, maximum) : fallback;
}
