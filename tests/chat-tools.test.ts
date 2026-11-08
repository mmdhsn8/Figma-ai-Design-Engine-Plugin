import { describe, expect, it } from "vitest";
import {
  CHAT_FUNCTION_TOOLS,
  chatFunctionToolsForState,
  ChatFunctionCallValidationError,
  ChatInputItemSchema,
  parseResponsesFunctionCalls,
  trimChatInputHistory,
  type ChatInputItem,
} from "../src/shared/chat-tools";

describe("allowlisted chat functions", () => {
  it("exposes planning only while the lifecycle is unplanned", () => {
    expect(chatFunctionToolsForState("UNPLANNED").map(({ name }) => name)).toContain(
      "plan_canvas_task",
    );
    for (const state of [
      "PLAN_SAVED",
      "EXECUTING_STAGE",
      "VERIFYING_STAGE",
      "STAGE_COMPLETED",
      "TASK_COMPLETED",
    ] as const)
      expect(chatFunctionToolsForState(state).map(({ name }) => name)).not.toContain(
        "plan_canvas_task",
      );
    expect(chatFunctionToolsForState("PLAN_SAVED").map(({ name }) => name)).toContain(
      "create_frame",
    );
    expect(chatFunctionToolsForState("PLAN_SAVED").map(({ name }) => name)).not.toContain(
      "complete_canvas_stage",
    );
    expect(chatFunctionToolsForState("EXECUTING_STAGE").map(({ name }) => name)).toContain(
      "complete_canvas_stage",
    );
  });

  it("exposes bounded native actions and validates model arguments into tool actions", () => {
    const functionCall = {
      type: "function_call",
      call_id: "call_12345678",
      name: "create_frame",
      arguments: JSON.stringify({
        ref: "home",
        name: "Home",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
    };
    const [call] = parseResponsesFunctionCalls([functionCall]);

    expect(call).toMatchObject({
      callId: "call_12345678",
      action: { tool: "create_frame", ref: "home", cornerRadius: 0 },
      functionCall,
    });
    expect(CHAT_FUNCTION_TOOLS.map(({ name }) => name)).not.toContain("delete_node");
    expect(CHAT_FUNCTION_TOOLS.find(({ name }) => name === "create_frame")).toMatchObject({
      type: "function",
      strict: false,
      parameters: { additionalProperties: false },
    });
  });

  it("rejects unknown, malformed, duplicate, and unsafe function calls", () => {
    expect(() =>
      parseResponsesFunctionCalls([
        { type: "function_call", call_id: "call_12345678", name: "delete_node", arguments: "{}" },
      ]),
    ).toThrow(/not allowlisted/u);
    expect(() =>
      parseResponsesFunctionCalls([
        {
          type: "function_call",
          call_id: "call_12345678",
          name: "create_frame",
          arguments:
            '{"ref":"unsafe","name":"X","parent":{"kind":"page"},"size":{"width":0,"height":800}}',
        },
      ]),
    ).toThrow();
    const duplicated = {
      type: "function_call",
      call_id: "call_12345678",
      name: "get_document_context",
      arguments: "{}",
    };
    expect(() => parseResponsesFunctionCalls([duplicated, duplicated])).toThrow(/duplicate/u);
    expect(
      ChatInputItemSchema.safeParse({
        type: "function_call_output",
        call_id: "short",
        output: "{}",
      }).success,
    ).toBe(false);
  });

  it("accepts the supported ten-call batch and rejects an oversized call set before dispatch", () => {
    const calls = Array.from({ length: 11 }, (_, index) => ({
      type: "function_call",
      call_id: `call_batch_${String(index).padStart(4, "0")}`,
      name: "get_document_context",
      arguments: "{}",
    }));
    expect(parseResponsesFunctionCalls(calls.slice(0, 10))).toHaveLength(10);
    try {
      parseResponsesFunctionCalls(calls);
      throw new Error("Expected an oversized Responses call set to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatFunctionCallValidationError);
      expect((error as ChatFunctionCallValidationError).validationIssues).toEqual([
        {
          stage: "call_set",
          errorCode: "too_many_calls",
          fieldPaths: ["calls"],
        },
      ]);
    }
  });

  it("rejects unsupported call_set wrappers without reading or executing embedded calls", () => {
    try {
      parseResponsesFunctionCalls([
        {
          type: "call_set",
          calls: [
            {
              type: "function_call",
              call_id: "embedded_call_01",
              name: "create_frame",
              arguments: JSON.stringify({
                ref: "must-not-execute",
                name: "Untrusted wrapper",
                parent: { kind: "page" },
                size: { width: 100, height: 100 },
              }),
            },
          ],
        },
      ]);
      throw new Error("Expected unsupported call_set wrapper rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatFunctionCallValidationError);
      expect((error as ChatFunctionCallValidationError).validationIssues).toEqual([
        {
          stage: "call_item",
          errorCode: "unsupported_wrapper",
          fieldPaths: ["type"],
        },
      ]);
      expect(
        JSON.stringify((error as ChatFunctionCallValidationError).validationIssues),
      ).not.toContain("must-not-execute");
    }
  });

  it("advertises only supported professional styling and structured planning fields", () => {
    const properties = (name: string) =>
      (
        CHAT_FUNCTION_TOOLS.find((tool) => tool.name === name)?.parameters as {
          properties: Record<string, unknown>;
        }
      ).properties;
    const createText = properties("create_text");
    const setProperties = (
      properties("set_properties").properties as { properties: Record<string, unknown> }
    ).properties;
    expect(createText).toHaveProperty("lineHeight");
    expect(createText).toHaveProperty("letterSpacing");
    expect(createText).not.toHaveProperty("textStyleId");
    expect(setProperties).toHaveProperty("textStyleId");
    expect(setProperties).toHaveProperty("fontFamily");
    expect(setProperties).toHaveProperty("shadow");
    expect(properties("plan_canvas_task")).toMatchObject({
      brief: { type: "object" },
      stages: { type: "array", maxItems: 12 },
    });
  });

  it("derives model parameter bounds from executor schemas and reports only safe field paths", () => {
    const parameters = (name: string) =>
      CHAT_FUNCTION_TOOLS.find((tool) => tool.name === name)?.parameters as {
        properties: Record<string, unknown>;
        required?: string[];
      };
    const rectangle = parameters("create_rectangle");
    expect(rectangle.required).not.toContain("tool");
    expect(rectangle.properties).not.toHaveProperty("tool");
    expect(rectangle.properties.fill).toMatchObject({
      type: "string",
      pattern: "^#[0-9A-Fa-f]{6}$",
    });
    expect(rectangle.properties.size).toMatchObject({
      properties: {
        width: { minimum: 1, maximum: 20_000 },
        height: { minimum: 1, maximum: 20_000 },
      },
    });
    const setProperties = parameters("set_properties").properties.properties as {
      properties: Record<string, { pattern?: string }>;
      minProperties: number;
    };
    expect(setProperties.properties.fill?.pattern).toBe("^#[0-9A-Fa-f]{6}$");
    expect(setProperties.minProperties).toBe(1);
    const inspectNodes = parameters("inspect_nodes");
    expect(inspectNodes.properties.maxNodes).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 25,
      default: 25,
    });
    expect(inspectNodes.properties.depth).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 4,
      default: 2,
    });

    let thrown: unknown;
    try {
      parseResponsesFunctionCalls([
        {
          type: "function_call",
          call_id: "call_style_1234",
          name: "create_rectangle",
          arguments: JSON.stringify({
            ref: "card",
            name: "Card",
            parent: { kind: "page" },
            size: { width: 300, height: 200 },
            fill: "rgba(1, 2, 3, 1)",
            private: "must never appear in diagnostics",
          }),
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChatFunctionCallValidationError);
    const issues = (thrown as ChatFunctionCallValidationError).validationIssues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "create_rectangle",
          callId: "call_style_1234",
          stage: "arguments_schema",
          fieldPaths: ["arguments.fill"],
        }),
        expect.objectContaining({ fieldPaths: ["arguments.private"] }),
      ]),
    );
    expect(JSON.stringify(issues)).not.toContain("rgba(");
    expect(JSON.stringify(issues)).not.toContain("must never appear");

    let conflict: unknown;
    try {
      parseResponsesFunctionCalls([
        {
          type: "function_call",
          call_id: "call_style_conflict",
          name: "create_rectangle",
          arguments: JSON.stringify({
            ref: "card",
            name: "Card",
            parent: { kind: "page" },
            size: { width: 300, height: 200 },
            fill: "#FFFFFF",
            paintStyleId: "style-123",
          }),
        },
      ]);
    } catch (error) {
      conflict = error;
    }
    expect((conflict as ChatFunctionCallValidationError).validationIssues[0]?.fieldPaths).toEqual([
      "arguments.fill",
      "arguments.paintStyleId",
    ]);
  });

  it("clamps finite out-of-range inspect_nodes numbers but rejects invalid types without coercion", () => {
    const rawCall = {
      type: "function_call",
      call_id: "inspect_bounds_001",
      name: "inspect_nodes",
      arguments: JSON.stringify({
        refs: ["store"],
        selection: false,
        maxNodes: 500,
        depth: -12,
      }),
    };
    const [normalized] = parseResponsesFunctionCalls([rawCall]);
    expect(normalized).toMatchObject({
      normalizedInspectionParameters: true,
      action: { tool: "inspect_nodes", refs: ["store"], maxNodes: 25, depth: 0 },
      functionCall: rawCall,
    });

    const [defaults] = parseResponsesFunctionCalls([
      {
        ...rawCall,
        call_id: "inspect_defaults_01",
        arguments: JSON.stringify({ refs: ["store"], selection: false }),
      },
    ]);
    expect(defaults).toMatchObject({
      action: { tool: "inspect_nodes", maxNodes: 25, depth: 2 },
    });
    expect(defaults?.normalizedInspectionParameters).toBeUndefined();

    let thrown: unknown;
    try {
      parseResponsesFunctionCalls([
        {
          ...rawCall,
          arguments: JSON.stringify({ refs: ["store"], selection: false, maxNodes: "500" }),
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChatFunctionCallValidationError);
    const issues = (thrown as ChatFunctionCallValidationError).validationIssues;
    expect(issues).toEqual([
      expect.objectContaining({
        toolName: "inspect_nodes",
        callId: "inspect_bounds_001",
        stage: "arguments_schema",
        fieldPaths: ["arguments.maxNodes"],
        receivedType: "string",
      }),
    ]);
    expect(JSON.stringify(issues)).not.toContain('"500"');

    expect(() =>
      parseResponsesFunctionCalls([
        {
          ...rawCall,
          arguments: JSON.stringify({ refs: Array.from({ length: 21 }, (_, i) => `ref-${i}`) }),
        },
      ]),
    ).toThrow();
  });

  it("trims only complete chat turns so function-call outputs are never orphaned", () => {
    const thirdTurn: ChatInputItem = { role: "user", content: "Third" };
    const input: ChatInputItem[] = [
      { role: "user", content: "First" },
      { role: "assistant", content: "First reply" },
      { role: "user", content: "Second" },
      {
        type: "function_call",
        call_id: "call_12345678",
        name: "create_frame",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_12345678", output: "{}" },
      { role: "assistant", content: "Second reply" },
      thirdTurn,
      { role: "assistant", content: "Third reply" },
    ];

    expect(trimChatInputHistory(input, 4)).toEqual([
      thirdTurn,
      { role: "assistant", content: "Third reply" },
    ]);
  });
});
