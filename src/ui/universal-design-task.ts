import { DesignProgramV1Schema, parseDesignProgram, type DesignProgramV1 } from "../shared/design-program";
import { compileDesignProgram } from "../shared/design-program-adapter";
import { ChatFunctionCallSchema, type ChatFunctionCall, type ChatLifecycleState, type ChatInputItem } from "../shared/chat-tools";
import { parseChatGenerationIntent } from "../shared/chat-generation";
import { resolveBrandKitTokens } from "../shared/brand-kit";
import { CHAT_TASK_MAX_VALIDATION_CORRECTIONS, ChatTaskSchema, type ChatTask } from "../shared/chat-task";
import { utf8Bytes } from "../shared/generation-limits";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import {
  parseProjectPlanDraft,
  projectPlanFingerprint,
  ProjectPlanV1Schema,
  UniversalDesignMetricsSchema,
  UniversalScreenCheckpointSchema,
  type ProjectPlanV1,
  type UniversalScreenCheckpoint,
} from "../shared/universal-design";
import type { AuthorizedChatTurn } from "./companion-client";
import type { DesignProgramRenderResponse } from "./design-program-bridge";

type NativeInspection = Extract<PluginToUIMessage, { type: "task-native-inspection-result" }>;

export type UniversalDesignDependencies = {
  model(input: ChatInputItem[], lifecycle: ChatLifecycleState): Promise<AuthorizedChatTurn>;
  save(task: ChatTask): Promise<void>;
  progress(message: string): void;
  assertAuthorized(): Promise<void>;
  renderProgram(program: DesignProgramV1, requestId: string): Promise<DesignProgramRenderResponse>;
  inspectProgram(request: Extract<UIToPluginMessage, { type: "task-native-inspect" }>): Promise<NativeInspection>;
  signal: AbortSignal;
  now?: () => number;
  onPhase?(phase: "planning" | "native_execution" | "verification"): void;
  timingEvidence?: "live" | "mock";
};

const MAX_PROVIDER_INPUT_BYTES = 56 * 1024;
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
      "native-placeholder assets only; no remote URLs or arbitrary code",
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

function requestInput(task: ChatTask, purpose: "plan" | "compose" | "repair", screen?: UniversalScreenCheckpoint): ChatInputItem[] {
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
    ? "Return only one plan_universal_project tool call. Respect the exact count/device/language constraints in this context. Choose useful distinct screens if the brief did not provide a count. Do not guess private document data."
    : purpose === "compose"
      ? "Return only one compose_design_program tool call for the single currentScreen. Use the shared project language and visual system, meaningful domain semantics, readable content, at least three planned regions, editable native elements and only clearly illustrative synthetic content when necessary. Use placeholder assets only. Do not include other screens."
      : "Return only one repair_design_program tool call. Modify only the supplied invalid fields/findings in this saved one-screen program and preserve all other valid content.";
  const payload = {
    contract: purpose === "plan" ? "ProjectPlanDraftV1" : "DesignProgramV1",
    requestId: task.id,
    brief: purpose === "plan" ? task.prompt : undefined,
    context,
    pinned: pinnedContext(task),
    instructions: routeInstruction,
    ...(task.validationFeedback ? { priorValidation: task.validationFeedback.slice(0, 3_000) } : {}),
  };
  const input: ChatInputItem[] = [
    ...inputHistory(task),
    { role: "user", content: `UNIVERSAL_DESIGN_${purpose.toUpperCase()}_V1\n${JSON.stringify(payload)}` },
  ];
  const bytes = utf8Bytes(JSON.stringify(input));
  if (bytes > MAX_PROVIDER_INPUT_BYTES)
    fail("request_too_large", `The bounded ${purpose} request is ${bytes} bytes; its limit is ${MAX_PROVIDER_INPUT_BYTES}. Trim prior chat context or pinned guidance and retry.`);
  return input;
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

function findingsForProgram(program: DesignProgramV1, expectedScreenId: string, plan: ProjectPlanV1, planScreen: ProjectPlanV1["screens"][number]): Array<{ code: string; path: string; message: string }> {
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
  const parsed = parseDesignProgram(program);
  if (!parsed.success)
    findings.push(...parsed.findings.filter((finding) => finding.severity === "error").slice(0, 10).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })));
  const compiled = compileDesignProgram(program);
  if (!compiled.success)
    findings.push(...compiled.findings.slice(0, 10).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) })));
  if (parsed.success && screen) {
    const roles = new Set<string>();
    let textNodes = 0;
    const visit = (node: DesignProgramV1["screens"][number]["root"]) => {
      roles.add(node.semanticRole.toLocaleLowerCase());
      if (node.type === "text") textNodes++;
      if (node.type === "container") node.children.forEach(visit);
    };
    visit(screen.root);
    if (parsed.nodeCount < 6 || roles.size < 3 || textNodes < 3)
      findings.push({ code: "screen_semantics_too_sparse", path: "screens.0.root", message: "The screen needs at least six native nodes, three distinct semantic roles and three editable text nodes to represent its planned regions." });
    if (screen.root.type !== "container")
      findings.push({ code: "screen_root_not_container", path: "screens.0.root", message: "The screen root must be an editable layout container." });
  }
  return [...new Map(findings.map((finding) => [`${finding.code}:${finding.path}`, finding])).values()].slice(0, 12);
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
  return DesignProgramV1Schema.parse({
    ...value,
    id: plan.projectId,
    revision: 1,
    contentProvenance: "synthetic-fixture",
    requiredCapabilities: [...required],
    tokens: value.tokens,
    locale: value.locale,
    screens: [{
      ...screen,
      id: screenPlan.screenId,
      title: screenPlan.name,
      purpose: screenPlan.purpose,
      order: screenPlan.order,
      viewport: screen.viewport,
      scroll: screenPlan.scroll,
      // Inter-screen dependencies live in ProjectPlanV1. This isolated program
      // is rendered and validated as one screen, so it cannot reference sibling IDs.
      dependsOn: [],
    }],
  });
}

function applyPinnedBrand(program: DesignProgramV1, task: ChatTask): DesignProgramV1 {
  if (!task.brandKit) return program;
  const palette = resolveBrandKitTokens(task.brandKit).palette;
  return DesignProgramV1Schema.parse({
    ...program,
    tokens: {
      ...program.tokens,
      colors: {
        ...program.tokens.colors,
        background: palette.background,
        surface: palette.surface,
        primary: palette.primary,
        accent: palette.accent,
        text: palette.text,
        muted: palette.mutedText,
      },
      headingFont: task.brandKit.tokens.typography.heading1.requestedFamily,
      bodyFont: task.brandKit.tokens.typography.body.requestedFamily,
      spacing: task.brandKit.tokens.spacing.slice(0, 24),
    },
  });
}

function estimateNativeNodes(program: DesignProgramV1): number {
  let images = 0;
  const visit = (node: DesignProgramV1["screens"][number]["root"]) => {
    if (node.type === "image") images++;
    if (node.type === "container") node.children.forEach(visit);
  };
  visit(program.screens[0]!.root);
  const parsed = parseDesignProgram(program);
  return parsed.success ? parsed.nodeCount + images + 2 : Number.MAX_SAFE_INTEGER;
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

function verifyNativeReadback(
  response: NativeInspection,
  screen: UniversalScreenCheckpoint,
  plan: ProjectPlanV1,
): { nodeCount: number; findings: string[] } {
  if (!response.success || !response.nodes || response.truncated)
    fail("native_readback_incomplete", "The task-owned native readback was failed, missing nodes, or truncated; this screen stays unverified.");
  if ((response.unresolvedRefs ?? []).some(({ ref }) => ref === screen.rootRef))
    fail("native_root_unresolved", "Figma could not resolve the adopted root reference for this screen.");
  const root = response.nodes.find(({ ref }) => ref === screen.rootRef);
  if (!root || root.type !== "FRAME")
    fail("native_root_invalid", "A unique task-owned native Frame root was not returned by readback.");
  const screenPlan = plan.screens.find(({ screenId }) => screenId === screen.screenId);
  if (!screenPlan) fail("checkpoint_incomplete", "The readback screen is absent from the saved plan.");
  if (root.width !== screenPlan.viewport.width || root.height !== screenPlan.viewport.height)
    fail("native_viewport_mismatch", "The native root dimensions differ from the planned viewport.");
  if (screenPlan.scroll === "vertical" && (!root.clipsContent || !["VERTICAL", "BOTH"].includes(root.overflowDirection ?? "NONE")))
    fail("native_scroll_mismatch", "The native root did not retain the planned vertical scroll behavior.");
  const subtree = nativeSubtree(response.nodes, root.id);
  if (subtree.length !== screen.nativeNodeCount)
    fail("native_node_count_mismatch", "Native readback did not match the exact adopted subtree node count.");
  const allowedTypes = new Set(["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "COMPONENT"]);
  if (subtree.some((node) => !allowedTypes.has(node.type)))
    fail("native_node_type_unsupported", "The screen contains a node type outside the editable native types supported by this route.");
  if (!subtree.some((node) => node.type === "TEXT"))
    fail("native_text_missing", "The native screen has no editable text content.");
  const warnings = (screen.findings ?? []).map((finding) => finding.code);
  return { nodeCount: subtree.length, findings: warnings };
}

export async function runUniversalDesignTask(task: ChatTask, deps: UniversalDesignDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const check = () => {
    if (deps.signal.aborted) throw new UniversalDesignTaskError("request_cancelled", "The request stopped. Saved plans and confirmed screens are retained.");
  };
  const transition = (lifecycle: ChatLifecycleState) => {
    if (task.lifecycle === lifecycle) return;
    task.lifecycle = lifecycle;
    task.lifecycleTransitions++;
  };
  const save = async () => {
    check();
    const parsed = ChatTaskSchema.safeParse(task);
    if (!parsed.success)
      fail("checkpoint_invalid", "The universal route could not save a schema-valid checkpoint; no new native render was dispatched.");
    await deps.save(parsed.data);
  };
  if (task.executionRoute !== "universal-design-v1" || task.intent !== "create")
    fail("route_intent_conflict", "Only the checkpointed universal create route can run this planner.");
  if (!task.model) fail("model_not_pinned", "The Chat task has no pinned account-visible model.");
  task.universalMetrics ??= initialMetrics(now(), deps.timingEvidence ?? "live");
  const metricCheck = UniversalDesignMetricsSchema.safeParse(task.universalMetrics);
  if (!metricCheck.success) fail("metrics_checkpoint_invalid", "The saved route metrics are invalid.");
  task.universalMetrics = metricCheck.data;
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
      const input = requestInput(task, purpose, screen);
      const inputBytes = utf8Bytes(JSON.stringify(input));
      if (task.rounds >= 100) fail("model_round_limit", "The existing 100-round Chat task limit was reached before the route completed.");
      if (purpose === "plan") metrics.planRequests++;
      else if (purpose === "compose") metrics.programRequests++;
      else metrics.repairRequests++;
      const startedAt = now();
      let turn: AuthorizedChatTurn;
      try {
        turn = await deps.model(input, lifecycle);
      } catch (error) {
        if (deps.signal.aborted) check();
        throw error;
      }
      check();
      const durationMs = Math.max(0, now() - startedAt);
      task.rounds++;
      metrics.providerRounds++;
      metrics.providerInputBytes += inputBytes;
      metrics.providerLatencyMs += durationMs;
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
      ...(task.brandKit ? { brandKit: { id: task.brandKit.id, revision: task.brandKit.revision, tokenHash: task.brandKit.tokenHash } } : {}),
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
        ...(task.brandKit ? { brandKit: { id: task.brandKit.id, revision: task.brandKit.revision, tokenHash: task.brandKit.tokenHash } } : {}),
        skills: (task.designSkills ?? []).map(({ id, revisionId }) => ({ id, revisionId })),
      });
      if (!retryResult.success) fail("project_plan_invalid", `The bounded plan correction failed (${retryResult.findings.map(({ code }) => code).join(", ")}).`);
      task.projectPlan = retryResult.plan;
      task.projectPlanFingerprint = retryResult.fingerprint;
    } else {
      task.projectPlan = planResult.plan;
      task.projectPlanFingerprint = planResult.fingerprint;
    }
    const plan = task.projectPlan!;
    task.pending = [];
    task.recent = [];
    task.universalScreens = plan.screens.map(({ screenId }) => checkpoint({ screenId, status: "pending", repairAttempts: 0, schemaCorrections: 0 }));
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
    if (!task.universalScreens)
      task.universalScreens = plan.data.screens.map(({ screenId }) => checkpoint({ screenId, status: "pending", repairAttempts: 0, schemaCorrections: 0 }));
    if (task.universalScreens.length !== plan.data.screenCount || task.universalScreens.some((item, index) => item.screenId !== plan.data.screens[index]?.screenId))
      fail("screen_checkpoint_inconsistent", "Saved screen checkpoints do not match the ordered project plan; no new root will be created.");
    if (task.stages.length !== plan.data.screenCount)
      task.stages = ChatTaskSchema.parse({ ...task, stages: stageCandidates(plan.data) }).stages;
  }

  const plan = task.projectPlan!;
  const screens = task.universalScreens!;
  for (const screen of screens) {
    check();
    if (screen.status === "verified") continue;
    const screenPlan = plan.screens.find(({ screenId }) => screenId === screen.screenId);
    if (!screenPlan) fail("checkpoint_incomplete", "A saved screen checkpoint is absent from ProjectPlanV1.");
    const stageIndex = plan.screens.findIndex(({ screenId }) => screenId === screen.screenId);
    const stage = task.stages[stageIndex];
    if (!stage) fail("checkpoint_incomplete", "The screen has no matching existing Chat stage.");
    screen.startedAtMs ??= now();

    if (screen.status === "pending" || !screen.program) {
      deps.onPhase?.("planning");
      transition("UNIVERSAL_COMPOSING");
      deps.progress(`Universal design route v1 · composing screen ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      await save();
      const call = await requestTool("compose", screen);
      if (call.action.tool !== "compose_design_program")
        fail("provider_tool_contract_invalid", "The provider returned a non-composition action during screen generation.");
      const normalized = applyPinnedBrand(normalizedProgram(call.action.program, plan, screenPlan), task);
      const findings = findingsForProgram(normalized, screen.screenId, plan, screenPlan);
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
        const parsed = parseDesignProgram(normalized);
        if (!parsed.success) fail("program_validation_failed", "The one-screen program did not pass its strict shared validator.");
        screen.fingerprint = parsed.fingerprint;
        screen.findings = compileDesignProgram(normalized).success
          ? compileDesignProgram(normalized).findings.filter(({ severity }) => severity === "warning").slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }))
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
      const normalized = applyPinnedBrand(normalizedProgram(call.action.program, plan, screenPlan), task);
      screen.repairAttempts++;
      const findings = findingsForProgram(normalized, screen.screenId, plan, screenPlan);
      screen.program = normalized;
      screen.findings = findings.length ? findings : compileDesignProgram(normalized).success
        ? compileDesignProgram(normalized).findings.filter(({ severity }) => severity === "warning").slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }))
        : [];
      if (findings.length) {
        screen.status = "repair_pending";
        screen.errorCode = "program_preflight_failed";
        await save();
        fail("program_repair_exhausted", `The bounded repair left ${findings.map(({ code }) => code).join(", ")}; no native render was dispatched.`);
      }
      const parsed = parseDesignProgram(normalized);
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
      const estimated = estimateNativeNodes(screen.program);
      if (alreadyVerifiedNodes + estimated > MAX_TASK_NATIVE_NODES)
        fail("native_capacity_exceeded", `This route allows at most ${MAX_TASK_NATIVE_NODES} adopted native nodes per task; the saved screen would exceed that bound. Earlier verified screens are retained.`);
      transition("UNIVERSAL_COMPOSING");
      screen.status = "rendering";
      screen.errorCode = "render_in_flight";
      task.universalMetrics!.nativeBatches++;
      await save();
      await deps.assertAuthorized();
      check();
      deps.progress(`Universal design route v1 · rendering editable native screen ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      const renderStarted = now();
      const response = await deps.renderProgram(screen.program, `${task.id}_render_${screen.screenId}`);
      check();
      task.universalMetrics!.nativeDurationMs += Math.max(0, now() - renderStarted);
      if (!response.success) {
        screen.errorCode = response.errorCode ?? "native_render_error";
        screen.findings = (response.findings ?? []).slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 180) }));
        await save();
        fail(screen.errorCode, `Figma did not confirm native rendering for ${screenPlan.name}; the persisted program is retained for safe resume.`);
      }
      if (
        response.screenId !== screen.screenId ||
        response.programFingerprint !== screen.fingerprint ||
        !response.rootRef || !response.nativeBatchId ||
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
      screen.nativeBatchId = response.nativeBatchId;
      screen.adoptionOperationIds = response.adoptionOperationIds;
      screen.nativeNodeCount = response.nativeNodeCount;
      delete screen.errorCode;
      task.universalMetrics!.firstNativeProgressMs ??= Math.max(0, now() - task.universalMetrics!.startedAtMs);
      await save();
    }

    if (screen.status === "rendered") {
      deps.onPhase?.("verification");
      transition("UNIVERSAL_COMPOSING");
      if (!screen.rootRef) fail("native_root_missing", "The rendered screen checkpoint has no verified root reference.");
      deps.progress(`Universal design route v1 · reading back task-owned native screen ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}…`);
      await deps.assertAuthorized();
      check();
      const inspection = await deps.inspectProgram({
        type: "task-native-inspect",
        requestId: `${task.id}_inspect_${screen.screenId}`,
        taskId: task.id,
        documentId: task.documentId,
        refs: [screen.rootRef],
      });
      check();
      const verified = verifyNativeReadback(inspection, screen, plan);
      if (screens.some((other) => other !== screen && other.rootRef === screen.rootRef))
        fail("native_root_conflict", "Two planned screens resolve to the same task-owned native root.");
      screen.status = "verified";
      screen.verifiedNodeCount = verified.nodeCount;
      stage.completed = true;
      stage.verified = true;
      stage.logicalRefs = [screen.rootRef];
      task.universalMetrics!.acceptedScreenTimesMs.push({
        screenId: screen.screenId,
        elapsedMs: Math.max(0, now() - screen.startedAtMs!),
      });
      task.universalMetrics!.acceptedScreenTimesMs = [...new Map(task.universalMetrics!.acceptedScreenTimesMs.map((entry) => [entry.screenId, entry])).values()];
      transition("UNIVERSAL_COMPOSING");
      await save();
      deps.progress(`Universal design route v1 · verified ${stageIndex + 1}/${plan.screenCount}: ${screenPlan.name}.`);
    }
  }

  if (screens.some(({ status }) => status !== "verified") || task.stages.some(({ completed }) => !completed))
    fail("native_verification_incomplete", "Not every planned screen has task-owned native readback; completion was refused.");
  task.universalMetrics!.totalElapsedMs = Math.max(0, now() - task.universalMetrics!.startedAtMs);
  task.text = plan.locale.toLocaleLowerCase().startsWith("fa")
    ? `مسیر طراحی همگانی v1: ${plan.screenCount} صفحهٔ قابل‌ویرایش در فیگما ساخته و از لایه‌های بومی همان task بازخوانی شد. ${screens.reduce((sum, item) => sum + (item.nativeNodeCount ?? 0), 0)} لایهٔ بومی ثبت شد.${screens.some(({ findings }) => findings?.length) ? " هشدارهای پیش‌بررسی در checkpoint هر صفحه نگه‌داری شده‌اند." : ""}`
    : `Universal design route v1: created and read back ${plan.screenCount} editable native Figma screens (${screens.reduce((sum, item) => sum + (item.nativeNodeCount ?? 0), 0)} adopted layers).${screens.some(({ findings }) => findings?.length) ? " Preflight warnings are preserved in each screen checkpoint." : ""}`;
  task.pending = [];
  task.recent = [];
  task.status = "completed";
  delete task.error;
  delete task.failure;
  transition("TASK_COMPLETED");
  await save();
}
