import { z } from "zod";
import {
  FigmaToolActionSchema,
  INSPECT_NODES_LIMITS,
  type FigmaToolAction,
} from "./figma-tools.js";

export const CHAT_TOOL_NAMES = [
  "classify_canvas_intent",
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

export const CHAT_LIFECYCLE_STATES = [
  "UNPLANNED",
  "INSPECTING",
  "EDIT_TARGETING",
  "EDIT_PLANNING",
  "PLAN_SAVED",
  "EXECUTING_STAGE",
  "VERIFYING_STAGE",
  "STAGE_COMPLETED",
  "TASK_COMPLETED",
] as const;
export const ChatLifecycleStateSchema = z.enum(CHAT_LIFECYCLE_STATES);
export type ChatLifecycleState = z.infer<typeof ChatLifecycleStateSchema>;

const ChatToolNameSchema = z.enum(CHAT_TOOL_NAMES);
const CallIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);

export const ChatCanvasIntentActionSchema = z
  .object({
    tool: z.literal("classify_canvas_intent"),
    intent: z.enum(["create", "edit", "inspect", "explain", "continue"]),
    targetName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

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

export const ChatDesignBriefSchema = z
  .object({
    platform: z.enum(["mobile", "desktop", "responsive", "web"]),
    viewport: z
      .object({
        width: z.number().int().min(320).max(5_000),
        height: z.number().int().min(320).max(5_000),
      })
      .strict(),
    brandDirection: z.string().min(1).max(160),
    audience: z.string().min(1).max(120),
    content: z.array(z.string().min(1).max(120)).min(1).max(16),
    hierarchy: z.string().min(1).max(200),
    typography: z
      .object({
        family: z.string().min(1).max(80),
        style: z.string().min(1).max(80),
        headingSize: z.number().min(16).max(96),
        bodySize: z.number().min(12).max(32),
      })
      .strict(),
    spacingScale: z.array(z.number().finite().min(0).max(128)).min(2).max(8),
    radiusScale: z.array(z.number().finite().min(0).max(128)).min(2).max(6),
    palette: z
      .object({
        source: z.enum(["existing-document", "user-requested", "curated-default", "brand-kit"]),
        background: z.string().min(1).max(100),
        surface: z.string().min(1).max(100),
        primary: z.string().min(1).max(100),
        accent: z.string().min(1).max(100),
        text: z.string().min(1).max(100),
        muted: z.string().min(1).max(100),
      })
      .strict(),
    imagePolicy: z.enum(["authorized-assets-only", "labeled-native-fallback"]),
    interactionPriorities: z.array(z.string().min(1).max(120)).min(1).max(8),
    readingDirection: z.enum(["LTR", "RTL"]),
  })
  .strict();

export const PlannedPropertyEditSchema = FigmaToolActionSchema.options.find(
  (option) => option.shape.tool.value === "set_properties",
)! as Extract<(typeof FigmaToolActionSchema.options)[number], { shape: { tool: z.ZodLiteral<"set_properties"> } }>;

export const ChatDesignStageSchema = z
  .object({
    title: z.string().min(1).max(160),
    goal: z.string().min(1).max(240),
    pageId: z.string().min(1).max(200).optional(),
    logicalRefs: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u))
      .min(1)
      .max(20),
    completionCriteria: z.array(z.string().min(1).max(180)).min(1).max(5),
    estimatedMutations: z.number().int().min(1).max(240).optional(),
    propertyEdit: PlannedPropertyEditSchema.optional(),
  })
  .strict();

const phaseMs = z.number().int().nonnegative().max(600_000);
export const ChatTurnTimingSchema = z.object({
  companionHeadersMs: phaseMs.optional(),
  upstreamHeadersMs: phaseMs.optional(),
  upstreamFirstDeltaMs: phaseMs.optional(),
  upstreamTotalMs: phaseMs.optional(),
}).strict();

export const CHAT_PLAN_VERSION = 1;
export const ChatPlanActionSchema = z
  .object({
    tool: z.literal("plan_canvas_task"),
    designName: z.string().trim().min(1).max(100).optional(),
    planVersion: z.literal(CHAT_PLAN_VERSION).default(CHAT_PLAN_VERSION),
    targetRefs: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u))
      .min(1)
      .max(20)
      .optional(),
    brief: ChatDesignBriefSchema,
    stages: z.array(ChatDesignStageSchema).min(1).max(12),
  })
  .strict();

export function modelPlanStages(stages: z.infer<typeof ChatDesignStageSchema>[]) {
  return stages.map(({ title, goal, pageId, logicalRefs, completionCriteria, estimatedMutations, propertyEdit }) => ({
    title,
    goal,
    ...(pageId ? { pageId } : {}),
    logicalRefs,
    completionCriteria,
    ...(propertyEdit ? { propertyEdit } : {}),
    ...(estimatedMutations ? { estimatedMutations } : {}),
  }));
}

// Runtime metadata has no design semantics; never trust model-authored execution state.
function normalizePlanArguments(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.stages)) return args;
  const runtimeFields = [
    "completed",
    "operations",
    "rounds",
    "verification",
    "qaAttempts",
    "verificationOperations",
    "verified",
    "segments",
    "readOnlyOperations",
    "completionReason",
    "verificationHistory",
    "qualityFindings",
    "repairOperationsExecuted",
    "repairOperationsAttempted",
    "qualityRepairAttempted",
    "awaitingQualityRepair",
  ];
  return {
    ...args,
    stages: args.stages.map((stage: unknown) => {
      if (!isRecord(stage)) return stage;
      const plan = { ...stage };
      for (const field of runtimeFields) delete plan[field];
      return plan;
    }),
  };
}

function normalizeInspectArguments(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  changed: boolean;
} {
  const normalized = { ...args };
  let changed = false;
  for (const [field, bounds] of [
    ["maxNodes", INSPECT_NODES_LIMITS.maxNodes],
    ["depth", INSPECT_NODES_LIMITS.depth],
  ] as const) {
    const value = normalized[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const bounded = Math.max(bounds.min, Math.min(bounds.max, value));
    if (bounded !== value) {
      normalized[field] = bounded;
      changed = true;
    }
  }
  return { args: normalized, changed };
}

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
    action: z.union([
      FigmaToolActionSchema,
      ChatCanvasIntentActionSchema,
      ChatPlanActionSchema,
      ChatStageActionSchema,
    ]),
    normalizedPlanningMetadata: z.boolean().optional(),
    normalizedInspectionParameters: z.boolean().optional(),
    stateRedirectedPlanning: z.boolean().optional(),
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

type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

const descriptions: Record<ChatToolName, string> = {
  classify_canvas_intent:
    "Classify a canvas-related user request before any other canvas tool unless intent is already checkpointed: create new work, edit existing nodes, inspect/report existing work, explain the observed state, or continue prior work. When the user or recent conversation identifies a project/screen, include its exact targetName. Call alone once. Never reclassify saved intent or classify an edit as create.",
  plan_canvas_task:
    "For create/edit/continue only, call alone once after intent classification. For edit, the native controller performs discovery and inspection first; include targetRefs copied exactly from the verified target evidence, including the existing root frame, and use only those refs for existing nodes. Return an internal concise design brief and 1–12 ordered stages. Include designName when the user named a project. Each stage needs a goal, stable logicalRefs for only required acceptance nodes, measurable completionCriteria, and estimatedMutations when known. For a new design, logicalRefs are fresh task-local aliases to create in this task, never unrelated page-history refs. For a stage that only updates properties of one existing node, include propertyEdit with tool set_properties, the exact ref, and the requested properties even if native evidence already matches. For edits, use the smallest plan that satisfies the request: a one-property change is one mutation on its existing target. Existing verified logicalRefs may be reused as acceptance evidence and do not each require a mutation. Do not add collateral refs or operations. Estimates are advisory and are not outstanding-operation requirements. Use exact inspected refs and their pageId. Do not replace or delete existing root frames. Work over 32 mutations continues in deterministic local segments; do not replan for that internal boundary. Preserve existing document styles/tokens and requested colors. No canvas edits in this call.",
  complete_canvas_stage:
    "Finish only the current saved stage after every required logicalRef and native operation is confirmed. Call alone. Previously verified existing edit targets may satisfy a required ref without a mutation; never mutate a layer only to satisfy a ref. The local controller reconciles missing creation, missing inspection, and invalid refs, then verifies actual native property values and editable geometry before completion. For failed operations, first obtain a confirmed repair using the same tool and logical ref, then include their original operation IDs in resolvedOperationIds. Never omit failed elements or replan. The result persists completion and identifies the next stage; continue automatically until all stages finish.",
  get_document_context:
    "Read current document/page identity, selection, tokens, and progressively scan accessible page trees in bounded yielding slices. Optionally pass a project/screen query or pageId to scope discovery. The native controller owns continuation, checkpoints, cancellation, and exact coverage reporting; never request repeated context calls or offset pagination for inspection. Multiple matches are valid for inspecting all frames, but ambiguous for editing one. Only a verified unique native target may be edited. No canvas edits are performed by this tool.",
  inspect_nodes: `Read-only inspection. Use at most ${INSPECT_NODES_LIMITS.refs} refs. pageId must be copied from document context when inspecting another page. depth is an integer from ${INSPECT_NODES_LIMITS.depth.min}–${INSPECT_NODES_LIMITS.depth.max} (default ${INSPECT_NODES_LIMITS.depth.default}); maxNodes is an integer from ${INSPECT_NODES_LIMITS.maxNodes.min}–${INSPECT_NODES_LIMITS.maxNodes.max} (default ${INSPECT_NODES_LIMITS.maxNodes.default}). Finite numbers outside either range are clamped locally. Invalid types and in-range fractions are rejected. Never inspect more than ${INSPECT_NODES_LIMITS.maxNodes.max} nodes. Set selection:true when refs is empty. Returns stable logical refs for follow-up edits. For INSPECTING requests, the plugin controller chooses targets and sequences operations; do not repeat inspection. A failed pre-plan inspection does not block a new design; existing-node edits still require successful inspection.`,
  create_frame:
    "Create one native editable frame. Omit x/y for safe non-overlapping page placement.",
  create_text:
    "Create editable text with a loaded/fallback font. For Persian, use right alignment; direction is an alignment hint and does not guarantee bidirectional shaping.",
  create_rectangle:
    "Create one bounded native rectangle with an optional solid fill or local paint style.",
  set_auto_layout:
    "Set Auto Layout on a frame/component and optionally normalize its direct children by logical ref.",
  set_properties:
    "Change only explicitly requested, allowlisted properties on an inspected/created logical ref.",
  append_child:
    "Append only a current page-root native node to a frame using logical refs. If it is already a direct child of that frame, the executor verifies a no-op; if it has another parent, this call is rejected. Never call inspect_nodes only to decide parent state and never use this to move a nested node.",
  reparent_node:
    "Explicitly move an inspected or current-task native node to a frame/component using logical refs when the requested task calls for that move. The executor rejects stale parent identity and cycles; it does not infer authorization from append_child.",
  get_operation_status: "Read the saved status of a prior operation by operation ID.",
};

function actionSchema(name: ChatToolName): z.ZodType {
  if (name === "classify_canvas_intent") return ChatCanvasIntentActionSchema;
  if (name === "plan_canvas_task") return ChatPlanActionSchema;
  if (name === "complete_canvas_stage") return ChatStageActionSchema;
  const schema = FigmaToolActionSchema.options.find((option) => option.shape.tool.value === name);
  if (!schema) throw new Error(`Missing action schema for ${name}.`);
  return schema;
}

function toolParameters(name: ChatToolName): Record<string, unknown> {
  const parameters = z.toJSONSchema(actionSchema(name), { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  delete parameters.$schema;
  const properties = parameters.properties as Record<string, unknown>;
  delete properties.tool;
  // Internal controller flag: native inspection calls set this after intent classification.
  delete properties.readOnlyInspection;
  delete properties.backgroundRootRef;
  if (Array.isArray(parameters.required))
    parameters.required = parameters.required.filter((field) => field !== "tool");
  if (name === "create_frame" || name === "create_rectangle")
    parameters.not = { required: ["fill", "paintStyleId"] };
  if (name === "set_properties") {
    const nested = properties.properties as Record<string, unknown>;
    nested.minProperties = 1;
    nested.not = { required: ["fill", "paintStyleId"] };
    nested.allOf = [
      {
        not: {
          required: ["textStyleId"],
          anyOf: [
            "fontSize",
            "color",
            "fontFamily",
            "fontStyle",
            "lineHeight",
            "letterSpacing",
            "align",
            "textAutoResize",
          ].map((field) => ({ required: [field] })),
        },
      },
    ];
  }
  return parameters;
}

export const CHAT_FUNCTION_TOOLS = CHAT_TOOL_NAMES.map((name) => ({
  type: "function",
  name,
  description: descriptions[name],
  parameters: toolParameters(name),
  strict: false,
}));

export function chatFunctionToolsForState(state: ChatLifecycleState) {
  const allowed = new Set<ChatToolName>(
    state === "INSPECTING"
      ? ["get_document_context", "inspect_nodes"]
      : state === "EDIT_TARGETING"
        ? ["get_document_context", "inspect_nodes"]
        : state === "EDIT_PLANNING"
          ? ["plan_canvas_task"]
      : state === "UNPLANNED"
      ? ["classify_canvas_intent", "get_document_context", "inspect_nodes", "plan_canvas_task"]
      : state === "EXECUTING_STAGE"
        ? CHAT_TOOL_NAMES.filter(
            (name) =>
              name !== "classify_canvas_intent" &&
              name !== "plan_canvas_task" &&
              name !== "get_document_context",
          )
      : state === "PLAN_SAVED" || state === "STAGE_COMPLETED"
        ? CHAT_TOOL_NAMES.filter(
            (name) =>
              name !== "classify_canvas_intent" &&
              name !== "plan_canvas_task" &&
                name !== "get_document_context" &&
                name !== "complete_canvas_stage",
            )
          : state === "VERIFYING_STAGE"
            ? ["inspect_nodes", "get_operation_status", "set_auto_layout", "set_properties"]
            : ["inspect_nodes", "get_operation_status"],
  );
  return CHAT_FUNCTION_TOOLS.filter(({ name }) => allowed.has(name));
}

export const ChatFunctionCallValidationIssueSchema = z
  .object({
    toolName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,80}$/u)
      .optional(),
    callId: CallIdSchema.optional(),
    stage: z.enum(["call_item", "call_id", "arguments_json", "arguments_schema", "call_set"]),
    errorCode: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/u),
    receivedType: z.enum(["null", "boolean", "number", "string", "array", "object"]).optional(),
    receivedNumber: z
      .string()
      .regex(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u)
      .max(40)
      .optional(),
    fieldPaths: z
      .array(z.string().regex(/^[A-Za-z0-9_.:/()-]{1,160}$/u))
      .min(1)
      .max(10),
  })
  .strict();
export type ChatFunctionCallValidationIssue = z.infer<typeof ChatFunctionCallValidationIssueSchema>;

export class ChatFunctionCallValidationError extends Error {
  constructor(readonly validationIssues: ChatFunctionCallValidationIssue[]) {
    const first = validationIssues[0];
    super(
      first?.errorCode === "unsupported_wrapper"
        ? "The model returned an unsupported function-call wrapper."
        : first?.errorCode === "duplicate_call_id"
          ? "The model returned duplicate function-call IDs."
          : first?.errorCode === "unknown_tool"
            ? "The model requested a function that is not allowlisted."
            : first
              ? `The model returned an invalid function call (${first.errorCode} at ${first.fieldPaths.join(", ")}).`
              : "The model returned an invalid function call.",
    );
    this.name = "ChatFunctionCallValidationError";
  }
}

export function parseResponsesFunctionCalls(output: unknown): ChatFunctionCall[] {
  if (!Array.isArray(output)) return [];
  if (output.some((item) => isRecord(item) && item.type === "call_set"))
    throw new ChatFunctionCallValidationError([
      {
        stage: "call_item",
        errorCode: "unsupported_wrapper",
        fieldPaths: ["type"],
      },
    ]);
  const functionItems = output.filter((item) => isRecord(item) && item.type === "function_call");
  const issues: ChatFunctionCallValidationIssue[] = [];
  if (functionItems.length > 10)
    throw new ChatFunctionCallValidationError([
      {
        stage: "call_set",
        errorCode: "too_many_calls",
        fieldPaths: ["calls"],
      },
    ]);
  const calls: ChatFunctionCall[] = [];
  for (const item of functionItems) {
    if (!isRecord(item)) continue;
    const nameResult = ChatToolNameSchema.safeParse(item.name);
    const toolName =
      typeof item.name === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(item.name)
        ? item.name
        : undefined;
    if (!nameResult.success) {
      issues.push({
        ...(toolName ? { toolName } : {}),
        ...(validCallId(item.call_id) ? { callId: item.call_id } : {}),
        stage: "call_item",
        errorCode: "unknown_tool",
        fieldPaths: ["name"],
      });
      continue;
    }
    const callIdResult = CallIdSchema.safeParse(item.call_id);
    if (!callIdResult.success) {
      issues.push({
        toolName: nameResult.data,
        stage: "call_id",
        errorCode: "invalid_call_id",
        fieldPaths: ["call_id"],
      });
      continue;
    }
    if (typeof item.arguments !== "string" || item.arguments.length > 24_000) {
      issues.push({
        toolName: nameResult.data,
        callId: callIdResult.data,
        stage: "arguments_json",
        errorCode: "invalid_arguments",
        fieldPaths: ["arguments"],
      });
      continue;
    }
    let args: unknown;
    try {
      args = JSON.parse(item.arguments) as unknown;
    } catch {
      issues.push({
        toolName: nameResult.data,
        callId: callIdResult.data,
        stage: "arguments_json",
        errorCode: "malformed_json",
        fieldPaths: ["arguments"],
      });
      continue;
    }
    if (!isRecord(args)) {
      issues.push({
        toolName: nameResult.data,
        callId: callIdResult.data,
        stage: "arguments_schema",
        errorCode: "expected_object",
        fieldPaths: ["arguments"],
      });
      continue;
    }
    if (Object.hasOwn(args, "tool")) {
      issues.push({
        toolName: nameResult.data,
        callId: callIdResult.data,
        stage: "arguments_schema",
        errorCode: "unsupported_field",
        fieldPaths: ["arguments.tool"],
      });
      continue;
    }
    const normalizedPlan =
      nameResult.data === "plan_canvas_task" ? normalizePlanArguments(args) : args;
    const normalizedInspection =
      nameResult.data === "inspect_nodes"
        ? normalizeInspectArguments(args)
        : { args: normalizedPlan, changed: false };
    const normalized =
      nameResult.data === "inspect_nodes" ? normalizedInspection.args : normalizedPlan;
    const actionInput = { ...normalized, tool: nameResult.data };
    const actionResult = actionSchema(nameResult.data).safeParse(actionInput);
    if (!actionResult.success) {
      issues.push(
        ...validationIssues(actionResult.error, nameResult.data, callIdResult.data, args),
      );
      continue;
    }
    const callResult = ChatFunctionCallSchema.safeParse({
      callId: callIdResult.data,
      name: nameResult.data,
      action: actionResult.data,
      ...(nameResult.data === "plan_canvas_task" &&
      JSON.stringify(normalized) !== JSON.stringify(args)
        ? { normalizedPlanningMetadata: true }
        : {}),
      ...(nameResult.data === "inspect_nodes" && normalizedInspection.changed
        ? { normalizedInspectionParameters: true }
        : {}),
      functionCall: {
        type: "function_call",
        call_id: callIdResult.data,
        name: nameResult.data,
        arguments: item.arguments,
      },
    });
    if (!callResult.success) {
      issues.push(...validationIssues(callResult.error, nameResult.data, callIdResult.data, args));
      continue;
    }
    calls.push(callResult.data);
  }
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.callId))
      issues.push({
        toolName: call.name,
        callId: call.callId,
        stage: "call_set",
        errorCode: "duplicate_call_id",
        fieldPaths: ["call_id"],
      });
    seen.add(call.callId);
  }
  if (issues.length) throw new ChatFunctionCallValidationError(issues.slice(0, 80));
  return calls;
}

function validationIssues(
  error: z.ZodError,
  toolName: ChatToolName,
  callId: string,
  args?: Record<string, unknown>,
): ChatFunctionCallValidationIssue[] {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.map(safePathSegment).filter(Boolean).join(".");
    const basePath = path ? `arguments.${path}` : "arguments";
    const unknownKeys = "keys" in issue && Array.isArray(issue.keys) ? issue.keys : [];
    const fieldPaths = unknownKeys.length
      ? unknownKeys.map((key) => `${basePath}.${safePathSegment(key)}`).slice(0, 8)
      : path
        ? [basePath]
        : validationRootPaths(issue.message);
    const errorCode =
      typeof issue.code === "string" && /^[A-Za-z0-9_.-]{1,60}$/u.test(issue.code)
        ? issue.code
        : "schema_validation";
    const inspectedParameter =
      toolName === "inspect_nodes" && (issue.path[0] === "maxNodes" || issue.path[0] === "depth")
        ? issue.path[0]
        : undefined;
    const received = inspectedParameter ? args?.[inspectedParameter] : undefined;
    return {
      toolName,
      callId,
      stage: "arguments_schema",
      errorCode,
      fieldPaths: fieldPaths.length ? fieldPaths : ["arguments"],
      ...(inspectedParameter && received !== undefined
        ? {
            receivedType:
              received === null
                ? "null"
                : Array.isArray(received)
                  ? "array"
                  : (typeof received as "boolean" | "number" | "object" | "string"),
            ...(typeof received === "number" && Number.isFinite(received)
              ? { receivedNumber: String(received) }
              : {}),
          }
        : {}),
    };
  });
}

function validationRootPaths(message: string): string[] {
  switch (message) {
    case "Choose a fill color or a local paint style.":
      return ["arguments.fill", "arguments.paintStyleId"];
    case "At least one property is required.":
      return ["arguments.properties"];
    case "Choose a text style or explicit typography changes.":
      return [
        "arguments.properties.textStyleId",
        "arguments.properties.fontSize",
        "arguments.properties.color",
        "arguments.properties.fontFamily",
        "arguments.properties.fontStyle",
        "arguments.properties.lineHeight",
        "arguments.properties.letterSpacing",
        "arguments.properties.align",
        "arguments.properties.textAutoResize",
      ];
    case "Choose refs or current selection.":
      return ["arguments.refs", "arguments.selection"];
    default:
      return ["arguments"];
  }
}

function safePathSegment(value: unknown): string {
  const segment = String(value);
  return /^[A-Za-z0-9_-]{1,60}$/u.test(segment) ? segment : "unknown";
}

function validCallId(value: unknown): value is string {
  return typeof value === "string" && CallIdSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
