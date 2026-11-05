import { describe, expect, it } from "vitest";
import {
  CHAT_FUNCTION_TOOLS,
  ChatInputItemSchema,
  parseResponsesFunctionCalls,
  trimChatInputHistory,
  type ChatInputItem,
} from "../src/shared/chat-tools";

describe("allowlisted chat functions", () => {
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
