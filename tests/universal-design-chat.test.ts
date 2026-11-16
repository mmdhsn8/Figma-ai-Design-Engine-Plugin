import { describe, expect, it, vi } from "vitest";
import { ChatTaskSchema, chatTaskSafeDiagnostic, type ChatTask } from "../src/shared/chat-task";
import { parseResponsesFunctionCalls, type ChatInputItem } from "../src/shared/chat-tools";
import { parseChatGenerationIntent, isClearCreateRequest } from "../src/shared/chat-generation";
import { DesignProgramV1Schema, parseDesignProgram, type DesignProgramV1 } from "../src/shared/design-program";
import { ProjectPlanDraftSchema, parseProjectPlanDraft } from "../src/shared/universal-design";
import { compileDesignProgram } from "../src/shared/design-program-adapter";
import { runChatTask } from "../src/ui/chat-task";
import { renderDesignProgramLocal } from "../src/plugin/design-program-spike";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { createMockApi } from "./figma-mock";
import type { AuthorizedChatTurn } from "../src/ui/companion-client";
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

function draftFor(input: Case) {
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
      ],
      dataRelationships: [`${input.entities[0]} links to ${input.entities[1] ?? input.entities[0]}`],
      responsiveConstraints: [input.platform === "mobile" ? "Vertical scroll within a 390px mobile frame" : "Keep primary data and controls aligned on a 1440px desktop frame"],
      accessibilityNotes: ["Use labeled actions and preserve the project's reading direction"],
      entityRefs: input.entities.slice(0, 4),
      actions: [{ label: input.goals[order % input.goals.length]!, purpose: screen.purpose }],
      states: ["ready", "empty", "completed"],
      navigationOrders: order < input.screens.length - 1 ? [order + 1] : [],
      dependencyOrders: order > 0 ? [order - 1] : [],
      scroll: "vertical",
    })),
    knownFacts: ["The requested audience and main goal are stated in the brief."],
    assumptions: ["No existing project file or data source was inspected."],
    nonGoals: ["No live records, appointments, metrics or customer details"],
  });
}

function programFor(input: Case, screenIndex: number): DesignProgramV1 {
  const screen = input.screens[screenIndex]!;
  const viewport = input.platform === "mobile"
    ? { preset: "mobile" as const, width: 390 as const, height: 844 as const }
    : { preset: "desktop" as const, width: 1440 as const, height: 900 as const };
  const width = viewport.width - 48;
  const content = [screen.name, screen.purpose, `${input.entities[screenIndex % input.entities.length]} · ${input.goals[screenIndex % input.goals.length]}`];
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
    weight: index === 0 ? "bold" as const : "regular" as const,
    align: input.locale === "fa-IR" ? "right" as const : "left" as const,
  });
  return DesignProgramV1Schema.parse({
    programVersion: 1,
    id: "model-generated-project",
    revision: 7,
    goal: input.purpose,
    audience: input.audience,
    locale: { language: input.locale, direction: input.locale === "fa-IR" ? "rtl" : "ltr" },
    visualIntent: "An editable, coherent screen with grouped project-specific information and a clear next action.",
    contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", ...(input.locale === "fa-IR" ? ["rtl" as const] : []), "vertical-scroll"],
    tokens: {
      colors: { background: "#F7F8FA", surface: "#FFFFFF", primary: "#315E75", accent: "#E4AA55", text: "#17232A", muted: "#5D6A70" },
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
      dependsOn: screenIndex > 0 ? [`screen-${String(screenIndex).padStart(2, "0")}`] : [],
      root: {
        type: "container",
        id: "screen-layout",
        name: `${screen.name} layout`,
        semanticRole: "screen-layout",
        interaction: "none",
        width: { mode: "fixed", value: width },
        height: { mode: "fixed", value: viewport.height + 120 },
        background: "token:background",
        layout: { axis: "column", gap: 20, padding: { top: 8, right: 0, bottom: 8, left: 0 }, align: "start", crossAlign: "stretch" },
        children: content.map((_, index) => ({
          type: "container" as const,
          id: `region-${index + 1}`,
          name: `Content region ${index + 1}`,
          semanticRole: ["primary-summary", "supporting-details", "next-step"][index]!,
          interaction: "none" as const,
          width: { mode: "fill" as const, value: width },
          height: { mode: "fixed" as const, value: 96 },
          background: index === 2 ? "#E9F0F2" : "token:surface",
          layout: { axis: "column" as const, gap: 8, padding: { top: 16, right: 16, bottom: 16, left: 16 }, align: "start" as const, crossAlign: "stretch" as const },
          children: [textNode(index)],
        })),
      },
    }],
  });
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

function makeHarness(input: Case, options: {
  firstPlanMalformed?: boolean;
  firstProgramViewportMismatch?: boolean;
  repairViewportMismatch?: boolean;
} = {}) {
  const task = taskFor(input);
  const mock = createMockApi();
  const sent: PluginToUIMessage[] = [];
  const executor = createFigmaToolExecutor(mock.api, (message) => sent.push(message));
  const checkpoints: ChatTask[] = [];
  const modelInputs: ChatInputItem[][] = [];
  const lifecycles: string[] = [];
  let providerCall = 0;
  let composed = 0;
  let authChecks = 0;
  const model = vi.fn(async (items: ChatInputItem[], lifecycle: string) => {
    modelInputs.push(items);
    lifecycles.push(lifecycle);
    const index = ++providerCall;
    if (lifecycle === "UNIVERSAL_CLASSIFY") return modelTurn("classify_canvas_intent", { intent: "create" }, index);
    if (lifecycle === "UNIVERSAL_PLANNING") {
      if (options.firstPlanMalformed && index === 2)
        return {
          kind: "tool_validation" as const,
          issues: [{ toolName: "plan_universal_project", callId: "universal-call-0002", stage: "arguments_schema" as const, errorCode: "too_small", fieldPaths: ["productPurpose"] }],
        };
      return modelTurn("plan_universal_project", draftFor(input), index);
    }
    if (lifecycle === "UNIVERSAL_COMPOSING") {
      const screenIndex = composed++;
      const program = programFor(input, screenIndex);
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
      const repair = checkpoints.at(-1)?.universalScreens?.find(({ status }) => status === "repair_pending");
      if (!repair) throw new Error("The repair request has no persisted finding scope.");
      const screenIndex = Number(repair.screenId.slice("screen-".length)) - 1;
      const program = programFor(input, screenIndex);
      if (options.repairViewportMismatch) {
        program.screens[0]!.viewport = input.platform === "mobile"
          ? { preset: "desktop", width: 1440, height: 900 }
          : { preset: "mobile", width: 390, height: 844 };
      }
      return modelTurn("repair_design_program", {
        screenId: repair.screenId,
        findings: repair.findings,
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
    renderProgram: vi.fn(async (program: DesignProgramV1, requestId: string) => {
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
      });
      if (!rendered.success)
        return { type: "design-program-render-result" as const, requestId, taskId: task.id, success: false, errorCode: rendered.code, findings: rendered.findings };
      const root = rendered.roots[0]!;
      return {
        type: "design-program-render-result" as const,
        requestId,
        taskId: task.id,
        success: true,
        screenId: root.screenId,
        rootRef: root.ref,
        nativeBatchId: rendered.batchId,
        adoptionOperationIds: rendered.operationIds,
        programFingerprint: rendered.fingerprint,
        nativeNodeCount: rendered.registeredRefs,
      };
    }),
    inspectProgram: vi.fn(async (request: Parameters<typeof executor>[0]) => {
      await executor(request);
      const result = sent.at(-1);
      if (result?.type !== "task-native-inspection-result") throw new Error("Missing mock native inspection response.");
      return result;
    }),
    timingEvidence: "mock" as const,
  };
  return { task, mock, sent, checkpoints, modelInputs, lifecycles, model, deps, get authChecks() { return authChecks; } };
}

describe("universal design Chat route", () => {
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
    expect(h.task.universalMetrics).toMatchObject({
      planRequests: 1,
      programRequests: input.screens.length,
      repairRequests: 0,
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
    h.deps.renderProgram.mockImplementationOnce(async (program, requestId) => {
      await actualRender!(program, requestId);
      throw new Error("Simulated lost native render acknowledgement");
    });
    await expect(runChatTask(h.task, h.deps)).rejects.toThrow("lost native render acknowledgement");
    const persisted = ChatTaskSchema.parse(structuredClone(h.task));
    expect(persisted.projectPlan).toBeDefined();
    expect(persisted.universalScreens?.[0]).toMatchObject({ status: "rendering", program: expect.any(Object) });
    const rootsBefore = h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete");
    expect(rootsBefore).toHaveLength(1);
    const providerCallsBeforeResume = h.model.mock.calls.length;
    await runChatTask(h.task, h.deps);
    const rootsAfterResume = h.mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.generation.commit") === "complete");
    expect(rootsAfterResume).toHaveLength(1);
    expect(h.model.mock.calls).toHaveLength(providerCallsBeforeResume);
    expect(h.task.status).toBe("completed");
  });

  it("shares the strict DesignProgramV1 boundary and refuses unverified references and remote assets", () => {
    const input = cases[0]!;
    const program = programFor(input, 0);
    expect(parseDesignProgram(program).success).toBe(true);
    expect(compileDesignProgram(program).success).toBe(true);
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
});
