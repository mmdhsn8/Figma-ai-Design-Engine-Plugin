import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import phase1Sample from "../samples/sample-design.json?raw";
import phase2Sample from "../samples/phase-2-storefront.json?raw";
import phase3Sample from "../samples/phase-3-design-system.json?raw";
import phase4Sample from "../samples/phase-4-multi-screen.json?raw";
import phase45Sample from "../samples/phase-4.5-visual-design.json?raw";
import phase5DashboardSample from "../samples/phase-5-english-dashboard.json?raw";
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
import {
  createDesignPlan,
  normalizeGeneratedDesignResponse,
  type GeneratedDesign,
  type DesignGenerationRequest,
  type DesignPlan,
} from "../shared/design-generation";
import {
  pendingGenerationScreens,
  prepareGeneratedDesign,
  retainGeneratedScreen,
} from "./design-generation";
import {
  getInferenceEligibility,
  getInferenceStatusLabel,
  retainSelectedAccountModel,
  type InferenceEligibility,
} from "./inference-eligibility";
import { inspectEmbeddedImage, parseSafeSvg } from "../shared/visual-assets";
import {
  CompanionClientError,
  cancelLocalPairing,
  disconnectChatGPT,
  disconnectLocalSession,
  discoverAuthorizedModels,
  getCompanionHealth,
  getCompanionStatus,
  generateAuthorizedDesign,
  pollLocalPairing,
  reopenLocalApproval,
  reopenChatGPTSignIn,
  requestLocalPairing,
  restoreLocalCompanionSession,
  runSmokeRequest,
  startChatGPTSignIn,
  switchChatGPTAccount,
  type CompanionModel,
  type CompanionStatus,
  type InferenceDiagnostic,
} from "./companion-client";

type Notice = {
  tone: "neutral" | "success" | "error";
  title: string;
  details?: string[];
};

type GenerationPreview = {
  json: string;
  plan: DesignPlan;
  projectName: string;
  nodeCount: number;
  repairAttempts: number;
  warnings: string[];
};

type GenerationDraft = {
  key: string;
  projectName?: string;
  palette?: GeneratedDesign["palette"];
  screens: GeneratedDesign["screens"];
};

export type CompanionConnectionState =
  | "discovering"
  | "reconnecting"
  | "offline"
  | "available"
  | "approval_required"
  | "pairing"
  | "connected";

export type PluginView = "design" | "json" | "assets" | "system" | "quality";
export type ModelDiscoveryState = "idle" | "loading" | "loaded" | "empty" | "error";
type GenerationTarget = DesignGenerationRequest["target"];
type GenerationLanguage = DesignGenerationRequest["language"];
type GenerationState =
  | "idle"
  | "planning"
  | "generating"
  | "validating"
  | "preparing"
  | "ready"
  | "failed"
  | "cancelled";

type NavigationState = { activeView: PluginView; settingsOpen: boolean };
type NavigationAction =
  { type: "navigate"; view: PluginView } | { type: "toggle-settings" } | { type: "open-settings" };

export function navigationReducer(
  state: NavigationState,
  action: NavigationAction,
): NavigationState {
  if (action.type === "navigate") return { activeView: action.view, settingsOpen: false };
  if (action.type === "open-settings") return { ...state, settingsOpen: true };
  return { ...state, settingsOpen: !state.settingsOpen };
}

export function getConnectionSummary(
  state: CompanionConnectionState,
  status: CompanionStatus | null,
): string {
  if (state !== "connected") {
    return (
      {
        discovering: "Reconnecting",
        reconnecting: "Reconnecting",
        offline: "Companion offline",
        available: "Sign-in required",
        approval_required: "Reconnecting",
        pairing: "Reconnecting",
        connected: "Connected",
      } satisfies Record<CompanionConnectionState, string>
    )[state];
  }

  if (
    status?.safeMessage === "service_unavailable" ||
    status?.safeMessage === "request_timed_out"
  ) {
    return "Reconnecting";
  }
  if (
    status?.auth === "session_expired" ||
    status?.auth === "signed_out" ||
    status?.auth === "blocked"
  ) {
    return "Sign-in required";
  }

  if (status?.auth === "signing_in") return "Reconnecting";
  return "Connected";
}

export function getModelAvailabilityMessage(
  state: ModelDiscoveryState,
  hasCompanionToken: boolean,
  planUseAuthorized: boolean,
): string {
  if (state === "loading") return "Loading account-visible models…";
  if (state === "empty") return "No account-visible models were returned.";
  if (state === "error") return "Model discovery failed. Review the connection status in Settings.";
  if (!hasCompanionToken) return "Connect the optional Companion in Settings to discover models.";
  if (!planUseAuthorized) return "Grant plan-use permission in Settings before loading models.";
  return "Models have not been loaded from this account yet.";
}

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

function createPairingVerifier(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export default function App({ initialView = "design" }: { initialView?: PluginView } = {}) {
  const [navigation, dispatchNavigation] = useReducer(navigationReducer, {
    activeView: initialView,
    settingsOpen: false,
  });
  const { activeView, settingsOpen } = navigation;
  const [prompt, setPrompt] = useState("");
  const [generationTarget, setGenerationTarget] = useState<GenerationTarget>("mobile");
  const [generationScreenCount, setGenerationScreenCount] = useState(2);
  const [generationScreenNames, setGenerationScreenNames] = useState("");
  const [generationLanguage, setGenerationLanguage] = useState<GenerationLanguage>("auto");
  const [generationStyle, setGenerationStyle] = useState("");
  const [generationProjectType, setGenerationProjectType] =
    useState<DesignGenerationRequest["projectType"]>("auto");
  const [generationTheme, setGenerationTheme] = useState<DesignGenerationRequest["theme"]>("auto");
  const [generationState, setGenerationState] = useState<GenerationState>("idle");
  const [generationPreview, setGenerationPreview] = useState<GenerationPreview | null>(null);
  const [generationErrors, setGenerationErrors] = useState<string[]>([]);
  const [generationScreenProgress, setGenerationScreenProgress] = useState({
    completed: 0,
    total: 0,
    retrying: false,
  });
  const generationDraft = useRef<GenerationDraft | null>(null);
  const generationAbort = useRef<AbortController | null>(null);
  const generationRequest = useRef<string | null>(null);
  const [modelDiscovery, setModelDiscovery] = useState<ModelDiscoveryState>("idle");
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
  const [companionToken, setCompanionToken] = useState<string | null>(null);
  const [restoreTicket, setRestoreTicket] = useState<string | null>(null);
  const [restoreTicketLoaded, setRestoreTicketLoaded] = useState(false);
  const [restoreStorageWarning, setRestoreStorageWarning] = useState(false);
  const [companionConnectionState, setCompanionConnectionState] =
    useState<CompanionConnectionState>("discovering");
  const [pairingAttemptId, setPairingAttemptId] = useState<string | null>(null);
  const [companionStatus, setCompanionStatus] = useState<CompanionStatus | null>(null);
  const [companionError, setCompanionError] = useState<string | null>(null);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [approvalPageBusy, setApprovalPageBusy] = useState(false);
  const [companionModels, setCompanionModels] = useState<CompanionModel[]>([]);
  const [selectedCompanionModel, setSelectedCompanionModel] = useState("");
  const [smokeResult, setSmokeResult] = useState<string | null>(null);
  const [smokeDiagnostic, setSmokeDiagnostic] = useState<InferenceDiagnostic | null>(null);
  const [smokeInFlight, setSmokeInFlight] = useState(false);
  const smokeAbort = useRef<AbortController | null>(null);
  const pairingAbort = useRef<AbortController | null>(null);
  const pairingAttempt = useRef<{ attemptId: string; verifier: string } | null>(null);
  const restoreTicketWrites = useRef(
    new Map<string, { resolve: (success: boolean) => void; timeout: number }>(),
  );
  const [multiProgress, setMultiProgress] = useState<MultiScreenProgressMessage | null>(null);
  const [multiReport, setMultiReport] = useState<MultiScreenRenderResultMessage | null>(null);
  const currentRequest = useRef<string | null>(null);
  const designGenerationInput = useMemo<DesignGenerationRequest>(
    () => ({
      prompt,
      target: generationTarget,
      screenCount: generationScreenCount,
      ...(parseScreenNames(generationScreenNames).length
        ? { screenNames: parseScreenNames(generationScreenNames) }
        : {}),
      language: generationLanguage,
      style: generationStyle,
      projectType: generationProjectType,
      theme: generationTheme,
    }),
    [
      generationLanguage,
      generationProjectType,
      generationScreenCount,
      generationScreenNames,
      generationStyle,
      generationTheme,
      generationTarget,
      prompt,
    ],
  );
  const generationPlan = useMemo(
    () => createDesignPlan(designGenerationInput),
    [designGenerationInput],
  );
  const generationInFlight = ["planning", "generating", "validating", "preparing"].includes(
    generationState,
  );
  const inferenceEligibility = getInferenceEligibility({
    companionConnected: Boolean(companionToken) && companionConnectionState === "connected",
    status: companionStatus,
    models: companionModels,
    selectedModel: selectedCompanionModel,
    smokeInFlight,
  });
  const generationBlockReason = getDesignGenerationBlockReason({
    prompt,
    planValid: generationPlan.success,
    planErrors: generationPlan.success ? [] : generationPlan.errors,
    inferenceEligibility,
    inFlight: generationInFlight,
  });
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

  useEffect(
    () => () => {
      generationRequest.current = null;
      generationAbort.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const raw = (event.data as { pluginMessage?: unknown } | null)?.pluginMessage;
      const result = PluginToUISchema.safeParse(raw);
      if (!result.success) return;
      const message = result.data;
      if (message.type === "companion-restore-ticket") {
        setRestoreTicket(message.ticket);
        setRestoreTicketLoaded(true);
        setRestoreStorageWarning(!message.storageAvailable);
        return;
      }
      if (message.type === "companion-restore-ticket-saved") {
        const pending = restoreTicketWrites.current.get(message.requestId);
        if (pending) {
          window.clearTimeout(pending.timeout);
          restoreTicketWrites.current.delete(message.requestId);
          pending.resolve(message.success);
        }
        return;
      }
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
    postToPlugin({ type: "load-companion-restore-ticket" });
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const persistRestoreTicket = useCallback(
    (ticket: string | null): Promise<boolean> =>
      new Promise((resolve) => {
        const requestId = `storage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const timeout = window.setTimeout(() => {
          restoreTicketWrites.current.delete(requestId);
          resolve(false);
        }, 5_000);
        restoreTicketWrites.current.set(requestId, { resolve, timeout });
        postToPlugin({ type: "save-companion-restore-ticket", requestId, ticket });
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const checkConnection = async () => {
      if (
        companionConnectionState === "approval_required" ||
        companionConnectionState === "pairing"
      ) {
        timer = window.setTimeout(() => void checkConnection(), 2_000);
        return;
      }
      try {
        await getCompanionHealth();
        if (cancelled) return;
        if (companionToken) {
          try {
            const status = await getCompanionStatus(companionToken);
            if (cancelled) return;
            setCompanionStatus(status);
            if (status.auth !== "ready" || !status.inferenceVerifiedModel) {
              setSmokeResult(null);
              setSmokeDiagnostic(null);
            }
            setCompanionConnectionState("connected");
          } catch (error) {
            if (cancelled) return;
            if (error instanceof CompanionClientError && error.category === "pairing_required") {
              setCompanionToken(null);
              setCompanionStatus(null);
              setCompanionModels([]);
              setSelectedCompanionModel("");
              setModelDiscovery("idle");
              setCompanionConnectionState(restoreTicket ? "reconnecting" : "available");
            } else {
              setCompanionConnectionState("reconnecting");
            }
          }
        } else if (!restoreTicketLoaded) {
          setCompanionConnectionState("discovering");
          timer = window.setTimeout(() => void checkConnection(), 250);
          return;
        } else if (restoreTicket) {
          try {
            const restored = await restoreLocalCompanionSession(restoreTicket);
            if (cancelled) return;
            setCompanionToken(restored.token);
            setCompanionStatus(restored.status);
            setCompanionConnectionState("connected");
            setCompanionError(null);
          } catch (error) {
            if (cancelled) return;
            if (
              error instanceof CompanionClientError &&
              ["pairing_failed", "pairing_required"].includes(error.category)
            ) {
              const cleared = await persistRestoreTicket(null);
              setRestoreTicket(null);
              setRestoreStorageWarning(!cleared);
              setCompanionConnectionState("available");
              setCompanionError(
                cleared
                  ? "The saved local approval is no longer valid. Connect again to approve this plugin."
                  : "The saved local approval is no longer valid, and Figma could not clear its saved ticket.",
              );
            } else {
              setCompanionConnectionState("reconnecting");
              setCompanionError(companionErrorText(error));
            }
          }
        } else {
          setCompanionConnectionState("available");
        }
      } catch {
        if (cancelled) return;
        setCompanionConnectionState("offline");
      }
      if (!cancelled) timer = window.setTimeout(() => void checkConnection(), 5_000);
    };
    void checkConnection();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    companionConnectionState,
    companionToken,
    persistRestoreTicket,
    restoreTicket,
    restoreTicketLoaded,
  ]);

  useEffect(() => {
    if (
      !companionToken ||
      companionStatus?.auth !== "signing_in" ||
      companionStatus.safeMessage === "system_browser_unavailable"
    ) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const next = await getCompanionStatus(companionToken);
        if (cancelled) return;
        setCompanionStatus(next);
        setCompanionError(next.safeMessage ? companionErrorText(next.safeMessage) : null);
        if (next.auth === "signing_in" && attempts < 120) {
          timer = window.setTimeout(() => void poll(), 1_500);
        } else if (next.auth === "signing_in") {
          setCompanionError("Sign-in timed out. Restart the companion and try again.");
        }
      } catch (error) {
        if (cancelled) return;
        setCompanionError(companionErrorText(error));
        timer = window.setTimeout(() => void poll(), 3_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [companionStatus?.auth, companionStatus?.safeMessage, companionToken]);

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

  const continueWithChatGPT = async () => {
    setCompanionBusy(true);
    setCompanionError(null);
    setSmokeResult(null);
    setSmokeDiagnostic(null);
    try {
      let token = companionToken;
      let pairingRestoreTicket: string | null = null;
      let pairingRestoreAvailable = true;
      if (!token) {
        setCompanionConnectionState("pairing");
        const verifier = createPairingVerifier();
        const attempt = await requestLocalPairing(verifier);
        pairingAttempt.current = { attemptId: attempt.attemptId, verifier };
        setPairingAttemptId(attempt.attemptId);
        setCompanionConnectionState("approval_required");
        if (!attempt.approvalOpened) {
          setCompanionError(companionErrorText("pairing_approval_unavailable"));
        }
        const controller = new AbortController();
        pairingAbort.current = controller;
        const deadline = Date.now() + attempt.expiresInMs;
        while (Date.now() < deadline) {
          if (controller.signal.aborted) throw new CompanionClientError("pairing_cancelled");
          const result = await pollLocalPairing(
            attempt.attemptId,
            verifier,
            fetch,
            controller.signal,
          );
          if (result.status === "approved") {
            token = result.sessionToken;
            pairingRestoreTicket = result.restoreTicket ?? null;
            pairingRestoreAvailable = result.restoreAvailable;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }
        if (!token) throw new CompanionClientError("pairing_expired");
        pairingAttempt.current = null;
        setPairingAttemptId(null);
        pairingAbort.current = null;
        setCompanionToken(token);
        setRestoreTicket(pairingRestoreTicket);
        if (pairingRestoreTicket) {
          const stored = await persistRestoreTicket(pairingRestoreTicket);
          setRestoreStorageWarning(!stored);
        } else {
          setRestoreStorageWarning(true);
        }
        if (!pairingRestoreAvailable) setRestoreStorageWarning(true);
        setCompanionConnectionState("connected");
      }
      let status = await getCompanionStatus(token);
      if (["signed_out", "signed_in_no_plan", "session_expired"].includes(status.auth)) {
        status = await startChatGPTSignIn(token);
      }
      setCompanionStatus(status);
      setCompanionConnectionState("connected");
      setCompanionError(status.safeMessage ? companionErrorText(status.safeMessage) : null);
    } catch (error) {
      pairingAttempt.current = null;
      setPairingAttemptId(null);
      setCompanionConnectionState("available");
      if (
        pairingAbort.current?.signal.aborted ||
        (error instanceof CompanionClientError && error.category === "request_cancelled")
      ) {
        setCompanionError("Local connection cancelled. No ChatGPT sign-in was started.");
      } else {
        setCompanionError(companionErrorText(error));
      }
      pairingAbort.current = null;
    } finally {
      setCompanionBusy(false);
    }
  };

  const cancelLocalConnection = async () => {
    const attempt = pairingAttempt.current;
    if (attempt) {
      try {
        await cancelLocalPairing(attempt.attemptId, attempt.verifier);
      } catch {
        // The short-lived attempt expires automatically if the companion is unavailable.
      }
    }
    pairingAbort.current?.abort();
    pairingAttempt.current = null;
    pairingAbort.current = null;
    setPairingAttemptId(null);
    setCompanionConnectionState("available");
    setCompanionError("Local connection cancelled. No ChatGPT sign-in was started.");
  };

  const reopenApprovalPage = async () => {
    const attempt = pairingAttempt.current;
    if (!attempt) return;
    setApprovalPageBusy(true);
    setCompanionError(null);
    try {
      await reopenLocalApproval(attempt.attemptId, attempt.verifier);
    } catch (error) {
      setCompanionError(companionErrorText(error));
    } finally {
      setApprovalPageBusy(false);
    }
  };

  const signInWithChatGPT = async () => {
    if (!companionToken) return;
    setCompanionBusy(true);
    setCompanionError(null);
    setSmokeResult(null);
    setSmokeDiagnostic(null);
    try {
      const status = await startChatGPTSignIn(companionToken);
      setCompanionStatus(status);
      setCompanionError(status.safeMessage ? companionErrorText(status.safeMessage) : null);
    } catch (error) {
      setCompanionError(companionErrorText(error));
    } finally {
      setCompanionBusy(false);
    }
  };

  const reopenChatGPTBrowser = async () => {
    if (!companionToken) return;
    setCompanionBusy(true);
    setCompanionError(null);
    try {
      const status = await reopenChatGPTSignIn(companionToken);
      setCompanionStatus(status);
      setCompanionError(status.safeMessage ? companionErrorText(status.safeMessage) : null);
    } catch (error) {
      setCompanionError(companionErrorText(error));
    } finally {
      setCompanionBusy(false);
    }
  };

  const discoverModels = async () => {
    if (!companionToken) return;
    setCompanionBusy(true);
    setModelDiscovery("loading");
    setCompanionError(null);
    try {
      const models = await discoverAuthorizedModels(companionToken);
      const status = await getCompanionStatus(companionToken);
      const nextModel = retainSelectedAccountModel(
        models,
        selectedCompanionModel,
        status.inferenceVerifiedModel,
      );
      setCompanionModels(models);
      setSelectedCompanionModel(nextModel);
      if (nextModel !== selectedCompanionModel) {
        setSmokeResult(null);
        setSmokeDiagnostic(null);
      }
      setModelDiscovery(models.length ? "loaded" : "empty");
      setCompanionError(
        models.length ? null : "No account-visible model was returned for this session.",
      );
      setCompanionStatus(status);
    } catch (error) {
      setModelDiscovery("error");
      setCompanionError(companionErrorText(error));
    } finally {
      setCompanionBusy(false);
    }
  };

  const runCompanionSmoke = async () => {
    if (!companionToken || !selectedCompanionModel) return;
    const controller = new AbortController();
    smokeAbort.current = controller;
    setSmokeInFlight(true);
    setCompanionBusy(true);
    setCompanionError(null);
    setSmokeResult(null);
    try {
      const smoke = await runSmokeRequest(
        companionToken,
        selectedCompanionModel,
        fetch,
        controller.signal,
      );
      setSmokeResult(smoke.text || "Completed successfully with an empty text delta.");
      setSmokeDiagnostic(smoke.diagnostic ?? null);
      let nextStatus = smoke.status;
      if (!nextStatus) {
        try {
          nextStatus = await getCompanionStatus(companionToken);
        } catch {
          setCompanionStatus(null);
          setCompanionError(
            "The smoke response completed, but the companion could not confirm which model was tested. Refresh Settings and rerun the test.",
          );
          return;
        }
      }
      setCompanionStatus(nextStatus);
      const eligibility = getInferenceEligibility({
        companionConnected: true,
        status: nextStatus,
        models: companionModels,
        selectedModel: selectedCompanionModel,
        smokeInFlight: false,
      });
      setCompanionError(
        eligibility.eligible
          ? null
          : `Responses returned, but generation remains disabled: ${eligibility.message}`,
      );
    } catch (error) {
      setSmokeDiagnostic(error instanceof CompanionClientError ? (error.diagnostic ?? null) : null);
      setCompanionError(companionErrorText(error));
      try {
        setCompanionStatus(await getCompanionStatus(companionToken));
      } catch {
        setCompanionStatus(null);
      }
    } finally {
      if (smokeAbort.current === controller) smokeAbort.current = null;
      setSmokeInFlight(false);
      setCompanionBusy(false);
    }
  };

  const cancelCompanionSmoke = () => smokeAbort.current?.abort();

  const clearConnectedAccountDetails = () => {
    if (generationAbort.current) {
      generationAbort.current.abort();
      setGenerationPreview(null);
      setGenerationState("cancelled");
    }
    setCompanionModels([]);
    setSelectedCompanionModel("");
    setModelDiscovery("idle");
    setSmokeResult(null);
    setSmokeDiagnostic(null);
  };

  const disconnectLocalCompanion = async () => {
    if (!companionToken) return;
    setCompanionBusy(true);
    try {
      await disconnectLocalSession(companionToken);
      const cleared = await persistRestoreTicket(null);
      setRestoreTicket(null);
      setRestoreStorageWarning(!cleared);
      setCompanionToken(null);
      setCompanionStatus(null);
      clearConnectedAccountDetails();
      setCompanionConnectionState("available");
      setCompanionError(
        cleared
          ? null
          : "The local connection was revoked, but Figma could not clear its encrypted saved ticket.",
      );
    } catch (error) {
      setCompanionError(companionErrorText(error));
    } finally {
      setCompanionBusy(false);
    }
  };

  const disconnectCompanion = async (switchAccount = false) => {
    if (!companionToken) return;
    setCompanionBusy(true);
    try {
      const result = switchAccount
        ? await switchChatGPTAccount(companionToken)
        : await disconnectChatGPT(companionToken);
      clearConnectedAccountDetails();
      setCompanionStatus(await getCompanionStatus(companionToken));
      setCompanionError(
        result === "revoked"
          ? null
          : "Local tokens were cleared. Remote revocation was unavailable; use OpenAI account settings if you need to revoke access.",
      );
    } catch (error) {
      setCompanionError(companionErrorText(error));
      clearConnectedAccountDetails();
      try {
        setCompanionStatus(await getCompanionStatus(companionToken));
      } catch {
        setCompanionToken(null);
        setCompanionStatus(null);
      }
    } finally {
      setCompanionBusy(false);
    }
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

  const openOfflineFixture = (content: string, label: string) => {
    loadSample(content, label);
    dispatchNavigation({ type: "navigate", view: "json" });
  };

  const generateDesignFromBrief = async () => {
    if (generationRequest.current) return;
    const planResult = createDesignPlan(designGenerationInput);
    if (!planResult.success) {
      setGenerationState("failed");
      setGenerationErrors(planResult.errors);
      return;
    }
    if (generationBlockReason || !companionToken || !selectedCompanionModel) {
      setGenerationState("failed");
      setGenerationErrors([generationBlockReason ?? "Connect the authorized companion first."]);
      return;
    }

    const requestId = nextRequestId();
    const controller = new AbortController();
    generationRequest.current = requestId;
    generationAbort.current = controller;
    setGenerationPreview(null);
    setGenerationErrors([]);
    setGenerationState("planning");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (controller.signal.aborted) {
      generationRequest.current = null;
      generationAbort.current = null;
      setGenerationState("cancelled");
      setGenerationErrors(["Generation was cancelled. No Figma layers were created."]);
      return;
    }

    const draftKey = JSON.stringify({
      model: selectedCompanionModel,
      request: planResult.data.request,
    });
    let draft: GenerationDraft =
      generationDraft.current?.key === draftKey
        ? generationDraft.current
        : { key: draftKey, screens: [] };
    generationDraft.current = draft;
    setGenerationScreenProgress({
      completed: draft.screens.length,
      total: planResult.data.screens.length,
      retrying: false,
    });

    try {
      let repairAttempts = 0;
      for (const screen of pendingGenerationScreens(planResult.data, draft.screens)) {
        const screenPlan = { ...planResult.data, screens: [screen] };
        const screenRequestId = nextRequestId();
        let repairIssues: string[] = [];
        let completedScreen: GeneratedDesign["screens"][number] | undefined;

        for (let attempt = 0; attempt <= 1; attempt += 1) {
          setGenerationState("generating");
          const raw = await generateAuthorizedDesign(
            companionToken,
            screenRequestId,
            selectedCompanionModel,
            planResult.data.request,
            repairIssues,
            fetch,
            controller.signal,
            [screen.id],
            () => {
              setGenerationScreenProgress((progress) => ({ ...progress, retrying: true }));
            },
          );
          if (controller.signal.aborted || generationRequest.current !== requestId) return;
          setGenerationState("validating");
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          if (controller.signal.aborted || generationRequest.current !== requestId) return;
          const validated = normalizeGeneratedDesignResponse(raw, screenPlan);
          if (!validated.success) {
            if (attempt === 0) {
              repairIssues = validated.errors.slice(0, 8);
              setGenerationErrors(validated.errors);
              repairAttempts += 1;
              continue;
            }
            throw new Error(validated.errors.join(" "));
          }

          const generated = validated.data.design;
          if (
            draft.projectName !== undefined &&
            (draft.projectName !== generated.projectName ||
              JSON.stringify(Object.entries(draft.palette ?? {}).sort()) !==
                JSON.stringify(Object.entries(generated.palette).sort()))
          ) {
            repairIssues = [
              `Use the exact project name “${draft.projectName}” and palette ${JSON.stringify(draft.palette)} established by the first screen.`,
            ];
            if (attempt === 0) {
              repairAttempts += 1;
              continue;
            }
            throw new Error("A screen did not preserve the shared project name and palette.");
          }

          completedScreen = generated.screens[0];
          if (!completedScreen)
            throw new Error("The response did not include its requested screen.");
          draft = {
            ...draft,
            projectName: draft.projectName ?? generated.projectName,
            palette: draft.palette ?? generated.palette,
            screens: retainGeneratedScreen(draft.screens, completedScreen),
          };
          generationDraft.current = draft;
          setGenerationScreenProgress({
            completed: draft.screens.length,
            total: planResult.data.screens.length,
            retrying: false,
          });
          break;
        }
        if (!completedScreen) throw new Error("The requested screen could not be completed.");
      }

      const orderedScreens = planResult.data.screens.map((screen) =>
        draft.screens.find((generated) => generated.id === screen.id),
      );
      if (
        orderedScreens.some((screen) => screen === undefined) ||
        !draft.projectName ||
        !draft.palette
      ) {
        throw new Error(
          "Some requested screens are still missing; run generation again to resume.",
        );
      }
      const completeScreens = orderedScreens.filter(
        (screen): screen is GeneratedDesign["screens"][number] => screen !== undefined,
      );
      const raw = JSON.stringify({
        projectName: draft.projectName,
        palette: draft.palette,
        screens: completeScreens,
      } satisfies GeneratedDesign);
      setGenerationState("preparing");
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (controller.signal.aborted || generationRequest.current !== requestId) return;
      const prepared = prepareGeneratedDesign(raw, planResult.data);
      if (!prepared.success) throw new Error(prepared.errors.join(" "));
      if (controller.signal.aborted || generationRequest.current !== requestId) return;
      setGenerationState("preparing");
      const audit = auditVisualQuality(prepared.data.batch);
      const warnings = [
        "No image assets were generated or downloaded. Import licensed local assets or keep editable placeholders.",
        "Check font availability, Persian shaping, text wrapping, and visual balance in Figma Desktop.",
        ...audit.diagnostics.slice(0, 6).map((item) => `${item.code}: ${item.message}`),
      ];
      setGenerationPreview({
        json: prepared.data.json,
        plan: planResult.data,
        projectName: prepared.data.batch.name,
        nodeCount: prepared.data.nodeCount,
        repairAttempts,
        warnings: [...new Set(warnings)],
      });
      setGenerationState("ready");
      generationDraft.current = null;
    } catch (error) {
      if (generationRequest.current !== requestId) return;
      const resumeMessage = draft.screens.length
        ? ` ${draft.screens.length} of ${planResult.data.screens.length} screens are saved; run Generate Design again to resume.`
        : "";
      if (
        controller.signal.aborted ||
        (error instanceof CompanionClientError && error.category === "request_cancelled")
      ) {
        setGenerationState("cancelled");
        setGenerationErrors([
          `Generation was cancelled. No Figma layers were created.${resumeMessage}`,
        ]);
      } else {
        setGenerationState("failed");
        const errorMessage =
          error instanceof CompanionClientError
            ? companionErrorText(error)
            : error instanceof Error
              ? error.message
              : companionErrorText(error);
        setGenerationErrors([`${errorMessage}${resumeMessage}`]);
        if (companionToken && error instanceof CompanionClientError) {
          try {
            setCompanionStatus(await getCompanionStatus(companionToken));
          } catch {
            // Keep the original sanitized failure if the companion is now offline.
          }
        }
      }
    } finally {
      if (generationRequest.current === requestId) generationRequest.current = null;
      if (generationAbort.current === controller) generationAbort.current = null;
    }
  };

  const cancelDesignGeneration = () => generationAbort.current?.abort();

  const inspectGeneratedJson = () => {
    if (!generationPreview) return;
    if (
      !window.confirm(
        "Load this generated design into the existing JSON editor? Its current contents will be replaced. You can review and edit the generated JSON before rendering.",
      )
    ) {
      return;
    }
    setJson(generationPreview.json);
    setMultiProgress(null);
    setMultiReport(null);
    currentRequest.current = null;
    dispatchNavigation({ type: "navigate", view: "json" });
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

  const connectionSummary = getConnectionSummary(companionConnectionState, companionStatus);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 5h14v14H5z" />
            <path d="M9 5v14M5 9h14" />
          </svg>
        </div>
        <div className="brand-copy">
          <div className="brand-title">Figma AI Design Engine</div>
          <div className="brand-subtitle">Structured, editable design workflows</div>
        </div>
        <span
          className={`connection-chip ${companionToken ? "is-connected" : ""} ${
            companionConnectionState === "offline"
              ? "is-offline"
              : connectionSummary === "Reconnecting"
                ? "is-reconnecting"
                : connectionSummary === "Sign-in required"
                  ? "is-sign-in-required"
                  : ""
          }`}
          aria-live="polite"
          aria-label={`Connection status: ${connectionSummary}`}
        >
          <span className="connection-dot" aria-hidden="true" />
          <span>{connectionSummary}</span>
        </span>
        <button
          className={`settings-button ${settingsOpen ? "is-active" : ""}`}
          type="button"
          aria-pressed={settingsOpen}
          onClick={() => dispatchNavigation({ type: "toggle-settings" })}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M8.3 2.5h3.4l.5 1.8 1.6.9 1.8-.5 1.7 2.9-1.3 1.4v1.8l1.3 1.4-1.7 2.9-1.8-.5-1.6.9-.5 1.8H8.3l-.5-1.8-1.6-.9-1.8.5-1.7-2.9L4 10.8V9l-1.3-1.4 1.7-2.9 1.8.5 1.6-.9.5-1.8Z" />
            <circle cx="10" cy="9.9" r="2.2" />
          </svg>
          <span>{settingsOpen ? "Close" : "Settings"}</span>
        </button>
      </header>

      {!settingsOpen && (
        <nav className="primary-nav" aria-label="Plugin sections">
          {(
            [
              ["design", "Design"],
              ["json", "JSON"],
              ["assets", "Assets"],
              ["system", "System"],
              ["quality", "Quality"],
            ] as const
          ).map(([view, label]) => (
            <button
              className={`nav-item ${activeView === view ? "is-active" : ""}`}
              key={view}
              type="button"
              aria-label={view === "system" ? "Design System" : label}
              aria-current={activeView === view ? "page" : undefined}
              onClick={() => dispatchNavigation({ type: "navigate", view })}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {settingsOpen ? (
        <section className="settings-view" aria-labelledby="settings-title">
          <div className="page-heading compact-heading">
            <div>
              <span className="page-eyebrow">PREFERENCES & CONNECTION</span>
              <h1 id="settings-title">Settings</h1>
            </div>
            <span className="system-status">Optional companion</span>
          </div>
          <p className="page-description">
            Manage local pairing, ChatGPT access, account-visible models, and developer diagnostics.
          </p>
        </section>
      ) : activeView === "design" ? (
        <section className="design-home" aria-labelledby="design-title">
          <div className="page-heading">
            <div>
              <span className="page-eyebrow">AI WORKSPACE</span>
              <h1 id="design-title">Design with AI</h1>
              <p className="page-description">
                Turn your ideas into structured, editable Figma designs.
              </p>
            </div>
            <span className="availability-tag">Preview</span>
          </div>

          <section className="prompt-card" aria-labelledby="prompt-label">
            <label className="prompt-label" id="prompt-label" htmlFor="design-prompt">
              Describe what you want to make
            </label>
            <textarea
              id="design-prompt"
              className="prompt-input"
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setGenerationPreview(null);
                setGenerationErrors([]);
                if (generationState === "ready") setGenerationState("idle");
              }}
              dir={
                generationLanguage === "fa" ||
                (generationLanguage === "auto" &&
                  (/[\u0600-\u06ff]/u.test(prompt) || /\b(farsi|persian|rtl)\b/iu.test(prompt)))
                  ? "rtl"
                  : "ltr"
              }
              placeholder="Describe your app, website, or interface… / یک فروشگاه اینترنتی فارسی طراحی کن…"
              aria-describedby="prompt-status prompt-count"
              disabled={generationInFlight}
            />
            <div className="prompt-footer">
              <span id="prompt-status">
                Persian, Finglish, and English briefs · request size is limited for safety.
              </span>
              <span id="prompt-count" className="char-count">
                {prompt.length.toLocaleString()} characters
              </span>
            </div>
          </section>

          <section className="design-options" aria-label="Generation options">
            <div className="option-heading">
              <span>Target</span>
              <span className="planned-tag">Native frames</span>
            </div>
            <div className="target-options" aria-describedby="target-help">
              {(["mobile", "desktop", "both"] as const).map((target) => (
                <button
                  key={target}
                  type="button"
                  className={generationTarget === target ? "is-selected" : ""}
                  aria-pressed={generationTarget === target}
                  onClick={() => {
                    setGenerationTarget(target);
                    setGenerationPreview(null);
                    if (generationState === "ready") setGenerationState("idle");
                  }}
                  disabled={generationInFlight}
                >
                  {target === "both"
                    ? "Mobile + Desktop"
                    : target === "mobile"
                      ? "Mobile"
                      : "Desktop"}
                </button>
              ))}
            </div>
            <p className="option-help" id="target-help">
              {generationTarget === "both"
                ? "Creates matching Mobile and Desktop counterparts for every planned screen."
                : "Uses a standard target frame; no custom dimensions are inferred."}
            </p>

            <div className="generation-fields">
              <label>
                <span>Screens</span>
                <input
                  type="number"
                  min={2}
                  step={1}
                  value={generationScreenCount}
                  onChange={(event) => {
                    setGenerationScreenCount(Number(event.target.value));
                    setGenerationPreview(null);
                    if (generationState === "ready") setGenerationState("idle");
                  }}
                  disabled={generationInFlight}
                />
              </label>
              <label>
                <span>Copy language</span>
                <select
                  value={generationLanguage}
                  onChange={(event) => {
                    setGenerationLanguage(event.target.value as GenerationLanguage);
                    setGenerationPreview(null);
                    if (generationState === "ready") setGenerationState("idle");
                  }}
                  disabled={generationInFlight}
                >
                  <option value="auto">Match brief</option>
                  <option value="fa">Persian (فارسی)</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label>
                <span>Project type</span>
                <select
                  value={generationProjectType}
                  onChange={(event) => {
                    setGenerationProjectType(
                      event.target.value as DesignGenerationRequest["projectType"],
                    );
                    setGenerationPreview(null);
                    if (generationState === "ready") setGenerationState("idle");
                  }}
                  disabled={generationInFlight}
                >
                  <option value="auto">Detect from brief</option>
                  <option value="storefront">Storefront</option>
                  <option value="dashboard">Dashboard</option>
                  <option value="product">General product</option>
                </select>
              </label>
              <label>
                <span>Theme</span>
                <select
                  value={generationTheme}
                  onChange={(event) => {
                    setGenerationTheme(event.target.value as DesignGenerationRequest["theme"]);
                    setGenerationPreview(null);
                    if (generationState === "ready") setGenerationState("idle");
                  }}
                  disabled={generationInFlight}
                >
                  <option value="auto">Match brief</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
            <label className="generation-text-field">
              <span>Screen names (one per line or comma-separated for larger batches)</span>
              <input
                value={generationScreenNames}
                onChange={(event) => {
                  setGenerationScreenNames(event.target.value);
                  setGenerationPreview(null);
                  if (generationState === "ready") setGenerationState("idle");
                }}
                disabled={generationInFlight}
                placeholder="Home, Products, Cart"
                dir={generationLanguage === "fa" ? "rtl" : "auto"}
              />
            </label>
            <label className="generation-text-field">
              <span>Visual direction (optional)</span>
              <input
                value={generationStyle}
                onChange={(event) => {
                  setGenerationStyle(event.target.value.slice(0, 160));
                  setGenerationPreview(null);
                  if (generationState === "ready") setGenerationState("idle");
                }}
                maxLength={160}
                disabled={generationInFlight}
                placeholder="Editorial, calm, premium…"
              />
            </label>

            <div className="model-option">
              <label htmlFor="design-model">Model</label>
              {companionModels.length > 0 ? (
                <>
                  <select
                    id="design-model"
                    value={selectedCompanionModel}
                    onChange={(event) => {
                      setSelectedCompanionModel(event.target.value);
                      setSmokeResult(null);
                      setSmokeDiagnostic(null);
                    }}
                    disabled={companionBusy || generationInFlight}
                  >
                    {companionModels.map((model) => (
                      <option key={model.slug} value={model.slug}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                  <p className="option-help">Loaded from this signed-in account.</p>
                </>
              ) : (
                <div className="model-empty-state" aria-live="polite">
                  <span>
                    {getModelAvailabilityMessage(
                      modelDiscovery,
                      Boolean(companionToken),
                      Boolean(companionStatus?.planUseAuthorized),
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => dispatchNavigation({ type: "open-settings" })}
                  >
                    {companionToken ? "Manage connection" : "Open Settings"}
                  </button>
                </div>
              )}
              <p className="model-verification-note" role="status">
                {inferenceEligibility.eligible
                  ? "A real Responses smoke request succeeded for this exact account-visible model."
                  : inferenceEligibility.message}
              </p>
            </div>
          </section>

          <button
            className="design-generate-button"
            type="button"
            onClick={() => void generateDesignFromBrief()}
            disabled={Boolean(generationBlockReason)}
            aria-describedby="generation-help"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5v13m-6.5-6.5h13M3.75 3.75l8.5 8.5m0-8.5-8.5 8.5" />
            </svg>
            Generate Design
          </button>
          <p className="generation-help" id="generation-help">
            {generationBlockReason ??
              "Generation creates a validated JSON plan only; review it in the existing JSON tab before rendering."}
          </p>

          {generationInFlight && (
            <div className="generation-progress" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>
                {generationScreenProgress.retrying
                  ? `Retrying screen ${generationScreenProgress.completed + 1} of ${generationScreenProgress.total}; incomplete output was discarded.`
                  : generationScreenProgress.total
                    ? `${generationProgressText(generationState)} Screen ${generationScreenProgress.completed + (generationState === "generating" ? 1 : 0)} of ${generationScreenProgress.total}.`
                    : generationProgressText(generationState)}
              </span>
              <button className="text-button" type="button" onClick={cancelDesignGeneration}>
                Cancel
              </button>
            </div>
          )}

          {generationState === "failed" || generationState === "cancelled" ? (
            <section className="generation-result generation-failure" role="alert">
              <strong>
                {generationState === "cancelled"
                  ? "Generation cancelled"
                  : "Generation needs attention"}
              </strong>
              <ErrorList errors={generationErrors} />
            </section>
          ) : null}

          {generationPlan.success && prompt.trim().length >= 10 && (
            <section className="generation-plan" aria-label="Planned screen inventory">
              <div className="section-title-row">
                <h2>Planned screens</h2>
                <span className="section-caption">{generationPlan.data.screens.length} frames</span>
              </div>
              <ul className="planned-screen-list">
                {generationPlan.data.screens.map((screen) => (
                  <li key={screen.id}>
                    <strong>{screen.name}</strong>
                    <span>
                      {screen.width} × {screen.height} · {screen.devicePreset}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {generationState === "ready" && generationPreview && (
            <section className="generation-result" aria-labelledby="generation-result-title">
              <div className="section-title-row">
                <h2 id="generation-result-title">Design plan ready</h2>
                <span className="section-caption">NOT RENDERED</span>
              </div>
              <p className="generation-summary">
                <strong>{generationPreview.projectName}</strong> ·{" "}
                {generationPreview.plan.screens.length} screens · {generationPreview.nodeCount}{" "}
                estimated editable nodes · {generationPreview.warnings.length} warnings
                {generationPreview.repairAttempts ? " · repaired once" : ""}
              </p>
              <ul className="planned-screen-list">
                {generationPreview.plan.screens.map((screen) => (
                  <li key={screen.id}>
                    <strong>{screen.name}</strong>
                    <span>
                      {screen.width} × {screen.height} · {screen.devicePreset}
                    </span>
                  </li>
                ))}
              </ul>
              <details className="generation-warnings">
                <summary>
                  Warnings and review checklist ({generationPreview.warnings.length})
                </summary>
                <ErrorList errors={generationPreview.warnings} />
              </details>
              <button className="secondary-action" type="button" onClick={inspectGeneratedJson}>
                Review JSON before rendering
              </button>
            </section>
          )}

          <section className="offline-fixtures" aria-label="Offline design fixtures">
            <div className="section-title-row">
              <h2>Offline fixtures</h2>
              <span className="section-caption">NO AI REQUEST</span>
            </div>
            <p>Deterministic editable examples remain available when the companion is offline.</p>
            <div className="fixture-actions">
              <button
                type="button"
                onClick={() => openOfflineFixture(phase45Sample, "Persian storefront fixture")}
                disabled={generationInFlight}
              >
                Persian storefront · 10 screens
              </button>
              <button
                type="button"
                onClick={() =>
                  openOfflineFixture(phase5DashboardSample, "English dashboard fixture")
                }
                disabled={generationInFlight}
              >
                English dashboard · 2 screens
              </button>
            </div>
          </section>

          <section className="recent-section" aria-labelledby="recent-title">
            <div className="section-title-row">
              <h2 id="recent-title">Recent</h2>
              <span className="section-caption">LOCAL</span>
            </div>
            <div className="recent-empty-state">
              <span className="recent-empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <rect x="5" y="3.5" width="14" height="17" rx="2" />
                  <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
                </svg>
              </span>
              <strong>Recent projects aren’t saved yet</strong>
              <span>This plugin does not keep a project history.</span>
            </div>
          </section>
        </section>
      ) : null}

      {!settingsOpen && activeView === "json" && (
        <>
          <section className="intro-row" aria-label="JSON workflow">
            <span className="step-indicator">OFFLINE WORKFLOW</span>
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
                  {inputValid
                    ? "Structure looks good"
                    : json
                      ? "Needs attention"
                      : "Waiting for JSON"}
                </span>
                <span className="char-count">{json.length.toLocaleString()} characters</span>
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
        </>
      )}

      {settingsOpen && (
        <section className="ai-gate-panel" aria-labelledby="ai-gate-title">
          <div className="design-system-heading">
            <div>
              <span className="section-kicker">PHASE 4.6 · CONNECTION</span>
              <h2 id="ai-gate-title">Companion &amp; ChatGPT</h2>
            </div>
            <span className={`system-status ${inferenceEligibility.eligible ? "is-ready" : ""}`}>
              {getInferenceStatusLabel(companionStatus, inferenceEligibility) ||
                (
                  {
                    discovering: "Checking local companion…",
                    reconnecting: "Restoring saved connection…",
                    offline: "Companion offline",
                    available: "Companion available · sign-in not checked",
                    approval_required: "Local approval required",
                    pairing: "Pairing with local companion",
                    connected: "Locally connected",
                  } satisfies Record<CompanionConnectionState, string>
                )[companionConnectionState]}
            </span>
          </div>
          {restoreStorageWarning && (
            <p className="ai-gate-note" role="status">
              Secure session restoration is unavailable. This connection works now, but Figma or the
              companion may ask for local approval or ChatGPT sign-in again after a restart.
            </p>
          )}
          {!companionToken ? (
            <>
              {companionConnectionState === "offline" ||
              companionConnectionState === "discovering" ||
              companionConnectionState === "reconnecting" ? (
                <>
                  <p className="ai-gate-note">
                    {companionConnectionState === "reconnecting" && restoreTicket
                      ? "Restoring the previous local approval. Keep the companion running."
                      : "The local companion is not available. In PowerShell, run npm run companion from the project folder, then retry here. The plugin cannot launch local executables."}
                  </p>
                  <button
                    className="system-action"
                    type="button"
                    onClick={() => setCompanionConnectionState("discovering")}
                    disabled={
                      companionConnectionState === "discovering" ||
                      companionConnectionState === "reconnecting"
                    }
                  >
                    {companionConnectionState === "discovering"
                      ? "Checking companion…"
                      : companionConnectionState === "reconnecting"
                        ? "Restoring connection…"
                        : "Retry connection"}
                  </button>
                </>
              ) : companionConnectionState === "approval_required" ||
                companionConnectionState === "pairing" ? (
                <>
                  <p className="ai-gate-note">
                    The companion is waiting for local approval. It normally opens the page in your
                    system browser; use the button below if it did not. Approve only if you just
                    started this connection here. The separate official ChatGPT sign-in opens after
                    local approval.
                  </p>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => void reopenApprovalPage()}
                    disabled={approvalPageBusy || !pairingAttemptId}
                  >
                    {approvalPageBusy ? "Opening approval page…" : "Open approval page again"}
                  </button>
                  <button
                    className="text-button ai-disconnect"
                    type="button"
                    onClick={() => void cancelLocalConnection()}
                    disabled={!pairingAttemptId}
                  >
                    Cancel local approval
                  </button>
                </>
              ) : (
                <>
                  <p className="ai-gate-note">
                    Continue opens a local approval page the first time this plugin connects to the
                    companion. The browser page cannot identify a specific plugin, so approve only
                    after initiating this action here. ChatGPT sign-in and plan-use consent remain
                    separate.
                  </p>
                  <button
                    className="system-action"
                    type="button"
                    onClick={() => void continueWithChatGPT()}
                    disabled={companionBusy}
                  >
                    {companionBusy ? "Connecting…" : "Continue with ChatGPT"}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <p className="ai-gate-note">
                Sign-in opens your system browser. Identity permission and direct plan-use
                permission are separate; the granted scope is checked after return.
              </p>
              {!companionStatus?.planUseAuthorized ? (
                <>
                  <button
                    className="system-action"
                    type="button"
                    onClick={() => void signInWithChatGPT()}
                    disabled={companionBusy || companionStatus?.auth === "signing_in"}
                  >
                    {companionStatus?.auth === "signing_in"
                      ? "Waiting for browser sign-in…"
                      : "Continue with ChatGPT"}
                  </button>
                  {(companionStatus?.auth === "signing_in" ||
                    companionStatus?.safeMessage === "system_browser_unavailable") && (
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => void reopenChatGPTBrowser()}
                      disabled={companionBusy}
                    >
                      Open sign-in page in system browser again
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="ai-gate-note ai-gate-ready">
                    {inferenceEligibility.eligible
                      ? `A real Responses smoke test completed for ${companionModels.find(({ slug }) => slug === inferenceEligibility.verifiedModel)?.displayName ?? inferenceEligibility.verifiedModel}.`
                      : inferenceEligibility.message}
                  </p>
                  <button
                    className="system-action"
                    type="button"
                    onClick={() => void discoverModels()}
                    disabled={companionBusy || generationInFlight}
                  >
                    {companionBusy ? "Checking account models…" : "Load available models"}
                  </button>
                  {companionModels.length > 0 && (
                    <label className="ai-gate-field">
                      <span>Account-visible model</span>
                      <select
                        value={selectedCompanionModel}
                        onChange={(event) => {
                          setSelectedCompanionModel(event.target.value);
                          setSmokeResult(null);
                          setSmokeDiagnostic(null);
                        }}
                        disabled={companionBusy || generationInFlight}
                      >
                        {companionModels.map((model) => (
                          <option key={model.slug} value={model.slug}>
                            {model.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <details className="advanced-settings">
                    <summary>Developer diagnostics</summary>
                    <p>
                      Sends the fixed text “Reply with exactly OK.” to verify live Responses access.
                      It does not send your design prompt or JSON.
                    </p>
                    <button
                      className="secondary-action ai-smoke-action"
                      type="button"
                      onClick={() => void runCompanionSmoke()}
                      disabled={
                        companionBusy ||
                        generationInFlight ||
                        !companionStatus.planUseAuthorized ||
                        !selectedCompanionModel
                      }
                    >
                      {companionBusy ? "Waiting for Responses…" : "Run fixed Responses smoke test"}
                    </button>
                    {smokeInFlight && (
                      <button
                        className="text-button ai-disconnect"
                        type="button"
                        onClick={cancelCompanionSmoke}
                      >
                        Cancel smoke request
                      </button>
                    )}
                    {smokeResult && (
                      <p className="ai-gate-result" role="status">
                        Responses output: <code>{smokeResult}</code>.{" "}
                        {inferenceEligibility.eligible
                          ? "The selected model is verified for design generation."
                          : `Generation remains disabled: ${inferenceEligibility.message}`}
                        {smokeDiagnostic && (
                          <small className="inference-diagnostic">
                            {formatInferenceDiagnostic(smokeDiagnostic)}
                          </small>
                        )}
                      </p>
                    )}
                  </details>
                </>
              )}
              <button
                className="text-button ai-disconnect"
                type="button"
                onClick={() => void disconnectLocalCompanion()}
                disabled={companionBusy}
              >
                Disconnect this plugin from the local companion
              </button>
              <button
                className="text-button ai-disconnect"
                type="button"
                onClick={() => void disconnectCompanion()}
                disabled={companionBusy}
              >
                Disconnect ChatGPT account
              </button>
              <button
                className="text-button ai-disconnect"
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Clear the saved local account registration and start a fresh ChatGPT account sign-in? The stable installation host ID will remain.",
                    )
                  ) {
                    void disconnectCompanion(true);
                  }
                }}
                disabled={companionBusy}
              >
                Forget account registration and switch account
              </button>
            </>
          )}
          {companionError && (
            <p className="ai-gate-error" role="alert">
              {companionError}
            </p>
          )}
          <p className="ai-gate-privacy">
            Sign-in does not grant access to ChatGPT conversations, files, or memory. The smoke
            action sends only “Reply with exactly OK.” An explicit Generate Design action sends the
            brief and fixed screen plan to the local companion for one streamed Responses request;
            the open JSON document and local assets are not sent. Live structured-output support is
            not guaranteed by the smoke test and may vary by account-visible model.
          </p>
        </section>
      )}

      {notice.title !== "Ready to validate" && (
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
      )}

      {!settingsOpen && activeView === "quality" && (
        <section className="visual-quality-panel" aria-labelledby="visual-quality-title">
          <div className="design-system-heading">
            <div>
              <span className="section-kicker">VISUAL PREFLIGHT</span>
              <h2 id="visual-quality-title">Quality preflight</h2>
            </div>
            <span className={`system-status ${visualAudit ? "is-ready" : ""}`}>
              {visualAudit ? `${visualAudit.diagnostics.length} findings` : "Validate JSON"}
            </span>
          </div>
          {visualAudit ? (
            <>
              <p className="visual-quality-summary">
                {visualAudit.screenCount} screen{visualAudit.screenCount === 1 ? "" : "s"} ·{" "}
                {batchPreview?.estimatedNodeCount ?? visualAudit.estimatedNativeNodes} estimated
                nodes · {visualAudit.componentCount} shared masters · {visualAudit.instanceCount}{" "}
                instances · {visualAudit.assetCount} assets
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
        </section>
      )}

      {!settingsOpen && activeView === "assets" && (
        <section className="assets-panel" aria-labelledby="assets-title">
          <div className="design-system-heading">
            <div>
              <span className="section-kicker">LOCAL ASSETS</span>
              <h2 id="assets-title">Asset library</h2>
            </div>
            <span className={`system-status ${assetInventory.length ? "is-ready" : ""}`}>
              {assetInventory.length} embedded
            </span>
          </div>
          <p className="page-description">
            Add local images and safe SVG paths to the current JSON document. Asset bytes stay in
            the offline workflow.
          </p>
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
            Local raster bytes are embedded in JSON (256 KiB each, 4,096 px maximum); safe SVG
            imports become editable path layers (50 KB, 32 paths max).
          </p>
        </section>
      )}

      {!settingsOpen && activeView === "json" && batchMode ? (
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
      ) : !settingsOpen && activeView === "system" ? (
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
      ) : null}

      {!settingsOpen && activeView === "json" && (
        <>
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
        </>
      )}

      <footer className="footer-note">
        <span className="local-icon" aria-hidden="true">
          ●
        </span>
        <span>Offline JSON</span>
        <span className="footer-divider">·</span>
        <span>Optional user-authorized companion · native editable layers</span>
      </footer>
    </main>
  );
}

function companionErrorText(error: unknown): string {
  const category =
    error instanceof CompanionClientError
      ? error.category
      : typeof error === "string"
        ? error
        : "connection_failed";
  const messages: Record<string, string> = {
    pairing_busy:
      "Another local approval is already pending. Finish or cancel it in the first Figma plugin, then retry.",
    pairing_rate_limited:
      "Too many local connection attempts were made. Wait a minute before trying again.",
    pairing_approval_unavailable:
      "The companion could not open the local approval page. Check that Windows has a default browser, then retry.",
    pairing_denied: "Local companion access was denied. No ChatGPT sign-in was started.",
    pairing_expired: "The local approval expired. Start a new connection from the Figma plugin.",
    pairing_cancelled: "Local companion connection was cancelled.",
    pairing_replayed: "This local approval was already used. Start a new connection from Figma.",
    system_browser_unavailable:
      "Windows could not open the system browser. Use the button to retry sign-in, or check your default browser.",
    browser_open_rate_limited:
      "Too many browser launch attempts were made. Wait briefly, then try again or restart the sign-in flow.",
    pairing_unavailable:
      "The local companion cannot accept another connection right now. Restart it and retry.",
    pairing_failed: "Local connection could not be verified. Start a new approval from Figma.",
    pairing_required: "Reconnect the local companion from the Figma plugin.",
    sign_in_already_pending:
      "A browser sign-in is already pending. Finish or cancel that attempt first.",
    sign_in_timed_out: "The browser sign-in attempt expired. Start a new sign-in from Figma.",
    consent_denied: "ChatGPT sign-in or permission was declined.",
    callback_invalid: "The sign-in callback did not match this attempt. Start sign-in again.",
    client_id_mismatch:
      "The returned OAuth client did not match this installation. Restart sign-in.",
    plan_use_scope_missing:
      "Identity sign-in succeeded, but direct plan-use permission was not granted.",
    plan_use_not_admitted:
      "The service did not admit this plan-authorized request. Check eligibility and permission.",
    account_not_eligible:
      "This ChatGPT account or workspace is not eligible for plan inference. Check account/workspace policy; do not retry the same request as a workaround.",
    unsupported_capability:
      "The selected model or account rejected a Responses capability in this request. The smoke test proves basic inference only; check the sanitized parameter/code below and try another account-visible supported model.",
    route_not_supported:
      "The plan-use service does not support this Responses route for the account. Confirm the current official integration requirements.",
    responses_transport_error:
      "The Responses stream was interrupted by a network/transport failure. The local companion was reachable, but no terminal event was received; check the network and retry once.",
    quota_or_rate_limit:
      "The account reached a rate or usage limit. Try later or check account eligibility.",
    session_expired: "The local authorization expired. Sign in again.",
    request_timed_out:
      "The companion request reached a bounded deadline. Incomplete stream output is discarded; check the timeout kind and activity timings below.",
    request_cancelled:
      "The inference request was cancelled. The companion asks the upstream stream to stop.",
    inference_not_verified:
      "The selected model has not passed a real Responses smoke test in this companion session. Run the fixed test in Settings first.",
    inference_busy:
      "Another Responses request is in progress in the companion. Wait for it to finish, then retry.",
    generation_busy:
      "Another design request is already running in the companion. Wait for it to finish, then retry.",
    generation_retry_limit:
      "This request has used its one schema-repair attempt. Start a new generation if you want to try again.",
    invalid_design_request:
      "The companion rejected the generation request. Review the validation detail; if it mentions contract mismatch, reload the plugin and restart the companion.",
    service_unavailable: "The OpenAI service is temporarily unavailable.",
    model_not_verified_for_account: "Choose a model returned by this account's model list.",
    account_mismatch:
      "This registration belongs to another account. Use Forget account registration and switch account before signing in with a different account.",
    public_client_unsupported:
      "The discovered OAuth server did not advertise the required public-client method.",
    response_incomplete:
      "No completed design/smoke result was accepted. The stream was incomplete or ended before response.completed; partial output was discarded.",
    response_invalid:
      "The companion received an invalid SSE event. No partial output was accepted; retry once and share only the safe diagnostic.",
    resource_exhausted:
      "The companion ran out of available memory or temporary disk space while processing the design. Free local resources, then rerun; completed screens are retained for resuming.",
    response_too_large: "A small companion control response exceeded its safety limit.",
    registration_clear_failed:
      "The local session was cleared, but the saved account registration could not be removed. Close the companion before trying again.",
    secure_storage_unavailable:
      "Windows protected storage is unavailable. This session works in memory, but it cannot be restored after the companion restarts.",
    secure_storage_timeout:
      "Windows protected storage did not respond in time. The session remains available in memory; retry before restarting the companion.",
    credential_store_corrupt:
      "The protected session file is damaged or cannot be unlocked. Sign in again after confirming the companion is running as your Windows user.",
    host_id_invalid:
      "The local installation host ID is not in the documented format. Sign-in was stopped before opening the browser.",
    installation_store_invalid:
      "The saved local installation metadata is invalid and was preserved. Do not delete it; share this sanitized error category with support.",
    request_rejected:
      "The request was rejected. The selected account model may not support the documented structured JSON response format.",
    unknown: "The companion returned an invalid response. Restart it and reconnect.",
    connection_failed:
      "Cannot reach the local companion. If it is running, Figma or the browser may have blocked localhost (manifest CSP, CORS, or private-network access); reload the development plugin and inspect its console.",
  };
  const message = messages[category] ?? "The companion could not complete that step.";
  const diagnostic = error instanceof CompanionClientError ? error.diagnostic : undefined;
  const validationIssues =
    error instanceof CompanionClientError ? error.validationIssues : undefined;
  return [
    message,
    ...(validationIssues?.length ? [`Validation: ${validationIssues.join(" ")}`] : []),
    ...(diagnostic ? [formatInferenceDiagnostic(diagnostic)] : []),
  ].join(" ");
}

function formatInferenceDiagnostic(diagnostic: InferenceDiagnostic): string {
  const details = [
    `model=${diagnostic.model}`,
    `stage=${diagnostic.stage}`,
    `outcome=${diagnostic.outcome}`,
    ...(diagnostic.httpStatus ? [`HTTP=${diagnostic.httpStatus}`] : []),
    ...(diagnostic.terminalEvent ? [`terminal=${diagnostic.terminalEvent}`] : []),
    ...(diagnostic.lastEvent ? [`last_event=${diagnostic.lastEvent}`] : []),
    ...(diagnostic.eventCount !== undefined ? [`events=${diagnostic.eventCount}`] : []),
    ...(diagnostic.responseBytes !== undefined ? [`stream_bytes=${diagnostic.responseBytes}`] : []),
    ...(diagnostic.generatedBytes !== undefined
      ? [`generated_bytes=${diagnostic.generatedBytes}`]
      : []),
    ...(diagnostic.timeoutKind ? [`timeout_kind=${diagnostic.timeoutKind}`] : []),
    ...(diagnostic.elapsedMs !== undefined ? [`elapsed_ms=${diagnostic.elapsedMs}`] : []),
    ...(diagnostic.idleMs !== undefined ? [`idle_ms=${diagnostic.idleMs}`] : []),
    ...(diagnostic.lastEventAgeMs !== undefined
      ? [`last_event_age_ms=${diagnostic.lastEventAgeMs}`]
      : []),
    ...(diagnostic.lastDeltaAgeMs !== undefined
      ? [`last_delta_age_ms=${diagnostic.lastDeltaAgeMs}`]
      : []),
    ...(diagnostic.errorCode ? [`upstream_code=${diagnostic.errorCode}`] : []),
    ...(diagnostic.errorParam ? [`upstream_param=${diagnostic.errorParam}`] : []),
    ...(diagnostic.incompleteReason ? [`incomplete_reason=${diagnostic.incompleteReason}`] : []),
  ];
  return `Safe diagnostic: ${details.join("; ")}.`;
}

function parseScreenNames(value: string): string[] {
  return value
    .split(/[\n,،]+/u)
    .map((name) => name.trim())
    .filter(Boolean);
}

function getDesignGenerationBlockReason(input: {
  prompt: string;
  planValid: boolean;
  planErrors: string[];
  inferenceEligibility: InferenceEligibility;
  inFlight: boolean;
}): string | null {
  if (input.inFlight) return "A design request is already running.";
  if (input.prompt.trim().length < 10) return "Enter a design brief with at least 10 characters.";
  if (!input.planValid) return input.planErrors[0] ?? "Review the screen plan options.";
  if (!input.inferenceEligibility.eligible) return input.inferenceEligibility.message;
  return null;
}

function generationProgressText(state: GenerationState): string {
  return (
    {
      idle: "Waiting",
      planning: "Planning the screen inventory…",
      generating: "Generating a structured design with the selected account model…",
      validating: "Validating the response against the native design schema…",
      preparing: "Preparing the JSON review and quality warnings…",
      ready: "Ready for review",
      failed: "Generation failed",
      cancelled: "Generation cancelled",
    } satisfies Record<GenerationState, string>
  )[state];
}
