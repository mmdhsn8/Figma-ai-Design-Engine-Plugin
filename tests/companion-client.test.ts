import { describe, expect, it, vi } from "vitest";
import {
  CompanionClientError,
  disconnectLocalSession,
  discoverAuthorizedModels,
  getCompanionHealth,
  getCompanionStatus,
  pollLocalPairing,
  reopenChatGPTSignIn,
  reopenLocalApproval,
  restoreLocalCompanionSession,
  restoreLocalSession,
  requestLocalPairing,
  runSmokeRequest,
} from "../src/ui/companion-client";

describe("Figma UI companion client", () => {
  it("discovers the local companion and starts approval without exposing a terminal code", async () => {
    const healthFetcher = vi.fn<typeof fetch>(async () => Response.json({ companion: "running" }));
    expect(await getCompanionHealth(healthFetcher)).toBe(true);
    expect(healthFetcher).toHaveBeenCalledWith(
      "http://localhost:1455/v1/health",
      expect.objectContaining({ method: "GET", mode: "cors", credentials: "omit" }),
    );
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ attemptId: "a".repeat(43), expiresInMs: 90_000, approvalOpened: true }),
    );
    const attempt = await requestLocalPairing("v".repeat(43), fetcher);
    expect(attempt).toEqual({
      attemptId: "a".repeat(43),
      expiresInMs: 90_000,
      approvalOpened: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:1455/v1/pairing/attempt",
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ verifier: "v".repeat(43) }),
      }),
    );
  });

  it("rejects malformed local pairing proofs before issuing a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(requestLocalPairing("too-short", fetcher)).rejects.toMatchObject({
      category: "pairing_failed",
    } satisfies Partial<CompanionClientError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("polls an attempt with its verifier and validates approved session credentials", async () => {
    const pendingFetch = vi.fn<typeof fetch>(async () => Response.json({ status: "pending" }));
    expect(await pollLocalPairing("a".repeat(43), "v".repeat(43), pendingFetch)).toEqual({
      status: "pending",
    });
    const approvedFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "approved",
        sessionToken: "s".repeat(43),
        restoreTicket: "FADP1T:" + "A".repeat(64),
        restoreAvailable: true,
      }),
    );
    expect(await pollLocalPairing("a".repeat(43), "v".repeat(43), approvedFetch)).toEqual({
      status: "approved",
      sessionToken: "s".repeat(43),
      restoreTicket: "FADP1T:" + "A".repeat(64),
      restoreAvailable: true,
    });
  });

  it("restores a saved pairing after a plugin UI remount without starting OAuth", async () => {
    const ticket = "FADP1T:" + "A".repeat(64);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sessionToken: "s".repeat(43) }))
      .mockResolvedValueOnce(
        Response.json({
          companion: "connected",
          auth: "scope_granted",
          authLabel: "Ready",
          planUseAuthorized: true,
          modelCount: 0,
        }),
      );

    await expect(restoreLocalCompanionSession(ticket, fetcher)).resolves.toMatchObject({
      token: "s".repeat(43),
      status: { auth: "scope_granted", planUseAuthorized: true },
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:1455/v1/pairing/restore",
      "http://localhost:1455/v1/status",
    ]);
    expect(fetcher).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/auth/start"),
      expect.anything(),
    );
  });

  it("rejects malformed or forged restore tickets before sending them", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(restoreLocalSession("not-a-ticket", fetcher)).rejects.toMatchObject({
      category: "pairing_failed",
    } satisfies Partial<CompanionClientError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reopens the system approval page only for a pending local proof", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ opened: true }));
    await expect(
      reopenLocalApproval("a".repeat(43), "v".repeat(43), fetcher),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:1455/v1/pairing/open",
      expect.objectContaining({
        body: JSON.stringify({ attemptId: "a".repeat(43), verifier: "v".repeat(43) }),
      }),
    );
  });

  it("offers a separate user-triggered retry for a pending ChatGPT browser flow", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: {
          companion: "connected",
          auth: "signing_in",
          authLabel: "Signing in",
          planUseAuthorized: false,
          modelCount: 0,
        },
      }),
    );
    expect(await reopenChatGPTSignIn("s".repeat(43), fetcher)).toMatchObject({
      auth: "signing_in",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:1455/v1/auth/open",
      expect.objectContaining({ body: "{}" }),
    );
  });

  it("treats the health probe as offline when loopback is unavailable", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(getCompanionHealth(offline)).rejects.toMatchObject({
      category: "connection_failed",
    });
  });

  it("can clear only the local pairing session", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ disconnected: true }));
    await expect(disconnectLocalSession("s".repeat(43), fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:1455/v1/pairing/disconnect",
      expect.objectContaining({ body: "{}" }),
    );
  });

  it("validates status payloads and maps server errors to safe categories", async () => {
    const badStatus = vi.fn<typeof fetch>(async () =>
      Response.json({ auth: "ready", token: "secret" }),
    );
    await expect(getCompanionStatus("x".repeat(40), badStatus)).rejects.toMatchObject({
      category: "unknown",
    });

    const denied = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "plan_use_scope_missing" }, { status: 403 }),
    );
    await expect(discoverAuthorizedModels("x".repeat(40), denied)).rejects.toMatchObject({
      category: "plan_use_scope_missing",
    });
  });

  it("preserves the official model slug/display-name shape", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ models: [{ slug: "model-slug", displayName: "Model Display Name" }] }),
    );
    expect(await discoverAuthorizedModels("x".repeat(40), fetcher)).toEqual([
      { slug: "model-slug", displayName: "Model Display Name" },
    ]);
  });

  it("sends only the selected account-visible model through the smoke action", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, completed: true, text: "OK" }),
    );
    expect(await runSmokeRequest("session-bearer", "account-model", fetcher)).toBe("OK");
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer session-bearer");
    expect(options?.body).toBe(JSON.stringify({ model: "account-model" }));
  });

  it("reports user cancellation separately from a connection failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    const pending = runSmokeRequest("x".repeat(40), "account-model", fetcher, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "request_cancelled" });
  });
});
