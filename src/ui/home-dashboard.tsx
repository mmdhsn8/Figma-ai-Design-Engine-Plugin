import type { ChatHistoryConversation } from "../shared/chat-history";

export function HomeDashboard({
  connection,
  model,
  recentChats,
  taskSummary,
  taskState,
  canOpenChats,
  onStartChat,
  onNavigate,
  onOpenChat,
}: {
  connection: string;
  model: string;
  recentChats: ChatHistoryConversation[];
  taskSummary?: string;
  taskState?: string;
  canOpenChats: boolean;
  onStartChat: () => void;
  onNavigate: (view: "history" | "brand-kit" | "skills" | "system" | "design") => void;
  onOpenChat: (conversation: ChatHistoryConversation) => void;
}) {
  return (
    <section className="route-page home-page" aria-labelledby="route-heading">
      <section className="hero-card">
        <span className="hero-glow" aria-hidden="true" />
        <span className="page-eyebrow">IDEA TO EDITABLE FIGMA</span>
        <h1 id="route-heading" tabIndex={-1}>
          Design with clarity.
        </h1>
        <p>
          Turn a brief into structured, editable native Figma screens—with confirmed progress and
          safe recovery.
        </p>
        <button className="primary-action hero-action" type="button" onClick={onStartChat}>
          Start New Chat <span aria-hidden="true">↗</span>
        </button>
        <div className="hero-model-row">
          <span className="connection-dot" aria-hidden="true" />
          <span>{connection}</span>
          <span aria-hidden="true">·</span>
          <span className="home-model" title={model}>
            {model}
          </span>
        </div>
      </section>

      {taskSummary && (
        <section className="home-task-card" aria-label="Recent task status">
          <div>
            <span className="section-kicker">CURRENT TASK · {taskState ?? "SAVED"}</span>
            <p>{taskSummary}</p>
          </div>
          <button className="text-button" type="button" onClick={() => onNavigate("history")}>
            View history
          </button>
        </section>
      )}

      <section className="quick-access" aria-labelledby="quick-access-title">
        <div className="section-title-row">
          <h2 id="quick-access-title">Quick access</h2>
          <span className="section-caption">WORKSPACE</span>
        </div>
        <div className="quick-grid">
          {[
            {
              key: "history" as const,
              icon: "◷",
              title: "Chat History",
              detail: "Reopen a saved task",
            },
            { key: "brand-kit" as const, icon: "◈", title: "Brand Kit", detail: "Brand workspace" },
            { key: "skills" as const, icon: "✧", title: "Skills", detail: "Local guidance" },
            {
              key: "system" as const,
              icon: "▧",
              title: "Design System",
              detail: "Document tokens",
            },
          ].map((item) => (
            <button
              className="quick-card"
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
            >
              <span className="quick-icon" aria-hidden="true">
                {item.icon}
              </span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="recent-section" aria-labelledby="recent-title">
        <div className="section-title-row">
          <h2 id="recent-title">Recent chats</h2>
          <button className="text-button" type="button" onClick={() => onNavigate("history")}>
            View all
          </button>
        </div>
        {recentChats.length ? (
          <ul className="home-recent-list">
            {recentChats.slice(0, 3).map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  disabled={!canOpenChats}
                  onClick={() => onOpenChat(conversation)}
                >
                  <span className="recent-chat-icon" aria-hidden="true">
                    ✦
                  </span>
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>
                      {conversation.taskState} · {conversation.messages.length} messages
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="recent-empty-state">
            <span className="recent-empty-icon" aria-hidden="true">
              ◷
            </span>
            <strong>No saved chats yet</strong>
            <span>Start a chat to keep its conversation and checkpoint on this Figma page.</span>
          </div>
        )}
      </section>

      <section className="home-promo-card">
        <div>
          <span className="section-kicker">NATIVE FIRST</span>
          <strong>Keep your workflow editable.</strong>
          <p>
            Generation is gated by a live authorized model check. Persian prompts and RTL canvas
            output remain supported.
          </p>
        </div>
        <button type="button" className="secondary-action" onClick={() => onNavigate("design")}>
          Generation options
        </button>
      </section>
    </section>
  );
}
