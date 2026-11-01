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
