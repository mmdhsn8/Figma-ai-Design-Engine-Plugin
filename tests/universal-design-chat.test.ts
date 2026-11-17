import { describe, expect, it, vi } from "vitest";
import { ChatTaskSchema, chatTaskSafeDiagnostic, type ChatTask } from "../src/shared/chat-task";
import { ChatInputItemSchema, parseResponsesFunctionCalls, validateChatRequestInput, type ChatInputItem, type ChatLifecycleState } from "../src/shared/chat-tools";
import { parseChatGenerationIntent, isClearCreateRequest } from "../src/shared/chat-generation";
import { UniversalDesignProgramV1Schema, parseDesignProgram, type DesignProgramNode, type DesignProgramV1 } from "../src/shared/design-program";
import { compositionVariationSeed, createDefaultVisualLanguage, type ProjectVisualLanguageV1 } from "../src/shared/design-composition";
import { ProjectPlanDraftSchema, parseProjectPlanDraft } from "../src/shared/universal-design";
import { compileDesignProgram } from "../src/shared/design-program-adapter";
import { auditDesignProgramContrast, normalizeDesignProgramContrast } from "../src/shared/design-program-quality";
import { runChatTask } from "../src/ui/chat-task";
import { renderDesignProgramLocal } from "../src/plugin/design-program-spike";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { handleChatTaskStorage } from "../src/plugin/chat-task-storage";
import { createMockApi } from "./figma-mock";
import { brandAssetContentHash, BrandKitRevisionSchema, createBrandVisualAsset, pinBrandKit, type PinnedBrandKit } from "../src/shared/brand-kit";
import { ONE_PIXEL_PNG } from "./visual-fixtures";
import { CompanionClientError, type AuthorizedChatTurn } from "../src/ui/companion-client";
import type { PluginToUIMessage } from "../src/shared/messages";
import { selectChatExecutionRoute } from "../src/ui/universal-design-route";
import {
  DEFAULT_DESIGN_ENGINE,
  migrateExperimentalEngineFlag,
  resolveDesignEnginePreference,
} from "../src/shared/design-engine-preference";

type Case = {
  name: string;
  brief: string;
  purpose: string;
  audience: string;
  platform: "mobile" | "desktop";
  locale: "fa-IR" | "en-US";
  tags: string[];
  entities: string[];
  goals: string[];
  screens: Array<{ name: string; role: string; purpose: string }>;
  independentScreens?: boolean;
};

const cases: Case[] = [
  {
    name: "education · Persian RTL",
    brief: "برای یادگیری دانش‌آموزان سه صفحهٔ موبایل بساز: خانهٔ یادگیری، جزئیات درس، پیشرفت و آزمون. فارسی و راست‌چین باشد.",
    purpose: "Help students discover learning material, study lessons and understand progress.",
    audience: "Students using a Persian language learning service",
    platform: "mobile",
    locale: "fa-IR",
    tags: ["education", "student-learning"],
    entities: ["course", "instructor", "lesson", "quiz"],
    goals: ["Resume a course", "Study a lesson", "Review quiz progress"],
    screens: [
      { name: "خانهٔ یادگیری", role: "learning-home", purpose: "Help a student resume a course and find the next lesson." },
      { name: "جزئیات درس", role: "lesson-detail", purpose: "Present the selected lesson and its instructor, outline and study action." },
      { name: "پیشرفت و آزمون", role: "progress-quiz", purpose: "Show course progress and a clearly illustrative quiz review." },
    ],
  },
  {
    name: "appointment booking · Persian RTL",
    brief: "برای رزرو نوبت سه صفحهٔ موبایل فارسی بساز: جست‌وجوی خدمات، جزئیات ارائه‌دهنده، تأیید رزرو. از اطلاعات واقعی بیمار استفاده نکن.",
    purpose: "Help people compare service providers and complete an appointment booking.",
    audience: "People arranging a service appointment",
    platform: "mobile",
    locale: "fa-IR",
    tags: ["appointment-planning", "service-directory"],
    entities: ["service", "provider", "availability", "booking"],
    goals: ["Find a service", "Compare provider details", "Confirm a selected time"],
    screens: [
      { name: "جست‌وجوی خدمات", role: "search", purpose: "Filter available services and providers by user-selected criteria." },
      { name: "جزئیات ارائه‌دهنده", role: "provider-detail", purpose: "Explain one provider's service, availability and next booking action." },
      { name: "تأیید رزرو", role: "booking-confirmation", purpose: "Summarize a synthetic appointment selection and its confirmation state." },
    ],
  },
  {
    name: "SaaS analytics · English LTR",
    brief: "Design 3 desktop screens for an analytics workspace: workspace overview, detailed report, team settings. English, LTR.",
    purpose: "Help a team monitor shared analytics and manage workspace access.",
    audience: "Analysts and workspace administrators",
    platform: "desktop",
    locale: "en-US",
    tags: ["analytics", "workspace-operations"],
    entities: ["workspace", "report", "metric", "member"],
    goals: ["Review workspace status", "Understand a report", "Manage team access"],
    screens: [
      { name: "Workspace overview", role: "overview", purpose: "Summarize workspace activity and highlight the next useful report." },
      { name: "Detailed analytics report", role: "report-detail", purpose: "Show meaningful metric comparisons and a clearly labeled chart representation." },
      { name: "Team settings", role: "team-settings", purpose: "Review team members, roles and workspace preferences." },
    ],
  },
  {
    name: "civic services · Persian RTL",
    brief: "دو صفحهٔ موبایل برای خدمات شهری بساز: ثبت مشکل شهری و پیگیری وضعیت پرونده. فارسی، راست‌چین و بدون دادهٔ واقعی شهروند.",
    purpose: "Let residents submit a municipal issue and follow its case status.",
    audience: "Residents using local civic services",
    platform: "mobile",
    locale: "fa-IR",
    tags: ["civic-services", "case-tracking"],
    entities: ["issue-report", "municipal-area", "case", "status-event"],
    goals: ["Describe a civic issue", "Review case progress"],
    screens: [
      { name: "ثبت مشکل شهری", role: "issue-intake", purpose: "Collect a resident's issue category, location context and description." },
      { name: "پیگیری پرونده", role: "case-status", purpose: "Show a synthetic case timeline and the latest municipal status." },
    ],
  },
  {
    name: "building maintenance · English LTR",
    brief: "Build five mobile screens for building maintenance operations: issue intake, work orders, assigned technician, schedule, and status history. Use illustrative sample values only.",
    purpose: "Coordinate building maintenance requests from intake through technician work and resolution.",
    audience: "Facilities coordinators and assigned technicians",
    platform: "mobile",
    locale: "en-US",
    tags: ["facilities-operations", "maintenance-workflow"],
    entities: ["building", "work-order", "technician", "schedule-slot", "status-event"],
    goals: ["Record a maintenance issue", "Assign work", "Coordinate a visit", "Review status history"],
    screens: [
      { name: "Issue intake", role: "request-intake", purpose: "Capture the building, issue type, location and priority." },
      { name: "Work orders", role: "work-order-list", purpose: "Prioritize active maintenance orders by status and urgency." },
      { name: "Assigned technician", role: "technician-detail", purpose: "Show the responsible technician and the selected work order." },
      { name: "Maintenance schedule", role: "schedule", purpose: "Present planned maintenance visits and schedule constraints." },
      { name: "Status history", role: "status-timeline", purpose: "Explain the work order's synthetic status changes and resolution." },
    ],
  },
];

function draftFor(input: Case, regionCount = 3, visualLanguageV1?: ProjectVisualLanguageV1) {
  return ProjectPlanDraftSchema.parse({
    productPurpose: input.purpose,
    projectNarrative: `${input.purpose} The screens share a stable task and entity vocabulary.`,
    audience: input.audience,
    primaryUserGoals: input.goals,
    capabilities: ["Search and browse", "Review a selected record", "Follow a clear next action"],
    keyEntities: input.entities.map((name) => ({ name, meaning: `A meaningful ${name} entity in this project.`, provenance: "user-stated" })),
    domainTags: input.tags,
    platform: input.platform,
    locale: input.locale,
    direction: input.locale === "fa-IR" ? "rtl" : "ltr",
    screenCount: input.screens.length,
    styleDirection: "Calm editorial hierarchy, clear card grouping, readable native text and a focused primary action.",
    visualLanguageV1: visualLanguageV1 ?? createDefaultVisualLanguage({ styleDirection: "Calm editorial hierarchy with varied native compositions.", density: "medium", locale: input.locale }),
    contentDensity: "medium",
    contentSamplePolicy: "clearly-illustrative",
    accessibilityMinimums: ["Readable text size", "High contrast", "Clear focus and action hierarchy"],
    componentOpportunities: ["Page header", "Status chip", "Primary action", "Reusable summary card"],
    designConstraints: ["Use one coherent visual system across screens", "No remote assets or executable content"],
    screens: input.screens.map((screen, order) => ({
      order,
      ...screen,
      source: "requested",
      primaryTask: screen.purpose,
      entryState: order === 0 ? "User opens the project flow" : `User arrives from ${input.screens[order - 1]?.name}`,
      exitState: order < input.screens.length - 1 ? `Continue to ${input.screens[order + 1]?.name}` : "Return to the project workspace",
      regions: [
        { name: "Page heading", semanticRole: "heading", content: screen.name, priority: 1 },
        { name: "Primary information", semanticRole: input.entities[0] ?? "primary-content", content: screen.purpose, priority: 2 },
        { name: "Next action", semanticRole: "primary-action", content: input.goals[order % input.goals.length], priority: 3 },
      ].slice(0, regionCount),
      dataRelationships: [`${input.entities[0]} links to ${input.entities[1] ?? input.entities[0]}`],
      responsiveConstraints: [input.platform === "mobile" ? "Vertical scroll within a 390px mobile frame" : "Keep primary data and controls aligned on a 1440px desktop frame"],
      accessibilityNotes: ["Use labeled actions and preserve the project's reading direction"],
      entityRefs: input.entities.slice(0, 4),
      actions: [{ label: input.goals[order % input.goals.length]!, purpose: screen.purpose }],
      states: ["ready", "empty", "completed"],
      navigationOrders: order < input.screens.length - 1 ? [order + 1] : [],
      dependencyOrders: input.independentScreens ? [] : order > 0 ? [order - 1] : [],
      scroll: "vertical",
    })),
    knownFacts: ["The requested audience and main goal are stated in the brief."],
    assumptions: ["No existing project file or data source was inspected."],
    nonGoals: ["No live records, appointments, metrics or customer details"],
  });
}

function programFor(input: Case, screenIndex: number, regionCount = 3): DesignProgramV1 {
  const screen = input.screens[screenIndex]!;
  const viewport = input.platform === "mobile"
    ? { preset: "mobile" as const, width: 390 as const, height: 844 as const }
    : { preset: "desktop" as const, width: 1440 as const, height: 900 as const };
  const width = viewport.width - 48;
  const content = [screen.name, screen.purpose, `${input.entities[screenIndex % input.entities.length]} · ${input.goals[screenIndex % input.goals.length]}`].slice(0, regionCount);
  const textNode = (index: number) => ({
    type: "text" as const,
    id: `copy-${index + 1}`,
    name: `Screen information ${index + 1}`,
    semanticRole: index === 0 ? "heading" : index === 1 ? "body-copy" : "primary-action-label",
    interaction: "none" as const,
    width: { mode: "fill" as const, value: width - 32, min: 80 },
    height: { mode: "fixed" as const, value: 52 },
    text: content[index]!,
    color: index === 0 ? "token:text" : "token:muted",
    fontSize: index === 0 ? 24 : 16,
    textRole: index === 0 ? "heading" as const : index === 2 ? "action" as const : "body" as const,
    weight: index === 0 ? "bold" as const : "regular" as const,
    align: input.locale === "fa-IR" ? "right" as const : "left" as const,
  });
  const draft = draftFor(input, regionCount);
  const planned = draft.screens[screenIndex]!;
  const archetypes = ["editorial", "multi-panel", "task-focused"] as const;
  type ContainerNode = Extract<DesignProgramNode, { type: "container" }>;
  const children: ContainerNode[] = content.map((_, index) => ({
    type: "container" as const,
    id: `region-${index + 1}`,
    name: planned.regions[index]?.name ?? `Content region ${index + 1}`,
    semanticRole: planned.regions[index]?.semanticRole ?? `content-${index + 1}`,
    interaction: index === 2 ? "button" as const : "none" as const,
    width: screenIndex === 1 ? { mode: "fixed" as const, value: [92, 136, 80][index]! } : { mode: "fill" as const, value: width },
    height: { mode: "fixed" as const, value: index === 2 ? 88 : screenIndex === 2 && index === 0 ? 160 : 148 },
    background: index === 0 ? "token:surface" : index === 2 ? "token:raised-surface" : "token:surface",
    layout: { axis: "column" as const, gap: index === 0 ? 12 : 8, padding: { top: 12, right: 12, bottom: 12, left: 12 }, align: "start" as const, crossAlign: "stretch" as const },
    children: [screenIndex === 1 ? { ...textNode(index), width: { mode: "fill", value: [68, 112, 56][index]!, min: 48 } } : textNode(index)],
  }));
  if (regionCount > 1 && screenIndex === 0) {
    children[1]!.children.push({ ...textNode(2), id: "copy-metric-detail", text: `${input.entities[0]} · ${input.goals[1 % input.goals.length]}`, semanticRole: "supporting-data" });
  } else if (regionCount > 1 && screenIndex === 1) {
    children[0]!.children.push({ ...textNode(2), id: "copy-detail-meta", width: { mode: "fill", value: 68, min: 48 }, text: `Selected ${input.entities[0]}`, semanticRole: "record-metadata" });
  } else if (regionCount > 1) {
    children[1]!.children.push({ ...textNode(2), id: "copy-status-detail", text: `Next: ${input.goals[0]}`, semanticRole: "status-detail" });
    children[0]!.children.push({
      type: "container",
      id: "progress-steps",
      name: "Progress sequence",
      semanticRole: "progress-sequence",
      interaction: "none",
      width: { mode: "fill", value: width - 24 },
      height: { mode: "fixed", value: 52 },
      layout: { axis: "row", gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: "start", crossAlign: "center" },
      children: [{ ...textNode(1), id: "progress-current", text: "Step 1 · In progress", semanticRole: "progress-current" }],
    });
  }
  return UniversalDesignProgramV1Schema.parse({
    programVersion: 1,
    id: "model-generated-project",
    revision: 7,
    goal: input.purpose,
    audience: input.audience,
    locale: { language: input.locale, direction: input.locale === "fa-IR" ? "rtl" : "ltr" },
    visualIntent: "An editable, coherent screen with grouped project-specific information and a clear next action.",
    visualLanguageV1: draft.visualLanguageV1,
    contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", ...(input.locale === "fa-IR" ? ["rtl" as const] : []), "vertical-scroll"],
    tokens: {
      colors: { background: draft.visualLanguageV1!.colorRoles.page, surface: draft.visualLanguageV1!.colorRoles.surface, "raised-surface": draft.visualLanguageV1!.colorRoles.raisedSurface, primary: draft.visualLanguageV1!.colorRoles.primary, accent: draft.visualLanguageV1!.colorRoles.accent, text: draft.visualLanguageV1!.colorRoles.text, muted: draft.visualLanguageV1!.colorRoles.mutedText, border: draft.visualLanguageV1!.colorRoles.border },
      spacing: [8, 12, 16, 24],
      headingFont: "Inter",
      bodyFont: "Inter",
    },
    references: [],
    screens: [{
      id: `screen-${String(screenIndex + 1).padStart(2, "0")}`,
      title: screen.name,
      purpose: screen.purpose,
      order: screenIndex,
      viewport,
      scroll: "vertical",
      compositionV1: {
        version: 1,
        archetype: archetypes[screenIndex % archetypes.length],
        decisionTrace: `The ${planned.role} prioritizes its main content and next action with a distinct hierarchy.`,
        variationSeed: compositionVariationSeed("chat-universal-0001", `screen-${String(screenIndex + 1).padStart(2, "0")}`),
        focusNodeId: `region-${Math.min(3, regionCount)}`,
        responsiveIntent: input.platform === "mobile" ? "Single-column content with local horizontal pairing only for compact metrics." : "Use a broader split to keep primary content and supporting details visible together.",
        regions: planned.regions.map((region, index) => ({ nodeId: `region-${index + 1}`, semanticRole: region.semanticRole, priority: region.priority, visualWeight: region.priority === 1 ? 6 : region.priority === 2 ? 4 : 2, contentKind: index === 2 ? "action" as const : index === 1 ? "data" as const : "text" as const })),
        entityRefs: planned.entityRefs,
        approvedAssetsUsed: [],
      },
      dependsOn: input.independentScreens || screenIndex === 0 ? [] : [`screen-${String(screenIndex).padStart(2, "0")}`],
      root: {
        type: "container",
        id: "screen-layout",
        name: `${screen.name} layout`,
        semanticRole: "screen-layout",
        interaction: "none",
        width: { mode: "fixed", value: width },
        height: { mode: "fixed", value: viewport.height + 120 },
        background: "token:background",
        layout: { axis: screenIndex === 1 ? "row" : "column", gap: screenIndex === 1 ? 12 : 20, padding: { top: 8, right: 0, bottom: 8, left: 0 }, align: screenIndex === 2 ? "center" : "start", crossAlign: "stretch" },
        children,
      },
    }],
  });
}

function compositionTopology(root: DesignProgramV1["screens"][number]["root"]): string {
  if (root.type !== "container") return root.type;
  return JSON.stringify([root.layout.axis, root.children.map((node) => node.type === "container"
    ? [node.layout.axis, node.children.map((child) => child.type === "container" ? [child.layout.axis, child.children.length] : child.type)]
    : node.type)]);
}

function modelTurn(name: string, argumentsValue: unknown, index: number): AuthorizedChatTurn {
  const calls = parseResponsesFunctionCalls([{
    type: "function_call",
    call_id: `universal-call-${String(index).padStart(4, "0")}`,
    name,
    arguments: JSON.stringify(argumentsValue),
  }]);
  return { kind: "tool_calls", calls, functionCallItems: calls.map(({ functionCall }) => functionCall), text: "" };
}

function taskFor(input: Case): ChatTask {
  const intent = parseChatGenerationIntent(input.brief);
  return ChatTaskSchema.parse({
    version: 1,
    id: "chat-universal-0001",
    documentId: "file-test-56-page_current",
    prompt: input.brief,
    model: "provider/account-visible-model",
    executionRoute: "universal-design-v1",
    ...(intent.kind === "ready" ? { generationIntent: intent.intent } : {}),
    context: [],
    stages: [],
    ledger: [],
    pending: [],
    recent: [],
    starts: [],
    rounds: 0,
    status: "ready",
    text: "",
  });
}

function pinnedBrandFixture(): PinnedBrandKit {
  const typography = Object.fromEntries(["display", "heading1", "heading2", "heading3", "body", "caption", "button"].map((role) => [role, {
    requestedFamily: "Brand Display", fallbackFamily: "Inter", style: "Regular", weight: 400,
    size: role === "display" ? 40 : role.startsWith("heading") ? 28 : role === "caption" ? 12 : 16,
    lineHeight: 24, letterSpacing: 0, alignment: "left", direction: "ltr",
  }]));
  return pinBrandKit(BrandKitRevisionSchema.parse({
    schemaVersion: 1, id: "brand_universal_01", revision: 1, name: "Universal Test Brand", locale: "en", direction: "ltr",
    createdAt: 1, updatedAt: 1, status: "active",
    tokens: {
      palette: { primary: "#2463EB", secondary: "#1E3A8A", accent: "#F97316", background: "#F8FAFC", surface: "#FFFFFF", text: "#0F172A", mutedText: "#64748B", border: "#CBD5E1", success: "#15803D", warning: "#B45309", error: "#B91C1C", custom: {} },
      typography,
      spacing: [4, 8, 12, 16], radii: [4, 8, 12], stroke: 1,
      shadow: { color: "#0F172A", opacity: 0.12, offsetX: 0, offsetY: 6, radius: 18 },
      grid: { mobileColumns: 4, desktopColumns: 12, mobileGutter: 12, desktopGutter: 24, desktopBreakpoint: 900 },
      density: "comfortable", components: { buttonRadius: 12, cardRadius: 16, inputRadius: 10, buttonHeight: 48 }, themes: [],
    },
    assets: [],
  }));
}

function addContrastFailure(program: DesignProgramV1) {
  const root = program.screens[0]!.root;
  if (root.type !== "container") throw new Error("Expected fixture root.");
  root.background = "#FFFFFF";
  for (const [index, foreground] of ["#AAAAAA", "#999999"].entries()) {
    const region = root.children[index];
    if (region?.type !== "container" || region.children[0]?.type !== "text") throw new Error("Expected fixture text.");
    delete region.background;
    region.children[0].color = foreground;
  }
  return program;
}

function makeHarness(input: Case, options: {
  firstPlanMalformed?: boolean;
  firstProgramViewportMismatch?: boolean;
  repairViewportMismatch?: boolean;
  sparseConfirmation?: boolean;
  brandKit?: PinnedBrandKit;
  planLanguage?: ProjectVisualLanguageV1;
  localComponent?: boolean;
  lowContrast?: boolean;
  providerDelayMs?: number;
  providerDelayForScreen?: (screenId: string) => number;
  maxConcurrentModelCalls?: 1 | 2;
} = {}) {
  const task = taskFor(input);
  if (options.brandKit) task.brandKit = options.brandKit;
  const mock = createMockApi({ simulateFill: true });
  const sent: PluginToUIMessage[] = [];
  const executor = createFigmaToolExecutor(mock.api, (message) => sent.push(message));
  const checkpoints: ChatTask[] = [];
  const renderReceipts = new Map<string, string>();
  const modelInputs: ChatInputItem[][] = [];
  const lifecycles: string[] = [];
  const modelCompletionScreenIds: string[] = [];
  let providerCall = 0;
  let authChecks = 0;
  const model = vi.fn<(
    items: ChatInputItem[], lifecycle: string, requestId?: string, signal?: AbortSignal,
  ) => Promise<AuthorizedChatTurn>>(async (items, lifecycle) => {
    modelInputs.push(items);
    lifecycles.push(lifecycle);
    const index = ++providerCall;
    const requestItem = [...items].reverse().find((item) => "role" in item && item.role === "user");
    const request = requestItem && "content" in requestItem ? requestItem.content : "";
    const payloadText = request.includes("UNIVERSAL_DESIGN_") ? request.split("\n", 2)[1] ?? "{}" : "{}";
    const payload = JSON.parse(payloadText) as { context?: { currentScreen?: { screenId?: string } } };
    const requestedScreenId = payload.context?.currentScreen?.screenId;
    const delayMs = requestedScreenId && options.providerDelayForScreen
      ? options.providerDelayForScreen(requestedScreenId)
      : options.providerDelayMs ?? 0;
    if (delayMs > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    if (lifecycle === "UNIVERSAL_CLASSIFY") return modelTurn("classify_canvas_intent", { intent: "create" }, index);
    if (lifecycle === "UNIVERSAL_PLANNING") {
      if (options.firstPlanMalformed && index === 2)
        return {
          kind: "tool_validation" as const,
          issues: [{ toolName: "plan_universal_project", callId: "universal-call-0002", stage: "arguments_schema" as const, errorCode: "too_small", fieldPaths: ["productPurpose"] }],
        };
      return modelTurn("plan_universal_project", draftFor(input, options.sparseConfirmation ? 1 : 3, options.planLanguage), index);
    }
    if (lifecycle === "UNIVERSAL_COMPOSING") {
      const screenId = payload.context?.currentScreen?.screenId;
      const screenIndex = Number(screenId?.slice(-2)) - 1;
      if (!Number.isInteger(screenIndex) || screenIndex < 0 || screenIndex >= input.screens.length)
        throw new Error("The compose fixture did not receive a stable screen identity.");
      modelCompletionScreenIds.push(screenId!);
      const program = programFor(input, screenIndex, options.sparseConfirmation ? 1 : 3);
      if (options.lowContrast) addContrastFailure(program);
      if (options.localComponent) {
        const fixed = { mode: "fixed" as const, value: 48 };
        const box = { width: fixed, height: fixed, interaction: "none" as const };
        program.componentsV1 = [{
          id: "project-mark",
          root: {
            ...box, id: "master", type: "container", name: "Project mark", semanticRole: "mark",
            layout: { axis: "column", gap: 0, padding: { left: 0, right: 0, top: 0, bottom: 0 }, align: "start", crossAlign: "start" },
            children: [{ ...box, id: "symbol", type: "ellipse", name: "Project symbol", semanticRole: "symbol", fill: "#2457A7" }],
          },
        }];
        const root = program.screens[0]!.root;
        if (root.type !== "container") throw new Error("Expected fixture container");
        if (root.layout.axis === "column")
          root.children.push({ ...box, id: "mark", type: "instance", name: "Project symbol instance", semanticRole: "symbol", componentId: "project-mark" });
        else delete program.componentsV1;
      }
      if (options.firstProgramViewportMismatch && screenIndex === 0) {
        program.screens[0]!.viewport = input.platform === "mobile"
          ? { preset: "desktop", width: 1440, height: 900 }
          : { preset: "mobile", width: 390, height: 844 };
      }
      return modelTurn("compose_design_program", {
        screenId: `screen-${String(screenIndex + 1).padStart(2, "0")}`,
        program,
      }, index);
    }
    if (lifecycle === "UNIVERSAL_REPAIR") {
      const requestItem = [...items].reverse().find((item) => "role" in item && item.role === "user");
      const request = requestItem && "content" in requestItem ? requestItem.content : "";
      const payloadText = request.split("\n", 2)[1] ?? "{}";
      const payload = JSON.parse(payloadText) as { context?: { screenId?: string; boundedFindings?: Array<{ code: string; path: string; message: string }> } };
      const screenId = payload.context?.screenId;
      const findings = payload.context?.boundedFindings;
      if (!screenId || !findings) throw new Error("The repair request has no persisted finding scope.");
      const screenIndex = Number(screenId.slice("screen-".length)) - 1;
      const program = programFor(input, screenIndex, options.sparseConfirmation ? 1 : 3);
      if (options.repairViewportMismatch) {
        program.screens[0]!.viewport = input.platform === "mobile"
          ? { preset: "desktop", width: 1440, height: 900 }
          : { preset: "mobile", width: 390, height: 844 };
      }
      return modelTurn("repair_design_program", {
        screenId,
        findings,
        program,
      }, index);
    }
    throw new Error(`Unexpected model lifecycle ${lifecycle}`);
  });
  const deps = {
    model,
    execute: vi.fn(async () => { throw new Error("Universal creates must not invoke legacy native operation planning."); }),
    save: vi.fn(async (snapshot: ChatTask) => { checkpoints.push(structuredClone(ChatTaskSchema.parse(snapshot))); }),
    progress: vi.fn(),
    signal: new AbortController().signal,
    now: () => 1_000 + providerCall * 10,
    assertAuthorized: vi.fn(async () => { authChecks++; }),
    renderProgram: vi.fn(async (program: DesignProgramV1, requestId: string, expectedRootNodeId?: string) => {
      expect(requestId).toContain("_render_screen-");
      const latest = checkpoints.at(-1);
      expect(latest?.projectPlan).toBeDefined();
      expect(latest?.universalScreens?.find(({ screenId }) => screenId === program.screens[0]?.id)?.program).toEqual(program);
      const parsed = parseDesignProgram(program);
      const compiled = compileDesignProgram(program);
      expect(parsed.success).toBe(true);
      expect(compiled.success).toBe(true);
      const rendered = await renderDesignProgramLocal(mock.api, program, {
        taskId: task.id,
        documentId: task.documentId,
        pageId: "page:current",
        executor,
        expectedRootNodeId,
        lookupNode: (id) => mock.api.getNodeByIdAsync(id),
        rootReceipt: {
          read: () => renderReceipts.get(program.screens[0]!.id) ?? "",
          write: (id) => renderReceipts.set(program.screens[0]!.id, id),
        },
      });
      if (!rendered.success)
        return { type: "design-program-render-result" as const, requestId, taskId: task.id, success: false, errorCode: rendered.code, nativeRootNodeId: rendered.nativeRootNodeId, findings: rendered.findings };
      const root = rendered.roots[0]!;
      return {
        type: "design-program-render-result" as const,
        requestId,
        taskId: task.id,
        success: true,
        screenId: root.screenId,
        nativeRootNodeId: root.nodeId,
        rootRef: root.ref,
        nativeBatchId: rendered.batchId,
        adoptionOperationIds: rendered.operationIds,
        programFingerprint: rendered.fingerprint,
        nativeNodeCount: rendered.registeredRefs,
        geometryVersion: rendered.geometryVersion,
        geometryRepairs: rendered.geometryRepairs,
        geometryDurationMs: rendered.timingsMs.geometry,
      };
    }),
    inspectProgram: vi.fn(async (request: Parameters<typeof executor>[0]) => {
      await executor(request);
      const result = sent.at(-1);
      if (result?.type !== "task-native-inspection-result") throw new Error("Missing mock native inspection response.");
      return result;
    }),
    timingEvidence: "mock" as const,
    maxConcurrentModelCalls: options.maxConcurrentModelCalls,
  };
  return { task, mock, sent, checkpoints, modelInputs, lifecycles, modelCompletionScreenIds, model, deps, get authChecks() { return authChecks; } };
}

function scriptedMarineCase(screenCount: number): Case {
  return {
    name: "marine archive scripted timing baseline",
    brief: `Design ${screenCount} desktop screens for a marine specimen archive with accession, provenance, care and loan workflows. Use illustrative records only.`,
    purpose: "Help collection staff manage a marine specimen from accession through care and loan readiness.",
    audience: "Museum collection and conservation staff",
    platform: "desktop",
    locale: "en-US",
    tags: ["marine-archive", "specimen-custody"],
    entities: ["specimen", "accession", "provenance", "conservation", "loan"],
    goals: ["Record an accession", "Review provenance", "Coordinate conservation", "Prepare a loan"],
    screens: Array.from({ length: screenCount }, (_, index) => ({
      name: [`Accession intake ${index + 1}`, `Provenance review ${index + 1}`, `Conservation record ${index + 1}`, `Loan readiness ${index + 1}`][index % 4]!,
      role: [`intake-${index + 1}`, `provenance-${index + 1}`, `conservation-${index + 1}`, `loan-${index + 1}`][index % 4]!,
      purpose: `Complete the ${["accession", "provenance", "conservation", "loan"][index % 4]} work for the selected illustrative specimen ${index + 1}.`,
    })),
    independentScreens: true,
  };
}

describe("universal design Chat route", () => {
  it("keeps RTL typography and repairs component text only when its surface is internal to the master", () => {
    const input = { ...scriptedMarineCase(1), locale: "fa-IR" as const };
    const program = programFor(input, 0);
    const screen = program.screens[0]!;
    const root = screen.root;
    if (root.type !== "container") throw new Error("Expected fixture root.");
    const region = root.children[0];
    if (region?.type !== "container" || region.children[0]?.type !== "text") throw new Error("Expected fixture region.");
    const label = region.children[0];
    const fixed = { mode: "fixed" as const, value: 60 };
    const master: Extract<DesignProgramNode, { type: "container" }> = {
      ...region, width: fixed, height: fixed, background: "#111111", children: [{ ...label, id: "master-label", color: "#333333" }],
    };
    program.componentsV1 = [{ id: "status-chip", root: master }];
    program.tokens.colors = { page: "#FFFFFF", background: "#FFFFFF", text: "#17202A", muted: "#444444", surface: "#FFFFFF", "raised-surface": "#FFFFFF" };
    root.children.push({ type: "instance", id: "status-instance", name: "Status chip", semanticRole: "status", interaction: "none", componentId: "status-chip", width: fixed, height: fixed });
    const normalized = normalizeDesignProgramContrast(program);
    expect(normalized.repairs).toContainEqual(expect.objectContaining({
      path: "componentsV1.status-chip.master-label.color", foreground: "#333333", background: "#111111", replacement: "#FFFFFF",
    }));
    expect(auditDesignProgramContrast(normalized.program)).toEqual([]);
    const compiled = compileDesignProgram(normalized.program);
    expect(compiled.success, JSON.stringify(compiled.findings)).toBe(true);
    const repairedMaster = normalized.program.componentsV1![0]!.root;
    if (repairedMaster.type !== "container") throw new Error("Expected fixture master.");
    expect(repairedMaster.children[0]).toEqual({ ...master.children[0], color: "token:surface" });
    expect(normalized.program.locale).toEqual(program.locale);

    delete master.background;
    root.background = "#333333";
    expect(normalizeDesignProgramContrast(program).repairs).not.toContainEqual(expect.objectContaining({ path: "componentsV1.status-chip.master-label.color" }));
    expect(auditDesignProgramContrast(program)).toContainEqual(expect.objectContaining({
      path: "screens.screen-01.root.status-instance.master-label.color",
      message: "#333333 over #333333 at alpha 1 measures 1.0000:1. Required at least 4.5:1.",
    }));
  });

  it.each([1, 3, 10])("repairs two inherited-surface contrast failures before each native dispatch for %i screens", async (count) => {
    const brandKit = pinnedBrandFixture();
    const h = makeHarness(scriptedMarineCase(count), { lowContrast: true, brandKit });
    await runChatTask(h.task, h.deps);
    expect(h.lifecycles).not.toContain("UNIVERSAL_REPAIR");
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(count);
    const programs = h.deps.renderProgram.mock.calls.map(([program]) => program);
    for (const program of programs) {
      expect(program.tokens.colors.text).toBe(brandKit.tokens.palette.text);
      expect(auditDesignProgramContrast(program)).toEqual([]);
      expect(normalizeDesignProgramContrast(program).program).toBe(program);
      const root = program.screens[0]!.root;
      if (root.type !== "container") throw new Error("Expected fixture root.");
      for (const region of root.children.slice(0, 2)) {
        if (region.type !== "container") throw new Error("Expected fixture region.");
        expect(region.children[0]).toMatchObject({ color: "token:text" });
        expect(region.background).toBeUndefined();
      }
    }
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(count);
  });

  it("repairs an exhausted saved preflight on reload before dispatch and preserves the adopted root on Resume", async () => {
    const h = makeHarness(scriptedMarineCase(1));
    const signal = new AbortController();
    const originalSave = h.deps.save.getMockImplementation()!;
    h.deps.save.mockImplementation(async (snapshot) => {
      await originalSave(snapshot);
      if (snapshot.universalScreens?.[0]?.status === "program_saved") signal.abort();
    });
    await expect(runChatTask(h.task, { ...h.deps, signal: signal.signal })).rejects.toThrow();
    expect(h.deps.renderProgram).not.toHaveBeenCalled();
    const saved = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    const screen = saved.universalScreens![0]!;
    const broken = addContrastFailure(screen.program!);
    const parsed = parseDesignProgram(broken);
    if (!parsed.success) throw new Error("Expected valid saved program.");
    const findings = auditDesignProgramContrast(broken);
    expect(findings.map(({ path, message }) => [path, message])).toEqual([
      ["screens.screen-01.root.copy-1.color", "#AAAAAA over #FFFFFF at alpha 1 measures 2.3231:1. Required at least 4.5:1."],
      ["screens.screen-01.root.copy-2.color", "#999999 over #FFFFFF at alpha 1 measures 2.8490:1. Required at least 4.5:1."],
    ]);
    screen.status = "repair_pending";
    screen.repairAttempts = 1;
    screen.repairDispatches = 1;
    screen.fingerprint = parsed.fingerprint;
    screen.findings = findings.map(({ code, path, message }) => ({ code, path, message }));
    h.deps.save.mockImplementation(originalSave);
    h.model.mockClear();
    await runChatTask(saved, h.deps);
    expect(h.model).not.toHaveBeenCalled();
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(1);
    expect(saved.universalScreens![0]!.repairAttempts).toBe(1);
    const rootIds = h.mock.roots.map(({ id }) => id);
    const reloaded = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    await runChatTask(reloaded, h.deps);
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(1);
    expect(h.mock.roots.map(({ id }) => id)).toEqual(rootIds);
  });

  it("reports measurable contrast failures without requesting model repair when the active palette has no compliant color", async () => {
    const input = scriptedMarineCase(1);
    const language = createDefaultVisualLanguage({ styleDirection: "Quiet archival", density: "medium", locale: input.locale });
    const colorRoles = Object.fromEntries(Object.keys(language.colorRoles).map((role) => [role, "#B0B0B0"])) as ProjectVisualLanguageV1["colorRoles"];
    const h = makeHarness(input, { lowContrast: true, planLanguage: { ...language, colorRoles } });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow(/program_contrast_unresolved.*copy-1.*#AAAAAA.*copy-2.*#999999/u);
    expect(h.lifecycles).not.toContain("UNIVERSAL_REPAIR");
    expect(h.deps.renderProgram).not.toHaveBeenCalled();
    expect(h.mock.roots).toHaveLength(0);
  });

  it.each([1, 3, 10])("retains valid sibling programs after a network interruption in a %i-screen task", async (count) => {
    const h = makeHarness(scriptedMarineCase(count), { maxConcurrentModelCalls: 2 });
    const original = h.model.getMockImplementation()!;
    let firstFailure = false;
    let siblingSignal: AbortSignal | undefined;
    let siblingStarted!: () => void;
    let finishSibling!: () => void;
    const siblingReady = new Promise<void>((resolve) => { siblingStarted = resolve; });
    const siblingGate = new Promise<void>((resolve) => { finishSibling = resolve; });
    h.model.mockImplementation(async (items, lifecycle, id, signal) => {
      if (lifecycle === "UNIVERSAL_COMPOSING" && id?.endsWith("screen-01_c1")) {
        if (count > 1) await siblingReady;
        firstFailure = true;
        throw new CompanionClientError("connection_failed");
      }
      if (lifecycle === "UNIVERSAL_COMPOSING" && id?.endsWith("screen-02_c1")) {
        siblingSignal = signal;
        siblingStarted();
        await siblingGate;
      }
      return original(items, lifecycle, id, signal);
    });
    const running = runChatTask(h.task, h.deps);
    const failed = expect(running).rejects.toMatchObject({ category: "connection_failed" });
    if (count > 1) {
      await vi.waitFor(() => expect(firstFailure).toBe(true));
      await vi.waitFor(() => expect(h.checkpoints.at(-1)?.universalScreens?.[0]?.errorCode).toBe("connection_failed"));
      expect(siblingSignal?.aborted).toBe(false);
      finishSibling();
    }
    await failed;
    expect(h.mock.roots).toHaveLength(0);
    expect(h.task.status).toBe("failed");
    const saved = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    if (count > 1) {
      expect(saved.universalScreens?.[1]?.status).toBe("program_saved");
      expect(saved.universalScreens?.[1]?.composeAttempts).toBe(1);
    }
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    if (count > 1) expect(saved.universalScreens?.[1]?.composeAttempts).toBe(1);
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(count);
  });

  it.each(["hi", "hello", "سلام"])("answers %s without a model planner or native operation", async (prompt) => {
    const h = makeHarness({ ...cases[0]!, brief: prompt });
    await runChatTask(h.task, h.deps);
    expect(h.task.status).toBe("completed");
    expect(h.task.text).toBeTruthy();
    expect(h.task.projectPlan).toBeUndefined();
    expect(h.model).not.toHaveBeenCalled();
    expect(h.deps.renderProgram).not.toHaveBeenCalled();
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.mock.nodes).toHaveLength(0);
  });

  it.each(["How do I design a mobile screen in Figma?", "I design screens for work."])("keeps discussion tool-free for %s", async (brief) => {
    const h = makeHarness({ ...cases[0]!, brief });
    h.model.mockResolvedValueOnce(modelTurn("classify_canvas_intent", { intent: "create" }, 1));
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("unexpected tool call");
    expect(h.model.mock.calls.map(([, state]) => state)).toEqual(["CONVERSATION"]);
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.deps.renderProgram).not.toHaveBeenCalled();
    expect(h.mock.nodes).toHaveLength(0);
  });

  it("blocks an old misrouted greeting without rewriting its checkpoint", async () => {
    const h = makeHarness({ ...cases[0]!, brief: "hello" });
    h.task.intent = "create";
    h.task.lifecycle = "UNIVERSAL_PLANNING";
    const previous = structuredClone(h.task);
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("does not authorize Canvas work");
    expect(h.task).toEqual(previous);
    expect(h.deps.save).not.toHaveBeenCalled();
    expect(h.model).not.toHaveBeenCalled();
    expect(h.mock.nodes).toHaveLength(0);
  });

  it("retains the attached native frame on pre-adoption geometry failure and reuses it after reload", async () => {
    const input = { ...cases[2]!, screens: cases[2]!.screens.slice(0, 1), brief: "Design one desktop screen for an analytics workspace." };
    const h = makeHarness(input);
    let badBounds = true;
    const createText = h.mock.api.createText.bind(h.mock.api);
    h.mock.api.createText = () => {
      const text = createText();
      Object.defineProperty(text, "absoluteRenderBounds", { configurable: true, get: () => badBounds
        ? { x: -10_000, y: -10_000, width: 100, height: 100 } : text.absoluteBoundingBox });
      return text;
    };
    const unrelated = h.mock.api.createFrame();
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("native_geometry_failed");
    const root = h.mock.roots.find((node) => node.getPluginData("fad.design.program-built.v1") === "1")!;
    expect(root).toBeDefined();
    expect(root.parent?.id).toBe(h.mock.page.id);
    expect(root.removed).toBe(false);
    expect(h.task.universalScreens?.[0]?.nativeRootNodeId).toBe(root.id);
    expect(h.mock.roots.map(({ id }) => id)).toContain(unrelated.id);
    const position = [root.x, root.y];
    badBounds = false;
    const saved = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete").map(({ id }) => id)).toEqual([root.id]);
    expect([root.x, root.y]).toEqual(position);
  });

  it("uses the creation receipt after a lost acknowledgement and refuses to replace a missing root", async () => {
    const input = { ...cases[2]!, screens: cases[2]!.screens.slice(0, 1), brief: "Design one desktop screen for analytics." };
    const h = makeHarness(input);
    const render = h.deps.renderProgram.getMockImplementation()!;
    h.deps.renderProgram.mockImplementationOnce(async (program, id) => {
      await render(program, id);
      throw new Error("Lost render acknowledgement");
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("Lost render acknowledgement");
    const root = h.mock.roots.find((node) => node.getPluginData("fad.generation.commit") === "complete")!;
    expect(root).toBeDefined();
    const saved = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    expect(saved.universalScreens?.[0]?.nativeRootNodeId).toBeUndefined();
    root.remove();
    await expect(runChatTask(saved, h.deps)).rejects.toThrow("native_root_missing");
    expect(h.mock.roots).toHaveLength(0);
    expect(h.deps.renderProgram.mock.calls[1]?.[1]).not.toBe(h.deps.renderProgram.mock.calls[0]?.[1]);
  });

  it("keeps the native root when cancellation arrives after rendering and reconciles it on resume", async () => {
    const input = { ...cases[2]!, screens: cases[2]!.screens.slice(0, 1), brief: "Design one desktop screen for analytics." };
    const h = makeHarness(input);
    const cancel = new AbortController();
    const render = h.deps.renderProgram.getMockImplementation()!;
    h.deps.signal = cancel.signal;
    h.deps.renderProgram.mockImplementationOnce(async (program, id) => {
      const response = await render(program, id);
      cancel.abort();
      return response;
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("request_cancelled");
    const root = h.mock.roots.find((node) => node.getPluginData("fad.generation.commit") === "complete")!;
    expect(root.removed).toBe(false);
    const saved = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    expect(saved.universalScreens?.[0]?.status).toBe("rendering");
    await runChatTask(saved, { ...h.deps, signal: new AbortController().signal });
    expect(saved.status).toBe("completed");
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete").map(({ id }) => id)).toEqual([root.id]);
  });

  it("accepts the actual long ten-screen planning request and resumes its saved task after interruption", async () => {
    const input = scriptedMarineCase(10);
    input.brief += " " + "Show illustrative records and preserve data provenance. ".repeat(80);
    const h = makeHarness(input, { firstPlanMalformed: true, maxConcurrentModelCalls: 1 });
    const model = h.model.getMockImplementation()!;
    const render = h.deps.renderProgram.getMockImplementation()!;
    let longPlanRequests = 0;
    h.model.mockImplementation(async (items, state) => {
      if (state === "UNIVERSAL_PLANNING") {
        expect(items.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/^UNIVERSAL_DESIGN_PLAN_V1\n/u) });
        expect(ChatInputItemSchema.safeParse(items.at(-1)).success).toBe(false);
        longPlanRequests++;
      }
      expect(validateChatRequestInput(JSON.parse(JSON.stringify(items)), state as ChatLifecycleState))
        .toEqual({ success: true, data: items });
      return model(items, state);
    });
    h.deps.renderProgram.mockImplementationOnce(async (program, id) => {
      await render(program, id);
      throw new Error("Interrupted after native commit");
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("Interrupted after native commit");
    const persisted = ChatTaskSchema.parse(JSON.parse(JSON.stringify(h.checkpoints.at(-1))));
    expect(persisted.projectPlan?.screenCount).toBe(10);
    const firstRoot = h.mock.roots.find((node) => node.getPluginData("fad.generation.commit") === "complete");
    expect(firstRoot).toBeDefined();
    await runChatTask(persisted, h.deps);
    expect(longPlanRequests).toBe(2);
    expect(persisted.status).toBe("completed");
    const roots = h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete");
    expect(roots).toHaveLength(10);
    expect(roots.map(({ id }) => id)).toContain(firstRoot!.id);
  });

  it("restarts a lost Companion planning turn from the persisted attempt without writing a native node", async () => {
    const h = makeHarness(cases[0]!);
    const original = h.model.getMockImplementation()!;
    let interrupted = false;
    h.model.mockImplementation(async (input, lifecycle) => {
      if (lifecycle === "UNIVERSAL_PLANNING" && !interrupted) {
        interrupted = true;
        throw new Error("Simulated Companion disconnect");
      }
      return original(input, lifecycle);
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("Companion disconnect");
    const saved = ChatTaskSchema.parse(h.checkpoints.at(-1));
    expect(saved.universalMetrics?.planRequests).toBe(1);
    expect(saved.projectPlan).toBeUndefined();
    expect(h.mock.roots).toHaveLength(0);
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    expect(saved.universalMetrics?.planRequests).toBe(2);
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(3);
  });

  it("recovers a lost per-screen provider response using the saved bounded attempt", async () => {
    const h = makeHarness(cases[0]!);
    const original = h.model.getMockImplementation()!;
    let interrupted = false;
    h.model.mockImplementation(async (input, lifecycle) => {
      if (lifecycle === "UNIVERSAL_COMPOSING" && !interrupted) {
        interrupted = true;
        throw new Error("Simulated per-screen Companion disconnect");
      }
      return original(input, lifecycle);
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("per-screen Companion disconnect");
    const saved = ChatTaskSchema.parse(structuredClone(h.checkpoints.at(-1)));
    expect(saved.universalScreens?.[0]).toMatchObject({ status: "pending", composeAttempts: 1, errorCode: "provider_or_host_error" });
    expect(h.mock.roots).toHaveLength(0);
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    expect(saved.universalScreens?.[0]?.composeAttempts).toBe(2);
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(3);
  });

  it("cancels concurrent screen calls, ignores late responses, and safely resumes the same task", async () => {
    const h = makeHarness(scriptedMarineCase(3), {
      providerDelayForScreen: () => 45,
      maxConcurrentModelCalls: 2,
    });
    const controller = new AbortController();
    h.deps.signal = controller.signal;
    const original = h.model.getMockImplementation()!;
    let started = 0;
    let resolveStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    h.model.mockImplementation(async (items, lifecycle) => {
      if (lifecycle === "UNIVERSAL_COMPOSING" && ++started === 2) resolveStarted();
      return original(items, lifecycle);
    });
    const running = runChatTask(h.task, h.deps);
    await bothStarted;
    controller.abort("user_stop");
    await expect(running).rejects.toThrow("request_cancelled");
    expect(h.deps.renderProgram).not.toHaveBeenCalled();
    expect(h.mock.roots).toHaveLength(0);
    const saved = ChatTaskSchema.parse(structuredClone(h.checkpoints.at(-1)));
    expect(saved.universalScreens?.some(({ status }) => status === "composing")).toBe(true);
    const resumedDeps = { ...h.deps, signal: new AbortController().signal };
    await runChatTask(saved, resumedDeps);
    expect(saved.status).toBe("completed");
    expect(saved.universalScreens?.map(({ status }) => status)).toEqual(["verified", "verified", "verified"]);
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(3);
    expect(new Set(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete").map(({ id }) => id)).size).toBe(3);
  });

  it("reuses a compatible Phase 5 pending screen response without another provider request", async () => {
    const input = { ...cases[0]!, screens: cases[0]!.screens.slice(0, 1), brief: "برای آموزش فارسی یک صفحهٔ موبایل جدید بساز." };
    const h = makeHarness(input);
    const original = h.model.getMockImplementation()!;
    let interrupted = false;
    h.model.mockImplementation(async (items, lifecycle) => {
      if (lifecycle === "UNIVERSAL_COMPOSING" && !interrupted) {
        interrupted = true;
        throw new Error("Simulated interruption before a Phase 5 response");
      }
      return original(items, lifecycle);
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("before a Phase 5 response");
    const saved = ChatTaskSchema.parse(structuredClone(h.checkpoints.at(-1)));
    expect(saved.projectPlan?.screens).toHaveLength(1);
    const pending = parseResponsesFunctionCalls([{
      type: "function_call",
      call_id: "phase5-pending-call-0001",
      name: "compose_design_program",
      arguments: JSON.stringify({ screenId: "screen-01", program: programFor(input, 0) }),
    }]);
    saved.pending = pending;
    saved.recent = pending.map(({ functionCall }) => functionCall);
    saved.universalScreens![0]!.status = "pending";
    saved.universalScreens![0]!.composeAttempts = 0;
    const requestsBeforeResume = h.model.mock.calls.filter(([, lifecycle]) => lifecycle === "UNIVERSAL_COMPOSING").length;
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    expect(saved.universalScreens?.[0]?.status).toBe("verified");
    expect(h.model.mock.calls.filter(([, lifecycle]) => lifecycle === "UNIVERSAL_COMPOSING")).toHaveLength(requestsBeforeResume);
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(1);
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(1);
  });

  it("does not schedule a dependent screen until its dependency program is checkpointed", async () => {
    const input = { ...scriptedMarineCase(3), independentScreens: false };
    const h = makeHarness(input, { providerDelayForScreen: (screenId) => screenId === "screen-01" ? 35 : 1, maxConcurrentModelCalls: 2 });
    await runChatTask(h.task, h.deps);
    expect(h.task.projectPlan?.screens.map(({ dependencies }) => dependencies)).toEqual([[], ["screen-01"], ["screen-02"]]);
    expect(h.modelCompletionScreenIds).toEqual(["screen-01", "screen-02", "screen-03"]);
    expect(h.task.universalMetrics?.peakConcurrentModelRequests).toBe(1);
    expect(h.deps.renderProgram.mock.calls.map(([program]) => program.screens[0]?.id)).toEqual(["screen-01", "screen-02", "screen-03"]);
  });

  it("keeps native placement order when the first screen finishes fastest", async () => {
    const input = scriptedMarineCase(3);
    const h = makeHarness(input, { maxConcurrentModelCalls: 2 });
    const model = h.model.getMockImplementation()!;
    let releaseSecond!: () => void;
    const thirdCompleted = new Promise<void>((resolve) => { releaseSecond = resolve; });
    h.model.mockImplementation(async (items, lifecycle, requestId, signal) => {
      if (requestId?.endsWith("screen-02_c1")) await thirdCompleted;
      const result = await model(items, lifecycle, requestId, signal);
      if (requestId?.endsWith("screen-03_c1")) releaseSecond();
      return result;
    });
    await runChatTask(h.task, h.deps);
    expect(h.modelCompletionScreenIds.indexOf("screen-01")).toBeLessThan(h.modelCompletionScreenIds.indexOf("screen-02"));
    expect(h.modelCompletionScreenIds.indexOf("screen-03")).toBeLessThan(h.modelCompletionScreenIds.indexOf("screen-02"));
    expect(h.deps.renderProgram.mock.calls.map(([program]) => program.screens[0]?.id)).toEqual(["screen-01", "screen-02", "screen-03"]);
    expect(h.task.universalScreens?.map(({ screenId, status }) => [screenId, status])).toEqual([
      ["screen-01", "verified"], ["screen-02", "verified"], ["screen-03", "verified"],
    ]);
  });

  it("reduces persisted concurrency after a provider capacity signal and resumes without a retry storm", async () => {
    const h = makeHarness(scriptedMarineCase(3), { maxConcurrentModelCalls: 2 });
    const original = h.model.getMockImplementation()!;
    let capacityHit = false;
    h.model.mockImplementation(async (items, lifecycle) => {
      if (lifecycle === "UNIVERSAL_COMPOSING" && !capacityHit) {
        const requestItem = [...items].reverse().find((item) => "role" in item && item.role === "user");
        const requestText = requestItem && "content" in requestItem ? requestItem.content : "";
        if (requestText.includes("screen-02")) {
          capacityHit = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          throw Object.assign(new Error("bounded provider capacity response"), { category: "inference_busy" });
        }
      }
      return original(items, lifecycle);
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("bounded provider capacity response");
    const saved = ChatTaskSchema.parse(structuredClone(h.checkpoints.at(-1)));
    expect(saved.universalMetrics).toMatchObject({ concurrencyLimit: 1, schedulerMode: "serial", peakConcurrentModelRequests: 2 });
    const callsBeforeResume = h.model.mock.calls.filter(([, lifecycle]) => lifecycle === "UNIVERSAL_COMPOSING").length;
    expect(callsBeforeResume).toBeGreaterThanOrEqual(2);
    expect(callsBeforeResume).toBeLessThanOrEqual(3);
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    expect(saved.universalMetrics?.concurrencyLimit).toBe(1);
    expect(saved.universalMetrics?.peakConcurrentModelRequests).toBe(2);
    expect(saved.universalScreens?.every(({ status }) => status === "verified")).toBe(true);
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(3);
    expect(h.model.mock.calls.filter(([, lifecycle]) => lifecycle === "UNIVERSAL_COMPOSING").length).toBeLessThanOrEqual(callsBeforeResume + 3);
  });

  it("rejects a schema-valid but changed saved program before replay", async () => {
    const h = makeHarness(cases[0]!);
    h.deps.renderProgram.mockRejectedValueOnce(new Error("Simulated interruption"));
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("interruption");
    const saved = ChatTaskSchema.parse(h.checkpoints.at(-1));
    saved.universalScreens![0]!.program!.goal = "Different valid persisted content";
    await expect(runChatTask(saved, h.deps)).rejects.toThrow("program_checkpoint_inconsistent");
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(1);
    expect(h.mock.roots).toHaveLength(0);
  });

  it("revalidates a built pending root after a simulated plugin restart and keeps its native ID", async () => {
    const h = makeHarness(cases[0]!);
    const program = programFor(cases[0]!, 0);
    const scope = { taskId: h.task.id, documentId: h.task.documentId, pageId: h.mock.page.id };
    const interrupted = await renderDesignProgramLocal(h.mock.api, program, {
      ...scope, executor: { registerRenderedGeneration: async () => { throw new Error("Interrupted before adoption"); } },
    });
    expect(interrupted.success).toBe(false);
    const root = h.mock.roots.find((node) => node.getPluginData("fad.design.program-built.v1") === "1")!;
    const nativeIds = h.mock.nodes.map(({ id }) => id);
    root.setPluginData("fad.generation.commit", "pending");
    root.setPluginData("fad.design.geometry-receipt.v1", "");
    const executor = createFigmaToolExecutor(h.mock.api, () => undefined);
    const recovered = await renderDesignProgramLocal(h.mock.api, program, { ...scope, executor });
    expect(recovered).toMatchObject({ success: true, roots: [{ nodeId: root.id }] });
    expect(h.mock.nodes.map(({ id }) => id)).toEqual(nativeIds);
    expect(root.getPluginData("fad.generation.commit")).toBe("complete");
  });

  it("preserves mixed Persian and English editability and selects the Arabic fallback only for that text", async () => {
    const mixed = "می\u200cخواهم ۱۲٫۵ USD";
    const input: Case = { ...cases[0]!, screens: cases[0]!.screens.map((screen, index) => index === 0 ? { ...screen, name: mixed } : screen) };
    const h = makeHarness(input);
    await runChatTask(h.task, h.deps);
    const texts = h.mock.nodes.filter((node) => node.type === "TEXT");
    const persian = texts.find((node) => node.characters === mixed);
    const english = texts.find((node) => node.characters === input.screens[0]!.purpose);
    expect(persian).toMatchObject({ type: "TEXT", characters: mixed, textAutoResize: "HEIGHT", textAlignHorizontal: "RIGHT", fontName: { family: "Arial" } });
    expect(english?.fontName).toMatchObject({ family: "Inter" });
    const corrupted = programFor(input, 0);
    const root = corrupted.screens[0]!.root;
    if (root.type !== "container" || root.children[0]?.type !== "container" || root.children[0].children[0]?.type !== "text")
      throw new Error("Missing test text node");
    root.children[0].children[0].text += "\ufffd";
    expect(parseDesignProgram(corrupted)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "invalid_native_text" })]) });
  });

  it("stops before native construction when no Arabic-capable font can be loaded", async () => {
    const h = makeHarness(cases[0]!);
    h.mock.api.listAvailableFontsAsync = async () => [{ fontName: { family: "Inter", style: "Regular" } }];
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("native_render_incomplete");
    expect(h.mock.roots).toHaveLength(0);
  });

  it("rejects fresh readback when an instance no longer resolves its original native master", async () => {
    const h = makeHarness(cases[0]!, { localComponent: true });
    const inspect = h.deps.inspectProgram.getMockImplementation()!;
    h.deps.inspectProgram.mockImplementationOnce(async (request) => {
      const instance = h.mock.nodes.find((node) => node.type === "INSTANCE")!;
      instance.getMainComponentAsync = async () => null;
      const result = await inspect(request);
      expect(result.geometry?.findings).toContainEqual(expect.objectContaining({ code: "native_instance_master_mismatch" }));
      return result;
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("native_geometry_failed");
    expect(h.task.universalScreens?.[0]?.status).toBe("rendered");
  });

  it("uses the same native route for an unfamiliar three-screen community instrument library", async () => {
    const h = makeHarness({
      name: "community instrument library",
      brief: "Design 3 desktop screens for a community instrument library: instrument catalog, loan inspection, and return intake.",
      purpose: "Help volunteers lend instruments and record their condition on return.",
      audience: "Instrument library volunteers and borrowers",
      platform: "desktop",
      locale: "en-US",
      tags: ["community-lending"],
      entities: ["instrument", "loan", "condition record"],
      goals: ["Find an instrument", "Review a loan", "Intake a return"],
      screens: [
        { name: "Instrument catalog", role: "browse", purpose: "Find a lendable instrument." },
        { name: "Loan inspection", role: "detail", purpose: "Review the instrument condition before loan." },
        { name: "Return intake", role: "intake", purpose: "Record the condition of the returned instrument." },
      ],
    });
    await runChatTask(h.task, h.deps);
    const roots = h.task.universalScreens?.map(({ status, rootRef }) => ({ status, rootRef })) ?? [];
    expect(roots).toHaveLength(3);
    expect(roots.every(({ status, rootRef }) => status === "verified" && rootRef)).toBe(true);
    expect(new Set(roots.map(({ rootRef }) => rootRef)).size).toBe(3);
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it("detects painted text overflow even when the editable text box fits", async () => {
    const h = makeHarness(cases[0]!);
    const inspect = h.deps.inspectProgram.getMockImplementation()!;
    h.deps.inspectProgram.mockImplementationOnce(async (request) => {
      const text = h.mock.nodes.find((node) => node.type === "TEXT")!;
      const parent = text.parent as typeof text;
      const frame = parent.absoluteBoundingBox!;
      Object.defineProperty(text, "absoluteRenderBounds", {
        value: { x: frame.x + 12, y: frame.y + 12, width: 32, height: frame.height - 6 },
      });
      const result = await inspect(request);
      expect(result.geometry?.findings).toContainEqual(expect.objectContaining({ code: "native_text_render_overflow" }));
      return result;
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("native_geometry_failed");
  });

  it("resumes a checkpoint after interrupted post-adoption verification without recreating its screen or master", async () => {
    const h = makeHarness(cases[0]!, { localComponent: true });
    h.deps.inspectProgram.mockRejectedValueOnce(new Error("Simulated verification interruption"));
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("verification interruption");
    const previousRoot = h.mock.roots.find((node) => node.getPluginData("fad.generation.commit") === "complete");
    expect(previousRoot).toBeDefined();
    const saved = ChatTaskSchema.parse(structuredClone(h.task));
    expect(saved.universalScreens?.[0]?.status).toBe("rendered");
    await runChatTask(h.task, h.deps);
    expect(h.task.status).toBe("completed");
    expect(h.mock.roots.find((node) => node.id === previousRoot?.id)).toBe(previousRoot);
    expect(h.mock.nodes.filter((node) => node.type === "COMPONENT" && !node.removed)).toHaveLength(1);
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(3);
  });

  it("reuses a persisted program when interrupted before any native creation", async () => {
    const h = makeHarness(cases[0]!);
    h.deps.renderProgram.mockRejectedValueOnce(new Error("Simulated interruption before native creation"));
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("before native creation");
    expect(h.mock.roots).toHaveLength(0);
    const saved = ChatTaskSchema.parse(structuredClone(h.checkpoints.at(-1)));
    expect(saved.universalScreens?.[0]).toMatchObject({ status: "rendering", program: expect.any(Object) });
    const compositionCallsBeforeResume = h.lifecycles.filter((name) => name === "UNIVERSAL_COMPOSING").length;
    const unsavedPrograms = saved.universalScreens!.filter(({ program }) => !program).length;
    await runChatTask(saved, h.deps);
    expect(saved.status).toBe("completed");
    expect(h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(3);
    expect(h.lifecycles.filter((name) => name === "UNIVERSAL_COMPOSING").length - compositionCallsBeforeResume).toBe(unsavedPrograms);
  });

  it("reuses a task local component master across two native screen instances", async () => {
    const h = makeHarness(cases[0]!, { localComponent: true });
    await runChatTask(h.task, h.deps).catch((error: unknown) => {
      throw new Error(JSON.stringify(h.task.universalScreens?.flatMap(({ findings }) => findings ?? [])), { cause: error });
    });
    expect(h.task.status).toBe("completed");
    expect(h.mock.nodes.filter((node) => node.type === "COMPONENT" && !node.removed)).toHaveLength(1);
    const instances = h.mock.nodes.filter((node) => node.type === "INSTANCE" && !node.removed);
    expect(instances).toHaveLength(2);
    expect(instances.every((node) => node.children[0]?.type === "ELLIPSE")).toBe(true);
    expect(instances[0]?.getPluginData("fad.tool.logical-ref.v1")).not.toBe(instances[1]?.getPluginData("fad.tool.logical-ref.v1"));
  });

  it("keeps a rendered checkpoint unverified when fresh native readback finds horizontal bleed", async () => {
    const h = makeHarness(cases[0]!);
    const inspect = h.deps.inspectProgram.getMockImplementation()!;
    h.deps.inspectProgram.mockImplementationOnce(async (request) => {
      const text = h.mock.nodes.find((node) => node.type === "TEXT")!;
      text.x += 20;
      const result = await inspect(request);
      expect(result.geometry?.findings).toContainEqual(expect.objectContaining({ code: "native_horizontal_overflow", nodeId: text.id }));
      return result;
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("native_geometry_failed");
    expect(h.task.universalScreens?.[0]).toMatchObject({ status: "rendered", geometryVersion: 1 });
    expect(h.mock.nodes.filter((node) => node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(1);
  });

  it("preserves the current selection and verifies a tall RTL body inside the fixed viewport", async () => {
    const h = makeHarness(cases[0]!);
    const selection = h.mock.api.createRectangle();
    h.mock.api.currentPage.selection = [selection];
    await runChatTask(h.task, h.deps);
    const roots = h.mock.roots.filter((node) => node.getPluginData("fad.generation.commit") === "complete");
    expect(roots).toHaveLength(3);
    for (const root of roots) {
      expect(root).toMatchObject({ width: 390, height: 844, clipsContent: true, overflowDirection: "VERTICAL" });
      expect(root.children[0]!.height).toBeGreaterThan(1000);
    }
    expect(h.mock.api.currentPage.selection).toEqual([selection]);
    expect(h.mock.nodes.find((node) => node.type === "TEXT")?.textAlignHorizontal).toBe("RIGHT");
  });

  it("defaults every new Chat task to Universal, independent of prompt intent", () => {
    expect(DEFAULT_DESIGN_ENGINE).toBe("universal");
    expect(selectChatExecutionRoute()).toBe("universal-design-v1");
    expect(selectChatExecutionRoute("universal")).toBe("universal-design-v1");
    expect(selectChatExecutionRoute("legacy")).toBe("legacy");
    expect(isClearCreateRequest("سه صفحهٔ جدید و قابل‌ویرایش بساز تا بعداً بتوانم صفحهٔ چهارم را تغییر بدهم.")).toBe(true);
    expect(selectChatExecutionRoute("universal")).toBe("universal-design-v1");
  });

  it.each([
    ["English count with device adjective", "Design 3 desktop screens for a new analytics workspace.", 3, "desktop"],
    ["English word count with device adjective", "Build four mobile screens for a field service team.", 4, "mobile"],
    ["Persian word count", "سه صفحهٔ موبایل جدید برای خدمات شهری بساز.", 3, "mobile"],
  ])("recognizes requested count when device or editability words precede the screen noun: %s", (_name, prompt, screenCount, target) => {
    expect(parseChatGenerationIntent(prompt)).toMatchObject({ kind: "ready", intent: { screenCount, target } });
  });

  it.each([
    "صفحهٔ ۴ را تغییر بده و بقیه را دست نزن.",
    "Change screen 4 without touching the others.",
    "Continue the saved task.",
    "Resume task chat-001.",
    "Create 3 screens and then edit screen 4 in the existing file.",
  ])("keeps engine preference separate from prompt classification: %s", (prompt) => {
    expect(selectChatExecutionRoute("universal")).toBe("universal-design-v1");
    expect(selectChatExecutionRoute("legacy")).toBe("legacy");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it.each([
    [null, "universal"],
    ["enabled", "universal"],
    ["disabled", "universal"],
    ["legacy", "universal"],
    ["true", "universal"],
    ["unknown", "universal"],
  ] as const)("migrates old experimental flag %s to the default engine %s", (oldValue, engine) => {
    expect(migrateExperimentalEngineFlag(oldValue)).toBe(engine);
  });

  it("prefers a persisted engine selection over the retired experimental flag", () => {
    expect(resolveDesignEnginePreference({ version: 1, selectedEngine: "legacy" }, "enabled")).toBe("legacy");
    expect(resolveDesignEnginePreference({ version: 1, selectedEngine: "universal" }, "legacy")).toBe("universal");
    expect(resolveDesignEnginePreference(undefined, "enabled")).toBe("universal");
  });

  it("normalizes an open-domain plan with stable ordered screen identities and exact request bounds", () => {
    const input = cases[4]!;
    const draft = draftFor(input);
    const first = parseProjectPlanDraft(draft, { taskId: "chat-universal-0001", requestedScreenCount: 5, requestedTarget: "mobile", requestedLocale: "en-US" });
    const second = parseProjectPlanDraft(draft, { taskId: "chat-universal-0001", requestedScreenCount: 5, requestedTarget: "mobile", requestedLocale: "en-US" });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.plan.domainTags).toEqual(["facilities-operations", "maintenance-workflow"]);
    expect(first.plan.screens.map(({ screenId, order }) => [screenId, order])).toEqual([
      ["screen-01", 0], ["screen-02", 1], ["screen-03", 2], ["screen-04", 3], ["screen-05", 4],
    ]);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(parseProjectPlanDraft(draft, { taskId: "chat-universal-0001", requestedScreenCount: 3 }).success).toBe(false);
    expect(ProjectPlanDraftSchema.safeParse({ ...draft, screenCount: 11 }).success).toBe(false);
    expect(ProjectPlanDraftSchema.safeParse({ ...draft, screens: draft.screens.slice(0, 4), screenCount: 4, productPurpose: "" }).success).toBe(false);
  });

  it.each(cases)("runs the actual Chat task coordinator, provider parser, Phase 2 adapter, native mock renderer and readback for $name", async (input) => {
    const h = makeHarness(input);
    await runChatTask(h.task, h.deps);
    expect(h.task.status).toBe("completed");
    expect(h.task.executionRoute).toBe("universal-design-v1");
    expect(h.task.generationIntent).toMatchObject({ screenCount: input.screens.length, target: input.platform, locale: input.locale });
    expect(h.task.universalScreens).toHaveLength(input.screens.length);
    expect(h.task.universalScreens?.every(({ status, program, rootRef, nativeNodeCount, verifiedNodeCount }) => status === "verified" && Boolean(program) && Boolean(rootRef) && Boolean(nativeNodeCount) && verifiedNodeCount === nativeNodeCount)).toBe(true);
    expect(h.task.projectPlan?.screens.map(({ name }) => name)).toEqual(input.screens.map(({ name }) => name));
    expect(h.task.projectPlan?.direction).toBe(input.locale === "fa-IR" ? "rtl" : "ltr");
    const composedPrograms = h.task.universalScreens!.map(({ program }) => program!);
    expect(new Set(composedPrograms.map(({ visualLanguageV1 }) => JSON.stringify(visualLanguageV1))).size).toBe(1);
    expect(composedPrograms.every(({ screens }) => Boolean(screens[0]?.compositionV1?.decisionTrace && screens[0]?.compositionV1?.regions.length === 3))).toBe(true);
    expect(composedPrograms.every(({ screens }) => screens[0]?.compositionV1?.variationSeed === compositionVariationSeed(h.task.id, screens[0]!.id))).toBe(true);
    if (composedPrograms.length >= 3)
      expect(new Set(composedPrograms.slice(0, 3).map(({ screens }) => compositionTopology(screens[0]!.root))).size).toBe(3);
    expect(h.task.universalMetrics).toMatchObject({
      intentRequests: 1,
      planRequests: 1,
      programRequests: input.screens.length,
      repairRequests: 0,
      providerRounds: input.screens.length + 2,
      nativeBatches: input.screens.length,
      timingEvidence: "mock",
      benchmarkComparableTiming: "not-measured",
    });
    expect(h.task.universalMetrics?.acceptedScreenTimesMs).toHaveLength(input.screens.length);
    expect(h.task.text).toContain(input.locale === "fa-IR" ? "مسیر طراحی همگانی v1" : "Universal design route v1");
    expect(h.authChecks).toBeGreaterThan(input.screens.length);
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(input.screens.length);
    expect(h.deps.inspectProgram).toHaveBeenCalledTimes(input.screens.length);
    expect(h.model.mock.calls.map(([, lifecycle]) => lifecycle)).toEqual([
      "UNIVERSAL_CLASSIFY",
      "UNIVERSAL_PLANNING",
      ...input.screens.map(() => "UNIVERSAL_COMPOSING"),
    ]);
    expect(h.modelInputs.some((items) => JSON.stringify(items).includes(input.brief))).toBe(true);
    const roots = h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete");
    expect(roots).toHaveLength(input.screens.length);
    expect(new Set(roots.map((node) => node.id)).size).toBe(input.screens.length);
    const nativeText = h.mock.nodes.filter((node) => node.type === "TEXT").map((node) => String(node.characters)).join(" ");
    expect(nativeText).toContain(input.screens[0]!.name);
    expect(nativeText).not.toMatch(/cart|checkout|apparel|clothing|clothes/iu);
    expect(chatTaskSafeDiagnostic(h.task)).toMatchObject({ executionRoute: "universal-design-v1", generationRoute: "universal_design_v1" });
  });

  it("evaluates a newly authored unseen brief after implementation through the same unbranched Chat path", async () => {
    const unseen: Case = {
      name: "unseen marine specimen custody",
      brief: "Design four desktop screens for a marine specimen archive: accession intake, provenance review, conservation record, and loan readiness. Keep specimen identifiers consistent across screens and use clearly illustrative records.",
      purpose: "Help collection staff track a marine specimen from accession through conservation and loan review.",
      audience: "Museum collection and conservation staff",
      platform: "desktop",
      locale: "en-US",
      tags: ["marine-collections", "specimen-provenance"],
      entities: ["specimen", "accession event", "conservation record", "loan request"],
      goals: ["Register a specimen", "Review provenance", "Record preservation work", "Assess loan readiness"],
      screens: [
        { name: "Accession intake", role: "collection-intake", purpose: "Register a specimen and establish its stable collection identifier." },
        { name: "Provenance review", role: "provenance-review", purpose: "Review the specimen's acquisition history and evidence trail." },
        { name: "Conservation record", role: "conservation-log", purpose: "Record synthetic preservation observations and completed care actions." },
        { name: "Loan readiness", role: "loan-assessment", purpose: "Assess documented readiness and constraints for a potential loan." },
      ],
    };
    const h = makeHarness(unseen);
    await runChatTask(h.task, h.deps);
    expect(h.task.status).toBe("completed");
    expect(h.task.generationIntent).toMatchObject({ screenCount: 4, target: "desktop", locale: "en-US" });
    expect(h.task.projectPlan?.domainTags).toEqual(unseen.tags);
    expect(h.task.projectPlan?.keyEntities.map(({ name }) => name)).toEqual(unseen.entities);
    expect(h.task.projectPlan?.screens.map(({ name, role, purpose }) => ({ name, role, purpose }))).toEqual(unseen.screens);
    expect(new Set(h.task.projectPlan?.screens.map(({ purpose }) => purpose)).size).toBe(4);
    expect(h.task.universalScreens?.every(({ status }) => status === "verified")).toBe(true);
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(4);
    const rootCount = h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete").length;
    expect(rootCount).toBe(4);
    const modelText = h.mock.nodes.filter((node) => node.type === "TEXT").map((node) => String(node.characters)).join(" ");
    expect(modelText).toMatch(/specimen|provenance|conservation|loan/iu);
    expect(modelText).not.toMatch(/cart|checkout|apparel|clothing|clothes/iu);
  });

  it("accepts a genuinely sparse confirmation screen without a node-count floor", async () => {
    const confirmation: Case = {
      name: "sparse appointment confirmation",
      brief: "Create one mobile appointment confirmation screen in English.",
      purpose: "Confirm the booking and explain the next step.",
      audience: "A person who just booked an appointment",
      platform: "mobile",
      locale: "en-US",
      tags: ["appointment-confirmation"],
      entities: ["appointment"],
      goals: ["Review the booking"],
      screens: [{ name: "Booking confirmed", role: "confirmation", purpose: "Confirm the booked appointment and show the next step." }],
    };
    const h = makeHarness(confirmation, { sparseConfirmation: true });
    await runChatTask(h.task, h.deps);
    const program = h.task.universalScreens?.[0]?.program;
    expect(h.task.status).toBe("completed");
    expect(program?.screens[0]?.compositionV1?.regions).toHaveLength(1);
    expect(parseDesignProgram(program).success).toBe(true);
    expect(h.task.universalScreens?.[0]?.verifiedNodeCount).toBeGreaterThan(0);
  });

  it("applies the task-pinned Brand Kit while preserving an explicit user palette override", async () => {
    const brandKit = pinnedBrandFixture();
    const base = cases[2]!;
    const brandRun = makeHarness(base, { brandKit });
    await runChatTask(brandRun.task, brandRun.deps);
    expect(brandRun.task.projectPlan?.visualLanguageV1?.colorRoles.primary).toBe("#2463EB");
    expect(brandRun.task.projectPlan?.visualLanguageV1?.typography.headingFont).toBe("Brand Display");
    expect(brandRun.task.projectPlan?.visualLanguageV1?.spacingScale).toEqual([4, 8, 12, 16]);
    expect(brandRun.task.universalScreens?.every(({ program }) => program?.tokens.colors.primary === "#2463EB")).toBe(true);

    const override = createDefaultVisualLanguage({ styleDirection: "Use a calm teal product identity", density: "medium", locale: base.locale });
    override.colorRoles.primary = "#117A65";
    const explicit: Case = { ...base, brief: `${base.brief} Use #117A65 as the project primary color instead of the Brand Kit color.` };
    const explicitRun = makeHarness(explicit, { brandKit, planLanguage: override });
    await runChatTask(explicitRun.task, explicitRun.deps);
    expect(explicitRun.task.projectPlan?.visualLanguageV1?.colorRoles.primary).toBe("#117A65");
    expect(explicitRun.task.projectPlan?.visualLanguageV1?.typography.headingFont).toBe("Brand Display");
    expect(explicitRun.task.universalScreens?.every(({ program }) => program?.tokens.colors.primary === "#117A65")).toBe(true);
  });

  it("corrects an invalid structured plan with one bounded schema retry", async () => {
    const h = makeHarness(cases[0]!, { firstPlanMalformed: true });
    await runChatTask(h.task, h.deps);
    expect(h.task.status).toBe("completed");
    expect(h.task.universalMetrics).toMatchObject({ planRequests: 2, repairRequests: 0 });
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(cases[0]!.screens.length);
    expect(h.model.mock.calls.slice(1, 3).map(([, lifecycle]) => lifecycle)).toEqual(["UNIVERSAL_PLANNING", "UNIVERSAL_PLANNING"]);
  });

  it("performs one bounded semantic repair from persisted findings before native rendering", async () => {
    const h = makeHarness(cases[0]!, { firstProgramViewportMismatch: true });
    await runChatTask(h.task, h.deps);
    expect(h.task.status).toBe("completed");
    expect(h.task.universalMetrics).toMatchObject({ repairRequests: 1, nativeBatches: cases[0]!.screens.length });
    expect(h.task.universalScreens?.[0]).toMatchObject({ status: "verified", repairAttempts: 1 });
    expect(h.task.universalScreens?.[0]?.findings).toEqual([]);
    expect(h.deps.renderProgram).toHaveBeenCalledTimes(cases[0]!.screens.length);
    expect(h.model.mock.calls.map(([, lifecycle]) => lifecycle)).toContain("UNIVERSAL_REPAIR");
  });

  it("refuses native rendering when its one semantic repair leaves a finding unresolved", async () => {
    const h = makeHarness(cases[0]!, { firstProgramViewportMismatch: true, repairViewportMismatch: true });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow(/program_repair_exhausted/u);
    expect(h.task.status).toBe("failed");
    expect(h.task.universalScreens?.[0]).toMatchObject({ status: "repair_pending", repairAttempts: 1, errorCode: "program_preflight_failed" });
    expect(h.deps.renderProgram).not.toHaveBeenCalled();
    expect(h.task.universalMetrics?.nativeBatches).toBe(0);
  });

  it("persists the plan and accepted model program before renderer dispatch, then resumes an ambiguous render without duplicating its root", async () => {
    const input: Case = {
      name: "single-page equipment archive",
      brief: "Build one mobile screen to review scientific equipment calibration records.",
      purpose: "Help laboratory staff review equipment calibration history.",
      audience: "Laboratory operations staff",
      platform: "mobile",
      locale: "en-US",
      tags: ["laboratory-operations", "equipment-records"],
      entities: ["instrument", "calibration-event", "service-provider"],
      goals: ["Review calibration state"],
      screens: [{ name: "Calibration record", role: "history", purpose: "Review a synthetic instrument calibration timeline." }],
    };
    const h = makeHarness(input);
    const actualRender = h.deps.renderProgram.getMockImplementation();
    expect(actualRender).toBeDefined();
    const rememberSnapshot = h.deps.save.getMockImplementation()!;
    const chatId = "chat-ambiguous-render";
    let saveSequence = 0;
    h.deps.save.mockImplementation(async (snapshot) => {
      const saved = await handleChatTaskStorage(h.mock.api, {
        type: "chat-task-save", requestId: `ambiguous-render-save-${++saveSequence}`,
        documentId: snapshot.documentId, chatId, task: snapshot,
      });
      expect(saved).toMatchObject({ success: true, revision: expect.any(Object) });
      await rememberSnapshot(snapshot);
    });
    h.deps.renderProgram.mockImplementationOnce(async (program, requestId) => {
      await actualRender!(program, requestId);
      throw new Error("Simulated lost native render acknowledgement");
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("lost native render acknowledgement");
    const loaded = await handleChatTaskStorage(h.mock.api, {
      type: "chat-task-load", requestId: "ambiguous-render-reload", documentId: h.task.documentId, chatId,
    });
    const persisted = ChatTaskSchema.parse(loaded.task);
    expect(persisted.id).toBe(h.task.id);
    expect(persisted.projectPlan).toBeDefined();
    expect(persisted.universalScreens?.[0]).toMatchObject({ status: "rendering", program: expect.any(Object) });
    const rootsBefore = h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete");
    expect(rootsBefore).toHaveLength(1);
    const providerCallsBeforeResume = h.model.mock.calls.length;
    await runChatTask(persisted, h.deps);
    const rootsAfterResume = h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete");
    expect(rootsAfterResume).toHaveLength(1);
    expect(h.model.mock.calls).toHaveLength(providerCallsBeforeResume);
    expect(rootsAfterResume[0]?.id).toBe(rootsBefore[0]?.id);
    expect(persisted.status).toBe("completed");
  });

  it("shares the strict DesignProgramV1 boundary and refuses unverified references and remote assets", () => {
    const input = cases[0]!;
    const program = programFor(input, 0);
    expect(parseDesignProgram(program).success).toBe(true);
    expect(compileDesignProgram(program).success).toBe(true);
    const phase3Checkpoint = structuredClone(program);
    Reflect.deleteProperty(phase3Checkpoint, "visualLanguageV1");
    Reflect.deleteProperty(phase3Checkpoint.screens[0]!, "compositionV1");
    const removeTextRoles = (node: DesignProgramNode) => {
      if (node.type === "text") Reflect.deleteProperty(node, "textRole");
      if (node.type === "container") node.children.forEach(removeTextRoles);
    };
    removeTextRoles(phase3Checkpoint.screens[0]!.root);
    expect(parseDesignProgram(phase3Checkpoint).success).toBe(true);
    expect(compileDesignProgram(phase3Checkpoint).success).toBe(true);
    expect(UniversalDesignProgramV1Schema.safeParse(phase3Checkpoint).success).toBe(false);
    expect(parseDesignProgram({ ...program, programVersion: 2 }).success).toBe(false);
    const external = structuredClone(program);
    const externalRoot = external.screens[0]!.root;
    if (externalRoot.type !== "container") throw new Error("Program fixture root must be a container.");
    externalRoot.children.push({
      type: "image",
      id: "remote-asset",
      name: "Remote image",
      semanticRole: "image",
      interaction: "none",
      width: { mode: "fixed", value: 80 },
      height: { mode: "fixed", value: 80 },
      asset: { source: "placeholder", label: "https://example.invalid/image.png" },
    });
    expect(parseDesignProgram(external).success).toBe(false);
    expect(() => parseResponsesFunctionCalls([{
      type: "function_call",
      call_id: "universal-call-invalid",
      name: "compose_design_program",
      arguments: JSON.stringify({ screenId: "screen-01", program: { programVersion: 999 } }),
    }])).toThrow();
    const unauthorized = structuredClone(program);
    const unauthorizedRoot = unauthorized.screens[0]!.root;
    if (unauthorizedRoot.type !== "container") throw new Error("Program fixture root must be a container.");
    unauthorizedRoot.children.push({
      type: "image",
      id: "unverified-asset",
      name: "Unverified asset",
      semanticRole: "image",
      interaction: "none",
      width: { mode: "fixed", value: 80 },
      height: { mode: "fixed", value: 80 },
      asset: { source: "authorized-existing-file", label: "private image", assetRef: "node:guessed", verified: false, authorized: false },
    });
    expect(parseDesignProgram(unauthorized).success).toBe(false);
  });

  it("preflights fixed-axis overflow, touch targets and text contrast without guessing an aesthetic score", () => {
    const overflowing = programFor(cases[2]!, 1);
    const horizontal = overflowing.screens[0]!.root;
    if (horizontal.type !== "container") throw new Error("Program fixture root must be a container.");
    const fixedRegion = horizontal.children[0];
    if (fixedRegion?.type !== "container") throw new Error("Program fixture region must be a container.");
    fixedRegion.width.value = horizontal.width.value + 80;
    expect(parseDesignProgram(overflowing).success).toBe(false);
    expect(parseDesignProgram(overflowing).findings.some(({ code }) => code === "layout_axis_overflow")).toBe(true);

    const tinyTarget = programFor(cases[0]!, 0);
    const tinyRoot = tinyTarget.screens[0]!.root;
    if (tinyRoot.type !== "container") throw new Error("Program fixture root must be a container.");
    const action = tinyRoot.children[2];
    if (action?.type !== "container") throw new Error("Program fixture action region must be a container.");
    action.width.value = 40;
    expect(parseDesignProgram(tinyTarget).findings.some(({ code }) => code === "touch_target_below_minimum")).toBe(true);

    const lowContrast = programFor(cases[0]!, 0);
    const replaceTextColors = (node: DesignProgramNode) => {
      if (node.type === "text") node.color = "#FFFFFF";
      if (node.type === "container") node.children.forEach(replaceTextColors);
    };
    replaceTextColors(lowContrast.screens[0]!.root);
    const audit = compileDesignProgram(lowContrast);
    expect(audit.success).toBe(true);
    if (audit.success) expect(audit.findings.some(({ code }) => code === "quality_low-contrast")).toBe(true);
  });

  it("renders a hash-verified pinned Brand Kit image as an editable native image fill", async () => {
    const input = cases[0]!;
    const assetId = "asset_universal_01";
    const asset = createBrandVisualAsset({
      assetId,
      kind: "raster",
      variant: "primary",
      name: "User-provided field image",
      mimeType: "image/png",
      width: 1,
      height: 1,
      contentHash: brandAssetContentHash(ONE_PIXEL_PNG),
      provenance: "user-provided",
      rightsNote: "Provided for a local regression test",
      createdAt: 1,
    }, ONE_PIXEL_PNG);
    const program = programFor(input, 0);
    const root = program.screens[0]!.root;
    if (root.type !== "container") throw new Error("Program fixture root must be a container.");
    root.children.push({
      type: "image",
      id: "brand-image",
      name: "Pinned field image",
      semanticRole: "approved-brand-media",
      interaction: "none",
      width: { mode: "fixed", value: 80 },
      height: { mode: "fixed", value: 80 },
      asset: { source: "user-approved-brand-kit", label: asset.name, assetRef: assetId, verified: true, authorized: true },
    });
    program.screens[0]!.compositionV1!.approvedAssetsUsed = [assetId];
    program.requiredCapabilities.push("image");
    expect(parseDesignProgram(program).success).toBe(false);
    expect(parseDesignProgram(program, { allowedBrandAssetIds: new Set([assetId]) }).success).toBe(true);
    const preflight = compileDesignProgram(program, { allowedBrandAssetIds: new Set([assetId]) });
    expect(preflight.success, JSON.stringify(preflight)).toBe(true);

    const mock = createMockApi({ simulateFill: true });
    const executor = createFigmaToolExecutor(mock.api, () => {});
    const rendered = await renderDesignProgramLocal(mock.api, program, {
      taskId: "chat-asset-test-0001",
      documentId: "file-test-56-page_current",
      pageId: "page:current",
      executor,
      assets: [asset],
    });
    expect(rendered.success, JSON.stringify(rendered)).toBe(true);
    expect(mock.nodes.some((node) => node.type === "RECTANGLE" && node.getPluginData("fad.design.asset-id") === assetId)).toBe(true);
    const replayProgram = structuredClone(program);
    replayProgram.id = "project-asset-reuse";
    const replay = await renderDesignProgramLocal(mock.api, replayProgram, {
      taskId: "chat-asset-test-0002",
      documentId: "file-test-56-page_current",
      pageId: "page:current",
      executor,
      assets: [asset],
    });
    expect(replay.success, JSON.stringify(replay)).toBe(true);
    expect(mock.getImageImportCalls()).toBe(1);
  });

  it("records the serial 1/3/10-screen baseline with deterministic provider delays", async () => {
    const measurements: Array<Record<string, number>> = [];
    for (const screenCount of [1, 3, 10]) {
      for (let repetition = 1; repetition <= 3; repetition++) {
        const input = scriptedMarineCase(screenCount);
        const h = makeHarness(input, { providerDelayForScreen: (screenId) => screenId === "screen-01" ? 60 : 15, maxConcurrentModelCalls: 1 });
        const startedAt = performance.now();
        await runChatTask(h.task, h.deps);
        measurements.push({
          screens: screenCount,
          repetition,
          elapsedMs: Math.round(performance.now() - startedAt),
          providerRequests: h.model.mock.calls.length,
          providerRounds: h.task.universalMetrics!.providerRounds,
          intentRequests: h.task.universalMetrics!.intentRequests,
          intentClassificationMs: h.task.universalMetrics!.intentClassificationMs,
          peakModelCalls: h.task.universalMetrics!.peakConcurrentModelRequests,
          firstNativeMs: h.task.universalMetrics!.firstNativeProgressMs ?? -1,
          firstVerifiedMs: h.task.universalMetrics!.firstVerifiedScreenMs ?? -1,
          providerMs: h.task.universalMetrics!.providerLatencyMs,
          compositionMs: h.task.universalMetrics!.programCompositionMs,
          queueWaitMs: h.task.universalMetrics!.providerQueueWaitMs,
          normalizationMs: h.task.universalMetrics!.programNormalizationMs,
          preflightMs: h.task.universalMetrics!.programPreflightMs,
          persistenceMs: h.task.universalMetrics!.persistenceMs,
          nativeMs: h.task.universalMetrics!.nativeDurationMs,
          readbackMs: h.task.universalMetrics!.readbackRoundTripMs,
          nativeNodes: h.task.universalScreens!.reduce((sum, screen) => sum + (screen.nativeNodeCount ?? 0), 0),
          nativeBatches: h.task.universalMetrics!.nativeBatches,
        });
        expect(h.task.status).toBe("completed");
        expect(h.task.universalMetrics?.concurrencyLimit).toBe(1);
        expect(h.task.universalMetrics?.peakConcurrentModelRequests).toBe(1);
        expect(h.model).toHaveBeenCalledTimes(screenCount + 2);
        expect(h.deps.renderProgram).toHaveBeenCalledTimes(screenCount);
        expect(h.deps.inspectProgram).toHaveBeenCalledTimes(screenCount);
      }
    }
    process.stderr.write(`PHASE6_SERIAL_BASELINE ${JSON.stringify(measurements)}\n`);
  }, 60_000);

  it("measures bounded screen scheduling at 1/3/10 with out-of-order provider completion and ordered native commits", async () => {
    const measurements: Array<Record<string, number>> = [];
    for (const screenCount of [1, 3, 10]) {
      for (let repetition = 1; repetition <= 3; repetition++) {
        const input = scriptedMarineCase(screenCount);
        const h = makeHarness(input, {
          providerDelayForScreen: (screenId) => screenId === "screen-01" ? 60 : 15,
          maxConcurrentModelCalls: 2,
        });
        const startedAt = performance.now();
        await runChatTask(h.task, h.deps);
        const elapsedMs = Math.round(performance.now() - startedAt);
        const metrics = h.task.universalMetrics!;
        measurements.push({
          screens: screenCount,
          repetition,
          elapsedMs,
          providerRequests: h.model.mock.calls.length,
          providerRounds: metrics.providerRounds,
          intentRequests: metrics.intentRequests,
          intentClassificationMs: metrics.intentClassificationMs,
          peakModelCalls: metrics.peakConcurrentModelRequests,
          firstNativeMs: metrics.firstNativeProgressMs ?? -1,
          firstVerifiedMs: metrics.firstVerifiedScreenMs ?? -1,
          providerMs: metrics.providerLatencyMs,
          compositionMs: metrics.programCompositionMs,
          queueWaitMs: metrics.providerQueueWaitMs,
          normalizationMs: metrics.programNormalizationMs,
          preflightMs: metrics.programPreflightMs,
          persistenceMs: metrics.persistenceMs,
          nativeMs: metrics.nativeDurationMs,
          readbackMs: metrics.readbackRoundTripMs,
          nativeNodes: h.task.universalScreens!.reduce((sum, screen) => sum + (screen.nativeNodeCount ?? 0), 0),
          nativeBatches: metrics.nativeBatches,
        });
        expect(h.task.status).toBe("completed");
        expect(h.task.universalManifest?.screens.map(({ screenId }) => screenId)).toEqual(input.screens.map((_, index) => `screen-${String(index + 1).padStart(2, "0")}`));
        expect(h.task.universalScreens?.map(({ screenId, status }) => [screenId, status])).toEqual(input.screens.map((_, index) => [`screen-${String(index + 1).padStart(2, "0")}`, "verified"]));
        expect(h.deps.renderProgram.mock.calls.map(([program]) => program.screens[0]?.id)).toEqual(input.screens.map((_, index) => `screen-${String(index + 1).padStart(2, "0")}`));
        expect(h.deps.inspectProgram.mock.calls.map(([request]) => {
          const inspect = request as unknown as { type?: string; refs?: string[] };
          return inspect.type === "task-native-inspect" ? inspect.refs?.[0] : undefined;
        })).toEqual(h.task.universalScreens!.map(({ rootRef }) => rootRef));
        expect(metrics.peakConcurrentModelRequests).toBe(screenCount > 1 ? 2 : 1);
        expect(metrics.timingEvidence).toBe("mock");
        expect(metrics.traceEvents.every((event) => event.buildId === "phase6-universal-orchestrator-v1" && event.taskId === h.task.id)).toBe(true);
        if (screenCount > 1) expect(h.modelCompletionScreenIds[0]).not.toBe("screen-01");
        expect(JSON.stringify(chatTaskSafeDiagnostic(h.task))).not.toContain(input.brief);
        expect(h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete")).toHaveLength(screenCount);
      }
    }
    process.stderr.write(`PHASE6_BOUNDED_PARALLEL_MOCK ${JSON.stringify(measurements)}\n`);
  }, 60_000);
});
