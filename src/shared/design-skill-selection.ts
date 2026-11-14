import {
  DESIGN_SKILL_MAX_PINNED,
  DesignSkillRevisionSchema,
  pinDesignSkill,
  type DesignSkillRevision,
  type PinnedDesignSkill,
} from "./design-skill.js";
import type { DesignDomain } from "./visual-design-spec.js";

export type SkillSelectionTask =
  "chat-planning" | "new-design" | "existing-screen-edit" | "multi-screen";
export type SkillSelectionLocale = "fa" | "en";
export type SkillSelectionScreen = "mobile" | "desktop" | "responsive";

export type SkillSelectionResult = {
  skills: PinnedDesignSkill[];
  explanation: string[];
  conflicts: string[];
};

function key(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function explicitSkillNames(prompt: string): string[] {
  return [...prompt.matchAll(/(?:use\s+skill|استفاده\s+از\s+مهارت)\s*:\s*([^\n;؛.]+)/giu)]
    .flatMap((match) => match[1]!.split(","))
    .map((value) => value.trim().replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/gu, ""))
    .filter(Boolean)
    .slice(0, DESIGN_SKILL_MAX_PINNED + 1);
}

function supports(
  skill: DesignSkillRevision,
  task: SkillSelectionTask,
  locale: SkillSelectionLocale,
  screen: SkillSelectionScreen,
): boolean {
  const taskMatches =
    skill.supportedTasks.includes(task) ||
    (task === "chat-planning" && skill.supportedTasks.includes("new-design")) ||
    (task === "multi-screen" && skill.supportedTasks.includes("new-design"));
  const localeMatches = skill.locale === "multi" || skill.locale === locale;
  const screenMatches =
    skill.screenTypes.includes("all") ||
    skill.screenTypes.includes(screen) ||
    (screen === "responsive" &&
      skill.screenTypes.includes("mobile") &&
      skill.screenTypes.includes("desktop"));
  return taskMatches && localeMatches && screenMatches;
}

export function selectDesignSkills(input: {
  skills: readonly DesignSkillRevision[];
  enabledIds: readonly string[];
  defaultIds: readonly string[];
  prompt: string;
  domain: DesignDomain;
  task: SkillSelectionTask;
  locale: SkillSelectionLocale;
  screen: SkillSelectionScreen;
}): SkillSelectionResult {
  const enabled = new Set(input.enabledIds);
  const candidates = input.skills
    .map((raw) => DesignSkillRevisionSchema.safeParse(raw))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((skill) => enabled.has(skill.id));
  const explicitRequests = explicitSkillNames(input.prompt).map(key);
  const requestedExplicit = candidates.filter((skill) =>
    explicitRequests.some((request) => request === key(skill.id) || request === key(skill.name)),
  );
  const explicit = requestedExplicit.filter((skill) =>
    supports(skill, input.task, input.locale, input.screen),
  );
  const unknownExplicit = explicitRequests.filter(
    (request) =>
      !explicit.some((skill) => request === key(skill.id) || request === key(skill.name)),
  );
  const conflicts: string[] = unknownExplicit.map((request) => {
    const unavailable = !candidates.some(
      (skill) => request === key(skill.id) || request === key(skill.name),
    );
    return unavailable
      ? `Requested Skill “${request}” is not enabled or available.`
      : `Requested Skill “${request}” does not support this task, language, or screen type.`;
  });
  const defaults = candidates.filter(
    (skill) =>
      input.defaultIds.includes(skill.id) &&
      supports(skill, input.task, input.locale, input.screen) &&
      (skill.domains.includes("general") || skill.domains.includes(input.domain)),
  );
  const ranked = candidates
    .filter(
      (skill) =>
        !defaults.some(({ id }) => id === skill.id) && !explicit.some(({ id }) => id === skill.id),
    )
    .filter((skill) => supports(skill, input.task, input.locale, input.screen))
    .map((skill) => {
      const domainMatch = skill.domains.includes(input.domain) || skill.domains.includes("general");
      const taskMatch = skill.supportedTasks.includes(input.task);
      const localeMatch = skill.locale === input.locale;
      const screenMatch = skill.screenTypes.includes(input.screen);
      const score =
        Number(domainMatch) * 8 +
        Number(taskMatch) * 4 +
        Number(localeMatch) * 2 +
        Number(screenMatch) +
        skill.priority;
      return { skill, score, domainMatch };
    })
    .filter(({ domainMatch }) => domainMatch)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const suggested =
    defaults.length || explicit.length ? [] : ranked.slice(0, 2).map(({ skill }) => skill);
  const selected = new Map<
    string,
    { skill: DesignSkillRevision; reason: PinnedDesignSkill["selectionReason"] }
  >();
  for (const skill of explicit) selected.set(skill.id, { skill, reason: "explicit" });
  for (const skill of defaults)
    if (!selected.has(skill.id)) selected.set(skill.id, { skill, reason: "default" });
  for (const skill of suggested)
    if (!selected.has(skill.id)) selected.set(skill.id, { skill, reason: "domain-suggestion" });

  const ordered = [...selected.values()].sort((a, b) => {
    const rank = (reason: PinnedDesignSkill["selectionReason"]) =>
      reason === "explicit" ? 0 : reason === "default" ? 1 : 2;
    return (
      rank(a.reason) - rank(b.reason) ||
      b.skill.priority - a.skill.priority ||
      a.skill.id.localeCompare(b.skill.id)
    );
  });
  if (ordered.length > DESIGN_SKILL_MAX_PINNED)
    conflicts.push(
      `Selected ${ordered.length} Skills; choose no more than ${DESIGN_SKILL_MAX_PINNED} for one task.`,
    );

  const seenGroups = new Map<string, string>();
  for (const { skill } of ordered.slice(0, DESIGN_SKILL_MAX_PINNED)) {
    for (const group of skill.incompatibilityGroups) {
      const prior = seenGroups.get(group);
      if (prior)
        conflicts.push(
          `Skills “${prior}” and “${skill.name}” conflict in group “${group}”; adjust the selection before starting.`,
        );
      else seenGroups.set(group, skill.name);
    }
  }

  let pins: PinnedDesignSkill[] = [];
  try {
    pins = ordered
      .slice(0, DESIGN_SKILL_MAX_PINNED)
      .map(({ skill, reason }) => pinDesignSkill(skill, reason));
  } catch (error) {
    conflicts.push(
      error instanceof Error ? error.message : "Selected Skill snapshots exceed the task budget.",
    );
  }
  const explanation = pins.map(
    (skill) =>
      `${skill.name} · ${skill.revisionId} (${skill.selectionReason.replaceAll("-", " ")})`,
  );
  return { skills: conflicts.length ? [] : pins, explanation, conflicts };
}
