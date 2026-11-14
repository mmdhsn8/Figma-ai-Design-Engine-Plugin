import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  DESIGN_SKILL_MAX_BODY_BYTES,
  DESIGN_SKILL_MAX_PINNED,
  DESIGN_SKILL_STORAGE_BUDGET_BYTES,
  DESIGN_SKILL_PATTERN_IDS,
  DesignSkillBundleSchema,
  DesignSkillRevisionSchema,
  parseSkillMarkdown,
  skillContentHash,
  type DesignSkillRevision,
  type DesignSkillStoreSnapshot,
} from "../shared/design-skill";
import type { PluginView } from "./workspace-routes";
import { designSkillsRequest } from "./design-skills-bridge";

type SkillDraft = {
  id: string;
  name: string;
  description: string;
  category: DesignSkillRevision["category"];
  domains: DesignSkillRevision["domains"];
  supportedTasks: DesignSkillRevision["supportedTasks"];
  screenTypes: DesignSkillRevision["screenTypes"];
  locale: DesignSkillRevision["locale"];
  version: string;
  tags: string[];
  priority: number;
  incompatibilityGroups: string[];
  requiredPatterns: DesignSkillRevision["requiredPatterns"];
  source: DesignSkillRevision["source"];
  trust: DesignSkillRevision["trust"];
  createdAt: number;
  sourceMarkdown: string;
  expectedRevision: number | null;
};

const categories: DesignSkillRevision["category"][] = [
  "general",
  "commerce",
  "dashboard",
  "saas",
  "education",
  "accessibility",
  "typography",
  "layout",
  "forms",
  "content",
];
const domains: DesignSkillRevision["domains"] = [
  "general",
  "commerce",
  "dashboard",
  "saas",
  "education",
  "onboarding",
  "productivity",
  "finance",
  "health",
  "social",
  "portfolio",
  "travel",
  "media",
  "content",
  "product",
];
const supportedTaskOptions: Array<{
  id: DesignSkillRevision["supportedTasks"][number];
  label: string;
}> = [
  { id: "chat-planning", label: "Chat planning" },
  { id: "new-design", label: "New designs" },
  { id: "existing-screen-edit", label: "Existing screen edits" },
  { id: "multi-screen", label: "Multi-screen projects" },
];
const screenOptions: DesignSkillRevision["screenTypes"][number][] = [
  "mobile",
  "desktop",
  "responsive",
  "all",
];
const emptyMarkdown = "# My design skill\n\nDescribe the design guidance here.\n";

function idForNewSkill(): string {
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`.slice(0, 80);
}

function blankDraft(): SkillDraft {
  const now = Date.now();
  return {
    id: idForNewSkill(),
    name: "",
    description: "",
    category: "general",
    domains: ["general"],
    supportedTasks: ["new-design"],
    screenTypes: ["all"],
    locale: "multi",
    version: "1.0.0",
    tags: [],
    priority: 0,
    incompatibilityGroups: [],
    requiredPatterns: [],
    source: "user-authored",
    trust: "first-party",
    createdAt: now,
    sourceMarkdown: emptyMarkdown,
    expectedRevision: null,
  };
}

function draftFromSkill(skill: DesignSkillRevision): SkillDraft {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    domains: skill.domains,
    supportedTasks: skill.supportedTasks,
    screenTypes: skill.screenTypes,
    locale: skill.locale,
    version: skill.version,
    tags: [...skill.tags],
    priority: skill.priority,
    incompatibilityGroups: [...skill.incompatibilityGroups],
    requiredPatterns: [...skill.requiredPatterns],
    source: skill.source,
    trust: skill.trust,
    createdAt: skill.createdAt,
    sourceMarkdown: skill.sourceMarkdown,
    expectedRevision: skill.revision,
  };
}

function makeRevision(draft: SkillDraft, revision: number, imported = false): DesignSkillRevision {
  const parsed = parseSkillMarkdown(draft.sourceMarkdown, draft.name || "Untitled Skill");
  const record = {
    schemaVersion: 1,
    id: draft.id,
    revision,
    revisionId: `${draft.id}.r${revision}`,
    contentHash: skillContentHash(parsed.sourceMarkdown),
    name: draft.name.trim() || parsed.metadata.name || "Untitled Skill",
    description: draft.description.trim().slice(0, 240),
    category: draft.category,
    domains: draft.domains,
    supportedTasks: draft.supportedTasks,
    screenTypes: draft.screenTypes,
    locale: draft.locale,
    version: draft.version.trim() || "1.0.0",
    tags: draft.tags
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12),
    priority: draft.priority,
    incompatibilityGroups: draft.incompatibilityGroups
      .map((group) => group.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8),
    requiredPatterns: draft.requiredPatterns,
    source: imported ? "imported" : draft.source,
    trust: imported ? "unverified" : draft.trust,
    createdAt: draft.createdAt,
    updatedAt: Date.now(),
    sourceMarkdown: parsed.sourceMarkdown,
    guidanceText: parsed.guidanceText,
    derivedNotes: parsed.derivedNotes,
  };
  return DesignSkillRevisionSchema.parse(record);
}

function safeMarkdownPreview(source: string): ReactNode[] {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let code: string[] = [];
  let inCode = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/u.test(line)) {
      if (inCode) {
        blocks.push(
          <pre className="skills-markdown-code" key={`code-${index}`}>
            {code.join("\n")}
          </pre>,
        );
        code = [];
        inCode = false;
      } else inCode = true;
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    if (!line.trim()) return;
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push(
        <h3 key={`h-${index}`} dir="auto">
          {heading[2]}
        </h3>,
      );
      return;
    }
    if (/^\s*[-*+]\s+/u.test(line)) {
      blocks.push(
        <p className="skills-markdown-list-item" key={`li-${index}`} dir="auto">
          • {line.replace(/^\s*[-*+]\s+/u, "")}
        </p>,
      );
      return;
    }
    if (/^\s*>/u.test(line)) {
      blocks.push(
        <blockquote key={`q-${index}`} dir="auto">
          {line.replace(/^\s*>\s?/u, "")}
        </blockquote>,
      );
      return;
    }
    blocks.push(
      <p key={`p-${index}`} dir="auto">
        {line}
      </p>,
    );
  });
  if (code.length)
    blocks.push(
      <pre className="skills-markdown-code" key="code-tail">
        {code.join("\n")}
      </pre>,
    );
  return blocks;
}

function downloadText(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function displayBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function DesignSkillsManager({
  snapshot,
  loading,
  loadError,
  onSnapshot,
  onRetry,
  onNavigate,
}: {
  snapshot: DesignSkillStoreSnapshot | null;
  loading: boolean;
  loadError: string;
  onSnapshot: (snapshot: DesignSkillStoreSnapshot) => void;
  onRetry: () => void;
  onNavigate: (view: PluginView) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState<"active" | "archived" | "removed" | "all">(
    "active",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [history, setHistory] = useState<DesignSkillRevision[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [importAsCopy, setImportAsCopy] = useState<DesignSkillRevision | null>(null);
  const future = snapshot?.integrity === "future-readonly";
  const displayedError = error || loadError;
  const entryMap = useMemo(
    () => new Map((snapshot?.entries ?? []).map((entry) => [entry.id, entry])),
    [snapshot],
  );
  const rows = useMemo(() => {
    const query = search.normalize("NFKC").trim().toLocaleLowerCase();
    return (snapshot?.skills ?? [])
      .filter((skill) => {
        const entry = entryMap.get(skill.id);
        if (
          !entry ||
          (stateFilter === "active" && (entry.archived || entry.removed)) ||
          (stateFilter === "archived" && (!entry.archived || entry.removed)) ||
          (stateFilter === "removed" && !entry.removed)
        )
          return false;
        if (categoryFilter !== "all" && skill.category !== categoryFilter) return false;
        return (
          !query ||
          [
            skill.name,
            skill.description,
            skill.tags.join(" "),
            skill.domains.join(" "),
            skill.source,
          ]
            .join(" ")
            .normalize("NFKC")
            .toLocaleLowerCase()
            .includes(query)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot, entryMap, search, categoryFilter, stateFilter]);
  const editingCurrent = draft ? snapshot?.skills.find(({ id }) => id === draft.id) : undefined;
  const changed = Boolean(
    draft &&
    (editingCurrent
      ? JSON.stringify(draft) !== JSON.stringify(draftFromSkill(editingCurrent))
      : draft.name.trim() !== "" ||
        draft.description.trim() !== "" ||
        draft.sourceMarkdown !== emptyMarkdown ||
        draft.category !== "general" ||
        draft.domains.join(",") !== "general" ||
        draft.supportedTasks.join(",") !== "new-design" ||
        draft.screenTypes.join(",") !== "all" ||
        draft.locale !== "multi" ||
        draft.version !== "1.0.0" ||
        draft.tags.length > 0 ||
        draft.priority !== 0 ||
        draft.incompatibilityGroups.length > 0 ||
        draft.requiredPatterns.length > 0),
  );

  const commitResult = (result: Awaited<ReturnType<typeof designSkillsRequest>>) => {
    if (!result.success) throw new Error(result.error ?? "Skill storage request failed.");
    if (result.snapshot) onSnapshot(result.snapshot);
    setError("");
    return result;
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (cause) {
      const text =
        cause instanceof Error
          ? cause.message
          : "The Skill operation failed; existing revisions were preserved.";
      setError(text);
      if (text.includes("already in the library"))
        setMessage(
          "Choose “Import as separate Skill” if this content should have a second identity.",
        );
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () =>
    run(async () => {
      if (!draft) return;
      const revision = makeRevision(draft, (draft.expectedRevision ?? 0) + 1);
      const result = commitResult(
        await designSkillsRequest({
          action: "save",
          skill: revision,
          expectedRevision: draft.expectedRevision,
        }),
      );
      setSelectedId(revision.id);
      setDraft(null);
      setPreview(false);
      setMessage(`Saved ${revision.name} as revision ${revision.revision}.`);
      if (result.snapshot?.defaultSkillIds.includes(revision.id))
        setMessage(`Saved and kept ${revision.name} as a default for new tasks.`);
    });

  const updateState = (
    id: string,
    next: { enabled: boolean; archived: boolean; removed: boolean },
  ) =>
    run(async () => {
      const entry = entryMap.get(id);
      if (!entry) throw new Error("This Skill was removed in another view; reload the library.");
      const result = commitResult(
        await designSkillsRequest({
          action: "set-state",
          id,
          ...next,
          expectedRevision: entry.currentRevision,
          expectedIndexUpdatedAt: snapshot?.indexUpdatedAt ?? -1,
        }),
      );
      setMessage(
        next.removed
          ? "Skill removed from the active library; its immutable revisions remain available to pinned tasks."
          : next.archived
            ? "Skill archived; existing task pins remain unchanged."
            : "Skill state updated.",
      );
      if (result.snapshot?.defaultSkillIds.includes(id))
        setMessage("Default Skill selection updated.");
    });

  const updateDefaults = (id: string, checked: boolean) =>
    run(async () => {
      if (!snapshot) return;
      const ids = checked
        ? [...snapshot.defaultSkillIds, id]
        : snapshot.defaultSkillIds.filter((candidate) => candidate !== id);
      if (ids.length > DESIGN_SKILL_MAX_PINNED)
        throw new Error(`Select no more than ${DESIGN_SKILL_MAX_PINNED} default Skills.`);
      const selected = ids
        .map((candidate) => snapshot.skills.find((skill) => skill.id === candidate))
        .filter((skill): skill is DesignSkillRevision => Boolean(skill));
      const conflicts = new Map<string, string>();
      for (const skill of selected)
        for (const group of skill.incompatibilityGroups) {
          const prior = conflicts.get(group);
          if (prior)
            throw new Error(
              `“${prior}” conflicts with “${skill.name}”. Resolve the default selection first.`,
            );
          conflicts.set(group, skill.name);
        }
      commitResult(
        await designSkillsRequest({
          action: "set-defaults",
          skillIds: ids,
          expectedIndexUpdatedAt: snapshot.indexUpdatedAt,
        }),
      );
    });

  const openHistory = (id: string) =>
    run(async () => {
      const result = commitResult(await designSkillsRequest({ action: "history", id }));
      setSelectedId(id);
      setHistory(result.history ?? []);
    });

  const restoreRevision = (id: string, revision: number) =>
    run(async () => {
      const result = commitResult(
        await designSkillsRequest({ action: "restore-revision", id, revision }),
      );
      const restored = result.snapshot?.skills.find((skill) => skill.id === id);
      setHistory([]);
      if (restored) setDraft(draftFromSkill(restored));
      setMessage("The selected revision was restored as a new immutable revision.");
    });

  const importBytes = async (file: File) => {
    if (file.size > DESIGN_SKILL_MAX_BODY_BYTES + 32 * 1024)
      throw new Error("Import file exceeds its size limit.");
    const buffer = await file.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    let importedDraft: SkillDraft;
    if (file.name.toLowerCase().endsWith(".json")) {
      const bundle = DesignSkillBundleSchema.parse(JSON.parse(text));
      const source = parseSkillMarkdown(bundle.skill.sourceMarkdown, file.name);
      importedDraft = {
        ...draftFromSkill({
          ...bundle.skill,
          sourceMarkdown: source.sourceMarkdown,
          guidanceText: source.guidanceText,
          derivedNotes: source.derivedNotes,
        } as DesignSkillRevision),
        id: idForNewSkill(),
        name: bundle.skill.name,
        source: "imported",
        trust: "unverified",
        createdAt: Date.now(),
        expectedRevision: null,
      };
    } else {
      const parsed = parseSkillMarkdown(text, file.name);
      importedDraft = {
        ...blankDraft(),
        id: idForNewSkill(),
        name: parsed.metadata.name ?? file.name.replace(/\.(?:md|markdown)$/iu, ""),
        description: parsed.metadata.description ?? "",
        category: parsed.metadata.category ?? "general",
        domains: parsed.metadata.domains ?? ["general"],
        locale: parsed.metadata.locale ?? "multi",
        version: parsed.metadata.version ?? "1.0.0",
        tags: parsed.metadata.tags ?? [],
        source: "imported",
        trust: "unverified",
        sourceMarkdown: parsed.sourceMarkdown,
      };
    }
    const skill = makeRevision(importedDraft, 1, true);
    setImportAsCopy(skill);
    setDraft(importedDraft);
    setSelectedId(skill.id);
    const result = await designSkillsRequest({ action: "import", skill, expectedRevision: null });
    if (!result.success && result.errorCode === "duplicate_content") {
      setMessage(
        "Identical Markdown is already in the library. You can import it as a separate Skill identity.",
      );
      return;
    }
    commitResult(result);
    setDraft(null);
    setImportAsCopy(null);
    setMessage(
      `Imported ${skill.name} as unverified local guidance. It is disabled for new tasks until you enable it.`,
    );
  };

  const importAsSeparate = () =>
    run(async () => {
      if (!importAsCopy) return;
      const result = commitResult(
        await designSkillsRequest({ action: "save", skill: importAsCopy, expectedRevision: null }),
      );
      setImportAsCopy(null);
      setDraft(null);
      setMessage(
        "Imported as a separate unverified Skill. It is disabled for new tasks until enabled.",
      );
      if (result.snapshot) onSnapshot(result.snapshot);
    });

  const exportMarkdown = (skill: DesignSkillRevision) =>
    downloadText(
      skill.sourceMarkdown,
      `${skill.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60) || "design-skill"}.md`,
      "text/markdown;charset=utf-8",
    );
  const exportBundle = (skill: DesignSkillRevision) =>
    downloadText(
      JSON.stringify({ schema: "figma-ai-design-skill", schemaVersion: 1, skill }, null, 2),
      `${skill.id}.skill.json`,
      "application/json;charset=utf-8",
    );

  const beginEdit = (skill: DesignSkillRevision) => {
    if (future) return;
    setSelectedId(skill.id);
    setDraft(draftFromSkill(skill));
    setPreview(false);
    setHistory([]);
  };

  const duplicate = (skill: DesignSkillRevision) => {
    setDraft({
      ...draftFromSkill(skill),
      id: idForNewSkill(),
      name: `${skill.name} (copy)`,
      createdAt: Date.now(),
      expectedRevision: null,
    });
    setSelectedId(null);
    setPreview(false);
    setHistory([]);
  };

  const newSkill = () => {
    if (draft && changed && !window.confirm("Discard unsaved Skill changes?")) return;
    setDraft(blankDraft());
    setSelectedId(null);
    setPreview(false);
    setHistory([]);
  };

  return (
    <section
      className="route-page detail-page skills-page"
      aria-labelledby="route-heading"
      dir="rtl"
    >
      <button className="text-button route-back" type="button" onClick={() => onNavigate("more")}>
        ‹ بیشتر
      </button>
      <div className="page-heading skills-page-heading">
        <div>
          <span className="page-eyebrow">راهنمای طراحی محلی</span>
          <h1 id="route-heading" tabIndex={-1}>
            مدیریت مهارت‌های طراحی
          </h1>
          <p className="page-description">
            مهارت‌ها فقط به‌عنوان راهنمای متنی محدودشده استفاده می‌شوند؛ ابزار، دسترسی یا مجوز جدیدی
            ایجاد نمی‌کنند.
          </p>
        </div>
        <button
          className="primary-action"
          type="button"
          onClick={newSkill}
          disabled={busy || future}
        >
          مهارت جدید
        </button>
      </div>

      <section className="route-card skills-policy-card" aria-label="سیاست استفاده از مهارت‌ها">
        <strong>برای وظایف جدید</strong>
        <p>
          حداکثر {DESIGN_SKILL_MAX_PINNED} مهارت پیش‌فرض را انتخاب کنید. هر وظیفه نسخهٔ ثابت خودش را
          نگه می‌دارد؛ ویرایش، غیرفعال‌سازی یا بایگانی، وظایف ذخیره‌شده را تغییر نمی‌دهد.
        </p>
        <small>
          برای انتخاب صریح در متن وظیفه از «Use skill: نام دقیق مهارت» استفاده کنید. نام و نسخهٔ
          انتخاب‌شده در checkpoint همان وظیفه ثبت می‌شود.
        </small>
      </section>

      {loading && (
        <p className="route-status" role="status">
          در حال بارگذاری کتابخانهٔ محلی…
        </p>
      )}
      {displayedError && (
        <p className="skills-error" role="alert">
          {displayedError}
        </p>
      )}
      {message && (
        <p className="route-status" role="status">
          {message}
        </p>
      )}
      {snapshot?.integrity === "recovered" && (
        <p className="skills-warning" role="status">
          بخشی از داده‌های ناسازگار جداگانه نگهداری شد. نسخه‌های معتبر همچنان قابل استفاده‌اند.
        </p>
      )}
      {future && (
        <p className="skills-warning" role="status">
          این کتابخانه با نسخهٔ جدیدتری ساخته شده و برای حفظ داده‌ها فقط‌خواندنی است.
        </p>
      )}

      <section className="route-card skills-storage-card" aria-label="مصرف فضای مهارت‌ها">
        <div className="skills-storage-heading">
          <strong>فضای محلی</strong>
          <span dir="ltr">
            {displayBytes(snapshot?.storageBytes ?? 0)} /{" "}
            {displayBytes(DESIGN_SKILL_STORAGE_BUDGET_BYTES)}
          </span>
        </div>
        <progress
          max={DESIGN_SKILL_STORAGE_BUDGET_BYTES}
          value={snapshot?.storageBytes ?? 0}
          aria-label="مصرف فضای محلی مهارت‌ها"
        />
        <small>
          نسخه‌های ثابت برای وظایف ذخیره‌شده حذف خودکار نمی‌شوند. مهارت حذف‌شده از کتابخانه پنهان
          می‌شود و نسخه‌های قبلی برای checkpointها می‌مانند.
        </small>
      </section>

      <div className="skills-layout">
        <section className="skills-library" aria-labelledby="skills-library-heading">
          <div className="skills-library-toolbar">
            <h2 id="skills-library-heading">
              کتابخانه <span>{rows.length}</span>
            </h2>
            <button
              className="secondary-action"
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy || future}
            >
              واردکردن Markdown
            </button>
            <input
              ref={fileInput}
              className="skills-file-input"
              type="file"
              accept=".md,.markdown,.json,text/markdown,application/json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void run(() => importBytes(file));
              }}
            />
          </div>
          <label className="skills-search-label">
            جست‌وجو
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="نام، توضیح، برچسب یا دامنه"
            />
          </label>
          <div className="skills-filters">
            <label>
              دسته
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="all">همهٔ دسته‌ها</option>
                {categories.map((category) => (
                  <option value={category} key={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              وضعیت
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}
              >
                <option value="active">فعال / بایگانی‌نشده</option>
                <option value="archived">بایگانی‌شده</option>
                <option value="removed">حذف‌شده</option>
                <option value="all">همه</option>
              </select>
            </label>
          </div>
          {!loading && rows.length === 0 && (
            <div className="skills-empty" role="status">
              <strong>{search ? "موردی پیدا نشد" : "کتابخانه خالی است"}</strong>
              <p>
                {search
                  ? "عبارت یا فیلتر دیگری را امتحان کنید."
                  : "یک فایل SKILL.md وارد کنید یا مهارت خودتان را بسازید."}
              </p>
            </div>
          )}
          <div className="skills-list">
            {rows.map((skill) => {
              const entry = entryMap.get(skill.id)!;
              const isDefault = snapshot?.defaultSkillIds.includes(skill.id) ?? false;
              return (
                <article
                  className={`skills-item ${selectedId === skill.id ? "is-selected" : ""}`}
                  key={skill.id}
                >
                  <div className="skills-item-heading">
                    <button
                      type="button"
                      className="skills-title-button"
                      dir="auto"
                      onClick={() => {
                        setSelectedId(skill.id);
                        setHistory([]);
                        setDraft(null);
                      }}
                    >
                      {skill.name}
                    </button>
                    <span className={`skills-source-badge is-${skill.trust}`}>
                      {skill.source === "bundled"
                        ? "قالب همراه"
                        : skill.source === "imported"
                          ? "واردشده"
                          : "ساخته‌شده"}{" "}
                      · {skill.trust === "unverified" ? "تأییدنشده" : "محلی"}
                    </span>
                  </div>
                  <p dir="auto">{skill.description || "بدون توضیح"}</p>
                  <div className="skills-meta-row">
                    <span>{skill.category}</span>
                    <span>v{skill.version}</span>
                    <span dir="ltr">r{skill.revision}</span>
                    <span>{skill.locale.toUpperCase()}</span>
                  </div>
                  <small className="skills-domain-list" dir="auto">
                    {skill.domains.join(" · ") || "همهٔ دامنه‌ها"} ·{" "}
                    {skill.supportedTasks.join(" · ")}
                  </small>
                  <div className="skills-item-controls">
                    <label className="skills-toggle">
                      <input
                        type="checkbox"
                        checked={entry.enabled && !entry.archived && !entry.removed}
                        disabled={busy || future || entry.archived || entry.removed}
                        onChange={(event) =>
                          void updateState(skill.id, {
                            enabled: event.target.checked,
                            archived: false,
                            removed: false,
                          })
                        }
                      />{" "}
                      فعال
                    </label>
                    <label className="skills-toggle">
                      <input
                        type="checkbox"
                        checked={isDefault}
                        disabled={
                          busy || future || !entry.enabled || entry.archived || entry.removed
                        }
                        onChange={(event) => void updateDefaults(skill.id, event.target.checked)}
                      />{" "}
                      پیش‌فرض وظایف جدید
                    </label>
                  </div>
                  <div className="skills-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setSelectedId(skill.id);
                        setDraft(null);
                        setPreview(true);
                        setHistory([]);
                      }}
                    >
                      پیش‌نمایش امن
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || future}
                      onClick={() => beginEdit(skill)}
                    >
                      ویرایش
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || future}
                      onClick={() => duplicate(skill)}
                    >
                      تکثیر
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => void openHistory(skill.id)}
                    >
                      نسخه‌ها
                    </button>
                    {entry.archived || entry.removed ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || future}
                        onClick={() =>
                          void updateState(skill.id, {
                            enabled: true,
                            archived: false,
                            removed: false,
                          })
                        }
                      >
                        بازگردانی
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || future}
                        onClick={() =>
                          void updateState(skill.id, {
                            enabled: false,
                            archived: true,
                            removed: false,
                          })
                        }
                      >
                        بایگانی
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger-action skills-remove-button"
                      disabled={busy || future}
                      onClick={() => setConfirmRemove(skill.id)}
                    >
                      حذف از کتابخانه
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => exportMarkdown(skill)}
                    >
                      خروجی MD
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => exportBundle(skill)}
                    >
                      خروجی امن JSON
                    </button>
                  </div>
                  {confirmRemove === skill.id && (
                    <div className="skills-confirm" role="alertdialog" aria-label="تأیید حذف مهارت">
                      <p>
                        این مهارت از فهرست فعال پنهان می‌شود. نسخه‌های ثابت وظایف موجود حفظ می‌شوند
                        و دادهٔ قبلی پاک نمی‌شود.
                      </p>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={busy || future}
                        onClick={() => {
                          setConfirmRemove(null);
                          void updateState(skill.id, {
                            enabled: false,
                            archived: false,
                            removed: true,
                          });
                        }}
                      >
                        تأیید حذف از فهرست
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setConfirmRemove(null)}
                      >
                        لغو
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="skills-detail" aria-labelledby="skills-detail-heading">
          {draft ? (
            <form
              className="route-card skills-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void saveDraft();
              }}
            >
              <div className="skills-editor-heading">
                <h2 id="skills-detail-heading">
                  {draft.expectedRevision === null
                    ? "مهارت تازه"
                    : `ویرایش · r${draft.expectedRevision}`}
                </h2>
                <div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setPreview(!preview)}
                  >
                    {preview ? "ویرایش متن" : "پیش‌نمایش امن"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      if (!changed || window.confirm("تغییرات ذخیره‌نشده کنار گذاشته شوند؟")) {
                        setDraft(null);
                        setPreview(false);
                      }
                    }}
                  >
                    لغو
                  </button>
                </div>
              </div>
              <div className="skills-form-grid">
                <label>
                  نام
                  <input
                    value={draft.name}
                    maxLength={100}
                    required
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  توضیح کوتاه
                  <input
                    value={draft.description}
                    maxLength={240}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </label>
                <label>
                  دسته
                  <select
                    value={draft.category}
                    onChange={(event) =>
                      setDraft({ ...draft, category: event.target.value as SkillDraft["category"] })
                    }
                  >
                    {categories.map((value) => (
                      <option value={value} key={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  زبان
                  <select
                    value={draft.locale}
                    onChange={(event) =>
                      setDraft({ ...draft, locale: event.target.value as SkillDraft["locale"] })
                    }
                  >
                    <option value="multi">چندزبانه</option>
                    <option value="fa">فارسی</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  نسخه
                  <input
                    value={draft.version}
                    maxLength={40}
                    onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                  />
                </label>
                <label>
                  اولویت مرتب‌سازی
                  <input
                    type="number"
                    min={-3}
                    max={3}
                    value={draft.priority}
                    onChange={(event) =>
                      setDraft({ ...draft, priority: Number(event.target.value) })
                    }
                  />
                </label>
                <fieldset className="skills-choice-field">
                  <legend>دامنه‌ها</legend>
                  {domains.map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={draft.domains.includes(value)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            domains: event.target.checked
                              ? [...draft.domains, value]
                              : draft.domains.filter((item) => item !== value),
                          })
                        }
                      />
                      {value}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="skills-choice-field">
                  <legend>کارهای پشتیبانی‌شده</legend>
                  {supportedTaskOptions.map(({ id, label }) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={draft.supportedTasks.includes(id)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            supportedTasks: event.target.checked
                              ? [...draft.supportedTasks, id]
                              : draft.supportedTasks.filter((item) => item !== id),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="skills-choice-field">
                  <legend>نوع صفحه</legend>
                  {screenOptions.map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={draft.screenTypes.includes(value)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            screenTypes: event.target.checked
                              ? [...draft.screenTypes, value]
                              : draft.screenTypes.filter((item) => item !== value),
                          })
                        }
                      />
                      {value}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="skills-choice-field">
                  <legend>الگوهای ساختاری قابل بررسی</legend>
                  <small>
                    فقط الگوهای موجود در فهرست کنترل‌شده می‌توانند شرط native QA بسازند.
                  </small>
                  {DESIGN_SKILL_PATTERN_IDS.map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={draft.requiredPatterns.includes(value)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            requiredPatterns: event.target.checked
                              ? [...draft.requiredPatterns, value]
                              : draft.requiredPatterns.filter((item) => item !== value),
                          })
                        }
                      />
                      {value}
                    </label>
                  ))}
                </fieldset>
                <label>
                  گروه ناسازگاری
                  <input
                    value={draft.incompatibilityGroups.join(", ")}
                    placeholder="مثلاً minimal-density"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        incompatibilityGroups: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <small>دو مهارت با گروه یکسان هم‌زمان انتخاب نمی‌شوند.</small>
                </label>
                <label>
                  برچسب‌ها
                  <input
                    value={draft.tags.join(", ")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        tags: event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </div>
              <div className="skills-source-heading">
                <h3>متن اصلی Markdown</h3>
                <span dir="ltr">
                  {new TextEncoder().encode(draft.sourceMarkdown).length} /{" "}
                  {DESIGN_SKILL_MAX_BODY_BYTES} B
                </span>
              </div>
              {preview ? (
                <div className="skills-markdown-preview" dir="auto">
                  {safeMarkdownPreview(draft.sourceMarkdown)}
                </div>
              ) : (
                <label className="skills-source-label">
                  محتوای کامل
                  <textarea
                    dir="auto"
                    rows={16}
                    maxLength={DESIGN_SKILL_MAX_BODY_BYTES}
                    value={draft.sourceMarkdown}
                    onChange={(event) => setDraft({ ...draft, sourceMarkdown: event.target.value })}
                  />
                </label>
              )}
              <p className="skills-untrusted-note">
                متن واردشده به‌عنوان دستور اجرایی اجرا نمی‌شود. بلوک‌های کد، HTML و مقصد لینک‌ها از
                راهنمای ارسالی به مدل حذف می‌شوند؛ متن کامل اصلی برای ویرایش و خروجی حفظ می‌شود.
              </p>
              <div className="skills-save-row">
                <span>
                  {changed ? "تغییر ذخیره‌نشده" : "نسخهٔ ذخیره‌شده"} · اعتماد:{" "}
                  {draft.trust === "unverified" ? "تأییدنشده" : "محلی"}
                </span>
                <button
                  type="submit"
                  className="primary-action"
                  disabled={
                    busy ||
                    future ||
                    !draft.name.trim() ||
                    !draft.supportedTasks.length ||
                    !draft.screenTypes.length
                  }
                >
                  ذخیرهٔ نسخهٔ جدید
                </button>
              </div>
            </form>
          ) : preview && selectedId ? (
            <article className="route-card skills-preview-card">
              <div className="skills-editor-heading">
                <h2 id="skills-detail-heading">پیش‌نمایش امن</h2>
                <button type="button" className="text-button" onClick={() => setPreview(false)}>
                  بستن
                </button>
              </div>
              <p>
                این Markdown فقط به متن و عناصر ساختاری ثابت تبدیل شده است؛ HTML و لینک‌ها اجرا یا
                باز نمی‌شوند.
              </p>
              <div className="skills-markdown-preview" dir="auto">
                {safeMarkdownPreview(
                  snapshot?.skills.find(({ id }) => id === selectedId)?.sourceMarkdown ?? "",
                )}
              </div>
            </article>
          ) : history.length && selectedId ? (
            <section className="route-card skills-history-card">
              <h2 id="skills-detail-heading">تاریخچهٔ نسخه‌ها</h2>
              <p>بازیابی، یک revision تازه می‌سازد و نسخه‌های قبلی را نگه می‌دارد.</p>
              {history.map((revision) => (
                <article className="skills-history-row" key={`${revision.id}-${revision.revision}`}>
                  <div>
                    <strong dir="auto">
                      {revision.name} · r{revision.revision}
                    </strong>
                    <small>{new Date(revision.updatedAt).toLocaleString()}</small>
                    <small dir="ltr">{revision.contentHash}</small>
                  </div>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={busy || future}
                    onClick={() => void restoreRevision(revision.id, revision.revision)}
                  >
                    بازیابی به‌صورت نسخهٔ تازه
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => exportMarkdown(revision)}
                  >
                    خروجی این نسخه
                  </button>
                </article>
              ))}
            </section>
          ) : selectedId ? (
            <article className="route-card skills-detail-card">
              {(() => {
                const skill = snapshot?.skills.find(({ id }) => id === selectedId);
                if (!skill)
                  return (
                    <>
                      <h2 id="skills-detail-heading">نسخه پیدا نشد</h2>
                      <p>
                        این مهارت حذف یا اصلاح شده است. بارگذاری دوباره، نسخه‌های معتبر را نشان
                        می‌دهد.
                      </p>
                    </>
                  );
                const entry = entryMap.get(skill.id);
                return (
                  <>
                    <div className="skills-editor-heading">
                      <h2 id="skills-detail-heading" dir="auto">
                        {skill.name}
                      </h2>
                      <span>
                        r{skill.revision} · {entry?.enabled ? "فعال" : "غیرفعال"}
                      </span>
                    </div>
                    <p dir="auto">{skill.description || "بدون توضیح"}</p>
                    <div className="skills-meta-row">
                      <span>{skill.category}</span>
                      <span>{skill.locale.toUpperCase()}</span>
                      <span>{skill.source}</span>
                      <span>{skill.trust}</span>
                    </div>
                    <p>
                      <strong>دسترسی:</strong> راهنمای طراحی متنی محدود. این مهارت ابزار، فایل،
                      شبکه، سندهای دیگر، مدل یا مجوز QA را کنترل نمی‌کند.
                    </p>
                    <p>
                      <strong>الگوهای QA:</strong>{" "}
                      {skill.requiredPatterns.join(" · ") || "هیچ الگوی ساختاری اجباری ندارد"}
                    </p>
                    <p>
                      <strong>Last used:</strong> برای این سیستم قابل اتکا نیست؛ وظایف فقط snapshot
                      و revision را ثبت می‌کنند.
                    </p>
                    <div className="skills-markdown-preview" dir="auto">
                      {safeMarkdownPreview(skill.sourceMarkdown)}
                    </div>
                  </>
                );
              })()}
            </article>
          ) : (
            <article className="route-card skills-detail-empty">
              <h2 id="skills-detail-heading">نسخه و قابلیت‌ها</h2>
              <p>یک مهارت را برای مشاهدهٔ نسخه، provenance و راهنمای امن انتخاب کنید.</p>
              <ul>
                <li>Markdown محلی با محدودیت 16 KiB</li>
                <li>حداکثر 3 snapshot در هر وظیفه</li>
                <li>واردشده‌ها تا زمان فعال‌سازی دستی غیرفعال می‌مانند</li>
                <li>محتوای مهارت مجوز اجرای ابزار یا شبکه ایجاد نمی‌کند</li>
              </ul>
              <small>
                برای واردکردن فایل، فقط `.md`, `.markdown` یا bundle امن `.json` انتخاب کنید. هیچ
                دانلود یا نصب بیرونی انجام نمی‌شود.
              </small>
            </article>
          )}
        </section>
      </div>
      {busy && (
        <p className="skills-saving" role="status">
          در حال ذخیرهٔ نسخهٔ محلی…
        </p>
      )}
      {importAsCopy && message.includes("Identical Markdown") && (
        <div className="skills-import-conflict" role="alert">
          <p>این متن قبلاً با fingerprint یکسان وجود دارد.</p>
          <button
            type="button"
            className="secondary-action"
            disabled={busy || future}
            onClick={() => void importAsSeparate()}
          >
            واردکردن به‌عنوان مهارت جدا
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setImportAsCopy(null);
              setDraft(null);
            }}
          >
            لغو
          </button>
        </div>
      )}
      {loadError && (
        <button className="secondary-action" type="button" disabled={busy} onClick={onRetry}>
          بارگذاری دوباره
        </button>
      )}
    </section>
  );
}
