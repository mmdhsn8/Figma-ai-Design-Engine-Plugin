import { z } from "zod";

export const CHAT_HISTORY_MAX_CHATS = 40;
export const CHAT_HISTORY_MAX_MESSAGES = 80;
export const CHAT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

export const ChatHistoryChatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u);

export const ChatHistoryMessageSchema = z
  .object({
    id: z.string().min(1).max(100),
    role: z.enum(["user", "assistant"]),
    content: z.string().max(8_000),
    error: z.string().max(1_500).optional(),
  })
  .strict();

export const ChatHistoryConversationSchema = z
  .object({
    id: ChatHistoryChatIdSchema,
    title: z.string().min(1).max(120),
    createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    model: z.string().max(100).optional(),
    taskId: ChatHistoryChatIdSchema.optional(),
    taskState: z.enum(["new", "ready", "running", "stopped", "failed", "completed"]),
    messages: z.array(ChatHistoryMessageSchema).max(CHAT_HISTORY_MAX_MESSAGES),
  })
  .strict();

export const ChatHistoryIndexSchema = z
  .object({
    version: z.literal(1),
    activeChatId: ChatHistoryChatIdSchema.nullable(),
    conversations: z.array(ChatHistoryConversationSchema).max(CHAT_HISTORY_MAX_CHATS),
  })
  .strict()
  .superRefine((history, context) => {
    const ids = new Set<string>();
    for (const [index, conversation] of history.conversations.entries()) {
      if (ids.has(conversation.id))
        context.addIssue({
          code: "custom",
          path: ["conversations", index, "id"],
          message: "Conversation IDs must be unique.",
        });
      ids.add(conversation.id);
    }
    if (history.activeChatId && !ids.has(history.activeChatId))
      context.addIssue({
        code: "custom",
        path: ["activeChatId"],
        message: "The active chat must exist in this history index.",
      });
  });

export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;
export type ChatHistoryConversation = z.infer<typeof ChatHistoryConversationSchema>;
export type ChatHistoryIndex = z.infer<typeof ChatHistoryIndexSchema>;

export function emptyChatHistory(): ChatHistoryIndex {
  return { version: 1, activeChatId: null, conversations: [] };
}

export function chatHistoryTitle(messages: ChatHistoryMessage[]): string {
  const first = messages.find(({ role, content }) => role === "user" && content.trim());
  if (!first) return "New chat";
  const line = first.content.trim().split(/\r?\n/u, 1)[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 69).trimEnd()}…` : line;
}

export function chatHistoryMatchesQuery(
  conversation: ChatHistoryConversation,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    !normalized ||
    [conversation.title, ...conversation.messages.map(({ content }) => content)]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized)
  );
}

export function newChatHistoryConversation(
  id: string,
  now: number,
  model?: string,
): ChatHistoryConversation {
  return {
    id,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    ...(model ? { model: model.slice(0, 100) } : {}),
    taskState: "new",
    messages: [],
  };
}

export function renameChatHistoryConversation(
  conversation: ChatHistoryConversation,
  title: string,
  updatedAt: number,
): ChatHistoryConversation {
  return { ...conversation, title: title.trim().slice(0, 120), updatedAt };
}

export function duplicateChatHistoryConversation(
  conversation: ChatHistoryConversation,
  id: string,
  now: number,
): ChatHistoryConversation {
  return {
    id,
    title: `${conversation.title} (copy)`.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    ...(conversation.model ? { model: conversation.model } : {}),
    taskState: "new",
    messages: conversation.messages.map((message, index) => ({ ...message, id: `${id}-${index}` })),
  };
}

export function chatHistoryExportJson(conversation: ChatHistoryConversation): string {
  return JSON.stringify(
    {
      version: 1,
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      model: conversation.model,
      taskState: conversation.taskState,
      messages: conversation.messages,
    },
    null,
    2,
  );
}
