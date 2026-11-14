import {
  BRAND_KIT_MAX_ARCHIVE_BYTES,
  BRAND_KIT_MAX_RECORDS,
  BRAND_KIT_MAX_TOTAL_ASSET_BYTES,
  BRAND_KIT_STORAGE_QUOTA_BYTES,
  BrandKitExportSchema,
  BrandKitIndexSchema,
  BrandKitRevisionSchema,
  BrandKitStorageCommandSchema,
  BrandKitStoreSnapshotSchema,
  createBrandVisualAsset,
  rejectPrototypeKeys,
  validateBrandAsset,
  type BrandKitIndex,
  type BrandKitRevision,
  type BrandKitStorageCommand,
  type BrandKitStoreSnapshot,
  type PinnedBrandKit,
} from "../shared/brand-kit";
import type { VisualAsset } from "../shared/visual-schema";
import { embeddedImageBytes } from "../shared/visual-assets";
import { utf8Bytes } from "../shared/generation-limits";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";

const INDEX_KEY = "fad.brand-kits.v1:index";
const PRESERVED_KEY = "fad.brand-kits.v1:preserved";
const REVISION_PREFIX = "fad.brand-kits.v1:revision:";
const ASSET_PREFIX = "fad.brand-kits.v1:asset:";
const queues = new WeakMap<object, Promise<void>>();
const STORAGE_ERROR = "Brand Kit data could not be saved. Existing records were kept.";

export type BrandKitStorageApi = Pick<
  PluginAPI["clientStorage"],
  "getAsync" | "setAsync" | "keysAsync"
>;
type PreservedSidecar = { version: 1; entries: Array<{ key: string; value: unknown }> };
type Recovered = {
  index: BrandKitIndex;
  brands: BrandKitRevision[];
  damaged: Array<{ key: string; value: unknown }>;
  integrity: BrandKitStoreSnapshot["integrity"];
  future: boolean;
};

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

function emptyIndex(now: number): BrandKitIndex {
  return { version: 1, entries: [], defaultBrandId: null, updatedAt: now };
}

function enqueue<T>(storage: object, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(storage) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(operation);
  queues.set(
    storage,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function parseSidecar(value: unknown): PreservedSidecar {
  if (value == null) return { version: 1, entries: [] };
  if (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.length <= 10_000 &&
    value.entries.every(
      (entry) => isRecord(entry) && typeof entry.key === "string" && "value" in entry,
    )
  )
    return value as unknown as PreservedSidecar;
  throw new Error("archive_failed");
}

async function recover(storage: BrandKitStorageApi, now = Date.now()): Promise<Recovered> {
  let raw: unknown;
  try {
    raw = await storage.getAsync(INDEX_KEY);
  } catch {
    throw new Error("storage_unavailable");
  }
  if (raw === undefined)
    return { index: emptyIndex(now), brands: [], damaged: [], integrity: "clean", future: false };
  if (isRecord(raw) && typeof raw.version === "number" && raw.version > 1)
    return {
      index: emptyIndex(now),
      brands: [],
      damaged: [],
      integrity: "future-readonly",
      future: true,
    };
  const parsed = BrandKitIndexSchema.safeParse(raw);
  if (parsed.success) {
    const brands: BrandKitRevision[] = [];
    const damaged: Array<{ key: string; value: unknown }> = [];
    let future = false;
    const seen = new Set<string>();
    for (const entry of parsed.data.entries) {
      if (seen.has(entry.id)) {
        damaged.push({
          key: INDEX_KEY,
          value: { duplicateId: entry.id, currentRevision: entry.currentRevision },
        });
        continue;
      }
      seen.add(entry.id);
      const key = revisionKey(entry.id, entry.currentRevision);
      let candidate: unknown;
      try {
        candidate = await storage.getAsync(key);
      } catch {
        damaged.push({ key, value: { error: "read_failed" } });
        continue;
      }
      if (
        isRecord(candidate) &&
        typeof candidate.schemaVersion === "number" &&
        candidate.schemaVersion > 1
      ) {
        future = true;
        damaged.push({ key, value: candidate });
        continue;
      }
      const brand = BrandKitRevisionSchema.safeParse(candidate);
      if (
        !brand.success ||
        brand.data.id !== entry.id ||
        brand.data.revision !== entry.currentRevision
      )
        damaged.push({ key, value: candidate ?? null });
      else brands.push(brand.data);
    }
    const defaultsToActive = brands.some(
      (brand) => brand.id === parsed.data.defaultBrandId && brand.status === "active",
    );
    return {
      index: {
        ...parsed.data,
        defaultBrandId: defaultsToActive ? parsed.data.defaultBrandId : null,
      },
      brands,
      damaged,
      integrity: future ? "future-readonly" : damaged.length ? "recovered" : "clean",
      future,
    };
  }

  const damaged: Array<{ key: string; value: unknown }> = [{ key: INDEX_KEY, value: raw }];
  const known: Array<{ id: string; currentRevision: number }> = [];
  const candidates = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  for (const candidate of candidates) {
    const entry = zBrandEntry(candidate);
    if (entry && !known.some(({ id }) => id === entry.id)) known.push(entry);
    else damaged.push({ key: INDEX_KEY, value: candidate });
  }
  let keys: string[];
  try {
    keys = await storage.keysAsync();
  } catch {
    throw new Error("storage_unavailable");
  }
  for (const key of keys
    .filter((item) => item.startsWith(REVISION_PREFIX))
    .slice(0, BRAND_KIT_MAX_RECORDS * 8)) {
    const parts = key.slice(REVISION_PREFIX.length).split(":");
    const revision = Number(parts.pop());
    const id = parts.join(":");
    if (!/^[A-Za-z0-9_-]{8,80}$/u.test(id) || !Number.isInteger(revision) || revision < 1) continue;
    if (!known.some((entry) => entry.id === id)) known.push({ id, currentRevision: revision });
  }
  const brands: BrandKitRevision[] = [];
  for (const entry of known.slice(0, BRAND_KIT_MAX_RECORDS)) {
    try {
      const candidate: unknown = await storage.getAsync(
        revisionKey(entry.id, entry.currentRevision),
      );
      if (
        isRecord(candidate) &&
        typeof candidate.schemaVersion === "number" &&
        candidate.schemaVersion > 1
      ) {
        damaged.push({ key: revisionKey(entry.id, entry.currentRevision), value: candidate });
        continue;
      }
      const brand = BrandKitRevisionSchema.safeParse(candidate);
      if (
        brand.success &&
        brand.data.id === entry.id &&
        brand.data.revision === entry.currentRevision
      )
        brands.push(brand.data);
      else
        damaged.push({
          key: revisionKey(entry.id, entry.currentRevision),
          value: candidate ?? null,
        });
    } catch {
      damaged.push({
        key: revisionKey(entry.id, entry.currentRevision),
        value: { error: "read_failed" },
      });
    }
  }
  return {
    index: {
      version: 1,
      entries: brands.map(({ id, revision }) => ({ id, currentRevision: revision })),
      defaultBrandId: null,
      updatedAt: now,
    },
    brands,
    damaged,
    integrity: "recovered",
    future: damaged.some(
      ({ value }) =>
        isRecord(value) && typeof value.schemaVersion === "number" && value.schemaVersion > 1,
    ),
  };
}

function zBrandEntry(value: unknown): { id: string; currentRevision: number } | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/u.test(value.id))
    return;
  if (
    typeof value.currentRevision !== "number" ||
    !Number.isInteger(value.currentRevision) ||
    value.currentRevision < 1
  )
    return;
  return { id: value.id, currentRevision: value.currentRevision };
}

async function archiveDamaged(
  storage: BrandKitStorageApi,
  damaged: Recovered["damaged"],
): Promise<void> {
  if (!damaged.length) return;
  let current: PreservedSidecar;
  try {
    current = parseSidecar(await storage.getAsync(PRESERVED_KEY));
  } catch {
    throw new Error("archive_failed");
  }
  const identity = new Set(
    current.entries.map(({ key, value }) => `${key}:${JSON.stringify(value)}`),
  );
  for (const entry of damaged) {
    const serialized = `${entry.key}:${JSON.stringify(entry.value)}`;
    if (!identity.has(serialized)) current.entries.push(entry);
  }
  if (byteSize(current) > BRAND_KIT_MAX_ARCHIVE_BYTES) throw new Error("archive_failed");
  try {
    await storage.setAsync(PRESERVED_KEY, current);
  } catch {
    throw new Error("archive_failed");
  }
}

async function ensureQuota(
  storage: BrandKitStorageApi,
  writes: Array<{ key: string; value: unknown }>,
): Promise<void> {
  let keys: string[];
  try {
    keys = await storage.keysAsync();
  } catch {
    throw new Error("storage_unavailable");
  }
  let total = 0;
  for (const key of keys) {
    try {
      total += key.length + byteSize(await storage.getAsync(key));
    } catch {
      throw new Error("storage_unavailable");
    }
  }
  const updates = new Map(writes.map(({ key, value }) => [key, value]));
  for (const [key, value] of updates) {
    if (keys.includes(key)) total -= key.length + byteSize(await storage.getAsync(key));
    total += key.length + byteSize(value);
  }
  if (total > BRAND_KIT_STORAGE_QUOTA_BYTES) throw new Error("quota_exceeded");
}

async function ensureAssetBudget(storage: BrandKitStorageApi, newBytes: number): Promise<void> {
  let total = 0;
  for (const key of await storage.keysAsync()) {
    if (!key.startsWith(ASSET_PREFIX)) continue;
    const value = await storage.getAsync(key);
    if (!(value instanceof Uint8Array)) throw new Error("asset_invalid");
    total += value.byteLength;
  }
  if (total + newBytes > BRAND_KIT_MAX_TOTAL_ASSET_BYTES) throw new Error("quota_exceeded");
}

function snapshot(
  recovered: Recovered,
  preservedCount = recovered.damaged.length,
): BrandKitStoreSnapshot {
  return BrandKitStoreSnapshotSchema.parse({
    version: 1,
    brands: recovered.brands,
    defaultBrandId: recovered.index.defaultBrandId,
    integrity: recovered.integrity,
    preservedRecordCount: preservedCount,
  });
}

async function saveRevision(
  storage: BrandKitStorageApi,
  recovered: Recovered,
  input: BrandKitRevision,
  expectedRevision: number | null,
): Promise<Recovered> {
  if (recovered.future) throw new Error("future_version");
  await archiveDamaged(storage, recovered.damaged);
  const current = recovered.index.entries.find(({ id }) => id === input.id);
  if ((current?.currentRevision ?? null) !== expectedRevision) throw new Error("revision_conflict");
  if (!current && recovered.index.entries.length >= BRAND_KIT_MAX_RECORDS)
    throw new Error("quota_exceeded");
  const now = Date.now();
  const existing = recovered.brands.find(({ id }) => id === input.id);
  const next = BrandKitRevisionSchema.parse({
    ...input,
    revision: (current?.currentRevision ?? 0) + 1,
    createdAt: existing?.createdAt ?? input.createdAt,
    updatedAt: now,
  });
  const oldAssets = recovered.brands
    .filter(({ id }) => id !== next.id)
    .flatMap(({ assets }) => assets);
  const assetIds = new Set([...oldAssets, ...next.assets].map(({ assetId }) => assetId));
  let totalAssetBytes = 0;
  for (const assetId of assetIds) {
    const metadata =
      next.assets.find(({ assetId: candidate }) => candidate === assetId) ??
      oldAssets.find(({ assetId: candidate }) => candidate === assetId);
    const value = await storage.getAsync(`${ASSET_PREFIX}${assetId}`);
    if (!(value instanceof Uint8Array) || !metadata || contentHash(value) !== metadata.contentHash)
      throw new Error("asset_missing");
    totalAssetBytes += value.byteLength;
  }
  if (totalAssetBytes > BRAND_KIT_MAX_TOTAL_ASSET_BYTES) throw new Error("quota_exceeded");
  const index = BrandKitIndexSchema.parse({
    version: 1,
    entries: current
      ? recovered.index.entries.map((entry) =>
          entry.id === input.id ? { id: input.id, currentRevision: next.revision } : entry,
        )
      : [...recovered.index.entries, { id: input.id, currentRevision: next.revision }],
    defaultBrandId:
      next.status === "archived" && recovered.index.defaultBrandId === next.id
        ? null
        : recovered.index.defaultBrandId,
    updatedAt: now,
  });
  const writes = [
    { key: revisionKey(next.id, next.revision), value: next },
    { key: INDEX_KEY, value: index },
  ];
  await ensureQuota(storage, writes);
  try {
    await storage.setAsync(writes[0]!.key, writes[0]!.value);
    await storage.setAsync(writes[1]!.key, writes[1]!.value);
  } catch {
    throw new Error("storage_unavailable");
  }
  return {
    index,
    brands: [...recovered.brands.filter(({ id }) => id !== next.id), next],
    damaged: [],
    integrity: recovered.damaged.length ? "recovered" : "clean",
    future: false,
  };
}

async function saveIndex(
  storage: BrandKitStorageApi,
  recovered: Recovered,
  index: BrandKitIndex,
): Promise<Recovered> {
  if (recovered.future) throw new Error("future_version");
  await archiveDamaged(storage, recovered.damaged);
  await ensureQuota(storage, [{ key: INDEX_KEY, value: index }]);
  try {
    await storage.setAsync(INDEX_KEY, index);
  } catch {
    throw new Error("storage_unavailable");
  }
  return {
    ...recovered,
    index,
    damaged: [],
    integrity: recovered.damaged.length ? "recovered" : "clean",
  };
}

function errorCode(
  error: unknown,
): NonNullable<Extract<PluginToUIMessage, { type: "brand-kit-result" }>["errorCode"]> {
  const message = error instanceof Error ? error.message : "";
  if (
    [
      "storage_unavailable",
      "index_corrupt",
      "revision_conflict",
      "future_version",
      "archive_failed",
      "quota_exceeded",
      "asset_missing",
      "asset_invalid",
      "import_collision",
      "not_found",
      "default_invalid",
    ].includes(message)
  )
    return message as ReturnType<typeof errorCode>;
  return "invalid_record";
}

function safeError(code: ReturnType<typeof errorCode>): string {
  const messages: Record<ReturnType<typeof errorCode>, string> = {
    storage_unavailable: STORAGE_ERROR,
    index_corrupt: "فهرست برند آسیب‌دیده است؛ داده‌های سالم حفظ و نسخه‌های ناسازگار آرشیو می‌شوند.",
    future_version: "این داده با نسخهٔ جدیدتری ساخته شده است؛ برای حفظ آن، ویرایش متوقف شد.",
    revision_conflict: "این برند در محل دیگری تغییر کرده است. نسخهٔ تازه را بارگذاری کنید.",
    invalid_record: "ساختار برند معتبر نیست؛ دادهٔ قبلی دست‌نخورده ماند.",
    quota_exceeded: "فضای محلی برند کافی نیست؛ هیچ رکورد قبلی حذف نشد.",
    archive_failed: "آرشیو امن دادهٔ ناسازگار ممکن نشد؛ ذخیره متوقف شد.",
    asset_missing: "فایل نشان پیدا نشد؛ بازبینی یا بازگردانی لازم است.",
    asset_invalid: "فایل نشان معتبر یا ایمن نیست.",
    import_collision: "شناسهٔ واردشده با یک برند موجود برخورد دارد.",
    not_found: "برند موردنظر پیدا نشد.",
    default_invalid: "برند پیش‌فرض باید فعال و ذخیره‌شده باشد.",
  };
  return messages[code];
}

function contentHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  return btoa(binary);
}

export async function resolvePinnedBrandVisualAssets(
  storage: BrandKitStorageApi,
  pinned: PinnedBrandKit | undefined,
): Promise<VisualAsset[]> {
  if (!pinned) return [];
  const visual: VisualAsset[] = [];
  for (const asset of pinned.assets) {
    const value = await storage.getAsync(`${ASSET_PREFIX}${asset.assetId}`);
    if (!(value instanceof Uint8Array) || contentHash(value) !== asset.contentHash)
      throw new Error(
        `Pinned Brand Kit asset “${asset.name}” is missing or changed; resume is blocked without mutation.`,
      );
    visual.push(createBrandVisualAsset(asset, bytesToBase64(value)));
  }
  return visual;
}

async function handleCommand(
  storage: BrandKitStorageApi,
  command: BrandKitStorageCommand,
): Promise<{
  snapshot?: BrandKitStoreSnapshot;
  assetBase64?: string;
}> {
  if (command.action === "save-asset") {
    const recovered = await recover(storage);
    if (recovered.future) throw new Error("future_version");
    await archiveDamaged(storage, recovered.damaged);
    const validation = validateBrandAsset(command.mimeType, command.base64);
    if (!validation.valid) throw new Error("asset_invalid");
    const bytes = embeddedImageBytes(command.base64);
    const key = `${ASSET_PREFIX}${command.assetId}`;
    const existing = await storage.getAsync(key);
    if (existing !== undefined) {
      if (!(existing instanceof Uint8Array) || contentHash(existing) !== contentHash(bytes))
        throw new Error("import_collision");
    } else {
      await ensureAssetBudget(storage, bytes.byteLength);
      const writes = [{ key, value: bytes }];
      await ensureQuota(storage, writes);
      await storage.setAsync(key, bytes);
    }
    return {};
  }
  if (command.action === "load-asset") {
    const value = await storage.getAsync(`${ASSET_PREFIX}${command.assetId}`);
    if (!(value instanceof Uint8Array)) throw new Error("asset_missing");
    return { assetBase64: bytesToBase64(value) };
  }

  let recovered = await recover(storage);
  if (recovered.future && command.action !== "load") throw new Error("future_version");
  if (command.action === "load") return { snapshot: snapshot(recovered) };
  if (command.action === "save") {
    const parsed = BrandKitRevisionSchema.safeParse(command.kit);
    if (!parsed.success) throw new Error("invalid_record");
    recovered = await saveRevision(storage, recovered, parsed.data, command.expectedRevision);
    return { snapshot: snapshot(recovered) };
  }
  if (command.action === "set-default") {
    if (
      command.brandId &&
      !recovered.brands.some(({ id, status }) => id === command.brandId && status === "active")
    )
      throw new Error("default_invalid");
    const index = BrandKitIndexSchema.parse({
      ...recovered.index,
      defaultBrandId: command.brandId,
      updatedAt: Date.now(),
    });
    recovered = await saveIndex(storage, recovered, index);
    return { snapshot: snapshot(recovered) };
  }
  if (command.action === "set-status") {
    const current = recovered.brands.find(({ id }) => id === command.brandId);
    if (!current) throw new Error("not_found");
    const next = { ...current, status: command.status };
    recovered = await saveRevision(
      storage,
      recovered,
      BrandKitRevisionSchema.parse(next),
      current.revision,
    );
    return { snapshot: snapshot(recovered) };
  }
  if (command.action === "import") {
    if (rejectPrototypeKeys(command.data)) throw new Error("invalid_record");
    const parsed = BrandKitExportSchema.safeParse(command.data);
    if (!parsed.success) throw new Error("invalid_record");
    if (recovered.brands.some(({ id }) => id === parsed.data.brand.id))
      throw new Error("import_collision");
    if (
      parsed.data.assets.length !== parsed.data.brand.assets.length ||
      new Set(parsed.data.assets.map(({ assetId }) => assetId)).size !==
        parsed.data.assets.length ||
      parsed.data.brand.assets.some(
        ({ assetId }) => !parsed.data.assets.some((asset) => asset.assetId === assetId),
      )
    )
      throw new Error("invalid_record");
    const assetWrites: Array<{ key: string; value: Uint8Array }> = [];
    for (const asset of parsed.data.assets) {
      const metadata = parsed.data.brand.assets.find(({ assetId }) => assetId === asset.assetId)!;
      const valid = validateBrandAsset(metadata.mimeType, asset.base64);
      if (!valid.valid) throw new Error("asset_invalid");
      const bytes = embeddedImageBytes(asset.base64);
      if (
        contentHash(bytes) !== metadata.contentHash ||
        valid.kind !== metadata.kind ||
        valid.width !== metadata.width ||
        valid.height !== metadata.height
      )
        throw new Error("asset_invalid");
      const key = `${ASSET_PREFIX}${asset.assetId}`;
      if ((await storage.getAsync(key)) !== undefined) throw new Error("import_collision");
      assetWrites.push({ key, value: bytes });
    }
    await ensureAssetBudget(
      storage,
      assetWrites.reduce((sum, { value }) => sum + value.byteLength, 0),
    );
    await ensureQuota(storage, assetWrites);
    try {
      for (const { key, value } of assetWrites) await storage.setAsync(key, value);
    } catch {
      throw new Error("storage_unavailable");
    }
    recovered = await saveRevision(storage, recovered, parsed.data.brand, null);
    return { snapshot: snapshot(recovered) };
  }
  throw new Error("invalid_record");
}

export async function handleBrandKitStorage(
  storage: BrandKitStorageApi,
  message: Extract<UIToPluginMessage, { type: "brand-kit-storage" }>,
): Promise<PluginToUIMessage> {
  try {
    const command = BrandKitStorageCommandSchema.parse(message.command);
    const result = await enqueue(storage as object, () => handleCommand(storage, command));
    return { type: "brand-kit-result", requestId: message.requestId, success: true, ...result };
  } catch (error) {
    const code = errorCode(error);
    return {
      type: "brand-kit-result",
      requestId: message.requestId,
      success: false,
      errorCode: code,
      error: safeError(code),
    };
  }
}
