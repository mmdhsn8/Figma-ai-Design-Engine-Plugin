import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import {
  DraftManifestSchema,
  MAX_PROJECT_BYTES,
  validateDraftSection,
  validateDraftScreen,
  type SavedDraft,
} from "../shared/generation-draft";
import { COMPANION_URL, CompanionClientError } from "./companion-client";

export function generationBridge(
  message: Extract<
    UIToPluginMessage,
    {
      type:
        | "generation-context"
        | "generation-remember"
        | "generation-render"
        | "generation-select"
        | "generation-prepare"
        | "generation-apply-section";
    }
  >,
  onNodeProgress?: (nodeId: string, elapsedMs: number) => void,
) {
  return new Promise<
    Extract<import("../shared/messages").PluginToUIMessage, { type: "generation-result" }>
  >((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (!parsed.success) return;
      if (parsed.data.type === "generation-node-progress") {
        if (parsed.data.requestId !== message.requestId) return;
        onNodeProgress?.(parsed.data.nodeId, parsed.data.elapsedMs);
        return;
      }
      if (parsed.data.type !== "generation-result" || parsed.data.requestId !== message.requestId)
        return;
      finish();
      if (!parsed.data.success)
        reject(new Error(parsed.data.error ?? "Figma operation failed; checkpoint retained."));
      else resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(
        new Error(
          "Figma bridge did not acknowledge within 60 seconds. Resume to reconcile; do not manually import a second copy.",
        ),
      );
    }, 60_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: message }, "*");
  });
}

export async function draftRequest(
  token: string,
  documentId: string,
  action: string,
  fields: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 30_000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await draftRequestInternal(token, documentId, action, fields, controller.signal);
  } catch (error) {
    if (signal?.aborted) throw new CompanionClientError("request_cancelled");
    if (controller.signal.aborted)
      throw new Error(
        "Persistence exceeded its 30-second deadline. Resume to recover committed screens; do not assume the write failed.",
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function draftRequestInternal(
  token: string,
  documentId: string,
  action: string,
  fields: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${COMPANION_URL}/v1/draft`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ documentId, action, ...fields }),
    signal,
  });
  if (!response.body) throw new Error("Draft storage returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_PROJECT_BYTES + 1024 * 1024)
        throw new Error("Saved project exceeds the 64 MiB recovery limit.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const result = JSON.parse(text);
    if (!response.ok)
      throw new Error(
        `Persistence: ${typeof result.error === "string" && /^[a-zA-Z0-9_]+$/u.test(result.error) ? result.error : "draft_storage_failed"}. Previously committed screens remain saved. Check local disk space and the documented quota; restore a recovery export or explicitly delete only this draft if its manifest is corrupt.`,
      );
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function loadSavedDraft(
  token: string,
  documentId: string,
): Promise<SavedDraft | null> {
  const result = (await draftRequest(token, documentId, "load")) as { draft?: SavedDraft | null };
  if (!result.draft) return null;
  const manifest = DraftManifestSchema.parse(result.draft.manifest);
  if (manifest.documentId !== documentId)
    throw new Error("Saved draft belongs to another document.");
  return {
    manifest,
    screens: result.draft.screens.map((record) => ({
      ...record,
      design: validateDraftScreen(manifest, record.design),
    })),
    transactions: (result.draft.transactions ?? []).map((record) => ({
      ...record,
      ...validateDraftSection(manifest, record.transaction, record.design),
    })),
    warnings: result.draft.warnings,
  };
}

export async function importSavedDraft(
  token: string,
  documentId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const value = input as SavedDraft;
  const manifest = DraftManifestSchema.parse(value.manifest);
  const transactions = Array.isArray(value.transactions) ? value.transactions : [];
  if (
    manifest.documentId !== documentId ||
    !Array.isArray(value.screens) ||
    value.screens.length > 400 ||
    transactions.length > 1_200
  )
    throw new Error(
      "Recovery file belongs to another document/page or has an invalid screen count.",
    );
  const designs = value.screens.map((record) => validateDraftScreen(manifest, record.design));
  const sections = transactions.map((record) =>
    validateDraftSection(manifest, record.transaction, record.design),
  );
  await draftRequest(token, documentId, "start", { manifest }, signal);
  const sectionScreenIds = new Set(sections.map(({ transaction }) => transaction.screen_id));
  for (const section of sections)
    await draftRequest(
      token,
      documentId,
      "save-section",
      {
        generationId: manifest.generationId,
        transaction: section.transaction,
        design: section.design,
      },
      signal,
    );
  for (const design of designs.filter((item) => !sectionScreenIds.has(item.screens[0]!.id)))
    await draftRequest(
      token,
      documentId,
      "save-screen",
      {
        generationId: manifest.generationId,
        design,
      },
      signal,
    );
}
