import { createDesignPlan } from "../shared/design-generation";
import { validateDraftScreen, DraftIdentitySchema } from "../shared/generation-draft";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import { prepareGeneratedDesign } from "../ui/design-generation";
import { renderMultiScreenDesign } from "./renderer";

type GenerationRequest = Extract<
  UIToPluginMessage,
  { type: "generation-context" | "generation-remember" | "generation-render" | "generation-select" }
>;

export function createGenerationController(api: PluginAPI) {
  let queue: Promise<unknown> = Promise.resolve();
  const identity = () => {
    let local = api.root.getPluginData("fad.document-id");
    if (!local) {
      local = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      api.root.setPluginData("fad.document-id", local);
    }
    return `${api.fileKey ?? local}-${api.currentPage.id.replaceAll(":", "_")}`;
  };
  return (message: GenerationRequest): Promise<PluginToUIMessage> => {
    const work = async (): Promise<PluginToUIMessage> => {
      const started = Date.now();
      try {
        const documentId = identity();
        const key = `generation-v1:${documentId}`;
        if (message.type === "generation-select") {
          const roots = api.currentPage.findAll(
            (node) =>
              node.getPluginData("fad.multi-screen.batch-id") === message.generationId &&
              node.getPluginData("fad.generation.commit") === "complete",
          );
          api.currentPage.selection = roots;
          if (roots.length) api.viewport.scrollAndZoomIntoView(roots);
          return { type: "generation-result", requestId: message.requestId, success: true };
        }
        if (message.type === "generation-context") {
          const saved: unknown = await api.clientStorage.getAsync(key);
          return {
            type: "generation-result",
            requestId: message.requestId,
            success: true,
            documentId,
            generationId: DraftIdentitySchema.safeParse(saved).success ? (saved as string) : null,
          };
        }
        if (message.type === "generation-remember") {
          if (message.generationId) await api.clientStorage.setAsync(key, message.generationId);
          else await api.clientStorage.deleteAsync(key);
          return { type: "generation-result", requestId: message.requestId, success: true };
        }
        if (message.manifest.documentId !== documentId)
          throw new Error("Document/page changed; reopen the draft in its original page.");
        const design = validateDraftScreen(message.manifest, message.design);
        const plan = createDesignPlan(message.manifest.request);
        if (!plan.success) throw new Error("Saved plan is invalid.");
        const prepared = prepareGeneratedDesign(JSON.stringify(design), {
          ...plan.data,
          screens: plan.data.screens.filter(({ id }) => id === design.screens[0]!.id),
        });
        if (!prepared.success) throw new Error(prepared.errors.join(" "));
        if (prepared.data.nodeCount > 10_000)
          throw new Error(
            "Native AI screen exceeds the 10,000-node render budget. Split the screen; saved content retained.",
          );
        prepared.data.batch.id = message.manifest.generationId;
        // Isolate generated projects while reusing styles within one stable generation.
        if (prepared.data.batch.designSystem) {
          prepared.data.batch.designSystem.id = message.manifest.generationId;
          prepared.data.batch.designSystem.namespace = message.manifest.generationId;
        }
        const result = await renderMultiScreenDesign(api, prepared.data.batch, {
          resume: true,
          verifyTouchTargets: true,
          beforeScreen: () => {
            if (identity() !== documentId)
              throw new Error(
                "Figma page changed during font preparation. Return to the original page and resume; no screen was created on the new page.",
              );
          },
        });
        if (result.failedScreens)
          throw new Error(
            result.screens[0]?.error ?? "Figma rendering failed; validated screen remains saved.",
          );
        return {
          type: "generation-result",
          requestId: message.requestId,
          success: true,
          nodeId: result.screens[0]?.nodeId,
          warnings: result.warnings.slice(0, 8).map((warning) => warning.slice(0, 500)),
          elapsedMs: Date.now() - started,
        };
      } catch (error) {
        return {
          type: "generation-result",
          requestId: message.requestId,
          success: false,
          error: (error instanceof Error
            ? error.message
            : "Native rendering or local metadata storage failed."
          ).slice(0, 500),
          elapsedMs: Date.now() - started,
        };
      }
    };
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
}
