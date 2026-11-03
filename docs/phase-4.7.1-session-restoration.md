# Phase 4.7.1 — Session Restoration and Storage

## Root cause

The repeated sign-in came from separate lifetimes that were all process or UI memory only:

1. **Plugin UI remount:** the local companion bearer was held only in React state. A remount discarded it, so the UI could not check the existing companion session.
2. **Companion bearer session:** the companion kept only bearer hashes in a process `Map`. Closing the companion invalidated every bearer.
3. **Companion restart:** closing the server cleared the in-memory ChatGPT session and bearer map.
4. **OAuth storage:** access and refresh tokens were not written to durable storage.
5. **Refresh/restoration:** refresh ran only for an already-loaded in-memory session. Rotated refresh tokens were not persisted. Any refresh error also discarded the session, including temporary network errors.
6. **Authorization on launch:** the plugin did not start OAuth on launch. It asked the user to re-pair because it had lost its local bearer; the browser authorization was a consequence of that flow, not an unconditional launch request.

## What is persisted

The companion stores OAuth access and refresh tokens, subject identity, scopes, expiry, and hashes for approved local pairing grants in:

```text
%LOCALAPPDATA%\Figma AI Design Engine\credentials.v1.dpapi
```

The file payload is protected with Windows DPAPI using `DataProtectionScope.CurrentUser` and app-specific optional entropy. The companion passes input to PowerShell over stdin, never as a command argument. The file contains only the DPAPI ciphertext and a format marker. Writes use a temporary file in the same directory and replace the credential file. If the user profile is not loaded or protection fails, the companion keeps the current session in memory and reports that durable restoration is unavailable.

`installation.json` remains separate and stores only the stable `ext_agent_host_id`, issued public client ID, and a SHA-256 subject fingerprint. It does not store OAuth credentials. The host ID remains stable across normal restarts and account switching.

Figma `clientStorage` contains only a `FADP1T:` ticket: a DPAPI-sealed random pairing grant ID and secret. `clientStorage` is not treated as secure storage. The companion stores only the grant's SHA-256 hash in its DPAPI file. A restored ticket mints a new short-lived in-memory bearer; that bearer is never saved. First pairing still requires the browser approval page and its CSRF proof. A ticket does not approve a new plugin client.

The OAuth ID token is validated during callback and discarded after extracting the subject. OAuth tokens and local bearer credentials are not placed in Figma document nodes, design JSON, URLs, or logs.

## Refresh and disconnect behavior

The implementation uses the documented Sign in with ChatGPT authorization-code/PKCE flow and requests `offline_access`. Refresh uses the issued public `client_id`, the stored refresh token, `grant_type=refresh_token`, and `resource=https://api.openai.com/v1`; it omits `scope`. A replacement refresh token is saved before a later restart can use it.

Refresh attempts are serialized. Network and service failures preserve the credential record for a retry. `invalid_grant`, invalid client registration, missing refresh credentials, and an upstream 401 move the account to **Sign-in required** and clear active tokens from the protected store. Sign-in is user-triggered; restoring a valid session does not open a browser or request consent.

- **Disconnect this plugin from the local companion** revokes that pairing grant and all live bearer sessions created from it. It leaves ChatGPT OAuth credentials intact.
- **Disconnect ChatGPT account** clears the OAuth credential record and keeps local pairing intact.
- **Forget account registration and switch account** also clears the issued client ID and subject fingerprint. It preserves the stable host ID and local pairing grant.

## Threat model and limits

- DPAPI CurrentUser protects credential contents from offline file inspection and other Windows users. It does not protect against malware or code already running as the same Windows user, nor an administrator who can act as that user.
- A Figma `clientStorage` value is scoped to this plugin and is treated as inspectable. Its ticket is ciphertext bound to the Windows user through DPAPI. Another plugin without the ticket cannot restore the session.
- If the Windows user profile is unavailable, reset, or belongs to a different Windows account, the companion cannot decrypt the credential file. The UI must ask for local approval or ChatGPT sign-in again.
- The companion uses protected storage only when it is available. There is no plaintext fallback. A session may work until the current companion process exits while persistence is unavailable.
- The automated DPAPI CurrentUser round-trip passes in this execution context with the explicit 30-second test timeout. It does not verify that the interactive Windows profile running Figma Desktop can restore the companion session end to end.

## Official contract references

- [OpenAI Sign in with ChatGPT: Sign in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI Sign in with ChatGPT: Profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI Sign in with ChatGPT: Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [OpenAI Sign in with ChatGPT: Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Figma Plugin API: clientStorage](https://developers.figma.com/docs/plugins/api/figma-clientStorage/)
- [Microsoft .NET: ProtectedData](https://learn.microsoft.com/dotnet/api/system.security.cryptography.protecteddata)

## Automated verification

Latest run after the model-bound inference-gate fix: `npm run test` completed with **201 passed across 21 test files**. The Windows DPAPI ciphertext round-trip passed with an explicit 30-second test timeout; it had exceeded Vitest's default 5-second timeout when the suite spawned many workers. Typecheck, companion compile, lint, Prettier check, and production build were also run for this update. The tests cover UI-remount restore exchange, companion restart and refresh rotation, expired/revoked credentials, disconnect separation, account switching, approval cancellation/replay, invalid tickets, and missing/corrupt credential data. Mocked OAuth/provider results do not establish live inference or Figma Desktop acceptance.

## Manual Windows and Figma Desktop acceptance checklist

Run the companion from a normal PowerShell window signed in as the same Windows user running Figma Desktop. The DPAPI test must pass in that user context before claiming durable OAuth storage.

1. Start the companion and open the plugin. Complete first local pairing and approve it in the browser. Confirm the plugin reports **Connected**.
2. Complete official ChatGPT sign-in and grant the requested plan-use scope. Confirm no token appears in plugin storage as readable text, `installation.json`, Figma document nodes, or logs.
3. Close and reopen the plugin UI. Confirm it restores without showing the local approval or OAuth browser flow.
4. Restart Figma Desktop. Reopen the same plugin and confirm it restores without repeating approval or consent.
5. Restart the companion. Reopen the plugin and confirm the pairing ticket restores a new local bearer and the OAuth account returns without a browser prompt.
6. Cause or simulate an expired access token. Confirm refresh succeeds and a later companion restart uses the rotated refresh token without consent.
7. Revoke the OAuth credential or use an expired refresh token. Confirm the header changes to **Sign-in required** and the UI asks for a user-triggered sign-in.
8. Stop the companion. Confirm the header shows **Companion offline** and the saved ticket remains available for its next start. Restart it and confirm **Reconnecting** then **Connected**.
9. Use **Disconnect ChatGPT account**. Confirm the local pairing stays connected and ChatGPT sign-in is required.
10. Use **Disconnect this plugin from the local companion**. Confirm the ChatGPT session remains in the companion but the plugin requires a new explicit local approval. Confirm an old ticket is rejected.
11. Use account switch. Confirm the issued client registration is cleared, the stable host ID is unchanged, and the next account is not compared with stale subject metadata.
12. Cancel a new pairing and replay its approval or poll request. Confirm it cannot create a persistent pairing grant. Try restoring with a missing or fabricated ticket and confirm rejection.

Do not mark steps 3–7 as verified from automated mocks. They require Figma Desktop and the companion running under the same interactive Windows user.
