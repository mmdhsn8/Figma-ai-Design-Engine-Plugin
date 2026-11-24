import { FW5_VISUAL_CAPTURE_LIMITS, type VisualReviewGrantV1, type VisualReviewRequestV1, type VisualReviewerV1 } from "../shared/fw5-visual-qa";
import type { ChatTask } from "../shared/chat-task";
import type { PluginToUIMessage } from "../shared/messages";
import { CompanionClientError, reviewAuthorizedVisual, type CompanionModel, type CompanionStatus } from "./companion-client";

type VisualIdentity = Omit<VisualReviewGrantV1, "version" | "authorized" | "authorizationId" | "recipient" | "provider" | "model" | "sessionId" | "accountScope" | "consentImageCount">;
type NativeInspection = Extract<PluginToUIMessage, { type: "task-native-inspection-result" }>;

export function createFW5VisualReviewAdapter(input: {
  enabled: boolean;
  mode: "capture-only" | "review" | "review+bounded-repair";
  token: string;
  model: string;
  models: CompanionModel[];
  session: Pick<CompanionStatus, "sessionId" | "accountScope">;
  task: ChatTask;
  assertCurrent(): void;
  getStatus(): Promise<CompanionStatus>;
  inspectRoot(request: { taskId: string; documentId: string; rootRef: string; rootId: string; pageId: string; programFingerprint: string; readbackRevision: string }): Promise<NativeInspection>;
  confirm(message: string): boolean;
  fetcher?: typeof fetch;
}): {
  reviewer?: VisualReviewerV1;
  authorize(identity: VisualIdentity): Promise<VisualReviewGrantV1 | undefined>;
} {
  const enabled = input.enabled && input.mode !== "capture-only";
  const requireImageInput = () => {
    const model = input.models.find(({ slug }) => slug === input.model);
    if (!model) throw new CompanionClientError("model_not_verified_for_account");
    if (model.imageInput !== "supported") throw new CompanionClientError(
      model.imageInput === "unsupported" ? "unsupported_capability" : "visual_review_capability_unknown",
    );
    return model;
  };
  const assertSession = async () => {
    input.assertCurrent();
    const status = await input.getStatus();
    input.assertCurrent();
    if (status.sessionId !== input.session.sessionId || status.accountScope !== input.session.accountScope || !status.planUseAuthorized)
      throw new CompanionClientError("authorization_required");
    if (!input.models.some(({ slug }) => slug === input.model))
      throw new CompanionClientError("model_not_verified_for_account");
  };
  const taskScreen = (identity: Pick<VisualIdentity, "taskId" | "taskGeneration" | "screenId" | "documentId" | "pageId" | "rootId" | "programFingerprint">) => {
    if (identity.taskId !== input.task.id || identity.documentId !== input.task.documentId ||
        identity.taskGeneration !== (input.task.generationLink?.generationId ?? `generation-${input.task.universalManifest?.fingerprint ?? input.task.id}`))
      throw new CompanionClientError("stale_task_session");
    const screen = input.task.universalScreens?.find(({ screenId }) => screenId === identity.screenId);
    if (!screen || !screen.rootRef || screen.nativeRootNodeId !== identity.rootId || screen.nativePageId !== identity.pageId ||
        screen.fingerprint !== identity.programFingerprint || !["rendered", "verified"].includes(screen.status))
      throw new CompanionClientError("stale_task_session");
    return screen;
  };
  const assertRoot = async (review: VisualReviewRequestV1) => {
    const screen = taskScreen(review);
    const result = await input.inspectRoot({
      taskId: input.task.id,
      documentId: input.task.documentId,
      rootRef: screen.rootRef!,
      rootId: review.rootId,
      pageId: review.pageId,
      programFingerprint: review.programFingerprint,
      readbackRevision: review.readbackRevision,
    });
    input.assertCurrent();
    if (result.type !== "task-native-inspection-result") throw new CompanionClientError("response_invalid");
    const root = result.nodes?.find(({ ref }) => ref === screen.rootRef);
    const expectedRoot = review.nodes.find(({ nodeId }) => nodeId === review.rootId);
    if (!result.success || result.taskId !== input.task.id || result.nativePageId !== review.pageId || result.expectedRootStatus !== "present" ||
        result.geometry?.receipt !== review.readbackRevision || root?.id !== review.rootId || root.parentId !== expectedRoot?.parentId)
      throw new CompanionClientError("stale_task_session");
  };
  return {
    ...(enabled ? {
      reviewer: {
        capabilities: () => ({ version: 1, kind: "vision", acceptsPng: true, maxBytes: FW5_VISUAL_CAPTURE_LIMITS.maxBytes, maxFindings: 10 }),
        review: async (review: VisualReviewRequestV1, grant: VisualReviewGrantV1, signal: AbortSignal) => {
          input.assertCurrent();
          if (signal.aborted) throw new CompanionClientError("request_cancelled");
          requireImageInput();
          if (grant.provider !== "openai-responses" || grant.model !== input.model || grant.sessionId !== input.session.sessionId ||
              grant.accountScope !== input.session.accountScope || grant.consentImageCount !== 1 || grant.taskGeneration !== review.taskGeneration ||
              grant.imageRevision !== review.imageRevision || !grant.authorizationId)
            throw new CompanionClientError("authorization_required");
          taskScreen(review);
          await assertSession();
          await assertRoot(review);
          const response = await reviewAuthorizedVisual(input.token, review, grant, input.fetcher ?? fetch, signal);
          if (signal.aborted) throw new CompanionClientError("request_cancelled");
          await assertSession();
          await assertRoot(review);
          return response;
        },
      } satisfies VisualReviewerV1,
    } : {}),
    authorize: async (identity) => {
      if (!enabled) return undefined;
      input.assertCurrent();
      taskScreen(identity);
      await assertSession();
      const model = requireImageInput();
      const stage = identity.imageRevision === 2 ? "the post-repair recheck screenshot" : "the initial screenshot";
      const accepted = input.confirm(
        `Allow one visual QA image to be sent?\n\n` +
          `Screen: ${identity.screenId}\nNative root: ${identity.rootId}\nFigma page: ${identity.pageId}\n` +
          `Task: ${identity.taskId} (${identity.taskGeneration})\nImage: ${stage}\n\n` +
          `A Figma screenshot may contain private design data. Recipient: OpenAI Responses through the existing ChatGPT plan-use session. ` +
          `Selected model: ${model.displayName} (${model.slug}). This authorization covers only this one image; if a second screenshot is needed, ` +
          `you will be asked again. The image is not added to Chat history or checkpoints. The request may use ChatGPT plan usage.\n\n` +
          `Send this screenshot for this task, screen, root, and page?`,
      );
      if (!accepted) return undefined;
      await assertSession();
      taskScreen(identity);
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      const nonce = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      return {
        version: 1,
        authorized: true,
        recipient: "authorized-image-provider",
        authorizationId: `fw5_review_${nonce}`,
        ...identity,
        provider: "openai-responses",
        model: input.model,
        sessionId: input.session.sessionId,
        accountScope: input.session.accountScope,
        consentImageCount: 1,
      };
    },
  };
}
