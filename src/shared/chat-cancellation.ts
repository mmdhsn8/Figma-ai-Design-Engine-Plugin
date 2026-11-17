export const CHAT_ABORT_ORIGINS = [
  "user_stop",
  "plugin_closed",
  "session_changed",
  "authorization_revoked",
  "client_disconnected",
  "companion_shutdown",
  "scheduler_stopped",
  "unattributed_abort",
] as const;

export type ChatAbortOrigin = (typeof CHAT_ABORT_ORIGINS)[number];

export function isChatAbortOrigin(value: unknown): value is ChatAbortOrigin {
  return CHAT_ABORT_ORIGINS.some((origin) => origin === value);
}

export function chatAbortOrigin(signal?: AbortSignal): ChatAbortOrigin {
  return isChatAbortOrigin(signal?.reason) ? signal.reason : "unattributed_abort";
}
