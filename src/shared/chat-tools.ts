import { z } from "zod";
import { FigmaToolActionSchema, type FigmaToolAction } from "./figma-tools.js";

export const CHAT_TOOL_NAMES = [
  "get_document_context",
  "inspect_nodes",
  "create_frame",
  "create_text",
  "create_rectangle",
  "set_auto_layout",
  "set_properties",
  "append_child",
  "reparent_node",
  "get_operation_status",
  "plan_canvas_task",
  "complete_canvas_stage",
] as const;

const ChatToolNameSchema = z.enum(CHAT_TOOL_NAMES);
const CallIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);

export const ChatInputItemSchema = z.union([
  z
    .object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(8_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call"),
      call_id: CallIdSchema,
      name: ChatToolNameSchema,
      arguments: z.string().max(24_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call_output"),
      call_id: CallIdSchema,
      output: z.string().max(8_000),
    })
    .strict(),
]);

export const ChatPlanActionSchema = z
  .object({
    tool: z.literal("plan_canvas_task"),
    stages: z.array(z.string().min(1).max(160)).min(1).max(12),
  })
  .strict();
export const ChatStageActionSchema = z
  .object({
    tool: z.literal("complete_canvas_stage"),
    summary: z.string().min(1).max(300),
    resolvedOperationIds: z.array(z.string().min(8).max(100)).max(32).default([]),
  })
  .strict();

export const ChatFunctionCallSchema = z
  .object({
    callId: CallIdSchema,
    name: ChatToolNameSchema,
    action: z.union([FigmaToolActionSchema, ChatPlanActionSchema, ChatStageActionSchema]),
    functionCall: z
      .object({
        type: z.literal("function_call"),
        call_id: CallIdSchema,
        name: ChatToolNameSchema,
        arguments: z.string().max(24_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((call, context) => {
    if (
      call.name !== call.action.tool ||
      call.functionCall.name !== call.name ||
      call.functionCall.call_id !== call.callId
    )
      context.addIssue({
        code: "custom",
        message: "Function-call identity must match its allowlisted action.",
      });
  });

export type ChatInputItem = z.infer<typeof ChatInputItemSchema>;
export type ChatFunctionCall = z.infer<typeof ChatFunctionCallSchema>;
export type ChatAction = FigmaToolAction;

export function trimChatInputHistory(input: ChatInputItem[], maxItems = 28): ChatInputItem[] {
  const result = [...input];
  while (result.length > maxItems) {
    const nextTurn = result.findIndex(
      (item, index) => index > 0 && "role" in item && item.role === "user",
    );
    if (nextTurn < 0) break;
    result.splice(0, nextTurn);
  }
  return result;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const ref = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]{0,79}$" };
const parent = {
  anyOf: [
    object({ kind: { const: "page" } }, ["kind"]),
    object({ kind: { const: "node" }, ref }, ["kind", "ref"]),
  ],
};
const size = object({ width: number, height: number }, ["width", "height"]);
const padding = object({ top: number, right: number, bottom: number, left: number }, [
  "top",
  "right",
  "bottom",
  "left",
]);
const layout = object(
  {
    direction: { type: "string", enum: ["horizontal", "vertical"] },
    gap: number,
    padding,
    primaryAlign: { type: "string", enum: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"] },
    counterAlign: { type: "string", enum: ["MIN", "CENTER", "MAX", "BASELINE"] },
    primarySizing: { type: "string", enum: ["FIXED", "AUTO"] },
    counterSizing: { type: "string", enum: ["FIXED", "AUTO"] },
  },
  ["direction"],
);

const definitions: Array<{
  name: (typeof CHAT_TOOL_NAMES)[number];
  description: string;
  parameters: unknown;
}> = [
  {
    name: "plan_canvas_task",
    description:
      "Before canvas work, plan all requested sections as 1–12 ordered stages, each needing at most 32 native operations. Include every requested element. Call alone, once per task; do not create nodes yet.",
    parameters: object({ stages: { type: "array", items: string, minItems: 1, maxItems: 12 } }, [
      "stages",
    ]),
  },
  {
    name: "complete_canvas_stage",
    description:
      "Finish only the current planned stage after all its native operations are confirmed successful. Call alone. For failed operations, first obtain a confirmed repair using the same tool and logical ref, then include their original operation IDs in resolvedOperationIds. Never omit failed elements. The result identifies the next stage; continue automatically until all stages finish.",
    parameters: object(
      { summary: string, resolvedOperationIds: { type: "array", items: string } },
      ["summary"],
    ),
  },
  {
    name: "get_document_context",
    description:
      "Read current page name, selection, viewport, and local design tokens. No canvas edits.",
    parameters: object({}),
  },
  {
    name: "inspect_nodes",
    description:
      "Inspect selected native layers or previously returned logical refs. Set selection:true when refs is empty. Returns stable logical refs for follow-up edits.",
    parameters: object(
      {
        refs: { type: "array", items: ref },
        selection: boolean,
        depth: integer,
        maxNodes: integer,
      },
      ["selection"],
    ),
  },
  {
    name: "create_frame",
    description:
      "Create one native editable frame. Omit x/y for safe non-overlapping page placement.",
    parameters: object(
      {
        ref,
        name: string,
        parent,
        size,
        x: number,
        y: number,
        fill: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        stroke: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        cornerRadius: number,
        autoLayout: layout,
      },
      ["ref", "name", "parent", "size"],
    ),
  },
  {
    name: "create_text",
    description:
      "Create editable text with a loaded/fallback font. For Persian, set direction RTL and right alignment.",
    parameters: object(
      {
        ref,
        name: string,
        parent,
        text: string,
        size,
        font: object({ family: string, style: string }),
        fontSize: number,
        color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT"] },
        direction: { type: "string", enum: ["LTR", "RTL"] },
        horizontalSizing: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
        verticalSizing: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
      },
      ["ref", "name", "parent", "text", "size"],
    ),
  },
  {
    name: "create_rectangle",
    description: "Create one native rectangle with bounded dimensions and a solid fill.",
    parameters: object(
      {
        ref,
        name: string,
        parent,
        size,
        x: number,
        y: number,
        fill: string,
        stroke: string,
        strokeWeight: number,
        cornerRadius: number,
      },
      ["ref", "name", "parent", "size"],
    ),
  },
  {
    name: "set_auto_layout",
    description:
      "Set Auto Layout on a frame/component and optionally normalize its direct children by logical ref.",
    parameters: object(
      {
        ref,
        layout,
        children: {
          type: "array",
          items: object(
            {
              ref,
              align: { type: "string", enum: ["INHERIT", "STRETCH"] },
              grow: integer,
              horizontal: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
              vertical: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
            },
            ["ref"],
          ),
        },
      },
      ["ref", "layout"],
    ),
  },
  {
    name: "set_properties",
    description:
      "Change only explicitly requested, allowlisted properties on an inspected/created logical ref.",
    parameters: object(
      {
        ref,
        properties: object({
          name: string,
          fill: string,
          paintStyleId: string,
          visible: boolean,
          width: number,
          height: number,
          text: string,
          fontSize: number,
          color: string,
          textStyleId: string,
          align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT"] },
        }),
      },
      ["ref", "properties"],
    ),
  },
  {
    name: "append_child",
    description:
      "Append a current page-root native node to a frame using logical refs. Does not accept raw Figma IDs.",
    parameters: object({ childRef: ref, parentRef: ref }, ["childRef", "parentRef"]),
  },
  {
    name: "reparent_node",
    description: "Move a native node by logical refs. Invalid parents and cycles are rejected.",
    parameters: object({ ref, parentRef: ref }, ["ref", "parentRef"]),
  },
  {
    name: "get_operation_status",
    description: "Read the saved status of a prior operation by operation ID.",
    parameters: object({ operationId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,100}$" } }, [
      "operationId",
    ]),
  },
];

export const CHAT_FUNCTION_TOOLS = definitions.map(({ name, description, parameters }) => ({
  type: "function",
  name,
  description,
  parameters,
  strict: false,
}));

export function parseResponsesFunctionCalls(output: unknown): ChatFunctionCall[] {
  if (!Array.isArray(output)) return [];
  const functionItems = output.filter((item) => isRecord(item) && item.type === "function_call");
  if (functionItems.length > 10) throw new Error("The model returned more than 10 function calls.");
  const calls = functionItems.map((item) => {
    if (!isRecord(item)) throw new Error("The model returned an invalid function call.");
    const nameResult = ChatToolNameSchema.safeParse(item.name);
    if (!nameResult.success)
      throw new Error("The model requested a function that is not allowlisted.");
    const callIdResult = CallIdSchema.safeParse(item.call_id);
    if (
      !callIdResult.success ||
      typeof item.arguments !== "string" ||
      item.arguments.length > 24_000
    )
      throw new Error("The model returned invalid function-call arguments.");
    let args: unknown;
    try {
      args = JSON.parse(item.arguments) as unknown;
    } catch {
      throw new Error("The model returned malformed function-call JSON.");
    }
    if (!isRecord(args)) throw new Error("The function-call arguments must be an object.");
    const actionInput = { ...args, tool: nameResult.data };
    const action =
      nameResult.data === "plan_canvas_task"
        ? ChatPlanActionSchema.parse(actionInput)
        : nameResult.data === "complete_canvas_stage"
          ? ChatStageActionSchema.parse(actionInput)
          : FigmaToolActionSchema.parse(actionInput);
    return ChatFunctionCallSchema.parse({
      callId: callIdResult.data,
      name: nameResult.data,
      action,
      functionCall: {
        type: "function_call",
        call_id: callIdResult.data,
        name: nameResult.data,
        arguments: item.arguments,
      },
    });
  });
  if (new Set(calls.map(({ callId }) => callId)).size !== calls.length)
    throw new Error("The model returned duplicate function-call IDs.");
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
