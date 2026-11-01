import { describe, expect, it, vi } from "vitest";
import {
  CompanionClientError,
  discoverAuthorizedModels,
  getCompanionStatus,
  pairWithCompanion,
  runSmokeRequest,
} from "../src/ui/companion-client";

describe("Figma UI companion client", () => {
  it("pairs with a valid one-time code and uses an explicit loopback endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ sessionToken: "x".repeat(43) }),
    );
    const token = await pairWithCompanion("A".repeat(32), fetcher);
    expect(token).toBe("x".repeat(43));
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:1455/v1/pair",
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("rejects malformed pairing codes before issuing a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(pairWithCompanion("too-short", fetcher)).rejects.toMatchObject({
      category: "pairing_failed",
    } satisfies Partial<CompanionClientError>);
    expect(fetcher).not.toHaveBeenCalled();
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
