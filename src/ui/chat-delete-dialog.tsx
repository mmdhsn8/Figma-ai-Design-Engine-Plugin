import { useEffect, useRef } from "react";
import type { ChatHistoryConversation } from "../shared/chat-history";

export function ChatDeleteDialog({
  conversation,
  busy,
  onCancel,
  onConfirm,
}: {
  conversation: ChatHistoryConversation;
  busy: boolean;
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
        <h2 id="delete-chat-title">Delete “{conversation.title}”?</h2>
        <p id="delete-chat-description">
          This removes the conversation and its saved checkpoint from this document. Existing Figma
          canvas layers are not deleted. A task checkpoint marked as running cannot be deleted.
        </p>
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
            {busy ? "Deleting chat data…" : "Delete chat data"}
          </button>
        </div>
      </section>
    </div>
  );
}
