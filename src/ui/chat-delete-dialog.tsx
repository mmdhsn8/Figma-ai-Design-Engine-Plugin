import { useEffect, useRef } from "react";
import type { ChatHistoryConversation } from "../shared/chat-history";

export function ChatDeleteDialog({
  conversation,
  busy,
  error = "",
  onCancel,
  onConfirm,
}: {
  conversation: ChatHistoryConversation | "all";
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!controls?.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-chat-title"
        aria-describedby="delete-chat-description"
      >
        <span className="page-eyebrow">DELETE CHAT DATA</span>
        <h2 id="delete-chat-title">
          {conversation === "all" ? "Delete all saved chats?" : `Delete “${conversation.title}”?`}
        </h2>
        <p id="delete-chat-description">
          {conversation === "all"
            ? "This permanently removes all saved chats and their checkpoints for this Figma page, including chats hidden by search. Existing canvas layers are kept."
            : "This permanently removes the conversation and its saved checkpoint. Existing canvas layers are kept."}
        </p>
        {error && <p className="history-load-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button
            ref={cancelButton}
            className="secondary-action"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="danger-action" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting chat data…" : conversation === "all" ? "Delete All" : "Delete chat data"}
          </button>
        </div>
      </section>
    </div>
  );
}
