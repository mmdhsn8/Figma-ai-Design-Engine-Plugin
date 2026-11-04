import { describe, expect, it, vi } from "vitest";
import {
  CompanionClientError,
  disconnectLocalSession,
  discoverAuthorizedModels,
  getCompanionHealth,
  getCompanionStatus,
  generateAuthorizedDesign,
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

    const verified = vi.fn<typeof fetch>(async () =>
      Response.json({
        companion: "connected",
        auth: "ready",
        authLabel: "Ready",
        planUseAuthorized: true,
        modelCount: 1,
        inferenceVerifiedModel: "account-model",
      }),
    );
    await expect(getCompanionStatus("x".repeat(40), verified)).resolves.toMatchObject({
      inferenceVerifiedModel: "account-model",
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
      Response.json({
        success: true,
        completed: true,
        text: "OK",
        status: {
          companion: "connected",
          auth: "ready",
          authLabel: "Ready",
          planUseAuthorized: true,
          modelCount: 1,
          inferenceVerifiedModel: "account-model",
        },
        diagnostic: {
          model: "account-model",
          stage: "stream",
          outcome: "completed",
          terminalEvent: "response.completed",
          lastEvent: "response.completed",
          eventCount: 2,
          responseBytes: 128,
        },
      }),
    );
    await expect(
      runSmokeRequest("session-bearer", "account-model", fetcher),
    ).resolves.toMatchObject({
      text: "OK",
      status: { inferenceVerifiedModel: "account-model" },
      diagnostic: { model: "account-model", terminalEvent: "response.completed" },
    });
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer session-bearer");
    expect(options?.body).toBe(JSON.stringify({ model: "account-model" }));
  });

  it("maps structured capability errors and exposes only sanitized streaming diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: "unsupported_capability",
          diagnostic: {
            model: "gpt-5.6-luna",
            stage: "http",
            outcome: "http_error",
            httpStatus: 400,
            errorCode: "subscription_sharing_unsupported_capability",
            errorParam: "text.format",
          },
          ignoredSensitiveMessage: "this field must not become the displayed diagnostic",
        },
        { status: 400 },
      ),
    );
    await expect(runSmokeRequest("session-bearer", "gpt-5.6-luna", fetcher)).rejects.toMatchObject({
      category: "unsupported_capability",
      diagnostic: {
        model: "gpt-5.6-luna",
        httpStatus: 400,
        errorCode: "subscription_sharing_unsupported_capability",
        errorParam: "text.format",
      },
    });
  });

  it("streams one selected screen from the companion and verifies completion metadata", async () => {
    const designRequest = {
      prompt: "Create a two-screen English dashboard for a small team.",
      target: "desktop" as const,
      screenCount: 2,
      language: "en" as const,
      style: "calm and editorial",
      projectType: "dashboard" as const,
      theme: "light" as const,
    };
    const designText = '{"screens":[]}';
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(designText, {
          headers: {
            "Content-Type": "application/json",
            "X-FAD-Request-Id": "req-design",
            "X-FAD-Model": "account-model",
            "X-FAD-Completed": "response.completed",
            "X-FAD-Response-Bytes": String(new TextEncoder().encode(designText).byteLength),
          },
        }),
    );
    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-design",
        "account-model",
        designRequest,
        [],
        fetcher,
        undefined,
        ["home"],
      ),
    ).resolves.toBe(designText);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://localhost:1455/v1/design");
    expect(options?.method).toBe("POST");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer session-bearer");
    expect(JSON.parse(String(options?.body))).toEqual({
      requestId: "req-design",
      model: "account-model",
      request: designRequest,
      screenIds: ["home"],
    });

    const mismatched = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          headers: {
            "Content-Type": "application/json",
            "X-FAD-Request-Id": "other-request",
            "X-FAD-Model": "account-model",
            "X-FAD-Completed": "response.completed",
            "X-FAD-Response-Bytes": "2",
          },
        }),
    );
    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-design",
        "account-model",
        designRequest,
        [],
        mismatched,
      ),
    ).rejects.toMatchObject({ category: "response_incomplete" });
  });

  it("preserves bounded validation issues returned by the companion", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: "invalid_design_request",
          issues: [
            "screenNames: Enter the same number of screen names as the selected screen count.",
          ],
          ignored: "untrusted detail",
        },
        { status: 400 },
      ),
    );
    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-invalid-contract",
        "account-model",
        {
          prompt: "Create a mobile app with two screens.",
          target: "mobile",
          screenCount: 2,
          language: "en",
          style: "",
          projectType: "product",
          theme: "auto",
        },
        [],
        fetcher,
      ),
    ).rejects.toMatchObject({
      category: "invalid_design_request",
      validationIssues: [
        "screenNames: Enter the same number of screen names as the selected screen count.",
      ],
    });
  });

  it("retries one clean SSE EOF for the same screen without accepting partial output", async () => {
    const designRequest = {
      prompt: "Create a three-screen English storefront.",
      target: "mobile" as const,
      screenCount: 3,
      screenNames: ["Home", "Products", "Cart"],
      language: "en" as const,
      style: "",
      projectType: "storefront" as const,
      theme: "auto" as const,
    };
    const designText = '{"projectName":"Store","screens":[{"id":"home","children":[]}]}';
    const success = () =>
      new Response(designText, {
        headers: {
          "Content-Type": "application/json",
          "X-FAD-Request-Id": "req-home",
          "X-FAD-Model": "account-model",
          "X-FAD-Completed": "response.completed",
          "X-FAD-Response-Bytes": String(new TextEncoder().encode(designText).byteLength),
        },
      });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "response_incomplete",
            diagnostic: {
              model: "account-model",
              stage: "stream",
              outcome: "stream_ended_without_terminal",
              httpStatus: 200,
              lastEvent: "response.output_text.delta",
              eventCount: 2_331,
              responseBytes: 625_484,
              generatedBytes: 8_590,
            },
          },
          { status: 502 },
        ),
      )
      .mockImplementationOnce(async () => success());
    const onRetry = vi.fn();

    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-home",
        "account-model",
        designRequest,
        [],
        fetcher,
        undefined,
        ["home"],
        onRetry,
      ),
    ).resolves.toBe(designText);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        requestId: "req-home",
        model: "account-model",
        request: designRequest,
        screenIds: ["home"],
      },
      {
        requestId: "req-home",
        model: "account-model",
        request: designRequest,
        screenIds: ["home"],
      },
    ]);
  });

  it("stops after one clean-EOF retry when the retry also ends incomplete", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: "response_incomplete",
          diagnostic: {
            model: "account-model",
            stage: "stream",
            outcome: "stream_ended_without_terminal",
            httpStatus: 200,
          },
        },
        { status: 502 },
      ),
    );

    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-one-eof-retry",
        "account-model",
        {
          prompt: "Create a mobile storefront.",
          target: "mobile",
          screenCount: 1,
          language: "en",
          style: "",
          projectType: "storefront",
          theme: "auto",
        },
        [],
        fetcher,
        undefined,
        ["home"],
      ),
    ).rejects.toMatchObject({
      category: "response_incomplete",
      diagnostic: { outcome: "stream_ended_without_terminal" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a stream timeout once for the same screen request", async () => {
    const designRequest = {
      prompt: "Create a mobile storefront.",
      target: "mobile" as const,
      screenCount: 1,
      language: "en" as const,
      style: "",
      projectType: "storefront" as const,
      theme: "auto" as const,
    };
    const designText = '{"projectName":"Store","screens":[{"id":"home","children":[]}]}';
    const timeoutResponse = () =>
      Response.json(
        {
          error: "request_timed_out",
          diagnostic: {
            model: "account-model",
            stage: "stream",
            outcome: "timed_out",
            httpStatus: 200,
            timeoutKind: "idle",
            elapsedMs: 300_000,
            idleMs: 15,
            lastDeltaAgeMs: 15,
          },
        },
        { status: 502 },
      );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(timeoutResponse())
      .mockResolvedValueOnce(
        new Response(designText, {
          headers: {
            "Content-Type": "application/json",
            "X-FAD-Request-Id": "req-timeout-home",
            "X-FAD-Model": "account-model",
            "X-FAD-Completed": "response.completed",
            "X-FAD-Response-Bytes": String(new TextEncoder().encode(designText).byteLength),
          },
        }),
      );

    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-timeout-home",
        "account-model",
        designRequest,
        [],
        fetcher,
        undefined,
        ["home"],
      ),
    ).resolves.toBe(designText);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        requestId: "req-timeout-home",
        model: "account-model",
        request: designRequest,
        screenIds: ["home"],
      },
      {
        requestId: "req-timeout-home",
        model: "account-model",
        request: designRequest,
        screenIds: ["home"],
      },
    ]);
  });

  it("bounds timeout retries and does not retry after cancellation", async () => {
    const timeoutResponse = () =>
      Response.json(
        {
          error: "request_timed_out",
          diagnostic: {
            model: "account-model",
            stage: "stream",
            outcome: "timed_out",
            httpStatus: 200,
            timeoutKind: "idle",
          },
        },
        { status: 502 },
      );
    const designRequest = {
      prompt: "Create a mobile storefront.",
      target: "mobile" as const,
      screenCount: 1,
      language: "en" as const,
      style: "",
      projectType: "storefront" as const,
      theme: "auto" as const,
    };
    const fetcher = vi.fn<typeof fetch>(async () => timeoutResponse());

    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-timeout-limit",
        "account-model",
        designRequest,
        [],
        fetcher,
        undefined,
        ["home"],
      ),
    ).rejects.toMatchObject({ category: "request_timed_out" });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const cancelledFetcher = vi.fn<typeof fetch>(async () => timeoutResponse());
    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-timeout-cancelled",
        "account-model",
        designRequest,
        [],
        cancelledFetcher,
        controller.signal,
        ["home"],
        () => controller.abort(),
      ),
    ).rejects.toMatchObject({ category: "request_cancelled" });
    expect(cancelledFetcher).toHaveBeenCalledOnce();

    for (const stage of ["http", "stream"]) {
      const headerTimeoutFetcher = vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            error: "request_timed_out",
            diagnostic: {
              model: "account-model",
              stage,
              outcome: "timed_out",
              timeoutKind: "overall",
            },
          },
          { status: 502 },
        ),
      );
      await expect(
        generateAuthorizedDesign(
          "session-bearer",
          "req-header-timeout",
          "account-model",
          designRequest,
          [],
          headerTimeoutFetcher,
        ),
      ).rejects.toMatchObject({ category: "request_timed_out" });
      expect(headerTimeoutFetcher).toHaveBeenCalledOnce();
    }
  });

  it("accepts multi-megabyte streamed JSON split at arbitrary byte boundaries", async () => {
    const content = JSON.stringify({ copy: "طراحی چندصفحه‌ای ".repeat(150_000) });
    const bytes = new TextEncoder().encode(content);
    expect(bytes.byteLength).toBeGreaterThan(2 * 1_024 * 1_024);
    const sizes = [1, 2, 17, 4_097, 63_000];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        let index = 0;
        while (offset < bytes.length) {
          const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]!);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        }
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, {
          headers: {
            "Content-Type": "application/json",
            "X-FAD-Request-Id": "req-large",
            "X-FAD-Model": "account-model",
            "X-FAD-Completed": "response.completed",
            "X-FAD-Response-Bytes": String(bytes.byteLength),
          },
        }),
    );
    await expect(
      generateAuthorizedDesign(
        "session-bearer",
        "req-large",
        "account-model",
        {
          prompt: "Create a large multi-screen design with realistic content.",
          target: "mobile",
          screenCount: 2,
          language: "en",
          style: "",
          projectType: "auto",
          theme: "auto",
        },
        [],
        fetcher,
      ),
    ).resolves.toBe(content);
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

  it("rejects oversized local companion responses before parsing them", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ models: [], unused: "x".repeat(1_100_100) }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(discoverAuthorizedModels("x".repeat(40), fetcher)).rejects.toMatchObject({
      category: "response_too_large",
    });
  });
});
