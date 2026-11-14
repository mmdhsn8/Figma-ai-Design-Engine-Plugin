import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_BIND_ADDRESSES } from "../src/companion/config.js";
import {
  OIDC_ISSUER,
  PLAN_USE_SCOPE,
  createCodeChallenge,
  type OidcDiscovery,
} from "../src/companion/oauth.js";
import { createMemoryCredentialStore } from "../src/companion/credential-store.js";
import {
  createCompanionServer,
  readCompletedResponse,
  type CompanionServerHandle,
} from "../src/companion/server.js";
import { createDraftStore, type DraftStore } from "../src/companion/draft-store.js";
import { draftFixture } from "./generation-fixture";
import { createMockApi } from "./figma-mock";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { handleChatTaskStorage } from "../src/plugin/chat-task-storage";
import { chatTaskCommittedOperationCount, ChatTaskSchema } from "../src/shared/chat-task";
import { runChatTask } from "../src/ui/chat-task";
import { streamAuthorizedChat } from "../src/ui/companion-client";
import type { PluginToUIMessage } from "../src/shared/messages";
import { UIToPluginSchema, PluginToUISchema } from "../src/shared/messages";
import { FigmaToolBatchSchema } from "../src/shared/figma-tools";

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
  vi.restoreAllMocks();
  await Promise.all(openHandles.splice(0).map((handle) => handle.close()));
});

describe("loopback companion", () => {
  it("rejects a delayed model catalog response after the authenticated account changes", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });

    const gate = harness.stallNextModelsResponse();
    const oldCatalog = request(harness.handle, "/v1/models", { token, body: {} });
    await gate.started;
    await request(harness.handle, "/v1/account/switch", { token, body: {} });
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    harness.changeSubject("a-different-account-subject");
    await completeLogin(harness);
    gate.release();

    const staleResponse = await oldCatalog;
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({ error: "account_mismatch" });
    const currentStatus = await request(harness.handle, "/v1/status", { token });
    await expect(currentStatus.json()).resolves.toMatchObject({
      auth: "scope_granted",
      planUseAuthorized: true,
    });
  });

  it("continues a persisted one-commit task without colliding with an inspected page alias", async () => {
    let sequence = 0;
    const call = (name: string, args: unknown) => ({
      type: "function_call",
      call_id: `alias_call_${String(++sequence).padStart(4, "0")}`,
      name,
      arguments: JSON.stringify(args),
    });
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "Minimal",
      audience: "Shoppers",
      content: ["Header"],
      hierarchy: "One clear title",
      typography: { family: "Arial", style: "Regular", headingSize: 28, bodySize: 14 },
      spacingScale: [8, 16],
      radiusScale: [8, 16],
      palette: {
        source: "curated-default",
        background: "#FFFFFF",
        surface: "#FFFFFF",
        primary: "#222222",
        accent: "#AA3366",
        text: "#222222",
        muted: "#555555",
      },
      imagePolicy: "labeled-native-fallback",
      interactionPriorities: ["Header"],
      readingDirection: "RTL",
    };
    const plan = call("plan_canvas_task", {
      brief,
      stages: [
        {
          title: "Mobile root",
          goal: "Create the requested editable root frame",
          logicalRefs: ["store_mobile"],
          completionCriteria: ["The 390 × 844 root frame exists"],
        },
      ],
    });
    const initialResponses = [
      call("get_document_context", {}),
      plan,
      call("inspect_nodes", { refs: ["store_mobile"], selection: false }),
      call("create_frame", {
        ref: "store_mobile",
        name: "Task store_mobile",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
    ];
    const mock = createMockApi();
    let initial = true;
    let editSent = false;
    let completeSent = false;
    let repairSent = false;
    let modelTurns = 0;
    const harness = await createHarness({
      chatResponder: (input) => {
        modelTurns++;
        if (initial) {
          const next = initialResponses.shift();
          if (next) return { outputItems: [next] };
          throw new Error("controlled interruption after the committed root");
        }
        const latestOutput = [...input]
          .reverse()
          .find(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              item.type === "function_call_output",
          );
        let failureCode = "";
        if (
          latestOutput &&
          typeof latestOutput === "object" &&
          "output" in latestOutput &&
          typeof latestOutput.output === "string"
        ) {
          try {
            failureCode = JSON.parse(latestOutput.output).data?.referenceResolution?.code ?? "";
          } catch {
            failureCode = "";
          }
        }
        if (!editSent) {
          editSent = true;
          return {
            outputItems: [
              call("set_properties", { ref: "store_mobile", properties: { fill: "#AA3366" } }),
            ],
          };
        }
        if (failureCode === "ambiguous_alias" && !repairSent) {
          repairSent = true;
          const canonicalRef = mock
            .find("Task store_mobile")
            ?.getPluginData("fad.tool.logical-ref.v1");
          if (!canonicalRef) throw new Error("The committed task node has no canonical ref");
          return {
            outputItems: [
              call("set_properties", { ref: canonicalRef, properties: { fill: "#AA3366" } }),
            ],
          };
        }
        if (!completeSent) {
          completeSent = true;
          return { outputItems: [call("complete_canvas_stage", { summary: "Root is confirmed" })] };
        }
        return { text: "Completed", outputItems: [] };
      },
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const seeded = FigmaToolBatchSchema.parse({
      type: "tool-execute",
      protocolVersion: 1,
      batchId: "legacy-seed-batch-01",
      operations: [
        {
          operationId: "legacy-store-mobile-01",
          idempotencyKey: "legacy:store_mobile",
          action: {
            tool: "create_frame",
            ref: "store_mobile",
            name: "Existing page store_mobile",
            parent: { kind: "page" },
            size: { width: 320, height: 640 },
          },
        },
      ],
    });
    await executor(seeded);
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "store-mobile-task-01",
      intent: "create",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "Create one mobile storefront root frame.",
      context: [],
      stages: [],
      ledger: [],
      pending: [],
      recent: [],
      starts: [],
      rounds: 0,
      status: "ready",
      text: "",
    });
    const fetcher: typeof fetch = (url, options) =>
      fetch(`http://localhost:${harness.handle.port}${new URL(String(url)).pathname}`, {
        ...options,
        headers: { ...Object.fromEntries(new Headers(options?.headers)), Origin: "null" },
      });
    let saveRequest = 0;
    let oneCommitCheckpoint: ReturnType<typeof ChatTaskSchema.parse> | undefined;
    const deps = {
      signal: new AbortController().signal,
      progress: () => {},
      model: (
        input: Parameters<typeof streamAuthorizedChat>[3],
        lifecycle: Parameters<typeof streamAuthorizedChat>[4],
      ) =>
        streamAuthorizedChat(
          token,
          `alias-request-${++sequence}`,
          "account-model",
          input,
          lifecycle,
          fetcher,
        ),
      save: async (checkpoint: typeof task) => {
        const saved = await handleChatTaskStorage(mock.api, {
          type: "chat-task-save",
          requestId: `alias-save-${++saveRequest}`,
          documentId: checkpoint.documentId,
          task: checkpoint,
        });
        expect(saved.success).toBe(true);
        if (chatTaskCommittedOperationCount(checkpoint) === 1)
          oneCommitCheckpoint = ChatTaskSchema.parse(JSON.parse(JSON.stringify(checkpoint)));
      },
      execute: async (operations: Parameters<Parameters<typeof runChatTask>[1]["execute"]>[0]) => {
        const batchId = `alias-batch-${++sequence}`;
        const dispatch = UIToPluginSchema.parse(
          JSON.parse(
            JSON.stringify({ type: "tool-execute", protocolVersion: 1, batchId, operations }),
          ),
        );
        if (dispatch.type !== "tool-execute") throw new Error("Invalid dispatch");
        await executor(dispatch);
        const result = [...messages]
          .reverse()
          .find((message) => message.type === "tool-result" && message.batchId === batchId);
        if (!result || result.type !== "tool-result") throw new Error("Missing plugin result");
        return PluginToUISchema.parse(JSON.parse(JSON.stringify(result))) as Extract<
          PluginToUIMessage,
          { type: "tool-result" }
        >;
      },
    };
    await expect(runChatTask(task, deps)).rejects.toThrow();
    expect(oneCommitCheckpoint).toBeDefined();
    expect(chatTaskCommittedOperationCount(oneCommitCheckpoint!)).toBe(1);
    const persisted = await handleChatTaskStorage(mock.api, {
      type: "chat-task-load",
      requestId: "alias-load-01",
    });
    const restored = ChatTaskSchema.parse(persisted.task);
    expect(chatTaskCommittedOperationCount(restored)).toBe(1);
    const storedState = [...mock.storage.values()].find(
      (value) => typeof value === "object" && value !== null && "refs" in value,
    ) as { refs: Record<string, unknown[]> };
    expect(storedState.refs.store_mobile?.[8]).toBe(task.id);
    expect(Object.values(storedState.refs).some((entry) => entry[6] === "store_mobile")).toBe(true);

    initial = false;
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let resumeError: unknown;
    try {
      await runChatTask(restored, deps);
    } catch (error) {
      resumeError = error;
    }
    const aliasFailures = messages.filter(
      (message) =>
        message.type === "tool-result" &&
        message.results.some((result) => {
          const resolution = result.data?.referenceResolution;
          return (
            typeof resolution === "object" &&
            resolution !== null &&
            "code" in resolution &&
            resolution.code === "ambiguous_alias"
          );
        }),
    );
    expect(aliasFailures, JSON.stringify(aliasFailures)).toHaveLength(0);
    expect(resumeError).toBeUndefined();
    expect(repairSent).toBe(false);
    expect(restored.status).toBe("completed");
    expect(restored.stages[0]?.completed).toBe(true);
    expect(restored.rounds).toBe(7);
    expect(mock.nodes).toHaveLength(2);
    expect(mock.find("Existing page store_mobile")?.width).toBe(320);
    expect(mock.find("Task store_mobile")?.width).toBe(390);
    expect(mock.find("Task store_mobile")?.fills).toMatchObject([
      { type: "SOLID", color: { r: 170 / 255, g: 51 / 255, b: 102 / 255 } },
    ]);
    expect(modelTurns).toBe(8);
  }, 20_000);

  it("runs the production HTTP/SSE chat path with simulated planning contamination, checkpoint reload and purchase-button edit (mock OAuth/Responses/Figma)", async () => {
    let sequence = 0;
    const call = (name: string, args: unknown) => ({
      type: "function_call",
      call_id: `stability_call_${++sequence}`,
      name,
      arguments: JSON.stringify(args),
    });
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "Modern",
      audience: "Shoppers",
      content: ["Header", "Search", "Categories", "Banner", "Products", "Purchase"],
      hierarchy: "Title then products",
      typography: { family: "Arial", style: "Regular", headingSize: 28, bodySize: 14 },
      spacingScale: [8, 16],
      radiusScale: [8, 16],
      palette: {
        source: "curated-default",
        background: "#FFFFFF",
        surface: "#FFFFFF",
        primary: "#222222",
        accent: "#AA3366",
        text: "#222222",
        muted: "#555555",
      },
      imagePolicy: "labeled-native-fallback",
      interactionPriorities: ["Purchase"],
      readingDirection: "RTL",
    };
    const stage = {
      title: "Storefront",
      goal: "Create editable content",
      logicalRefs: ["store"],
      completionCriteria: ["All requested sections exist"],
    };
    const contaminatedPlan = call("plan_canvas_task", {
      brief,
      stages: [
        {
          ...stage,
          completed: false,
          operations: 0,
          rounds: 0,
          verification: { status: "pending" },
        },
      ],
    });
    const texts = [
      "فروشگاه لباس",
      "جست‌وجو",
      "دسته‌بندی‌ها",
      "بنر",
      "پیراهن — ۵۰۰٬۰۰۰ تومان",
      "خرید",
      "شلوار — ۷۰۰٬۰۰۰ تومان",
      "خرید",
    ];
    const nativeCalls = [
      call("create_frame", {
        ref: "store",
        name: "Store",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
        autoLayout: { direction: "vertical", gap: 8 },
      }),
      ...texts.flatMap((text, index) => [
        ...(index === 4 || index === 6
          ? [
              call("create_frame", {
                ref: `product-${index === 4 ? 0 : 1}`,
                name: `Product card ${index === 4 ? 0 : 1}`,
                parent: { kind: "node", ref: "store" },
                size: { width: 350, height: 160 },
                autoLayout: { direction: "vertical", gap: 8 },
              }),
            ]
          : []),
        ...(index === 5 || index === 7
          ? [
              call("create_frame", {
                ref: `purchase-${index === 5 ? 0 : 1}`,
                name: `Purchase button ${index === 5 ? 0 : 1}`,
                parent: { kind: "node", ref: `product-${index === 5 ? 0 : 1}` },
                size: { width: 320, height: 48 },
                fill: "#222222",
                cornerRadius: 12,
                autoLayout: {
                  direction: "horizontal",
                  primaryAlign: "CENTER",
                  counterAlign: "CENTER",
                },
              }),
            ]
          : []),
        call("create_text", {
          ref: index === 0 ? "header" : `content-${index}`,
          name: `Content ${index}`,
          parent: {
            kind: "node",
            ref:
              index < 4
                ? "store"
                : index === 5 || index === 7
                  ? `purchase-${index === 5 ? 0 : 1}`
                  : `product-${Math.floor((index - 4) / 2)}`,
          },
          text,
          size: { width: index === 5 || index === 7 ? 300 : 350, height: 48 },
          fontSize: index === 0 ? 28 : 16,
          color: index === 5 || index === 7 ? "#FFFFFF" : "#1F2937",
          direction: "RTL",
        }),
      ]),
    ];
    const responses = [
      { outputItems: [call("get_document_context", {})] },
      { outputItems: [contaminatedPlan] },
      { outputItems: nativeCalls.slice(0, 10) },
      { outputItems: nativeCalls.slice(10) },
      { outputItems: [call("complete_canvas_stage", { summary: "All sections exist" })] },
      { text: "Completed", outputItems: [] },
    ];
    const harness = await createHarness({ chatResponses: responses });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "stability-task-01",
      intent: "create",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt:
        "یک صفحه موبایل 390×844 برای فروشگاه لباس فارسی طراحی کن؛ شامل هدر، جست‌وجو، دسته‌بندی‌ها، بنر، دو کارت محصول با قیمت تومان و دکمه خرید. تمام عناصر قابل‌ویرایش باشند.",
      context: [],
      stages: [],
      ledger: [],
      pending: [],
      recent: [],
      starts: [],
      rounds: 0,
      status: "ready",
      text: "",
    });
    const fetcher: typeof fetch = (url, options) =>
      fetch(`http://localhost:${harness.handle.port}${new URL(String(url)).pathname}`, {
        ...options,
        headers: { ...Object.fromEntries(new Headers(options?.headers)), Origin: "null" },
      });
    let lost = false;
    let batch = 0;
    const progress: string[] = [];
    const deps = {
      signal: new AbortController().signal,
      progress: (message: string) => progress.push(message),
      model: (
        input: Parameters<typeof streamAuthorizedChat>[3],
        lifecycle: Parameters<typeof streamAuthorizedChat>[4],
      ) =>
        streamAuthorizedChat(
          token,
          `stability-request-${++sequence}`,
          "account-model",
          input,
          lifecycle,
          fetcher,
        ),
      save: async (checkpoint: typeof task) => {
        const saved = await handleChatTaskStorage(mock.api, {
          type: "chat-task-save",
          requestId: "stability-save-01",
          documentId: task.documentId,
          task: checkpoint,
        });
        expect(saved.success).toBe(true);
      },
      execute: async (operations: Parameters<Parameters<typeof runChatTask>[1]["execute"]>[0]) => {
        const batchId = `stability-batch-${++batch}`;
        const dispatch = UIToPluginSchema.parse(
          JSON.parse(
            JSON.stringify({ type: "tool-execute", protocolVersion: 1, batchId, operations }),
          ),
        );
        if (dispatch.type !== "tool-execute") throw new Error("Invalid dispatch");
        await executor(dispatch);
        const result = [...messages]
          .reverse()
          .find((message) => message.type === "tool-result" && message.batchId === batchId);
        if (!result || result.type !== "tool-result") throw new Error("Missing result");
        if (!lost && operations.some((operation) => operation.action.tool === "create_frame")) {
          lost = true;
          throw new Error("Lost acknowledgement");
        }
        const received = PluginToUISchema.parse(JSON.parse(JSON.stringify(result)));
        if (received.type !== "tool-result") throw new Error("Invalid result");
        return received;
      },
    };
    await expect(runChatTask(task, deps)).rejects.toThrow("Lost acknowledgement");
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const loaded = await handleChatTaskStorage(mock.api, {
      type: "chat-task-load",
      requestId: "stability-load-01",
    });
    const restored = ChatTaskSchema.parse(loaded.task);
    await runChatTask(restored, deps);
    expect(restored.status).toBe("completed");
    expect(restored.stages.every((item) => item.completed)).toBe(true);
    expect(restored.validationCorrections).toBe(0);
    expect(restored.rounds).toBe(6);
    expect(mock.nodes).toHaveLength(13);
    expect(mock.find("Product card 0")?.children).toHaveLength(2);
    expect(mock.find("Product card 1")?.children).toHaveLength(2);
    expect(
      mock.nodes.filter((node) => node.type === "TEXT").map((node) => node.characters),
    ).toEqual(texts);
    expect(progress.length).toBeGreaterThan(0);
    const header = mock.find("Content 0")!;
    const originalHeaderFills = header.fills;
    const firstPurchase = mock.find("Purchase button 0")!;
    const secondPurchase = mock.find("Purchase button 1")!;
    const firstPurchaseRef = firstPurchase.getPluginData("fad.tool.logical-ref.v1");
    const secondPurchaseRef = secondPurchase.getPluginData("fad.tool.logical-ref.v1");
    const storeRef = mock.find("Store")!.getPluginData("fad.tool.logical-ref.v1");
    responses.push(
      {
        outputItems: [
          call("plan_canvas_task", {
            brief,
            targetRefs: [storeRef, firstPurchaseRef, secondPurchaseRef],
            stages: [
              {
                ...stage,
                title: "Purchase buttons",
                goal: "Recolor only the existing purchase buttons",
                logicalRefs: [firstPurchaseRef, secondPurchaseRef],
              },
            ],
          }),
        ],
      },
      {
        outputItems: [
          call("set_properties", {
            ref: firstPurchaseRef,
            properties: { fill: "#C2185B" },
          }),
          call("set_properties", {
            ref: secondPurchaseRef,
            properties: { fill: "#C2185B" },
          }),
        ],
      },
      { outputItems: [call("complete_canvas_stage", { summary: "Edited existing buttons" })] },
      { text: "Edited", outputItems: [] },
    );
    const followup = ChatTaskSchema.parse({
      ...task,
      id: "stability-edit-01",
      intent: "edit",
      targetName: "Store",
      prompt: "رنگ دکمه‌های خرید را صورتی کن؛ بقیه عناصر تغییر نکنند.",
      stages: [],
      ledger: [],
      pending: [],
      recent: [],
      starts: [],
      rounds: 0,
      status: "ready",
    });
    await runChatTask(followup, deps);
    expect(followup.status).toBe("completed");
    expect(mock.nodes).toHaveLength(13);
    expect(firstPurchase.fills).toMatchObject([
      { type: "SOLID", color: { r: 194 / 255, g: 24 / 255, b: 91 / 255 } },
    ]);
    expect(secondPurchase.fills).toMatchObject([
      { type: "SOLID", color: { r: 194 / 255, g: 24 / 255, b: 91 / 255 } },
    ]);
    expect(header.fills).toEqual(originalHeaderFills);
  }, 20_000);

  it("streams allowlisted chat calls and accepts their function outputs for continuation", async () => {
    const call = {
      type: "function_call",
      call_id: "call_frame_123456",
      name: "create_frame",
      arguments: JSON.stringify({
        ref: "home",
        name: "Home",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
    };
    const harness = await createHarness({
      chatResponses: [
        { outputItems: [call], omitCompletedOutput: true },
        { text: "Your frame is ready.", outputItems: [] },
      ],
    });
    const token = await authorizeAndDiscover(harness);
    const unauthenticated = await request(harness.handle, "/v1/chat", {
      body: {
        requestId: "chat-test-0000",
        model: "account-model",
        input: [{ role: "user", content: "Hi" }],
      },
    });
    expect(unauthenticated.status).toBe(401);
    const unverified = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-test-0000",
        model: "account-model",
        input: [{ role: "user", content: "Hi" }],
      },
    });
    expect(unverified.status).toBe(403);
    expect(harness.responsesCallCount).toBe(0);
    const smoke = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(smoke.status).toBe(200);

    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const userItem = { role: "user", content: "Create a home frame." };
    const first = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-test-0001",
        model: "account-model",
        input: [userItem],
        lifecycle: "EXECUTING_STAGE",
      },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-fad-request-id")).toBe("chat-test-0001");
    const firstEvents = await first.text();
    expect(firstEvents).toContain("event: tool_calls");
    const toolFrame = firstEvents
      .split(/\r?\n\r?\n/u)
      .find((frame) => frame.includes("event: tool_calls"));
    const toolEvent = toolFrame
      ?.split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    expect(JSON.parse(toolEvent ?? "{}")).toMatchObject({
      requestId: "chat-test-0001",
      calls: [{ callId: "call_frame_123456", action: { tool: "create_frame", ref: "home" } }],
      functionCallItems: [call],
    });

    const toolOutput = {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify({ success: true, logicalRef: "home" }),
    };
    const second = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-test-0002",
        model: "account-model",
        input: [userItem, call, toolOutput],
        lifecycle: "EXECUTING_STAGE",
      },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Your frame is ready.");
    const diagnosticRecords = diagnostics.mock.calls
      .filter(([label]) => label === "[FAD_CHAT_DIAGNOSTIC]")
      .map(([, value]) => JSON.parse(String(value)) as Record<string, unknown>);
    expect(diagnosticRecords).toHaveLength(2);
    expect(diagnosticRecords[0]).toMatchObject({
      requestId: "chat-test-0001",
      httpStatus: 200,
      responseStatus: "completed",
      outputItemTypes: ["function_call"],
      functionCallCount: 1,
      continuationState: "initial",
      chatState: "tool_calls",
    });
    expect(diagnosticRecords[1]).toMatchObject({
      requestId: "chat-test-0002",
      continuationState: "continuation",
      chatState: "text",
    });
    expect(JSON.stringify(diagnosticRecords)).not.toContain("Home");
    expect(JSON.stringify(diagnosticRecords)).not.toContain("arguments");
    const sent = JSON.parse(harness.responsesRequest!.body) as {
      input: unknown[];
      tools: Array<{
        name: string;
        parameters?: {
          properties?: Record<string, Record<string, unknown>>;
        };
      }>;
      store: boolean;
      parallel_tool_calls: boolean;
    };
    expect(sent).toMatchObject({
      store: false,
      input: [userItem, call, toolOutput],
    });
    expect(sent.tools.map(({ name }) => name)).toContain("create_frame");
    expect(sent.tools.map(({ name }) => name)).not.toContain("delete_node");
    const inspectTool = sent.tools.find(({ name }) => name === "inspect_nodes");
    expect(inspectTool?.parameters?.properties?.maxNodes).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 25,
      default: 25,
    });
    expect(inspectTool?.parameters?.properties?.depth).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 4,
      default: 2,
    });
    expect(sent.parallel_tool_calls).toBe(true);
  }, 20_000);

  it("sends the bounded inspect_nodes schema to authenticated Responses and clamps safe numeric overflow locally", async () => {
    const call = {
      type: "function_call",
      call_id: "inspect_bounds_001",
      name: "inspect_nodes",
      arguments: JSON.stringify({
        refs: ["store"],
        selection: false,
        maxNodes: 999,
        depth: -8,
      }),
    };
    const harness = await createHarness({ chatResponses: [{ outputItems: [call] }] });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const response = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "inspect-contract-0001",
        model: "account-model",
        input: [{ role: "user", content: "Inspect the saved storefront." }],
      },
    });
    expect(response.status).toBe(200);
    const events = await response.text();
    const payload = events
      .split(/\r?\n\r?\n/u)
      .find((frame) => frame.includes("event: tool_calls"))
      ?.split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    expect(JSON.parse(payload ?? "{}")).toMatchObject({
      calls: [
        {
          normalizedInspectionParameters: true,
          action: { tool: "inspect_nodes", refs: ["store"], maxNodes: 25, depth: 0 },
        },
      ],
      functionCallItems: [call],
    });
    const requestBody = JSON.parse(harness.responsesRequest!.body) as {
      tools: Array<{
        name: string;
        parameters: { properties: Record<string, Record<string, unknown>> };
      }>;
    };
    const inspectTool = requestBody.tools.find(({ name }) => name === "inspect_nodes");
    expect(inspectTool?.parameters.properties.maxNodes).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 25,
      default: 25,
    });
    expect(inspectTool?.parameters.properties.depth).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 4,
      default: 2,
    });
  }, 20_000);

  it("stops, resumes, inspects between three stages, and retries without duplicating 31 committed nodes", async () => {
    let sequence = 0;
    const call = (name: string, args: unknown) => ({
      type: "function_call",
      call_id: `three_stage_${String(++sequence).padStart(4, "0")}`,
      name,
      arguments: JSON.stringify(args),
    });
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "Minimal",
      audience: "Shoppers",
      content: ["Shell", "Details", "Finish"],
      hierarchy: "Shell then details",
      typography: { family: "Arial", style: "Regular", headingSize: 28, bodySize: 14 },
      spacingScale: [8, 16],
      radiusScale: [8, 16],
      palette: {
        source: "curated-default",
        background: "#FFFFFF",
        surface: "#FFFFFF",
        primary: "#222222",
        accent: "#AA3366",
        text: "#222222",
        muted: "#555555",
      },
      imagePolicy: "labeled-native-fallback",
      interactionPriorities: ["Details"],
      readingDirection: "LTR",
    };
    const stages = [
      {
        title: "Stage one shell",
        goal: "Build the committed shell",
        logicalRefs: ["stage1-0"],
        completionCriteria: ["The shell frame exists"],
      },
      {
        title: "Stage two details",
        goal: "Inspect the shell then add details",
        logicalRefs: ["stage2-card"],
        completionCriteria: ["The details frame exists"],
      },
      {
        title: "Stage three finish",
        goal: "Add the finishing frame",
        logicalRefs: ["stage3-card"],
        completionCriteria: ["The finishing frame exists"],
      },
    ];
    const plan = call("plan_canvas_task", { brief, stages });
    const duplicatePlan = call("plan_canvas_task", { brief, stages });
    const stageOneCalls = Array.from({ length: 31 }, (_, index) =>
      call("create_frame", {
        ref: `stage1-${index}`,
        name: `Stage one frame ${index}`,
        parent: { kind: "page" },
        size: { width: 60, height: 48 },
      }),
    );
    const modelResponses: Array<{ text?: string; outputItems?: unknown[] }> = [
      { outputItems: [call("get_document_context", {})] },
      { outputItems: [plan] },
      { outputItems: [duplicatePlan] },
      ...[0, 10, 20].map((offset) => ({ outputItems: stageOneCalls.slice(offset, offset + 10) })),
      { outputItems: stageOneCalls.slice(30) },
    ];
    const harness = await createHarness({
      chatResponder: () => {
        const next = modelResponses.shift();
        if (!next) throw new Error("No scripted three-stage response remains.");
        return next;
      },
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });

    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const taskId = "three-stage-task-01";
    const documentId = "file-test-56-page_current";
    let task = ChatTaskSchema.parse({
      version: 1,
      id: taskId,
      intent: "create",
      referenceScope: "task-v1",
      documentId,
      prompt: "Create a three-stage editable mobile layout.",
      context: [],
      stages: [],
      ledger: [],
      pending: [],
      recent: [],
      starts: [],
      rounds: 0,
      status: "ready",
      text: "",
    });
    const fetcher: typeof fetch = (url, options) =>
      fetch(`http://localhost:${harness.handle.port}${new URL(String(url)).pathname}`, {
        ...options,
        headers: { ...Object.fromEntries(new Headers(options?.headers)), Origin: "null" },
      });
    let requestNumber = 0;
    let batchNumber = 0;
    let saveNumber = 0;
    let virtualNow = Date.now();
    let committedStageOneCreates = 0;
    let stopAfter31 = true;
    let failStageThreeOnce = true;
    const dependencies = (controller: AbortController) => ({
      signal: controller.signal,
      progress: () => {},
      model: (
        input: Parameters<typeof streamAuthorizedChat>[3],
        lifecycle: Parameters<typeof streamAuthorizedChat>[4],
      ) =>
        streamAuthorizedChat(
          token,
          `three-stage-request-${++requestNumber}`,
          "account-model",
          input,
          lifecycle,
          fetcher,
          controller.signal,
        ),
      now: () => virtualNow,
      wait: async (duration: number) => {
        virtualNow += duration;
      },
      save: async (checkpoint: typeof task) => {
        const saved = await handleChatTaskStorage(mock.api, {
          type: "chat-task-save",
          requestId: `three-stage-save-${++saveNumber}`,
          documentId: checkpoint.documentId,
          task: checkpoint,
        });
        expect(saved.success).toBe(true);
      },
      execute: async (operations: Parameters<Parameters<typeof runChatTask>[1]["execute"]>[0]) => {
        const batchId = `three-stage-batch-${++batchNumber}`;
        const rejected = operations.find(
          (operation) =>
            failStageThreeOnce &&
            operation.action.tool === "create_frame" &&
            operation.action.name === "Stage three card",
        );
        if (rejected) {
          failStageThreeOnce = false;
          return {
            type: "tool-result",
            protocolVersion: 1,
            batchId,
            success: false,
            cancelled: false,
            committedOperationIds: [],
            partialOperationIds: [],
            results: operations.map((operation) => ({
              operationId: operation.operationId,
              success: false,
              replayed: false,
              acknowledgementStatus:
                operation.operationId === rejected.operationId ? "rejected" : "not_attempted",
              error:
                operation.operationId === rejected.operationId
                  ? "Simulated pre-commit stage-three write rejection."
                  : "Not attempted after the rejected operation.",
            })),
          } satisfies Extract<PluginToUIMessage, { type: "tool-result" }>;
        }
        const dispatch = UIToPluginSchema.parse(
          JSON.parse(
            JSON.stringify({ type: "tool-execute", protocolVersion: 1, batchId, operations }),
          ),
        );
        if (dispatch.type !== "tool-execute") throw new Error("Invalid tool dispatch");
        await executor(dispatch);
        const response = [...messages]
          .reverse()
          .find((message) => message.type === "tool-result" && message.batchId === batchId);
        if (!response || response.type !== "tool-result") throw new Error("Missing tool result");
        const result = PluginToUISchema.parse(JSON.parse(JSON.stringify(response))) as Extract<
          PluginToUIMessage,
          { type: "tool-result" }
        >;
        if (stopAfter31) {
          committedStageOneCreates += result.committedOperationIds.filter((id) =>
            operations.some(
              (operation) =>
                operation.operationId === id &&
                operation.action.tool === "create_frame" &&
                operation.action.name.startsWith("Stage one frame "),
            ),
          ).length;
          if (committedStageOneCreates === 31) {
            stopAfter31 = false;
            controller.abort();
          }
        }
        return result;
      },
    });

    const stopController = new AbortController();
    await expect(runChatTask(task, dependencies(stopController))).rejects.toThrow("Stopped");
    expect(task.status).toBe("stopped");
    expect(chatTaskCommittedOperationCount(task)).toBe(31);
    expect(mock.nodes).toHaveLength(31);
    const committedNodeIds = mock.nodes.map((node) => node.id);
    expect(modelResponses).toHaveLength(0);
    expect(task.validationCorrections).toBe(0);
    expect(task.roundBreakdown.planning).toBe(2);
    const stateAwareRequests = harness.responsesRequests.map(({ body }) => JSON.parse(body));
    expect(
      stateAwareRequests.some(
        ({ instructions, tools }) =>
          String(instructions).includes("Current lifecycle state: PLAN_SAVED") &&
          Array.isArray(tools) &&
          !tools.some((tool) => tool.name === "plan_canvas_task") &&
          tools.some((tool) => tool.name === "create_frame"),
      ),
    ).toBe(true);

    const stoppedCheckpoint = await handleChatTaskStorage(mock.api, {
      type: "chat-task-load",
      requestId: "three-stage-load-stopped",
    });
    task = ChatTaskSchema.parse(stoppedCheckpoint.task);
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    modelResponses.push(
      { outputItems: [call("complete_canvas_stage", { summary: "Shell committed" })] },
      {
        outputItems: [
          call("inspect_nodes", {
            refs: ["stage1-0"],
            selection: false,
            maxNodes: 999,
            depth: 99,
          }),
        ],
      },
      {
        outputItems: [
          call("create_frame", {
            ref: "stage2-card",
            name: "Stage two card",
            parent: { kind: "page" },
            size: { width: 120, height: 80 },
          }),
        ],
      },
      { outputItems: [call("complete_canvas_stage", { summary: "Details committed" })] },
      {
        outputItems: [
          call("create_frame", {
            ref: "stage3-card",
            name: "Stage three card",
            parent: { kind: "page" },
            size: { width: 120, height: 80 },
          }),
        ],
      },
    );
    await expect(runChatTask(task, dependencies(new AbortController()))).rejects.toThrow(
      "Simulated pre-commit stage-three write rejection.",
    );
    expect(task.status).toBe("failed");
    expect(task.stages.map((stage) => stage.completed)).toEqual([true, true, false]);
    expect(chatTaskCommittedOperationCount(task)).toBe(32);
    expect(mock.nodes.filter((node) => node.name.startsWith("Stage one frame "))).toHaveLength(31);
    expect(
      mock.nodes.map((node) => node.id).filter((id) => committedNodeIds.includes(id)),
    ).toHaveLength(31);
    const normalizedInspection = task.ledger.find(
      (entry) => entry.call.action.tool === "inspect_nodes" && entry.stage === 1,
    );
    expect(normalizedInspection?.call).toMatchObject({
      normalizedInspectionParameters: true,
      action: { maxNodes: 25, depth: 4 },
    });
    expect(task.validationCorrections).toBe(0);

    const failedCheckpoint = await handleChatTaskStorage(mock.api, {
      type: "chat-task-load",
      requestId: "three-stage-load-failed",
    });
    task = ChatTaskSchema.parse(failedCheckpoint.task);
    executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const failedOperationId = task.ledger.find((entry) => entry.status === "failed")!.operationId;
    modelResponses.push(
      {
        outputItems: [
          call("create_frame", {
            ref: "stage3-card",
            name: "Stage three card",
            parent: { kind: "page" },
            size: { width: 120, height: 80 },
          }),
        ],
      },
      {
        outputItems: [
          call("complete_canvas_stage", {
            summary: "Stage three repaired",
            resolvedOperationIds: [failedOperationId],
          }),
        ],
      },
      { text: "All three stages completed.", outputItems: [] },
    );
    await runChatTask(task, dependencies(new AbortController()));
    expect(task.status).toBe("completed");
    expect(task.stages.every((stage) => stage.completed)).toBe(true);
    expect(chatTaskCommittedOperationCount(task)).toBe(33);
    expect(mock.nodes).toHaveLength(33);
    expect(mock.nodes.filter((node) => node.name.startsWith("Stage one frame "))).toHaveLength(31);
    expect(mock.nodes.filter((node) => node.name === "Stage two card")).toHaveLength(1);
    expect(mock.nodes.filter((node) => node.name === "Stage three card")).toHaveLength(1);
    expect(committedNodeIds.every((id) => mock.nodes.some((node) => node.id === id))).toBe(true);
    expect(new Set(mock.nodes.map((node) => node.id)).size).toBe(33);
    expect(task.validationCorrections).toBe(0);
  }, 30_000);

  it("continues multiple Persian design calls across rounds until it returns user-facing text", async () => {
    const frameCall = {
      type: "function_call",
      call_id: "call_frame_123456",
      name: "create_frame",
      arguments: JSON.stringify({
        ref: "storefront",
        name: "خانه فروشگاه",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
    };
    const textCall = {
      type: "function_call",
      call_id: "call_title_123456",
      name: "create_text",
      arguments: JSON.stringify({
        ref: "title",
        name: "عنوان",
        parent: { kind: "node", ref: "storefront" },
        text: "فروشگاه شما",
        size: { width: 342, height: 40 },
        direction: "RTL",
        align: "RIGHT",
      }),
    };
    const colorCall = {
      type: "function_call",
      call_id: "call_color_123456",
      name: "set_properties",
      arguments: JSON.stringify({ ref: "title", properties: { color: "#6841D8" } }),
    };
    const harness = await createHarness({
      chatResponses: [
        { outputItems: [frameCall, textCall] },
        { outputItems: [colorCall] },
        { text: "صفحهٔ فروشگاه آماده است.", outputItems: [] },
      ],
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const user = { role: "user", content: "salam, yek safhe baraye home shop tarahi kon" };
    const first = await request(harness.handle, "/v1/chat", {
      token,
      body: { requestId: "chat-round-0001", model: "account-model", input: [user] },
    });
    const firstEvents = await first.text();
    expect(firstEvents).toContain('"callId":"call_frame_123456"');
    expect(firstEvents).toContain('"callId":"call_title_123456"');
    const firstRequest = JSON.parse(harness.responsesRequest!.body) as { input: unknown[] };
    expect(firstRequest.input).toEqual([user]);

    const outputs = [
      {
        type: "function_call_output",
        call_id: frameCall.call_id,
        output: JSON.stringify({ success: true, logicalRef: "storefront" }),
      },
      {
        type: "function_call_output",
        call_id: textCall.call_id,
        output: JSON.stringify({ success: true, logicalRef: "title" }),
      },
    ];
    const secondInput = [user, frameCall, textCall, ...outputs];
    const second = await request(harness.handle, "/v1/chat", {
      token,
      body: { requestId: "chat-round-0002", model: "account-model", input: secondInput },
    });
    expect(await second.text()).toContain('"callId":"call_color_123456"');
    expect(JSON.parse(harness.responsesRequest!.body).input).toEqual(secondInput);

    const finalInput = [
      ...secondInput,
      colorCall,
      {
        type: "function_call_output",
        call_id: colorCall.call_id,
        output: JSON.stringify({ success: true, logicalRef: "title" }),
      },
    ];
    const final = await request(harness.handle, "/v1/chat", {
      token,
      body: { requestId: "chat-round-0003", model: "account-model", input: finalInput },
    });
    expect(await final.text()).toContain("صفحهٔ فروشگاه آماده است.");
    expect(JSON.parse(harness.responsesRequest!.body).input).toEqual(finalInput);
  }, 20_000);

  it("serves INSPECTING through HTTP/SSE with only read-only tools and distinct availability/schema failures", async () => {
    const call = (name: string, args: unknown) => ({
      type: "function_call",
      call_id: "readonly_http_call",
      name,
      arguments: JSON.stringify(args),
    });
    const harness = await createHarness({
      chatResponses: [
        { outputItems: [call("get_document_context", { query: "Charm", offset: 8 })] },
        { outputItems: [call("classify_canvas_intent", { intent: "inspect" })] },
        { outputItems: [call("inspect_nodes", { refs: ["charm-home"], maxNodes: "wrong" })] },
        {
          outputItems: [
            call("plan_canvas_task", {
              brief: {
                platform: "mobile",
                viewport: { width: 390, height: 844 },
                brandDirection: "Charm",
                audience: "Shoppers",
                content: ["Home"],
                hierarchy: "Heading first",
                typography: { family: "Arial", style: "Regular", headingSize: 28, bodySize: 14 },
                spacingScale: [8, 16],
                radiusScale: [8, 16],
                palette: {
                  source: "curated-default",
                  background: "#FFFFFF",
                  surface: "#FFFFFF",
                  primary: "#222222",
                  accent: "#AA3366",
                  text: "#222222",
                  muted: "#555555",
                },
                imagePolicy: "labeled-native-fallback",
                interactionPriorities: ["Home"],
                readingDirection: "RTL",
              },
              stages: [
                {
                  title: "Unwanted plan",
                  goal: "Create an unwanted frame",
                  logicalRefs: ["charm-home"],
                  completionCriteria: ["Frame exists"],
                },
              ],
            }),
          ],
        },
        { text: "Verified existing Charm frames; no mutations.", outputItems: [] },
      ],
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const send = (index: number) =>
      request(harness.handle, "/v1/chat", {
        token,
        body: {
          requestId: `readonly-http-${index}`,
          model: "account-model",
          lifecycle: "INSPECTING",
          input: [
            {
              role: "user",
              content: "Find and inspect all existing Charm frames; no selection or changes.",
            },
          ],
        },
      });
    const discovery = await send(1);
    expect(await discovery.text()).toContain('"name":"get_document_context"');
    const upstream = JSON.parse(harness.responsesRequest!.body);
    expect(upstream.tools.map(({ name }: { name: string }) => name)).toEqual([
      "get_document_context",
      "inspect_nodes",
    ]);
    expect(upstream.instructions).toContain("no mutation plan is needed or allowed");
    expect(await (await send(2)).text()).toContain("tool_not_available_for_state");
    const schema = await (await send(3)).text();
    expect(schema).toContain("tool_validation");
    expect(schema).toContain("invalid_type");
    expect(schema).not.toContain("tool_not_available_for_state");
    expect(await (await send(4)).text()).toContain("tool_not_available_for_state");
    const completed = await send(5);
    expect(await completed.text()).toContain("Verified existing Charm frames");
  });

  it("uses completed message text, displays refusals, and reports truly empty completed output", async () => {
    const messageCases = [
      {
        chatResponses: [
          {
            outputItems: [{ type: "message", content: [{ type: "output_text", text: "Ready." }] }],
          },
        ],
        expected: "Ready.",
      },
      {
        chatResponses: [
          {
            outputItems: [
              { type: "message", content: [{ type: "refusal", refusal: "I can’t do that." }] },
            ],
          },
        ],
        expected: "I can’t do that.",
      },
    ];
    for (const [index, testCase] of messageCases.entries()) {
      const harness = await createHarness(testCase);
      const token = await authorizeAndDiscover(harness);
      await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
      const response = await request(harness.handle, "/v1/chat", {
        token,
        body: {
          requestId: `chat-content-${index}01`,
          model: "account-model",
          input: [{ role: "user", content: "Reply." }],
        },
      });
      expect(await response.text()).toContain(testCase.expected);
    }

    const emptyHarness = await createHarness({ chatResponses: [{ outputItems: [] }] });
    const token = await authorizeAndDiscover(emptyHarness);
    await request(emptyHarness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const empty = await request(emptyHarness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-empty-0001",
        model: "account-model",
        input: [{ role: "user", content: "Make a shop page." }],
      },
    });
    expect(await empty.text()).toMatch(/event: error[\s\S]*empty_response/u);
  }, 20_000);

  it("reports token-budget exhaustion and rejects malformed function arguments without echoing them", async () => {
    const incompleteHarness = await createHarness({
      chatResponses: [{ incompleteReason: "max_output_tokens" }],
    });
    const incompleteToken = await authorizeAndDiscover(incompleteHarness);
    await request(incompleteHarness.handle, "/v1/smoke", {
      token: incompleteToken,
      body: { model: "account-model" },
    });
    const incomplete = await request(incompleteHarness.handle, "/v1/chat", {
      token: incompleteToken,
      body: {
        requestId: "chat-incomplete-01",
        model: "account-model",
        input: [{ role: "user", content: "Create a storefront." }],
      },
    });
    const incompleteBody = await incomplete.text();
    expect(incompleteBody).toContain("max_output_tokens");
    expect(incompleteBody).toContain('"responseStatus":"incomplete"');
    expect(incompleteBody).toContain('"functionCallCount":0');

    const malformed = {
      type: "function_call",
      call_id: "call_badargs_123",
      name: "create_rectangle",
      arguments: JSON.stringify({
        ref: "card",
        name: "Card",
        parent: { kind: "page" },
        size: { width: 300, height: 200 },
        fill: "rgba(1, 2, 3, 1)",
        private: "must not be echoed",
      }),
    };
    const validSibling = {
      type: "function_call",
      call_id: "call_valid_12345",
      name: "create_frame",
      arguments: JSON.stringify({
        ref: "another-card",
        name: "Another card",
        parent: { kind: "page" },
        size: { width: 300, height: 200 },
      }),
    };
    const malformedHarness = await createHarness({
      chatResponses: [{ outputItems: [validSibling, malformed] }],
    });
    const malformedToken = await authorizeAndDiscover(malformedHarness);
    await request(malformedHarness.handle, "/v1/smoke", {
      token: malformedToken,
      body: { model: "account-model" },
    });
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const rejected = await request(malformedHarness.handle, "/v1/chat", {
      token: malformedToken,
      body: {
        requestId: "chat-malformed-01",
        model: "account-model",
        input: [{ role: "user", content: "Create a storefront." }],
      },
    });
    const safeError = await rejected.text();
    expect(safeError).toContain("event: tool_validation");
    expect(safeError).not.toContain("event: tool_calls");
    expect(safeError).toContain('"toolName":"create_rectangle"');
    expect(safeError).toContain('"callId":"call_badargs_123"');
    expect(safeError).toContain('"fieldPaths":["arguments.fill"]');
    expect(safeError).toContain('"fieldPaths":["arguments.private"]');
    expect(safeError).not.toContain("must not be echoed");
    expect(safeError).not.toContain(malformed.arguments);
    const log = String(diagnostics.mock.calls[0]?.[1]);
    expect(log).toContain('"errorCode":"invalid_format"');
    expect(log).toContain('"stage":"arguments_schema"');
    expect(log).toContain('"fieldPaths":["arguments.fill"]');
    expect(log).not.toContain("rgba(");
    expect(log).not.toContain("must not be echoed");
  }, 20_000);

  it("rejects an oversized Responses call set before emitting any dispatchable calls", async () => {
    const outputItems = Array.from({ length: 11 }, (_, index) => ({
      type: "function_call",
      call_id: `call_overflow_${String(index).padStart(3, "0")}`,
      name: "get_document_context",
      arguments: "{}",
    }));
    const harness = await createHarness({ chatResponses: [{ outputItems }] });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    const rejected = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-callset-overflow-01",
        model: "account-model",
        input: [{ role: "user", content: "Create a storefront." }],
        lifecycle: "UNPLANNED",
      },
    });
    const event = await rejected.text();
    expect(event).toContain("event: tool_validation");
    expect(event).toContain('"stage":"call_set"');
    expect(event).toContain('"errorCode":"too_many_calls"');
    expect(event).toContain('"fieldPaths":["calls"]');
    expect(event).not.toContain("event: tool_calls");
    expect(event).not.toContain('"name":"get_document_context"');
  }, 20_000);

  it("rejects a nested call_set wrapper before its embedded mutation reaches the client", async () => {
    const harness = await createHarness({
      chatResponses: [
        {
          outputItems: [
            {
              type: "call_set",
              calls: [
                {
                  type: "function_call",
                  call_id: "embedded_call_01",
                  name: "create_frame",
                  arguments: JSON.stringify({
                    ref: "must-not-execute",
                    name: "Wrapped call",
                    parent: { kind: "page" },
                    size: { width: 100, height: 100 },
                  }),
                },
              ],
            },
          ],
        },
      ],
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    const rejected = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-invalid-wrapper-01",
        model: "account-model",
        input: [{ role: "user", content: "Create a storefront." }],
        lifecycle: "UNPLANNED",
      },
    });
    const event = await rejected.text();
    expect(event).toContain("event: tool_validation");
    expect(event).toContain('"errorCode":"unsupported_wrapper"');
    expect(event).not.toContain("event: tool_calls");
    expect(event).not.toContain("must-not-execute");
  }, 20_000);

  it("aborts the upstream Responses stream when the chat client stops", async () => {
    const harness = await createHarness();
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);
    harness.stallNextResponse();
    const controller = new AbortController();
    const pending = request(harness.handle, "/v1/chat", {
      token,
      signal: controller.signal,
      body: {
        requestId: "chat-cancel-0001",
        model: "account-model",
        input: [{ role: "user", content: "Create a frame." }],
      },
    });
    await harness.waitForResponseStream();
    await harness.waitForResponseStream();
    const duplicate = await request(harness.handle, "/v1/chat", {
      token,
      body: {
        requestId: "chat-cancel-0002",
        model: "account-model",
        input: [{ role: "user", content: "Create another frame." }],
      },
    });
    expect(duplicate.status).toBe(409);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(harness.wasResponseStreamCancelled()).toBe(true));
    await vi.waitFor(() =>
      expect(
        diagnostics.mock.calls.some(
          ([, line]) =>
            String(line).includes('"requestId":"chat-cancel-0001"') &&
            String(line).includes('"terminationReason":"user_cancelled"'),
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("protects durable checkpoints behind pairing and restores them after companion restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fad-route-draft-test-"));
    try {
      const harness = await createHarness({ draftStore: createDraftStore(directory) });
      const { manifest, design } = draftFixture();
      const denied = await request(harness.handle, "/v1/draft", {
        body: { action: "load", documentId: manifest.documentId },
      });
      expect(denied.status).toBe(401);
      let token = await authorizeAndDiscover(harness);
      const started = await request(harness.handle, "/v1/draft", {
        token,
        body: { action: "start", documentId: manifest.documentId, manifest },
      });
      expect(started.status).toBe(200);
      const saved = await request(harness.handle, "/v1/draft", {
        token,
        body: {
          action: "save-screen",
          documentId: manifest.documentId,
          generationId: manifest.generationId,
          design,
        },
      });
      expect(saved.status).toBe(200);
      const restarted = await harness.restart();
      token = await harness.pair();
      const loaded = await request(restarted, "/v1/draft", {
        token,
        body: { action: "load", documentId: manifest.documentId },
      });
      expect(loaded.status).toBe(200);
      const recovered = await loaded.json();
      expect(recovered.draft.screens).toHaveLength(1);
      expect(recovered.draft.screens[0].design).toEqual(design);
      expect(JSON.stringify(recovered)).not.toContain("access-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
    const pairingResult = (await paired.json()) as {
      status: string;
      sessionToken: string;
      restoreTicket: string;
    };
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
    expect(
      (
        await request(harness.handle, "/v1/pairing/restore", {
          body: { ticket: pairingResult.restoreTicket },
        })
      ).status,
    ).toBe(403);
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

  it("restores an explicitly approved plugin session after UI and companion restarts", async () => {
    const harness = await createHarness();
    const paired = await harness.pairWithTicket();
    expect(paired.restoreTicket).toMatch(/^FADP1T:/u);
    expect(
      (await request(harness.handle, "/v1/status", { token: paired.sessionToken })).status,
    ).toBe(200);

    const restartedHandle = await harness.restart();
    expect(
      (await request(restartedHandle, "/v1/status", { token: paired.sessionToken })).status,
    ).toBe(401);
    const restored = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    expect(restored.status).toBe(200);
    const restoredToken = (await restored.json()) as { sessionToken: string };
    expect(
      (await request(restartedHandle, "/v1/status", { token: restoredToken.sessionToken })).status,
    ).toBe(200);
    expect(
      (
        await request(restartedHandle, "/v1/pairing/restore", {
          body: { ticket: "FADP1T:" + "A".repeat(64) },
        })
      ).status,
    ).toBe(403);
  });

  it("restores OAuth after companion restart and rotates the refresh token using the issued client", async () => {
    const harness = await createHarness({ expiresIn: 2, refresh: true });
    const paired = await harness.pairWithTicket();
    await request(harness.handle, "/v1/auth/start", { token: paired.sessionToken, body: {} });
    await completeLogin(harness);
    expect(harness.storeSnapshot()).not.toContain("access-secret");

    harness.advanceTime(5_000);
    const restartedHandle = await harness.restart();
    expect(harness.refreshRequest).toContain("grant_type=refresh_token");
    expect(harness.refreshRequest).toContain("client_id=issued-public-client");
    expect(harness.refreshRequest).toContain("resource=https%3A%2F%2Fapi.openai.com%2Fv1");
    const restored = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    const restoredToken = (await restored.json()) as { sessionToken: string };
    const status = await request(restartedHandle, "/v1/status", {
      token: restoredToken.sessionToken,
    });
    expect(await status.json()).toMatchObject({ auth: "scope_granted", planUseAuthorized: true });
    expect(
      (
        await request(restartedHandle, "/v1/models", {
          token: restoredToken.sessionToken,
          body: {},
        })
      ).status,
    ).toBe(200);
  });

  it("restores a valid saved OAuth session after a companion restart without another browser prompt", async () => {
    const harness = await createHarness({ refresh: true });
    const paired = await harness.pairWithTicket();
    await request(harness.handle, "/v1/auth/start", { token: paired.sessionToken, body: {} });
    await completeLogin(harness);
    const initialSession = (await (
      await request(harness.handle, "/v1/status", {
        token: paired.sessionToken,
      })
    ).json()) as { sessionId: string; accountScope: string };
    const authorizationUrl = harness.openedUrl;
    await request(harness.handle, "/v1/models", { token: paired.sessionToken, body: {} });
    const smoke = await request(harness.handle, "/v1/smoke", {
      token: paired.sessionToken,
      body: { model: "account-model" },
    });
    expect(await smoke.json()).toMatchObject({
      status: { inferenceVerifiedModel: "account-model" },
    });
    expect(harness.storeSnapshot()).not.toContain("sessionId");
    expect(harness.storeSnapshot()).not.toContain("inferenceVerifiedModel");

    const restartedHandle = await harness.restart();
    const restored = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    const restoredToken = ((await restored.json()) as { sessionToken: string }).sessionToken;
    const status = await request(restartedHandle, "/v1/status", { token: restoredToken });
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ auth: "scope_granted", planUseAuthorized: true });
    expect(statusBody).not.toHaveProperty("inferenceVerifiedModel");
    expect(statusBody.sessionId).not.toBe(initialSession.sessionId);
    expect(statusBody.accountScope).toMatch(/^[a-f0-9]{64}$/u);
    expect(statusBody.accountScope).toBe(initialSession.accountScope);
    expect(harness.openedUrl).toBe(authorizationUrl);
    expect(harness.refreshRequest).toBeUndefined();
  });

  it("keeps the local pairing when ChatGPT is disconnected and clears it only on account switch", async () => {
    const harness = await createHarness();
    const originalHostId = (await harness.store.load()).extAgentHostId;
    const paired = await harness.pairWithTicket();
    await request(harness.handle, "/v1/auth/start", { token: paired.sessionToken, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/disconnect", { token: paired.sessionToken, body: {} });

    let restartedHandle = await harness.restart();
    const localRestore = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    expect(localRestore.status).toBe(200);
    const restoredToken = ((await localRestore.json()) as { sessionToken: string }).sessionToken;
    expect(
      await (await request(restartedHandle, "/v1/status", { token: restoredToken })).json(),
    ).toMatchObject({
      auth: "signed_out",
    });

    await request(restartedHandle, "/v1/auth/start", { token: restoredToken, body: {} });
    await completeLogin(harness);
    const switched = await request(restartedHandle, "/v1/account/switch", {
      token: restoredToken,
      body: {},
    });
    expect(await switched.json()).toMatchObject({ registrationForgotten: true });
    expect((await harness.store.load()).clientId).toBeUndefined();
    expect((await harness.store.load()).extAgentHostId).toBe(originalHostId);

    restartedHandle = await harness.restart();
    const afterSwitch = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    expect(afterSwitch.status).toBe(200);
    const tokenAfterSwitch = ((await afterSwitch.json()) as { sessionToken: string }).sessionToken;
    expect(
      await (await request(restartedHandle, "/v1/status", { token: tokenAfterSwitch })).json(),
    ).toMatchObject({
      auth: "signed_out",
    });
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
      text: "Authenticated Responses function calling passed.",
      status: { auth: "ready", inferenceVerifiedModel: "account-model" },
    });
    const liveStatus = await request(harness.handle, "/v1/status", { token });
    expect(await liveStatus.json()).toMatchObject({
      auth: "ready",
      planUseAuthorized: true,
      inferenceVerifiedModel: "account-model",
    });
    const sent = harness.responsesRequest as { body: string; headers: HeadersInit };
    const payload = JSON.parse(sent.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      input: [{ role: "user", content: "Call get_document_context with no arguments." }],
      tool_choice: { type: "function", name: "get_document_context" },
      store: false,
      stream: true,
    });
    expect((payload.tools as Array<{ name: string }>).map(({ name }) => name)).toEqual([
      "get_document_context",
    ]);
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload.model).toBe("account-model");
    expect(new Headers(sent.headers).get("authorization")).toBe("Bearer access-secret");
  });

  it("parses completed SSE events when CRLF delimiters and JSON are split across chunks and binds the exact selected model", async () => {
    const harness = await createHarness({
      accountModel: "gpt-5.6-luna",
      responseChunks: [
        "event: response.output_text.delta\r",
        '\ndata: {"type":"response.output_text.delta","delta":"O"}\r',
        "\n\r",
        '\ndata: {"type":"response.output_text.delta","delta":"K"}\r\n\r\n',
        `event: response.output_item.done\r\ndata: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "smoke_call_123456",
            name: "get_document_context",
            arguments: "{}",
          },
        })}\r\n\r\n`,
        `event: response.completed\r\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "smoke_call_123456",
                name: "get_document_context",
                arguments: "{}",
              },
            ],
          },
        })}`,
      ],
    });
    const token = await authorizeAndDiscover(harness);
    const smoke = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "gpt-5.6-luna" },
    });
    expect(smoke.status).toBe(200);
    expect(await smoke.json()).toMatchObject({
      success: true,
      completed: true,
      text: "Authenticated Responses function calling passed.",
      status: { auth: "ready", inferenceVerifiedModel: "gpt-5.6-luna" },
      diagnostic: {
        model: "gpt-5.6-luna",
        stage: "stream",
        outcome: "completed",
        terminalEvent: "response.completed",
        lastEvent: "response.completed",
        eventCount: 4,
        responseStatus: "completed",
        outputItemTypes: ["function_call"],
        outputItemCount: 1,
        functionCallCount: 1,
      },
    });
    const sent = harness.responsesRequest as { body: string };
    expect(JSON.parse(sent.body)).toMatchObject({
      model: "gpt-5.6-luna",
      input: [{ role: "user", content: "Call get_document_context with no arguments." }],
      tool_choice: { type: "function", name: "get_document_context" },
      store: false,
      stream: true,
    });
    expect(JSON.parse(sent.body).tools.map(({ name }: { name: string }) => name)).toEqual([
      "get_document_context",
    ]);
  });

  it("verifies function calling with a forced no-side-effect smoke tool", async () => {
    const call = {
      type: "function_call",
      id: "fc_123",
      call_id: "call_12345678",
      name: "get_document_context",
      arguments: "{}",
    };
    const harness = await createHarness({
      responseChunks: [
        `data: ${JSON.stringify({ type: "response.output_item.done", item: call })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [call] } })}\n\n`,
      ],
    });
    const token = await authorizeAndDiscover(harness);
    const response = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      completed: true,
      text: "Authenticated Responses function calling passed.",
    });
    expect(harness.responsesCallCount).toBe(1);
    const sent = JSON.parse((harness.responsesRequest as { body: string }).body);
    expect(sent.tool_choice).toEqual({ type: "function", name: "get_document_context" });
    expect(sent.tools).toMatchObject([{ type: "function", name: "get_document_context" }]);
    expect(sent.input).toEqual([
      { role: "user", content: "Call get_document_context with no arguments." },
    ]);
  });

  it("does not mark a model ready when its forced function-call smoke result is missing", async () => {
    const harness = await createHarness({
      responseChunks: [
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
          },
        })}\n\n`,
      ],
    });
    const token = await authorizeAndDiscover(harness);
    const response = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "unsupported_capability",
      diagnostic: { errorCode: "function_call_smoke_failed", functionCallCount: 0 },
    });
    expect(await (await request(harness.handle, "/v1/status", { token })).json()).toMatchObject({
      auth: "scope_granted",
    });
  });

  it("rejects a normally ended stream with partial output but no response.completed", async () => {
    const harness = await createHarness({
      responseChunks: [
        'data: {"type":"response.output_text.delta","delta":"partial private output"}\n\n',
      ],
    });
    const token = await authorizeAndDiscover(harness);
    const response = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "response_incomplete",
      diagnostic: {
        model: "account-model",
        stage: "stream",
        outcome: "stream_ended_without_terminal",
        lastEvent: "response.output_text.delta",
        eventCount: 1,
      },
    });
    expect(JSON.stringify(body)).not.toContain("partial private output");
    expect(await (await request(harness.handle, "/v1/status", { token })).json()).toMatchObject({
      auth: "scope_granted",
    });
  });

  it("classifies event-name-only failures and explicit incomplete events without exposing upstream text", async () => {
    const failedHarness = await createHarness({
      responseChunks: [
        'event: error\r\ndata: {"error":{"code":"subscription_sharing_unsupported_capability","param":"text.format","message":"do not expose this response text"}}\r\n\r\n',
      ],
    });
    const failedToken = await authorizeAndDiscover(failedHarness);
    const failed = await request(failedHarness.handle, "/v1/smoke", {
      token: failedToken,
      body: { model: "account-model" },
    });
    expect(failed.status).toBe(502);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({
      error: "unsupported_capability",
      diagnostic: {
        model: "account-model",
        outcome: "failed",
        lastEvent: "error",
        errorCode: "subscription_sharing_unsupported_capability",
        errorParam: "text.format",
      },
    });
    expect(JSON.stringify(failedBody)).not.toContain("do not expose this response text");

    const incompleteHarness = await createHarness({
      responseChunks: [
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      ],
    });
    const incompleteToken = await authorizeAndDiscover(incompleteHarness);
    const incomplete = await request(incompleteHarness.handle, "/v1/smoke", {
      token: incompleteToken,
      body: { model: "account-model" },
    });
    expect(incomplete.status).toBe(502);
    expect(await incomplete.json()).toMatchObject({
      error: "response_incomplete",
      diagnostic: {
        outcome: "incomplete",
        lastEvent: "response.incomplete",
        incompleteReason: "max_output_tokens",
      },
    });
  });

  it("reports a stream timeout separately and leaves the selected model unverified", async () => {
    const harness = await createHarness({
      stalledStream: true,
      requestTimeoutMs: 500,
      streamIdleTimeoutMs: 25,
      streamOverallTimeoutMs: 500,
    });
    const token = await authorizeAndDiscover(harness);
    const response = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "request_timed_out",
      diagnostic: {
        model: "account-model",
        stage: "stream",
        outcome: "timed_out",
        timeoutKind: "idle",
        elapsedMs: expect.any(Number),
        idleMs: expect.any(Number),
        eventCount: 0,
      },
    });
    expect(await (await request(harness.handle, "/v1/status", { token })).json()).toMatchObject({
      auth: "scope_granted",
    });
  });

  it.each([
    {
      kind: "idle" as const,
      idle: 25,
      overall: 1_000,
      timeoutSource: "upstream_inactivity",
      terminationReason: "upstream_inactivity",
    },
    {
      kind: "overall" as const,
      idle: 1_000,
      overall: 30,
      timeoutSource: "overall_deadline",
      terminationReason: "overall_deadline",
    },
  ])(
    "preserves the authenticated chat $kind timeout boundary through SSE and the client",
    async ({ kind, idle, overall, timeoutSource, terminationReason }) => {
      const harness = await createHarness({
        requestTimeoutMs: 1_000,
        streamIdleTimeoutMs: idle,
        streamOverallTimeoutMs: overall,
      });
      const token = await authorizeAndDiscover(harness);
      await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
      harness.stallNextResponse();
      const requestId = `chat-timeout-${kind}-01`;
      const localFetcher: typeof fetch = (url, init) =>
        fetch(`http://localhost:${harness.handle.port}${new URL(String(url)).pathname}`, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), Origin: "null" },
        });

      await expect(
        streamAuthorizedChat(
          token,
          requestId,
          "account-model",
          [{ role: "user", content: "Continue the saved Home stage." }],
          "EXECUTING_STAGE",
          localFetcher,
        ),
      ).rejects.toMatchObject({
        category: "request_timed_out",
        diagnostic: {
          requestId,
          requestPhase: "upstream_stream",
          requestStartedAtMs: expect.any(Number),
          stage: "stream",
          outcome: "timed_out",
          timeoutKind: kind,
          timeoutSource,
          terminationReason,
          elapsedMs: expect.any(Number),
          idleMs: expect.any(Number),
        },
      });
    },
  );

  it("reports an authenticated chat header timeout separately from upstream stream timeouts", async () => {
    const harness = await createHarness({ requestTimeoutMs: 25 });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    harness.stallNextChatHeaders();
    const requestId = "chat-header-timeout-01";
    const localFetcher: typeof fetch = (url, init) =>
      fetch(`http://localhost:${harness.handle.port}${new URL(String(url)).pathname}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), Origin: "null" },
      });

    await expect(
      streamAuthorizedChat(
        token,
        requestId,
        "account-model",
        [{ role: "user", content: "Continue the saved stage." }],
        "EXECUTING_STAGE",
        localFetcher,
      ),
    ).rejects.toMatchObject({
      category: "request_timed_out",
      diagnostic: {
        requestId,
        requestPhase: "upstream_headers",
        outcome: "timed_out",
        timeoutKind: "headers",
        timeoutSource: "upstream_headers",
        terminationReason: "upstream_header_timeout",
        elapsedMs: expect.any(Number),
      },
    });
  });

  it("accepts response.completed already received before a delayed SSE handler crosses the deadline", async () => {
    const startedAt = performance.now();
    const requestStartedAtMs = Date.now();
    const payload = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "valid reasoning" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output: [] },
      })}\n\n`,
    ].join("");
    const response = new Response(payload, {
      headers: { "Content-Type": "text/event-stream" },
    });

    const completed = await readCompletedResponse(
      response,
      1_000,
      startedAt + 30,
      undefined,
      "account-model",
      async () => new Promise((resolve) => setTimeout(resolve, 60)),
      startedAt,
      undefined,
      "chat-slow-terminal-01",
      requestStartedAtMs,
    );

    expect(completed.diagnostic).toMatchObject({
      requestId: "chat-slow-terminal-01",
      requestStartedAtMs,
      requestPhase: "upstream_stream",
      outcome: "completed",
      terminationReason: "response_completed",
      terminalEvent: "response.completed",
    });
    expect(completed.diagnostic.elapsedMs).toBeGreaterThan(30);
  });

  it("reports an overall stream deadline when output deltas keep arriving", async () => {
    const harness = await createHarness({
      progressingGeneratedStream: true,
      streamIdleTimeoutMs: 2_000,
      streamOverallTimeoutMs: 1_000,
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const response = await request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-active-overall-timeout",
        model: "account-model",
        request: {
          prompt: "Create a polished mobile storefront with home and cart screens.",
          target: "mobile",
          screenCount: 2,
          screenNames: ["Home", "Cart"],
          language: "en",
          style: "",
        },
      },
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "request_timed_out",
      diagnostic: {
        stage: "stream",
        outcome: "timed_out",
        timeoutKind: "overall",
        generatedBytes: expect.any(Number),
        elapsedMs: expect.any(Number),
        idleMs: expect.any(Number),
        lastDeltaAgeMs: expect.any(Number),
      },
    });
    expect(body.diagnostic.generatedBytes).toBeGreaterThan(0);
    expect(body.diagnostic.idleMs).toBeLessThan(2_000);
    expect(body.diagnostic.lastDeltaAgeMs).toBeLessThan(2_000);
  }, 20_000);

  it("identifies an overall timeout while waiting for design response headers", async () => {
    const harness = await createHarness({
      stallDesignHeaders: true,
      streamOverallTimeoutMs: 25,
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const response = await request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-header-overall-timeout",
        model: "account-model",
        request: {
          prompt: "Create a polished mobile storefront with home and cart screens.",
          target: "mobile",
          screenCount: 2,
          screenNames: ["Home", "Cart"],
          language: "en",
          style: "",
        },
      },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "request_timed_out",
      diagnostic: {
        stage: "http",
        outcome: "timed_out",
        timeoutKind: "overall",
      },
    });
  }, 20_000);

  it("retries a timed-out screen once with the same ID, then blocks duplicate generation", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fad-timeout-retry-test-"));
    const generatedOutput = JSON.stringify({
      projectName: "Timed Store",
      palette: { brand: "#223344" },
      screens: [{ id: "home", children: [] }],
    });
    const harness = await createHarness({
      generatedOutput,
      timeoutGeneratedStreams: 1,
      streamIdleTimeoutMs: 25,
      streamOverallTimeoutMs: 500,
      temporaryDirectory,
    });
    try {
      const token = await authorizeAndDiscover(harness);
      await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
      const body = {
        requestId: "req-screen-timeout-retry",
        model: "account-model",
        request: {
          prompt: "Create a polished mobile storefront with home and cart screens.",
          target: "mobile",
          screenCount: 2,
          screenNames: ["Home", "Cart"],
          language: "en",
          style: "",
        },
        screenIds: ["home"],
      };

      const incomplete = await request(harness.handle, "/v1/design", { token, body });
      expect(incomplete.status).toBe(502);
      const errorBody = await incomplete.json();
      expect(errorBody).toMatchObject({
        error: "request_timed_out",
        diagnostic: {
          outcome: "timed_out",
          timeoutKind: "idle",
          generatedBytes: Buffer.byteLength(generatedOutput),
        },
      });
      expect(JSON.stringify(errorBody)).not.toContain(generatedOutput);

      const retried = await request(harness.handle, "/v1/design", { token, body });
      expect(retried.status).toBe(200);
      expect(await retried.text()).toBe(generatedOutput);
      expect(retried.headers.get("x-fad-request-id")).toBe(body.requestId);
      const duplicate = await request(harness.handle, "/v1/design", { token, body });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: "generation_retry_limit" });
      await vi.waitFor(async () => expect(await readdir(temporaryDirectory)).toEqual([]));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("classifies documented HTTP entitlement and unsupported-capability errors by safe code and status", async () => {
    const unsupported = await createHarness({
      responsesHttpError: {
        status: 400,
        body: {
          error: {
            code: "subscription_sharing_unsupported_capability",
            param: "text.format",
            message: "private upstream detail",
          },
        },
      },
    });
    const token = await authorizeAndDiscover(unsupported);
    const response = await request(unsupported.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "unsupported_capability",
      diagnostic: {
        model: "account-model",
        stage: "http",
        outcome: "http_error",
        httpStatus: 400,
        errorCode: "subscription_sharing_unsupported_capability",
        errorParam: "text.format",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private upstream detail");

    const unavailable = await createHarness({
      responsesHttpError: {
        status: 503,
        body: { detail: "private transient routing detail" },
      },
    });
    const unavailableToken = await authorizeAndDiscover(unavailable);
    const transient = await request(unavailable.handle, "/v1/smoke", {
      token: unavailableToken,
      body: { model: "account-model" },
    });
    expect(transient.status).toBe(503);
    const transientBody = await transient.json();
    expect(transientBody).toMatchObject({
      error: "service_unavailable",
      diagnostic: {
        model: "account-model",
        stage: "http",
        outcome: "http_error",
        httpStatus: 503,
      },
    });
    expect(JSON.stringify(transientBody)).not.toContain("private transient routing detail");

    const ineligible = await createHarness({
      responsesHttpError: {
        status: 403,
        body: {
          error: {
            code: "subscription_sharing_user_not_eligible",
            message: "private policy detail",
          },
        },
      },
    });
    const ineligibleToken = await authorizeAndDiscover(ineligible);
    const denied = await request(ineligible.handle, "/v1/smoke", {
      token: ineligibleToken,
      body: { model: "account-model" },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: "account_not_eligible",
      diagnostic: { httpStatus: 403, errorCode: "subscription_sharing_user_not_eligible" },
    });

    const interrupted = await createHarness({ responsesFetchFailure: true });
    const interruptedToken = await authorizeAndDiscover(interrupted);
    const interruptedResponse = await request(interrupted.handle, "/v1/smoke", {
      token: interruptedToken,
      body: { model: "account-model" },
    });
    expect(interruptedResponse.status).toBe(502);
    const interruptedBody = await interruptedResponse.json();
    expect(interruptedBody).toMatchObject({
      error: "responses_transport_error",
      diagnostic: {
        model: "account-model",
        stage: "http",
        outcome: "transport_error",
      },
    });
    expect(JSON.stringify(interruptedBody)).not.toContain("private transport failure text");
  });

  it("requires a model-specific real smoke test before design generation and streams a strict JSON schema request", async () => {
    const design = {
      projectName: "Generated Storefront",
      palette: {
        brand: "#223344",
        accent: "#CC7744",
        page: "#F7F5F0",
        surface: "#FFFFFF",
        text: "#17212B",
        muted: "#647080",
        border: "#D8DEE6",
      },
      screens: [
        { id: "home", children: [] },
        { id: "products", children: [] },
      ],
    };
    const harness = await createHarness({ generatedOutput: JSON.stringify(design) });
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });

    const requestBody = {
      requestId: "req-design-test",
      model: "account-model",
      request: {
        prompt: "Create a polished storefront with a home and product catalog.",
        target: "mobile",
        screenCount: 2,
        language: "en",
        style: "editorial",
      },
    };
    const blocked = await request(harness.handle, "/v1/design", { token, body: requestBody });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "inference_not_verified" });
    expect(harness.responsesRequest).toBeUndefined();

    const smoke = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(smoke.status).toBe(200);
    const response = await request(harness.handle, "/v1/design", { token, body: requestBody });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(design));
    expect(response.headers.get("x-fad-request-id")).toBe("req-design-test");
    expect(response.headers.get("x-fad-model")).toBe("account-model");
    expect(response.headers.get("x-fad-completed")).toBe("response.completed");
    expect(response.headers.get("x-fad-response-bytes")).toBe(
      String(Buffer.byteLength(JSON.stringify(design))),
    );

    const sent = harness.responsesRequest as { body: string; headers: HeadersInit };
    const payload = JSON.parse(sent.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "account-model",
      input: [{ role: "user", content: expect.stringContaining("Create a polished storefront") }],
      text: { format: { type: "json_schema", name: "figma_design", strict: true } },
      store: false,
      stream: true,
    });
    expect(payload).toHaveProperty("instructions");
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(JSON.stringify(payload)).not.toContain('"role":"system"');
    expect(new Headers(sent.headers).get("authorization")).toBe("Bearer access-secret");

    const repairIssue =
      "screens.products.children[0].children[0] button is below the 44 px minimum tap target.";
    const repeated = await request(harness.handle, "/v1/design", {
      token,
      body: {
        ...requestBody,
        repairIssues: [repairIssue],
        repairTargets: [
          {
            path: "screens.products.children[0].children[0]",
            node: { type: "rectangle", qualityRole: "button", width: 20, height: 20 },
          },
        ],
      },
    });
    expect(repeated.status).toBe(200);
    await repeated.text();
    expect(JSON.parse(harness.responsesRequest!.body).instructions).toContain(repairIssue);
    const repairPayload = JSON.parse(harness.responsesRequest!.body);
    expect(repairPayload.input[0].content).not.toContain(requestBody.request.prompt);
    expect(repairPayload.text.format.schema.properties).toHaveProperty("nodes");
    expect(repairPayload.text.format.schema.properties).not.toHaveProperty("screens");
    expect(repairPayload).toMatchObject({ stream: true, store: false });
    const tooManyRepairs = await request(harness.handle, "/v1/design", {
      token,
      body: { ...requestBody, repairIssues: ["one repair was already used"] },
    });
    expect(tooManyRepairs.status).toBe(409);
    expect(await tooManyRepairs.json()).toMatchObject({ error: "generation_retry_limit" });
  });

  it("serves one bounded planned section per authorized completed Responses request", async () => {
    const design = {
      projectName: "فروشگاه فارسی",
      palette: {
        brand: "#223344",
        accent: "#CC7744",
        page: "#F7F5F0",
        surface: "#FFFFFF",
        text: "#17212B",
        muted: "#647080",
        border: "#D8DEE6",
      },
      screens: [{ id: "home", children: [] }],
    };
    const harness = await createHarness({ generatedOutput: JSON.stringify(design) });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const body = {
      requestId: "req-section-identity",
      model: "account-model",
      request: {
        prompt: "یک فروشگاه فارسی با صفحه خانه و جزئیات محصول طراحی کن.",
        target: "mobile",
        screenCount: 2,
        screenNames: ["Home", "Detail"],
        language: "fa",
        style: "",
      },
      screenIds: ["home"],
      section: { id: "identity", sequence: 0 },
    };
    const response = await request(harness.handle, "/v1/design", { token, body });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(design));
    expect(response.headers.get("x-fad-completed")).toBe("response.completed");
    const payload = JSON.parse((harness.responsesRequest as { body: string }).body);
    expect(payload).toMatchObject({ store: false, stream: true });
    expect(payload.input[0].content).toContain("section_id: identity");
    expect(payload.instructions).toContain("Section 1/3");
    expect(payload.instructions).toContain("natural Persian");
    expect(payload.text.format).toMatchObject({ type: "json_schema", strict: true });
    const completedRequest = harness.responsesRequest;

    const invalidSelector = await request(harness.handle, "/v1/design", {
      token,
      body: {
        ...body,
        requestId: "req-section-invalid-sequence",
        section: { id: "primary", sequence: 0 },
      },
    });
    expect(invalidSelector.status).toBe(400);
    expect(harness.responsesRequest).toBe(completedRequest);
  });

  it("accepts a long Persian brief for two mobile screens and explains validation failures", async () => {
    const design = {
      projectName: "فروشگاه فارسی",
      palette: {
        brand: "#223344",
        accent: "#CC7744",
        page: "#F7F5F0",
        surface: "#FFFFFF",
        text: "#17212B",
        muted: "#647080",
        border: "#D8DEE6",
      },
      screens: [{ id: "screen-1", children: [] }],
    };
    const harness = await createHarness({ generatedOutput: JSON.stringify(design) });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });

    const invalid = await request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-specific-validation",
        model: "account-model",
        request: {
          prompt: "Create a Persian storefront with two screens.",
          target: "mobile",
          screenCount: 2,
          screenNames: ["خانه"],
          language: "fa",
          style: "",
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: "invalid_design_request",
      issues: ["screenNames: Enter the same number of screen names as the selected screen count."],
    });

    const prompt = `یک فروشگاه اینترنتی فارسی برای موبایل با دو صفحه خانه و جزئیات محصول طراحی کن. ${"تجربهٔ خرید روان، متن فارسی خوانا و چیدمان راست‌چین داشته باشد. ".repeat(50)}`;
    expect(prompt.length).toBeGreaterThan(2_000);
    const accepted = await request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-persian-two-screen",
        model: "account-model",
        request: {
          prompt,
          target: "mobile",
          screenCount: 2,
          screenNames: ["خانه", "جزئیات"],
          language: "auto",
          style: "",
        },
        screenIds: ["screen-1"],
      },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe(JSON.stringify(design));
    const payload = JSON.parse((harness.responsesRequest as { body: string }).body);
    expect(payload.input[0].content).toContain(prompt.slice(0, 100));

    const tooLarge = await request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-body-limit",
        model: "account-model",
        request: { prompt: "x".repeat(16_384) },
      },
    });
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toMatchObject({
      error: "invalid_design_request",
      issues: [
        "The request exceeds the companion's 16 KiB safety limit. Shorten the brief or screen names.",
      ],
    });
  });

  it("streams multi-megabyte completed output from a temporary spool and cleans it up", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fad-spool-test-"));
    const children = Array.from({ length: 2_600 }, (_, index) => ({
      id: `node-${index}`,
      text: "Product description ".repeat(24),
    }));
    const generatedOutput = JSON.stringify({
      projectName: "Large Storefront",
      palette: { brand: "#223344" },
      screens: [
        { id: "home", children },
        { id: "products", children },
      ],
    });
    expect(generatedOutput.length).toBeGreaterThan(2 * 1_024 * 1_024);
    const harness = await createHarness({ generatedOutput, temporaryDirectory });
    try {
      const token = await authorizeAndDiscover(harness);
      await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
      const response = await request(harness.handle, "/v1/design", {
        token,
        body: {
          requestId: "req-multi-megabyte",
          model: "account-model",
          request: {
            prompt: "Create a polished storefront with a home and product screen.",
            target: "mobile",
            screenCount: 2,
            screenNames: ["Home", "Products"],
            language: "en",
            style: "",
          },
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(generatedOutput);
      expect(response.headers.get("x-fad-response-bytes")).toBe(
        String(Buffer.byteLength(generatedOutput)),
      );
      await vi.waitFor(async () => expect(await readdir(temporaryDirectory)).toEqual([]));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a design stream EOF, cleans the partial spool, and permits one same-screen retry", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fad-eof-retry-test-"));
    const generatedOutput = JSON.stringify({
      projectName: "Resumable Store",
      palette: { brand: "#223344" },
      screens: [{ id: "screen-home", children: [] }],
    });
    const harness = await createHarness({
      generatedOutput,
      incompleteGeneratedStreams: 1,
      temporaryDirectory,
    });
    try {
      const token = await authorizeAndDiscover(harness);
      await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
      const body = {
        requestId: "req-screen-eof-retry",
        model: "account-model",
        request: {
          prompt: "Create a polished mobile storefront with home and cart screens.",
          target: "mobile",
          screenCount: 2,
          screenNames: ["Home", "Cart"],
          language: "en",
          style: "",
        },
      };

      const incomplete = await request(harness.handle, "/v1/design", { token, body });
      expect(incomplete.status).toBe(502);
      const errorBody = await incomplete.json();
      expect(errorBody).toMatchObject({
        error: "response_incomplete",
        diagnostic: {
          outcome: "stream_ended_without_terminal",
          lastEvent: "response.output_text.delta",
          generatedBytes: Buffer.byteLength(generatedOutput),
        },
      });
      expect(JSON.stringify(errorBody)).not.toContain(generatedOutput);

      // Retry as soon as the 502 is received; the active-generation lock must already be released.
      const retried = await request(harness.handle, "/v1/design", { token, body });
      expect(retried.status).toBe(200);
      expect(await retried.text()).toBe(generatedOutput);
      expect(retried.headers.get("x-fad-request-id")).toBe(body.requestId);
      await vi.waitFor(async () => expect(await readdir(temporaryDirectory)).toEqual([]));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("blocks a third same-phase request after the single clean-EOF retry is exhausted", async () => {
    const harness = await createHarness({
      generatedOutput: '{"screens":[]}',
      incompleteGeneratedStreams: 2,
    });
    const token = await authorizeAndDiscover(harness);
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    const body = {
      requestId: "req-screen-eof-limit",
      model: "account-model",
      request: {
        prompt: "Create a polished mobile storefront with home and cart screens.",
        target: "mobile",
        screenCount: 2,
        screenNames: ["Home", "Cart"],
        language: "en",
        style: "",
      },
    };

    const first = await request(harness.handle, "/v1/design", { token, body });
    expect(first.status).toBe(502);
    expect((await first.json()).diagnostic).toMatchObject({
      outcome: "stream_ended_without_terminal",
    });
    const retry = await request(harness.handle, "/v1/design", { token, body });
    expect(retry.status).toBe(502);
    expect((await retry.json()).diagnostic).toMatchObject({
      outcome: "stream_ended_without_terminal",
    });

    const third = await request(harness.handle, "/v1/design", { token, body });
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: "generation_retry_limit" });
  }, 20_000);

  it("cancels an in-progress large spool and removes its partial output", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fad-cancel-spool-test-"));
    const generatedOutput = JSON.stringify({ content: "Large output ".repeat(100_000) });
    const harness = await createHarness({
      generatedOutput,
      temporaryDirectory,
      stallAfterGeneratedDelta: true,
    });
    try {
      const token = await authorizeAndDiscover(harness);
      await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
      const controller = new AbortController();
      const pending = request(harness.handle, "/v1/design", {
        token,
        signal: controller.signal,
        body: {
          requestId: "req-cancel-large-spool",
          model: "account-model",
          request: {
            prompt: "Create a polished storefront with a home and cart screen.",
            target: "mobile",
            screenCount: 2,
            screenNames: ["Home", "Cart"],
            language: "en",
            style: "",
          },
        },
      });
      await harness.waitForResponseStream();
      await vi.waitFor(async () => {
        const directories = await readdir(temporaryDirectory);
        expect(directories).toHaveLength(1);
        const spoolPath = join(temporaryDirectory, directories[0]!, "design.json");
        expect((await stat(spoolPath)).size).toBeGreaterThan(0);
      });
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(harness.wasResponseStreamCancelled()).toBe(true));
      await vi.waitFor(async () => expect(await readdir(temporaryDirectory)).toEqual([]));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("cancels an in-flight design stream when the paired UI aborts", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    harness.stallNextResponse();
    const controller = new AbortController();
    const pending = request(harness.handle, "/v1/design", {
      token,
      signal: controller.signal,
      body: {
        requestId: "req-cancel-design",
        model: "account-model",
        request: {
          prompt: "Create a professional mobile storefront for clothing.",
          target: "mobile",
          screenCount: 2,
          language: "en",
          style: "",
        },
      },
    });
    await harness.waitForResponseStream();
    const duplicate = await request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-duplicate-design",
        model: "account-model",
        request: {
          prompt: "Create another mobile storefront.",
          target: "mobile",
          screenCount: 2,
          language: "en",
          style: "",
        },
      },
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "generation_busy" });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(harness.wasResponseStreamCancelled()).toBe(true));
  });

  it("invalidates an in-flight design request and its verified-model state on account disconnect", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    harness.stallNextResponse();
    const generation = request(harness.handle, "/v1/design", {
      token,
      body: {
        requestId: "req-disconnect-design",
        model: "account-model",
        request: {
          prompt: "Create a professional mobile storefront for clothing.",
          target: "mobile",
          screenCount: 2,
          language: "en",
          style: "",
        },
      },
    });
    await harness.waitForResponseStream();

    const disconnected = await request(harness.handle, "/v1/disconnect", { token, body: {} });
    expect(disconnected.status).toBe(200);
    expect((await generation).status).toBe(502);
    await vi.waitFor(() => expect(harness.wasResponseStreamCancelled()).toBe(true));
    const status = await request(harness.handle, "/v1/status", { token });
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ auth: "signed_out", planUseAuthorized: false });
    expect(statusBody).not.toHaveProperty("inferenceVerifiedModel");
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
    const originalStatus = (await (
      await request(harness.handle, "/v1/status", { token })
    ).json()) as {
      sessionId: string;
    };
    await request(harness.handle, "/v1/models", { token, body: {} });
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });

    const switchResponse = await request(harness.handle, "/v1/account/switch", { token, body: {} });
    expect(switchResponse.status).toBe(200);
    expect(await switchResponse.json()).toMatchObject({ registrationForgotten: true });
    expect(JSON.parse(harness.storeSnapshot())).toMatchObject({ extAgentHostId: TEST_HOST_ID });
    expect(JSON.parse(harness.storeSnapshot())).not.toHaveProperty("clientId");
    expect(JSON.parse(harness.storeSnapshot())).not.toHaveProperty("subjectHash");
    const signedOut = await request(harness.handle, "/v1/status", { token });
    const signedOutBody = await signedOut.json();
    expect(signedOutBody).toMatchObject({ auth: "signed_out" });
    expect(signedOutBody).not.toHaveProperty("inferenceVerifiedModel");

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
    const newAccountStatus = await status.json();
    expect(newAccountStatus).toMatchObject({ auth: "scope_granted", planUseAuthorized: true });
    expect(newAccountStatus.sessionId).not.toBe(originalStatus.sessionId);
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

  it("clears the previous model verification as soon as a new smoke test starts and leaves it cleared on failure", async () => {
    const harness = await createHarness();
    const token = await harness.pair();
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    expect(await (await request(harness.handle, "/v1/status", { token })).json()).toMatchObject({
      auth: "ready",
      inferenceVerifiedModel: "account-model",
    });

    harness.failNextResponseWithUsage();
    const failed = await request(harness.handle, "/v1/smoke", {
      token,
      body: { model: "account-model" },
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "quota_or_rate_limit" });
    const status = await request(harness.handle, "/v1/status", { token });
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ auth: "scope_granted" });
    expect(statusBody).not.toHaveProperty("inferenceVerifiedModel");
  });

  it("expires a successful model verification after eight hours in the live Companion session", async () => {
    const harness = await createHarness();
    const paired = await harness.pairWithTicket();
    const token = paired.sessionToken;
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    await request(harness.handle, "/v1/models", { token, body: {} });
    await request(harness.handle, "/v1/smoke", { token, body: { model: "account-model" } });
    expect(await (await request(harness.handle, "/v1/status", { token })).json()).toMatchObject({
      auth: "ready",
      inferenceVerifiedModel: "account-model",
    });

    harness.advanceTime(8 * 60 * 60 * 1_000 + 1);
    const restored = await request(harness.handle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    const restoredToken = ((await restored.json()) as { sessionToken: string }).sessionToken;
    const expired = await request(harness.handle, "/v1/status", { token: restoredToken });
    const expiredBody = await expired.json();
    expect(expiredBody).toMatchObject({ auth: "scope_granted" });
    expect(expiredBody).not.toHaveProperty("inferenceVerifiedModel");
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
    const paired = await harness.pairWithTicket();
    const token = paired.sessionToken;
    await request(harness.handle, "/v1/auth/start", { token, body: {} });
    await completeLogin(harness);
    harness.advanceTime(5_000);
    const models = await request(harness.handle, "/v1/models", { token, body: {} });
    expect(models.status).toBe(401);
    expect(await models.json()).toMatchObject({ error: "session_expired" });
    const status = await request(harness.handle, "/v1/status", { token });
    expect(await status.json()).toMatchObject({ auth: "session_expired" });

    const restartedHandle = await harness.restart();
    const restored = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    const restoredToken = ((await restored.json()) as { sessionToken: string }).sessionToken;
    expect(
      await (await request(restartedHandle, "/v1/status", { token: restoredToken })).json(),
    ).toMatchObject({ auth: "session_expired" });
  });

  it("persists sign-in required when an upstream request confirms the access token was revoked", async () => {
    const harness = await createHarness({ modelsUnauthorized: true });
    const paired = await harness.pairWithTicket();
    await request(harness.handle, "/v1/auth/start", { token: paired.sessionToken, body: {} });
    await completeLogin(harness);

    const rejected = await request(harness.handle, "/v1/models", {
      token: paired.sessionToken,
      body: {},
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: "session_expired" });

    const restartedHandle = await harness.restart();
    const restored = await request(restartedHandle, "/v1/pairing/restore", {
      body: { ticket: paired.restoreTicket },
    });
    const restoredToken = ((await restored.json()) as { sessionToken: string }).sessionToken;
    expect(
      await (await request(restartedHandle, "/v1/status", { token: restoredToken })).json(),
    ).toMatchObject({ auth: "session_expired" });
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

  it("persists the rotated refresh credential securely for the next companion restart", async () => {
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

    harness.advanceTime(3_601_000);
    await harness.restart();
    expect(harness.refreshRequest).toContain("refresh_token=refresh-new");
  });
});

async function createHarness(
  options: {
    draftStore?: DraftStore;
    scope?: string;
    expiresIn?: number;
    refresh?: boolean;
    refreshFailure?: boolean;
    modelsUnauthorized?: boolean;
    usageFailure?: boolean;
    stalledStream?: boolean;
    stallChatHeaders?: boolean;
    stallAfterGeneratedDelta?: boolean;
    timeoutGeneratedStreams?: number;
    progressingGeneratedStream?: boolean;
    stallDesignHeaders?: boolean;
    incompleteGeneratedStreams?: number;
    generatedOutput?: string;
    chatResponses?: Array<{
      text?: string;
      outputItems?: unknown[];
      incompleteReason?: string;
      omitCompletedOutput?: boolean;
    }>;
    chatResponder?: (input: unknown[]) => {
      text?: string;
      outputItems?: unknown[];
      incompleteReason?: string;
      omitCompletedOutput?: boolean;
    };
    responseChunks?: string[];
    responsesHttpError?: { status: number; body: unknown };
    responsesFetchFailure?: boolean;
    accountModel?: string;
    requestTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    streamOverallTimeoutMs?: number;
    oauthBrowserFailures?: number;
    temporaryDirectory?: string;
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
  const responsesRequests: Array<{ body: string; headers: HeadersInit }> = [];
  let responsesCallCount = 0;
  let refreshRequest: string | undefined;
  let codeExchange: string | undefined;
  let markResponseStreamStarted = () => {};
  let responseStreamCancelled = false;
  let responseStreamStarted = new Promise<void>((resolve) => {
    markResponseStreamStarted = resolve;
  });
  let stallNextResponses = false;
  let stallChatHeaders = false;
  let nextResponsesUsageFailure = false;
  const resetResponseStreamWaiter = () => {
    responseStreamStarted = new Promise<void>((resolve) => {
      markResponseStreamStarted = resolve;
    });
  };
  let currentTime = Date.now();
  let authNonce = "";
  let authTransactionUrl: URL | undefined;
  let currentSubject = "opaque-subject";
  let nextModelFetchGate:
    | { started: Promise<void>; markStarted: () => void; wait: Promise<void>; release: () => void }
    | undefined;
  const credentialStore = createMemoryCredentialStore();
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
      const gate = nextModelFetchGate;
      if (gate) {
        nextModelFetchGate = undefined;
        gate.markStarted();
        await gate.wait;
      }
      if (options.modelsUnauthorized) {
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== "Bearer access-secret" && authorization !== "Bearer access-rotated") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        models: [
          {
            slug: options.accountModel ?? "account-model",
            display_name: options.accountModel ?? "Account Model",
            visibility: "list",
          },
          { slug: "hidden-model", display_name: "Hidden Model", visibility: "private" },
        ],
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      responsesCallCount++;
      responsesRequest = { body: String(init?.body ?? ""), headers: init?.headers ?? {} };
      responsesRequests.push(responsesRequest);
      const responsePayload = JSON.parse(String(init?.body ?? "")) as {
        text?: unknown;
        tools?: unknown;
        tool_choice?: unknown;
        input?: unknown[];
      };
      if (options.responsesFetchFailure) throw new TypeError("private transport failure text");
      if (
        stallChatHeaders &&
        Array.isArray(responsePayload.tools) &&
        responsePayload.tool_choice === "auto"
      ) {
        stallChatHeaders = false;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (options.stallDesignHeaders && JSON.parse(String(init?.body ?? "")).text) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (options.stalledStream || stallNextResponses) {
        stallNextResponses = false;
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
      if (options.responsesHttpError) {
        return Response.json(options.responsesHttpError.body, {
          status: options.responsesHttpError.status,
        });
      }
      if (options.usageFailure || nextResponsesUsageFailure) {
        nextResponsesUsageFailure = false;
        return new Response(
          `data: ${JSON.stringify({
            type: "response.failed",
            response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (options.responseChunks) {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of options.responseChunks ?? []) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (Array.isArray(responsePayload.tools)) {
        if (
          typeof responsePayload.tool_choice === "object" &&
          responsePayload.tool_choice !== null
        ) {
          const call = {
            type: "function_call",
            call_id: "smoke_call_123456",
            name: "get_document_context",
            arguments: "{}",
          };
          return new Response(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { status: "completed", output: [call] },
            })}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        const chatResponse = options.chatResponder?.(responsePayload.input ?? []) ??
          options.chatResponses?.shift() ?? { text: "OK", outputItems: [] };
        if (chatResponse.incompleteReason) {
          return new Response(
            `data: ${JSON.stringify({
              type: "response.incomplete",
              response: {
                status: "incomplete",
                output: [],
                incomplete_details: { reason: chatResponse.incompleteReason },
              },
            })}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(
          [
            ...(chatResponse.text
              ? [
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: chatResponse.text })}\n\n`,
                ]
              : []),
            ...(chatResponse.outputItems ?? [])
              .filter(
                (item) =>
                  typeof item === "object" &&
                  item !== null &&
                  "type" in item &&
                  item.type === "function_call",
              )
              .map(
                (item) =>
                  `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
              ),
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                status: "completed",
                output: chatResponse.omitCompletedOutput ? [] : (chatResponse.outputItems ?? []),
              },
            })}\n\n`,
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      const outputText = responsePayload.text ? (options.generatedOutput ?? "{}") : "OK";
      if ((options.incompleteGeneratedStreams ?? 0) > 0 && responsePayload.text) {
        options.incompleteGeneratedStreams = (options.incompleteGeneratedStreams ?? 0) - 1;
        return new Response(
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: outputText })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (options.progressingGeneratedStream && responsePayload.text) {
        const encoder = new TextEncoder();
        let interval: ReturnType<typeof setInterval> | undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              const enqueueDelta = () =>
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x" })}\n\n`,
                  ),
                );
              enqueueDelta();
              interval = setInterval(enqueueDelta, 20);
              markResponseStreamStarted();
            },
            cancel() {
              if (interval) clearInterval(interval);
              responseStreamCancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (
        ((options.timeoutGeneratedStreams ?? 0) > 0 || options.stallAfterGeneratedDelta) &&
        responsePayload.text
      ) {
        if ((options.timeoutGeneratedStreams ?? 0) > 0) {
          options.timeoutGeneratedStreams = (options.timeoutGeneratedStreams ?? 0) - 1;
        }
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: outputText })}\n\n`,
                ),
              );
              markResponseStreamStarted();
            },
            cancel() {
              responseStreamCancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: outputText })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({ error: "unexpected_test_request" }, { status: 500 });
  };
  const createCompanion = () =>
    createCompanionServer({
      port: 0,
      fetchImpl,
      draftStore: options.draftStore,
      installationStore: store,
      credentialStore,
      now: () => currentTime,
      ...(options.temporaryDirectory ? { temporaryDirectory: options.temporaryDirectory } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
        : {}),
      ...(options.streamOverallTimeoutMs !== undefined
        ? { streamOverallTimeoutMs: options.streamOverallTimeoutMs }
        : {}),
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
  let handle = await createCompanion().start();
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
    get responsesRequests() {
      return responsesRequests;
    },
    get responsesCallCount() {
      return responsesCallCount;
    },
    get refreshRequest() {
      return refreshRequest;
    },
    get codeExchange() {
      return codeExchange;
    },
    async pair() {
      return (await this.pairWithTicket()).sessionToken;
    },
    async pairWithTicket() {
      const verifier = randomBytes(32).toString("base64url");
      const attempt = await beginPairing(handle, verifier);
      const approvalPage = await getApprovalPage(handle, attempt.attemptId);
      const html = await approvalPage.text();
      const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/u)?.[1] ?? "";
      await submitApproval(handle, attempt.attemptId, csrf, "approve");
      const result = await request(handle, "/v1/pairing/poll", {
        body: { attemptId: attempt.attemptId, verifier },
      });
      return (await result.json()) as {
        sessionToken: string;
        restoreTicket: string;
        restoreAvailable: boolean;
      };
    },
    async restart() {
      await handle.close();
      handle = await createCompanion().start();
      openHandles.push(handle);
      return handle;
    },
    advanceTime(milliseconds: number) {
      currentTime += milliseconds;
    },
    changeSubject(subject: string) {
      currentSubject = subject;
    },
    stallNextModelsResponse() {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextModelFetchGate = { started, markStarted, wait, release };
      return { started, release };
    },
    storeSnapshot() {
      return JSON.stringify(storeData);
    },
    waitForResponseStream() {
      return responseStreamStarted;
    },
    stallNextResponse() {
      responseStreamCancelled = false;
      stallNextResponses = true;
      resetResponseStreamWaiter();
    },
    stallNextChatHeaders() {
      stallChatHeaders = true;
    },
    failNextResponseWithUsage() {
      nextResponsesUsageFailure = true;
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

async function authorizeAndDiscover(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<string> {
  const token = await harness.pair();
  await request(harness.handle, "/v1/auth/start", { token, body: {} });
  await completeLogin(harness);
  const models = await request(harness.handle, "/v1/models", { token, body: {} });
  expect(models.status).toBe(200);
  return token;
}

async function request(
  handle: CompanionServerHandle,
  path: string,
  options: { token?: string; body?: unknown; origin?: string; signal?: AbortSignal },
): Promise<Response> {
  const headers = new Headers({ Origin: options.origin ?? "null" });
  const body =
    path === "/v1/chat" &&
    options.body &&
    typeof options.body === "object" &&
    !Array.isArray(options.body) &&
    !("lifecycle" in options.body)
      ? { ...options.body, lifecycle: "UNPLANNED" }
      : options.body;
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  return fetch(`http://localhost:${handle.port}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
