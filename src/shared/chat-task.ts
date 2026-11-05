import { z } from "zod";
import { ChatFunctionCallSchema, ChatInputItemSchema } from "./chat-tools.js";

export const CHAT_TASK_MAX_OPERATIONS = 240;
export const CHAT_STAGE_MAX_OPERATIONS = 32;
export const CHAT_TASK_MAX_BYTES = 512 * 1024;

export const ChatTaskSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    documentId: z.string().min(1).max(300),
    prompt: z.string().min(1).max(8_000),
    context: z.array(ChatInputItemSchema).max(28),
    stages: z
      .array(
        z
          .object({
            title: z.string().min(1).max(160),
            completed: z.boolean(),
            operations: z.number().int().min(0).max(CHAT_STAGE_MAX_OPERATIONS),
            rounds: z.number().int().min(0).max(8),
          })
          .strict(),
      )
      .max(12),
    ledger: z
      .array(
        z
          .object({
            call: ChatFunctionCallSchema,
            operationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
            stage: z.number().int().min(0).max(11),
            status: z.enum(["pending", "running", "completed", "failed", "repaired"]),
            output: z.string().max(8_000).optional(),
          })
          .strict(),
      )
      .max(CHAT_TASK_MAX_OPERATIONS),
    pending: z.array(ChatFunctionCallSchema).max(10),
    recent: z.array(ChatInputItemSchema).max(20),
    starts: z.array(z.number().int().nonnegative()).max(40),
    rounds: z.number().int().min(0).max(100),
    batches: z.number().int().min(0).max(1_000).default(0),
    lastResponseCalls: z.number().int().min(0).max(10).default(0),
    status: z.enum(["ready", "running", "stopped", "failed", "completed"]),
    text: z.string().max(8_000),
    error: z.string().max(500).optional(),
  })
  .strict();

export type ChatTask = z.infer<typeof ChatTaskSchema>;

export function chatTaskProgress(task: ChatTask): string {
  const completed = task.stages.filter((stage) => stage.completed).length;
  const confirmed = task.ledger.filter((entry) => entry.status === "completed").length;
  const stage = task.stages.find((item) => !item.completed);
  return `${completed}/${task.stages.length} stages completed · ${task.stages.length - completed} pending · ${confirmed} operations confirmed${stage ? ` · ${stage.title}` : ""}`;
}
