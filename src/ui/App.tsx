import { useEffect, useMemo, useRef, useState } from "react";
import phase1Sample from "../samples/sample-design.json?raw";
import phase2Sample from "../samples/phase-2-storefront.json?raw";
import { parseDesignText } from "../shared/schema";
import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";

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

export default function App() {
  const [json, setJson] = useState(phase1Sample.trim());
  const [notice, setNotice] = useState<Notice>({
    tone: "neutral",
    title: "Ready to validate",
  });
  const [busy, setBusy] = useState(false);
  const currentRequest = useRef<string | null>(null);
  const parsed = useMemo(() => parseDesignText(json), [json]);

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

      currentRequest.current = null;
      setBusy(false);
      if (message.type === "validation-result") {
        const counts = message.counts;
        setNotice(
          message.success
            ? {
                tone: "success",
                title: "JSON is valid",
                details: [
                  `Schema 1.0.0 · ${counts?.frames ?? 0} frames, ${counts?.texts ?? 0} texts, ${counts?.rectangles ?? 0} rectangles, ${counts?.components ?? 0} components, ${counts?.instances ?? 0} instances.`,
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
            `${counts.frames} frames · ${counts.texts} texts · ${counts.rectangles} rectangles · ${counts.components} components · ${counts.instances} instances.`,
            `Fonts: ${fontSummary}.`,
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
    if (!parsed.success) {
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
    if (!parsed.success) {
      setNotice({ tone: "error", title: "Fix the JSON before generating", details: parsed.errors });
      return;
    }
    const requestId = nextRequestId();
    currentRequest.current = requestId;
    setBusy(true);
    setNotice({ tone: "neutral", title: "Creating native Figma layers…" });
    postToPlugin({ type: "generate", requestId, json });
  };

  const loadSample = (content: string, label: string) => {
    setJson(content.trim());
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
        <span className="step-indicator">PHASE 02</span>
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
            onChange={(event) => setJson(event.target.value)}
            disabled={busy}
            placeholder={'{\n  "schemaVersion": "1.0.0",\n  "document": { ... }\n}'}
          />
          <div className="editor-foot" id="editor-help">
            <span
              className={`validation-dot ${parsed.success ? "is-valid" : json ? "is-invalid" : ""}`}
            />
            <span>
              {parsed.success
                ? "Structure looks good"
                : json
                  ? "Needs attention"
                  : "Waiting for JSON"}
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

      <div className="actions">
        <button className="secondary-action" type="button" onClick={validate} disabled={busy}>
          Validate JSON
        </button>
        <button
          className="primary-action"
          type="button"
          onClick={generate}
          disabled={busy || !parsed.success}
        >
          {busy ? (
            <span className="button-spinner" />
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5v13m-6.5-6.5h13M3.75 3.75l8.5 8.5m0-8.5-8.5 8.5" />
            </svg>
          )}
          {busy ? "Working…" : "Generate in Figma"}
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
