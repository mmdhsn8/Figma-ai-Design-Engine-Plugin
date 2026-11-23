import { z } from "zod";
import { CHAT_ABORT_ORIGINS } from "./chat-cancellation.js";
import { DESIGN_PROGRAM_VERSION, DesignProgramV1Schema } from "./design-program.js";
import { createDefaultVisualLanguage, ProjectVisualLanguageV1Schema } from "./design-composition.js";
import { VisualQaOutcomeV1Schema } from "./fw5-visual-qa.js";

const text = (maximum: number, minimum = 1) => z.string().trim().min(minimum).max(maximum);
const orderRef = z.number().int().min(0).max(9);
const localeSchema = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u).max(16);

export const ProjectPlanDraftSchema = z
  .object({
    productPurpose: text(500),
    projectNarrative: text(1_000),
    audience: text(200),
    primaryUserGoals: z.array(text(240)).min(1).max(10),
    capabilities: z.array(text(100)).max(16),
    keyEntities: z
      .array(z.object({ name: text(80), meaning: text(180), provenance: z.enum(["user-stated", "inferred", "illustrative"]) }).strict())
      .max(16),
    domainTags: z.array(text(48)).max(12),
    platform: z.enum(["mobile", "desktop"]),
    locale: localeSchema,
    direction: z.enum(["rtl", "ltr"]),
    screenCount: z.number().int().min(1).max(10),
    styleDirection: text(500),
    visualLanguageV1: ProjectVisualLanguageV1Schema.optional(),
    contentDensity: z.enum(["low", "medium", "high"]),
    contentSamplePolicy: z.enum(["user-provided-only", "clearly-illustrative", "no-sample-data"]),
    accessibilityMinimums: z.array(text(180)).max(10),
    componentOpportunities: z.array(text(100)).max(12),
    designConstraints: z.array(text(180)).max(16),
    screens: z
      .array(
        z
          .object({
            order: orderRef,
            name: text(100),
            role: text(80),
            purpose: text(240),
            source: z.enum(["requested", "inferred"]),
            primaryTask: text(180),
            entryState: text(120),
            exitState: text(120),
            regions: z
              .array(
                z
                  .object({
                    name: text(80),
                    semanticRole: text(60),
                    content: text(180),
                    priority: z.number().int().min(1).max(6),
                  })
                  .strict(),
              )
              .min(1)
              .max(6),
            dataRelationships: z.array(text(140)).max(8),
            responsiveConstraints: z.array(text(140)).max(8),
            accessibilityNotes: z.array(text(140)).max(8),
            entityRefs: z.array(text(80)).max(12),
            actions: z.array(z.object({ label: text(80), purpose: text(120) }).strict()).max(8),
            states: z.array(text(100)).max(8),
            navigationOrders: z.array(orderRef).max(8),
            dependencyOrders: z.array(orderRef).max(8),
            scroll: z.enum(["none", "vertical"]),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    knownFacts: z.array(text(240)).max(12),
    assumptions: z.array(text(240)).max(12),
    nonGoals: z.array(text(180)).max(12),
  })
  .strict();
export type ProjectPlanDraft = z.infer<typeof ProjectPlanDraftSchema>;

const PlannedRegionSchema = z
  .object({ name: text(80), semanticRole: text(60), content: text(180), priority: z.number().int().min(1).max(6) })
  .strict();

const PlannedScreenSchema = z
  .object({
    screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u),
    order: orderRef,
    name: text(100),
    role: text(80),
    purpose: text(240),
    source: z.enum(["requested", "inferred"]),
    primaryTask: text(180),
    entryState: text(120),
    exitState: text(120),
    regions: z.array(PlannedRegionSchema).min(1).max(6),
    dataRelationships: z.array(text(140)).max(8),
    responsiveConstraints: z.array(text(140)).max(8),
    accessibilityNotes: z.array(text(140)).max(8),
    entityRefs: z.array(text(80)).max(12),
    actions: z.array(z.object({ label: text(80), purpose: text(120) }).strict()).max(8),
    states: z.array(text(100)).max(8),
    navigationTargets: z.array(z.string().regex(/^screen-(?:0[1-9]|10)$/u)).max(8),
    dependencies: z.array(z.string().regex(/^screen-(?:0[1-9]|10)$/u)).max(8),
    scroll: z.enum(["none", "vertical"]),
    viewport: z.discriminatedUnion("preset", [
      z.object({ preset: z.literal("mobile"), width: z.literal(390), height: z.literal(844) }).strict(),
      z.object({ preset: z.literal("desktop"), width: z.literal(1440), height: z.literal(900) }).strict(),
    ]),
  })
  .strict();

export const ProjectPlanV1Schema = z
  .object({
    version: z.literal(1),
    taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    projectId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/u),
    plannerVersion: z.literal("universal-planner-v1"),
    designProgramVersion: z.literal(DESIGN_PROGRAM_VERSION),
    productPurpose: text(500),
    projectNarrative: text(1_000),
    audience: text(200),
    primaryUserGoals: z.array(text(240)).min(1).max(10),
    capabilities: z.array(text(100)).max(16),
    keyEntities: ProjectPlanDraftSchema.shape.keyEntities,
    domainTags: z.array(text(48)).max(12),
    platform: z.enum(["mobile", "desktop"]),
    locale: localeSchema,
    direction: z.enum(["rtl", "ltr"]),
    viewport: z.discriminatedUnion("preset", [
      z.object({ preset: z.literal("mobile"), width: z.literal(390), height: z.literal(844) }).strict(),
      z.object({ preset: z.literal("desktop"), width: z.literal(1440), height: z.literal(900) }).strict(),
    ]),
    screenCount: z.number().int().min(1).max(10),
    styleDirection: text(500),
    visualLanguageV1: ProjectVisualLanguageV1Schema.optional(),
    contentDensity: z.enum(["low", "medium", "high"]),
    contentSamplePolicy: z.enum(["user-provided-only", "clearly-illustrative", "no-sample-data"]),
    accessibilityMinimums: z.array(text(180)).max(10),
    componentOpportunities: z.array(text(100)).max(12),
    designConstraints: z.array(text(180)).max(16),
    screens: z.array(PlannedScreenSchema).min(1).max(10),
    knownFacts: z.array(text(240)).max(12),
    assumptions: z.array(text(240)).max(12),
    nonGoals: z.array(text(180)).max(12),
    pinnedBrandKit: z.object({ id: text(80), revision: z.number().int().positive(), tokenHash: z.string().regex(/^[a-f0-9]{8}$/u) }).strict().optional(),
    pinnedSkills: z.array(z.object({ id: text(80), revisionId: text(120) }).strict()).max(3),
    capabilityFlags: z.array(z.enum(["native-frame", "native-text", "native-shape", "auto-layout", "vertical-scroll", "local-placeholder-only", "pinned-brand-assets", "task-scoped-readback"])).max(12),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.screenCount !== plan.screens.length)
      context.addIssue({ code: "custom", path: ["screens"], message: "Screen count must match the ordered screen list." });
    const expectedViewport = plan.platform === "mobile" ? { preset: "mobile", width: 390, height: 844 } : { preset: "desktop", width: 1440, height: 900 };
    if (JSON.stringify(plan.viewport) !== JSON.stringify(expectedViewport))
      context.addIssue({ code: "custom", path: ["viewport"], message: "Viewport must match the supported platform preset." });
    const expectedDirection = /^(?:fa|ar|ur|he)(?:-|$)/iu.test(plan.locale) ? "rtl" : "ltr";
    if (plan.direction !== expectedDirection)
      context.addIssue({ code: "custom", path: ["direction"], message: "Reading direction does not match the project locale." });
    const byOrder = new Map(plan.screens.map((screen) => [screen.order, screen]));
    const names = plan.screens.map(({ name }) => name.toLocaleLowerCase());
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", path: ["screens"], message: "Screen names must be distinct." });
    for (const [index, screen] of plan.screens.entries()) {
      const expectedId = `screen-${String(index + 1).padStart(2, "0")}`;
      if (screen.order !== index || screen.screenId !== expectedId)
        context.addIssue({ code: "custom", path: ["screens", index], message: "Screen order and stable identity must be contiguous and deterministic." });
      for (const target of [...screen.navigationTargets, ...screen.dependencies])
        if (!plan.screens.some(({ screenId }) => screenId === target) || target === screen.screenId)
          context.addIssue({ code: "custom", path: ["screens", index], message: "Screen relationship points to a missing or self screen." });
      if (new Set(screen.dependencies).size !== screen.dependencies.length || new Set(screen.navigationTargets).size !== screen.navigationTargets.length)
        context.addIssue({ code: "custom", path: ["screens", index], message: "Screen relationships must be unique." });
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (screenId: string) => {
      if (visiting.has(screenId)) return false;
      if (visited.has(screenId)) return true;
      visiting.add(screenId);
      const order = Number(screenId.slice(-2)) - 1;
      for (const dependencyOrder of byOrder.get(order)?.dependencies.map((id) => Number(id.slice(-2)) - 1) ?? []) {
        const dependency = plan.screens[dependencyOrder];
        if (dependency && !visit(dependency.screenId)) return false;
      }
      visiting.delete(screenId);
      visited.add(screenId);
      return true;
    };
    if (plan.screens.some(({ screenId }) => !visit(screenId)))
      context.addIssue({ code: "custom", path: ["screens"], message: "Screen dependencies must be acyclic." });
  });
export type ProjectPlanV1 = z.infer<typeof ProjectPlanV1Schema>;

export type ProjectPlanFinding = { code: string; path: string; message: string };
export type ProjectPlanResult = { success: true; plan: ProjectPlanV1; fingerprint: string } | { success: false; findings: ProjectPlanFinding[] };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export const UNIVERSAL_DESIGN_TRACE_BUILD_ID = "phase6-universal-orchestrator-v1" as const;

export const UniversalJobManifestV1Schema = z
  .object({
    version: z.literal(1),
    taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
    engineRoute: z.literal("universal-design-v1"),
    modelSlug: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/u),
    planFingerprint: z.string().regex(/^ppv1-[a-f0-9]{16}$/u),
    designProgramVersion: z.literal(DESIGN_PROGRAM_VERSION),
    platform: z.enum(["mobile", "desktop"]),
    locale: localeSchema,
    direction: z.enum(["rtl", "ltr"]),
    screens: z.array(z.object({
      screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u),
      order: orderRef,
      name: text(100),
      role: text(80),
      dependencies: z.array(z.string().regex(/^screen-(?:0[1-9]|10)$/u)).max(8),
    }).strict()).min(1).max(10),
    brandKit: z.object({
      id: text(80),
      revision: z.number().int().positive(),
      tokenHash: z.string().regex(/^[a-f0-9]{8}$/u),
      assets: z.array(z.object({ assetId: text(80), contentHash: z.string().regex(/^[a-f0-9]{8}$/u) }).strict()).max(100),
    }).strict().optional(),
    skills: z.array(z.object({ id: text(80), revisionId: text(120) }).strict()).max(3),
    capabilities: z.array(z.enum(["native-frame", "native-text", "native-shape", "auto-layout", "vertical-scroll", "local-placeholder-only", "pinned-brand-assets", "task-scoped-readback"])).max(12),
    layoutCapabilities: z.array(z.enum(["auto-layout", "fill-and-hug-sizing", "bounded-wrap", "vertical-scroll", "native-components", "editable-text"])).max(8),
    fingerprint: z.string().regex(/^ujm1-[a-f0-9]{16}$/u),
  })
  .strict()
  .superRefine((manifest, context) => {
    const fingerprint = universalJobManifestFingerprint({ ...manifest, fingerprint: undefined });
    if (fingerprint !== manifest.fingerprint)
      context.addIssue({ code: "custom", path: ["fingerprint"], message: "The immutable task manifest fingerprint does not match its saved values." });
    if (manifest.screens.some((screen, index) => screen.order !== index || screen.screenId !== `screen-${String(index + 1).padStart(2, "0")}`))
      context.addIssue({ code: "custom", path: ["screens"], message: "The manifest screen identities and order must be contiguous and stable." });
  });
export type UniversalJobManifestV1 = z.infer<typeof UniversalJobManifestV1Schema>;

export function universalJobManifestFingerprint(manifest: unknown): string {
  const value = JSON.stringify(canonical(manifest));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `ujm1-${hash.toString(16).padStart(16, "0")}`;
}

export const UniversalDesignTraceEventSchema = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
  taskId: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/u),
  engineRoute: z.literal("universal-design-v1"),
  buildId: z.literal(UNIVERSAL_DESIGN_TRACE_BUILD_ID),
  stageId: z.string().regex(/^(?:task|screen-(?:0[1-9]|10))$/u),
  stage: z.enum(["intent", "plan", "compose", "repair", "normalize", "preflight", "persistence", "native_render", "native_readback", "visual_capture", "visual_review", "visual_repair", "verification", "task"]),
  event: z.enum(["request_started", "request_completed", "request_failed", "checkpoint_saved", "program_normalized", "preflight_completed", "render_dispatched", "render_acknowledged", "readback_completed", "recovered", "task_completed"]),
  outcome: z.enum(["started", "completed", "failed", "recovered"]),
  providerRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
  nativeOperationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
  nativeBatchId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
  attempt: z.number().int().min(1).max(10).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  queueWaitMs: z.number().int().nonnegative().max(86_400_000).optional(),
  inputBytes: z.number().int().nonnegative().max(10_000_000).optional(),
  outputBytes: z.number().int().nonnegative().max(10_000_000).optional(),
  upstreamHeadersMs: z.number().int().nonnegative().max(600_000).optional(),
  firstDeltaMs: z.number().int().nonnegative().max(600_000).optional(),
  nodeCount: z.number().int().nonnegative().max(500).optional(),
  qaFindingCodes: z.array(z.string().regex(/^[a-z0-9_-]{1,80}$/u)).max(8).optional(),
  qaCoverage: z.enum(["complete", "incomplete"]).optional(),
  code: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/u).optional(),
  cancellationOrigin: z.enum(CHAT_ABORT_ORIGINS).optional(),
}).strict();
export type UniversalDesignTraceEvent = z.infer<typeof UniversalDesignTraceEventSchema>;

export function projectPlanFingerprint(plan: ProjectPlanV1): string {
  const value = JSON.stringify(canonical(plan));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `ppv1-${hash.toString(16).padStart(16, "0")}`;
}

export function parseProjectPlanDraft(
  value: unknown,
  context: {
    taskId: string;
    requestedScreenCount?: number;
    requestedTarget?: "mobile" | "desktop";
    requestedLocale?: string;
    visualLanguageFallback?: z.infer<typeof ProjectVisualLanguageV1Schema>;
    brandKit?: { id: string; revision: number; tokenHash: string; assetIds?: string[] };
    skills?: Array<{ id: string; revisionId: string }>;
  },
): ProjectPlanResult {
  const parsed = ProjectPlanDraftSchema.safeParse(value);
  if (!parsed.success)
    return { success: false, findings: parsed.error.issues.slice(0, 20).map((issue) => ({ code: "project_plan_schema_invalid", path: issue.path.map(String).join(".") || "plan", message: issue.message.slice(0, 180) })) };
  const draft = parsed.data;
  const findings: ProjectPlanFinding[] = [];
  if (draft.screenCount !== draft.screens.length) findings.push({ code: "screen_count_mismatch", path: "screens", message: "Plan count and screen list length differ." });
  if (context.requestedScreenCount !== undefined && draft.screenCount !== context.requestedScreenCount)
    findings.push({ code: "requested_count_mismatch", path: "screenCount", message: "The plan changed the screen count requested in Chat." });
  if (context.requestedTarget && draft.platform !== context.requestedTarget)
    findings.push({ code: "requested_platform_mismatch", path: "platform", message: "The plan changed the requested device family." });
  if (context.requestedLocale && draft.locale.toLocaleLowerCase() !== context.requestedLocale.toLocaleLowerCase())
    findings.push({ code: "requested_locale_mismatch", path: "locale", message: "The plan changed the language/locale of the Chat request." });
  if (findings.length) return { success: false, findings };
  const viewport = draft.platform === "mobile" ? { preset: "mobile" as const, width: 390 as const, height: 844 as const } : { preset: "desktop" as const, width: 1440 as const, height: 900 as const };
  const screens = draft.screens.map((screen, index) => ({
    screenId: `screen-${String(index + 1).padStart(2, "0")}`,
    order: index,
    name: screen.name,
    role: screen.role,
    purpose: screen.purpose,
    source: screen.source,
    primaryTask: screen.primaryTask,
    entryState: screen.entryState,
    exitState: screen.exitState,
    regions: screen.regions,
    dataRelationships: screen.dataRelationships,
    responsiveConstraints: screen.responsiveConstraints,
    accessibilityNotes: screen.accessibilityNotes,
    entityRefs: screen.entityRefs,
    actions: screen.actions,
    states: screen.states,
    navigationTargets: screen.navigationOrders.map((order) => `screen-${String(order + 1).padStart(2, "0")}`),
    dependencies: screen.dependencyOrders.map((order) => `screen-${String(order + 1).padStart(2, "0")}`),
    scroll: screen.scroll,
    viewport,
  }));
  const candidate = {
    version: 1 as const,
    taskId: context.taskId,
    projectId: `project-${context.taskId}`.slice(0, 60),
    plannerVersion: "universal-planner-v1" as const,
    designProgramVersion: DESIGN_PROGRAM_VERSION,
    productPurpose: draft.productPurpose,
    projectNarrative: draft.projectNarrative,
    audience: draft.audience,
    primaryUserGoals: draft.primaryUserGoals,
    capabilities: draft.capabilities,
    keyEntities: draft.keyEntities,
    domainTags: draft.domainTags,
    platform: draft.platform,
    locale: draft.locale,
    direction: draft.direction,
    viewport,
    screenCount: draft.screenCount,
    styleDirection: draft.styleDirection,
    visualLanguageV1: draft.visualLanguageV1 ?? context.visualLanguageFallback ?? createDefaultVisualLanguage({ styleDirection: draft.styleDirection, density: draft.contentDensity, locale: draft.locale }),
    contentDensity: draft.contentDensity,
    contentSamplePolicy: draft.contentSamplePolicy,
    accessibilityMinimums: draft.accessibilityMinimums,
    componentOpportunities: draft.componentOpportunities,
    designConstraints: draft.designConstraints,
    screens,
    knownFacts: draft.knownFacts,
    assumptions: draft.assumptions,
    nonGoals: draft.nonGoals,
    ...(context.brandKit ? { pinnedBrandKit: { id: context.brandKit.id, revision: context.brandKit.revision, tokenHash: context.brandKit.tokenHash } } : {}),
    pinnedSkills: context.skills ?? [],
    capabilityFlags: ["native-frame", "native-text", "native-shape", "auto-layout", "vertical-scroll", "local-placeholder-only", ...(context.brandKit?.assetIds?.length ? ["pinned-brand-assets" as const] : []), "task-scoped-readback"] as const,
  };
  const checked = ProjectPlanV1Schema.safeParse(candidate);
  if (!checked.success)
    return { success: false, findings: checked.error.issues.slice(0, 20).map((issue) => ({ code: "project_plan_invariant_failed", path: issue.path.map(String).join(".") || "plan", message: issue.message.slice(0, 180) })) };
  return { success: true, plan: checked.data, fingerprint: projectPlanFingerprint(checked.data) };
}

export const UniversalScreenCheckpointSchema = z
  .object({
    screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u),
    status: z.enum(["pending", "composing", "repair_pending", "program_saved", "rendering", "rendered", "verified"]),
    startedAtMs: z.number().int().nonnegative().optional(),
    composeAttempts: z.number().int().min(0).max(10).default(0),
    activeRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
    schemaFeedback: z.string().max(500).optional(),
    repairDispatches: z.number().int().min(0).max(3).default(0),
    program: DesignProgramV1Schema.optional(),
    fingerprint: z.string().regex(/^dpv1-[a-f0-9]{16}$/u).optional(),
    rootRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u).optional(),
    nativeRootNodeId: z.string().min(1).max(100).optional(),
    nativePageId: z.string().min(1).max(200).optional(),
    nativeBatchId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
    adoptionOperationIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u)).max(200).optional(),
    nativeNodeCount: z.number().int().min(0).max(300).optional(),
    verifiedNodeCount: z.number().int().min(0).max(500).optional(),
    geometryVersion: z.literal(1).optional(),
    visualQa: VisualQaOutcomeV1Schema.optional(),
    renderAttempts: z.number().int().min(0).max(3).optional(),
    repairAttempts: z.number().int().min(0).max(1).default(0),
    schemaCorrections: z.number().int().min(0).max(2).default(0),
    findings: z.array(z.object({ code: z.string().regex(/^[a-z0-9_-]{1,80}$/u), path: z.string().max(200), message: z.string().max(180) }).strict()).max(12).optional(),
    errorCode: z.string().regex(/^[a-z_]{1,80}$/u).optional(),
  })
  .strict();
export type UniversalScreenCheckpoint = z.infer<typeof UniversalScreenCheckpointSchema>;

export const UniversalDesignMetricsSchema = z
  .object({
    version: z.literal(1),
    startedAtMs: z.number().int().nonnegative(),
    intentRequests: z.number().int().min(0).max(3).default(0),
    intentClassificationMs: z.number().int().min(0).max(86_400_000).default(0),
    planRequests: z.number().int().min(0).max(3),
    programRequests: z.number().int().min(0).max(100),
    repairRequests: z.number().int().min(0).max(10),
    providerRounds: z.number().int().min(0).max(100),
    providerInputBytes: z.number().int().min(0).max(10_000_000),
    providerLatencyMs: z.number().int().min(0).max(86_400_000),
    nativeBatches: z.number().int().min(0).max(30),
    nativeDurationMs: z.number().int().min(0).max(86_400_000),
    nativeGeometryMs: z.number().finite().min(0).max(86_400_000).optional(),
    nativeReadbackMs: z.number().finite().min(0).max(86_400_000).optional(),
    nativeGeometryRepairs: z.number().int().min(0).max(10).optional(),
    firstNativeProgressMs: z.number().int().nonnegative().optional(),
    firstVerifiedScreenMs: z.number().int().nonnegative().optional(),
    totalElapsedMs: z.number().int().nonnegative().optional(),
    acceptedScreenTimesMs: z.array(z.object({ screenId: z.string().regex(/^screen-(?:0[1-9]|10)$/u), elapsedMs: z.number().int().nonnegative() }).strict()).max(10),
    timingEvidence: z.enum(["live", "mock"]),
    benchmarkComparableTiming: z.literal("not-measured"),
    schedulerMode: z.enum(["serial", "bounded-parallel"]).default("bounded-parallel"),
    concurrencyLimit: z.union([z.literal(1), z.literal(2)]).default(2),
    peakConcurrentModelRequests: z.number().int().min(0).max(2).default(0),
    providerQueueWaitMs: z.number().int().min(0).max(86_400_000).default(0),
    providerFirstDeltaMs: z.number().int().min(0).max(86_400_000).default(0),
    programCompositionMs: z.number().int().min(0).max(86_400_000).default(0),
    programNormalizationMs: z.number().int().min(0).max(86_400_000).default(0),
    programPreflightMs: z.number().int().min(0).max(86_400_000).default(0),
    persistenceMs: z.number().int().min(0).max(86_400_000).default(0),
    readbackRoundTripMs: z.number().int().min(0).max(86_400_000).default(0),
    traceSequence: z.number().int().min(0).max(100_000).default(0),
    traceEvents: z.array(UniversalDesignTraceEventSchema).max(128).default([]),
  })
  .strict();
