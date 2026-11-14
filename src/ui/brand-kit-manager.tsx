import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  BRAND_KIT_MAX_ASSET_BYTES,
  BrandKitRevisionSchema,
  BrandKitExportSchema,
  colorContrastRatio,
  rejectPrototypeKeys,
  pinBrandKit,
  resolveBrandKitTokens,
  validateBrandAsset,
  type BrandColorRole,
  type BrandKitRevision,
  type BrandKitStorageCommand,
  type BrandKitStoreSnapshot,
} from "../shared/brand-kit";
import { brandKitRequest } from "./brand-kit-bridge";
import type { PluginView } from "./workspace-routes";

const colorRoles: Array<[BrandColorRole, string]> = [
  ["primary", "اصلی"],
  ["secondary", "ثانویه"],
  ["accent", "تأکیدی"],
  ["background", "پس‌زمینه"],
  ["surface", "سطح"],
  ["text", "متن"],
  ["mutedText", "متن کم‌رنگ"],
  ["border", "خط دور"],
  ["success", "موفقیت"],
  ["warning", "هشدار"],
  ["error", "خطا"],
];
const typographyRoles = [
  ["display", "نمایشی"],
  ["heading1", "عنوان ۱"],
  ["heading2", "عنوان ۲"],
  ["heading3", "عنوان ۳"],
  ["body", "متن اصلی"],
  ["caption", "کپشن"],
  ["button", "دکمه"],
] as const;

function makeId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 80);
}

function defaultTypography(size: number, weight: number) {
  return {
    requestedFamily: "Inter",
    fallbackFamily: "Inter",
    style: weight >= 600 ? "Bold" : "Regular",
    weight,
    size,
    lineHeight: Math.round(size * 1.45),
    letterSpacing: 0,
    alignment: "right" as const,
    direction: "auto" as const,
  };
}

export function newBrandKit(name = "برند تازه"): BrandKitRevision {
  const now = Date.now();
  return BrandKitRevisionSchema.parse({
    schemaVersion: 1,
    id: makeId("brand"),
    revision: 1,
    name,
    description: "",
    locale: "fa",
    direction: "rtl",
    createdAt: now,
    updatedAt: now,
    status: "active",
    tokens: {
      palette: {
        primary: "#2563EB",
        secondary: "#1E3A8A",
        accent: "#F97316",
        background: "#F8FAFC",
        surface: "#FFFFFF",
        text: "#0F172A",
        mutedText: "#64748B",
        border: "#CBD5E1",
        success: "#15803D",
        warning: "#B45309",
        error: "#B91C1C",
        custom: {},
      },
      typography: {
        display: defaultTypography(38, 700),
        heading1: defaultTypography(32, 700),
        heading2: defaultTypography(25, 600),
        heading3: defaultTypography(20, 600),
        body: defaultTypography(16, 400),
        caption: defaultTypography(12, 400),
        button: defaultTypography(14, 600),
      },
      spacing: [4, 8, 12, 16, 24, 32],
      radii: [4, 8, 12, 20],
      stroke: 1,
      shadow: { color: "#0F172A", opacity: 0.12, offsetX: 0, offsetY: 6, radius: 18 },
      grid: {
        mobileColumns: 4,
        desktopColumns: 12,
        mobileGutter: 12,
        desktopGutter: 24,
        desktopBreakpoint: 900,
      },
      density: "comfortable",
      components: { buttonRadius: 12, cardRadius: 16, inputRadius: 10, buttonHeight: 48 },
      themes: [],
    },
    assets: [],
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  return btoa(binary);
}

function assetHash(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

function downloadJson(value: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => bytesToBase64(new Uint8Array(buffer)));
}

function useAssetPreview(
  kit: BrandKitRevision | null,
  preferredVariant: "primary" | "alternate" | "monochrome",
) {
  const [loadedPreview, setLoadedPreview] = useState<{
    key: string;
    src: string;
    name: string;
  } | null>(null);
  const [missingAssetKey, setMissingAssetKey] = useState("");
  const asset =
    kit?.assets.find(({ variant }) => variant === preferredVariant) ??
    kit?.assets.find(({ variant }) => variant === "primary") ??
    kit?.assets[0];
  const assetKey = asset
    ? `${asset.assetId}:${asset.contentHash}:${asset.mimeType}:${asset.name}`
    : "";
  useEffect(() => {
    let current = true;
    if (!asset)
      return () => {
        current = false;
      };
    void brandKitRequest({ action: "load-asset", assetId: asset.assetId })
      .then((result) => {
        if (!current) return;
        if (!result.success || !result.assetBase64) {
          setMissingAssetKey(assetKey);
          return;
        }
        setLoadedPreview({
          key: assetKey,
          src: `data:${asset.mimeType};base64,${result.assetBase64}`,
          name: asset.name,
        });
      })
      .catch(() => current && setMissingAssetKey(assetKey));
    return () => {
      current = false;
    };
  }, [asset, assetKey]);
  return {
    preview: loadedPreview?.key === assetKey ? loadedPreview : null,
    missing: Boolean(assetKey && missingAssetKey === assetKey),
  };
}

export function BrandKitManager({
  snapshot,
  loading,
  loadError,
  createNew = false,
  onSnapshot,
  onNavigate,
}: {
  snapshot: BrandKitStoreSnapshot | null;
  loading: boolean;
  loadError: string;
  createNew?: boolean;
  onSnapshot: (snapshot: BrandKitStoreSnapshot) => void;
  onNavigate: (view: PluginView) => void;
}) {
  const [draft, setDraft] = useState<BrandKitRevision | null>(() =>
    createNew ? newBrandKit() : null,
  );
  const [selectedId, setSelectedId] = useState(() => draft?.id ?? "");
  const [dirty, setDirty] = useState(createNew);
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"default" | "name" | "recent">("default");
  const [showArchived, setShowArchived] = useState(false);
  const [previewMode, setPreviewMode] = useState<"light" | "dark">("light");
  const [previewDirection, setPreviewDirection] = useState<"rtl" | "ltr">("rtl");
  const [previewSize, setPreviewSize] = useState<"mobile" | "desktop">("mobile");
  const [assetError, setAssetError] = useState("");
  const [rightsNote, setRightsNote] = useState("");
  const [assetVariant, setAssetVariant] = useState<"primary" | "alternate" | "monochrome">(
    "primary",
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const brands = useMemo(() => snapshot?.brands ?? [], [snapshot?.brands]);
  const selected =
    brands.find(({ id }) => id === selectedId) ??
    (selectedId ? null : (brands.find(({ id }) => id === snapshot?.defaultBrandId) ?? brands[0])) ??
    null;
  const activeDraft = dirty ? draft : (selected ?? draft);
  const { preview: assetPreview, missing: assetMissing } = useAssetPreview(
    activeDraft,
    assetVariant,
  );
  const readOnly = snapshot?.integrity === "future-readonly";
  const filteredBrands = useMemo(
    () =>
      brands
        .filter(({ status }) => showArchived || status === "active")
        .filter(({ name, description }) =>
          `${name} ${description ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
        )
        .sort((first, second) =>
          sortBy === "recent"
            ? second.updatedAt - first.updatedAt
            : sortBy === "name"
              ? first.name.localeCompare(second.name, "fa")
              : Number(second.id === snapshot?.defaultBrandId) -
                  Number(first.id === snapshot?.defaultBrandId) ||
                first.name.localeCompare(second.name, "fa"),
        ),
    [brands, search, showArchived, snapshot?.defaultBrandId, sortBy],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (mutate: (source: BrandKitRevision) => BrandKitRevision) => {
    setDraft((current) => {
      const source = current ?? selected;
      return source ? mutate(structuredClone(source)) : current;
    });
    setDirty(true);
    setNotice("");
  };
  const editCustomColor = (name: string, color: string) =>
    update((source) => ({
      ...source,
      tokens: {
        ...source.tokens,
        palette: {
          ...source.tokens.palette,
          custom: { ...source.tokens.palette.custom, [name]: color },
        },
      },
    }));
  const addCustomColor = () =>
    update((source) => ({
      ...source,
      tokens: {
        ...source.tokens,
        palette: {
          ...source.tokens.palette,
          custom: {
            ...source.tokens.palette.custom,
            [`custom-${Object.keys(source.tokens.palette.custom).length + 1}`]: "#64748B",
          },
        },
      },
    }));
  const removeCustomColor = (name: string) =>
    update((source) => {
      const custom = { ...source.tokens.palette.custom };
      delete custom[name];
      return {
        ...source,
        tokens: { ...source.tokens, palette: { ...source.tokens.palette, custom } },
      };
    });
  const editThemeColor = (mode: "light" | "dark", role: BrandColorRole, color: string) =>
    update((source) => ({
      ...source,
      tokens: {
        ...source.tokens,
        themes: source.tokens.themes.map((theme) =>
          theme.mode === mode ? { ...theme, palette: { ...theme.palette, [role]: color } } : theme,
        ),
      },
    }));
  const editThemeInheritance = (mode: "light" | "dark", inherits: "base" | "light" | "dark") =>
    update((source) => ({
      ...source,
      tokens: {
        ...source.tokens,
        themes: source.tokens.themes.map((theme) =>
          theme.mode === mode ? { ...theme, inherits } : theme,
        ),
      },
    }));
  const addTheme = (mode: "light" | "dark") =>
    update((source) => ({
      ...source,
      tokens: {
        ...source.tokens,
        themes: [...source.tokens.themes, { mode, inherits: "base" as const, palette: {} }],
      },
    }));
  const removeTheme = (mode: "light" | "dark") =>
    update((source) => ({
      ...source,
      tokens: {
        ...source.tokens,
        themes: source.tokens.themes.filter((theme) => theme.mode !== mode),
      },
    }));
  const confirmDiscard = () => !dirty || window.confirm("تغییرهای ذخیره‌نشده کنار گذاشته شوند؟");
  const command = async (payload: BrandKitStorageCommand) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await brandKitRequest(payload);
      if (!result.success) throw new Error(result.error ?? "ذخیره انجام نشد.");
      if (result.snapshot) onSnapshot(result.snapshot);
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ذخیره انجام نشد.");
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!draft) return;
    const parsed = BrandKitRevisionSchema.safeParse(draft);
    if (!parsed.success) {
      setNotice(`مقادیر برند معتبر نیستند: ${parsed.error.issues[0]?.message ?? "بررسی ورودی‌ها"}`);
      return;
    }
    const currentRevision = brands.find(({ id }) => id === draft.id)?.revision ?? null;
    try {
      const result = await command({
        action: "save",
        kit: parsed.data,
        expectedRevision: currentRevision,
      });
      const saved = result.snapshot?.brands.find(({ id }) => id === draft.id);
      if (saved) {
        setDraft(saved);
        setSelectedId(saved.id);
        setDirty(false);
        setNotice(`نسخهٔ ${saved.revision} ذخیره شد.`);
      }
    } catch {
      /* The stored revision remains the source of truth. */
    }
  };
  const create = () => {
    if (!confirmDiscard()) return;
    const kit = newBrandKit();
    setSelectedId(kit.id);
    setDraft(kit);
    setDirty(true);
    setTab("overview");
    setNotice("برند تازه ساخته شد؛ برای ثبت دائمی ذخیره را بزنید.");
  };
  const selectBrand = (kit: BrandKitRevision) => {
    if (!confirmDiscard()) return;
    setSelectedId(kit.id);
    setDraft(kit);
    setDirty(false);
    setTab("overview");
    setNotice("");
  };
  const setDefault = async () => {
    if (!activeDraft || activeDraft.status !== "active" || dirty) return;
    try {
      await command({ action: "set-default", brandId: activeDraft.id });
      setNotice("این برند برای کارهای تازه انتخاب شد.");
    } catch {
      /* error is shown in the view */
    }
  };
  const changeStatus = async () => {
    if (dirty || !selected) return;
    const status = selected.status === "active" ? "archived" : "active";
    if (
      status === "archived" &&
      !window.confirm("این برند بایگانی شود؟ کارهای ذخیره‌شده نسخهٔ خود را نگه می‌دارند.")
    )
      return;
    try {
      const result = await command({ action: "set-status", brandId: selected.id, status });
      const saved = result.snapshot?.brands.find(({ id }) => id === selected.id);
      if (saved) {
        setDraft(saved);
        setDirty(false);
        setNotice(status === "archived" ? "برند بایگانی شد." : "برند بازگردانی شد.");
      }
    } catch {
      /* error is shown in the view */
    }
  };
  const duplicate = async () => {
    if (!selected || dirty || !confirmDiscard()) return;
    const copy = BrandKitRevisionSchema.parse({
      ...structuredClone(selected),
      id: makeId("brand"),
      revision: 1,
      name: `${selected.name} (کپی)`,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    try {
      const result = await command({ action: "save", kit: copy, expectedRevision: null });
      const saved = result.snapshot?.brands.find(({ id }) => id === copy.id);
      if (saved) {
        setSelectedId(saved.id);
        setDraft(saved);
        setDirty(false);
        setNotice("یک نسخهٔ مستقل ساخته شد.");
      }
    } catch {
      /* error is shown in the view */
    }
  };
  const uploadAsset = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeDraft) return;
    if (file.size > BRAND_KIT_MAX_ASSET_BYTES) {
      setAssetError("هر فایل نشان حداکثر ۲۵۶ کیلوبایت است.");
      return;
    }
    const rights = rightsNote.trim();
    if (rights.length < 2) {
      setAssetError("منشأ و مجوز استفاده از نشان را ثبت کنید.");
      return;
    }
    if (activeDraft.assets.some(({ variant }) => variant === assetVariant)) {
      setAssetError("این گونه قبلاً ثبت شده است؛ گونهٔ دیگری انتخاب کنید.");
      return;
    }
    const base64 = await fileToBase64(file);
    const validated = validateBrandAsset(file.type, base64);
    if (!validated.valid) {
      setAssetError(validated.error);
      return;
    }
    if (activeDraft.assets.length >= 8) {
      setAssetError("هر نسخه حداکثر ۸ فایل نشان دارد.");
      return;
    }
    const assetId = makeId("asset");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    if (bytes.byteLength > BRAND_KIT_MAX_ASSET_BYTES) {
      setAssetError("اندازهٔ فایل از حد مجاز بیشتر است.");
      return;
    }
    setBusy(true);
    try {
      const saved = await brandKitRequest({
        action: "save-asset",
        assetId,
        mimeType: file.type,
        base64,
      });
      if (!saved.success) throw new Error(saved.error ?? "فایل ذخیره نشد.");
      const asset = {
        assetId,
        kind: validated.kind,
        variant: assetVariant,
        name: file.name.slice(0, 120),
        mimeType: file.type as "image/png" | "image/jpeg" | "image/gif" | "image/svg+xml",
        width: validated.width,
        height: validated.height,
        contentHash: assetHash(base64),
        provenance: "user-provided" as const,
        rightsNote: rights,
        createdAt: Date.now(),
      };
      update((source) => ({ ...source, assets: [...source.assets, asset] }));
      setRightsNote("");
      setAssetError("");
      setNotice("فایل محلی ذخیره شد؛ نسخهٔ برند را هم ذخیره کنید.");
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : "فایل نشان ذخیره نشد.");
    } finally {
      setBusy(false);
    }
  };
  const exportBrand = async () => {
    if (!selected || dirty) return;
    try {
      const assets = [];
      for (const asset of selected.assets) {
        const result = await brandKitRequest({ action: "load-asset", assetId: asset.assetId });
        if (!result.success || !result.assetBase64)
          throw new Error("یکی از فایل‌های نشان موجود نیست.");
        assets.push({ assetId: asset.assetId, base64: result.assetBase64 });
      }
      const data = BrandKitExportSchema.parse({
        schema: "figma-ai-brand-kit",
        schemaVersion: 1,
        brand: selected,
        assets,
      });
      downloadJson(data, `brand-${selected.id}-r${selected.revision}.json`);
      setNotice("خروجی JSON آماده شد.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "خروجی آماده نشد.");
    }
  };
  const importBrand = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setNotice("فایل واردات حداکثر ۱ مگابایت است.");
      return;
    }
    try {
      const raw: unknown = JSON.parse(await file.text());
      if (rejectPrototypeKeys(raw)) throw new Error("کلیدهای ناامن در فایل واردات وجود دارد.");
      const parsed = BrandKitExportSchema.safeParse(raw);
      if (!parsed.success) throw new Error("فایل Brand Kit با نسخهٔ معتبر سازگار نیست.");
      if (!window.confirm("این برند به‌عنوان یک کپی جدید وارد شود؟ برندهای موجود تغییر نمی‌کنند."))
        return;
      const data = structuredClone(parsed.data);
      data.brand.id = makeId("brand");
      data.brand.revision = 1;
      data.brand.name = `${data.brand.name} (واردشده)`;
      data.brand.status = "active";
      data.brand.createdAt = Date.now();
      data.brand.updatedAt = Date.now();
      const map = new Map(data.brand.assets.map(({ assetId }) => [assetId, makeId("asset")]));
      data.brand.assets = data.brand.assets.map((asset) => ({
        ...asset,
        assetId: map.get(asset.assetId)!,
      }));
      data.assets = data.assets.map((asset) => ({
        ...asset,
        assetId: map.get(asset.assetId) ?? asset.assetId,
      }));
      const result = await command({ action: "import", data });
      const saved = result.snapshot?.brands.find(({ id }) => id === data.brand.id);
      if (saved) {
        setSelectedId(saved.id);
        setDraft(saved);
        setDirty(false);
        setNotice("برند وارد شد و نسخهٔ تازه‌ای ساخت.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "فایل وارد نشد.");
    }
  };

  const token = activeDraft?.tokens;
  const previewTokens = activeDraft
    ? resolveBrandKitTokens(pinBrandKit(activeDraft), previewMode)
    : token;
  const contrastPairs = token
    ? [
        {
          label: "متن/پس‌زمینه",
          ratio: colorContrastRatio(token.palette.text, token.palette.background),
        },
        { label: "متن/سطح", ratio: colorContrastRatio(token.palette.text, token.palette.surface) },
        {
          label: "متن کم‌رنگ/پس‌زمینه",
          ratio: colorContrastRatio(token.palette.mutedText, token.palette.background),
        },
        {
          label: "متن کم‌رنگ/سطح",
          ratio: colorContrastRatio(token.palette.mutedText, token.palette.surface),
        },
      ]
    : [];
  const currentDefault = snapshot?.brands.find(({ id }) => id === snapshot.defaultBrandId);

  return (
    <section className="route-page brand-kit-page" aria-labelledby="route-heading" dir="rtl">
      <button
        className="text-button route-back"
        type="button"
        onClick={() => {
          if (confirmDiscard()) onNavigate("more");
        }}
      >
        ‹ بیشتر
      </button>
      <div className="brand-kit-heading page-heading">
        <div>
          <span className="page-eyebrow">هویت و توکن‌های طراحی</span>
          <h1 id="route-heading" tabIndex={-1}>
            مدیریت کیت برند
          </h1>
          <p className="page-description">
            کیت‌های محلی برای ساخت‌های تازه؛ هر کار ذخیره‌شده نسخهٔ خودش را نگه می‌دارد.
          </p>
        </div>
        <button
          className="primary-action"
          type="button"
          onClick={create}
          disabled={busy || readOnly}
        >
          ＋ برند تازه
        </button>
      </div>
      {loadError && (
        <div className="brand-kit-alert" role="alert">
          {loadError}
        </div>
      )}
      {snapshot?.integrity === "recovered" && (
        <div className="brand-kit-integrity" role="status">
          چند رکورد ناسازگار در آرشیو ایمنی نگه‌داری شد.{" "}
          {snapshot.preservedRecordCount
            ? `${snapshot.preservedRecordCount} مورد`
            : "نسخه‌های سالم بازیابی شدند."}
        </div>
      )}
      {snapshot?.integrity === "future-readonly" && (
        <div className="brand-kit-integrity" role="alert">
          یک رکورد با نسخهٔ جدیدتر شناسایی شد. ویرایش تا حفظ کامل داده متوقف است.
        </div>
      )}
      {notice && (
        <div className="brand-kit-notice" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <div className="brand-kit-empty" role="status">
          در حال بارگذاری برندهای محلی…
        </div>
      ) : (
        <div className="brand-kit-layout">
          <aside className="brand-kit-list route-card" aria-label="فهرست برندها">
            <label className="brand-kit-search">
              جست‌وجو
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="نام برند…"
              />
            </label>
            <label className="brand-kit-search">
              مرتب‌سازی
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
              >
                <option value="default">پیش‌فرض نخست</option>
                <option value="name">نام</option>
                <option value="recent">آخرین ویرایش</option>
              </select>
            </label>
            <label className="brand-kit-filter">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />{" "}
              نمایش بایگانی‌شده‌ها
            </label>
            <div className="brand-kit-brand-list" role="list">
              {filteredBrands.map((brand) => (
                <button
                  key={brand.id}
                  type="button"
                  role="listitem"
                  className={`brand-kit-brand-row ${brand.id === selected?.id ? "is-selected" : ""}`}
                  onClick={() => selectBrand(brand)}
                >
                  <span
                    className="brand-kit-swatch"
                    style={{ background: brand.tokens.palette.primary }}
                    aria-hidden="true"
                  />
                  <span className="brand-kit-row-copy">
                    <strong>{brand.name}</strong>
                    <small>
                      نسخه {brand.revision} · {brand.status === "active" ? "فعال" : "بایگانی"}
                    </small>
                  </span>
                  {brand.id === snapshot?.defaultBrandId && (
                    <span className="brand-kit-default-badge">پیش‌فرض</span>
                  )}
                </button>
              ))}
              {!filteredBrands.length && (
                <p className="brand-kit-list-empty">هنوز برندی در این فهرست نیست.</p>
              )}
            </div>
            <div className="brand-kit-list-actions">
              <label className="secondary-action brand-kit-file-button">
                واردکردن JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => void importBrand(event)}
                  disabled={readOnly}
                />
              </label>
              <button
                className="secondary-action"
                type="button"
                disabled={!selected || dirty || busy}
                onClick={() => void exportBrand()}
              >
                خروجی JSON
              </button>
            </div>
          </aside>
          {activeDraft && token ? (
            <main className="brand-kit-editor">
              <fieldset disabled={readOnly} className="brand-kit-editor-fields">
                <div className="brand-kit-editor-toolbar route-card">
                  <div>
                    <strong>{activeDraft.name || "برند بدون نام"}</strong>
                    <span>
                      نسخهٔ در حال ویرایش:{" "}
                      {selected?.id === activeDraft.id ? selected.revision : "پیش‌نویس"}
                      {dirty ? " · ذخیره‌نشده" : ""}
                    </span>
                  </div>
                  <div className="brand-kit-actions">
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={
                        busy ||
                        dirty ||
                        selected?.status !== "active" ||
                        currentDefault?.id === selected?.id
                      }
                      onClick={() => void setDefault()}
                    >
                      انتخاب برای کارهای تازه
                    </button>
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={busy || dirty || !selected}
                      onClick={() => void duplicate()}
                    >
                      کپی
                    </button>
                    {selected && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy || dirty}
                        onClick={() => void changeStatus()}
                      >
                        {selected.status === "active" ? "بایگانی" : "بازگردانی"}
                      </button>
                    )}
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy || !dirty}
                      onClick={() => {
                        if (confirmDiscard()) {
                          setDraft(selected);
                          setDirty(false);
                        }
                      }}
                    >
                      لغو
                    </button>
                    <button
                      className="primary-action"
                      type="button"
                      disabled={busy || !dirty}
                      onClick={() => void save()}
                    >
                      {busy ? "در حال ذخیره…" : "ذخیره نسخه"}
                    </button>
                  </div>
                </div>
                <div className="brand-kit-pinned" role="status">
                  {currentDefault ? (
                    <>
                      انتخاب فعلی برای کارهای جدید: <bdi>{currentDefault.name}</bdi> · نسخه{" "}
                      {currentDefault.revision}
                    </>
                  ) : (
                    "برای کارهای تازه هنوز برند پیش‌فرض انتخاب نشده است."
                  )}
                  {selected?.id !== currentDefault?.id && selected && (
                    <> · کارهای مرتبط با این برند نسخهٔ پین‌شدهٔ خود را دارند.</>
                  )}
                </div>
                <nav className="brand-kit-tabs" aria-label="بخش‌های ویرایش برند">
                  {[
                    ["overview", "نمای کلی"],
                    ["colors", "رنگ‌ها"],
                    ["typography", "تایپوگرافی"],
                    ["assets", "نشان و فایل‌ها"],
                    ["tokens", "توکن‌ها"],
                    ["preview", "پیش‌نمایش"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-current={tab === id ? "page" : undefined}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                {tab === "overview" && (
                  <section className="route-card brand-kit-form-grid" aria-label="اطلاعات برند">
                    <label>
                      نام برند
                      <input
                        value={activeDraft.name}
                        maxLength={100}
                        onChange={(event) =>
                          update((source) => ({ ...source, name: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      توضیح
                      <textarea
                        value={activeDraft.description ?? ""}
                        maxLength={500}
                        rows={3}
                        onChange={(event) =>
                          update((source) => ({ ...source, description: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      زبان محتوا
                      <select
                        value={activeDraft.locale}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            locale: event.target.value as BrandKitRevision["locale"],
                          }))
                        }
                      >
                        <option value="fa">فارسی</option>
                        <option value="en">English</option>
                        <option value="mixed">ترکیبی</option>
                      </select>
                    </label>
                    <label>
                      جهت پیش‌فرض
                      <select
                        value={activeDraft.direction}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            direction: event.target.value as BrandKitRevision["direction"],
                          }))
                        }
                      >
                        <option value="rtl">راست‌به‌چپ</option>
                        <option value="ltr">چپ‌به‌راست</option>
                        <option value="auto">تشخیص از زبان</option>
                      </select>
                    </label>
                    <label>
                      یادداشت‌های داخلی
                      <textarea
                        value={activeDraft.notes ?? ""}
                        maxLength={1000}
                        rows={3}
                        onChange={(event) =>
                          update((source) => ({ ...source, notes: event.target.value }))
                        }
                      />
                    </label>
                    <p className="brand-kit-note">
                      شناسهٔ پایدار: <bdi dir="ltr">{activeDraft.id}</bdi> · شناسه تغییر نمی‌کند؛ هر
                      ذخیره یک نسخهٔ تازه می‌سازد.
                    </p>
                  </section>
                )}
                {tab === "colors" && (
                  <section className="route-card brand-kit-color-grid" aria-label="پالت معنایی رنگ">
                    {colorRoles.map(([role, label]) => (
                      <label className="brand-kit-color-control" key={role}>
                        <span>{label}</span>
                        <input
                          aria-label={`رنگ ${label}`}
                          type="color"
                          value={token.palette[role]}
                          onChange={(event) =>
                            update((source) => ({
                              ...source,
                              tokens: {
                                ...source.tokens,
                                palette: {
                                  ...source.tokens.palette,
                                  [role]: event.target.value.toUpperCase(),
                                },
                              },
                            }))
                          }
                        />
                        <input
                          aria-label={`کد HEX ${label}`}
                          dir="ltr"
                          value={token.palette[role]}
                          maxLength={7}
                          onChange={(event) =>
                            update((source) => ({
                              ...source,
                              tokens: {
                                ...source.tokens,
                                palette: { ...source.tokens.palette, [role]: event.target.value },
                              },
                            }))
                          }
                        />
                      </label>
                    ))}
                    <div
                      className="brand-kit-contrast"
                      role="status"
                      aria-label="بررسی کنتراست متن"
                    >
                      {contrastPairs.map(({ label, ratio }) => (
                        <span key={label} data-pass={ratio >= 4.5}>
                          {label}: {ratio.toFixed(2)}:1 ·{" "}
                          {ratio >= 4.5 ? "مطابق AA" : "نیازمند بهبود"}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
                {tab === "typography" && (
                  <section
                    className="route-card brand-kit-typography-list"
                    aria-label="نقش‌های تایپوگرافی"
                  >
                    {typographyRoles.map(([role, label]) => {
                      const style = token.typography[role];
                      return (
                        <fieldset key={role} className="brand-kit-type-role">
                          <legend>{label}</legend>
                          <label>
                            فونت درخواستی
                            <input
                              value={style.requestedFamily}
                              maxLength={100}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        requestedFamily: event.target.value,
                                      },
                                    },
                                  },
                                }))
                              }
                            />
                          </label>
                          <label>
                            جایگزین ثبت‌شده
                            <input
                              value={style.fallbackFamily}
                              maxLength={100}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        fallbackFamily: event.target.value,
                                      },
                                    },
                                  },
                                }))
                              }
                            />
                          </label>
                          <label>
                            سبک درخواستی
                            <input
                              value={style.style}
                              maxLength={80}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        style: event.target.value,
                                      },
                                    },
                                  },
                                }))
                              }
                            />
                          </label>
                          <label>
                            اندازه
                            <input
                              type="number"
                              min={8}
                              max={96}
                              value={style.size}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        size: Number(event.target.value),
                                      },
                                    },
                                  },
                                }))
                              }
                            />
                          </label>
                          <label>
                            وزن
                            <select
                              value={style.weight}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        weight: Number(event.target.value),
                                        style:
                                          Number(event.target.value) >= 600
                                            ? "Bold"
                                            : Number(event.target.value) >= 500
                                              ? "Medium"
                                              : "Regular",
                                      },
                                    },
                                  },
                                }))
                              }
                            >
                              <option value={400}>۴۰۰</option>
                              <option value={500}>۵۰۰</option>
                              <option value={600}>۶۰۰</option>
                              <option value={700}>۷۰۰</option>
                            </select>
                          </label>
                          <label>
                            ارتفاع خط
                            <input
                              type="number"
                              min={8}
                              max={160}
                              value={style.lineHeight}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        lineHeight: Number(event.target.value),
                                      },
                                    },
                                  },
                                }))
                              }
                            />
                          </label>
                          <label>
                            فاصلهٔ حروف
                            <input
                              type="number"
                              min={-10}
                              max={20}
                              step={0.1}
                              value={style.letterSpacing}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        letterSpacing: Number(event.target.value),
                                      },
                                    },
                                  },
                                }))
                              }
                            />
                          </label>
                          <label>
                            تراز متن
                            <select
                              value={style.alignment}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        alignment: event.target.value as typeof style.alignment,
                                      },
                                    },
                                  },
                                }))
                              }
                            >
                              <option value="right">راست</option>
                              <option value="center">وسط</option>
                              <option value="left">چپ</option>
                              <option value="justified">دوطرفه</option>
                            </select>
                          </label>
                          <label>
                            جهت متن
                            <select
                              value={style.direction}
                              onChange={(event) =>
                                update((source) => ({
                                  ...source,
                                  tokens: {
                                    ...source.tokens,
                                    typography: {
                                      ...source.tokens.typography,
                                      [role]: {
                                        ...source.tokens.typography[role],
                                        direction: event.target.value as typeof style.direction,
                                      },
                                    },
                                  },
                                }))
                              }
                            >
                              <option value="auto">خودکار</option>
                              <option value="rtl">راست‌به‌چپ</option>
                              <option value="ltr">چپ‌به‌راست</option>
                            </select>
                          </label>
                          <span className="brand-kit-font-status">
                            فونت درخواستی هنگام ساخت بررسی می‌شود؛ جایگزین فقط پس از بررسی فونت‌های
                            واقعی فیگما انتخاب و گزارش می‌شود. نمونه: فارسی «طراحی برای همه» ·
                            English “Design for everyone”.
                          </span>
                        </fieldset>
                      );
                    })}
                  </section>
                )}
                {tab === "assets" && (
                  <section
                    className="route-card brand-kit-assets"
                    aria-label="نشان و دارایی‌های برند"
                  >
                    <div className="brand-kit-asset-preview">
                      {assetPreview ? (
                        <img src={assetPreview.src} alt={`پیش‌نمایش واقعی ${assetPreview.name}`} />
                      ) : (
                        <span>{assetMissing ? "فایل نشان پیدا نشد" : "پیش‌نمایش محلی نشان"}</span>
                      )}
                    </div>
                    <p>
                      فقط فایل محلیِ دارای منشأ و مجوز ثبت‌شده پذیرفته می‌شود. SVG به مسیرهای محدود
                      و قابل‌ویرایش تبدیل می‌شود؛ URL خارجی پذیرفته نیست.
                    </p>
                    <label>
                      گونهٔ نشان
                      <select
                        value={assetVariant}
                        onChange={(event) =>
                          setAssetVariant(event.target.value as typeof assetVariant)
                        }
                      >
                        <option value="primary">اصلی</option>
                        <option value="alternate">جایگزین</option>
                        <option value="monochrome">تک‌رنگ</option>
                      </select>
                    </label>
                    <label>
                      منشأ و حق استفاده
                      <input
                        value={rightsNote}
                        maxLength={500}
                        placeholder="مثلاً فایل رسمی ارائه‌شده توسط تیم برند"
                        onChange={(event) => setRightsNote(event.target.value)}
                      />
                    </label>
                    <label className="secondary-action brand-kit-file-button">
                      بارگذاری نشان محلی
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/svg+xml,.svg"
                        onChange={(event) => void uploadAsset(event)}
                        disabled={busy}
                      />
                    </label>
                    {assetError && (
                      <p className="brand-kit-alert" role="alert">
                        {assetError}
                      </p>
                    )}
                    {activeDraft.assets.map((asset) => (
                      <button
                        key={asset.assetId}
                        type="button"
                        className={`brand-kit-asset-row ${assetVariant === asset.variant ? "is-selected" : ""}`}
                        onClick={() => setAssetVariant(asset.variant)}
                      >
                        <strong>{asset.name}</strong>
                        <span>
                          {asset.variant} · {asset.width}×{asset.height} · {asset.rightsNote}
                        </span>
                        <code dir="ltr">
                          {asset.assetId} · {asset.contentHash}
                        </code>
                      </button>
                    ))}
                  </section>
                )}
                {tab === "tokens" && (
                  <section
                    className="route-card brand-kit-tokens"
                    aria-label="مقیاس و توکن‌های طراحی"
                  >
                    <label>
                      فاصله‌ها، جداشده با ویرگول
                      <input
                        dir="ltr"
                        value={token.spacing.join(", ")}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              spacing: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean)
                                .map(Number),
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      شعاع گوشه‌ها
                      <input
                        dir="ltr"
                        value={token.radii.join(", ")}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              radii: event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean)
                                .map(Number),
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      ضخامت خط
                      <input
                        type="number"
                        min={0.25}
                        max={16}
                        step={0.25}
                        value={token.stroke}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: { ...source.tokens, stroke: Number(event.target.value) },
                          }))
                        }
                      />
                    </label>
                    <label>
                      تراکم
                      <select
                        value={token.density}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              density: event.target.value as typeof source.tokens.density,
                            },
                          }))
                        }
                      >
                        <option value="comfortable">متوازن</option>
                        <option value="compact">فشرده</option>
                        <option value="spacious">باز</option>
                      </select>
                    </label>
                    <label>
                      گوشهٔ دکمه
                      <input
                        type="number"
                        min={0}
                        max={128}
                        value={token.components.buttonRadius}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              components: {
                                ...source.tokens.components,
                                buttonRadius: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      گوشهٔ کارت
                      <input
                        type="number"
                        min={0}
                        max={128}
                        value={token.components.cardRadius}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              components: {
                                ...source.tokens.components,
                                cardRadius: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      گوشهٔ ورودی
                      <input
                        type="number"
                        min={0}
                        max={128}
                        value={token.components.inputRadius}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              components: {
                                ...source.tokens.components,
                                inputRadius: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      ارتفاع دکمه
                      <input
                        type="number"
                        min={32}
                        max={72}
                        value={token.components.buttonHeight}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              components: {
                                ...source.tokens.components,
                                buttonHeight: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      ستون‌های موبایل
                      <input
                        type="number"
                        min={2}
                        max={8}
                        value={token.grid.mobileColumns}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              grid: {
                                ...source.tokens.grid,
                                mobileColumns: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      ستون‌های دسکتاپ
                      <input
                        type="number"
                        min={4}
                        max={24}
                        value={token.grid.desktopColumns}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              grid: {
                                ...source.tokens.grid,
                                desktopColumns: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      فاصلهٔ کناری موبایل
                      <input
                        type="number"
                        min={0}
                        max={64}
                        value={token.grid.mobileGutter}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              grid: {
                                ...source.tokens.grid,
                                mobileGutter: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      فاصلهٔ کناری دسکتاپ
                      <input
                        type="number"
                        min={0}
                        max={128}
                        value={token.grid.desktopGutter}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              grid: {
                                ...source.tokens.grid,
                                desktopGutter: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      نقطهٔ شکست دسکتاپ
                      <input
                        type="number"
                        min={600}
                        max={2000}
                        value={token.grid.desktopBreakpoint}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              grid: {
                                ...source.tokens.grid,
                                desktopBreakpoint: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      رنگ سایه
                      <input
                        type="color"
                        value={token.shadow.color}
                        aria-label="رنگ سایه"
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              shadow: {
                                ...source.tokens.shadow,
                                color: event.target.value.toUpperCase(),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      شدت سایه
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={token.shadow.opacity}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              shadow: {
                                ...source.tokens.shadow,
                                opacity: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      جابجایی افقی سایه
                      <input
                        type="number"
                        min={-100}
                        max={100}
                        value={token.shadow.offsetX}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              shadow: {
                                ...source.tokens.shadow,
                                offsetX: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      جابجایی عمودی سایه
                      <input
                        type="number"
                        min={-100}
                        max={100}
                        value={token.shadow.offsetY}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              shadow: {
                                ...source.tokens.shadow,
                                offsetY: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      محو سایه
                      <input
                        type="number"
                        min={0}
                        max={128}
                        value={token.shadow.radius}
                        onChange={(event) =>
                          update((source) => ({
                            ...source,
                            tokens: {
                              ...source.tokens,
                              shadow: {
                                ...source.tokens.shadow,
                                radius: Number(event.target.value),
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <div className="brand-kit-custom-colors">
                      <strong>رنگ‌های معنایی اختصاصی</strong>
                      {Object.entries(token.palette.custom).map(([name, color]) => (
                        <div key={name} className="brand-kit-custom-color">
                          <label>
                            {name}
                            <input
                              type="color"
                              aria-label={`رنگ ${name}`}
                              value={color}
                              onChange={(event) =>
                                editCustomColor(name, event.target.value.toUpperCase())
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`حذف ${name}`}
                            onClick={() => removeCustomColor(name)}
                          >
                            حذف
                          </button>
                        </div>
                      ))}
                      <button type="button" className="secondary-action" onClick={addCustomColor}>
                        ＋ رنگ معنایی
                      </button>
                    </div>
                    <div className="brand-kit-theme-controls">
                      <strong>تم‌های روشن و تیره</strong>
                      {(["light", "dark"] as const).map((mode) => {
                        const theme = token.themes.find((item) => item.mode === mode);
                        return (
                          <fieldset key={mode} className="brand-kit-theme-row">
                            <legend>{mode === "light" ? "روشن" : "تیره"}</legend>
                            {theme ? (
                              <>
                                <label>
                                  ارث‌بری از
                                  <select
                                    value={theme.inherits}
                                    onChange={(event) =>
                                      editThemeInheritance(
                                        mode,
                                        event.target.value as typeof theme.inherits,
                                      )
                                    }
                                  >
                                    <option value="base">پایه</option>
                                    <option value={mode === "light" ? "dark" : "light"}>
                                      {mode === "light" ? "تیره" : "روشن"}
                                    </option>
                                  </select>
                                </label>
                                {colorRoles.map(([role, label]) => (
                                  <label key={role}>
                                    {label}
                                    <input
                                      type="color"
                                      aria-label={`${mode} ${label}`}
                                      value={theme.palette[role] ?? token.palette[role]}
                                      onChange={(event) =>
                                        editThemeColor(mode, role, event.target.value.toUpperCase())
                                      }
                                    />
                                  </label>
                                ))}
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() => removeTheme(mode)}
                                >
                                  حذف تم
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="secondary-action"
                                onClick={() => addTheme(mode)}
                              >
                                افزودن تم {mode === "light" ? "روشن" : "تیره"}
                              </button>
                            )}
                          </fieldset>
                        );
                      })}
                    </div>
                    <p>
                      پیش‌نمایش تم، جهت و اندازه فقط روی این کارت محلی اثر دارد؛ بوم فیگما تغییر
                      نمی‌کند.
                    </p>
                  </section>
                )}
                {tab === "preview" && previewTokens && (
                  <section
                    className={`brand-kit-preview route-card is-${previewMode}`}
                    dir={previewDirection}
                    data-brand-preview="read-only"
                  >
                    <div className="brand-kit-preview-controls">
                      <button
                        type="button"
                        onClick={() => setPreviewMode(previewMode === "light" ? "dark" : "light")}
                      >
                        تم {previewMode === "light" ? "روشن" : "تیره"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewDirection(previewDirection === "rtl" ? "ltr" : "rtl")
                        }
                      >
                        جهت {previewDirection.toUpperCase()}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewSize(previewSize === "mobile" ? "desktop" : "mobile")
                        }
                      >
                        پیش‌نمایش {previewSize === "mobile" ? "موبایل" : "دسکتاپ"}
                      </button>
                    </div>
                    <div
                      className={`brand-kit-preview-stage is-${previewSize}`}
                      style={{
                        background: previewTokens.palette.background,
                        color: previewTokens.palette.text,
                      }}
                    >
                      <header className="brand-kit-preview-header">
                        <strong>
                          {assetPreview ? (
                            <img src={assetPreview.src} alt="نشان برند" />
                          ) : (
                            activeDraft.name
                          )}
                        </strong>
                        <span>
                          {previewDirection === "rtl"
                            ? "خانه   محصولات   دربارهٔ ما"
                            : "Home   Products   About"}
                        </span>
                      </header>
                      <div className="brand-kit-preview-hero">
                        <small>پیش‌نمایش محلی · {activeDraft.name}</small>
                        <h2
                          style={{
                            fontFamily: previewTokens.typography.heading1.requestedFamily,
                            fontSize: previewTokens.typography.heading1.size,
                          }}
                        >
                          طراحی هماهنگ، در هر صفحه
                        </h2>
                        <p style={{ fontFamily: previewTokens.typography.body.requestedFamily }}>
                          A flexible brand system for real products and teams.
                        </p>
                        <button
                          style={{
                            background: previewTokens.palette.primary,
                            borderRadius: previewTokens.components.buttonRadius,
                            minHeight: previewTokens.components.buttonHeight,
                          }}
                        >
                          شروع کنید
                        </button>
                      </div>
                      <article
                        className="brand-kit-preview-product"
                        style={{
                          background: previewTokens.palette.surface,
                          borderRadius: previewTokens.components.cardRadius,
                          borderColor: previewTokens.palette.border,
                        }}
                      >
                        <span
                          className="brand-kit-preview-image"
                          style={{ background: previewTokens.palette.accent }}
                          aria-hidden="true"
                        />
                        <div>
                          <strong>کالای نمونه</strong>
                          <p>متن پیش‌نمایش؛ بدون تغییر در بوم فیگما</p>
                          <bdi>۲٬۴۸۰٬۰۰۰ تومان</bdi>
                        </div>
                      </article>
                    </div>
                  </section>
                )}
              </fieldset>
            </main>
          ) : (
            <section className="brand-kit-empty route-card">
              <strong>هنوز کیتی ذخیره نشده است.</strong>
              <p>یک برند بسازید تا رنگ‌ها، فونت‌ها و توکن‌های محلی را تعریف کنید.</p>
              <button className="primary-action" type="button" onClick={create} disabled={readOnly}>
                ساخت اولین برند
              </button>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
