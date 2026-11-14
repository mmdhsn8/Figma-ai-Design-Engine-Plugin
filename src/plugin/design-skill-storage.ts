import {
  DESIGN_SKILL_MAX_ARCHIVE_BYTES,
  DESIGN_SKILL_MAX_RECORDS,
  DESIGN_SKILL_STORAGE_BUDGET_BYTES,
  DesignSkillIndexSchema,
  DesignSkillRevisionSchema,
  DesignSkillStorageCommandSchema,
  DesignSkillStoreSnapshotSchema,
  rejectSkillPrototypeKeys,
  skillContentHash,
  type DesignSkillIndex,
  type DesignSkillRevision,
  type DesignSkillStorageCommand,
  type DesignSkillStorageResult,
  type DesignSkillStoreSnapshot,
} from "../shared/design-skill";
import { utf8Bytes } from "../shared/generation-limits";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";

const INDEX_KEY = "fad.design-skills.v1:index";
const PRESERVED_KEY = "fad.design-skills.v1:preserved";
const REVISION_PREFIX = "fad.design-skills.v1:revision:";
const STORAGE_ERROR = "Design Skills could not be saved. Existing revisions were preserved.";

export type DesignSkillStorageApi = Pick<
  PluginAPI["clientStorage"],
  "getAsync" | "setAsync" | "keysAsync"
>;
type Sidecar = { version: 1; entries: Array<{ key: string; value: unknown }> };
type Damaged = { key: string; value: unknown };
type Recovered = {
  index: DesignSkillIndex;
  skills: DesignSkillRevision[];
  damaged: Damaged[];
  integrity: DesignSkillStoreSnapshot["integrity"];
  future: boolean;
};

const queues = new WeakMap<object, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionKey(id: string, revision: number): string {
  return `${REVISION_PREFIX}${id}:${revision}`;
}

function byteSize(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function emptyIndex(now: number): DesignSkillIndex {
  return { version: 1, entries: [], defaultSkillIds: [], updatedAt: now };
}

function nextIndexTimestamp(index: DesignSkillIndex, now: number): number {
  return Math.max(now, index.updatedAt + 1);
}

function enqueue<T>(storage: object, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(storage) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(
    storage,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function parseSidecar(value: unknown): Sidecar {
  if (value === undefined) return { version: 1, entries: [] };
  if (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.length <= 1_000 &&
    value.entries.every(
      (entry) => isRecord(entry) && typeof entry.key === "string" && "value" in entry,
    )
  )
    return value as unknown as Sidecar;
  throw new Error("archive_failed");
}

function archivedSidecar(currentValue: unknown, damaged: Damaged[], now: number): Sidecar {
  const current = parseSidecar(currentValue);
  const next = {
    version: 1 as const,
    entries: [
      ...current.entries,
      ...damaged.map(({ key, value }) => ({ key, value, archivedAt: now })),
    ],
  };
  if (next.entries.length > 1_000 || byteSize(next) > DESIGN_SKILL_MAX_ARCHIVE_BYTES)
    throw new Error("archive_failed");
  return next;
}

function parseRevisionCandidate(raw: unknown, key: string): DesignSkillRevision | undefined {
  if (isRecord(raw) && typeof raw.schemaVersion === "number" && raw.schemaVersion > 1)
    throw new Error("future_version");
  const parsed = DesignSkillRevisionSchema.safeParse(raw);
  if (!parsed.success || key !== revisionKey(parsed.data.id, parsed.data.revision))
    return undefined;
  if (parsed.data.revisionId !== `${parsed.data.id}.r${parsed.data.revision}`) return undefined;
  return parsed.data;
}

async function recover(storage: DesignSkillStorageApi, now = Date.now()): Promise<Recovered> {
  let rawIndex: unknown;
  let keys: string[];
  try {
    [rawIndex, keys] = await Promise.all([storage.getAsync(INDEX_KEY), storage.keysAsync()]);
  } catch {
    throw new Error("storage_unavailable");
  }
  if (isRecord(rawIndex) && typeof rawIndex.version === "number" && rawIndex.version > 1)
    return {
      index: emptyIndex(now),
      skills: [],
      damaged: [],
      integrity: "future-readonly",
      future: true,
    };

  const damaged: Damaged[] = [];
  const revisionsById = new Map<string, DesignSkillRevision[]>();
  let future = false;
  for (const key of keys.filter((candidate) => candidate.startsWith(REVISION_PREFIX))) {
    let raw: unknown;
    try {
      raw = await storage.getAsync(key);
    } catch {
      damaged.push({ key, value: { error: "read_failed" } });
      continue;
    }
    try {
      const parsed = parseRevisionCandidate(raw, key);
      if (!parsed) damaged.push({ key, value: raw ?? null });
      else revisionsById.set(parsed.id, [...(revisionsById.get(parsed.id) ?? []), parsed]);
    } catch (error) {
      if (error instanceof Error && error.message === "future_version") {
        future = true;
        damaged.push({ key, value: raw });
      } else damaged.push({ key, value: raw ?? null });
    }
  }
  const validRevisions = [...revisionsById.values()].flat();
  const latest = new Map<string, DesignSkillRevision>();
  for (const revision of validRevisions.sort((a, b) => a.revision - b.revision)) {
    const current = latest.get(revision.id);
    if (!current || revision.revision > current.revision) latest.set(revision.id, revision);
  }

  const parsedIndex = DesignSkillIndexSchema.safeParse(rawIndex);
  let index: DesignSkillIndex;
  if (parsedIndex.success) {
    const entries: DesignSkillIndex["entries"] = [];
    const seen = new Set<string>();
    for (const entry of parsedIndex.data.entries) {
      if (seen.has(entry.id)) {
        damaged.push({ key: INDEX_KEY, value: { duplicateId: entry.id } });
        continue;
      }
      seen.add(entry.id);
      const current = latest.get(entry.id);
      if (!current) {
        damaged.push({
          key: revisionKey(entry.id, entry.currentRevision),
          value: { error: "revision_missing" },
        });
        continue;
      }
      entries.push({ ...entry, currentRevision: current.revision });
      if (current.revision !== entry.currentRevision)
        damaged.push({
          key: INDEX_KEY,
          value: {
            staleRevision: entry.currentRevision,
            recoveredRevision: current.revision,
            id: entry.id,
          },
        });
    }
    for (const [id, current] of latest) {
      if (!seen.has(id)) {
        if (entries.length >= DESIGN_SKILL_MAX_RECORDS) {
          damaged.push({ key: revisionKey(id, current.revision), value: current });
          continue;
        }
        entries.push({
          id,
          currentRevision: current.revision,
          enabled: current.trust !== "unverified",
          archived: false,
          removed: false,
        });
      }
    }
    const validDefaults = parsedIndex.data.defaultSkillIds.filter((id) => {
      const entry = entries.find((candidate) => candidate.id === id);
      return entry?.enabled && !entry.archived && !entry.removed;
    });
    if (validDefaults.length !== parsedIndex.data.defaultSkillIds.length)
      damaged.push({
        key: INDEX_KEY,
        value: { invalidDefaults: parsedIndex.data.defaultSkillIds },
      });
    index = {
      version: 1,
      entries,
      defaultSkillIds: validDefaults.slice(0, 3),
      updatedAt: parsedIndex.data.updatedAt,
    };
  } else {
    if (rawIndex !== undefined) damaged.push({ key: INDEX_KEY, value: rawIndex });
    else if (latest.size)
      damaged.push({
        key: INDEX_KEY,
        value: { error: "missing_index_recovered_from_immutable_revisions" },
      });
    index = {
      ...emptyIndex(now),
      entries: [...latest.values()]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(0, DESIGN_SKILL_MAX_RECORDS)
        .map((skill) => ({
          id: skill.id,
          currentRevision: skill.revision,
          enabled: skill.trust !== "unverified",
          archived: false,
          removed: false,
        })),
    };
  }
  const skills = index.entries.flatMap((entry) => {
    const revision = latest.get(entry.id);
    return revision ? [revision] : [];
  });
  return {
    index,
    skills,
    damaged,
    integrity: future ? "future-readonly" : damaged.length ? "recovered" : "clean",
    future,
  };
}

async function currentStorageBytes(
  storage: DesignSkillStorageApi,
  changes: Map<string, unknown>,
): Promise<number> {
  let keys: string[];
  try {
    keys = await storage.keysAsync();
  } catch {
    throw new Error("storage_unavailable");
  }
  const managed = new Set(keys.filter((key) => key.startsWith("fad.design-skills.v1:")));
  for (const key of changes.keys()) managed.add(key);
  let total = 0;
  for (const key of managed) {
    if (changes.has(key)) total += byteSize(changes.get(key));
    else {
      try {
        total += byteSize(await storage.getAsync(key));
      } catch {
        throw new Error("storage_unavailable");
      }
    }
  }
  return total;
}

async function ensureBudget(
  storage: DesignSkillStorageApi,
  changes: Map<string, unknown>,
): Promise<void> {
  if ((await currentStorageBytes(storage, changes)) > DESIGN_SKILL_STORAGE_BUDGET_BYTES)
    throw new Error("quota_exceeded");
}

async function makeSnapshot(
  storage: DesignSkillStorageApi,
  recovered: Recovered,
  preservedCount: number,
): Promise<DesignSkillStoreSnapshot> {
  const storageBytes = await currentStorageBytes(storage, new Map());
  return DesignSkillStoreSnapshotSchema.parse({
    version: 1,
    skills: recovered.skills,
    entries: recovered.index.entries,
    defaultSkillIds: recovered.index.defaultSkillIds,
    indexUpdatedAt: recovered.index.updatedAt,
    integrity: recovered.integrity,
    preservedRecordCount: Math.min(10_000, preservedCount),
    storageBytes: Math.min(DESIGN_SKILL_STORAGE_BUDGET_BYTES, storageBytes),
    storageLimitBytes: DESIGN_SKILL_STORAGE_BUDGET_BYTES,
  });
}

async function sidecarState(storage: DesignSkillStorageApi): Promise<Sidecar> {
  try {
    return parseSidecar(await storage.getAsync(PRESERVED_KEY));
  } catch {
    throw new Error("archive_failed");
  }
}

async function nextSidecar(
  storage: DesignSkillStorageApi,
  damaged: Damaged[],
  now: number,
): Promise<Sidecar | undefined> {
  if (!damaged.length) return undefined;
  return archivedSidecar(await storage.getAsync(PRESERVED_KEY), damaged, now);
}

function currentFor(recovered: Recovered, id: string): DesignSkillRevision | undefined {
  return recovered.skills.find((skill) => skill.id === id);
}

function safeError(code: string): string {
  const messages: Record<string, string> = {
    storage_unavailable: STORAGE_ERROR,
    index_corrupt: "Skill storage could not be read safely. Existing data was preserved.",
    future_version: "This Skill store was created by a newer plugin version and is read-only here.",
    revision_conflict: "This Skill changed in another view. Reload it before saving.",
    invalid_record: "The Skill record is invalid or its source fingerprint does not match.",
    quota_exceeded:
      "The local Skills storage budget is full. Export or archive Skills before adding more.",
    archive_failed: "Damaged Skill data could not be preserved; the write was stopped.",
    not_found: "The requested Skill revision is not available.",
    default_invalid:
      "Defaults must refer to enabled, active Skills and cannot contain incompatible Skills.",
    duplicate_content: "This Markdown content is already in the library.",
    too_many_revisions:
      "This Skill has reached its revision limit; export it before starting a new identity.",
  };
  return messages[code] ?? "The Skill request could not be completed; saved data was kept.";
}

function errorCode(error: unknown): NonNullable<DesignSkillStorageResult["errorCode"]> {
  if (
    error instanceof Error &&
    [
      "storage_unavailable",
      "index_corrupt",
      "future_version",
      "revision_conflict",
      "invalid_record",
      "quota_exceeded",
      "archive_failed",
      "not_found",
      "default_invalid",
      "duplicate_content",
      "too_many_revisions",
    ].includes(error.message)
  )
    return error.message as NonNullable<DesignSkillStorageResult["errorCode"]>;
  return "invalid_record";
}

async function publishIndex(
  storage: DesignSkillStorageApi,
  index: DesignSkillIndex,
  damaged: Damaged[],
  changes: Map<string, unknown>,
  now: number,
): Promise<void> {
  const sidecar = await nextSidecar(storage, damaged, now);
  if (sidecar) changes.set(PRESERVED_KEY, sidecar);
  changes.set(INDEX_KEY, index);
  await ensureBudget(storage, changes);
  try {
    if (sidecar) await storage.setAsync(PRESERVED_KEY, sidecar);
    for (const [key, value] of changes) {
      if (key === PRESERVED_KEY || key === INDEX_KEY) continue;
      await storage.setAsync(key, value);
    }
    await storage.setAsync(INDEX_KEY, index);
  } catch {
    throw new Error("storage_unavailable");
  }
}

async function handleCommand(
  storage: DesignSkillStorageApi,
  command: DesignSkillStorageCommand,
  now = Date.now(),
) {
  if (command.action === "load") {
    const recovered = await recover(storage, now);
    const sidecar = await sidecarState(storage);
    return { snapshot: await makeSnapshot(storage, recovered, sidecar.entries.length) };
  }
  if (rejectSkillPrototypeKeys(command)) throw new Error("invalid_record");
  let recovered = await recover(storage, now);
  if (recovered.future) throw new Error("future_version");
  const sidecar = await sidecarState(storage);

  if (command.action === "history") {
    if (!recovered.index.entries.some((entry) => entry.id === command.id))
      throw new Error("not_found");
    const keys = await storage.keysAsync();
    const prefix = `${REVISION_PREFIX}${command.id}:`;
    const history: DesignSkillRevision[] = [];
    for (const key of keys.filter((candidate) => candidate.startsWith(prefix))) {
      const raw = await storage.getAsync(key);
      const parsed = parseRevisionCandidate(raw, key);
      if (parsed) history.push(parsed);
    }
    return { history: history.sort((a, b) => b.revision - a.revision).slice(0, 100) };
  }

  if (command.action === "save" || command.action === "import") {
    const parsed = DesignSkillRevisionSchema.safeParse(command.skill);
    if (!parsed.success || parsed.data.contentHash !== skillContentHash(parsed.data.sourceMarkdown))
      throw new Error("invalid_record");
    const current = currentFor(recovered, parsed.data.id);
    if (command.action === "import" && current && current.contentHash === parsed.data.contentHash)
      return { snapshot: await makeSnapshot(storage, recovered, sidecar.entries.length) };
    if ((current?.revision ?? null) !== command.expectedRevision)
      throw new Error("revision_conflict");
    if ((current?.revision ?? 0) >= 100_000) throw new Error("too_many_revisions");
    const expectedNext = (current?.revision ?? 0) + 1;
    if (
      parsed.data.revision !== expectedNext ||
      parsed.data.revisionId !== `${parsed.data.id}.r${expectedNext}`
    )
      throw new Error("invalid_record");
    if (
      command.action === "import" &&
      !current &&
      recovered.skills.some(({ contentHash }) => contentHash === parsed.data.contentHash)
    )
      throw new Error("duplicate_content");
    let entry = recovered.index.entries.find(({ id }) => id === parsed.data.id);
    let entries = [...recovered.index.entries];
    if (!entry) {
      if (entries.length >= DESIGN_SKILL_MAX_RECORDS) throw new Error("quota_exceeded");
      entry = {
        id: parsed.data.id,
        currentRevision: expectedNext,
        enabled: parsed.data.trust !== "unverified",
        archived: false,
        removed: false,
      };
      entries.push(entry);
    } else {
      entry = {
        ...entry,
        currentRevision: expectedNext,
        archived: false,
        removed: false,
        ...(command.action === "import" && parsed.data.trust === "unverified"
          ? { enabled: false }
          : {}),
      };
      entries = entries.map((candidate) => (candidate.id === parsed.data.id ? entry! : candidate));
    }
    const defaults =
      command.action === "import" && parsed.data.trust === "unverified"
        ? recovered.index.defaultSkillIds.filter((id) => id !== parsed.data.id)
        : recovered.index.defaultSkillIds;
    const index = DesignSkillIndexSchema.parse({
      ...recovered.index,
      entries,
      defaultSkillIds: defaults,
      updatedAt: nextIndexTimestamp(recovered.index, now),
    });
    recovered = {
      ...recovered,
      skills: [...recovered.skills.filter(({ id }) => id !== parsed.data.id), parsed.data],
      index,
    };
    const changes = new Map<string, unknown>([
      [revisionKey(parsed.data.id, parsed.data.revision), parsed.data],
    ]);
    await publishIndex(storage, index, recovered.damaged, changes, now);
    return {
      snapshot: await makeSnapshot(
        storage,
        { ...recovered, damaged: [], integrity: "clean" },
        sidecar.entries.length + recovered.damaged.length,
      ),
    };
  }

  if (command.action === "set-defaults") {
    if (command.expectedIndexUpdatedAt !== recovered.index.updatedAt)
      throw new Error("revision_conflict");
    for (const id of command.skillIds) {
      const entry = recovered.index.entries.find((candidate) => candidate.id === id);
      if (!entry?.enabled || entry.archived || entry.removed) throw new Error("default_invalid");
    }
    const defaultGroups = new Set<string>();
    for (const id of command.skillIds) {
      const skill = currentFor(recovered, id);
      if (!skill) throw new Error("default_invalid");
      for (const group of skill.incompatibilityGroups) {
        if (defaultGroups.has(group)) throw new Error("default_invalid");
        defaultGroups.add(group);
      }
    }
    const index = DesignSkillIndexSchema.parse({
      ...recovered.index,
      defaultSkillIds: command.skillIds,
      updatedAt: nextIndexTimestamp(recovered.index, now),
    });
    await publishIndex(storage, index, recovered.damaged, new Map(), now);
    return {
      snapshot: await makeSnapshot(
        storage,
        { ...recovered, index, damaged: [], integrity: "clean" },
        sidecar.entries.length + recovered.damaged.length,
      ),
    };
  }

  if (command.action === "set-state") {
    if (command.expectedIndexUpdatedAt !== recovered.index.updatedAt)
      throw new Error("revision_conflict");
    const current = currentFor(recovered, command.id);
    const priorEntry = recovered.index.entries.find(({ id }) => id === command.id);
    if (!current || !priorEntry) throw new Error("not_found");
    if (current.revision !== command.expectedRevision) throw new Error("revision_conflict");
    const entry = {
      ...priorEntry,
      enabled: command.enabled,
      archived: command.archived,
      removed: command.removed,
    };
    const defaults =
      command.enabled && !command.archived && !command.removed
        ? recovered.index.defaultSkillIds
        : recovered.index.defaultSkillIds.filter((id) => id !== command.id);
    const index = DesignSkillIndexSchema.parse({
      ...recovered.index,
      entries: recovered.index.entries.map((candidate) =>
        candidate.id === command.id ? entry : candidate,
      ),
      defaultSkillIds: defaults,
      updatedAt: nextIndexTimestamp(recovered.index, now),
    });
    await publishIndex(storage, index, recovered.damaged, new Map(), now);
    return {
      snapshot: await makeSnapshot(
        storage,
        { ...recovered, index, damaged: [], integrity: "clean" },
        sidecar.entries.length + recovered.damaged.length,
      ),
    };
  }

  if (command.action === "remove") {
    const current = currentFor(recovered, command.id);
    if (!current) throw new Error("not_found");
    const entries = recovered.index.entries.map((entry) =>
      entry.id === command.id ? { ...entry, enabled: false, removed: true } : entry,
    );
    const index = DesignSkillIndexSchema.parse({
      ...recovered.index,
      entries,
      defaultSkillIds: recovered.index.defaultSkillIds.filter((id) => id !== command.id),
      updatedAt: nextIndexTimestamp(recovered.index, now),
    });
    await publishIndex(storage, index, recovered.damaged, new Map(), now);
    return {
      snapshot: await makeSnapshot(
        storage,
        { ...recovered, index, damaged: [], integrity: "clean" },
        sidecar.entries.length + recovered.damaged.length,
      ),
    };
  }

  if (command.action === "restore-revision") {
    const raw = await storage.getAsync(revisionKey(command.id, command.revision));
    const revision = parseRevisionCandidate(raw, revisionKey(command.id, command.revision));
    if (!revision) throw new Error("not_found");
    const entry = recovered.index.entries.find(({ id }) => id === command.id);
    if (!entry) throw new Error("not_found");
    const nextRevision = currentFor(recovered, command.id)!.revision + 1;
    const restored = DesignSkillRevisionSchema.parse({
      ...revision,
      revision: nextRevision,
      revisionId: `${command.id}.r${nextRevision}`,
      updatedAt: now,
    });
    const nextEntry = { ...entry, currentRevision: nextRevision, archived: false, removed: false };
    const index = DesignSkillIndexSchema.parse({
      ...recovered.index,
      entries: recovered.index.entries.map((candidate) =>
        candidate.id === command.id ? nextEntry : candidate,
      ),
      updatedAt: nextIndexTimestamp(recovered.index, now),
    });
    recovered = {
      ...recovered,
      skills: [...recovered.skills.filter(({ id }) => id !== command.id), restored],
      index,
    };
    await publishIndex(
      storage,
      index,
      recovered.damaged,
      new Map([[revisionKey(command.id, nextRevision), restored]]),
      now,
    );
    return {
      snapshot: await makeSnapshot(
        storage,
        { ...recovered, damaged: [], integrity: "clean" },
        sidecar.entries.length + recovered.damaged.length,
      ),
    };
  }
  throw new Error("invalid_record");
}

export async function handleDesignSkillStorage(
  storage: DesignSkillStorageApi,
  message: Extract<UIToPluginMessage, { type: "design-skills-storage" }>,
): Promise<PluginToUIMessage> {
  try {
    const command = DesignSkillStorageCommandSchema.parse(message.command);
    const result = await enqueue(storage as object, () => handleCommand(storage, command));
    return { type: "design-skills-result", requestId: message.requestId, success: true, ...result };
  } catch (error) {
    const code = errorCode(error);
    return {
      type: "design-skills-result",
      requestId: message.requestId,
      success: false,
      errorCode: code,
      error: safeError(code),
    };
  }
}
