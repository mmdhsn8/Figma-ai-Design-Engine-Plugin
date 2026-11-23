import { DesignProgramV1Schema, parseDesignProgram, type DesignProgramV1 } from "../shared/design-program";
import { compileDesignProgram } from "../shared/design-program-adapter";
import { auditDesignProgramContrast, normalizeDesignProgramContrast } from "../shared/design-program-quality";
import { ChatFunctionCallSchema, MAX_CHAT_PROVIDER_INPUT_BYTES, UNIVERSAL_CONTEXT_PREFIX, type ChatFunctionCall, type ChatLifecycleState, type ChatInputItem } from "../shared/chat-tools";
import { isClearCreateRequest, isExplicitCanvasRequest, parseChatGenerationIntent, requestedDesignContext } from "../shared/chat-generation";
import { resolveBrandKitTokens } from "../shared/brand-kit";
import { CHAT_TASK_MAX_BYTES, CHAT_TASK_MAX_VALIDATION_CORRECTIONS, ChatTaskSchema, type ChatTask } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import { chatAbortOrigin, isChatAbortOrigin } from "../shared/chat-cancellation";
import { compositionVariationSeed, createDefaultVisualLanguage, ProjectVisualLanguageV1Schema, type ProjectVisualLanguageV1 } from "../shared/design-composition";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import {
  parseProjectPlanDraft,
  projectPlanFingerprint,
  ProjectPlanV1Schema,
  UniversalJobManifestV1Schema,
  UniversalDesignMetricsSchema,
  UniversalScreenCheckpointSchema,
  UNIVERSAL_DESIGN_TRACE_BUILD_ID,
  universalJobManifestFingerprint,
  type ProjectPlanV1,
  type UniversalDesignTraceEvent,
  type UniversalScreenCheckpoint,
} from "../shared/universal-design";
import type { AuthorizedChatTurn } from "./companion-client";
import type { ContextResponse, DesignProgramRenderResponse } from "./design-program-bridge";
import { CONTEXT_PRECEDENCE, plannerDesignContext, type ContextTicket } from "../shared/design-context";
import { FW4_GEOMETRY_ENABLED, FW4_GEOMETRY_FEATURE, projectNativeLayoutExpectations } from "../shared/fw4-geometry";
import { FW5_VISUAL_QA_ENABLED, FW5_VISUAL_REVIEW_MODE } from "../shared/fw5-visual-qa-feature";
import {
  FW5_VISUAL_CAPTURE_LIMITS,
  runVisualReviewerV1,
  VisualCaptureReceiptV1Schema,
  VisualCaptureTransportV1Schema,
  VisualQaOutcomeV1Schema,
  VisualNativeRepairResultV1Schema,
  pngDimensions,
  visualContentDigest,
  visualFindingId,
  VisualRepairProposalV1Schema,
  type VisualReviewGrantV1,
  type VisualReviewRequestV1,
  type VisualReviewResponseV1,
  type VisualRepairProposalV1,
  type VisualReviewerV1,
  type VisualCaptureRequestV1,
  type VisualCaptureReceiptV1,
  type VisualQaOutcomeV1,
} from "../shared/fw5-visual-qa";

type NativeInspection = Extract<PluginToUIMessage, { type: "task-native-inspection-result" }>;

export type UniversalDesignDependencies = {
  model(input: ChatInputItem[], lifecycle: ChatLifecycleState, requestId: string, signal?: AbortSignal): Promise<AuthorizedChatTurn>;
  save(task: ChatTask): Promise<void>;
  progress(message: string): void;
  assertAuthorized(): Promise<void>;
  renderProgram(program: DesignProgramV1, requestId: string, expectedRootNodeId?: string, contextTicket?: ContextTicket): Promise<DesignProgramRenderResponse>;
  readContext?(): Promise<ContextResponse | undefined>;
  inspectProgram(request: Extract<UIToPluginMessage, { type: "task-native-inspect" }>): Promise<NativeInspection>;
  captureVisual?(request: Extract<UIToPluginMessage, { type: "task-native-visual-capture" }>, signal: AbortSignal): Promise<Extract<PluginToUIMessage, { type: "task-native-visual-capture-result" }>>;
  repairVisual?(request: Extract<UIToPluginMessage, { type: "task-native-visual-repair" }>, signal: AbortSignal): Promise<Extract<PluginToUIMessage, { type: "task-native-visual-repair-result" }>>;
  visualReviewer?: VisualReviewerV1;
  authorizeVisualReview?(identity: Omit<VisualReviewGrantV1, "version" | "authorized" | "authorizationId" | "recipient">): Promise<unknown | undefined>;
  signal: AbortSignal;
  now?: () => number;
  monotonicNow?: () => number;
  maxConcurrentModelCalls?: 1 | 2;
  isCurrent?(): boolean;
  onPhase?(phase: "planning" | "native_execution" | "verification"): void;
  timingEvidence?: "live" | "mock";
};

export const UNIVERSAL_DESIGN_MAX_CONCURRENT_MODEL_CALLS: 1 | 2 = 2;
const MAX_TASK_NATIVE_NODES = 200;

export class UniversalDesignTaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(`universal_${code}: ${message}`);
    this.name = "UniversalDesignTaskError";
  }
}

function fail(code: string, message: string): never {
  throw new UniversalDesignTaskError(code, message);
}

function checkpoint(value: UniversalScreenCheckpoint): UniversalScreenCheckpoint {
  return UniversalScreenCheckpointSchema.parse(value);
}

function inputHistory(task: ChatTask): ChatInputItem[] {
  return task.context
    .filter((item): item is Extract<ChatInputItem, { role: "user" | "assistant" }> => "role" in item)
    .filter((item) => !item.content.includes("MULTI_SCREEN_GENERATION_HANDOFF_V1"))
    .slice(-3)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 8_000) }));
}

function pinnedContext(task: ChatTask): Record<string, unknown> {
  return {
    brandKit: task.brandKit
      ? {
          id: task.brandKit.id,
          revision: task.brandKit.revision,
          name: task.brandKit.name,
          locale: task.brandKit.locale,
          direction: task.brandKit.direction,
          tokenHash: task.brandKit.tokenHash,
          tokens: task.brandKit.tokens,
          assetCatalog: task.brandKit.assets.map(({ assetId, kind, variant, name, mimeType, width, height, provenance, rightsNote, contentHash }) => ({ assetId, kind, variant, name, mimeType, width, height, provenance, rightsNote, contentHash })),
        }
      : null,
    designSkills: (task.designSkills ?? []).map((skill) => ({
      id: skill.id,
      revisionId: skill.revisionId,
      name: skill.name,
      trust: skill.trust,
      requiredPatterns: skill.requiredPatterns,
      guidanceText: skill.guidanceText.slice(0, 6_000),
    })),
  };
}

function planRequestContext(task: ChatTask): Record<string, unknown> {
  const parsedIntent = parseChatGenerationIntent(task.prompt);
  const explicit = parsedIntent.kind === "ready" ? parsedIntent.intent : undefined;
  const requestedTarget = explicit?.target ??
    (/\b(?:desktop|laptop|web)\b|دسکتاپ/iu.test(task.prompt)
      ? "desktop"
      : /\b(?:mobile|phone)\b|موبایل|گوشی/iu.test(task.prompt)
        ? "mobile"
        : undefined);
  const isPersian = /[\u0600-\u06ff]/u.test(task.prompt);
  return {
    requestId: task.id,
    originalBrief: task.prompt,
    requestedScreenCount: explicit?.screenCount ?? null,
    requestedPlatform: requestedTarget ?? "model-selected-within-supported-presets",
    requestedLocale: explicit?.locale ?? (isPersian ? "fa-IR" : "en-US"),
    requestedDirection: isPersian ? "rtl" : "ltr",
    pinned: pinnedContext(task),
    supportedCapabilities: [
      "editable native Figma frames, text and vector shapes",
      "mobile viewport 390×844 or desktop viewport 1440×900",
      "RTL or LTR layout; vertical scroll",
      "editable native text, frames and vector shapes; pinned Brand Kit images may be reused by asset ID",
      "clearly labeled native placeholders when no authorized local asset fits; no remote URLs or arbitrary code",
      "maximum 10 screens and 200 adopted native nodes per task",
    ],
    readScope: "No existing document content has been inspected; plan from the brief and pinned local design context only.",
  };
}

function planSummary(plan: ProjectPlanV1, screen: ProjectPlanV1["screens"][number]): Record<string, unknown> {
  const destinations = new Map(plan.screens.map((item) => [item.screenId, item.name]));
  return {
    projectPurpose: plan.productPurpose,
    projectNarrative: plan.projectNarrative,
    audience: plan.audience,
    primaryUserGoals: plan.primaryUserGoals,
    capabilities: plan.capabilities,
    keyEntities: plan.keyEntities,
    domainTags: plan.domainTags,
    styleDirection: plan.styleDirection,
    visualLanguageV1: plan.visualLanguageV1,
    contentDensity: plan.contentDensity,
    contentSamplePolicy: plan.contentSamplePolicy,
    accessibilityMinimums: plan.accessibilityMinimums,
    designConstraints: plan.designConstraints,
    componentOpportunities: plan.componentOpportunities,
    locale: plan.locale,
    direction: plan.direction,
    platform: plan.platform,
    viewport: plan.viewport,
    screenCount: plan.screenCount,
    orderedSitemap: plan.screens.map(({ screenId, name, role, purpose, source }) => ({ screenId, name, role, purpose, source })),
    currentScreen: {
      ...screen,
      navigationTargets: screen.navigationTargets.map((id) => ({ screenId: id, name: destinations.get(id) })),
    },
    knownFacts: plan.knownFacts,
    assumptions: plan.assumptions,
    nonGoals: plan.nonGoals,
    pinnedBrandKit: taskBrandSummary(plan),
  };
}

function taskBrandSummary(plan: ProjectPlanV1): unknown {
  return plan.pinnedBrandKit ?? null;
}

function pinBrandLanguage(language: ProjectVisualLanguageV1, task: ChatTask): ProjectVisualLanguageV1 {
  const kit = task.brandKit;
  if (!kit) return language;
  const prompt = task.prompt;
  const explicitColor = /#[0-9a-f]{6}/iu.test(prompt)
    || /\b(?:black|white|red|orange|yellow|green|blue|purple|violet|teal|cyan|pink|brown|gray|grey|beige|navy|indigo|mint|coral)\b/iu.test(prompt)
    || /(?:رنگ\s*(?:آبی|سبز|قرمز|بنفش|نارنجی|زرد|صورتی|قهوه‌ای|مشکی|سفید)|از\s+.{1,30}\s+رنگ\s+استفاده)/iu.test(prompt);
  const explicitFont = /\b(?:font|typeface|typography family)\b|(?:فونت|قلم)/iu.test(prompt);
  const explicitSpacing = /\b(?:spacing|compact|spacious|dense layout)\b|(?:فاصله|تراکم)/iu.test(prompt);
  const brand = resolveBrandKitTokens(kit, language.colorMode);
  const brandSpacing = [...new Set(kit.tokens.spacing.filter((value) => value >= 2).sort((a, b) => a - b))].slice(0, 8);
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, Math.round(value)));
  return ProjectVisualLanguageV1Schema.parse({
    ...language,
    colorRoles: explicitColor ? language.colorRoles : {
      ...language.colorRoles,
      page: brand.palette.background,
      surface: brand.palette.surface,
      raisedSurface: brand.palette.surface,
      text: brand.palette.text,
      mutedText: brand.palette.mutedText,
      primary: brand.palette.primary,
      accent: brand.palette.accent,
      border: brand.palette.border,
    },
    typography: explicitFont ? language.typography : {
      ...language.typography,
      headingFont: kit.tokens.typography.heading1.requestedFamily,
      bodyFont: kit.tokens.typography.body.requestedFamily,
      displaySize: clamp(kit.tokens.typography.display.size, 24, 72),
      titleSize: clamp(kit.tokens.typography.heading1.size, 20, 48),
      bodySize: clamp(kit.tokens.typography.body.size, 12, 24),
      captionSize: clamp(kit.tokens.typography.caption.size, 10, 18),
    },
    spacingScale: explicitSpacing || brandSpacing.length < 3 ? language.spacingScale : brandSpacing,
    radii: {
      compact: Math.min(32, kit.tokens.radii[0] ?? language.radii.compact),
      control: Math.min(40, kit.tokens.components.inputRadius),
      surface: Math.min(48, kit.tokens.components.cardRadius),
    },
  });
}

function pinPlanLanguage(plan: ProjectPlanV1, task: ChatTask): ProjectPlanV1 {
  const visualLanguageV1 = pinBrandLanguage(visualLanguageForPlan(plan), task);
  return ProjectPlanV1Schema.parse({ ...plan, visualLanguageV1 });
}

function finalizePlan(plan: ProjectPlanV1, task: ChatTask): { plan: ProjectPlanV1; fingerprint: string } {
  const pinnedPlan = pinPlanLanguage(plan, task);
  return { plan: pinnedPlan, fingerprint: projectPlanFingerprint(pinnedPlan) };
}

function requestInput(task: ChatTask, purpose: "plan" | "compose" | "repair", screen?: UniversalScreenCheckpoint, validationFeedback?: string, local?: ReturnType<typeof plannerDesignContext>): ChatInputItem[] {
  const plan = task.projectPlan;
  const screenPlan = screen && plan?.screens.find(({ screenId }) => screenId === screen.screenId);
  if (purpose !== "plan" && (!plan || !screen || !screenPlan))
    fail("checkpoint_incomplete", "A saved plan and matching stable screen identity are required before composition.");
  const context = purpose === "plan"
    ? planRequestContext(task)
    : purpose === "compose"
      ? planSummary(plan!, screenPlan!)
      : {
          projectPurpose: plan!.productPurpose,
          screen: planSummary(plan!, screenPlan!),
          screenId: screen!.screenId,
          acceptedProgram: screen!.program,
          boundedFindings: screen!.findings,
          repairAttempt: screen!.repairAttempts,
        };
  const routeInstruction = purpose === "plan"
    ? "Return only one plan_universal_project tool call. Respect the exact count/device/language constraints in this context. Choose useful distinct screens if the brief did not provide a count. Declare a screen dependency only when the saved content of that screen is required to author another; navigation alone is not a generation dependency. Do not guess private document data."
    : purpose === "compose"
      ? `Return only one compose_design_program tool call for the single currentScreen. Reuse the exact shared visualLanguageV1; choose a useful general archetype from the allowed vocabulary and explain the choice in decisionTrace. Give each planned region a real container nodeId in the editable tree, prioritize the user goal, and use the stable variation seed ${compositionVariationSeed(task.id, screen!.screenId)}. Use semantic textRole values so typography tokens apply. Follow contentSamplePolicy exactly and label fictional sample data as illustrative. Only use an image assetRef if its ID is in the pinned Brand Kit assetCatalog; otherwise make a visibly labeled native placeholder or editable vector. Do not force card grids, add at least three nodes, or include other screens.`
      : "Return only one repair_design_program tool call. Modify only the supplied invalid fields/findings in this saved one-screen program and preserve all other valid content.";
  const payload = {
    contract: purpose === "plan" ? "ProjectPlanDraftV1" : "DesignProgramV1",
    requestId: task.id,
    brief: purpose === "plan" ? task.prompt : undefined,
    context,
    pinned: pinnedContext(task),
    ...(purpose === "compose" ? {
      reusableLocalComponents: [...new Map(
        (task.universalScreens ?? []).flatMap(({ program }) => program?.componentsV1 ?? []).map((definition) => [definition.id, definition]),
      ).values()].filter((definition) => utf8Bytes(JSON.stringify(definition)) <= 1_500).slice(0, 6),
    } : {}),
    instructions: routeInstruction,
    ...((validationFeedback ?? task.validationFeedback) ? { priorValidation: (validationFeedback ?? task.validationFeedback)!.slice(0, 3_000) } : {}),
  };
  const history = inputHistory(task);
  const input: ChatInputItem[] = [
    ...history,
    { role: "user", content: UNIVERSAL_CONTEXT_PREFIX[purpose] + JSON.stringify(payload) },
  ];
  const bytes = utf8Bytes(JSON.stringify(input));
  if (bytes > MAX_CHAT_PROVIDER_INPUT_BYTES)
    fail("request_too_large", `The bounded ${purpose} request is ${bytes} bytes; its limit is ${MAX_CHAT_PROVIDER_INPUT_BYTES}. Trim prior chat context or pinned guidance and retry.`);
  if (!local || purpose === "repair") return input;
  const grounded: ChatInputItem[] = [...history, {
    role: "user",
    content: UNIVERSAL_CONTEXT_PREFIX[purpose] + JSON.stringify({
      ...payload,
      context: { ...context, readScope: "Only the explicitly approved Figma scope was sampled, read-only." },
      localDesignContext: local,
      contextPolicy: CONTEXT_PRECEDENCE + " Only exact compatible decorative shapes and single solid-color links may be reused natively. Never change a planned color, text or geometry merely to force reuse.",
    }),
  }];
  return utf8Bytes(JSON.stringify(grounded)) <= MAX_CHAT_PROVIDER_INPUT_BYTES ? grounded : input;
}

function stageCandidates(plan: ProjectPlanV1) {
  return plan.screens.map((screen, index) => ({
    title: `${index + 1}/${plan.screenCount} ${screen.name}`,
    goal: screen.purpose,
    purpose: screen.purpose,
    priority: index + 1,
    navigation: screen.navigationTargets,
    dependsOn: screen.dependencies,
    contentPlaceholders: screen.regions.map(({ content }) => content),
    componentOpportunities: plan.componentOpportunities.slice(0, 8),
    logicalRefs: [],
    completionCriteria: ["One bounded DesignProgramV1 is saved before render.", "Renderer ownership and fresh native readback match the saved screen."],
    estimatedMutations: 1,
    completed: false,
    operations: 0,
    readOnlyOperations: 0,
    segments: [],
    rounds: 0,
    qaAttempts: 0,
    verificationOperations: 0,
    verified: false,
    verificationHistory: [],
    qualityFindings: [],
    repairOperationsExecuted: 0,
    repairOperationsAttempted: 0,
    awaitingQualityRepair: false,
  }));
}

function initialMetrics(now: number, timingEvidence: "live" | "mock") {
  return UniversalDesignMetricsSchema.parse({
    version: 1,
    startedAtMs: now,
    planRequests: 0,
    programRequests: 0,
    repairRequests: 0,
    providerRounds: 0,
    providerInputBytes: 0,
    providerLatencyMs: 0,
    nativeBatches: 0,
    nativeDurationMs: 0,
    acceptedScreenTimesMs: [],
    timingEvidence,
    benchmarkComparableTiming: "not-measured",
  });
}

function createJobManifest(task: ChatTask, plan: ProjectPlanV1, planFingerprint: string) {
  if (!task.model) fail("model_not_pinned", "The task manifest requires the exact account-visible model already pinned to this Chat task.");
  const base = {
    version: 1 as const,
    taskId: task.id,
    engineRoute: "universal-design-v1" as const,
    modelSlug: task.model,
    planFingerprint,
    designProgramVersion: plan.designProgramVersion,
    platform: plan.platform,
    locale: plan.locale,
    direction: plan.direction,
    screens: plan.screens.map(({ screenId, order, name, role, dependencies }) => ({ screenId, order, name, role, dependencies })),
    ...(task.brandKit ? {
      brandKit: {
        id: task.brandKit.id,
        revision: task.brandKit.revision,
        tokenHash: task.brandKit.tokenHash,
        assets: task.brandKit.assets.map(({ assetId, contentHash }) => ({ assetId, contentHash })).sort((a, b) => a.assetId.localeCompare(b.assetId)),
      },
    } : {}),
    skills: (task.designSkills ?? []).map(({ id, revisionId }) => ({ id, revisionId })).sort((a, b) => a.id.localeCompare(b.id)),
    capabilities: [...plan.capabilityFlags],
    layoutCapabilities: ["auto-layout", "fill-and-hug-sizing", "bounded-wrap", "vertical-scroll", "native-components", "editable-text"],
  };
  return UniversalJobManifestV1Schema.parse({ ...base, fingerprint: universalJobManifestFingerprint(base) });
}

function safeErrorCode(error: unknown): string {
  const candidate = error && typeof error === "object"
    ? "code" in error && typeof error.code === "string"
      ? error.code
      : "category" in error && typeof error.category === "string"
        ? error.category
        : undefined
    : undefined;
  return candidate && /^[A-Za-z0-9_.:-]{1,100}$/u.test(candidate) ? candidate : "provider_or_host_error";
}

function visualReviewFailureStatus(reason: string | undefined): VisualQaOutcomeV1["visualReview"] {
  if (reason === "VISUAL_REVIEW_CONSENT_REQUIRED") return "VISUAL_REVIEW_CONSENT_REQUIRED";
  if (reason === "visual_review_unsupported_capability") return "VISUAL_REVIEW_UNSUPPORTED";
  if (reason === "visual_review_authorization_required" || reason === "visual_review_model_unavailable") return "VISUAL_REVIEW_AUTHORIZATION_REQUIRED";
  if (reason === "visual_review_timed_out") return "VISUAL_REVIEW_INCONCLUSIVE";
  if (reason === "visual_review_temporarily_unavailable") return "VISUAL_REVIEW_TEMPORARILY_UNAVAILABLE";
  return "VISUAL_REVIEW_UNAVAILABLE";
}

function cancellationOrigin(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return chatAbortOrigin(signal);
  const diagnostic = error && typeof error === "object" && "diagnostic" in error ? error.diagnostic : undefined;
  const origin = diagnostic && typeof diagnostic === "object" && "cancellationOrigin" in diagnostic
    ? diagnostic.cancellationOrigin : undefined;
  return isChatAbortOrigin(origin) ? origin : undefined;
}

function pinnedBrandAssetIds(task: ChatTask): Set<string> {
  return new Set(task.brandKit?.assets.map(({ assetId }) => assetId) ?? []);
}

function layoutTopology(root: DesignProgramV1["screens"][number]["root"]): string {
  if (root.type !== "container") return root.type;
  return JSON.stringify([root.layout.axis, root.children.map((child) => child.type === "container"
    ? [child.layout.axis, child.children.map((grandchild) => grandchild.type === "container" ? [grandchild.layout.axis, grandchild.children.length] : grandchild.type)]
    : child.type)]);
}

function isContrastFinding({ code }: { code: string }): boolean {
  return code === "quality_low-contrast" || code === "quality_contrast-unmeasurable";
}

function failContrast(screenId: string, findings: Array<{ code: string; path: string; message: string }>) {
  const details = findings.filter(isContrastFinding).slice(0, 2).map(({ path, message }) => `${path} — ${message}`);
  if (details.length)
    fail("program_contrast_unresolved", `No safe semantic color repair on ${screenId}. ${details.join(" ")} No native render was dispatched for this screen.`);
}

function findingsForProgram(program: DesignProgramV1, expectedScreenId: string, plan: ProjectPlanV1, planScreen: ProjectPlanV1["screens"][number], task: ChatTask): Array<{ code: string; path: string; message: string }> {
  const findings: Array<{ code: string; path: string; message: string }> = [];
  const screen = program.screens[0];
  if (!screen || program.screens.length !== 1)
    findings.push({ code: "one_screen_required", path: "screens", message: "The saved program must contain exactly one screen." });
  else {
    if (screen.id !== expectedScreenId)
      findings.push({ code: "screen_identity_mismatch", path: "screens.0.id", message: "The program screen ID differs from the stable planned ID." });
    if (screen.viewport.preset !== planScreen.viewport.preset || screen.viewport.width !== planScreen.viewport.width || screen.viewport.height !== planScreen.viewport.height)
      findings.push({ code: "viewport_mismatch", path: "screens.0.viewport", message: "The program viewport differs from the saved project plan." });
  }
  if (program.locale.direction !== plan.direction || program.locale.language.toLocaleLowerCase() !== plan.locale.toLocaleLowerCase())
    findings.push({ code: "locale_mismatch", path: "locale", message: "The program language or reading direction differs from the saved project plan." });
  const allowedBrandAssetIds = pinnedBrandAssetIds(task);
  const parsed = parseDesignProgram(program, { allowedBrandAssetIds });
  if (!parsed.success)
    findings.push(...parsed.findings.filter((finding) => finding.severity === "error").slice(0, 10).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })));
  const compiled = compileDesignProgram(program, { allowedBrandAssetIds });
  if (!compiled.success)
    findings.push(...compiled.findings.slice(0, 10).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })));
  if (parsed.success && screen) {
    const textContent: string[] = [];
    const visit = (node: DesignProgramV1["screens"][number]["root"]) => {
      if (node.type === "text") textContent.push(node.text.trim());
      if (node.type === "container") node.children.forEach(visit);
    };
    visit(screen.root);
    if (screen.root.type !== "container")
      findings.push({ code: "screen_root_not_container", path: "screens.0.root", message: "The screen root must be an editable layout container." });
    if (!textContent.some((value) => value.length > 1 && !/^(?:placeholder|lorem ipsum|sample text)$/iu.test(value)))
      findings.push({ code: "meaningful_content_missing", path: "screens.0.root", message: "The screen has no meaningful editable text for its planned purpose." });
    if (!screen.compositionV1)
      findings.push({ code: "composition_intent_missing", path: "screens.0.compositionV1", message: "The screen must record its archetype, visual rationale and semantic region mapping." });
    else if (plan.visualLanguageV1) {
      if (screen.compositionV1.regions.length !== planScreen.regions.length)
        findings.push({ code: "planned_region_coverage_mismatch", path: "screens.0.compositionV1.regions", message: "Map each planned semantic region to a distinct editable container." });
      else if (screen.compositionV1.regions.some((region, index) => region.semanticRole.toLocaleLowerCase() !== planScreen.regions[index]?.semanticRole.toLocaleLowerCase()))
        findings.push({ code: "planned_region_role_mismatch", path: "screens.0.compositionV1.regions", message: "Keep each composition region aligned with the matching planned semantic role." });
      const unknownEntities = screen.compositionV1.entityRefs.filter((ref) => !planScreen.entityRefs.includes(ref));
      if (unknownEntities.length)
        findings.push({ code: "unplanned_entity_reference", path: "screens.0.compositionV1.entityRefs", message: "Composition entity references must come from the saved screen plan." });
    }
    if (program.visualLanguageV1 && plan.visualLanguageV1 && JSON.stringify(program.visualLanguageV1) !== JSON.stringify(plan.visualLanguageV1))
      findings.push({ code: "visual_language_drift", path: "visualLanguageV1", message: "Every screen must retain the exact visual language saved for its project." });
    if (plan.visualLanguageV1 && planScreen.order < 3) {
      const topology = layoutTopology(screen.root);
      const repeatedEarlierRole = task.universalScreens?.some((saved) => {
        if (saved.screenId === planScreen.screenId || !saved.program) return false;
        const priorPlan = plan.screens.find(({ screenId }) => screenId === saved.screenId);
        const priorScreen = saved.program.screens[0];
        return Boolean(priorPlan && priorScreen && priorPlan.role.toLocaleLowerCase() !== planScreen.role.toLocaleLowerCase() && layoutTopology(priorScreen.root) === topology);
      });
      if (repeatedEarlierRole)
        findings.push({ code: "repeated_screen_topology", path: "screens.0.root", message: "Use a distinct editable layout structure when this screen has a different role from an earlier planned screen." });
    }
    if (compiled.success) {
      const actionable = compiled.findings.filter((finding) => isContrastFinding(finding) || finding.code === "quality_overflow-risk" || finding.code === "quality_small-touch-target");
      findings.push(...actionable.map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })));
    }
  }
  return [...new Map(findings.map((finding) => [`${finding.code}:${finding.path}`, finding])).values()].slice(0, 12);
}

function visualLanguageForPlan(plan: ProjectPlanV1): ProjectVisualLanguageV1 {
  return plan.visualLanguageV1 ?? createDefaultVisualLanguage({ styleDirection: plan.styleDirection, density: plan.contentDensity, locale: plan.locale });
}

function logContrastRepairs(screenId: string, repairs: ReturnType<typeof normalizeDesignProgramContrast>["repairs"]) {
  if (repairs.length) console.info("[universal-quality]", { screenId, repairCount: repairs.length, repairs: repairs.slice(0, 12) });
}

function normalizedProgram(value: DesignProgramV1, plan: ProjectPlanV1, screenPlan: ProjectPlanV1["screens"][number]): DesignProgramV1 {
  const screen = value.screens[0];
  if (!screen || value.screens.length !== 1)
    fail("program_screen_mismatch", "The model must return exactly the one planned screen.");
  const required = new Set(value.requiredCapabilities);
  required.add("native-text");
  required.add("auto-layout");
  if (plan.direction === "rtl") required.add("rtl");
  if (screenPlan.scroll === "vertical") required.add("vertical-scroll");
  if (screen.root.type === "container") {
    const visit = (node: DesignProgramV1["screens"][number]["root"]) => {
      if (node.type === "vector") required.add("vector");
      if (node.type === "image" && node.asset.source === "user-approved-brand-kit") required.add("image");
      if (node.type === "container") node.children.forEach(visit);
    };
    visit(screen.root);
  }
  const visualLanguageV1 = visualLanguageForPlan(plan);
  const existingComposition = screen.compositionV1;
  const childRegions = screen.root.type === "container" ? screen.root.children.filter((node) => node.type === "container").slice(0, 6) : [];
  const assetRefs: string[] = [];
  const collectAssets = (node: DesignProgramV1["screens"][number]["root"]) => {
    if (node.type === "image" && node.asset.source === "user-approved-brand-kit" && node.asset.assetRef) assetRefs.push(node.asset.assetRef);
    if (node.type === "container") node.children.forEach(collectAssets);
  };
  collectAssets(screen.root);
  const compositionV1 = {
    ...(existingComposition ?? {
      version: 1 as const,
      archetype: "custom" as const,
      decisionTrace: "Recovered from the saved editable container hierarchy.",
      focusNodeId: childRegions[0]?.id ?? screen.root.id,
      responsiveIntent: `${plan.platform} viewport with ${screenPlan.scroll === "vertical" ? "vertical scroll" : "contained content"}.`,
      regions: (childRegions.length ? childRegions : [screen.root]).map((node, index) => ({ nodeId: node.id, semanticRole: node.semanticRole, priority: Math.min(index + 1, 6), visualWeight: Math.max(1, 6 - index), contentKind: "text" as const })),
      entityRefs: screenPlan.entityRefs,
      approvedAssetsUsed: [...new Set(assetRefs)],
    }),
    variationSeed: compositionVariationSeed(plan.taskId, screenPlan.screenId),
  };
  const languageColors = visualLanguageV1.colorRoles;
  const normalized = DesignProgramV1Schema.parse({
    ...value,
    id: plan.projectId,
    revision: 1,
    contentProvenance: plan.contentSamplePolicy === "clearly-illustrative" ? "synthetic-illustrative" : value.contentProvenance,
    requiredCapabilities: [...required],
    visualLanguageV1,
    tokens: {
      ...value.tokens,
      colors: {
        ...value.tokens.colors,
        page: languageColors.page,
        background: languageColors.page,
        surface: languageColors.surface,
        "raised-surface": languageColors.raisedSurface,
        primary: languageColors.primary,
        accent: languageColors.accent,
        text: languageColors.text,
        muted: languageColors.mutedText,
        border: languageColors.border,
      },
      spacing: visualLanguageV1.spacingScale,
      headingFont: visualLanguageV1.typography.headingFont,
      bodyFont: visualLanguageV1.typography.bodyFont,
    },
    locale: value.locale,
    screens: [{
      ...screen,
      id: screenPlan.screenId,
      title: screenPlan.name,
      purpose: screenPlan.purpose,
      order: screenPlan.order,
      viewport: screen.viewport,
      scroll: screenPlan.scroll,
      compositionV1,
      // Inter-screen dependencies live in ProjectPlanV1. This isolated program
      // is rendered and validated as one screen, so it cannot reference sibling IDs.
      dependsOn: [],
    }],
  });
  const quality = normalizeDesignProgramContrast(normalized);
  logContrastRepairs(screenPlan.screenId, quality.repairs);
  return quality.program;
}

function estimateNativeNodes(program: DesignProgramV1, task: ChatTask): number {
  let extraImageNodes = 0;
  const visit = (node: DesignProgramV1["screens"][number]["root"]) => {
    if (node.type === "image") {
      if (node.asset.source === "placeholder") extraImageNodes++;
      else if (node.asset.source === "user-approved-brand-kit" && node.asset.assetRef) {
        const pinned = task.brandKit?.assets.find(({ assetId }) => assetId === node.asset.assetRef);
        // Safe SVGs may expand to one editable frame plus at most 32 vector paths.
        if (pinned?.kind === "svg-paths") extraImageNodes += 32;
      } else extraImageNodes += 32;
    }
    if (node.type === "container") node.children.forEach(visit);
  };
  visit(program.screens[0]!.root);
  const parsed = parseDesignProgram(program, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
  return parsed.success ? parsed.nodeCount + extraImageNodes + 2 : Number.MAX_SAFE_INTEGER;
}

function nativeSubtree(nodes: NonNullable<NativeInspection["nodes"]>, rootId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return [...ids].map((id) => byId.get(id)).filter((node): node is NonNullable<typeof node> => Boolean(node));
}

function createVisualReviewRequest(input: {
  task: ChatTask;
  screen: UniversalScreenCheckpoint;
  screenPlan: ProjectPlanV1["screens"][number];
  inspection: NativeInspection;
  receipt: VisualCaptureReceiptV1;
  pngBytes: Uint8Array<ArrayBuffer>;
  attempt: 1 | 2;
}): VisualReviewRequestV1 {
  const { task, screen, screenPlan, inspection, receipt, pngBytes, attempt } = input;
  const program = screen.program;
  const plannedScreen = program?.screens.find(({ id }) => id === screen.screenId);
  if (!program || !plannedScreen || !inspection.nodes || !screen.nativeRootNodeId)
    throw new Error("review_context_missing");
  const native = nativeSubtree(inspection.nodes, screen.nativeRootNodeId);
  if (native.length > 80) throw new Error("review_native_context_limit");
  const nativeById = new Map(native.map((node) => [node.id, node]));
  const root = nativeById.get(screen.nativeRootNodeId);
  if (!root) throw new Error("review_root_missing");
  const nativeBounds = (node: NonNullable<NativeInspection["nodes"]>[number]) => {
    let x = 0;
    let y = 0;
    let current: typeof node | undefined = node;
    const visited = new Set<string>();
    while (current && current.id !== root.id && visited.size < 16 && !visited.has(current.id)) {
      visited.add(current.id);
      x += current.x;
      y += current.y;
      current = current.parentId ? nativeById.get(current.parentId) : undefined;
    }
    if (node.id !== root.id && current?.id !== root.id) throw new Error("review_native_parent_chain_invalid");
    return { x, y, width: node.width, height: node.height };
  };
  const programNodes: Array<{
    nodeId: string;
    parentNodeId?: string;
    type: "container" | "text" | "rectangle" | "ellipse" | "vector" | "instance" | "image";
    semanticRole: string;
    width: { mode: "FIXED" | "HUG" | "FILL"; value: number };
    height: { mode: "FIXED" | "HUG" | "FILL"; value: number };
    textLength?: number;
    fontSize?: number;
  }> = [];
  const visit = (node: typeof plannedScreen.root, parentNodeId?: string) => {
    programNodes.push({
      nodeId: node.id,
      ...(parentNodeId ? { parentNodeId } : {}),
      type: node.type,
      semanticRole: node.semanticRole,
      width: { mode: node.width.mode.toUpperCase() as "FIXED" | "HUG" | "FILL", value: node.width.value },
      height: { mode: node.height.mode.toUpperCase() as "FIXED" | "HUG" | "FILL", value: node.height.value },
      ...(node.type === "text" ? { textLength: node.text.length, fontSize: node.fontSize } : {}),
    });
    if (node.type === "container") node.children.forEach((child) => visit(child, node.id));
  };
  visit(plannedScreen.root);
  if (programNodes.length > 80) throw new Error("review_program_context_limit");
  return {
    version: 1,
    requestId: `${receipt.receiptId.slice(4)}_review`,
    taskId: task.id,
    taskGeneration: task.generationLink?.generationId ?? `generation-${task.universalManifest?.fingerprint ?? task.id}`,
    screenId: screen.screenId as VisualReviewRequestV1["screenId"],
    documentId: task.documentId,
    pageId: receipt.pageId,
    rootId: receipt.rootId,
    programFingerprint: receipt.programFingerprint,
    readbackRevision: receipt.readbackRevision,
    receiptId: receipt.receiptId,
    imageRevision: attempt,
    viewport: { width: screenPlan.viewport.width, height: screenPlan.viewport.height },
    scrollIntent: plannedScreen.scroll,
    nodes: native.map((node) => ({
      nodeId: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.logicalRef ? { logicalRef: node.logicalRef } : {}),
      ...(node.semanticRole ? { semanticRole: node.semanticRole } : {}),
      type: node.type as "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "VECTOR" | "COMPONENT" | "INSTANCE",
      bounds: nativeBounds(node),
      visible: node.visible,
      ...(node.clipsContent !== undefined ? { clipsContent: node.clipsContent } : {}),
      ...(node.overflowDirection ? { overflowDirection: node.overflowDirection } : {}),
      ...(node.textLength !== undefined ? { textLength: node.textLength } : {}),
      ...(node.fontFamily ? { fontFamily: node.fontFamily } : {}),
      ...(node.fontSize !== undefined ? { fontSize: node.fontSize } : {}),
      ...(node.layoutSizingHorizontal ? { layoutSizingHorizontal: node.layoutSizingHorizontal } : {}),
      ...(node.layoutSizingVertical ? { layoutSizingVertical: node.layoutSizingVertical } : {}),
      ...(node.textAutoResize ? { textAutoResize: node.textAutoResize } : {}),
    })),
    program: {
      programId: program.id,
      programRevision: program.revision,
      screenId: screen.screenId as VisualReviewRequestV1["screenId"],
      viewport: { width: screenPlan.viewport.width, height: screenPlan.viewport.height },
      language: program.locale.language,
      direction: program.locale.direction,
      scrollIntent: plannedScreen.scroll,
      nodes: programNodes,
    },
    pngBytes,
  };
}

async function captureVisualAttempt(input: {
  deps: UniversalDesignDependencies;
  task: ChatTask;
  screen: UniversalScreenCheckpoint;
  pageId: string;
  readbackRevision: string;
  attempt: 1 | 2;
  previousReceiptId?: string;
}): Promise<{ receipt: VisualCaptureReceiptV1; pngBytes?: Uint8Array<ArrayBuffer>; exportMs: number; failureReason?: string }> {
  const { deps, task, screen, pageId, readbackRevision, attempt, previousReceiptId } = input;
  const requestId = `${task.id}_fw5_${screen.screenId}_${screen.renderAttempts ?? 1}_a${attempt}`;
  const request: VisualCaptureRequestV1 = {
    version: 1, taskId: task.id, screenId: screen.screenId as VisualCaptureRequestV1["screenId"],
    authorizedDocumentScope: { documentId: task.documentId, pageId, rootId: screen.nativeRootNodeId! },
    pageId, rootId: screen.nativeRootNodeId!, programFingerprint: screen.fingerprint!, readbackRevision,
    captureAttempt: attempt, ...(previousReceiptId ? { previousReceiptId } : {}),
    maxPixelWidth: FW5_VISUAL_CAPTURE_LIMITS.maxPixelWidth,
    maxPixelHeight: FW5_VISUAL_CAPTURE_LIMITS.maxPixelHeight,
    maxBytes: FW5_VISUAL_CAPTURE_LIMITS.maxBytes,
    deadlineAtMs: Date.now() + FW5_VISUAL_CAPTURE_LIMITS.timeoutMs,
    captureNonce: requestId,
  };
  const makeFailure = (status: "CAPTURE_FAILED" | "UNVERIFIED", diagnostic: VisualCaptureReceiptV1["diagnostic"]) => VisualCaptureReceiptV1Schema.parse({
    version: 1, status, receiptId: `fw5-${requestId}`, taskId: task.id,
    screenId: screen.screenId, documentId: task.documentId, pageId, rootId: screen.nativeRootNodeId!,
    programFingerprint: screen.fingerprint!, readbackRevision, mime: "image/png", width: 0, height: 0,
    byteLength: 0, capturedAtMs: Date.now(), exportScale: 1, captureAttempt: attempt,
    ...(previousReceiptId ? { previousReceiptId } : {}), diagnostic,
  });
  const startedAt = performance.now();
  try {
    if (!deps.captureVisual) throw Object.assign(new Error("Visual capture bridge is unavailable."), { code: "visual_capture_transport_unavailable" });
    const response = await deps.captureVisual({
      type: "task-native-visual-capture", requestId, rootRef: screen.rootRef!, visualCapture: request,
      ...(FW4_GEOMETRY_ENABLED ? { expectedLayout: projectNativeLayoutExpectations(screen.program!, screen.screenId) } : {}),
    }, deps.signal);
    if (deps.signal.aborted) throw Object.assign(new Error("Visual capture cancelled."), { code: "visual_capture_cancelled" });
    const exportMs = response.exportDurationMs ?? Math.max(0, Math.round(performance.now() - startedAt));
    const rawReceipt = response.success ? response.visualCapture?.receipt : response.receipt;
    const identityMatches = response.requestId === requestId && response.taskId === task.id && rawReceipt?.taskId === task.id &&
      rawReceipt.screenId === screen.screenId && rawReceipt.documentId === task.documentId && rawReceipt.pageId === pageId &&
      rawReceipt.rootId === screen.nativeRootNodeId && rawReceipt.programFingerprint === screen.fingerprint &&
      rawReceipt.readbackRevision === readbackRevision && rawReceipt.captureAttempt === attempt &&
      rawReceipt.previousReceiptId === previousReceiptId;
    if (!identityMatches) return { receipt: makeFailure("UNVERIFIED", "identity_mismatch"), exportMs, failureReason: "visual_capture_receipt_identity_mismatch" };
    if (!response.success) {
      const receipt = VisualCaptureReceiptV1Schema.safeParse(response.receipt);
      return { receipt: receipt.success ? receipt.data : makeFailure("CAPTURE_FAILED", "capture_transport_unavailable"), exportMs,
        failureReason: receipt.success ? receipt.data.diagnostic : "visual_capture_receipt_invalid" };
    }
    const transport = VisualCaptureTransportV1Schema.safeParse(response.visualCapture);
    const dimensions = transport.success ? pngDimensions(transport.data.pngBytes) : undefined;
    if (!transport.success || !dimensions || dimensions.width !== rawReceipt!.width || dimensions.height !== rawReceipt!.height ||
        transport.data.pngBytes.byteLength !== rawReceipt!.byteLength || rawReceipt!.status !== "CAPTURED")
      return { receipt: makeFailure("CAPTURE_FAILED", "capture_transport_unavailable"), exportMs, failureReason: "visual_capture_transport_invalid" };
    const receipt = VisualCaptureReceiptV1Schema.parse({ ...rawReceipt, contentDigest: visualContentDigest(transport.data.pngBytes) });
    return { receipt, pngBytes: transport.data.pngBytes, exportMs };
  } catch (error) {
    if (deps.signal.aborted) throw error;
    const exportMs = Math.max(0, Math.round(performance.now() - startedAt));
    const failureReason = safeErrorCode(error);
    return { receipt: makeFailure("CAPTURE_FAILED", failureReason.includes("timeout") ? "capture_deadline_exceeded" : "capture_transport_unavailable"), exportMs, failureReason };
  }
}

function verifyNativeReadback(
  response: NativeInspection,
  screen: UniversalScreenCheckpoint,
  plan: ProjectPlanV1,
  allowOneSizingMismatch = false,
): { nodeCount: number; findings: string[] } {
  if (response.expectedRootStatus === "removed")
    fail("native_root_removed", "Figma reported that the acknowledged native root was removed.");
  if (response.expectedRootStatus === "missing")
    fail("native_root_missing", "Figma could not locate the acknowledged native root. Its deletion is unconfirmed.");
  if (response.expectedRootStatus === "unexpected_parent")
    fail("native_root_moved_or_retagged", "The acknowledged root has a different parent. It was retained in place.");
  if (!response.success || !response.nodes || response.truncated)
    fail("native_readback_incomplete", "The task-owned native readback was failed, missing nodes, or truncated; this screen stays unverified.");
  if ((response.unresolvedRefs ?? []).some(({ ref }) => ref === screen.rootRef))
    fail("native_root_unresolved", "Figma could not resolve the adopted root reference for this screen.");
  const root = response.nodes.find(({ ref }) => ref === screen.rootRef);
  if (!root || root.type !== "FRAME")
    fail("native_root_invalid", "A unique task-owned native Frame root was not returned by readback.");
  if (screen.nativeRootNodeId && root.id !== screen.nativeRootNodeId)
    fail("native_root_identity_conflict", "The readback root differs from the acknowledged native node.");
  if (!root.visible)
    fail("native_root_hidden", "The acknowledged root is hidden in Figma. It was retained in place.");
  const screenPlan = plan.screens.find(({ screenId }) => screenId === screen.screenId);
  if (!screenPlan) fail("checkpoint_incomplete", "The readback screen is absent from the saved plan.");
  if (root.width !== screenPlan.viewport.width || root.height !== screenPlan.viewport.height)
    fail("native_viewport_mismatch", "The native root dimensions differ from the planned viewport.");
  if (screenPlan.scroll === "vertical" && (!root.clipsContent || !["VERTICAL", "BOTH"].includes(root.overflowDirection ?? "NONE")))
    fail("native_scroll_mismatch", "The native root did not retain the planned vertical scroll behavior.");
  const subtree = nativeSubtree(response.nodes, root.id);
  if (subtree.length !== screen.nativeNodeCount)
    fail("native_node_count_mismatch", "Native readback did not match the exact adopted subtree node count.");
  if (!response.geometry || response.geometry.coverage !== "complete" || response.geometry.measuredNodes !== subtree.length)
    fail("native_geometry_incomplete", "Figma could not measure the full task-owned screen geometry.");
  const oneSizingMismatch = response.geometry.findings.length === 1 &&
    response.geometry.findings[0]?.code === "native_layout_sizing_mismatch" &&
    Boolean(response.geometry.findings[0]?.nodeId && response.geometry.findings[0]?.parentId &&
      response.geometry.findings[0]?.logicalRef && response.geometry.findings[0]?.expectedLayout &&
      response.geometry.findings[0]?.observedLayout);
  if (response.geometry.findings.length && !(allowOneSizingMismatch && oneSizingMismatch))
    fail("native_geometry_failed", "Figma detected a layout or ownership discrepancy. The saved screen remains unverified.");
  const allowedTypes = new Set(["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "COMPONENT", "INSTANCE"]);
  if (subtree.some((node) => !allowedTypes.has(node.type)))
    fail("native_node_type_unsupported", "The screen contains a node type outside the editable native types supported by this route.");
  if (!subtree.some((node) => node.type === "TEXT"))
    fail("native_text_missing", "The native screen has no editable text content.");
  const warnings = (screen.findings ?? []).map((finding) => finding.code);
  return { nodeCount: subtree.length, findings: warnings };
}

function buildVisualQaOutcome(input: {
  taskId: string;
  screenId: string;
  fingerprint: string;
  rootId: string;
  pageId: string;
  readbackRevision?: string;
  nativeGeometry: VisualQaOutcomeV1["nativeGeometry"];
  designProgramConsistency: VisualQaOutcomeV1["designProgramConsistency"];
  captureReceipt?: VisualCaptureReceiptV1;
  nativeFindingCodes?: string[];
  failureReason?: string;
  exportMs?: number;
  nativeReadbackMs?: number;
}): VisualQaOutcomeV1 {
  const findings = (input.nativeFindingCodes ?? []).slice(0, 12).map((code) => ({
    findingId: visualFindingId("native_geometry_finding", input.rootId, code),
    taskId: input.taskId,
    screenId: input.screenId as VisualReviewRequestV1["screenId"],
    issueCode: "native_geometry_finding" as const,
    source: "native-rule" as const,
    evidenceSource: "native-readback" as const,
    severity: "error" as const,
    evidenceRef: `native-readback:${code}`,
    nodeId: input.rootId,
    uncertain: false,
    safeToAutoRepair: false,
    suggestedRepairCategory: "none" as const,
  }));
  const receipt = input.captureReceipt;
  const captureStatus = receipt?.status ?? "UNVERIFIED";
  const status: VisualQaOutcomeV1["status"] = findings.length
    ? "FINDINGS"
    : captureStatus === "CAPTURE_FAILED" ? "CAPTURE_FAILED" : captureStatus === "CAPTURED" ? "REVIEW_UNAVAILABLE" : "UNVERIFIED";
  const repairReason = FW5_VISUAL_REVIEW_MODE === "capture-only" ? "capture_only_policy" : "reviewer_unavailable";
  return VisualQaOutcomeV1Schema.parse({
    version: 1,
    status,
    taskId: input.taskId,
    screenId: input.screenId,
    programFingerprint: input.fingerprint,
    rootId: input.rootId,
    pageId: input.pageId,
    ...(input.readbackRevision ? { readbackRevision: input.readbackRevision } : {}),
    nativeGeometry: input.nativeGeometry,
    designProgramConsistency: input.designProgramConsistency,
    visualCapture: receipt?.status === "CAPTURED" ? "CAPTURED" : receipt?.status === "CAPTURE_FAILED" ? "CAPTURE_FAILED" : "UNVERIFIED",
    visualReview: "VISUAL_REVIEW_UNAVAILABLE",
    reviewMode: FW5_VISUAL_REVIEW_MODE,
    ...(receipt ? { afterReceiptId: receipt.receiptId, captureReceipt: receipt } : {}),
    findingCounts: { nativeRule: findings.length, pixelReview: 0, human: 0 },
    repair: { status: "REPAIR_BLOCKED", attempts: 0, reason: repairReason },
    findings,
    diagnostics: {
      ...(receipt?.byteLength ? { payloadBytes: receipt.byteLength } : {}),
      ...(input.exportMs !== undefined ? { exportMs: Math.round(input.exportMs) } : {}),
      ...(input.nativeReadbackMs !== undefined ? { nativeReadbackMs: Math.round(input.nativeReadbackMs) } : {}),
      reviewerCalls: 0,
      repairAttempts: 0,
      repairMethods: [],
      ...(input.failureReason ? { failureReason: input.failureReason.slice(0, 100) } : {}),
    },
  });
}

export async function runUniversalDesignTask(task: ChatTask, deps: UniversalDesignDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const runStartedAt = monotonicNow();
  const screenRunStartedAt = new Map<string, number>();
  const freshVisualCaptureScreens = new Set<string>();
  let saveQueue = Promise.resolve();
  let saveFailure: { error: unknown } | undefined;
  let taskStateQueue = Promise.resolve();
  let activeScreenModelCalls = 0;
  const withTaskLock = async <T>(work: () => Promise<T> | T): Promise<T> => {
    const operation = taskStateQueue.then(work, work);
    taskStateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const check = () => {
    if (deps.signal.aborted) throw new UniversalDesignTaskError("request_cancelled", "The request stopped. Saved plans and confirmed screens are retained.");
    if (deps.isCurrent && !deps.isCurrent()) throw new UniversalDesignTaskError("stale_task_session", "This task was replaced or selected elsewhere. Its late provider results were ignored.");
  };
  const transition = (lifecycle: ChatLifecycleState) => {
    if (task.lifecycle === lifecycle) return;
    task.lifecycle = lifecycle;
    task.lifecycleTransitions++;
  };
  const recordTrace = (event: Omit<UniversalDesignTraceEvent, "eventId" | "taskId" | "engineRoute" | "buildId">) => {
    const metrics = task.universalMetrics;
    if (!metrics) return;
    metrics.traceSequence++;
    const traceEvent: UniversalDesignTraceEvent = {
      eventId: `${task.id}_p6e${metrics.traceSequence}`,
      taskId: task.id,
      engineRoute: "universal-design-v1",
      buildId: UNIVERSAL_DESIGN_TRACE_BUILD_ID,
      ...event,
    };
    metrics.traceEvents = [...metrics.traceEvents, traceEvent].slice(-128);
    if (event.providerRequestId && event.event === "request_failed") {
      console.info("[FAD_CHAT_CANCEL] " + JSON.stringify({
        actor: "scheduler", event: "request_failed", atMs: now(), taskId: task.id,
        requestId: event.providerRequestId, stageId: event.stageId,
        lifecycle: event.stage === "compose" ? "UNIVERSAL_COMPOSING"
          : event.stage === "repair" ? "UNIVERSAL_REPAIR" : task.lifecycle,
        code: event.code, cancellationOrigin: event.cancellationOrigin,
      }));
    }
  };
  const save = async (snapshot: ChatTask = task) => {
    check();
    const parsed = ChatTaskSchema.safeParse(snapshot);
    if (!parsed.success)
      fail("checkpoint_invalid", "The universal route could not save a schema-valid checkpoint; no new native render was dispatched.");
    if (utf8Bytes(JSON.stringify(parsed.data)) > CHAT_TASK_MAX_BYTES)
      fail("checkpoint_size_limit", "The task checkpoint reached its 512 KiB safety budget; existing canvas work is retained and no further native work was started.");
    const startedAt = monotonicNow();
    const pendingWrite = saveQueue.then(async () => {
      if (saveFailure) throw saveFailure.error;
      check();
      try {
        await deps.save(parsed.data);
      } catch (error) {
        saveFailure = { error };
        throw error;
      }
    });
    saveQueue = pendingWrite.then(() => undefined, () => undefined);
    await pendingWrite;
    check();
    const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
    if (task.universalMetrics) {
      task.universalMetrics.persistenceMs += durationMs;
      recordTrace({ stageId: "task", stage: "persistence", event: "checkpoint_saved", outcome: "completed", durationMs });
    }
  };
  if (task.executionRoute !== "universal-design-v1" || task.intent !== "create")
    fail("route_intent_conflict", "Only the checkpointed universal create route can run this planner.");
  if (!isExplicitCanvasRequest(task.prompt) || !isClearCreateRequest(task.prompt))
    fail("canvas_intent_not_authorized", "The original message does not request an editable Canvas design.");
  if (!task.model) fail("model_not_pinned", "The Chat task has no pinned account-visible model.");
  let localContext: ReturnType<typeof plannerDesignContext>;
  let contextTicket: ContextTicket | undefined;
  const approval = requestedDesignContext(task.prompt, "create");
  if (approval && deps.readContext && !task.projectPlan && !task.pending.length) {
    check();
    await deps.assertAuthorized();
    check();
    const result = await deps.readContext();
    check();
    if (result?.success) {
      localContext = plannerDesignContext(result.snapshot);
      if (localContext && approval.reuse) contextTicket = { requestId: result.requestId, digest: result.snapshot.digest };
    } else if (result) deps.progress(`Scoped design context unavailable (${result.code}); continuing without it.`);
  }
  const importingIntentTiming = !task.universalMetrics;
  if (importingIntentTiming) {
    const intentRounds = task.modelRoundTrace.filter((round) => round.lifecycle === "UNIVERSAL_CLASSIFY");
    const metrics = initialMetrics(Math.max(0, Math.floor(runStartedAt)), deps.timingEvidence ?? "live");
    metrics.intentRequests = intentRounds.length;
    metrics.intentClassificationMs = intentRounds.reduce((sum, round) => sum + (round.durationMs ?? 0), 0);
    metrics.providerRounds = intentRounds.length;
    metrics.providerInputBytes = intentRounds.reduce((sum, round) => sum + (round.inputBytes ?? 0), 0);
    metrics.providerLatencyMs = metrics.intentClassificationMs;
    metrics.providerFirstDeltaMs = intentRounds.reduce((sum, round) => sum + (round.timing?.upstreamFirstDeltaMs ?? 0), 0);
    task.universalMetrics = metrics;
  }
  const metricCheck = UniversalDesignMetricsSchema.safeParse(task.universalMetrics);
  if (!metricCheck.success) fail("metrics_checkpoint_invalid", "The saved route metrics are invalid.");
  task.universalMetrics = metricCheck.data;
  task.universalMetrics.startedAtMs = Math.max(0, Math.floor(runStartedAt));
  task.universalMetrics.schedulerMode = deps.maxConcurrentModelCalls === 1 ? "serial" : "bounded-parallel";
  task.universalMetrics.concurrencyLimit = Math.min(task.universalMetrics.concurrencyLimit, deps.maxConcurrentModelCalls ?? UNIVERSAL_DESIGN_MAX_CONCURRENT_MODEL_CALLS) as 1 | 2;
  if (importingIntentTiming) {
    const intentRounds = task.modelRoundTrace.filter((round) => round.lifecycle === "UNIVERSAL_CLASSIFY");
    intentRounds.forEach((round, index) => recordTrace({
      stageId: "task",
      stage: "intent",
      event: "request_completed",
      outcome: "completed",
      ...(round.providerRequestId ? { providerRequestId: round.providerRequestId } : {}),
      attempt: index + 1,
      ...(round.durationMs !== undefined ? { durationMs: round.durationMs } : {}),
      ...(round.inputBytes !== undefined ? { inputBytes: round.inputBytes } : {}),
      ...(round.timing?.upstreamHeadersMs !== undefined ? { upstreamHeadersMs: round.timing.upstreamHeadersMs } : {}),
      ...(round.timing?.upstreamFirstDeltaMs !== undefined ? { firstDeltaMs: round.timing.upstreamFirstDeltaMs } : {}),
    }));
  }
  await save();

  const requestTool = async (
    purpose: "plan" | "compose" | "repair",
    screen?: UniversalScreenCheckpoint,
  ): Promise<ChatFunctionCall> => {
    const lifecycle: ChatLifecycleState = purpose === "plan"
      ? "UNIVERSAL_PLANNING"
      : purpose === "compose"
        ? "UNIVERSAL_COMPOSING"
        : "UNIVERSAL_REPAIR";
    const expectedTool = purpose === "plan"
      ? "plan_universal_project"
      : purpose === "compose"
        ? "compose_design_program"
        : "repair_design_program";
    if (task.pending.length) {
      if (task.pending.length !== 1 || task.pending[0]?.action.tool !== expectedTool)
        fail("pending_response_scope_conflict", "The saved model response does not match the current universal lifecycle state.");
      return ChatFunctionCallSchema.parse(task.pending[0]);
    }
    const metrics = task.universalMetrics!;
    while (true) {
      check();
      await deps.assertAuthorized();
      transition(lifecycle);
      const input = requestInput(task, purpose, screen, undefined, localContext);
      const inputBytes = utf8Bytes(JSON.stringify(input));
      if (task.rounds >= 100) fail("model_round_limit", "The existing 100-round Chat task limit was reached before the route completed.");
      if ((purpose === "plan" && metrics.planRequests >= 3) ||
        (purpose === "compose" && metrics.programRequests >= 100) ||
        (purpose === "repair" && metrics.repairRequests >= 10))
        fail("model_request_limit", "The saved request budget for this stage is exhausted.");
      if (purpose === "plan") metrics.planRequests++;
      else if (purpose === "compose") metrics.programRequests++;
      else metrics.repairRequests++;
      const attempt = purpose === "plan" ? metrics.planRequests : purpose === "compose" ? metrics.programRequests : metrics.repairRequests;
      const requestId = `${task.id}_p6_${purpose}_${screen?.screenId ?? "task"}_${attempt}`;
      recordTrace({ stageId: screen?.screenId ?? "task", stage: purpose, event: "request_started", outcome: "started", providerRequestId: requestId, attempt, inputBytes });
      // A lost provider response consumes the attempt, but never commits a plan or native effect.
      await save();
      const startedAt = monotonicNow();
      let turn: AuthorizedChatTurn;
      try {
        turn = await deps.model(input, lifecycle, requestId, deps.signal);
      } catch (error) {
        recordTrace({ stageId: screen?.screenId ?? "task", stage: purpose, event: "request_failed", outcome: "failed", providerRequestId: requestId, attempt, durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)), code: safeErrorCode(error), cancellationOrigin: cancellationOrigin(error, deps.signal) });
        if (!deps.signal.aborted) await save();
        if (deps.signal.aborted || (deps.isCurrent && !deps.isCurrent())) check();
        throw error;
      }
      check();
      const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
      task.rounds++;
      metrics.providerRounds++;
      metrics.providerInputBytes += inputBytes;
      metrics.providerLatencyMs += durationMs;
      metrics.providerFirstDeltaMs += turn.timing?.upstreamFirstDeltaMs ?? 0;
      recordTrace({
        stageId: screen?.screenId ?? "task",
        stage: purpose,
        event: "request_completed",
        outcome: "completed",
        providerRequestId: requestId,
        attempt,
        durationMs,
        inputBytes,
        outputBytes: utf8Bytes(JSON.stringify(turn)),
        ...(turn.timing?.upstreamHeadersMs !== undefined ? { upstreamHeadersMs: turn.timing.upstreamHeadersMs } : {}),
        ...(turn.timing?.upstreamFirstDeltaMs !== undefined ? { firstDeltaMs: turn.timing.upstreamFirstDeltaMs } : {}),
      });
      if (purpose === "plan") task.roundBreakdown.prePlan++;
      else task.roundBreakdown.planning++;
      if (screen) {
        const screenIndex = task.projectPlan?.screens.findIndex(({ screenId }) => screenId === screen.screenId) ?? -1;
        const stage = screenIndex >= 0 ? task.stages[screenIndex] : undefined;
        if (stage) {
          stage.rounds++;
          stage.roundBreakdown ??= {
            prePlan: 0,
            planning: 0,
            execution: 0,
            inspection: 0,
            completion: 0,
            correction: 0,
            continuation: 0,
            modelRetries: 0,
          };
          stage.roundBreakdown.planning++;
        }
      }
      const tools = turn.kind === "tool_calls" ? turn.calls.map(({ name }) => name) : [];
      task.modelRoundTrace.push({
        round: task.rounds,
        lifecycle,
        outcome: turn.kind,
        tools,
        validationCodes: turn.kind === "tool_validation" ? turn.issues.slice(0, 8).map(({ errorCode }) => errorCode) : [],
        durationMs,
        inputBytes,
        ...(turn.timing ? { timing: turn.timing } : {}),
      });
      if (task.modelRoundTrace.length > 100) task.modelRoundTrace = task.modelRoundTrace.slice(-100);
      if (turn.kind === "tool_validation") {
        if (task.validationCorrections >= CHAT_TASK_MAX_VALIDATION_CORRECTIONS)
          fail("model_schema_repair_exhausted", "The model did not return a valid bounded structured response after two corrections.");
        task.validationCorrections++;
        if (screen) {
          screen.schemaCorrections++;
          if (screen.schemaCorrections > 2)
            fail("model_schema_repair_exhausted", "The screen program remained invalid after its bounded schema corrections.");
        }
        const codes = [...new Set(turn.issues.slice(0, 8).map(({ errorCode, toolName }) => `${toolName ?? expectedTool}:${errorCode}`))];
        task.validationFeedback = `The previous structured response failed boundary validation (${codes.join(", ")}). Return one corrected call to ${expectedTool} using the exact documented schema; do not add extra tools or screens.`;
        task.pending = [];
        task.recent = [];
        await save();
        continue;
      }
      if (turn.kind !== "tool_calls")
        fail("provider_response_incomplete", `The provider returned prose instead of the required ${expectedTool} call.`);
      if (turn.calls.length !== 1 || turn.calls[0]?.action.tool !== expectedTool)
        fail("provider_tool_contract_invalid", `The provider must return exactly one ${expectedTool} call for this lifecycle.`);
      const call = ChatFunctionCallSchema.parse(turn.calls[0]);
      delete task.validationFeedback;
      task.pending = [call];
      task.recent = [call.functionCall];
      await save();
      return call;
    }
  };

  const requestScreenCall = async (
    screen: UniversalScreenCheckpoint,
    purpose: "compose" | "repair",
    requestSignal: AbortSignal,
    queueWaitMs: number,
  ): Promise<ChatFunctionCall> => {
    const lifecycle: ChatLifecycleState = purpose === "compose" ? "UNIVERSAL_COMPOSING" : "UNIVERSAL_REPAIR";
    const expectedTool = purpose === "compose" ? "compose_design_program" : "repair_design_program";
    while (true) {
      check();
      if (requestSignal.aborted) throw new UniversalDesignTaskError("request_cancelled", "This bounded screen request was cancelled before a structured result was saved.");
      await deps.assertAuthorized();
      const reserved = await withTaskLock(async () => {
        check();
        const metrics = task.universalMetrics!;
        if (task.rounds + activeScreenModelCalls >= 100)
          fail("model_round_limit", "The existing 100-round Chat task limit was reached before the screen request started.");
        if ((purpose === "compose" && metrics.programRequests >= 100) || (purpose === "repair" && metrics.repairRequests >= 10))
          fail("model_request_limit", "The saved request budget for this screen stage is exhausted.");
        if (purpose === "compose" && screen.composeAttempts >= 3)
          fail("screen_compose_retry_limit", `The saved program request limit for ${screen.screenId} is exhausted; confirmed sibling screens are retained.`);
        if (purpose === "repair" && screen.repairAttempts >= 1)
          fail("program_repair_exhausted", `The bounded semantic repair for ${screen.screenId} is exhausted.`);
        if (purpose === "repair" && screen.repairDispatches >= 3)
          fail("screen_repair_request_limit", `The bounded repair request limit for ${screen.screenId} is exhausted.`);
        const attempt = purpose === "compose" ? screen.composeAttempts + 1 : screen.repairDispatches + 1;
        const requestId = `${task.id}_p6_${screen.screenId}_${purpose === "compose" ? "c" : "r"}${attempt}`;
        const input = requestInput(task, purpose, screen, screen.schemaFeedback, localContext);
        const inputBytes = utf8Bytes(JSON.stringify(input));
        if (inputBytes > MAX_CHAT_PROVIDER_INPUT_BYTES)
          fail("request_too_large", `The bounded ${purpose} request for ${screen.screenId} exceeds its ${MAX_CHAT_PROVIDER_INPUT_BYTES}-byte input limit.`);
        if (purpose === "compose") {
          screen.composeAttempts = attempt;
          metrics.programRequests++;
        } else {
          screen.repairDispatches = attempt;
          metrics.repairRequests++;
        }
        transition(lifecycle);
        if (purpose === "compose") screen.status = "composing";
        screen.activeRequestId = requestId;
        screen.startedAtMs ??= now();
        screenRunStartedAt.set(screen.screenId, screenRunStartedAt.get(screen.screenId) ?? monotonicNow());
        metrics.providerQueueWaitMs += queueWaitMs;
        activeScreenModelCalls++;
        metrics.peakConcurrentModelRequests = Math.max(metrics.peakConcurrentModelRequests, activeScreenModelCalls);
        recordTrace({ stageId: screen.screenId, stage: purpose, event: "request_started", outcome: "started", providerRequestId: requestId, attempt, inputBytes, queueWaitMs });
        await save();
        return { input, inputBytes, requestId, attempt };
      });
      const startedAt = monotonicNow();
      let turn: AuthorizedChatTurn;
      try {
        turn = await deps.model(reserved.input, lifecycle, reserved.requestId, requestSignal);
        if (requestSignal.aborted)
          throw new UniversalDesignTaskError(deps.signal.aborted ? "request_cancelled" : "stale_task_session", "A late provider result was ignored after cancellation or task replacement.");
        if (deps.isCurrent && !deps.isCurrent())
          throw new UniversalDesignTaskError("stale_task_session", "A late provider result was ignored after cancellation or task replacement.");
        check();
      } catch (error) {
        const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
        await withTaskLock(async () => {
          activeScreenModelCalls = Math.max(0, activeScreenModelCalls - 1);
          if (requestSignal.aborted || (deps.isCurrent && !deps.isCurrent())) return;
          task.universalMetrics!.providerLatencyMs += durationMs;
          if (purpose === "compose") task.universalMetrics!.programCompositionMs += durationMs;
          const code = safeErrorCode(error);
          recordTrace({ stageId: screen.screenId, stage: purpose, event: "request_failed", outcome: "failed", providerRequestId: reserved.requestId, attempt: reserved.attempt, durationMs, queueWaitMs, inputBytes: reserved.inputBytes, code, cancellationOrigin: cancellationOrigin(error, requestSignal) });
          if (!requestSignal.aborted && (!deps.isCurrent || deps.isCurrent())) {
            screen.status = purpose === "compose" ? "pending" : "repair_pending";
            screen.errorCode = code.replace(/[^a-z0-9_]/giu, "_").toLocaleLowerCase().slice(0, 80);
            delete screen.activeRequestId;
            if (["inference_busy", "quota_or_rate_limit", "plan_use_not_admitted"].includes(code)) {
              task.universalMetrics!.concurrencyLimit = 1;
              task.universalMetrics!.schedulerMode = "serial";
            }
            await save();
          }
        });
        throw error;
      }
      const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
      const outputBytes = utf8Bytes(JSON.stringify(turn));
      const validation = await withTaskLock(async () => {
        activeScreenModelCalls = Math.max(0, activeScreenModelCalls - 1);
        const metrics = task.universalMetrics!;
        task.rounds++;
        metrics.providerRounds++;
        metrics.providerInputBytes += reserved.inputBytes;
        metrics.providerLatencyMs += durationMs;
        if (purpose === "compose") metrics.programCompositionMs += durationMs;
        metrics.providerFirstDeltaMs += turn.timing?.upstreamFirstDeltaMs ?? 0;
        const roundBreakdown = task.roundBreakdown;
        roundBreakdown.planning++;
        const screenIndex = task.projectPlan?.screens.findIndex(({ screenId }) => screenId === screen.screenId) ?? -1;
        const stage = screenIndex >= 0 ? task.stages[screenIndex] : undefined;
        if (stage) {
          stage.rounds++;
          stage.roundBreakdown ??= { prePlan: 0, planning: 0, execution: 0, inspection: 0, completion: 0, correction: 0, continuation: 0, modelRetries: 0 };
          stage.roundBreakdown.planning++;
        }
        const tools = turn.kind === "tool_calls" ? turn.calls.map(({ name }) => name) : [];
        task.modelRoundTrace.push({ round: task.rounds, lifecycle, outcome: turn.kind, tools, validationCodes: turn.kind === "tool_validation" ? turn.issues.slice(0, 8).map(({ errorCode }) => errorCode) : [], durationMs, inputBytes: reserved.inputBytes, ...(turn.timing ? { timing: turn.timing } : {}) });
        if (task.modelRoundTrace.length > 100) task.modelRoundTrace = task.modelRoundTrace.slice(-100);
        recordTrace({
          stageId: screen.screenId,
          stage: purpose,
          event: "request_completed",
          outcome: "completed",
          providerRequestId: reserved.requestId,
          attempt: reserved.attempt,
          durationMs,
          queueWaitMs,
          inputBytes: reserved.inputBytes,
          outputBytes,
          ...(turn.timing?.upstreamHeadersMs !== undefined ? { upstreamHeadersMs: turn.timing.upstreamHeadersMs } : {}),
          ...(turn.timing?.upstreamFirstDeltaMs !== undefined ? { firstDeltaMs: turn.timing.upstreamFirstDeltaMs } : {}),
        });
        if (turn.kind === "tool_validation") {
          if (task.validationCorrections >= CHAT_TASK_MAX_VALIDATION_CORRECTIONS || screen.schemaCorrections >= 2)
            fail("model_schema_repair_exhausted", `The structured ${purpose} response for ${screen.screenId} remained invalid after its bounded correction budget.`);
          task.validationCorrections++;
          screen.schemaCorrections++;
          const codes = [...new Set(turn.issues.slice(0, 8).map(({ errorCode, toolName }) => `${toolName ?? expectedTool}:${errorCode}`))];
          screen.schemaFeedback = `The previous structured response failed boundary validation (${codes.join(", ")}). Return one corrected ${expectedTool} call for ${screen.screenId}; do not change its scope.`;
          screen.status = purpose === "compose" ? "pending" : "repair_pending";
          delete screen.activeRequestId;
          await save();
          return true;
        }
        return false;
      });
      if (validation) continue;
      if (turn.kind !== "tool_calls" || turn.calls.length !== 1 || turn.calls[0]?.action.tool !== expectedTool) {
        await withTaskLock(async () => {
          screen.status = purpose === "compose" ? "pending" : "repair_pending";
          screen.errorCode = "provider_tool_contract_invalid";
          delete screen.activeRequestId;
          await save();
        });
        fail("provider_tool_contract_invalid", `The provider did not return exactly one ${expectedTool} call for ${screen.screenId}.`);
      }
      return ChatFunctionCallSchema.parse(turn.calls[0]);
    }
  };

  deps.progress("Universal design route v1 · validating the new-create intent and saved task scope…");
  deps.onPhase?.("planning");
  if (task.lifecycle === "UNIVERSAL_CLASSIFY") {
    fail("intent_classification_pending", "The existing Chat coordinator must checkpoint create intent before universal planning.");
  }
  if (!task.projectPlan) {
    if (task.universalScreens?.length || task.projectPlanFingerprint)
      fail("plan_checkpoint_inconsistent", "A partial universal plan checkpoint cannot be silently regenerated.");
    const call = await requestTool("plan");
    if (call.action.tool !== "plan_universal_project") fail("provider_tool_contract_invalid", "The planner call was not allowlisted for this lifecycle.");
    const draft = { ...call.action };
    Reflect.deleteProperty(draft, "tool");
    const parsedIntent = parseChatGenerationIntent(task.prompt);
    const intent = parsedIntent.kind === "ready" ? parsedIntent.intent : undefined;
    const isPersian = /[\u0600-\u06ff]/u.test(task.prompt);
    const requestedTarget = intent?.target ??
      (/\b(?:desktop|laptop|web)\b|دسکتاپ/iu.test(task.prompt)
        ? "desktop"
        : /\b(?:mobile|phone)\b|موبایل|گوشی/iu.test(task.prompt)
          ? "mobile"
          : undefined);
    const planResult = parseProjectPlanDraft(draft, {
      taskId: task.id,
      ...(intent ? { requestedScreenCount: intent.screenCount } : {}),
      ...(requestedTarget ? { requestedTarget } : {}),
      requestedLocale: intent?.locale ?? (isPersian ? "fa-IR" : "en-US"),
      visualLanguageFallback: createDefaultVisualLanguage({ styleDirection: "Clear project hierarchy", density: "medium", locale: intent?.locale ?? (isPersian ? "fa-IR" : "en-US") }),
      ...(task.brandKit ? { brandKit: { id: task.brandKit.id, revision: task.brandKit.revision, tokenHash: task.brandKit.tokenHash, assetIds: task.brandKit.assets.map(({ assetId }) => assetId) } } : {}),
      skills: (task.designSkills ?? []).map(({ id, revisionId }) => ({ id, revisionId })),
    });
    if (!planResult.success) {
      if (task.validationCorrections >= CHAT_TASK_MAX_VALIDATION_CORRECTIONS)
        fail("project_plan_invalid", `The project plan could not satisfy the saved request: ${planResult.findings.map(({ code }) => code).join(", ")}.`);
      task.validationCorrections++;
      task.validationFeedback = `The plan failed semantic contract checks (${planResult.findings.map(({ code }) => code).join(", ")}). Preserve the requested project, exact count/device/language and deterministic screen order; return one corrected plan.`;
      task.pending = [];
      task.recent = [];
      await save();
      const retryCall = await requestTool("plan");
      if (retryCall.action.tool !== "plan_universal_project") fail("provider_tool_contract_invalid", "The planner correction call was invalid.");
      const retryDraft = { ...retryCall.action };
      Reflect.deleteProperty(retryDraft, "tool");
      const retryResult = parseProjectPlanDraft(retryDraft, {
        taskId: task.id,
        ...(intent ? { requestedScreenCount: intent.screenCount } : {}),
        ...(requestedTarget ? { requestedTarget } : {}),
        requestedLocale: intent?.locale ?? (isPersian ? "fa-IR" : "en-US"),
        visualLanguageFallback: createDefaultVisualLanguage({ styleDirection: "Clear project hierarchy", density: "medium", locale: intent?.locale ?? (isPersian ? "fa-IR" : "en-US") }),
        ...(task.brandKit ? { brandKit: { id: task.brandKit.id, revision: task.brandKit.revision, tokenHash: task.brandKit.tokenHash, assetIds: task.brandKit.assets.map(({ assetId }) => assetId) } } : {}),
        skills: (task.designSkills ?? []).map(({ id, revisionId }) => ({ id, revisionId })),
      });
      if (!retryResult.success) fail("project_plan_invalid", `The bounded plan correction failed (${retryResult.findings.map(({ code }) => code).join(", ")}).`);
      const finalized = finalizePlan(retryResult.plan, task);
      task.projectPlan = finalized.plan;
      task.projectPlanFingerprint = finalized.fingerprint;
    } else {
      const finalized = finalizePlan(planResult.plan, task);
      task.projectPlan = finalized.plan;
      task.projectPlanFingerprint = finalized.fingerprint;
    }
    const plan = task.projectPlan!;
    task.universalManifest = createJobManifest(task, plan, task.projectPlanFingerprint!);
    task.pending = [];
    task.recent = [];
    task.universalScreens = plan.screens.map(({ screenId }) => checkpoint({ screenId, status: "pending", composeAttempts: 0, repairDispatches: 0, repairAttempts: 0, schemaCorrections: 0 }));
    task.stages = ChatTaskSchema.parse({ ...task, stages: stageCandidates(plan) }).stages;
    transition("UNIVERSAL_COMPOSING");
    delete task.validationFeedback;
    deps.progress(`Universal design route v1 · saved ${plan.screenCount} planned screens before native work.`);
    await save();
  } else {
    const plan = ProjectPlanV1Schema.safeParse(task.projectPlan);
    if (!plan.success || plan.data.taskId !== task.id || !task.projectPlanFingerprint || projectPlanFingerprint(plan.data) !== task.projectPlanFingerprint)
      fail("plan_checkpoint_inconsistent", "The saved universal project plan no longer matches its stable task identity or fingerprint.");
    task.projectPlan = plan.data;
    const expectedManifest = createJobManifest(task, plan.data, task.projectPlanFingerprint);
    if (task.universalManifest) {
      const savedManifest = UniversalJobManifestV1Schema.safeParse(task.universalManifest);
      if (!savedManifest.success || JSON.stringify(savedManifest.data) !== JSON.stringify(expectedManifest))
        fail("job_manifest_inconsistent", "The saved engine, model, screen order, Brand Kit, Skills or capability manifest changed; existing native work was retained.");
      task.universalManifest = savedManifest.data;
    } else {
      // Phase 5 checkpoint migration is additive: pin the exact already-saved route and context once.
      task.universalManifest = expectedManifest;
      recordTrace({ stageId: "task", stage: "task", event: "recovered", outcome: "recovered", code: "phase5_manifest_pinned" });
      await save();
    }
    if (!task.universalScreens)
      task.universalScreens = plan.data.screens.map(({ screenId }) => checkpoint({ screenId, status: "pending", composeAttempts: 0, repairDispatches: 0, repairAttempts: 0, schemaCorrections: 0 }));
    if (task.universalScreens.length !== plan.data.screenCount || task.universalScreens.some((item, index) => item.screenId !== plan.data.screens[index]?.screenId))
      fail("screen_checkpoint_inconsistent", "Saved screen checkpoints do not match the ordered project plan; no new root will be created.");
    if (task.stages.length !== plan.data.screenCount)
      task.stages = ChatTaskSchema.parse({ ...task, stages: stageCandidates(plan.data) }).stages;
  }

  const plan = task.projectPlan!;
  const screens = task.universalScreens!;
  for (const screen of screens) {
    Object.assign(screen, checkpoint(screen));
    const pendingAction = task.pending.length === 1 ? task.pending[0]?.action : undefined;
    const pendingMatchesScreen = pendingAction?.tool === "compose_design_program" || pendingAction?.tool === "repair_design_program"
      ? pendingAction.screenId === screen.screenId
      : false;
    if ((screen.status === "composing" && !screen.program && !pendingMatchesScreen) ||
      (screen.status === "repair_pending" && Boolean(screen.activeRequestId) && !pendingMatchesScreen)) {
      recordTrace({ stageId: screen.screenId, stage: "compose", event: "recovered", outcome: "recovered", ...(screen.activeRequestId ? { providerRequestId: screen.activeRequestId } : {}), attempt: Math.max(1, screen.composeAttempts), code: "provider_result_not_checkpointed" });
      if (screen.status === "composing") screen.status = "pending";
      screen.errorCode = screen.status === "repair_pending" ? "repair_result_not_checkpointed" : "provider_result_not_checkpointed";
      delete screen.activeRequestId;
      screen.schemaFeedback = undefined;
      await save();
    }
  }
  for (const screen of screens) {
    const awaitingRepair = screen.status === "repair_pending";
    if (!["repair_pending", "program_saved", "rendering", "rendered", "verified"].includes(screen.status)) continue;
    const parsed = parseDesignProgram(screen.program, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
    if (awaitingRepair && !parsed.success) continue;
    // Older repair checkpoints did not always record a fingerprint.
    if (!parsed.success || ((!awaitingRepair || screen.fingerprint) && parsed.fingerprint !== screen.fingerprint) ||
      parsed.data.screens.length !== 1 || parsed.data.screens[0]?.id !== screen.screenId)
      fail("program_checkpoint_inconsistent", "The saved screen program failed its fingerprint or identity check. Existing native work was retained.");
    if ((screen.status === "rendered" || screen.status === "verified") &&
      (!screen.rootRef || !screen.nativeBatchId || !screen.nativeNodeCount ||
        screen.adoptionOperationIds?.length !== screen.nativeNodeCount))
      fail("native_checkpoint_inconsistent", "The saved checkpoint lacks complete native ownership evidence.");
    // A dispatched program's fingerprint is part of native ownership and recovery.
    if ((!awaitingRepair && screen.status !== "program_saved") || screen.renderAttempts || screen.nativeRootNodeId || screen.rootRef) continue;
    const savedResponse = task.pending[0]?.action;
    if (savedResponse?.tool === "repair_design_program" && savedResponse.screenId === screen.screenId) continue;
    if (!auditDesignProgramContrast(parsed.data).length && !screen.findings?.some(isContrastFinding)) continue;
    const screenPlan = plan.screens.find(({ screenId }) => screenId === screen.screenId);
    if (!screenPlan) fail("checkpoint_incomplete", `The saved plan has no ${screen.screenId} screen definition.`);
    const normalized = normalizeDesignProgramContrast(parsed.data);
    const findings = findingsForProgram(normalized.program, screen.screenId, plan, screenPlan, task);
    const checked = parseDesignProgram(normalized.program, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
    if (!checked.success) fail("program_validation_failed", "The restored screen failed strict program validation.");
    logContrastRepairs(screen.screenId, normalized.repairs);
    screen.program = normalized.program;
    screen.fingerprint = checked.fingerprint;
    screen.findings = findings;
    screen.status = findings.length ? "repair_pending" : "program_saved";
    if (findings.length) screen.errorCode = "program_preflight_failed";
    else delete screen.errorCode;
    await save();
  }

  type ReadySignal = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  const readySignals = new Map<string, ReadySignal>();
  for (const screen of screens) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => undefined);
    readySignals.set(screen.screenId, { promise, resolve, reject });
  }
  const scheduledPrograms = new Set(screens.filter((screen) =>
    ["program_saved", "rendering", "rendered", "verified"].includes(screen.status) && Boolean(screen.program && screen.fingerprint),
  ).map(({ screenId }) => screenId));
  for (const screenId of scheduledPrograms) readySignals.get(screenId)!.resolve();

  const schedulerController = new AbortController();
  let wakeStoppedRun!: () => void;
  const stoppedRun = new Promise<void>((resolve) => { wakeStoppedRun = resolve; });
  const abortScheduler = () => {
    const origin = chatAbortOrigin(deps.signal);
    for (const screen of screens) {
      if (!screen.activeRequestId) continue;
      recordTrace({ stageId: screen.screenId, stage: screen.status === "repair_pending" ? "repair" : "compose",
        event: "request_failed", outcome: "failed", providerRequestId: screen.activeRequestId,
        code: "request_cancelled", cancellationOrigin: origin });
    }
    schedulerController.abort(origin);
    wakeStoppedRun();
    const error = new UniversalDesignTaskError("request_cancelled", "The task stopped. Saved programs and confirmed screens are retained.");
    for (const ready of readySignals.values()) ready.reject(error);
  };
  deps.signal.addEventListener("abort", abortScheduler, { once: true });
  const schedulerQueuedAt = monotonicNow();
  let schedulerFailure: unknown;
  const composePending = new Set(screens.filter((screen) => !scheduledPrograms.has(screen.screenId)).map(({ screenId }) => screenId));
  let phase5PendingScreenId: string | undefined;
  const phase5PendingCall = task.pending.length === 1 ? task.pending[0] : undefined;
  let phase5PendingReused = false;
  if (task.pending.length) {
    const savedAction = phase5PendingCall?.action;
    if (savedAction?.tool !== "compose_design_program" && savedAction?.tool !== "repair_design_program")
      fail("pending_response_scope_conflict", "A saved provider response has no compatible universal screen checkpoint; existing evidence was retained.");
    phase5PendingScreenId = savedAction.screenId;
    const savedScreen = screens.find((screen) => screen.screenId === phase5PendingScreenId);
    const pendingMatchesStage = savedAction.tool === "compose_design_program"
      ? Boolean(savedScreen && !savedScreen.program && composePending.has(phase5PendingScreenId))
      : Boolean(savedScreen?.program && savedScreen.status === "repair_pending");
    if (!pendingMatchesStage)
      fail("pending_response_scope_conflict", "A saved Phase 5 response does not match any unfinished screen checkpoint.");
    task.universalMetrics!.concurrencyLimit = 1;
    task.universalMetrics!.schedulerMode = "serial";
  }
  const activeJobs = new Set<Promise<void>>();
  let screenPreparationQueue = Promise.resolve();
  const withPreparationPriority = async <T>(work: () => T): Promise<T> => {
    const operation = screenPreparationQueue.then(async () => {
      await saveQueue;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await saveQueue;
      check();
      return work();
    });
    screenPreparationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const getScreenCall = async (screen: UniversalScreenCheckpoint, purpose: "compose" | "repair", signal: AbortSignal, queueWaitMs: number) => {
    const expectedTool = purpose === "compose" ? "compose_design_program" : "repair_design_program";
    if (phase5PendingCall && !phase5PendingReused && phase5PendingCall.action.tool === expectedTool &&
      phase5PendingCall.action.screenId === screen.screenId) {
      check();
      if (signal.aborted) throw new UniversalDesignTaskError("request_cancelled", "The saved Phase 5 response was cancelled before it could be committed.");
      await deps.assertAuthorized();
      phase5PendingReused = true;
      screen.status = purpose === "compose" ? "composing" : "repair_pending";
      screen.activeRequestId = phase5PendingCall.callId;
      recordTrace({ stageId: screen.screenId, stage: purpose, event: "recovered", outcome: "recovered", providerRequestId: phase5PendingCall.callId, attempt: Math.max(1, purpose === "compose" ? screen.composeAttempts : screen.repairDispatches), code: "phase5_pending_response_reused" });
      await save();
      return ChatFunctionCallSchema.parse(phase5PendingCall);
    }
    return requestScreenCall(screen, purpose, signal, queueWaitMs);
  };
  const clearConsumedPending = () => {
    if (phase5PendingCall && !phase5PendingReused) return;
    task.pending = [];
    task.recent = [];
  };

  const composeOneScreen = async (screen: UniversalScreenCheckpoint, queueWaitMs: number) => {
    const screenIndex = plan.screens.findIndex(({ screenId }) => screenId === screen.screenId);
    const screenPlan = plan.screens[screenIndex];
    if (!screenPlan) fail("checkpoint_incomplete", `The saved plan has no ${screen.screenId} screen definition.`);
    screenRunStartedAt.set(screen.screenId, screenRunStartedAt.get(screen.screenId) ?? monotonicNow());
    if (!screen.program) {
      deps.progress(`Universal design route v1 · generating screen ${screenIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      const call = await getScreenCall(screen, "compose", schedulerController.signal, queueWaitMs);
      if (call.action.tool !== "compose_design_program") fail("provider_tool_contract_invalid", `The provider returned an unexpected action for ${screen.screenId}.`);
      const composeAction = call.action;
      const prepared = await withPreparationPriority(() => {
        const normalizeStartedAt = monotonicNow();
        const normalized = normalizedProgram(composeAction.program, plan, screenPlan);
        const normalizeMs = Math.max(0, Math.round(monotonicNow() - normalizeStartedAt));
        const preflightStartedAt = monotonicNow();
        const findings = findingsForProgram(normalized, screen.screenId, plan, screenPlan, task);
        const parsed = parseDesignProgram(normalized, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
        const compiled = compileDesignProgram(normalized, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
        const warnings = compiled.success ? compiled.findings.filter(({ severity }) => severity === "warning").slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })) : [];
        const preflightMs = Math.max(0, Math.round(monotonicNow() - preflightStartedAt));
        return { normalized, normalizeMs, findings, parsed, warnings, preflightMs };
      });
      const { normalized, normalizeMs, findings, parsed, warnings, preflightMs } = prepared;
      await withTaskLock(async () => {
        if (schedulerController.signal.aborted) throw new UniversalDesignTaskError("request_cancelled", "The screen result was not committed after its task was cancelled.");
        task.universalMetrics!.programNormalizationMs += normalizeMs;
        task.universalMetrics!.programPreflightMs += preflightMs;
        recordTrace({ stageId: screen.screenId, stage: "normalize", event: "program_normalized", outcome: "completed", durationMs: normalizeMs, outputBytes: utf8Bytes(JSON.stringify(normalized)) });
        recordTrace({ stageId: screen.screenId, stage: "preflight", event: "preflight_completed", outcome: findings.length ? "failed" : "completed", durationMs: preflightMs, outputBytes: utf8Bytes(JSON.stringify(normalized)), ...(findings.length ? { qaFindingCodes: findings.slice(0, 8).map(({ code }) => code), qaCoverage: "complete" as const } : { qaFindingCodes: warnings.slice(0, 8).map(({ code }) => code), qaCoverage: "complete" as const }) });
        screen.program = normalized;
        screen.fingerprint = parsed.success ? parsed.fingerprint : undefined;
        screen.findings = findings.length ? findings : warnings;
        screen.status = findings.length ? "repair_pending" : "program_saved";
        if (findings.length) screen.errorCode = "program_preflight_failed";
        else delete screen.errorCode;
        delete screen.activeRequestId;
        delete screen.schemaFeedback;
        clearConsumedPending();
        transition(findings.length ? "UNIVERSAL_REPAIR" : "UNIVERSAL_COMPOSING");
        await save();
      });
      deps.progress(`Universal design route v1 · saved screen ${screenIndex + 1}/${plan.screenCount}: ${screenPlan.name}.`);
    }

    if (screen.status === "repair_pending") {
      if (!screen.program || !screen.findings?.length)
        fail("repair_checkpoint_incomplete", `The saved ${screen.screenId} program has no bounded repair findings.`);
      const savedRepair = phase5PendingScreenId === screen.screenId && phase5PendingCall?.action.tool === "repair_design_program";
      if (!savedRepair && screen.findings.every(isContrastFinding)) failContrast(screen.screenId, screen.findings);
      if (screen.repairAttempts >= 1 || screen.repairDispatches >= 3) {
        failContrast(screen.screenId, screen.findings);
        fail("program_repair_exhausted", `The saved ${screen.screenId} program exhausted its bounded semantic repair; native rendering was not started.`);
      }
      deps.progress(`Universal design route v1 · repairing ${screen.findings.length} measured finding(s) on ${screenPlan.name}…`);
      const call = await getScreenCall(screen, "repair", schedulerController.signal, 0);
      if (call.action.tool !== "repair_design_program" || call.action.screenId !== screen.screenId)
        fail("repair_scope_mismatch", `The repair response changed the stable screen scope for ${screen.screenId}.`);
      const repairAction = call.action;
      const supplied = new Set(screen.findings.map(({ code, path }) => `${code}:${path}`));
      if (repairAction.findings.some(({ code, path }) => !supplied.has(`${code}:${path}`)))
        fail("repair_scope_mismatch", "The repair referenced findings outside the locally measured preflight report.");
      if (JSON.stringify(repairAction.program) === JSON.stringify(screen.program))
        fail("program_repair_no_progress", `The bounded repair returned an unchanged program for ${screen.screenId}; further repair was stopped.`);
      const prepared = await withPreparationPriority(() => {
        const normalizeStartedAt = monotonicNow();
        const normalized = normalizedProgram(repairAction.program, plan, screenPlan);
        const normalizeMs = Math.max(0, Math.round(monotonicNow() - normalizeStartedAt));
        const preflightStartedAt = monotonicNow();
        const findings = findingsForProgram(normalized, screen.screenId, plan, screenPlan, task);
        const parsed = parseDesignProgram(normalized, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
        const compiled = compileDesignProgram(normalized, { allowedBrandAssetIds: pinnedBrandAssetIds(task) });
        const warnings = compiled.success ? compiled.findings.filter(({ severity }) => severity === "warning").slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })) : [];
        const preflightMs = Math.max(0, Math.round(monotonicNow() - preflightStartedAt));
        return { normalized, normalizeMs, findings, parsed, warnings, preflightMs };
      });
      const { normalized, normalizeMs, findings, parsed, warnings, preflightMs } = prepared;
      await withTaskLock(async () => {
        if (schedulerController.signal.aborted) throw new UniversalDesignTaskError("request_cancelled", "The repaired screen result was not committed after its task was cancelled.");
        task.universalMetrics!.programNormalizationMs += normalizeMs;
        task.universalMetrics!.programPreflightMs += preflightMs;
        recordTrace({ stageId: screen.screenId, stage: "normalize", event: "program_normalized", outcome: "completed", durationMs: normalizeMs, outputBytes: utf8Bytes(JSON.stringify(normalized)) });
        recordTrace({ stageId: screen.screenId, stage: "preflight", event: "preflight_completed", outcome: findings.length ? "failed" : "completed", durationMs: preflightMs, outputBytes: utf8Bytes(JSON.stringify(normalized)), qaFindingCodes: (findings.length ? findings : warnings).slice(0, 8).map(({ code }) => code), qaCoverage: "complete" });
        screen.repairAttempts++;
        screen.program = normalized;
        screen.fingerprint = parsed.success ? parsed.fingerprint : undefined;
        screen.findings = findings.length ? findings : warnings;
        screen.status = findings.length ? "repair_pending" : "program_saved";
        if (findings.length) screen.errorCode = "program_preflight_failed";
        else delete screen.errorCode;
        delete screen.activeRequestId;
        delete screen.schemaFeedback;
        clearConsumedPending();
        transition(findings.length ? "UNIVERSAL_REPAIR" : "UNIVERSAL_COMPOSING");
        await save();
      });
      if (findings.length) {
        failContrast(screen.screenId, findings);
        fail("program_repair_exhausted", `The bounded repair left ${findings.map(({ code }) => code).join(", ")} on ${screen.screenId}; no native render was dispatched.`);
      }
    }
    if (screen.status !== "program_saved" && screen.status !== "rendering" && screen.status !== "rendered" && screen.status !== "verified")
      fail("program_checkpoint_incomplete", `The ${screen.screenId} program was not durably saved before native work.`);
  };

  const schedulePrograms = async () => {
    const pending = [...composePending];
    if (phase5PendingScreenId) {
      const index = pending.indexOf(phase5PendingScreenId);
      if (index > 0) pending.unshift(...pending.splice(index, 1));
    }
    while (pending.length || activeJobs.size) {
      check();
      if (schedulerController.signal.aborted && !schedulerFailure)
        schedulerFailure = new UniversalDesignTaskError("request_cancelled", "The screen scheduler stopped; saved programs and verified siblings are retained.");
      let launched = false;
      while (!schedulerFailure && !schedulerController.signal.aborted && activeJobs.size < task.universalMetrics!.concurrencyLimit) {
        const readyIndex = pending.findIndex((screenId) => {
          const screenPlan = plan.screens.find(({ screenId: candidate }) => candidate === screenId);
          return screenPlan?.dependencies.every((dependency) => scheduledPrograms.has(dependency)) ?? false;
        });
        if (readyIndex < 0) break;
        const [screenId] = pending.splice(readyIndex, 1);
        const screen = screens.find(({ screenId: candidate }) => candidate === screenId)!;
        const queuedAt = schedulerQueuedAt;
        const queueWaitMs = Math.max(0, Math.round(monotonicNow() - queuedAt));
        const job = composeOneScreen(screen, queueWaitMs).then(() => {
          scheduledPrograms.add(screen.screenId);
          readySignals.get(screen.screenId)!.resolve();
        }).catch((error: unknown) => {
          readySignals.get(screen.screenId)!.reject(error);
          schedulerFailure ??= error;
        }).finally(() => activeJobs.delete(job));
        activeJobs.add(job);
        launched = true;
      }
      if (schedulerFailure) {
        for (const screenId of pending) readySignals.get(screenId)!.reject(schedulerFailure);
        pending.length = 0;
      }
      if (activeJobs.size) await Promise.race([...activeJobs, stoppedRun]);
      else if (pending.length && !launched)
        fail("screen_dependency_blocked", "The saved screen dependency graph has no schedulable screen; no native work was started.");
    }
    if (schedulerFailure) throw schedulerFailure;
  };
  const schedulerDone = schedulePrograms().catch((error: unknown) => {
    for (const ready of readySignals.values()) ready.reject(error);
    throw error;
  });
  void schedulerDone.catch(() => undefined);

  try {
  for (const screen of screens) {
    check();
    if (screen.status === "verified") continue;
    const ready = readySignals.get(screen.screenId);
    if (!ready) fail("checkpoint_incomplete", `The ${screen.screenId} screen has no scheduler readiness checkpoint.`);
    await ready.promise;
    check();
    const screenPlan = plan.screens.find(({ screenId }) => screenId === screen.screenId);
    if (!screenPlan) fail("checkpoint_incomplete", "A saved screen checkpoint is absent from ProjectPlanV1.");
    const stageIndex = plan.screens.findIndex(({ screenId }) => screenId === screen.screenId);
    const stage = task.stages[stageIndex];
    if (!stage) fail("checkpoint_incomplete", "The screen has no matching existing Chat stage.");
    screen.startedAtMs ??= now();
    screenRunStartedAt.set(screen.screenId, screenRunStartedAt.get(screen.screenId) ?? monotonicNow());

    if (screen.status === "pending" || !screen.program) {
      deps.onPhase?.("planning");
      transition("UNIVERSAL_COMPOSING");
      deps.progress(`Universal design route v1 · composing screen ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      await save();
      const call = await requestTool("compose", screen);
      if (call.action.tool !== "compose_design_program")
        fail("provider_tool_contract_invalid", "The provider returned a non-composition action during screen generation.");
      const normalized = normalizedProgram(call.action.program, plan, screenPlan);
      const findings = findingsForProgram(normalized, screen.screenId, plan, screenPlan, task);
      if (findings.length) {
        screen.program = normalized;
        screen.findings = findings;
        screen.status = "repair_pending";
        screen.errorCode = "program_preflight_failed";
        task.pending = [];
        task.recent = [];
        transition("UNIVERSAL_REPAIR");
        await save();
      } else {
        screen.program = normalized;
        const allowedBrandAssetIds = pinnedBrandAssetIds(task);
        const parsed = parseDesignProgram(normalized, { allowedBrandAssetIds });
        if (!parsed.success) fail("program_validation_failed", "The one-screen program did not pass its strict shared validator.");
        screen.fingerprint = parsed.fingerprint;
        screen.findings = compileDesignProgram(normalized, { allowedBrandAssetIds }).success
          ? compileDesignProgram(normalized, { allowedBrandAssetIds }).findings.filter(({ severity }) => severity === "warning").slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }))
          : undefined;
        screen.status = "program_saved";
        delete screen.errorCode;
        task.pending = [];
        task.recent = [];
        await save();
      }
    }

    if (screen.status === "repair_pending") {
      if (!screen.program || !screen.findings?.length)
        fail("repair_checkpoint_incomplete", "A semantic repair requires the saved program and bounded native preflight findings.");
      if (screen.findings.every(isContrastFinding)) failContrast(screen.screenId, screen.findings);
      if (screen.repairAttempts >= 1)
        fail("program_repair_exhausted", `The saved screen program still fails preflight (${screen.findings.map(({ code }) => code).join(", ")}); native rendering was not started.`);
      deps.onPhase?.("planning");
      transition("UNIVERSAL_REPAIR");
      deps.progress(`Universal design route v1 · repairing only ${screen.findings.length} bounded finding(s) on ${screenPlan.name}…`);
      await save();
      const call = await requestTool("repair", screen);
      if (call.action.tool !== "repair_design_program" || call.action.screenId !== screen.screenId)
        fail("repair_scope_mismatch", "The provider repair changed the saved screen scope.");
      const supplied = new Set(screen.findings.map(({ code, path }) => `${code}:${path}`));
      if (call.action.findings.some(({ code, path }) => !supplied.has(`${code}:${path}`)))
        fail("repair_scope_mismatch", "The repair referenced findings outside the locally measured preflight report.");
      if (JSON.stringify(call.action.program) === JSON.stringify(screen.program))
        fail("program_repair_no_progress", "The bounded repair returned an unchanged program; further repair was stopped.");
      const normalized = normalizedProgram(call.action.program, plan, screenPlan);
      screen.repairAttempts++;
      const findings = findingsForProgram(normalized, screen.screenId, plan, screenPlan, task);
      screen.program = normalized;
      const allowedBrandAssetIds = pinnedBrandAssetIds(task);
      screen.findings = findings.length ? findings : compileDesignProgram(normalized, { allowedBrandAssetIds }).success
        ? compileDesignProgram(normalized, { allowedBrandAssetIds }).findings.filter(({ severity }) => severity === "warning").slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }))
        : [];
      if (findings.length) {
        screen.status = "repair_pending";
        screen.errorCode = "program_preflight_failed";
        await save();
        failContrast(screen.screenId, findings);
        fail("program_repair_exhausted", `The bounded repair left ${findings.map(({ code }) => code).join(", ")}; no native render was dispatched.`);
      }
      const parsed = parseDesignProgram(normalized, { allowedBrandAssetIds });
      if (!parsed.success) fail("program_validation_failed", "The repaired one-screen program did not pass its strict shared validator.");
      screen.fingerprint = parsed.fingerprint;
      screen.status = "program_saved";
      delete screen.errorCode;
      task.pending = [];
      task.recent = [];
      transition("UNIVERSAL_COMPOSING");
      await save();
    }

    if (!screen.program || !screen.fingerprint)
      fail("program_checkpoint_incomplete", "A validated DesignProgramV1 must be durably saved before renderer dispatch.");
    if (screen.status === "program_saved" || screen.status === "rendering") {
      deps.onPhase?.("native_execution");
      const alreadyVerifiedNodes = screens.filter((item) => item.status === "verified").reduce((sum, item) => sum + (item.nativeNodeCount ?? 0), 0);
      const estimated = estimateNativeNodes(screen.program, task);
      if (alreadyVerifiedNodes + estimated > MAX_TASK_NATIVE_NODES)
        fail("native_capacity_exceeded", `This route allows at most ${MAX_TASK_NATIVE_NODES} adopted native nodes per task; the saved screen would exceed that bound. Earlier verified screens are retained.`);
      if ((screen.renderAttempts ?? 0) >= 3)
        fail("native_render_retry_limit", "The saved screen reached its native render retry limit. The canvas and checkpoint were retained.");
      screen.renderAttempts = (screen.renderAttempts ?? 0) + 1;
      transition("UNIVERSAL_COMPOSING");
      screen.status = "rendering";
      screen.errorCode = "render_in_flight";
      task.universalMetrics!.nativeBatches++;
      const renderRequestId = `${task.id}_render_${screen.screenId}_${screen.renderAttempts}`;
      recordTrace({ stageId: screen.screenId, stage: "native_render", event: "render_dispatched", outcome: "started", nativeOperationId: renderRequestId, attempt: screen.renderAttempts, nodeCount: estimated });
      await save();
      await deps.assertAuthorized();
      check();
      deps.progress(`Universal design route v1 · rendering editable native screen ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      const renderStarted = monotonicNow();
      let response: DesignProgramRenderResponse;
      try {
        response = await deps.renderProgram(screen.program, renderRequestId, screen.nativeRootNodeId, contextTicket);
      } catch (error) {
        const durationMs = Math.max(0, Math.round(monotonicNow() - renderStarted));
        screen.errorCode = safeErrorCode(error);
        task.universalMetrics!.nativeDurationMs += durationMs;
        recordTrace({ stageId: screen.screenId, stage: "native_render", event: "request_failed", outcome: "failed", nativeOperationId: renderRequestId, attempt: screen.renderAttempts, durationMs, code: safeErrorCode(error) });
        if (!deps.signal.aborted) await save();
        throw error;
      }
      check();
      const renderDurationMs = Math.max(0, Math.round(monotonicNow() - renderStarted));
      task.universalMetrics!.nativeDurationMs += renderDurationMs;
      if (!response.success) {
        screen.nativeRootNodeId ??= response.nativeRootNodeId;
        screen.errorCode = response.errorCode ?? "native_render_error";
        screen.findings = (response.findings ?? []).slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }));
        recordTrace({ stageId: screen.screenId, stage: "native_render", event: "request_failed", outcome: "failed", nativeOperationId: renderRequestId, attempt: screen.renderAttempts, durationMs: renderDurationMs, code: screen.errorCode, qaFindingCodes: screen.findings.map(({ code }) => code).slice(0, 8), qaCoverage: "incomplete" });
        await save();
        fail(screen.errorCode, response.findings?.[0]?.message ??
          `Figma could not confirm rendering for ${screenPlan.name}. The saved program is retained for recovery.`);
      }
      if (
        response.screenId !== screen.screenId ||
        response.programFingerprint !== screen.fingerprint ||
        !response.rootRef || !response.nativeBatchId ||
        (screen.nativeRootNodeId !== undefined && response.nativeRootNodeId !== screen.nativeRootNodeId) ||
        !response.adoptionOperationIds?.length ||
        response.nativeNodeCount === undefined ||
        response.adoptionOperationIds.length !== response.nativeNodeCount ||
        response.nativeNodeCount > MAX_TASK_NATIVE_NODES ||
        screens.some((other) => other !== screen && other.rootRef === response.rootRef)
      )
        fail("native_acknowledgement_invalid", "Figma returned incomplete or conflicting task-owned screen adoption evidence.");
      if (alreadyVerifiedNodes + response.nativeNodeCount > MAX_TASK_NATIVE_NODES)
        fail("native_capacity_exceeded", `The native renderer exceeded the ${MAX_TASK_NATIVE_NODES}-node task limit; the acknowledged screen remains saved for inspection.`);
      screen.status = "rendered";
      screen.rootRef = response.rootRef;
      screen.nativeRootNodeId = response.nativeRootNodeId;
      screen.nativeBatchId = response.nativeBatchId;
      screen.adoptionOperationIds = response.adoptionOperationIds;
      screen.nativeNodeCount = response.nativeNodeCount;
      screen.geometryVersion = response.geometryVersion;
      if (FW5_VISUAL_QA_ENABLED && response.visualCaptureEligible === true)
        freshVisualCaptureScreens.add(screen.screenId);
      if (response.geometryDurationMs !== undefined)
        task.universalMetrics!.nativeGeometryMs = (task.universalMetrics!.nativeGeometryMs ?? 0) + response.geometryDurationMs;
      if (response.geometryRepairs !== undefined)
        task.universalMetrics!.nativeGeometryRepairs = (task.universalMetrics!.nativeGeometryRepairs ?? 0) + response.geometryRepairs;
      const nativeWarnings = (response.findings ?? []).filter(({ severity }) => severity === "warning")
        .map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }));
      if (nativeWarnings.length) screen.findings = [...(screen.findings ?? []).slice(0, 11), ...nativeWarnings].slice(0, 12);
      delete screen.errorCode;
      task.universalMetrics!.firstNativeProgressMs ??= Math.max(0, Math.round(monotonicNow() - runStartedAt));
      recordTrace({ stageId: screen.screenId, stage: "native_render", event: "render_acknowledged", outcome: "completed", nativeOperationId: renderRequestId, nativeBatchId: response.nativeBatchId, attempt: screen.renderAttempts, durationMs: renderDurationMs, nodeCount: response.nativeNodeCount, qaFindingCodes: nativeWarnings.map(({ code }) => code).slice(0, 8), qaCoverage: "complete" });
      await save();
    }

    if (screen.status === "rendered") {
      deps.onPhase?.("verification");
      transition("UNIVERSAL_COMPOSING");
      if (!screen.rootRef || !screen.fingerprint) fail("native_root_missing", "The rendered screen checkpoint has no verified root reference or fingerprint.");
      if (FW4_GEOMETRY_ENABLED && !screen.program)
        fail("fw4_layout_expectation_missing", "The saved screen program is unavailable for FW-4 native sizing readback.");
      const expectedLayout = FW4_GEOMETRY_ENABLED
        ? projectNativeLayoutExpectations(screen.program!, screen.screenId)
        : undefined;
      if (FW4_GEOMETRY_ENABLED && !expectedLayout?.length)
        fail("fw4_layout_expectation_missing", "The saved screen has no bounded layout expectations for FW-4 native readback.");
      deps.progress(`Universal design route v1 · reading back task-owned native screen ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      await deps.assertAuthorized();
      check();
      const inspectRequestId = `${task.id}_inspect_${screen.screenId}_${Math.random().toString(36).slice(2, 10)}`;
      const readbackStartedAt = monotonicNow();
      recordTrace({ stageId: screen.screenId, stage: "native_readback", event: "request_started", outcome: "started", nativeOperationId: inspectRequestId, nativeBatchId: screen.nativeBatchId,
        ...(expectedLayout ? { code: FW4_GEOMETRY_FEATURE, nodeCount: expectedLayout.length } : {}) });
      let inspection: NativeInspection;
      try {
        inspection = await deps.inspectProgram({
        type: "task-native-inspect",
        requestId: inspectRequestId,
        taskId: task.id,
        documentId: task.documentId,
        refs: [screen.rootRef],
        geometry: { programFingerprint: screen.fingerprint, requireReceipt: screen.geometryVersion === 1,
          expectedRootNodeId: screen.nativeRootNodeId, ...(expectedLayout ? { expectedLayout } : {}) },
        });
      } catch (error) {
        const durationMs = Math.max(0, Math.round(monotonicNow() - readbackStartedAt));
        screen.errorCode = safeErrorCode(error);
        task.universalMetrics!.readbackRoundTripMs += durationMs;
        recordTrace({ stageId: screen.screenId, stage: "native_readback", event: "request_failed", outcome: "failed", nativeOperationId: inspectRequestId, nativeBatchId: screen.nativeBatchId, durationMs, code: safeErrorCode(error), qaCoverage: "incomplete" });
        if (!deps.signal.aborted) await save();
        throw error;
      }
      check();
      const readbackDurationMs = Math.max(0, Math.round(monotonicNow() - readbackStartedAt));
      task.universalMetrics!.readbackRoundTripMs += readbackDurationMs;
      const readbackFindingCodes = inspection.geometry?.findings.map(({ code }) => code).slice(0, 8) ?? [];
      recordTrace({ stageId: screen.screenId, stage: "native_readback", event: "readback_completed", outcome: inspection.geometry?.coverage === "complete" ? "completed" : "failed", nativeOperationId: inspectRequestId, nativeBatchId: screen.nativeBatchId, durationMs: readbackDurationMs, nodeCount: inspection.geometry?.measuredNodes, qaFindingCodes: readbackFindingCodes, qaCoverage: inspection.geometry?.coverage === "complete" ? "complete" : "incomplete",
        ...(expectedLayout ? { code: FW4_GEOMETRY_FEATURE } : {}) });
      if (inspection.geometry) {
        task.universalMetrics!.nativeReadbackMs = (task.universalMetrics!.nativeReadbackMs ?? 0) + inspection.geometry.durationMs;
        if (inspection.geometry.findings.length) {
          screen.findings = inspection.geometry.findings.map(({ code, nodeId }) => ({
            code, path: `native.${nodeId}`, message: "Figma reported a native geometry or ownership discrepancy.",
          }));
          await save();
        }
      }
      let verified: ReturnType<typeof verifyNativeReadback>;
      const pendingSizingMismatch = FW5_VISUAL_QA_ENABLED && FW5_VISUAL_REVIEW_MODE === "review+bounded-repair" && FW4_GEOMETRY_ENABLED &&
        inspection.geometry?.coverage === "complete" && inspection.geometry.findings.length === 1 &&
        inspection.geometry.findings[0]?.code === "native_layout_sizing_mismatch" &&
        Boolean(inspection.geometry.findings[0]?.nodeId && inspection.geometry.findings[0]?.parentId &&
          inspection.geometry.findings[0]?.logicalRef && inspection.geometry.findings[0]?.expectedLayout &&
          inspection.geometry.findings[0]?.observedLayout)
        ? inspection.geometry.findings[0]
        : undefined;
      try {
        verified = verifyNativeReadback(inspection, screen, plan, Boolean(pendingSizingMismatch));
      } catch (error) {
        screen.errorCode = safeErrorCode(error).replace(/[^a-z0-9_]/giu, "_").toLocaleLowerCase().slice(0, 80);
        if (FW5_VISUAL_QA_ENABLED && inspection.nativePageId && screen.nativeRootNodeId && screen.fingerprint) {
          const findingCodes = [...new Set([
            ...readbackFindingCodes,
            ...(inspection.unresolvedRefs ?? []).map(({ status }) => `native_ref_${status}`),
            ...(inspection.geometry?.coverage === "incomplete" ? ["native_geometry_incomplete"] : []),
            ...(screen.findings ?? []).map(({ code }) => code),
          ])].slice(0, 12);
          screen.nativePageId = inspection.nativePageId;
          screen.visualQa = buildVisualQaOutcome({
            taskId: task.id, screenId: screen.screenId, fingerprint: screen.fingerprint,
            rootId: screen.nativeRootNodeId, pageId: inspection.nativePageId,
            readbackRevision: inspection.geometry?.receipt,
            nativeGeometry: inspection.geometry?.coverage === "complete" && !readbackFindingCodes.length ? "PASS" : findingCodes.length ? "FINDINGS" : "UNVERIFIED",
            designProgramConsistency: "UNVERIFIED",
            nativeFindingCodes: findingCodes,
            failureReason: screen.errorCode,
            nativeReadbackMs: inspection.geometry?.durationMs ?? readbackDurationMs,
          });
        }
        recordTrace({ stageId: screen.screenId, stage: "verification", event: "request_failed", outcome: "failed", nativeOperationId: inspectRequestId, nativeBatchId: screen.nativeBatchId, durationMs: readbackDurationMs, qaFindingCodes: [...new Set([...readbackFindingCodes, ...(screen.findings ?? []).map(({ code }) => code)])].slice(0, 8), qaCoverage: "incomplete", code: screen.errorCode });
        await save();
        throw error;
      }
      if (screens.some((other) => other !== screen && other.rootRef === screen.rootRef))
        fail("native_root_conflict", "Two planned screens resolve to the same task-owned native root.");
      let finalVerificationRequestId = inspectRequestId;
      let finalVerificationDurationMs = readbackDurationMs;
      if (FW5_VISUAL_QA_ENABLED) {
        screen.nativePageId = inspection.nativePageId;
        const root = inspection.nodes?.find(({ ref }) => ref === screen.rootRef);
        const pageId = inspection.nativePageId;
        const readbackRevision = inspection.geometry?.receipt;
        const readbackIdentityComplete = Boolean(pageId && root && readbackRevision);
        const captureEligible = freshVisualCaptureScreens.has(screen.screenId);
        let capture = undefined as Awaited<ReturnType<typeof captureVisualAttempt>> | undefined;
        if (!pageId || !root || !readbackRevision) {
          capture = { receipt: VisualCaptureReceiptV1Schema.parse({
            version: 1, status: "UNVERIFIED", receiptId: `fw5-${task.id}_${screen.screenId}_r${screen.renderAttempts ?? 1}`,
            taskId: task.id, screenId: screen.screenId, documentId: task.documentId, pageId: pageId ?? "unavailable",
            rootId: screen.nativeRootNodeId!, programFingerprint: screen.fingerprint!, readbackRevision: readbackRevision ?? "v1-00000000",
            mime: "image/png", width: 0, height: 0, byteLength: 0, capturedAtMs: Date.now(), exportScale: 1,
            captureAttempt: 1, diagnostic: "readback_stale",
          }), exportMs: 0, failureReason: "visual_capture_readback_identity_incomplete" };
        } else if (!captureEligible) {
          capture = { receipt: VisualCaptureReceiptV1Schema.parse({
            version: 1, status: "UNVERIFIED", receiptId: `fw5-${task.id}_${screen.screenId}_r${screen.renderAttempts ?? 1}`,
            taskId: task.id, screenId: screen.screenId, documentId: task.documentId, pageId,
            rootId: screen.nativeRootNodeId!, programFingerprint: screen.fingerprint!, readbackRevision,
            mime: "image/png", width: 0, height: 0, byteLength: 0, capturedAtMs: Date.now(), exportScale: 1,
            captureAttempt: 1, diagnostic: "root_reused_or_recovered",
          }), exportMs: 0, failureReason: "root_reused_or_recovered" };
        } else {
          const requestId = `${task.id}_fw5_${screen.screenId}_${screen.renderAttempts ?? 1}_a1`;
          recordTrace({ stageId: screen.screenId, stage: "visual_capture", event: "request_started", outcome: "started", nativeOperationId: requestId, nativeBatchId: screen.nativeBatchId, attempt: 1 });
          capture = await captureVisualAttempt({ deps, task, screen, pageId, readbackRevision, attempt: 1 });
          check();
          freshVisualCaptureScreens.delete(screen.screenId);
          recordTrace({ stageId: screen.screenId, stage: "visual_capture", event: capture.receipt.status === "CAPTURED" ? "request_completed" : "request_failed", outcome: capture.receipt.status === "CAPTURED" ? "completed" : "failed", nativeOperationId: requestId, nativeBatchId: screen.nativeBatchId, durationMs: capture.exportMs, outputBytes: capture.receipt.byteLength, code: capture.receipt.diagnostic });
        }
        const receipt = capture?.receipt;
        let pngBytesForReview = capture?.pngBytes;
        let exportMs = capture?.exportMs ?? 0;
        const failureReason = capture?.failureReason;
        let reviewResponse: VisualReviewResponseV1 | undefined;
        let reviewStatus: VisualQaOutcomeV1["visualReview"] = "VISUAL_REVIEW_UNAVAILABLE";
        let reviewFailureReason: string | undefined;
        let reviewerDurationMs = 0;
        let reviewerCalls = 0;
        const reviewCapturedImage = async (reviewInspection: NativeInspection, reviewReceipt: VisualCaptureReceiptV1,
          reviewBytes: Uint8Array<ArrayBuffer>, attempt: 1 | 2) => {
          if (!deps.visualReviewer || !deps.authorizeVisualReview)
            return { response: undefined, failureReason: "reviewer_or_explicit_authorization_unavailable", durationMs: 0 };
          const reviewStartedAt = monotonicNow();
          try {
            const request = createVisualReviewRequest({ task, screen, screenPlan, inspection: reviewInspection, receipt: reviewReceipt, pngBytes: reviewBytes, attempt });
            const grant = await deps.authorizeVisualReview({ taskId: request.taskId, screenId: request.screenId,
              taskGeneration: request.taskGeneration, imageRevision: request.imageRevision,
              documentId: request.documentId, pageId: request.pageId, rootId: request.rootId,
              programFingerprint: request.programFingerprint, readbackRevision: request.readbackRevision, receiptId: request.receiptId });
            check();
            if (!grant) return { response: undefined, failureReason: "VISUAL_REVIEW_CONSENT_REQUIRED", durationMs: Math.max(0, Math.round(monotonicNow() - reviewStartedAt)) };
            reviewerCalls++;
            recordTrace({ stageId: screen.screenId, stage: "visual_review", event: "request_started", outcome: "started", nativeOperationId: request.requestId, nativeBatchId: screen.nativeBatchId, attempt });
            const response = await runVisualReviewerV1(deps.visualReviewer, request, grant, deps.signal);
            check();
            recordTrace({ stageId: screen.screenId, stage: "visual_review", event: "request_completed", outcome: response.verdict === "inconclusive" ? "failed" : "completed", nativeOperationId: response.requestId, nativeBatchId: screen.nativeBatchId, attempt, durationMs: Math.max(0, Math.round(monotonicNow() - reviewStartedAt)), qaFindingCodes: response.findings.map(({ issueCode }) => issueCode).slice(0, 8), qaCoverage: response.verdict === "inconclusive" ? "incomplete" : "complete" });
            return { response, durationMs: Math.max(0, Math.round(monotonicNow() - reviewStartedAt)) };
          } catch (error) {
            check();
            const issues = error && typeof error === "object" && "issues" in error ? (error as { issues?: unknown }).issues : undefined;
            const safeIssuePaths = Array.isArray(issues) ? issues.slice(0, 4).map((issue: unknown) => {
              if (!issue || typeof issue !== "object") return "unknown";
              const path = "path" in issue && Array.isArray(issue.path) ? issue.path.map((part: unknown) => String(part).replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32)).join(".") : "unknown";
              const code = "code" in issue && typeof issue.code === "string" ? issue.code.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32) : "invalid";
              const keys = "keys" in issue && Array.isArray(issue.keys) ? issue.keys.map((key: unknown) => String(key).replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32)).join("+") : "";
              return `${code}:${path}:${keys}`;
            }).join(",") : "";
            const category = safeErrorCode(error);
            const reason = category === "unsupported_capability" ? "visual_review_unsupported_capability"
              : category === "authorization_required" || category === "plan_use_scope_missing" || category === "session_expired" ? "visual_review_authorization_required"
                : category === "model_not_verified_for_account" ? "visual_review_model_unavailable"
                  : category === "request_timed_out" || error instanceof Error && /timed out/iu.test(error.message) ? "visual_review_timed_out"
                    : category === "service_unavailable" || category === "responses_transport_error" || category === "connection_failed" ? "visual_review_temporarily_unavailable"
                      : safeIssuePaths ? `visual_review_schema_invalid:${safeIssuePaths}` : "visual_review_invalid_or_failed";
            return { response: undefined, failureReason: reason, durationMs: Math.max(0, Math.round(monotonicNow() - reviewStartedAt)) };
          }
        };
        if (receipt?.status === "CAPTURED" && pngBytesForReview && FW5_VISUAL_REVIEW_MODE !== "capture-only") {
          try {
            const reviewed = await reviewCapturedImage(inspection, receipt, pngBytesForReview, 1);
            reviewResponse = reviewed.response;
            reviewFailureReason = reviewed.failureReason;
            reviewerDurationMs += reviewed.durationMs;
            reviewStatus = reviewResponse ? reviewResponse.verdict === "inconclusive" ? "VISUAL_REVIEW_INCONCLUSIVE" : "REVIEWED"
              : reviewFailureReason?.startsWith("visual_review_schema_invalid") ? "VISUAL_REVIEW_FAILED" : visualReviewFailureStatus(reviewFailureReason);
          } finally {
            pngBytesForReview.fill(0);
            pngBytesForReview = undefined;
          }
        }
        if (pngBytesForReview) { pngBytesForReview.fill(0); pngBytesForReview = undefined; }
        const baseVisualQa = buildVisualQaOutcome({
          taskId: task.id, screenId: screen.screenId, fingerprint: screen.fingerprint!, rootId: screen.nativeRootNodeId!, pageId: pageId ?? "unavailable",
          readbackRevision, nativeGeometry: pendingSizingMismatch ? "FINDINGS" : readbackIdentityComplete ? "PASS" : "UNVERIFIED",
          designProgramConsistency: pendingSizingMismatch ? "FINDINGS" : readbackIdentityComplete ? "PASS" : "UNVERIFIED", captureReceipt: receipt,
          nativeFindingCodes: [],
          failureReason: failureReason ?? reviewFailureReason, exportMs, nativeReadbackMs: inspection.geometry?.durationMs ?? readbackDurationMs,
        });
        let finalInspection = inspection;
        let finalReceipt = receipt;
        let finalReviewStatus = reviewStatus;
        let finalReviewFailure = reviewFailureReason;
        let finalQaStatus: VisualQaOutcomeV1["status"] = reviewResponse
          ? reviewResponse.verdict === "inconclusive" ? "REVIEW_INCONCLUSIVE"
            : reviewResponse.verdict === "findings" ? "ISSUES_DETECTED"
              : baseVisualQa.nativeGeometry === "PASS" && baseVisualQa.designProgramConsistency === "PASS" ? "VISUAL_QA_PASSED" : "UNVERIFIED"
          : receipt?.status === "CAPTURED" ? "REVIEW_UNAVAILABLE" : baseVisualQa.status;
        let repair: VisualQaOutcomeV1["repair"] = reviewResponse?.verdict === "findings"
          ? { status: "REPAIR_BLOCKED", attempts: 0, reason: FW5_VISUAL_REVIEW_MODE === "review+bounded-repair" ? "no_safe_proposal" : "capture_only_policy" }
          : { status: "NOT_REQUIRED", attempts: 0, reason: "none" };
        let recheckReviewResponse: VisualReviewResponseV1 | undefined;
        let afterReceiptId: string | undefined;
        let finalNativeGeometry: VisualQaOutcomeV1["nativeGeometry"] = pendingSizingMismatch ? "FINDINGS" : baseVisualQa.nativeGeometry;
        let finalProgramConsistency: VisualQaOutcomeV1["designProgramConsistency"] = pendingSizingMismatch ? "FINDINGS" : baseVisualQa.designProgramConsistency;
        let finalReadbackMs = readbackDurationMs;
        let blockForUnresolvedNativeMismatch = false;
        let repairFindingId: string | undefined;
        let repairProposal: VisualRepairProposalV1 | undefined;

        if (pendingSizingMismatch) {
          const expectedLayoutValue = (property: "layoutSizingHorizontal" | "layoutSizingVertical") => property === "layoutSizingHorizontal"
            ? pendingSizingMismatch.expectedLayout!.horizontalSizing : pendingSizingMismatch.expectedLayout!.verticalSizing;
          const observedLayoutValue = (property: "layoutSizingHorizontal" | "layoutSizingVertical") => property === "layoutSizingHorizontal"
            ? pendingSizingMismatch.observedLayout!.horizontalSizing : pendingSizingMismatch.observedLayout!.verticalSizing;
          const repairCandidates = reviewResponse?.verdict === "findings" && reviewResponse.confidence >= 0.85
            ? reviewResponse.findings.filter((finding) => {
                const action = finding.proposedAction;
                if (!action || finding.issueCode !== "native_layout_sizing_mismatch" || finding.nodeId !== pendingSizingMismatch.nodeId ||
                    finding.source !== "pixel-review" || finding.evidenceSource !== "image+native-readback" ||
                    finding.evidenceRef !== `capture:${receipt?.receiptId}` || finding.uncertain || (finding.confidence ?? 0) < 0.85 ||
                    !finding.safeToAutoRepair || finding.suggestedRepairCategory !== "layout-sizing") return false;
                const nativeTarget = inspection.nodes?.find(({ id }) => id === pendingSizingMismatch.nodeId);
                const expectedParent = inspection.nodes?.find(({ id }) => id === pendingSizingMismatch.parentId);
                return nativeTarget?.type === "FRAME" && nativeTarget.parentId === pendingSizingMismatch.parentId &&
                  nativeTarget.logicalRef === pendingSizingMismatch.logicalRef && nativeTarget[ action.property ] === action.expectedValue &&
                  expectedParent?.layoutMode !== undefined && expectedParent.layoutMode !== "NONE" &&
                  action.expectedValue === observedLayoutValue(action.property) && action.proposedValue === expectedLayoutValue(action.property);
              })
            : [];
          let repairBlockReason: VisualQaOutcomeV1["repair"]["reason"] = !FW4_GEOMETRY_ENABLED ? "fw4_gate_off"
            : !reviewResponse || reviewFailureReason ? "reviewer_unavailable" : "no_safe_proposal";
          if (repairCandidates.length === 1 && receipt?.status === "CAPTURED") {
            const finding = repairCandidates[0]!;
            repairFindingId = finding.findingId;
            const action = finding.proposedAction!;
            const proposalId = `fw5-repair-${task.id}_${screen.screenId}_${screen.renderAttempts ?? 1}`;
            const proposal = VisualRepairProposalV1Schema.parse({
              version: 1, proposalId, taskId: task.id, screenId: screen.screenId, pageId: pageId!, rootId: screen.nativeRootNodeId!,
              programFingerprint: screen.fingerprint!, readbackRevision: receipt.readbackRevision, captureReceiptId: receipt.receiptId,
              findingId: finding.findingId, targetNodeId: pendingSizingMismatch.nodeId!, expectedParentId: pendingSizingMismatch.parentId!,
              targetType: "FRAME", property: action.property, expectedValue: action.expectedValue,
              proposedValue: action.proposedValue, source: "fw4-sizing-convergence",
            });
            repairProposal = proposal;
            if (!deps.repairVisual) {
              repairBlockReason = "repair_executor_unavailable";
            } else {
              repair = { status: "REPAIR_BLOCKED", attempts: 1, reason: "fresh_root_required", method: "fw4-sizing-convergence" };
              recordTrace({ stageId: screen.screenId, stage: "visual_repair", event: "request_started", outcome: "started", nativeOperationId: proposalId, nativeBatchId: screen.nativeBatchId, attempt: 1, nodeCount: 1 });
              let repairResult: ReturnType<typeof VisualNativeRepairResultV1Schema.parse> | undefined;
              try {
                check();
                const response = await deps.repairVisual({ type: "task-native-visual-repair", request: {
                  version: 1, requestId: proposalId, taskId: task.id, screenId: screen.screenId as VisualReviewRequestV1["screenId"],
                  documentId: task.documentId, pageId: pageId!, rootId: screen.nativeRootNodeId!, rootRef: screen.rootRef!,
                  programFingerprint: screen.fingerprint!, captureReceiptId: receipt.receiptId,
                  deadlineAtMs: Date.now() + FW5_VISUAL_CAPTURE_LIMITS.timeoutMs, proposal,
                } }, deps.signal);
                check();
                if (response.type === "task-native-visual-repair-result") {
                  const parsedResult = VisualNativeRepairResultV1Schema.safeParse(response.result);
                  if (parsedResult.success && parsedResult.data.requestId === proposalId && parsedResult.data.taskId === task.id &&
                      parsedResult.data.screenId === screen.screenId && parsedResult.data.rootId === screen.nativeRootNodeId &&
                      parsedResult.data.captureReceiptId === receipt.receiptId) repairResult = parsedResult.data;
                }
              } catch (error) {
                check();
                repairBlockReason = safeErrorCode(error) === "visual_repair_cancelled" ? "stop_or_stale_task" : "repair_executor_unavailable";
              }
              if (repairResult?.status === "APPLIED" && repairResult.reason === "none" &&
                  repairResult.targetNodeId === proposal.targetNodeId && repairResult.property === proposal.property &&
                  repairResult.readbackRevision && repairResult.readbackRevision !== receipt.readbackRevision) {
                repair = { status: "APPLIED", attempts: 1, reason: "none", method: "fw4-sizing-convergence" };
                finalNativeGeometry = "PASS";
                finalProgramConsistency = "PASS";
                finalQaStatus = "RECHECK_PENDING";
                finalReviewFailure = undefined;
                screen.visualQa = VisualQaOutcomeV1Schema.parse({
                  ...baseVisualQa, status: "RECHECK_PENDING", nativeGeometry: "FINDINGS", designProgramConsistency: "FINDINGS",
                  beforeReceiptId: receipt.receiptId, visualReview: reviewStatus, repair,
                  findings: [...baseVisualQa.findings, ...(reviewResponse?.findings ?? [])].slice(0, 20),
                  findingCounts: { nativeRule: 1, pixelReview: reviewResponse?.kind === "vision" ? reviewResponse.findings.length : 0,
                    human: reviewResponse?.kind === "human" ? reviewResponse.findings.length : 0 },
                  diagnostics: { ...baseVisualQa.diagnostics, reviewerCalls, reviewerDurationMs, repairAttempts: 1, repairMethods: [proposal.property] },
                });
                check();
                await save();
                try {
                  const recheckRequestId = `${task.id}_inspect_${screen.screenId}_recheck`;
                  const recheckStarted = monotonicNow();
                  recordTrace({ stageId: screen.screenId, stage: "native_readback", event: "request_started", outcome: "started", nativeOperationId: recheckRequestId, nativeBatchId: screen.nativeBatchId, attempt: 2, code: FW4_GEOMETRY_FEATURE });
                  const recheck = await deps.inspectProgram({ type: "task-native-inspect", requestId: recheckRequestId, taskId: task.id,
                    documentId: task.documentId, refs: [screen.rootRef!], geometry: { programFingerprint: screen.fingerprint!, requireReceipt: true,
                      expectedRootNodeId: screen.nativeRootNodeId, ...(expectedLayout ? { expectedLayout } : {}) } });
                  check();
                  const durationMs = Math.max(0, Math.round(monotonicNow() - recheckStarted));
                  task.universalMetrics!.readbackRoundTripMs += durationMs;
                  if (!recheck.success || recheck.taskId !== task.id || recheck.nativePageId !== pageId || recheck.expectedRootStatus !== "present" ||
                      recheck.geometry?.receipt !== repairResult.readbackRevision || recheck.nodes?.find(({ ref }) => ref === screen.rootRef)?.id !== screen.nativeRootNodeId)
                    fail("visual_repair_readback_identity_mismatch", "The repaired screen did not return the original task-owned root and fresh geometry receipt.");
                  verified = verifyNativeReadback(recheck, screen, plan);
                  finalInspection = recheck;
                  finalReadbackMs = durationMs;
                  finalVerificationRequestId = recheckRequestId;
                  finalVerificationDurationMs = durationMs;
                  task.universalMetrics!.nativeReadbackMs = (task.universalMetrics!.nativeReadbackMs ?? 0) + (recheck.geometry?.durationMs ?? durationMs);
                  recordTrace({ stageId: screen.screenId, stage: "native_readback", event: "readback_completed", outcome: "completed", nativeOperationId: recheckRequestId, nativeBatchId: screen.nativeBatchId, durationMs, nodeCount: verified.nodeCount, qaCoverage: "complete", attempt: 2 });

                  const secondCaptureRequestId = `${task.id}_fw5_${screen.screenId}_${screen.renderAttempts ?? 1}_a2`;
                  recordTrace({ stageId: screen.screenId, stage: "visual_capture", event: "request_started", outcome: "started", nativeOperationId: secondCaptureRequestId, nativeBatchId: screen.nativeBatchId, attempt: 2 });
                  const secondCapture = await captureVisualAttempt({ deps, task, screen, pageId: pageId!, readbackRevision: repairResult.readbackRevision,
                    attempt: 2, previousReceiptId: receipt.receiptId });
                  check();
                  exportMs += secondCapture.exportMs;
                  finalReceipt = secondCapture.receipt;
                  afterReceiptId = secondCapture.receipt.receiptId;
                  if (secondCapture.receipt.status !== "CAPTURED" || !secondCapture.pngBytes) {
                    repair = { status: "RECHECK_FAILED", attempts: 1, reason: "recheck_unavailable", method: "fw4-sizing-convergence" };
                    finalQaStatus = "RECHECK_FAILED";
                    finalReviewFailure = secondCapture.failureReason ?? secondCapture.receipt.diagnostic;
                    finalReviewStatus = "VISUAL_REVIEW_UNAVAILABLE";
                  } else {
                    try {
                      const secondReview = await reviewCapturedImage(recheck, secondCapture.receipt, secondCapture.pngBytes, 2);
                      recheckReviewResponse = secondReview.response;
                      reviewerDurationMs += secondReview.durationMs;
                      finalReviewFailure = secondReview.failureReason;
                      finalReviewStatus = recheckReviewResponse ? recheckReviewResponse.verdict === "inconclusive" ? "VISUAL_REVIEW_INCONCLUSIVE" : "REVIEWED"
                        : finalReviewFailure?.startsWith("visual_review_schema_invalid") ? "VISUAL_REVIEW_FAILED" : visualReviewFailureStatus(finalReviewFailure);
                      if (!recheckReviewResponse || recheckReviewResponse.verdict === "inconclusive") {
                        repair = { status: "RECHECK_FAILED", attempts: 1, reason: "recheck_unavailable", method: "fw4-sizing-convergence" };
                        finalQaStatus = "RECHECK_FAILED";
                      } else {
                        const unresolvedOriginalFindings = (reviewResponse?.findings ?? [])
                          .filter((finding) => finding.findingId !== repairFindingId);
                        finalQaStatus = recheckReviewResponse.verdict === "pass" && unresolvedOriginalFindings.length === 0
                          ? "VISUAL_QA_PASSED" : "ISSUES_DETECTED";
                      }
                    } finally {
                      secondCapture.pngBytes.fill(0);
                    }
                  }
                } catch (error) {
                  if (deps.signal.aborted) throw error;
                  repair = { status: "RECHECK_FAILED", attempts: 1, reason: "readback_failed", method: "fw4-sizing-convergence" };
                  finalQaStatus = "RECHECK_FAILED";
                  finalReviewFailure = safeErrorCode(error);
                  finalReadbackMs = Math.max(0, Math.round(monotonicNow() - readbackStartedAt));
                  blockForUnresolvedNativeMismatch = true;
                  finalNativeGeometry = "UNVERIFIED";
                  finalProgramConsistency = "UNVERIFIED";
                }
              } else {
                repairBlockReason = repairResult?.reason === "mode_disabled" || repairResult?.reason === "gate_disabled" ? "fw4_gate_off"
                  : repairResult?.reason === "cancelled" ? "stop_or_stale_task"
                    : repairResult?.reason === "readback_failed" ? "readback_failed"
                      : repairResult?.reason === "correction_failed" ? "correction_failed"
                        : repairResult ? "stale_readback" : repairBlockReason;
              }
            }
          }
          if (repair.status !== "APPLIED" && repair.status !== "RECHECK_FAILED") {
            repair = { status: "REPAIR_BLOCKED", attempts: repair.attempts, reason: repairBlockReason,
              ...(repair.attempts ? { method: "fw4-sizing-convergence" as const } : {}) };
            finalQaStatus = "REPAIR_BLOCKED";
            finalReviewFailure ??= repairBlockReason;
            blockForUnresolvedNativeMismatch = true;
          }
        }

        const nativeRepairFinding = pendingSizingMismatch ? {
          findingId: visualFindingId("native_layout_sizing_mismatch", screen.nativeRootNodeId!, pendingSizingMismatch.nodeId),
          taskId: task.id, screenId: screen.screenId as VisualReviewRequestV1["screenId"], issueCode: "native_layout_sizing_mismatch" as const,
          source: "native-rule" as const, evidenceSource: "native-readback" as const, severity: "error" as const,
          evidenceRef: `native-readback:${pendingSizingMismatch.logicalRef}`, nodeId: pendingSizingMismatch.nodeId,
          uncertain: false, safeToAutoRepair: false, suggestedRepairCategory: "none" as const,
          ...(repairProposal && repair.status !== "REPAIR_BLOCKED" ? { resolution: "repaired" as const } : {}),
        } : undefined;
        const firstReviewFindings = (reviewResponse?.findings ?? []).map((finding) => ({
          ...finding,
          ...(repairFindingId && finding.findingId === repairFindingId && repair.status !== "REPAIR_BLOCKED" ? { resolution: "repaired" as const } : {}),
          ...(repairFindingId && finding.findingId !== repairFindingId && repair.status !== "REPAIR_BLOCKED" ? { resolution: "unrepaired" as const } : {}),
        }));
        const secondFindings = (recheckReviewResponse?.findings ?? []).map((finding) => ({ ...finding, resolution: "unrepaired" as const }));
        const combinedFindings = [...secondFindings, ...baseVisualQa.findings, ...(nativeRepairFinding ? [nativeRepairFinding] : []), ...firstReviewFindings]
          .filter((finding, index, all) => all.findIndex(({ findingId }) => findingId === finding.findingId) === index).slice(0, 20);
        const reviewFindings = [...firstReviewFindings, ...secondFindings];
        screen.visualQa = VisualQaOutcomeV1Schema.parse({
          ...baseVisualQa,
          status: finalQaStatus,
          ...(finalReceipt ? { afterReceiptId: afterReceiptId ?? finalReceipt.receiptId, captureReceipt: finalReceipt } : {}),
          ...(repair.attempts > 0 && receipt ? { beforeReceiptId: receipt.receiptId } : {}),
          readbackRevision: finalInspection.geometry?.receipt ?? readbackRevision,
          nativeGeometry: finalNativeGeometry,
          designProgramConsistency: finalProgramConsistency,
          visualCapture: finalReceipt?.status ?? baseVisualQa.visualCapture,
          visualReview: finalReviewStatus,
          findings: combinedFindings,
          findingCounts: { nativeRule: pendingSizingMismatch && repair.status !== "APPLIED" ? 1 : baseVisualQa.findingCounts.nativeRule,
            pixelReview: Math.min(20, reviewFindings.filter(({ source }) => source === "pixel-review").length),
            human: Math.min(20, reviewFindings.filter(({ source }) => source === "human").length) },
          repair,
          diagnostics: { ...baseVisualQa.diagnostics, payloadBytes: finalReceipt?.byteLength ?? 0, exportMs,
            nativeReadbackMs: finalReadbackMs, reviewerCalls, reviewerDurationMs, repairAttempts: repair.attempts,
            repairMethods: repair.attempts && repairProposal ? [repairProposal.property] : [], ...(finalReviewFailure ? { failureReason: finalReviewFailure.slice(0, 100) } : {}) },
        });
        if (blockForUnresolvedNativeMismatch) {
          check();
          await save();
          fail(repair.status === "RECHECK_FAILED" ? "visual_repair_recheck_failed" : "visual_repair_blocked",
            "The original task-owned root remains attached, but FW-4 sizing could not be safely repaired and verified. Inspect or recover this root before resuming.");
        }
      }
      screen.status = "verified";
      screen.verifiedNodeCount = verified.nodeCount;
      stage.completed = true;
      stage.verified = true;
      stage.logicalRefs = [screen.rootRef];
      task.universalMetrics!.acceptedScreenTimesMs.push({
        screenId: screen.screenId,
        elapsedMs: Math.max(0, Math.round(monotonicNow() - (screenRunStartedAt.get(screen.screenId) ?? runStartedAt))),
      });
      task.universalMetrics!.firstVerifiedScreenMs ??= Math.max(0, Math.round(monotonicNow() - runStartedAt));
      recordTrace({ stageId: screen.screenId, stage: "verification", event: "readback_completed", outcome: "completed", nativeOperationId: finalVerificationRequestId, nativeBatchId: screen.nativeBatchId, durationMs: finalVerificationDurationMs, nodeCount: verified.nodeCount, qaFindingCodes: verified.findings.slice(0, 8), qaCoverage: "complete" });
      task.universalMetrics!.acceptedScreenTimesMs = [...new Map(task.universalMetrics!.acceptedScreenTimesMs.map((entry) => [entry.screenId, entry])).values()];
      transition("UNIVERSAL_COMPOSING");
      await save();
      deps.progress(`Universal design route v1 · verified ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}.`);
    }
  }
  await schedulerDone;
  } catch (error) {
    schedulerFailure ??= error;
    await schedulerDone.catch(() => undefined);
    throw error;
  } finally {
    deps.signal.removeEventListener("abort", abortScheduler);
  }

  check();
  if (screens.some(({ status }) => status !== "verified") || task.stages.some(({ completed }) => !completed))
    fail("native_verification_incomplete", "Not every planned screen has task-owned native readback; completion was refused.");
  task.universalMetrics!.totalElapsedMs = Math.max(0, Math.round(monotonicNow() - runStartedAt));
  const usedFallback = screens.some(({ findings }) => findings?.some(({ code }) => code === "native_font_fallback"));
  const visualQaDetails = screens.map(({ screenId, visualQa }) => {
    const receipt = visualQa?.captureReceipt;
    return `${screenId}:${visualQa?.visualCapture === "CAPTURED" && receipt ? `${receipt.width}×${receipt.height}px` : "capture-unavailable"}`;
  }).join(", ");
  const visualQaSummary = FW5_VISUAL_QA_ENABLED
    ? screens.every(({ visualQa }) => visualQa?.status === "VISUAL_QA_PASSED")
      ? plan.locale.toLocaleLowerCase().startsWith("fa")
        ? ` بازبینی بصری مجاز برای PNGهای محدود (${visualQaDetails}) بدون یافتهٔ مسدودکننده پایان یافت.`
        : ` Authorized visual review completed for bounded PNG evidence (${visualQaDetails}) without blocking findings.`
      : screens.some(({ visualQa }) => visualQa?.visualReview === "REVIEWED" && visualQa.status === "ISSUES_DETECTED")
        ? plan.locale.toLocaleLowerCase().startsWith("fa")
          ? ` بازبین مجاز در PNGهای محدود (${visualQaDetails}) یافته‌هایی ثبت کرد؛ کیفیت بصری تأیید نشد و لایه‌های بومی حفظ شدند.`
          : ` The authorized reviewer found issues in bounded PNG evidence (${visualQaDetails}); visual QA did not pass and native layers were retained.`
        : screens.every(({ visualQa }) => visualQa?.visualCapture === "CAPTURED")
          ? plan.locale.toLocaleLowerCase().startsWith("fa")
            ? ` شواهد PNG محدود (${visualQaDetails}) ثبت شد؛ بازبین بصری یا مجوز صریح در دسترس نیست و کیفیت بصری تأییدنشده است.`
            : ` Bounded PNG evidence (${visualQaDetails}) was captured; no authorized visual reviewer is available, so visual quality remains unverified.`
          : plan.locale.toLocaleLowerCase().startsWith("fa")
            ? ` بازبینی بصری کامل نشد (${visualQaDetails})؛ کیفیت بصری تأییدنشده است و لایه‌های بومی حفظ شده‌اند.`
            : ` Visual review did not complete (${visualQaDetails}); visual quality remains unverified and native layers are retained.`
    : "";
  const completionText = plan.locale.toLocaleLowerCase().startsWith("fa")
    ? `مسیر طراحی همگانی v1: ${plan.screenCount} صفحهٔ قابل‌ویرایش در فیگما ساخته و از لایه‌های بومی همان task بازخوانی شد. ${screens.reduce((sum, item) => sum + (item.nativeNodeCount ?? 0), 0)} لایهٔ بومی ثبت شد.${usedFallback ? " برای یکی از فونت‌های در دسترس نبود‌ه از فونت جایگزین استفاده شد." : ""}${visualQaSummary}`
    : `Universal design route v1: created and read back ${plan.screenCount} editable native Figma screens (${screens.reduce((sum, item) => sum + (item.nativeNodeCount ?? 0), 0)} adopted layers).${usedFallback ? " Figma used a fallback for at least one requested font." : ""}${visualQaSummary}`;
  const completionCheckpoint = ChatTaskSchema.parse(task);
  completionCheckpoint.text = completionText;
  completionCheckpoint.pending = [];
  completionCheckpoint.recent = [];
  completionCheckpoint.status = "completed";
  delete completionCheckpoint.error;
  delete completionCheckpoint.failure;
  if (completionCheckpoint.lifecycle !== "TASK_COMPLETED") {
    completionCheckpoint.lifecycle = "TASK_COMPLETED";
    completionCheckpoint.lifecycleTransitions++;
  }
  await save(completionCheckpoint);
  check();
  const liveMetrics = task.universalMetrics;
  Object.assign(task, completionCheckpoint);
  if (liveMetrics) task.universalMetrics = liveMetrics;
  recordTrace({ stageId: "task", stage: "task", event: "task_completed", outcome: "completed", durationMs: task.universalMetrics!.totalElapsedMs, nodeCount: task.universalMetrics!.acceptedScreenTimesMs.length });
}
