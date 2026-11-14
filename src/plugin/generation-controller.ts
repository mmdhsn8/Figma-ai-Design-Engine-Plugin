import { createDesignPlan } from "../shared/design-generation";
import {
  validateDraftSection,
  validateDraftScreen,
  DraftIdentitySchema,
} from "../shared/generation-draft";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import { verifyNativeDesign, type NativeDesignVerification } from "./native-design-verification";
import { prepareGeneratedDesign } from "../ui/design-generation";
import { createGenerationSkeletons, renderMultiScreenDesign } from "./renderer";
import { resolvePinnedBrandVisualAssets } from "./brand-kit-storage";

type GenerationRequest = Extract<
  UIToPluginMessage,
  {
    type:
      | "generation-context"
      | "generation-remember"
      | "generation-render"
      | "generation-verify"
      | "generation-select"
      | "generation-prepare"
      | "generation-apply-section";
  }
>;

function visualVerificationError(result: NativeDesignVerification): string | undefined {
  if (result.verified) return undefined;
  const issueRefs = result.findings
    .filter((finding) =>
      [
        "missing-ref",
        "invalid-geometry",
        "hidden-node",
        "empty-text",
        "clipped-child",
        "overlapping-auto-layout",
        "low-contrast",
        "type-mismatch",
        "parent-mismatch",
        "viewport-mismatch",
        "value-mismatch",
      ].includes(finding.code),
    )
    .slice(0, 6)
    .map((finding) => `${finding.code}${finding.ref ? `:${finding.ref}` : ""}`);
  const missingPatterns = result.missingPatterns.slice(0, 4).map((pattern) => `pattern:${pattern}`);
  return `Native visual verification is incomplete; saved nodes were retained. ${result.truncated ? "The native QA safety budget was exceeded. " : ""}${[...issueRefs, ...missingPatterns].join(", ") || "required evidence unavailable"}.`;
}

export function createGenerationController(
  api: PluginAPI,
  onNodeProgress?: (
    message: Extract<PluginToUIMessage, { type: "generation-node-progress" }>,
  ) => void,
) {
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
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
              (message.screenId
                ? node.getPluginData("fad.multi-screen.screen-id") === message.screenId
                : node.getPluginData("fad.generation.commit") === "complete"),
          );
          const targets = roots.flatMap((root) =>
            message.sectionId && "children" in root
              ? root.children.filter(
                  (node) =>
                    node.getPluginData("fad.generation.semantic-id") ===
                    `section:${message.screenId}:${message.sectionId}`,
                )
              : [root],
          );
          api.currentPage.selection = targets;
          if (targets.length) api.viewport.scrollAndZoomIntoView(targets);
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
        if (message.type === "generation-prepare") {
          if (message.manifest.documentId !== documentId)
            throw new Error("Document/page changed; reopen the draft in its original page.");
          const plan = createDesignPlan(message.manifest.request, message.manifest.brandKit);
          if (!plan.success) throw new Error("Saved plan is invalid.");
          await resolvePinnedBrandVisualAssets(api.clientStorage, message.manifest.brandKit);
          const nodeIds = createGenerationSkeletons(
            api,
            message.manifest.generationId,
            plan.data,
            message.screenIds,
            message.focusInitial,
          );
          return {
            type: "generation-result",
            requestId: message.requestId,
            success: true,
            nodeId: nodeIds[0],
          };
        }
        if (message.type === "generation-apply-section") {
          if (message.manifest.documentId !== documentId)
            throw new Error("Document/page changed; reopen the draft in its original page.");
          const checked = validateDraftSection(
            message.manifest,
            message.transaction,
            message.design,
          );
          const plan = createDesignPlan(message.manifest.request, message.manifest.brandKit);
          if (!plan.success) throw new Error("Saved plan is invalid.");
          const brandAssets = await resolvePinnedBrandVisualAssets(
            api.clientStorage,
            message.manifest.brandKit,
          );
          const prepared = prepareGeneratedDesign(
            JSON.stringify(checked.design),
            {
              ...plan.data,
              screens: plan.data.screens.filter(({ id }) => id === checked.transaction.screen_id),
            },
            { scope: "section", sectionId: checked.transaction.section_id, assets: brandAssets },
          );
          if (!prepared.success) throw new Error(prepared.errors.join(" "));
          if (prepared.data.nodeCount > 250)
            throw new Error(
              "Section exceeds the 250-node transaction budget; saved data is retained.",
            );
          prepared.data.batch.id = message.manifest.generationId;
          if (prepared.data.batch.designSystem) {
            prepared.data.batch.designSystem.id = message.manifest.generationId;
            prepared.data.batch.designSystem.namespace = message.manifest.generationId;
          }
          const result = await renderMultiScreenDesign(api, prepared.data.batch, {
            resume: true,
            verifyTouchTargets: true,
            transaction: checked.transaction,
            beforeScreen: () => {
              if (identity() !== documentId)
                throw new Error(
                  "Figma page changed during section preparation; no section was applied to the new page.",
                );
            },
            onSectionVisible: (nodeId) => {
              onNodeProgress?.({
                type: "generation-node-progress",
                requestId: message.requestId,
                transactionId: checked.transaction.transaction_id,
                screenId: checked.transaction.screen_id,
                sectionId: checked.transaction.section_id,
                nodeId,
                elapsedMs: Date.now() - started,
              });
            },
          });
          if (result.failedScreens)
            throw new Error(
              result.screens[0]?.error ?? "Section rendering failed; its checkpoint was retained.",
            );
          const nodeId = result.screens[0]?.nodeId;
          if (!nodeId) throw new Error("Figma did not acknowledge the section root.");
          const visualSpec = prepared.data.visualSpecs[0];
          if (!visualSpec)
            throw new Error(
              "The saved visual specification is unavailable for native verification.",
            );
          const verification = await verifyNativeDesign(
            api,
            nodeId,
            api.currentPage.id,
            visualSpec,
          );
          const verificationError = visualVerificationError(verification);
          if (verificationError) throw new Error(verificationError);
          return {
            type: "generation-result",
            requestId: message.requestId,
            success: true,
            nodeId,
            generationId: message.manifest.generationId,
            warnings: [
              ...result.warnings.slice(0, 6).map((warning) => warning.slice(0, 500)),
              `Fresh native visual verification passed for ${verification.nodeCount} nodes.`,
            ],
            elapsedMs: Date.now() - started,
          };
        }
        if (message.type === "generation-verify") {
          if (message.manifest.documentId !== documentId)
            throw new Error("Document/page changed; reopen the draft in its original page.");
          const design = validateDraftScreen(message.manifest, message.design);
          const plan = createDesignPlan(message.manifest.request, message.manifest.brandKit);
          if (!plan.success) throw new Error("Saved plan is invalid.");
          const brandAssets = await resolvePinnedBrandVisualAssets(
            api.clientStorage,
            message.manifest.brandKit,
          );
          const screenId = design.screens[0]!.id;
          const prepared = prepareGeneratedDesign(
            JSON.stringify(design),
            {
              ...plan.data,
              screens: plan.data.screens.filter(({ id }) => id === screenId),
            },
            { assets: brandAssets },
          );
          if (!prepared.success) throw new Error(prepared.errors.join(" "));
          const roots = api.currentPage.findAll(
            (node) =>
              node.getPluginData("fad.multi-screen.batch-id") === message.manifest.generationId &&
              node.getPluginData("fad.multi-screen.screen-id") === screenId,
          );
          if (roots.length !== 1 || roots[0]?.type !== "FRAME")
            throw new Error(
              "Native screen identity is missing or ambiguous; no canvas changes were made.",
            );
          if (roots[0].getPluginData("fad.generation.commit") !== "complete")
            throw new Error(
              "Native screen has unfinished section transactions; verification is partial.",
            );
          const verification = await verifyNativeDesign(
            api,
            roots[0].id,
            api.currentPage.id,
            prepared.data.visualSpecs[0]!,
          );
          const verificationError = visualVerificationError(verification);
          if (verificationError) throw new Error(verificationError);
          return {
            type: "generation-result",
            requestId: message.requestId,
            success: true,
            nodeId: roots[0].id,
            generationId: message.manifest.generationId,
            warnings: [
              `Fresh full-screen native verification passed for ${verification.nodeCount} nodes.`,
            ],
            elapsedMs: Date.now() - started,
          };
        }
        if (message.type !== "generation-render")
          throw new Error("Unsupported generation command.");
        if (message.manifest.documentId !== documentId)
          throw new Error("Document/page changed; reopen the draft in its original page.");
        const design = validateDraftScreen(message.manifest, message.design);
        const plan = createDesignPlan(message.manifest.request, message.manifest.brandKit);
        if (!plan.success) throw new Error("Saved plan is invalid.");
        const brandAssets = await resolvePinnedBrandVisualAssets(
          api.clientStorage,
          message.manifest.brandKit,
        );
        const prepared = prepareGeneratedDesign(
          JSON.stringify(design),
          {
            ...plan.data,
            screens: plan.data.screens.filter(({ id }) => id === design.screens[0]!.id),
          },
          { assets: brandAssets },
        );
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
        const rootNodeId = result.screens[0]?.nodeId;
        if (!rootNodeId) throw new Error("Figma did not acknowledge the rendered screen root.");
        const visualSpec = prepared.data.visualSpecs[0];
        if (!visualSpec)
          throw new Error("The saved visual specification is unavailable for native verification.");
        const verification = await verifyNativeDesign(
          api,
          rootNodeId,
          api.currentPage.id,
          visualSpec,
        );
        const verificationError = visualVerificationError(verification);
        if (verificationError) throw new Error(verificationError);
        return {
          type: "generation-result",
          requestId: message.requestId,
          success: true,
          nodeId: rootNodeId,
          warnings: [
            ...result.warnings.slice(0, 6).map((warning) => warning.slice(0, 500)),
            `Fresh native visual verification passed for ${verification.nodeCount} nodes.`,
          ],
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
    if (pending >= 8)
      return Promise.resolve({
        type: "generation-result",
        requestId: message.requestId,
        success: false,
        error: "The bounded Figma message queue is full; retry after the current section finishes.",
      });
    pending++;
    const next = queue.then(work, work).finally(() => {
      pending--;
    });
    queue = next.catch(() => undefined);
    return next;
  };
}
