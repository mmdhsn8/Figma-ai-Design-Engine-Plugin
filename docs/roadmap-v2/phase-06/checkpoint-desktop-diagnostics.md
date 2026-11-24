# Phase 6 Desktop checkpoint diagnostics

1. Build the project and run `npm run verify:phase5` to check the registered manifest. In Figma Desktop, open an authorized disposable Design file. Run the development plugin with **Use Developer VM** disabled. Open **Plugins → Development → Open Console** and filter for `[FAD_CHECKPOINT]`.
2. Use the storage-only probe below from the plugin UI iframe's console context. Run `phase6CheckpointProbe()` once. Record its synthetic chat ID and the receipt's hash and byte count. The probe creates one isolated checkpoint with ten pending stages and about 220 KB of synthetic context. It invokes no model, renderer, or History operation.
3. Close and relaunch the development plugin on the same page. Paste the probe again and run `phase6CheckpointProbe("phase6-probe-…")` with the recorded ID. The reload must report the same hash and byte count, the same task ID, and ten stages. A second write with a new revision can be checked on a new disposable probe ID. Keep all saved records intact.
4. Once the storage probe passes, test the actual Chat bridge on the disposable file with a one-screen task. Check for `ui post → controller received → write_start → write_end → read_back_end (match) → ack_posted → ui ack_received → confirmed`. If testing resume, stop at a saved boundary, reopen the plugin on the same page and resume that same chat. Confirm the same task and native root are reused. Verify this sequence before trying ten screens.

If the failing chat can be opened without resuming, its ordinary load trace can be captured separately. Run **Retry storage recovery** on that chat only when canvas changes on its original page are authorized, since a confirmed save can let execution continue.

## Storage-only probe

Paste into the running plugin UI iframe's console. It uses the production message handler and storage path. The subsequent one-screen run exercises the production UI bridge itself.

```js
async function phase6CheckpointProbe(existingChatId) {
  const chatId = existingChatId ?? "phase6-probe-" + Date.now().toString(36);
  const send = (message) => new Promise((resolve, reject) => {
    const requestId = "phase6-probe-" + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("No probe reply. Inspect the checkpoint trace."));
    }, 15000);
    function receive(event) {
      const result = event.data?.pluginMessage;
      if (result?.requestId !== requestId || !["chat-task-result", "plugin-runtime-handshake-result", "protocol-error"].includes(result.type)) return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (result.success || result.compatible) resolve(result);
      else reject(new Error(result.errorCode ?? (message.type === "plugin-runtime-handshake" ? "checkpoint_build_mismatch" : "checkpoint_failed")));
    }
    window.addEventListener("message", receive);
    const scope = message.type === "plugin-runtime-handshake" ? {} : { chatId };
    parent.postMessage({ pluginMessage: { ...message, ...scope, requestId } }, "*");
  });
  const buildId = window.__fadBuildId;
  if (!buildId) throw new Error("Use the current plugin UI iframe console.");
  const runtime = await send({ type: "plugin-runtime-handshake", protocolVersion: 1, buildId });
  if (runtime.uiBuildId !== buildId || runtime.pluginBuildId !== buildId) throw new Error("checkpoint_build_mismatch");
  const loaded = await send({ type: "chat-task-load" });
  const { documentId } = loaded;
  if (existingChatId || loaded.task) {
    if (!loaded.task) throw new Error("Checkpoint missing after reload.");
    return { chatId, taskId: loaded.task.id, stages: loaded.task.stages.length, ...loaded.revision };
  }
  const task = {
    version: 1, id: chatId, chatId, documentId, intent: "create",
    executionRoute: "universal-design-v1", prompt: "Synthetic storage probe",
    context: Array.from({ length: 28 }, () => ({ role: "user", content: "x".repeat(7900) })),
    stages: Array.from({ length: 10 }, (_, i) => ({
      title: "Probe stage " + (i + 1), completed: false, operations: 0,
    })),
    ledger: [], pending: [], recent: [], starts: [], rounds: 0, status: "ready", text: "",
  };
  const saved = await send({ type: "chat-task-save", documentId, task });
  const confirmed = await send({ type: "chat-task-load", documentId, confirm: saved.revision });
  if (confirmed.revision?.hash !== saved.revision?.hash ||
      confirmed.revision?.bytes !== saved.revision?.bytes || !saved.revision)
    throw new Error("Checkpoint revision mismatch.");
  return { chatId, taskId: task.id, stages: task.stages.length, ...saved.revision };
}
```

## Reading the trace

| Trace pattern | What it shows |
| --- | --- |
| UI `post` with no controller `received` | The request did not reach the observed controller. Check the selected console and registered build. |
| `storage_error` in phase `write` | Figma rejected the write. `quota: true` identifies an apparent storage quota rejection. Keep the records intact. |
| `write_start` with no `write_end` | The write was still pending or the controller stopped. |
| `read_back_end` with `present: false` or a different hash | The read returned a missing value or different revision after the write resolved. Inspect nearby writes with the same `keyHash`. |
| Matching `read_back_end` and `ack_posted` with no UI `ack_received` | Storage was confirmed in the controller. The UI did not observe the acknowledgement. |
| UI `confirm_received` with the expected hash and size, followed by `confirmed` | Recovery confirmed the saved revision without replaying the write. |

Export only the `[FAD_CHECKPOINT]` lines. They contain hashed identifiers, content revisions, byte counts, timestamps, phases, and result codes. Compare `correlation` between the UI and controller, and join recovery reads using the UI's `readCorrelation` field.
