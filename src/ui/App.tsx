import { useEffect, useMemo, useRef, useState } from "react";
import phase1Sample from "../samples/sample-design.json?raw";
import phase2Sample from "../samples/phase-2-storefront.json?raw";
import phase3Sample from "../samples/phase-3-design-system.json?raw";
import phase4Sample from "../samples/phase-4-multi-screen.json?raw";
import phase45Sample from "../samples/phase-4.5-visual-design.json?raw";
import visualLtrFixture from "../samples/visual-ltr-fixture.json?raw";
import { parseDesignText } from "../shared/schema";
import {
  PluginToUISchema,
  type MultiScreenProgressMessage,
  type MultiScreenRenderResultMessage,
  type UIToPluginMessage,
} from "../shared/messages";
import { isMultiScreenInput, parseMultiScreenText } from "../shared/multi-screen-schema";
import {
  createMultiScreenPreview,
  multiScreenProgressText,
  multiScreenResultLines,
} from "../shared/multi-screen-preview";
import { planDesignSystemApply } from "../plugin/design-system/apply-design-system";
import { DEFAULT_MAX_ROW_WIDTH, DEFAULT_MIN_CANVAS_GAP } from "../plugin/canvas-placement";
import { auditVisualQuality, type VisualQualityAudit } from "../shared/visual-quality";
import { inspectEmbeddedImage, parseSafeSvg } from "../shared/visual-assets";

type Notice = {
  tone: "neutral" | "success" | "error";
  title: string;
  details?: string[];
};

function postToPlugin(message: UIToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function ErrorList({ errors }: { errors: string[] }) {
  return (
    <ul className="notice-list">
      {errors.map((error, index) => (
        <li key={`${index}-${error}`}>{error}</li>
      ))}
    </ul>
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary);
}

function rawAssetInventory(source: string): Array<Record<string, unknown>> {
  try {
    const value = JSON.parse(source) as { assets?: unknown };
    return Array.isArray(value.assets)
      ? value.assets.filter(
          (asset): asset is Record<string, unknown> => typeof asset === "object" && asset !== null,
        )
      : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [json, setJson] = useState(phase1Sample.trim());
  const [notice, setNotice] = useState<Notice>({
    tone: "neutral",
    title: "Ready to validate",
  });
  const [busy, setBusy] = useState(false);
  const [updateOwned, setUpdateOwned] = useState(false);
  const [canvasGap, setCanvasGap] = useState(DEFAULT_MIN_CANVAS_GAP);
  const [rowWidth, setRowWidth] = useState(DEFAULT_MAX_ROW_WIDTH);
  const [assetLicense, setAssetLicense] = useState("");
  const [assetAttribution, setAssetAttribution] = useState("");
  const [multiProgress, setMultiProgress] = useState<MultiScreenProgressMessage | null>(null);
  const [multiReport, setMultiReport] = useState<MultiScreenRenderResultMessage | null>(null);
  const currentRequest = useRef<string | null>(null);
  const parsed = useMemo(() => parseDesignText(json), [json]);
  const batchMode = useMemo(() => isMultiScreenInput(json), [json]);
  const batchParsed = useMemo(
    () => (batchMode ? parseMultiScreenText(json) : undefined),
    [batchMode, json],
  );
  const batchPreview = useMemo(
    () =>
      batchParsed?.success
        ? createMultiScreenPreview(batchParsed.data, batchParsed.nodeCount)
        : undefined,
    [batchParsed],
  );
  const visualAudit = useMemo<VisualQualityAudit | undefined>(() => {
    if (batchParsed?.success) return auditVisualQuality(batchParsed.data);
    if (parsed.success) return auditVisualQuality(parsed.data);
    return undefined;
  }, [batchParsed, parsed]);
  const assetInventory = useMemo(() => rawAssetInventory(json), [json]);
  const dryRun = parsed.success ? planDesignSystemApply(parsed.data) : undefined;
  const inputValid = batchMode ? Boolean(batchParsed?.success) : parsed.success;
  const placementOptionsValid =
    Number.isFinite(canvasGap) &&
    canvasGap >= 0 &&
    canvasGap <= 1_000 &&
    Number.isFinite(rowWidth) &&
    rowWidth >= 390 &&
    rowWidth <= 20_000;

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const raw = (event.data as { pluginMessage?: unknown } | null)?.pluginMessage;
      const result = PluginToUISchema.safeParse(raw);
      if (!result.success) return;
      const message = result.data;
      if (message.type === "protocol-error") {
        currentRequest.current = null;
        setBusy(false);
        setNotice({ tone: "error", title: message.message });
        return;
      }
      if (message.requestId !== currentRequest.current) return;

      if (message.type === "multi-screen-progress") {
        setMultiProgress(message);
        setNotice({
          tone: "neutral",
          title: "Generating screen " + message.index + " of " + message.total,
          details: [
            multiScreenProgressText(message),
            ...(message.message ? [message.message] : []),
          ],
        });
        return;
      }

      currentRequest.current = null;
      setBusy(false);
      if (message.type === "validation-result") {
        const counts = message.counts;
        if (message.success && message.multiScreen) {
          setNotice({
            tone: "success",
            title: "Multi-screen JSON is valid",
            details: [
              message.multiScreen.totalScreens +
                " screens · " +
                message.multiScreen.nodeCount +
                " estimated nodes.",
              ...(message.fontWarnings ?? []),
              ...message.multiScreen.screens.map(
                (screen) =>
                  screen.name +
                  " · " +
                  screen.width +
                  " × " +
                  screen.height +
                  (screen.devicePreset ? " · " + screen.devicePreset : "") +
                  (screen.group ? " · " + screen.group : ""),
              ),
            ],
          });
          return;
        }
        setNotice(
          message.success
            ? {
                tone: "success",
                title: "JSON is valid",
                details: [
                  `Schema 1.0.0 · ${counts?.frames ?? 0} frames, ${counts?.texts ?? 0} texts, ${counts?.rectangles ?? 0} rectangles, ${(counts?.ellipses ?? 0) + (counts?.vectors ?? 0)} editable vector/ellipse shapes, ${counts?.images ?? 0} image fills, ${counts?.components ?? 0} components, ${counts?.instances ?? 0} instances.`,
                  ...(message.fontWarnings ?? []),
                ],
              }
            : { tone: "error", title: "Validation failed", details: message.errors },
        );
      } else if (message.type === "render-error") {
        setNotice({
          tone: "error",
          title: message.message,
          details: message.errors,
        });
        setMultiProgress(null);
      } else if (message.type === "multi-screen-result") {
        setMultiProgress(null);
        setMultiReport(message);
        const tone =
          message.generatedScreens === message.totalScreens
            ? "success"
            : message.generatedScreens > 0
              ? "neutral"
              : "error";
        setNotice({
          tone,
          title: message.generatedScreens + " of " + message.totalScreens + " screens generated",
          details: multiScreenResultLines(message),
        });
      } else {
        const counts = message.counts;
        const fonts = [
          ...new Set(message.fontSelections.map((font) => `${font.usedFamily} ${font.usedStyle}`)),
        ];
        const visibleFonts = fonts.slice(0, 3).join(", ");
        const fontSummary = `${visibleFonts || "none"}${fonts.length > 3 ? `, +${fonts.length - 3} more` : ""}`;
        setNotice({
          tone: "success",
          title: `Created “${message.frameName}”`,
          details: [
            `${counts.frames} frames · ${counts.texts} texts · ${counts.rectangles} rectangles · ${(counts.ellipses ?? 0) + (counts.vectors ?? 0)} editable vector/ellipse shapes · ${counts.images ?? 0} image fills · ${counts.components} components · ${counts.instances} instances.`,
            `Fonts: ${fontSummary}.`,
            ...(message.designSystem
              ? [
                  `Design system ${message.designSystem.namespace}: created ${message.designSystem.created.length} · reused ${message.designSystem.reused.length} · updated ${message.designSystem.updated.length} · skipped ${message.designSystem.skipped.length}.`,
                  ...(message.designSystem.fallbacks.length
                    ? [`Fallbacks: ${message.designSystem.fallbacks.join("; ")}`]
                    : []),
                ]
              : []),
            ...message.warnings,
          ],
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const nextRequestId = () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const validate = () => {
    if (batchMode && !batchParsed?.success) {
      setNotice({
        tone: "error",
        title: "Multi-screen validation failed",
        details: batchParsed?.errors ?? ["Provide a valid screens array."],
      });
      return;
    }
    if (!batchMode && !parsed.success) {
      setNotice({ tone: "error", title: "Validation failed", details: parsed.errors });
      return;
    }
    const requestId = nextRequestId();
    currentRequest.current = requestId;
    setBusy(true);
    setNotice({ tone: "neutral", title: "Checking JSON in the plugin controller…" });
    postToPlugin({ type: "validate", requestId, json });
  };

  const generate = () => {
    if (!parsed.success || batchMode) {
      setNotice({
        tone: "error",
        title: "Use the correct generation action for this JSON",
        details: parsed.success
          ? ["Multi-screen input uses the dedicated batch action."]
          : parsed.errors,
      });
      return;
    }
    const requestId = nextRequestId();
    currentRequest.current = requestId;
    setBusy(true);
    setNotice({ tone: "neutral", title: "Creating native Figma layers…" });
    postToPlugin({ type: "generate", requestId, json });
  };

  const generateMultiScreen = () => {
    if (!batchParsed?.success) {
      setNotice({
        tone: "error",
        title: "Fix the multi-screen JSON before generating",
        details: batchParsed?.errors ?? ["Provide a valid screens array."],
      });
      return;
    }
    if (!placementOptionsValid) {
      setNotice({
        tone: "error",
        title: "Canvas placement settings are out of range",
        details: ["Gap must be 0–1,000 px and row width must be 390–20,000 px."],
      });
      return;
    }
    const requestId = nextRequestId();
    currentRequest.current = requestId;
    setBusy(true);
    setMultiProgress(null);
    setMultiReport(null);
    setNotice({ tone: "neutral", title: "Planning the multi-screen batch…" });
    postToPlugin({
      type: "generate-multi-screen",
      requestId,
      json,
      gap: canvasGap,
      maxRowWidth: rowWidth,
    });
  };

  const applyDesignSystem = () => {
    if (!parsed.success || !dryRun) {
      setNotice({
        tone: "error",
        title: "Fix the design-system JSON before creating assets",
        details: parsed.success ? ["No designSystem section was found."] : parsed.errors,
      });
      return;
    }
    const requestId = nextRequestId();
    currentRequest.current = requestId;
    setBusy(true);
    setNotice({ tone: "neutral", title: "Creating the design system and editable preview…" });
    postToPlugin({ type: "apply-design-system", requestId, json, updateOwned });
  };

  const loadSample = (content: string, label: string) => {
    setJson(content.trim());
    setMultiProgress(null);
    setMultiReport(null);
    currentRequest.current = null;
    setBusy(false);
    setNotice({
      tone: "neutral",
      title: `${label} loaded`,
      details: ["Validate the JSON, then generate editable native Figma layers."],
    });
  };

  const reset = () => {
    setJson("");
    setMultiProgress(null);
    setMultiReport(null);
    currentRequest.current = null;
    setBusy(false);
    setNotice({ tone: "neutral", title: "Editor cleared" });
  };

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setNotice({
        tone: "error",
        title: "File is too large",
        details: ["Choose a JSON file under 1 MB."],
      });
      return;
    }
    try {
      setJson(await file.text());
      setNotice({ tone: "neutral", title: `Imported ${file.name}` });
    } catch {
      setNotice({
        tone: "error",
        title: "Could not read the selected file",
        details: ["Choose a UTF-8 JSON file and try again."],
      });
    }
  };

  const importVisualAsset = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    const isSvg = extension === "svg";
    const limit = isSvg ? 50 * 1_024 : 256 * 1_024;
    if (file.size > limit) {
      setNotice({
        tone: "error",
        title: "Asset is too large",
        details: [
          isSvg
            ? "SVG markup is limited to 50 KB."
            : "PNG, JPEG, and GIF files are limited to 256 KiB each.",
        ],
      });
      return;
    }
    if (!assetLicense.trim()) {
      setNotice({
        tone: "error",
        title: "Add provenance before importing",
        details: ["Enter the asset's source/license or a note that you own its rights."],
      });
      return;
    }
    let root: Record<string, unknown>;
    try {
      const parsedJson = JSON.parse(json) as unknown;
      if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
        throw new Error("The design JSON root must be an object.");
      }
      root = parsedJson as Record<string, unknown>;
      if (!("document" in root) && !("screens" in root)) {
        throw new Error("Load a single-design or multi-screen JSON document first.");
      }
    } catch (error) {
      setNotice({
        tone: "error",
        title: "Could not attach the local asset",
        details: [error instanceof Error ? error.message : "Fix the JSON syntax and try again."],
      });
      return;
    }
    const assets = Array.isArray(root.assets) ? [...root.assets] : [];
    if (root.assets !== undefined && !Array.isArray(root.assets)) {
      setNotice({
        tone: "error",
        title: "Invalid assets field",
        details: ["Top-level assets must be an array."],
      });
      return;
    }
    const stem = file.name.replace(/\.[^.]+$/, "").trim() || "local-asset";
    const baseId = `visual-${
      stem
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "local-asset"
    }`.slice(0, 90);
    let id = baseId;
    let suffix = 2;
    while (
      assets.some(
        (asset) =>
          typeof asset === "object" && asset !== null && (asset as { id?: unknown }).id === id,
      )
    ) {
      id = `${baseId.slice(0, 85)}-${suffix++}`;
    }
    const common = {
      id,
      name: stem.slice(0, 160),
      license: assetLicense.trim(),
      ...(assetAttribution.trim() ? { attribution: assetAttribution.trim() } : {}),
    };

    try {
      if (isSvg) {
        const imported = parseSafeSvg(await file.text());
        if (!imported.success) throw new Error(imported.error);
        assets.push({ kind: "svg-paths", ...common, ...imported.data });
      } else {
        const mimeType =
          extension === "png"
            ? "image/png"
            : extension === "jpg" || extension === "jpeg"
              ? "image/jpeg"
              : extension === "gif"
                ? "image/gif"
                : undefined;
        if (!mimeType) throw new Error("Choose an SVG, PNG, JPEG, or GIF file.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const base64 = bytesToBase64(bytes);
        const dimensions = inspectEmbeddedImage(base64, mimeType);
        if (!dimensions.valid)
          throw new Error(dimensions.error ?? "Image bytes could not be validated.");
        assets.push({
          kind: "raster",
          ...common,
          width: dimensions.width,
          height: dimensions.height,
          mimeType,
          base64,
        });
      }
      const next = { ...root, assets };
      const serialized = JSON.stringify(next, null, 2);
      if (serialized.length > 1_000_000)
        throw new Error("Combined JSON and embedded assets exceed the 1 MB document limit.");
      setJson(serialized);
      setNotice({
        tone: "success",
        title: `${isSvg ? "Editable SVG paths" : "Replaceable image fill"} attached`,
        details: [
          `Asset id: ${id}. Add an image node that references this id. No network request was made.`,
        ],
      });
    } catch (error) {
      setNotice({
        tone: "error",
        title: "Asset was not added",
        details: [error instanceof Error ? error.message : "Check the local file and try again."],
      });
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 2.5 14.5 9.5 21.5 12 14.5 14.5 12 21.5 9.5 14.5 2.5 12 9.5 9.5 12 2.5Z" />
            <path d="m19 2 .8 2.2L22 5l-2.2.8L19 8l-.8-2.2L16 5l2.2-.8L19 2Z" />
          </svg>
        </div>
        <div className="brand-copy">
          <div className="brand-title">Design Engine</div>
          <div className="brand-subtitle">JSON → native Figma layers</div>
        </div>
        <span className="version-tag">v0.1.0</span>
      </header>

      <section className="intro-row" aria-label="Import instructions">
        <span className="step-indicator">PHASE 01–04</span>
        <span className="intro-copy">Paste a design spec or import a .json file</span>
      </section>

      <section className="editor-section">
        <div className="section-heading">
          <label htmlFor="json-input">Design JSON</label>
          <span className="format-hint">Schema 1.0.0</span>
        </div>
        <div className="editor-wrap">
          <textarea
            id="json-input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby="editor-help"
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              setMultiProgress(null);
              setMultiReport(null);
            }}
            disabled={busy}
            placeholder={'{\n  "schemaVersion": "1.0.0",\n  "document": { ... }\n}'}
          />
          <div className="editor-foot" id="editor-help">
            <span
              className={`validation-dot ${inputValid ? "is-valid" : json ? "is-invalid" : ""}`}
            />
            <span>
              {inputValid ? "Structure looks good" : json ? "Needs attention" : "Waiting for JSON"}
            </span>
            <span className="char-count">{json.length.toLocaleString()} / 1,000,000</span>
          </div>
        </div>
      </section>

      <div className="utility-row">
        <label className={`file-button ${busy ? "is-disabled" : ""}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 10.75V2.5m0 0L4.75 5.75M8 2.5l3.25 3.25M2.5 9.5v3A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-3" />
          </svg>
          Import JSON
          <input
            type="file"
            accept="application/json,.json"
            onChange={importFile}
            disabled={busy}
          />
        </label>
        <div className="utility-spacer" />
        <button
          className="text-button"
          type="button"
          onClick={() => loadSample(phase1Sample, "Phase 1 sample")}
          disabled={busy}
        >
          Phase 1 sample
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => loadSample(phase2Sample, "Phase 2 demo")}
          disabled={busy}
        >
          Phase 2 demo
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => loadSample(phase3Sample, "Phase 3 design-system demo")}
          disabled={busy}
        >
          Phase 3 demo
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => loadSample(phase4Sample, "Phase 4 multi-screen demo")}
          disabled={busy}
        >
          Phase 4 demo
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => loadSample(phase45Sample, "Phase 4.5 visual design demo")}
          disabled={busy}
        >
          Visual demo
        </button>
        <button
          className="text-button muted"
          type="button"
          onClick={() => loadSample(visualLtrFixture, "LTR visual regression fixture")}
          disabled={busy}
        >
          LTR fixture
        </button>
        <button
          className="text-button muted"
          type="button"
          onClick={reset}
          disabled={busy || !json}
        >
          Reset
        </button>
      </div>

      <section
        className={`status-card status-${notice.tone}`}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className={`status-icon ${busy ? "is-spinning" : ""}`} aria-hidden="true">
          {busy ? (
            <span className="spinner" />
          ) : notice.tone === "success" ? (
            <svg viewBox="0 0 16 16">
              <path d="m3.5 8.2 2.8 2.8 6.2-6.2" />
            </svg>
          ) : notice.tone === "error" ? (
            <svg viewBox="0 0 16 16">
              <path d="M8 4.5v4m0 2.5h.01M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5Z" />
            </svg>
          ) : (
            <span className="ready-dot" />
          )}
        </span>
        <div className="status-copy">
          <strong>{notice.title}</strong>
          {notice.details &&
            (notice.tone === "error" ? (
              <ErrorList errors={notice.details} />
            ) : (
              <p>{notice.details.join(" ")}</p>
            ))}
        </div>
      </section>

      <section className="visual-quality-panel" aria-labelledby="visual-quality-title">
        <div className="design-system-heading">
          <div>
            <span className="section-kicker">VISUAL PREFLIGHT</span>
            <h2 id="visual-quality-title">Quality & Local Assets</h2>
          </div>
          <span className={`system-status ${visualAudit ? "is-ready" : ""}`}>
            {visualAudit ? `${visualAudit.diagnostics.length} findings` : "Validate JSON"}
          </span>
        </div>
        {visualAudit ? (
          <>
            <p className="visual-quality-summary">
              {visualAudit.screenCount} screen{visualAudit.screenCount === 1 ? "" : "s"} ·{" "}
              {batchPreview?.estimatedNodeCount ?? visualAudit.estimatedNativeNodes} estimated nodes
              · {visualAudit.componentCount} shared masters · {visualAudit.instanceCount} instances
              · {visualAudit.assetCount} assets
            </p>
            <p className="visual-quality-note">
              Measured JSON checks only. Font availability, visual balance, and Persian shaping
              still need a Figma Desktop review.
            </p>
            {visualAudit.diagnostics.length ? (
              <ul className="quality-diagnostics" aria-label="Visual quality findings">
                {visualAudit.diagnostics.slice(0, 8).map((item, index) => (
                  <li key={`${item.code}-${item.path}-${index}`}>
                    <strong>{item.code.replaceAll("-", " ")}</strong>
                    <span>{item.path}</span>
                    <p>{item.message}</p>
                    <small>{item.action}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quality-clear" role="status">
                No configured preflight warnings. This is not a visual-quality score.
              </p>
            )}
          </>
        ) : (
          <div className="system-validation">
            <strong>Fix validation errors before preview</strong>
            <ErrorList
              errors={(batchMode
                ? batchParsed?.success === false
                  ? batchParsed.errors
                  : []
                : !parsed.success
                  ? parsed.errors
                  : []
              ).slice(0, 4)}
            />
          </div>
        )}
        <div className="asset-provenance-fields">
          <label>
            <span>Asset source / license (required)</span>
            <input
              type="text"
              maxLength={500}
              value={assetLicense}
              onChange={(event) => setAssetLicense(event.target.value)}
              disabled={busy}
              placeholder="Owned by me, CC0, or source and license"
            />
          </label>
          <label>
            <span>Attribution (optional)</span>
            <input
              type="text"
              maxLength={500}
              value={assetAttribution}
              onChange={(event) => setAssetAttribution(event.target.value)}
              disabled={busy}
              placeholder="Creator or source credit"
            />
          </label>
          <label className={`file-button ${busy ? "is-disabled" : ""}`}>
            <span>Import local PNG / JPEG / GIF / safe SVG</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml,.png,.jpg,.jpeg,.gif,.svg"
              onChange={importVisualAsset}
              disabled={busy}
            />
          </label>
        </div>
        {assetInventory.length > 0 && (
          <ul className="asset-inventory" aria-label="Embedded local assets">
            {assetInventory.slice(0, 8).map((asset, index) => (
              <li key={String(asset.id ?? index)}>
                <strong>{String(asset.name ?? asset.id ?? "Local asset")}</strong>
                <span>
                  {String(asset.kind ?? "unknown")} · {String(asset.width ?? "?")} ×{" "}
                  {String(asset.height ?? "?")}
                </span>
                <small>{String(asset.license ?? "Missing provenance note")}</small>
                {typeof asset.attribution === "string" && (
                  <small>Credit: {asset.attribution}</small>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="visual-quality-note">
          Local raster bytes are embedded in JSON (256 KiB each, 4,096 px maximum); safe SVG imports
          become editable path layers (50 KB, 32 paths max).
        </p>
      </section>

      {batchMode ? (
        <section className="multi-screen-panel" aria-labelledby="multi-screen-title">
          <div className="design-system-heading">
            <div>
              <span className="section-kicker">PHASE 04</span>
              <h2 id="multi-screen-title">Multi-Screen Generator</h2>
            </div>
            <span className="system-status is-ready">
              {batchParsed?.success ? "Preview ready" : "Fix JSON"}
            </span>
          </div>
          {batchParsed?.success && batchPreview ? (
            <>
              <p className="system-namespace">
                <strong>{batchPreview.name}</strong> · {batchPreview.id}
              </p>
              <p className="multi-screen-summary">
                {batchPreview.screens.length} screens · {batchPreview.estimatedNodeCount} estimated
                native nodes.
                {" " + batchPreview.sharedAssetSummary}
              </p>
              <ul className="multi-screen-list" aria-label="Screen preview">
                {batchPreview.screens.map((screen, index) => {
                  const result = multiReport?.screens.find((item) => item.id === screen.id);
                  return (
                    <li key={screen.id} className={result ? "has-result" : ""}>
                      <span className="screen-order">{String(index + 1).padStart(2, "0")}</span>
                      <span className="screen-info">
                        <strong>{screen.name}</strong>
                        <small>
                          {screen.width} × {screen.height}
                          {screen.devicePreset ? " · " + screen.devicePreset : ""}
                          {screen.group ? " · " + screen.group : ""}
                        </small>
                      </span>
                      {result && (
                        <span
                          className={"screen-outcome screen-" + result.status}
                          aria-label={result.status}
                        >
                          {result.status === "generated" ? "Created" : "Failed"}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="multi-screen-options">
                <label>
                  <span>Minimum gap (px)</span>
                  <input
                    type="number"
                    min={0}
                    max={1_000}
                    step={10}
                    value={canvasGap}
                    onChange={(event) => setCanvasGap(Number(event.target.value))}
                    disabled={busy}
                    aria-label="Canvas gap in pixels"
                  />
                </label>
                <label>
                  <span>Target row width (px)</span>
                  <input
                    type="number"
                    min={390}
                    max={20_000}
                    step={100}
                    value={rowWidth}
                    onChange={(event) => setRowWidth(Number(event.target.value))}
                    disabled={busy}
                    aria-label="Canvas row width in pixels"
                  />
                </label>
              </div>
              {!placementOptionsValid && (
                <p className="system-validation">
                  Gap range: 0–1,000 px. Row width range: 390–20,000 px.
                </p>
              )}
              {multiProgress && (
                <div className="multi-progress" aria-live="polite">
                  <div
                    role="progressbar"
                    aria-label="Multi-screen generation progress"
                    aria-valuemin={0}
                    aria-valuemax={multiProgress.total}
                    aria-valuenow={
                      multiProgress.status === "started"
                        ? multiProgress.index - 1
                        : multiProgress.index
                    }
                    aria-valuetext={
                      multiProgress.status +
                      " screen " +
                      multiProgress.index +
                      " of " +
                      multiProgress.total
                    }
                  >
                    <span
                      style={{
                        width:
                          ((multiProgress.status === "started"
                            ? multiProgress.index - 1
                            : multiProgress.index) /
                            multiProgress.total) *
                            100 +
                          "%",
                      }}
                    />
                  </div>
                  <p>
                    {multiProgress.status === "started" ? "Working on " : "Last screen: "}
                    {multiProgress.screenName} · {multiProgress.index}/{multiProgress.total}
                  </p>
                </div>
              )}
              {multiReport && (
                <p className="multi-screen-summary" role="status">
                  Actual result: {multiReport.generatedScreens} generated,{" "}
                  {multiReport.failedScreens} failed; created {multiReport.createdNodeCount} native
                  nodes.
                </p>
              )}
              <button
                className="system-action"
                type="button"
                onClick={generateMultiScreen}
                disabled={busy || !batchParsed.success || !placementOptionsValid}
              >
                {busy ? "Generating screens…" : "Generate all screens"}
              </button>
              <p className="multi-screen-note">
                Preview counts are estimates. Successful screens remain if another screen fails; the
                current batch cannot be cancelled.
              </p>
            </>
          ) : (
            <div className="system-validation">
              <strong>Validation issues, including screen paths and unresolved references</strong>
              <ErrorList
                errors={
                  batchParsed && !batchParsed.success
                    ? batchParsed.errors.slice(0, 8)
                    : ["Enter a valid screens array."]
                }
              />
              {batchParsed && !batchParsed.success && batchParsed.errors.length > 8 && (
                <p>+{batchParsed.errors.length - 8} more errors</p>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="design-system-panel" aria-labelledby="design-system-title">
          <div className="design-system-heading">
            <div>
              <span className="section-kicker">PHASE 03</span>
              <h2 id="design-system-title">Design System</h2>
            </div>
            <span className={`system-status ${dryRun ? "is-ready" : ""}`}>
              {dryRun ? "Ready to preview" : "No valid system"}
            </span>
          </div>
          {dryRun ? (
            <>
              <p className="system-namespace">
                <strong>{dryRun.namespace}</strong> · {dryRun.name}
              </p>
              <div className="system-counts">
                <span>{dryRun.colors} colors</span>
                <span>{dryRun.typography} type</span>
                <span>{dryRun.spacing} spacing</span>
                <span>{dryRun.radii} radii</span>
                <span>{dryRun.borders} borders</span>
                <span>{dryRun.components} components</span>
              </div>
              <div className="dry-run-summary">
                <strong>Dry run</strong>
                <p>{dryRun.message}</p>
                {dryRun.fallbacks.map((fallback) => (
                  <p className="system-fallback" key={fallback}>
                    {fallback}
                  </p>
                ))}
              </div>
              <label className="update-owned-option">
                <input
                  type="checkbox"
                  checked={updateOwned}
                  onChange={(event) => setUpdateOwned(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Update plugin-owned styles only if their saved fingerprint shows they were not
                  manually edited.
                </span>
              </label>
              <button
                className="system-action"
                type="button"
                onClick={applyDesignSystem}
                disabled={busy || !parsed.success}
              >
                {busy ? "Working…" : "Create / Update Design System"}
              </button>
            </>
          ) : parsed.success ? (
            <p className="system-empty">
              Add a valid optional designSystem section to preview assets.
            </p>
          ) : (
            <div className="system-validation">
              <strong>Validation issues, including unresolved token references</strong>
              <ErrorList errors={parsed.errors.slice(0, 5)} />
              {parsed.errors.length > 5 && <p>+{parsed.errors.length - 5} more errors</p>}
            </div>
          )}
        </section>
      )}

      <div className="actions">
        <button className="secondary-action" type="button" onClick={validate} disabled={busy}>
          Validate JSON
        </button>
        <button
          className="primary-action"
          type="button"
          onClick={generate}
          disabled={
            busy ||
            batchMode ||
            !parsed.success ||
            (parsed.success && Boolean(parsed.data.designSystem))
          }
        >
          {busy ? (
            <span className="button-spinner" />
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5v13m-6.5-6.5h13M3.75 3.75l8.5 8.5m0-8.5-8.5 8.5" />
            </svg>
          )}
          {busy
            ? "Working…"
            : batchMode
              ? "Use multi-screen panel"
              : parsed.success && parsed.data.designSystem
                ? "Use design-system action"
                : "Generate in Figma"}
        </button>
      </div>

      <footer className="footer-note">
        <span className="local-icon" aria-hidden="true">
          ●
        </span>
        <span>Local only</span>
        <span className="footer-divider">·</span>
        <span>Native editable layers · no cloud service</span>
      </footer>
    </main>
  );
}
