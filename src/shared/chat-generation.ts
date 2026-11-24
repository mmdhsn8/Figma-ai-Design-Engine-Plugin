import { z } from "zod";
import { ModelIdSchema } from "./model-preference";
import { PinnedBrandKitSchema, type PinnedBrandKit } from "./brand-kit";
import { PinnedDesignSkillsSchema, type PinnedDesignSkill } from "./design-skill";
import { createDesignPlan, DesignGenerationRequestSchema } from "./design-generation";
import { DEFAULT_MAX_ROW_WIDTH, DEFAULT_MIN_CANVAS_GAP } from "../plugin/canvas-placement";
import { MAX_SECTION_BYTES, MAX_SECTION_NODES, utf8Bytes } from "./generation-limits";
import { VisualAssetCoverageSchema } from "./visual-composition";

const StableIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);
const ScreenIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u);

export const ChatGenerationIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    screenCount: z.number().int().min(1).max(10),
    target: z.enum(["mobile", "desktop"]),
    locale: z.enum(["fa-IR", "en-US"]),
  })
  .strict();
export type ChatGenerationIntent = z.infer<typeof ChatGenerationIntentSchema>;

export type MultiScreenNativeRoot = {
  screenId: string;
  nodeId: string;
  logicalRef: string;
};

const MultiScreenNativeRootSchema = z
  .object({
    screenId: ScreenIdSchema,
    nodeId: z.string().trim().min(1).max(100),
    logicalRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u),
  })
  .strict();

export function createChatScreenLogicalRef(generationId: string, screenId: string): string {
  return `screen-${fnv1a(`${generationId}:${screenId}`)}`;
}

export const MultiScreenProgressEventSchema = z
  .object({
    phase: z.enum([
      "planning",
      "screen-start",
      "section-start",
      "section-saved",
      "native-render",
      "screen-verified",
      "complete",
    ]),
    screenId: ScreenIdSchema.optional(),
    screenIndex: z.number().int().min(0).max(9).optional(),
    sectionId: z.enum(["identity", "primary", "supporting"]).optional(),
    nativeRoot: MultiScreenNativeRootSchema.optional(),
    completedScreens: z.number().int().min(0).max(10),
    completedSections: z.number().int().min(0).max(30),
    totalScreens: z.number().int().min(1).max(10),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.phase === "screen-verified" &&
      event.screenId &&
      event.nativeRoot?.screenId !== event.screenId
    )
      context.addIssue({
        code: "custom",
        path: ["nativeRoot"],
        message: "A verified screen event must include the matching native root identity.",
      });
  });
export type MultiScreenProgressEvent = z.infer<typeof MultiScreenProgressEventSchema>;

export const ChatGenerationLinkSchema = z
  .object({
    schemaVersion: z.literal(1),
    generationId: StableIdSchema,
    planFingerprint: z.string().regex(/^p12-[a-f0-9]{16}$/u),
    screenIds: z.array(ScreenIdSchema).min(1).max(10),
    completedScreenIds: z.array(ScreenIdSchema).max(10),
    nativeRoots: z.array(MultiScreenNativeRootSchema).max(10).default([]),
    completedSections: z.number().int().min(0).max(30),
    status: z.enum(["prepared", "running", "paused", "failed", "completed"]),
    currentScreenId: ScreenIdSchema.optional(),
    currentSectionId: z.enum(["identity", "primary", "supporting"]).optional(),
    errorCode: z
      .string()
      .regex(/^[a-z0-9_]{1,80}$/u)
      .optional(),
  })
  .strict()
  .superRefine((link, context) => {
    if (new Set(link.screenIds).size !== link.screenIds.length)
      context.addIssue({
        code: "custom",
        path: ["screenIds"],
        message: "Generation screen IDs must be unique.",
      });
    if (new Set(link.completedScreenIds).size !== link.completedScreenIds.length)
      context.addIssue({
        code: "custom",
        path: ["completedScreenIds"],
        message: "Completed screen IDs must be unique.",
      });
    if (link.completedScreenIds.some((id) => !link.screenIds.includes(id)))
      context.addIssue({
        code: "custom",
        path: ["completedScreenIds"],
        message: "Completed screens must belong to this generation.",
      });
    if (
      new Set(link.nativeRoots.map(({ screenId }) => screenId)).size !== link.nativeRoots.length ||
      link.nativeRoots.some(({ screenId }) => !link.screenIds.includes(screenId)) ||
      new Set(link.nativeRoots.map(({ logicalRef }) => logicalRef)).size !== link.nativeRoots.length
    )
      context.addIssue({
        code: "custom",
        path: ["nativeRoots"],
        message: "Native roots must be unique and belong to this generation.",
      });
    if (link.currentScreenId && !link.screenIds.includes(link.currentScreenId))
      context.addIssue({
        code: "custom",
        path: ["currentScreenId"],
        message: "Current screen does not belong to this generation.",
      });
  });
export type ChatGenerationLink = z.infer<typeof ChatGenerationLinkSchema>;

export const MultiScreenGenerationOutcomeSchema = z
  .object({
    generationId: StableIdSchema,
    screenIds: z.array(ScreenIdSchema).min(1).max(10),
    verifiedScreenIds: z.array(ScreenIdSchema).min(1).max(10),
    nativeRoots: z.array(MultiScreenNativeRootSchema).max(10).optional(),
    nodeCount: z.number().int().nonnegative().max(100_000),
    assetCoverage: VisualAssetCoverageSchema.optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (
      new Set(outcome.screenIds).size !== outcome.screenIds.length ||
      new Set(outcome.verifiedScreenIds).size !== outcome.verifiedScreenIds.length ||
      outcome.screenIds.length !== outcome.verifiedScreenIds.length ||
      outcome.screenIds.some((id) => !outcome.verifiedScreenIds.includes(id))
    )
      context.addIssue({
        code: "custom",
        path: ["verifiedScreenIds"],
        message: "Every planned screen needs one native verification result.",
      });
    if (
      outcome.nativeRoots !== undefined &&
      (outcome.nativeRoots.length !== outcome.screenIds.length ||
        outcome.screenIds.some(
          (id) => !outcome.nativeRoots!.some((root) => root.screenId === id),
        ) ||
        new Set(outcome.nativeRoots.map(({ screenId }) => screenId)).size !==
          outcome.nativeRoots.length ||
        new Set(outcome.nativeRoots.map(({ nodeId }) => nodeId)).size !==
          outcome.nativeRoots.length ||
        new Set(outcome.nativeRoots.map(({ logicalRef }) => logicalRef)).size !==
          outcome.nativeRoots.length)
    )
      context.addIssue({
        code: "custom",
        path: ["nativeRoots"],
        message: "Every planned screen needs one unique, task-addressable native root.",
      });
  });
export type MultiScreenGenerationOutcome = z.infer<typeof MultiScreenGenerationOutcomeSchema>;

const GenerationSectionSchema = z.enum(["identity", "primary", "supporting"]);

export const MultiScreenPlanScreenSchema = z
  .object({
    id: ScreenIdSchema,
    name: z.string().trim().min(1).max(100),
    order: z.number().int().min(0).max(9),
    purpose: z.string().trim().min(1).max(240),
    priority: z.number().int().min(1).max(10),
    navigationTargets: z.array(ScreenIdSchema).max(8),
    requiredSections: z.array(GenerationSectionSchema).length(3),
    contentPlaceholders: z.array(z.string().trim().min(1).max(120)).max(8),
    dependencies: z.array(ScreenIdSchema).max(8),
    componentOpportunities: z.array(z.string().trim().min(1).max(100)).max(8),
    componentReferences: z.array(z.string().trim().min(1).max(100)).max(8),
    width: z.number().int().positive().max(1_440),
    height: z.number().int().positive().max(900),
  })
  .strict();

const MultiScreenVisualContextSchema = z
  .object({
    appDomain: z.string().trim().min(1).max(80),
    tone: z.string().trim().min(1).max(160),
    audience: z.string().trim().min(1).max(120),
    hierarchy: z.string().trim().min(1).max(200),
    typography: z
      .object({
        family: z.string().trim().min(1).max(80),
        style: z.string().trim().min(1).max(80),
        headingSize: z.number().min(16).max(96),
        bodySize: z.number().min(12).max(32),
      })
      .strict(),
    spacingScale: z.array(z.number().finite().min(0).max(128)).min(2).max(8),
    radiusScale: z.array(z.number().finite().min(0).max(128)).min(2).max(6),
    sharedContent: z.array(z.string().trim().min(1).max(120)).min(1).max(16),
    palette: z
      .object({
        source: z.enum(["user-requested", "curated-default", "brand-kit"]),
        background: z.string().trim().min(1).max(100),
        surface: z.string().trim().min(1).max(100),
        primary: z.string().trim().min(1).max(100),
        accent: z.string().trim().min(1).max(100),
        text: z.string().trim().min(1).max(100),
        muted: z.string().trim().min(1).max(100),
      })
      .strict(),
    imagePolicy: z.enum(["authorized-assets-only", "labeled-native-fallback"]),
    interactionPriorities: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
    requiredPatterns: z.array(z.string().trim().min(1).max(80)).max(18),
    direction: z.enum(["rtl", "ltr"]),
  })
  .strict();

export const MultiScreenDesignRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: StableIdSchema,
    generationId: StableIdSchema,
    documentId: StableIdSchema,
    model: ModelIdSchema,
    request: DesignGenerationRequestSchema,
    locale: z.enum(["fa-IR", "en-US"]),
    direction: z.enum(["rtl", "ltr"]),
    visualContext: MultiScreenVisualContextSchema,
    screens: z.array(MultiScreenPlanScreenSchema).min(1).max(10),
    planFingerprint: z.string().regex(/^p12-[a-f0-9]{16}$/u),
    componentReusePreference: z.enum(["prefer-shared", "screen-specific"]),
    designSystemReference: z
      .object({
        brandKitId: z.string().min(1).max(100).optional(),
        brandKitRevision: z.number().int().positive().max(1_000_000).optional(),
        skills: z
          .array(
            z
              .object({
                id: z.string().min(1).max(100),
                revision: z.number().int().positive().max(100_000),
                revisionId: z.string().min(10).max(120),
              })
              .strict(),
          )
          .max(3),
      })
      .strict(),
    brandKit: PinnedBrandKitSchema.optional(),
    designSkills: PinnedDesignSkillsSchema.optional(),
    assetPolicy: z.enum(["brand-kit-only", "native-placeholders-only"]),
    placement: z
      .object({
        gap: z.literal(DEFAULT_MIN_CANVAS_GAP),
        maxRowWidth: z.literal(DEFAULT_MAX_ROW_WIDTH),
        preserveExistingRoots: z.literal(true),
      })
      .strict(),
    limits: z
      .object({
        screens: z.literal(10),
        sectionsPerScreen: z.literal(3),
        sectionBytes: z.literal(MAX_SECTION_BYTES),
        sectionNodes: z.literal(MAX_SECTION_NODES),
        responseBytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (utf8Bytes(JSON.stringify(request)) > 256 * 1024)
      context.addIssue({
        code: "custom",
        path: [],
        message: "The multi-screen request exceeds its 256 KiB payload limit.",
      });
    if (request.request.target === "both")
      context.addIssue({
        code: "custom",
        path: ["request", "target"],
        message:
          "This handoff supports one device family per task; mobile and desktop are separate Phase 12 tasks.",
      });
    const targetScreens = request.screens.length;
    if (targetScreens !== request.request.screenCount || request.screens.length > 10) {
      context.addIssue({
        code: "custom",
        path: ["screens"],
        message: "The saved screen plan must match the requested 1–10 screen count.",
      });
    }
    if (
      request.request.screenCount > 10 ||
      request.request.prompt.length > 12_000 ||
      request.request.screenNames?.length !== request.request.screenCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "The generation request exceeds its bounded screen or prompt contract.",
      });
    }
    const ids = request.screens.map(({ id }) => id);
    const names = request.screens.map(({ name }) => name.toLocaleLowerCase());
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["screens"],
        message: "Screen IDs must be unique.",
      });
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        path: ["screens"],
        message: "Screen names must be unique.",
      });
    const idSet = new Set(ids);
    for (const [index, screen] of request.screens.entries()) {
      const expectedWidth = screen.width === 390 ? 390 : 1_440;
      const expectedHeight = screen.width === 390 ? 844 : 900;
      if (
        screen.order !== index ||
        screen.width !== expectedWidth ||
        screen.height !== expectedHeight ||
        screen.requiredSections.join(",") !== "identity,primary,supporting"
      ) {
        context.addIssue({
          code: "custom",
          path: ["screens", index],
          message: "Screen order, viewport, or ordered generation sections are invalid.",
        });
      }
      if (screen.componentReferences.length)
        context.addIssue({
          code: "custom",
          path: ["screens", index, "componentReferences"],
          message:
            "Native component references require an explicit supported component manifest; no such references are authorized for this task.",
        });
      for (const reference of [...screen.navigationTargets, ...screen.dependencies]) {
        if (!idSet.has(reference) || reference === screen.id) {
          context.addIssue({
            code: "custom",
            path: ["screens", index],
            message: "A screen dependency or navigation target is unknown or self-referential.",
          });
        }
      }
    }
    const state = new Map<string, "visiting" | "visited">();
    const byId = new Map(request.screens.map((screen) => [screen.id, screen]));
    const visit = (id: string): boolean => {
      const current = state.get(id);
      if (current === "visiting") return false;
      if (current === "visited") return true;
      state.set(id, "visiting");
      for (const dependency of byId.get(id)?.dependencies ?? [])
        if (!visit(dependency)) return false;
      state.set(id, "visited");
      return true;
    };
    if (request.screens.some(({ id }) => !visit(id)))
      context.addIssue({
        code: "custom",
        path: ["screens"],
        message: "Screen dependency relationships must be acyclic.",
      });
    const expectedDirection = request.locale === "fa-IR" ? "rtl" : "ltr";
    if (
      request.direction !== expectedDirection ||
      request.visualContext.direction !== expectedDirection
    )
      context.addIssue({
        code: "custom",
        path: ["direction"],
        message: "Locale and reading direction do not match.",
      });
    const expectedSkills = (request.designSkills ?? []).map(({ id, revision, revisionId }) => ({
      id,
      revision,
      revisionId,
    }));
    if (
      request.designSystemReference.brandKitId !== request.brandKit?.id ||
      request.designSystemReference.brandKitRevision !== request.brandKit?.revision ||
      JSON.stringify(request.designSystemReference.skills) !== JSON.stringify(expectedSkills)
    )
      context.addIssue({
        code: "custom",
        path: ["designSystemReference"],
        message: "Pinned Brand Kit or Skills references do not match the captured revisions.",
      });
  });

export type MultiScreenDesignRequest = z.infer<typeof MultiScreenDesignRequestSchema>;

export type ChatPlanScreenInput = {
  title: string;
  goal: string;
  purpose?: string;
  priority?: number;
  navigation?: string[];
  dependsOn?: string[];
  contentPlaceholders?: string[];
  componentOpportunities?: string[];
};

export type ChatGenerationPlanInput = {
  taskId: string;
  generationId: string;
  documentId: string;
  model: string;
  prompt: string;
  intent: ChatGenerationIntent;
  brief: {
    platform: "mobile" | "desktop" | "responsive" | "web";
    viewport: { width: number; height: number };
    brandDirection: string;
    audience: string;
    content: string[];
    hierarchy: string;
    typography: { family: string; style: string; headingSize: number; bodySize: number };
    spacingScale: number[];
    radiusScale: number[];
    readingDirection: "LTR" | "RTL";
    palette: {
      source: "existing-document" | "user-requested" | "curated-default" | "brand-kit";
      background: string;
      surface: string;
      primary: string;
      accent: string;
      text: string;
      muted: string;
    };
    imagePolicy: "authorized-assets-only" | "labeled-native-fallback";
    interactionPriorities: string[];
    requiredPatterns?: string[];
  };
  stages: ChatPlanScreenInput[];
  brandKit?: PinnedBrandKit;
  designSkills?: PinnedDesignSkill[];
};

export type MultiScreenRequestResult =
  { success: true; data: MultiScreenDesignRequest } | { success: false; errors: string[] };

function fnv1a(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code;
    second = Math.imul(second, 0x85ebca6b);
  }
  return [first, second].map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("");
}

function orderedFingerprint(value: unknown): string {
  return `p12-${fnv1a(JSON.stringify(value))}`;
}

export function multiScreenPlanFingerprint(request: MultiScreenDesignRequest): string {
  const core = Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== "planFingerprint"),
  );
  return orderedFingerprint(core);
}

function screenReferences(
  values: string[] | undefined,
  names: Map<string, string>,
  label: string,
): string[] {
  const refs: string[] = [];
  for (const value of values ?? []) {
    const id = names.get(value.trim().toLocaleLowerCase());
    if (!id) throw new Error(`${label} “${value}” does not match a planned screen name.`);
    refs.push(id);
  }
  if (new Set(refs).size !== refs.length)
    throw new Error(`${label} contains duplicate screen references.`);
  return refs;
}

export function createMultiScreenDesignRequest(
  input: ChatGenerationPlanInput,
): MultiScreenRequestResult {
  if (input.stages.length !== input.intent.screenCount) {
    return {
      success: false,
      errors: [
        `The Chat plan contains ${input.stages.length} screens, but ${input.intent.screenCount} were requested. No generation was started; retry with a clearer screen count.`,
      ],
    };
  }
  if (
    input.brief.platform !== input.intent.target &&
    input.brief.platform !== "responsive" &&
    !(input.intent.target === "desktop" && input.brief.platform === "web")
  ) {
    return {
      success: false,
      errors: [
        "The Chat plan target does not match the requested device. No generation was started.",
      ],
    };
  }
  const expectedViewport =
    input.intent.target === "mobile" ? { width: 390, height: 844 } : { width: 1_440, height: 900 };
  if (
    input.brief.viewport.width !== expectedViewport.width ||
    input.brief.viewport.height !== expectedViewport.height
  ) {
    return {
      success: false,
      errors: [
        `The current generation renderer requires ${expectedViewport.width}×${expectedViewport.height} ${input.intent.target} roots. No native changes were made.`,
      ],
    };
  }
  const language = input.intent.locale === "fa-IR" ? "fa" : "en";
  const direction = language === "fa" ? "rtl" : "ltr";
  if (input.brief.readingDirection.toLowerCase() !== direction) {
    return {
      success: false,
      errors: [
        "The planned reading direction does not match the request locale. No generation was started.",
      ],
    };
  }
  if (input.brief.palette.source === "existing-document") {
    return {
      success: false,
      errors: [
        "This Chat handoff has no authorized existing-document context. Choose the pinned Brand Kit or a brief-defined palette.",
      ],
    };
  }
  const screenNames = input.stages.map(({ title }) => title.trim());
  if (screenNames.some((name) => !name))
    return {
      success: false,
      errors: ["Every planned screen needs a name before generation can start."],
    };
  const generationRequest = DesignGenerationRequestSchema.safeParse({
    prompt: input.prompt.trim(),
    target: input.intent.target,
    screenCount: input.intent.screenCount,
    screenNames,
    language,
    style: input.brief.brandDirection,
    projectType: "auto",
    theme: "auto",
  });
  if (!generationRequest.success)
    return {
      success: false,
      errors: generationRequest.error.issues.slice(0, 8).map(({ message }) => message),
    };
  const plan = createDesignPlan(generationRequest.data, input.brandKit, input.designSkills);
  if (!plan.success) return { success: false, errors: plan.errors };
  const idByName = new Map(
    plan.data.screens.map((screen) => [screen.familyName.toLocaleLowerCase(), screen.id]),
  );
  const planScreens: MultiScreenDesignRequest["screens"] = [];
  try {
    plan.data.screens.forEach((screen, index) => {
      const stage = input.stages[index]!;
      planScreens.push({
        id: screen.id,
        name: screen.familyName,
        order: index,
        purpose: (stage.purpose ?? stage.goal).trim().slice(0, 240),
        priority: stage.priority ?? index + 1,
        navigationTargets: screenReferences(stage.navigation, idByName, "Navigation target"),
        requiredSections: ["identity", "primary", "supporting"],
        contentPlaceholders: (stage.contentPlaceholders ?? input.brief.content).slice(0, 8),
        dependencies: screenReferences(stage.dependsOn, idByName, "Dependency"),
        componentOpportunities: (stage.componentOpportunities ?? []).slice(0, 8),
        componentReferences: [],
        width: screen.width,
        height: screen.height,
      });
    });
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : "The screen plan has invalid references."],
    };
  }
  const screenContext = planScreens
    .map(
      (screen) =>
        `${screen.order + 1}. ${screen.name}: ${screen.purpose}; content: ${screen.contentPlaceholders.join(", ")}`,
    )
    .join("\n");
  const generationPrompt = [
    input.prompt.trim(),
    `Shared design direction: ${input.brief.brandDirection}. Audience: ${input.brief.audience}.`,
    `Hierarchy: ${input.brief.hierarchy}. Typography: ${input.brief.typography.family}, ${input.brief.typography.style}, heading ${input.brief.typography.headingSize}px, body ${input.brief.typography.bodySize}px.`,
    `Spacing scale: ${input.brief.spacingScale.join(", ")}px. Radius scale: ${input.brief.radiusScale.join(", ")}px. Reading direction: ${direction}.`,
    `Semantic palette: background ${input.brief.palette.background}; surface ${input.brief.palette.surface}; primary ${input.brief.palette.primary}; accent ${input.brief.palette.accent}; text ${input.brief.palette.text}; muted ${input.brief.palette.muted}.`,
    `Ordered screen plan:\n${screenContext}`,
  ].join("\n\n");
  if (generationPrompt.length > 12_000) {
    return {
      success: false,
      errors: [
        "The planned design context exceeds the 12,000-character generation limit. Shorten the brief and retry.",
      ],
    };
  }
  const request = DesignGenerationRequestSchema.safeParse({
    ...generationRequest.data,
    prompt: generationPrompt,
  });
  if (!request.success)
    return {
      success: false,
      errors: request.error.issues.slice(0, 8).map(({ message }) => message),
    };
  const core = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    generationId: input.generationId,
    documentId: input.documentId,
    model: input.model,
    request: request.data,
    locale: input.intent.locale,
    direction,
    visualContext: {
      appDomain: plan.data.domain,
      tone: input.brief.brandDirection,
      audience: input.brief.audience,
      hierarchy: input.brief.hierarchy,
      typography: input.brief.typography,
      spacingScale: input.brief.spacingScale,
      radiusScale: input.brief.radiusScale,
      sharedContent: input.brief.content,
      palette: input.brief.palette,
      imagePolicy: input.brief.imagePolicy,
      interactionPriorities: input.brief.interactionPriorities,
      requiredPatterns: input.brief.requiredPatterns ?? [],
      direction,
    },
    screens: planScreens,
    componentReusePreference: "prefer-shared" as const,
    designSystemReference: {
      ...(input.brandKit
        ? { brandKitId: input.brandKit.id, brandKitRevision: input.brandKit.revision }
        : {}),
      skills: (input.designSkills ?? []).map(({ id, revision, revisionId }) => ({
        id,
        revision,
        revisionId,
      })),
    },
    brandKit: input.brandKit,
    designSkills: input.designSkills,
    assetPolicy: input.brandKit
      ? ("brand-kit-only" as const)
      : ("native-placeholders-only" as const),
    placement: {
      gap: DEFAULT_MIN_CANVAS_GAP,
      maxRowWidth: DEFAULT_MAX_ROW_WIDTH,
      preserveExistingRoots: true as const,
    },
    limits: {
      screens: 10 as const,
      sectionsPerScreen: 3 as const,
      sectionBytes: MAX_SECTION_BYTES,
      sectionNodes: MAX_SECTION_NODES,
      responseBytes: MAX_SECTION_BYTES,
    },
  };
  const fingerprint = orderedFingerprint(core);
  const parsed = MultiScreenDesignRequestSchema.safeParse({
    ...core,
    planFingerprint: fingerprint,
  });
  if (!parsed.success)
    return {
      success: false,
      errors: parsed.error.issues.slice(0, 8).map(({ message }) => message),
    };
  return { success: true, data: parsed.data };
}

const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
const countWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  یک: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
};

function asciiDigits(value: string): string {
  return [...value]
    .map((digit) => {
      const persian = persianDigits.indexOf(digit);
      if (persian >= 0) return String(persian);
      const arabic = arabicDigits.indexOf(digit);
      return arabic >= 0 ? String(arabic) : digit;
    })
    .join("");
}

export type ParsedChatGenerationIntent =
  | { kind: "not_a_handoff" }
  | { kind: "ready"; intent: ChatGenerationIntent }
  | { kind: "out_of_range"; screenCount: number }
  | { kind: "unsupported_target" };

const CREATE_VERB =
  /(?:\b(?:create|design|build|make|generate)\b|(?:طراحی|بساز|ایجاد|طراحى|بسازید))/iu;
const TOP_LEVEL_EDIT =
  /^(?:please\s+)?(?:edit|change|update|modify|fix|restyle)\b|^(?:لطفا[ً\s‌-]*)?(?:(?:صفحه|اسکرین)(?:\s+\d+)?\s*(?:را|رو)?\s*)?(?:ویرایش|تغییر|اصلاح|بهبود)(?:\s+کن|\s+بده|\s+بدید)?/iu;
const EXISTING_EDIT_COMMAND =
  /\b(?:edit|change|update|modify|fix|restyle)\s+(?:(?:the|existing|current|selected)\s+)?(?:screen|page|frame|canvas|design)\b|\b(?:edit|change|update|modify)\s+(?:screen|page)\s+\d+\b|(?:صفحه|اسکرین)(?:\s+\d+)?\s*(?:را|رو)\s*(?:ویرایش|تغییر|اصلاح|بهبود)(?:\s+کن|\s+بده|\s+بدید)|(?:ویرایش|تغییر|اصلاح|بهبود)\s*(?:صفحه|اسکرین)(?:\s+\d+)?/iu;

const ROMANIZED_CREATE = /^(?:lotfan\s+)?([0-9۰-۹٠-٩]+)\s+(?:safheh?|screens?)\b[^.!?؟\n]{0,160}\b(?:besaz(?:id)?|tarahi\s+kon(?:id)?)[.!]?$/iu;
const ROMANIZED_EDIT = /^(?:lotfan\s+)?safhe(?:h|ye)?\s+[0-9۰-۹٠-٩]+\s+(?:ro|ra)\s+(?:virayesh|eslah|taghir)\s+kon(?:id)?[.!]?$/iu;

export function isClearCreateRequest(prompt: string): boolean {
  const normalized = prompt.trim().toLocaleLowerCase();
  if (ROMANIZED_CREATE.test(normalized)) return true;
  return Boolean(
    normalized &&
      CREATE_VERB.test(normalized) &&
      !TOP_LEVEL_EDIT.test(normalized) &&
      !EXISTING_EDIT_COMMAND.test(normalized),
  );
}

const CANVAS_TARGET = /\b(?:screens?|pages?|views?|frames?|layers?|nodes?|components?|dashboards?|interfaces?|mockups?|wireframes?|layouts?|canvas|figma|designs?|prototypes?|buttons?|cards?|sign[- ]?up|log[- ]?in)\b|صفحه|اسکرین|فریم|لایه|داشبورد|رابط کاربری|بوم|فیگما|وایرفریم|کامپوننت|دکمه/iu;
const ENGLISH_CANVAS_COMMAND = /(?:^|[,.!?:;]\s*)(?:(?:please|kindly)\s+|(?:can|could|would|will) you\s+|i (?:need|want) you to\s+)*(?:create|design|build|make|generate|edit|change|update|modify|fix|restyle|inspect|audit|continue|find|remove|move|resize|align|set|add)\b/iu;
const PERSIAN_CANVAS_COMMAND = /بساز|(?:طراحی|ایجاد|ویرایش|تغییر|اصلاح|بهبود|بررسی|ادامه|پیدا|حذف|اضافه|جابه‌جا)\s*(?:کن|بده|بدید|ده)/u;
const ADVICE_REQUEST = /\b(?:how (?:do|can|should|would) (?:i|we)|how to|what (?:is|are)|why|can you (?:teach|explain how))\b|چطور|چگونه|چیست/iu;

export function isExplicitCanvasRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (ROMANIZED_CREATE.test(trimmed) || ROMANIZED_EDIT.test(trimmed)) return true;
  return CANVAS_TARGET.test(prompt) && !ADVICE_REQUEST.test(prompt) &&
    (ENGLISH_CANVAS_COMMAND.test(trimmed) || PERSIAN_CANVAS_COMMAND.test(prompt));
}

export function greetingReply(prompt: string): string | undefined {
  const greeting = prompt.trim().replace(/[\s.!؟?!،,]+$/gu, "");
  if (/^(?:hi|hello|hey)$/iu.test(greeting)) return "Hi! How can I help?";
  if (/^(?:سلام|درود|salam)$/iu.test(greeting)) return "سلام! چطور می‌تونم کمک کنم؟";
  return undefined;
}

export function requestedDesignContext(prompt: string, intent: "create" | "edit") {
  if (!isExplicitCanvasRequest(prompt) || (intent === "create" && !isClearCreateRequest(prompt)) ||
    (intent === "edit" && isClearCreateRequest(prompt))) return;
  const selected = intent === "edit"
    ? /\b(?:selection|selected (?:screens?|frames?|layers?|nodes?|subtree|components?|elements?))\b|انتخاب‌شده|انتخاب شده|محدودهٔ انتخاب/iu.test(prompt)
    : /\b(?:use|reuse|read|inspect|match|using|based on|follow)\b[^.!?\r\n]{0,70}\b(?:selection|selected (?:screens?|frames?|layers?|nodes?|subtree|components?|elements?))\b|از\s+(?:سبک\s+|طراحی\s+|محدوده[ٔ‌ی ]+\s*)?(?:انتخاب|فریم انتخاب‌شده)[^.!؟\r\n]{0,100}(?:استفاده|پیروی|الگو)/iu.test(prompt);
  const page = intent === "create" && /\b(?:use|reuse|read|inspect|match|using|based on|follow)\b[^.!?\r\n]{0,70}\b(?:current|this) page\b|از\s+(?:سبک\s+|طراحی\s+)?صفحه[ٔ‌ی ]+(?:فعلی|کنونی)[^.!؟\r\n]{0,100}(?:استفاده|پیروی|الگو)/iu.test(prompt);
  if ((!selected && !page) ||
    /\b(?:ignore|without|don't use|do not use)\s+(?:the\s+)?(?:selection|current page|selected)\b/iu.test(prompt)) return;
  return {
    scope: selected ? /\bselected subtree\b/iu.test(prompt) ? "selected-subtree" as const : "selection" as const : "page" as const,
    reuse: intent === "create" && /\breuse\b|استفاده[ٔ‌ی ]+مجدد|بازاستفاده/iu.test(prompt) &&
      !/\b(?:not|never|no|don't|without)\s+(?:\w+\s+){0,2}reuse\b|استفاده[ٔ‌ی ]+مجدد\s+نکن|بازاستفاده\s+نکن/iu.test(prompt),
    catalog: !selected && page && /\b(?:include|read|use)\s+(?:the\s+)?(?:file-local|file local|file's local)\s+(?:design system|styles|variables|tokens)\b|منابع طراحی محلی فایل/iu.test(prompt),
  };
}

export function parseChatGenerationIntent(prompt: string): ParsedChatGenerationIntent {
  const normalized = prompt.trim().toLocaleLowerCase();
  const romanizedCount = ROMANIZED_CREATE.exec(normalized)?.[1];
  if (!isClearCreateRequest(normalized)) return { kind: "not_a_handoff" };
  const screenTerm =
    /(?:\b(?:screens?|pages?|views?)\b|(?:صفحه(?:‌ها|ها|ی|های)?|اسکرین(?:‌ها|ها)?))/iu;
  if (!romanizedCount && !screenTerm.test(normalized)) return { kind: "not_a_handoff" };
  const screenAdjective =
    /(?:(?:new|editable|mobile|desktop|web|phone|responsive|جدید|قابل‌ویرایش|موبایل|دسکتاپ)\s+){0,3}/iu;
  const screenNoun =
    /(?:(?:screens?|pages?|views?)\b|صفحه(?:‌ها|ها|ی|های)?|اسکرین(?:‌ها|ها)?)/iu;
  const numericMatch = new RegExp(
    `(?<![0-9۰-۹٠-٩])([0-9۰-۹٠-٩]+)\\s*${screenAdjective.source}${screenNoun.source}`,
    "iu",
  ).exec(normalized);
  const englishWordMatch = new RegExp(
    `\\b(one|two|three|four|five|six|seven|eight|nine|ten)\\b\\s*${screenAdjective.source}${screenNoun.source}`,
    "iu",
  ).exec(normalized);
  const persianWordMatch =
    /(یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)\s*(?:صفحه|اسکرین)/iu.exec(normalized);
  const rawCount = romanizedCount ?? numericMatch?.[1];
  const word = englishWordMatch?.[1] ?? persianWordMatch?.[1];
  const count = rawCount ? Number(asciiDigits(rawCount)) : word ? countWords[word] : undefined;
  if (count === undefined) return { kind: "not_a_handoff" };
  if (count < 1 || count > 10) return { kind: "out_of_range", screenCount: count };
  if (
    /\bresponsive\b|\b(?:both\s+)?mobile\s*(?:and|\+)\s*desktop\b|موبایل\s*(?:و|\+)\s*دسکتاپ/iu.test(
      normalized,
    )
  )
    return { kind: "unsupported_target" };
  const isPersian = Boolean(romanizedCount) || /[\u0600-\u06ff]/u.test(normalized);
  return {
    kind: "ready",
    intent: {
      schemaVersion: 1,
      screenCount: count,
      target: /\b(?:desktop|laptop|web)\b|دسکتاپ/iu.test(normalized) ? "desktop" : "mobile",
      locale: isPersian ? "fa-IR" : "en-US",
    },
  };
}
