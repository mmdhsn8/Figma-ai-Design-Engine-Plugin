import { describe, expect, it, vi } from "vitest";
import { ChatTaskSchema, chatTaskSafeDiagnostic, type ChatTask } from "../src/shared/chat-task";
import { parseResponsesFunctionCalls, type ChatInputItem } from "../src/shared/chat-tools";
import { FigmaToolBatchSchema, type FigmaToolOperation } from "../src/shared/figma-tools";
import type { PluginToUIMessage } from "../src/shared/messages";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { runChatTask } from "../src/ui/chat-task";
import type { AuthorizedChatTurn } from "../src/ui/companion-client";
import { createMockApi } from "./figma-mock";

describe("registered plugin saved verification recovery", () => {
  it.each([true, false])(
    "dispatches both repairs after five failed checks and 33 preserved commits (legacy awaiting flag: %s)",
    async (awaitingQualityRepair) => {
      const mock = createMockApi();
      const messages: PluginToUIMessage[] = [];
      const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      let callNumber = 0;
      const turn = (actions: Array<Record<string, unknown>>): AuthorizedChatTurn => {
        const calls = parseResponsesFunctionCalls(
          actions.map(({ tool, ...args }) => ({
            type: "function_call",
            call_id: `recovery_call_${++callNumber}`,
            name: tool,
            arguments: JSON.stringify(args),
          })),
        );
        return {
          kind: "tool_calls",
          calls,
          functionCallItems: calls.map((call) => call.functionCall),
          text: "",
        };
      };
      const frame = (
        ref: string,
        parent: string | undefined,
        width: number,
        height: number,
        extra = {},
      ) => ({
        tool: "create_frame",
        ref,
        name: ref,
        parent: parent ? { kind: "node", ref: parent } : { kind: "page" },
        size: { width, height },
        ...extra,
      });
      const text = (ref: string, parent: string, width: number, height: number, extra = {}) => ({
        tool: "create_text",
        ref,
        name: ref,
        parent: { kind: "node", ref: parent },
        size: { width, height },
        text: "Native content",
        horizontalSizing: "FIXED",
        verticalSizing: "FIXED",
        textAutoResize: "NONE",
        color: "#111111",
        ...extra,
      });
      const creations = [
        frame("screen", undefined, 390, 844, { x: 4590, y: 5000, fill: "#FFFFFF" }),
        frame("section", "screen", 350, 130, {
          x: 20,
          y: 41,
          clipsContent: true,
          autoLayout: {
            direction: "vertical",
            primarySizing: "FIXED",
            gap: 16,
            padding: { top: 16, right: 16, bottom: 16, left: 16 },
          },
        }),
        text("title", "section", 318, 56),
        text("overflow", "section", 318, 142),
        text("label", "screen", 200, 24, { color: "#888888" }),
        frame("grid", "screen", 350, 400, { x: 20, y: 380 }),
        ...Array.from({ length: 24 }, (_, index) => ({
          tool: "create_rectangle",
          ref: `cell-${index}`,
          name: `cell-${index}`,
          parent: { kind: "node", ref: "grid" },
          size: { width: 40, height: 40 },
          x: 10 + (index % 6) * 50,
          y: 10 + Math.floor(index / 6) * 50,
          fill: "#EEEEEE",
        })),
      ];
      const brief = {
        platform: "mobile",
        viewport: { width: 390, height: 844 },
        brandDirection: "Ocean shop",
        audience: "Shoppers",
        content: ["Store"],
        hierarchy: "Store and products",
        typography: { family: "Inter", style: "Regular", headingSize: 28, bodySize: 14 },
        spacingScale: [8, 16],
        radiusScale: [8, 16],
        palette: {
          source: "curated-default",
          background: "#FFFFFF",
          surface: "#FFFFFF",
          primary: "#006699",
          accent: "#99CCDD",
          text: "#111111",
          muted: "#888888",
        },
        imagePolicy: "labeled-native-fallback",
        interactionPriorities: ["Browse"],
        readingDirection: "LTR",
      };
      const refs = [
        "screen",
        "section",
        "title",
        "overflow",
        "label",
        "grid",
        ...Array.from({ length: 5 }, (_, index) => `cell-${index}`),
      ];
      const turns = [
        turn([{ tool: "get_document_context" }]),
        turn([
          {
            tool: "plan_canvas_task",
            brief,
            stages: [
              {
                title: "Store",
                goal: "Complete store",
                logicalRefs: refs,
                completionCriteria: ["No clipping and sufficient contrast"],
                estimatedMutations: 30,
              },
            ],
          },
        ]),
        ...[0, 10, 20].map((start) => turn(creations.slice(start, start + 10))),
        turn(
          [0, 1, 2].map((index) => ({
            tool: "set_properties",
            ref: `cell-${index}`,
            properties: { fill: "#CCCCCC" },
          })),
        ),
        turn([{ tool: "complete_canvas_stage", summary: "Verify native design" }]),
        turn([{ tool: "complete_canvas_stage", summary: "Complete verified design" }]),
        { kind: "done", text: "Verified" } as AuthorizedChatTurn,
      ];
      const task = ChatTaskSchema.parse({
        version: 1,
        id: "chat-1794214243148-w6e91f",
        intent: "create",
        referenceScope: "task-v1",
        documentId: "file-test-56-page_current",
        prompt: "Create store",
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
      const controller = new AbortController();
      let resuming = false;
      let batchNumber = 0;
      let clock = Date.now();
      const actions: FigmaToolOperation[] = [];
      const coverage: number[] = [];
      const execute = async (operations: FigmaToolOperation[]) => {
        if (
          !resuming &&
          operations.some(
            ({ action }) =>
              action.tool === "inspect_nodes" && action.purpose === "structural_verification",
          )
        ) {
          // Only Figma's synchronous HUG setter is simulated; runner, executor and V3 storage are production code.
          const section = mock.find("section")!;
          let sizing = "FIXED";
          Object.defineProperty(section, "primaryAxisSizingMode", {
            get: () => sizing,
            set: (value: string) => {
              sizing = value;
              if (value === "AUTO")
                section.resize(
                  section.width,
                  16 +
                    section.children.reduce((sum, child) => sum + child.height, 0) +
                    16 * (section.children.length - 1) +
                    16,
                );
            },
          });
        }
        actions.push(...operations);
        const batchId = `recovery_batch_${++batchNumber}`;
        await executor(
          FigmaToolBatchSchema.parse({
            type: "tool-execute",
            protocolVersion: 1,
            batchId,
            operations,
          }),
        );
        const result = messages.find(
          (message) => message.type === "tool-result" && message.batchId === batchId,
        );
        if (result?.type !== "tool-result") throw new Error("Native acknowledgement missing");
        for (const item of result.results)
          if (item.data?.qualityCoverage)
            coverage.push((item.data.qualityCoverage as { nodeCount: number }).nodeCount);
        return result;
      };
      const model = vi.fn(async () => {
        if (resuming && task.stages[0].qualityFindings.length)
          throw new Error("Requested model repair instead of dispatching native corrections");
        const next = turns.shift();
        if (!next) throw new Error("Unexpected model request");
        return next;
      });
      const deps = {
        model,
        execute,
        progress: () => {},
        now: () => clock,
        wait: async (ms: number) => {
          clock += ms;
        },
      };
      await expect(
        runChatTask(task, {
          ...deps,
          signal: controller.signal,
          save: async (checkpoint) => {
            ChatTaskSchema.parse(checkpoint);
            if (checkpoint.stages[0]?.awaitingQualityRepair) controller.abort();
          },
        }),
      ).rejects.toThrow("Stopped");
      const originalIds = mock.nodes.map((node) => node.id);
      const originalCommits = task.ledger
        .filter((entry) => entry.acknowledgementStatus === "confirmed_mutation")
        .map((entry) => entry.operationId);
      expect(originalIds).toHaveLength(30);
      expect(originalCommits).toHaveLength(33);
      const stage = task.stages[0];
      const clip = stage.qualityFindings.find((finding) => finding.code === "clipped-child")!;
      const legacyFindings = [
        clip,
        structuredClone(clip),
        ...stage.qualityFindings.filter((finding) => finding.code !== "clipped-child"),
      ];
      stage.qualityFindings = legacyFindings;
      stage.verificationHistory = Array.from({ length: 5 }, (_, index) => ({
        attempt: index + 1,
        findings: structuredClone(legacyFindings),
      }));
      for (let attempt = 2; attempt <= 5; attempt++) {
        const call = turn([{ tool: "inspect_nodes", refs: ["screen"] }]);
        if (call.kind !== "tool_calls") throw new Error("Invalid test call");
        task.ledger.push({
          call: call.calls[0],
          operationId: `${task.id}-qa-1-${attempt}`,
          stage: 0,
          status: "completed",
          category: "verification",
          acknowledgementStatus: "read_only",
          output: JSON.stringify({ success: true, findings: legacyFindings }),
        });
      }
      delete stage.nativeRepairPlan;
      delete stage.nativeQualityCoverage;
      delete stage.nativeRepairPipelineVersion;
      stage.awaitingQualityRepair = awaitingQualityRepair;
      stage.qualityRepairBlocked = false;
      stage.repairVerificationPending = false;
      stage.qaAttempts = 3;
      stage.verificationOperations = 5;
      task.status = "failed";
      task.lifecycle = "VERIFYING_STAGE";
      task.failure = {
        category: "planning",
        phase: "verification",
        code: "no_progress_repeated_error",
        committedOperations: 33,
      };
      task.lastFailureSignature = `structural_quality:${JSON.stringify(legacyFindings)}`;
      task.lastFailureProgress = 33;
      expect(stage.repairOperationsAttempted).toBe(0);
      const checkpoint = ChatTaskSchema.parse(structuredClone(task));
      expect(chatTaskSafeDiagnostic(checkpoint)).toMatchObject({
        repairPipelineVersion: "native-quality-repair-v1",
      });
      const beforeRetry = actions.length;
      resuming = true;
      await runChatTask(checkpoint, {
        ...deps,
        model: async () => {
          task.stages = checkpoint.stages;
          return model();
        },
        signal: new AbortController().signal,
        save: async (saved) => {
          ChatTaskSchema.parse(saved);
        },
      });
      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.stages[0]).toMatchObject({
        verified: true,
        repairOperationsAttempted: 2,
        repairOperationsExecuted: 2,
        repairFindingsResolved: 2,
        qualityFindings: [],
      });
      expect(coverage).toEqual([30, 30, 30, 30]);
      expect(mock.nodes.map((node) => node.id)).toEqual(originalIds);
      expect(
        checkpoint.ledger
          .filter((entry) => originalCommits.includes(entry.operationId))
          .every((entry) => entry.status === "completed"),
      ).toBe(true);
      expect(actions.slice(beforeRetry).map(({ action }) => action.tool)).toEqual([
        "inspect_nodes",
        "set_auto_layout",
        "inspect_nodes",
        "set_properties",
        "inspect_nodes",
      ]);
      expect(mock.find("section")!.height).toBe(246);
      expect(checkpoint.stages[0].nativeRepairPipelineVersion).toBe("native-quality-repair-v1");
      expect(chatTaskSafeDiagnostic(checkpoint)).toMatchObject({
        repairPipelineVersion: "native-quality-repair-v1",
      });
    },
  );

  it("rejects a short mobile root, repairs 330px content into a 310px body, and completes three stages", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    let callNumber = 0;
    const turn = (actions: Array<Record<string, unknown>>): AuthorizedChatTurn => {
      const calls = parseResponsesFunctionCalls(
        actions.map(({ tool, ...args }) => ({
          type: "function_call",
          call_id: `layout_call_${++callNumber}`,
          name: tool,
          arguments: JSON.stringify(args),
        })),
      );
      return {
        kind: "tool_calls",
        calls,
        functionCallItems: calls.map((call) => call.functionCall),
        text: "",
      };
    };
    const frame = (
      ref: string,
      parent: string | undefined,
      width: number,
      height: number,
      extra: Record<string, unknown> = {},
    ) => ({
      tool: "create_frame",
      ref,
      name: ref,
      parent: parent ? { kind: "node", ref: parent } : { kind: "page" },
      size: { width, height },
      ...extra,
    });
    const brief = {
      platform: "mobile",
      viewport: { width: 390, height: 844 },
      brandDirection: "Clothing store",
      audience: "Shoppers",
      content: ["Header", "Products", "Details"],
      hierarchy: "Scrollable product content below a fixed mobile viewport",
      typography: { family: "Inter", style: "Regular", headingSize: 28, bodySize: 14 },
      spacingScale: [8, 16],
      radiusScale: [8, 16],
      palette: {
        source: "curated-default",
        background: "#FFFFFF",
        surface: "#FFFFFF",
        primary: "#006699",
        accent: "#99CCDD",
        text: "#111111",
        muted: "#777777",
      },
      imagePolicy: "labeled-native-fallback",
      interactionPriorities: ["Browse"],
      readingDirection: "LTR",
    };
    const pageRoot = (ref: string) =>
      frame(ref, undefined, 390, 844, {
        clipsContent: true,
        overflowDirection: "VERTICAL",
        fill: "#FFFFFF",
        autoLayout: {
          direction: "vertical",
          primarySizing: "FIXED",
          counterSizing: "FIXED",
          padding: { top: 20, right: 20, bottom: 20, left: 20 },
        },
      });
    const turns: AuthorizedChatTurn[] = [
      turn([{ tool: "classify_canvas_intent", intent: "create" }]),
      turn([{ tool: "get_document_context" }]),
      turn([
        {
          tool: "plan_canvas_task",
          brief,
          stages: [
            {
              title: "Storefront",
              goal: "Create the native mobile storefront with scrollable content.",
              logicalRefs: ["screen-1", "body-1", "content-1"],
              completionCriteria: ["Viewport dimensions and native content fit are verified."],
            },
            {
              title: "Product detail",
              goal: "Create the native product detail screen.",
              logicalRefs: ["screen-2"],
              completionCriteria: ["The product detail screen matches the mobile viewport."],
            },
            {
              title: "Cart",
              goal: "Create the native cart screen.",
              logicalRefs: ["screen-3"],
              completionCriteria: ["The cart screen matches the mobile viewport."],
            },
          ],
        },
      ]),
      turn([{ ...pageRoot("screen-1"), size: { width: 390, height: 201 } }]),
      turn([
        pageRoot("screen-1"),
        frame("body-1", "screen-1", 350, 145, {
          clipsContent: true,
          autoLayout: {
            direction: "vertical",
            primarySizing: "FIXED",
            counterSizing: "FIXED",
            padding: { top: 20, right: 20, bottom: 20, left: 20 },
          },
        }),
        frame("content-1", "body-1", 330, 835, { fill: "#EEEEEE" }),
      ]),
      turn([
        {
          tool: "set_properties",
          ref: "screen-1",
          properties: { height: 201 },
        },
      ]),
      turn([{ tool: "complete_canvas_stage", summary: "Verify storefront" }]),
      turn([{ tool: "complete_canvas_stage", summary: "Complete repaired storefront" }]),
      turn([pageRoot("screen-2")]),
      turn([{ tool: "complete_canvas_stage", summary: "Verify product detail" }]),
      turn([pageRoot("screen-3")]),
      turn([{ tool: "complete_canvas_stage", summary: "Verify cart" }]),
      { kind: "done", text: "All three mobile screens passed native verification." },
    ];
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "chat-native-layout-390px",
      referenceScope: "task-v1",
      documentId: "file-test-56-page_current",
      prompt: "Create a three-screen mobile clothing store.",
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
    const nativeActions: FigmaToolOperation[] = [];
    const checkpoints: ChatTask[] = [];
    const modelInputs: ChatInputItem[][] = [];
    let batchNumber = 0;
    let clock = Date.now();
    let reflowInstalled = false;
    const execute = async (operations: FigmaToolOperation[]) => {
      nativeActions.push(...operations);
      if (
        !reflowInstalled &&
        operations.some(
          ({ action }) =>
            action.tool === "inspect_nodes" && action.purpose === "structural_verification",
        )
      ) {
        const body = mock.find("body-1")!;
        const content = mock.find("content-1")!;
        let horizontal = content.layoutSizingHorizontal as "FIXED" | "HUG" | "FILL";
        Object.defineProperty(content, "layoutSizingHorizontal", {
          configurable: true,
          get: () => horizontal,
          set: (value: "FIXED" | "HUG" | "FILL") => {
            horizontal = value;
            if (value === "FILL")
              content.resize(
                body.width - Number(body.paddingLeft) - Number(body.paddingRight),
                content.height,
              );
          },
        });
        let primary = body.primaryAxisSizingMode as "AUTO" | "FIXED";
        Object.defineProperty(body, "primaryAxisSizingMode", {
          configurable: true,
          get: () => primary,
          set: (value: "AUTO" | "FIXED") => {
            primary = value;
            if (value === "AUTO")
              body.resize(
                body.width,
                Number(body.paddingTop) + content.height + Number(body.paddingBottom),
              );
          },
        });
        reflowInstalled = true;
      }
      const batchId = `layout_batch_${++batchNumber}`;
      await executor(
        FigmaToolBatchSchema.parse({
          type: "tool-execute",
          protocolVersion: 1,
          batchId,
          operations,
        }),
      );
      const result = messages.find(
        (message) => message.type === "tool-result" && message.batchId === batchId,
      );
      if (result?.type !== "tool-result") throw new Error("Native acknowledgement missing");
      return result;
    };
    const controller = new AbortController();
    const model = vi.fn(async (input: ChatInputItem[]) => {
      modelInputs.push(input);
      const next = turns.shift();
      if (!next) throw new Error("Unexpected model request after the three-stage fixture.");
      return next;
    });

    await runChatTask(task, {
      model,
      execute,
      progress: () => {},
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      signal: controller.signal,
      save: async (checkpoint) => {
        ChatTaskSchema.parse(checkpoint);
        checkpoints.push(structuredClone(checkpoint));
      },
    });

    expect(task.status).toBe("completed");
    expect(task.validationCorrections).toBe(2);
    expect(task.stages.map(({ completed }) => completed)).toEqual([true, true, true]);
    expect(task.stages[0]).toMatchObject({
      repairOperationsExecuted: 1,
      repairFindingsResolved: 1,
      qualityFindings: [],
      nativeQualityCoverage: { complete: true, findingCount: 0 },
    });
    expect(mock.nodes).toHaveLength(5);
    expect(mock.find("screen-1")!.height).toBe(844);
    expect(mock.find("screen-1")!.overflowDirection).toBe("VERTICAL");
    expect(mock.find("screen-2")!.height).toBe(844);
    expect(mock.find("screen-3")!.height).toBe(844);
    expect(mock.find("content-1")!.width).toBe(310);
    expect(mock.find("body-1")!.height).toBe(875);
    expect(new Set(mock.nodes.map(({ name }) => name)).size).toBe(mock.nodes.length);
    expect(nativeActions.filter(({ action }) => action.tool === "set_auto_layout")).toHaveLength(1);
    expect(nativeActions.filter(({ action }) => action.tool === "create_frame")).toHaveLength(5);
    expect(nativeActions.some(({ action }) => action.tool === "set_properties")).toBe(false);
    expect(
      nativeActions.some(
        ({ action }) => action.tool === "create_frame" && action.size.height === 201,
      ),
    ).toBe(false);
    expect(
      modelInputs.some((input) =>
        input.some(
          (item) =>
            "role" in item &&
            item.role === "user" &&
            item.content.includes("mobile_viewport_contract"),
        ),
      ),
    ).toBe(true);
    expect(checkpoints.at(-1)?.stages.map(({ completed }) => completed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(
      task.ledger.filter(
        ({ acknowledgementStatus }) => acknowledgementStatus === "confirmed_mutation",
      ),
    ).toHaveLength(6);
  });
});
