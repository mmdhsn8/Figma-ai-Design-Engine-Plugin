import { Fragment, useMemo, useState } from "react";
import { chatHistoryMatchesQuery, type ChatHistoryConversation } from "../shared/chat-history";

export function ChatHistoryView({
  conversations,
  activeChatId,
  canSwitch,
  disabledReason,
  loading = false,
  loadError = "",
  corruptRecordCount = 0,
  onNew,
  onOpen,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
}: {
  conversations: ChatHistoryConversation[];
  activeChatId: string | null;
  canSwitch: boolean;
  disabledReason?: string;
  loading?: boolean;
  loadError?: string;
  corruptRecordCount?: number;
  onNew: () => void;
  onOpen: (conversation: ChatHistoryConversation) => void;
  onRename: (conversation: ChatHistoryConversation, title: string) => void;
  onDuplicate: (conversation: ChatHistoryConversation) => void;
  onExport: (conversation: ChatHistoryConversation) => void;
  onDelete: (conversation: ChatHistoryConversation) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const filtered = useMemo(
    () =>
      conversations
        .filter((conversation) => chatHistoryMatchesQuery(conversation, query))
        .sort(
          (first, second) =>
            safeDate(second.updatedAt).getTime() - safeDate(first.updatedAt).getTime(),
        ),
    [conversations, query],
  );
  const groups = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 24 * 60 * 60 * 1000;
    const grouped = new Map<string, ChatHistoryConversation[]>();
    for (const conversation of filtered) {
      const group =
        safeDate(conversation.updatedAt).getTime() >= today
          ? "Today"
          : safeDate(conversation.updatedAt).getTime() >= yesterday
            ? "Yesterday"
            : "Earlier";
      const entries = grouped.get(group) ?? [];
      entries.push(conversation);
      grouped.set(group, entries);
    }
    return ["Today", "Yesterday", "Earlier"]
      .filter((group) => grouped.has(group))
      .map((title) => ({ title, conversations: grouped.get(title)! }));
  }, [filtered]);

  return (
    <section className="route-page history-page" aria-labelledby="route-heading">
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">SAVED LOCALLY IN THIS FIGMA DOCUMENT</span>
          <h1 id="route-heading" tabIndex={-1}>
            Chat History
          </h1>
          <p className="page-description">
            Each chat keeps its own messages and resumable task checkpoint.
          </p>
        </div>
        <button className="primary-action" type="button" onClick={onNew} disabled={!canSwitch}>
          New Chat
        </button>
      </div>
      {!canSwitch && disabledReason && (
        <p className="history-lock-note" role="status">
          {disabledReason}
        </p>
      )}
      {corruptRecordCount > 0 && (
        <p className="history-integrity-note" role="status">
          {corruptRecordCount} saved history record{corruptRecordCount === 1 ? " needs" : "s need"}{" "}
          recovery. Valid chats remain available; unreconciled data is preserved in this document.
        </p>
      )}
      {loadError && (
        <p className="history-load-error" role="alert">
          Saved chats could not be loaded: {loadError}
        </p>
      )}
      <label className="history-search">
        <span className="sr-only">Search chats</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
        />
      </label>
      {loading ? (
        <div className="history-empty" role="status">
          <span className="empty-orb" aria-hidden="true">
            ◌
          </span>
          <h2>Loading saved chats</h2>
          <p>Reading this document's local conversation index.</p>
        </div>
      ) : filtered.length ? (
        <>
          <p className="history-count" role="status" aria-live="polite">
            Showing {filtered.length} of {conversations.length} saved chat
            {conversations.length === 1 ? "" : "s"}
          </p>
          <ul className="history-list">
            {groups.map((group) => (
              <Fragment key={group.title}>
                <li className="history-group-heading">
                  <h2>{group.title}</h2>
                </li>
                {group.conversations.map((conversation) => {
                  const firstPrompt = conversation.messages.find(
                    ({ role }) => role === "user",
                  )?.content;
                  const active = conversation.id === activeChatId;
                  const editing = editingId === conversation.id;
                  return (
                    <li key={conversation.id}>
                      <article className={`history-card ${active ? "is-active" : ""}`}>
                        <div className="history-card-top">
                          {editing ? (
                            <form
                              className="history-rename"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const next = title.trim();
                                if (next) onRename(conversation, next);
                                setEditingId(null);
                              }}
                            >
                              <label className="sr-only" htmlFor={`rename-${conversation.id}`}>
                                Chat title
                              </label>
                              <input
                                id={`rename-${conversation.id}`}
                                dir="auto"
                                maxLength={120}
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                autoFocus
                              />
                              <button
                                className="secondary-action"
                                type="submit"
                                disabled={!canSwitch || !title.trim()}
                              >
                                Save
                              </button>
                              <button
                                className="text-button muted"
                                type="button"
                                onClick={() => setEditingId(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <h2 dir="auto">{conversation.title}</h2>
                          )}
                          <span className={`history-state is-${conversation.taskState}`}>
                            {conversation.taskState === "running"
                              ? active
                                ? "Current · Needs recovery"
                                : "Needs recovery"
                              : active
                                ? "Current"
                                : conversation.taskState}
                          </span>
                        </div>
                        <p className="history-preview" dir="auto">
                          {firstPrompt || "No messages yet"}
                        </p>
                        <div className="history-meta">
                          <time dateTime={safeTimestamp(conversation.updatedAt)} dir="ltr">
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(safeDate(conversation.updatedAt))}
                          </time>
                          <span>{conversation.messages.length} messages</span>
                          {conversation.model && (
                            <span title={conversation.model} dir="ltr">
                              {conversation.model}
                            </span>
                          )}
                        </div>
                        <div className="history-actions">
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={!canSwitch || active}
                            onClick={() => onOpen(conversation)}
                          >
                            Open
                          </button>
                          {!editing && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={!canSwitch}
                              onClick={() => {
                                setTitle(conversation.title);
                                setEditingId(conversation.id);
                              }}
                            >
                              Rename
                            </button>
                          )}
                          <button
                            type="button"
                            className="text-button"
                            disabled={!canSwitch}
                            onClick={() => onDuplicate(conversation)}
                          >
                            Duplicate
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onExport(conversation)}
                          >
                            Export
                          </button>
                          <button
                            type="button"
                            className="text-button danger-text"
                            disabled={!canSwitch}
                            onClick={() => onDelete(conversation)}
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </Fragment>
            ))}
          </ul>
        </>
      ) : (
        <div className="history-empty">
          <span className="empty-orb" aria-hidden="true">
            ✦
          </span>
          <h2>
            {loadError
              ? "History is unavailable"
              : query
                ? "No matching chats"
                : "Your design conversations will appear here"}
          </h2>
          <p>
            {loadError
              ? "Reload the plugin to retry reading this document's saved conversation index."
              : query
                ? "Try a different title or message."
                : "Start a new chat to create a saved conversation and a document-scoped task checkpoint."}
          </p>
          {!query && !loadError && (
            <button className="primary-action" type="button" onClick={onNew} disabled={!canSwitch}>
              Start New Chat
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function safeDate(timestamp: number): Date {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function safeTimestamp(timestamp: number): string {
  return safeDate(timestamp).toISOString();
}
