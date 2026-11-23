import {
  FW2_FEATURE, type ContextTicket,
  type ContextFailure, type ContextRead, type DesignContextSnapshot,
} from "../shared/design-context";
import { requestedDesignContext } from "../shared/chat-generation";
import type { PluginToUIMessage } from "../shared/messages";
import { captureDesignContext, ContextReadError } from "./design-context";

export function createDesignContextController(api: PluginAPI, enabled: boolean, documentId: () => string | undefined) {
  let generation = 0;
  let pageGeneration = 0;
  let active: { requestId: string; taskId: string } | undefined;
  let grant: { request: Pick<ContextRead, "requestId" | "taskId" | "documentId" | "scope">; snapshot: DesignContextSnapshot; generation: number } | undefined;
  const invalidate = () => { generation++; pageGeneration++; grant = undefined; };
  if (enabled) {
    api.on("selectionchange", () => {
      generation++;
      if (grant?.request.scope !== "page") grant = undefined;
    });
    api.on("currentpagechange", invalidate);
    api.on("close", () => { invalidate(); active = undefined; });
  }

  async function read(request: ContextRead): Promise<Extract<PluginToUIMessage, { type: "design-context-result" }>> {
    const { requestId, taskId } = request;
    const envelope = { type: "design-context-result", feature: FW2_FEATURE, requestId, taskId } as const;
    const fail = (code: ContextFailure) => ({ ...envelope, success: false as const, code });
    if (!enabled) return fail("UNSUPPORTED");
    const approval = requestedDesignContext(request.prompt, request.intent);
    if (!approval || approval.scope !== request.scope || documentId() !== request.documentId) return fail("PERMISSION_DENIED");
    if (api.editorType !== "figma" || api.mode !== "default") return fail("UNSUPPORTED");
    if (request.intent === "edit" && (!request.targetNodeId || api.currentPage.id !== request.targetPageId || api.currentPage.selection.length !== 1 ||
      api.currentPage.selection[0]?.id !== request.targetNodeId)) return fail("PERMISSION_DENIED");
    if (active) return fail("UNAVAILABLE");
    const capture = { requestId, taskId };
    active = capture;
    grant = undefined;
    const atGeneration = generation;
    const atPageGeneration = pageGeneration;
    const stillCurrent = () => atPageGeneration === pageGeneration && documentId() === request.documentId &&
      (request.scope === "page" || atGeneration === generation);
    try {
      const snapshot = await captureDesignContext(api, request.scope, {
        stillCurrent, cancelled: () => active !== capture, catalog: approval.catalog,
      });
      if (active !== capture) return fail("CANCELLED");
      if (!stillCurrent()) return fail("STALE");
      if (approval.reuse && request.intent === "create")
        grant = { request: { requestId, taskId, documentId: request.documentId, scope: request.scope }, snapshot, generation: atGeneration };
      return { ...envelope, success: true, snapshot };
    } catch (error) {
      return fail(error instanceof ContextReadError ? error.code : "UNAVAILABLE");
    } finally {
      if (active === capture) active = undefined;
    }
  }
  function cancel(request: { requestId: string; taskId: string }) {
    const matches = (candidate: { requestId: string; taskId: string } | undefined) =>
      candidate?.requestId === request.requestId && candidate.taskId === request.taskId;
    if (matches(active)) active = undefined;
    if (matches(grant?.request)) grant = undefined;
  }
  function reuse(ticket: ContextTicket, taskId: string, document: string) {
    const selected = grant;
    const current = () => Boolean(enabled && selected && selected === grant && selected.request.taskId === taskId &&
      selected.request.documentId === document && documentId() === document && api.currentPage.id === selected.snapshot.pageId &&
      selected.request.requestId === ticket.requestId && selected.snapshot.digest === ticket.digest &&
      Date.now() - selected.snapshot.capturedAt < 5 * 60_000 &&
      (selected.request.scope === "page" || (generation === selected.generation &&
        selected.snapshot.roots.length === api.currentPage.selection.length &&
        selected.snapshot.roots.every((id, i) => api.currentPage.selection[i]?.id === id))));
    return { snapshot: current() ? selected?.snapshot : undefined, current };
  }
  return { read, cancel, reuse };
}
