import { chatTaskSafeDiagnostic, type ChatTask } from "../shared/chat-task";

type ClipboardWriter = { writeText(text: string): Promise<void> };
type CopyDocument = Pick<Document, "body" | "createElement" | "execCommand" | "activeElement">;
type DownloadDocument = Pick<Document, "body" | "createElement">;
type ObjectUrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export function chatTaskDiagnosticJson(task: ChatTask): string {
  return JSON.stringify(chatTaskSafeDiagnostic(task), null, 2);
}

export async function copyDiagnosticJson(
  text: string,
  environment: { clipboard?: ClipboardWriter; document?: CopyDocument } = {},
): Promise<"clipboard" | "fallback"> {
  let clipboard = environment.clipboard;
  if (!clipboard && typeof navigator !== "undefined") {
    try {
      clipboard = navigator.clipboard;
    } catch {
      clipboard = undefined;
    }
  }
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return "clipboard";
    } catch {
      // The plugin iframe may deny clipboard permission; try its synchronous copy path.
    }
  }

  const documentRef =
    environment.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!documentRef?.body || !documentRef.execCommand)
    throw new Error("Clipboard access is unavailable. Download the diagnostic JSON instead.");
  const textarea = documentRef.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  const previousFocus = documentRef.activeElement as HTMLElement | null;
  documentRef.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (!documentRef.execCommand("copy"))
      throw new Error("Clipboard copy was denied. Download the diagnostic JSON instead.");
    return "fallback";
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}

export function downloadDiagnosticJson(
  text: string,
  filename: string,
  environment: { document?: DownloadDocument; url?: ObjectUrlApi } = {},
): void {
  const documentRef =
    environment.document ?? (typeof document !== "undefined" ? document : undefined);
  const urlApi = environment.url ?? (typeof URL !== "undefined" ? URL : undefined);
  if (!documentRef?.body || !urlApi?.createObjectURL)
    throw new Error("JSON download is unavailable in this plugin UI.");
  const blobUrl = urlApi.createObjectURL(
    new Blob([text], { type: "application/json;charset=utf-8" }),
  );
  const link = documentRef.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  link.style.display = "none";
  try {
    documentRef.body.appendChild(link);
    link.click();
  } catch {
    link.remove();
    urlApi.revokeObjectURL(blobUrl);
    throw new Error("The browser blocked the JSON download.");
  }
  link.remove();
  setTimeout(() => urlApi.revokeObjectURL(blobUrl), 1_000);
}
