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
  type PluginToUIMessage,
  type UIToPluginMessage,
} from "../shared/messages";
import { FigmaToolOperationSchema, type FigmaToolOperation } from "../shared/figma-tools";
import { type ChatInputItem } from "../shared/chat-tools";
import { type ChatTask, chatTaskProgress } from "../shared/chat-task";
import { runChatTask, chatTaskInput } from "./chat-task";
import { chatTaskBridge } from "./chat-task-bridge";
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
  generationBridge,
  draftRequest,
  loadSavedDraft,
  importSavedDraft,
} from "./generation-session";
import {
  validateDraftSection,
  type DraftManifest,
  type SavedDraft,
} from "../shared/generation-draft";
import {
  createDesignPlan,
  createDesignSections,
  normalizeGeneratedDesignResponse,
  type GeneratedDesign,
  type DesignGenerationRequest,
  type DesignPlan,
} from "../shared/design-generation";
import { createGenerationTransaction } from "../shared/generation-transaction";
import { prepareGeneratedDesign } from "./design-generation";
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
  streamAuthorizedChat,
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
  manifest: DraftManifest;
  projectName?: string;
  palette?: GeneratedDesign["palette"];
  screens: GeneratedDesign["screens"];
  transactions: SavedDraft["transactions"];
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: string;
};

type ChatToolResult = Extract<PluginToUIMessage, { type: "tool-result" }>;

function safeChatProse(text: string): string {
  if (/```|^\s*[[{]|"(?:tool|arguments|call_id|properties)"\s*:/mu.test(text))
    return "Internal structured output was hidden. See task progress for confirmed canvas changes.";
  return text;
}

type SectionStage =
  | "queued"
  | "generating"
  | "validating"
  | "saving"
  | "applying"
  | "saved"
  | "completed"
  | "needs-repair"
  | "paused"
  | "failed";

export type CompanionConnectionState =
  | "discovering"
  | "reconnecting"
  | "offline"
  | "available"
  | "approval_required"
  | "pairing"
  | "connected";

export type PluginView = "chat" | "design" | "json" | "assets" | "system" | "quality";
export type ModelDiscoveryState = "idle" | "loading" | "loaded" | "empty" | "error";
type GenerationTarget = DesignGenerationRequest["target"];
type GenerationLanguage = DesignGenerationRequest["language"];
type GenerationState =
  | "idle"
  | "planning"
  | "generating"
  | "validating"
  | "preparing"
  | "saving"
  | "rendering"
  | "repairing"
  | "paused"
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

function postToPlugin(message: UIToPluginMessage): boolean {
  try {
    parent.postMessage({ pluginMessage: message }, "*");
    return true;
  } catch {
    return false;
  }
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

function developerToolOperation(operationId: string, action: unknown): FigmaToolOperation {
  return FigmaToolOperationSchema.parse({
    operationId,
    idempotencyKey: `phase56:${operationId}`,
    action,
  });
}

const PHASE56_FRAME_REF = "phase56-mobile";
const PHASE56_TITLE_REF = "phase56-title";
const PHASE56_INPUT_REF = "phase56-input";
const PHASE56_INPUT_TEXT_REF = "phase56-input-hint";
const PHASE56_BUTTON_REF = "phase56-button";
const PHASE56_BUTTON_TEXT_REF = "phase56-button-label";
const TOOL_RESPONSE_TIMEOUT_MS = 45_000;

function phase56FixtureOperations() {
  return [
    developerToolOperation("phase56-frame-0001", {
      tool: "create_frame",
      ref: PHASE56_FRAME_REF,
      name: "Phase 5.6 · Persian mobile fixture",
      parent: { kind: "page" },
      size: { width: 390, height: 844 },
      fill: "#F8FAFC",
      cornerRadius: 28,
      autoLayout: {
        direction: "vertical",
        gap: 20,
        padding: { top: 32, right: 24, bottom: 24, left: 24 },
        counterAlign: "MIN",
      },
    }),
    developerToolOperation("phase56-title-0001", {
      tool: "create_text",
      ref: PHASE56_TITLE_REF,
      name: "عنوان فارسی",
      parent: { kind: "node", ref: PHASE56_FRAME_REF },
      text: "فروشگاه شما",
      size: { width: 342, height: 40 },
      direction: "RTL",
      font: { family: "Inter", style: "Regular" },
      fontSize: 24,
      horizontalSizing: "FILL",
      verticalSizing: "HUG",
    }),
    developerToolOperation("phase56-input-0001", {
      tool: "create_frame",
      ref: PHASE56_INPUT_REF,
      name: "فیلد جست‌وجو",
      parent: { kind: "node", ref: PHASE56_FRAME_REF },
      size: { width: 342, height: 54 },
      fill: "#FFFFFF",
      stroke: "#CBD5E1",
      cornerRadius: 12,
      autoLayout: {
        direction: "horizontal",
        gap: 8,
        padding: { top: 8, right: 14, bottom: 8, left: 14 },
        counterAlign: "CENTER",
      },
    }),
    developerToolOperation("phase56-hint-0001", {
      tool: "create_text",
      ref: PHASE56_INPUT_TEXT_REF,
      name: "متن راهنمای ورودی",
      parent: { kind: "node", ref: PHASE56_INPUT_REF },
      text: "جست‌وجوی محصول",
      size: { width: 290, height: 24 },
      direction: "RTL",
      align: "RIGHT",
      fontSize: 14,
      color: "#64748B",
      horizontalSizing: "FILL",
      verticalSizing: "HUG",
    }),
    developerToolOperation("phase56-button-0001", {
      tool: "create_frame",
      ref: PHASE56_BUTTON_REF,
      name: "دکمه جست‌وجو",
      parent: { kind: "node", ref: PHASE56_FRAME_REF },
      size: { width: 342, height: 52 },
      fill: "#6841D8",
      cornerRadius: 12,
      autoLayout: {
        direction: "horizontal",
        gap: 8,
        padding: { top: 8, right: 16, bottom: 8, left: 16 },
        primaryAlign: "CENTER",
        counterAlign: "CENTER",
      },
    }),
    developerToolOperation("phase56-label-0001", {
      tool: "create_text",
      ref: PHASE56_BUTTON_TEXT_REF,
      name: "برچسب دکمه",
      parent: { kind: "node", ref: PHASE56_BUTTON_REF },
      text: "جست‌وجو",
      size: { width: 120, height: 24 },
      direction: "RTL",
      align: "CENTER",
      fontSize: 16,
      color: "#FFFFFF",
      horizontalSizing: "HUG",
      verticalSizing: "HUG",
    }),
    developerToolOperation("phase56-color-0001", {
      tool: "set_properties",
      ref: PHASE56_BUTTON_REF,
      properties: { fill: "#0F766E" },
    }),
  ];
}

export default function App({ initialView = "chat" }: { initialView?: PluginView } = {}) {
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
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<SavedDraft | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const [screenStages, setScreenStages] = useState<Record<string, string>>({});
  const [sectionStages, setSectionStages] = useState<Record<string, SectionStage>>({});
  const [currentSection, setCurrentSection] = useState<{
    screenId: string;
    sectionId: "identity" | "primary" | "supporting";
  } | null>(null);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);
  const [followGeneration, setFollowGeneration] = useState(false);
  const followGenerationRef = useRef(false);
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  const [secondsSinceProgress, setSecondsSinceProgress] = useState(0);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [generationPaused, setGenerationPaused] = useState(false);
  const [stageMetrics, setStageMetrics] = useState<Record<string, number>>({});
  const [generationStarted, setGenerationStarted] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const generationAbort = useRef<AbortController | null>(null);
  const generationRequest = useRef<string | null>(null);
  const generationPauseRequested = useRef(false);
  const generationResume = useRef<(() => void) | null>(null);
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
  const [toolBusy, setToolBusy] = useState(false);
  const [toolStatus, setToolStatus] = useState("Ready to run a local native-operation check.");
  const [lastToolOperation, setLastToolOperation] = useState<FigmaToolOperation | null>(null);
  const toolBatchId = useRef<string | null>(null);
  const toolWatchdog = useRef<number | null>(null);
  const toolCompletion = useRef<{
    batchId: string;
    onResult: (message: ChatToolResult) => void;
    onFailure: (message: string) => void;
  } | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatActivity, setChatActivity] = useState("");
  const [chatPendingTool, setChatPendingTool] = useState(false);
  const [chatRetryMessageId, setChatRetryMessageId] = useState<string | null>(null);
  const chatAbort = useRef<AbortController | null>(null);
  const chatModelInput = useRef<ChatInputItem[]>([]);
  const chatTask = useRef<ChatTask | null>(null);
  const [chatTaskSnapshot, setChatTaskSnapshot] = useState<ChatTask | null>(null);
  const [chatTaskLoaded, setChatTaskLoaded] = useState(false);
  const chatRunning = useRef(false);
  const chatStopRequested = useRef(false);
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
  const generationInFlight = [
    "planning",
    "generating",
    "validating",
    "preparing",
    "saving",
    "rendering",
    "repairing",
    "paused",
  ].includes(generationState);
  const inferenceEligibility = getInferenceEligibility({
    companionConnected: Boolean(companionToken) && companionConnectionState === "connected",
    status: companionStatus,
    models: companionModels,
    selectedModel: selectedCompanionModel,
    smokeInFlight,
  });
  const chatReady =
    inferenceEligibility.eligible && Boolean(companionToken && selectedCompanionModel);

  useEffect(() => {
    let active = true;
    void chatTaskBridge({ type: "chat-task-load", requestId: `chat-load-${Date.now()}` })
      .then((result) => {
        if (!active) return;
        const task = result.task ?? null;
        chatTask.current = task;
        setChatTaskSnapshot(task);
        setChatTaskLoaded(true);
        if (!task) return;
        if (task.status === "completed")
          chatModelInput.current = chatTaskInput({ ...task, recent: [] }).filter(
            (item) => "role" in item,
          );
        setChatPendingTool(task.status !== "completed");
        setChatRetryMessageId(task.status === "completed" ? null : task.id);
        setChatMessages([
          { id: `${task.id}-user`, role: "user", content: task.prompt },
          {
            id: task.id,
            role: "assistant",
            content: task.status === "completed" ? safeChatProse(task.text) : "",
            ...(task.status !== "completed"
              ? {
                  error:
                    task.error ??
                    "Saved task restored. Resume reconciles native operations before continuing.",
                }
              : {}),
          },
        ]);
      })
      .catch((error: Error) => {
        if (active) setChatActivity(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
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

  const failToolBatch = (batchId: string, message: string, cancel = true) => {
    if (toolBatchId.current !== batchId) return;
    const completion = toolCompletion.current;
    if (completion?.batchId === batchId) {
      toolCompletion.current = null;
      completion.onFailure(message);
    }
    if (toolWatchdog.current !== null) window.clearTimeout(toolWatchdog.current);
    toolWatchdog.current = null;
    toolBatchId.current = null;
    if (cancel) postToPlugin({ type: "tool-cancel", protocolVersion: 1, batchId });
    setToolBusy(false);
    setToolStatus(message);
  };

  useEffect(
    () => () => {
      generationRequest.current = null;
      generationAbort.current?.abort();
      chatAbort.current?.abort();
      const activeBatchId = toolBatchId.current;
      if (activeBatchId)
        postToPlugin({ type: "tool-cancel", protocolVersion: 1, batchId: activeBatchId });
      toolCompletion.current = null;
      if (toolWatchdog.current !== null) window.clearTimeout(toolWatchdog.current);
    },
    [],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const raw = (event.data as { pluginMessage?: unknown } | null)?.pluginMessage;
      const result = PluginToUISchema.safeParse(raw);
      if (!result.success) {
        if (
          raw &&
          typeof raw === "object" &&
          (raw as { type?: unknown }).type === "tool-result" &&
          typeof (raw as { batchId?: unknown }).batchId === "string" &&
          (raw as { batchId: string }).batchId === toolBatchId.current
        )
          failToolBatch(
            (raw as { batchId: string }).batchId,
            "The plugin returned an invalid tool result. The operation stopped; inspect the canvas before retrying.",
          );
        return;
      }
      const message = result.data;
      if (
        message.type === "generation-result" ||
        message.type === "generation-node-progress" ||
        message.type === "chat-task-result"
      )
        return;
      if (message.type === "tool-progress") {
        if (toolBatchId.current === message.batchId) {
          setToolStatus(`${message.index + 1}/${message.total} · ${message.message}`);
          if (chatRunning.current) setChatActivity(message.message);
        }
        return;
      }
      if (message.type === "tool-result") {
        if (toolBatchId.current === message.batchId) {
          if (toolWatchdog.current !== null) window.clearTimeout(toolWatchdog.current);
          toolWatchdog.current = null;
          toolBatchId.current = null;
          setToolBusy(false);
          const last = message.results.at(-1);
          const replayCount = message.results.filter(({ replayed }) => replayed).length;
          setToolStatus(
            message.cancelled
              ? `Cancelled between operations. ${message.committedOperationIds.length} operation(s) remain committed.`
              : message.success
                ? `${message.results.length} operation(s) completed; ${replayCount} idempotent replay(s), with no duplicate nodes.`
                : `${last?.error ?? "The operation failed."}${message.committedOperationIds.length ? ` ${message.committedOperationIds.length} earlier operation(s) remain committed.` : ""}${message.partialOperationIds.length ? ` Inspect possible partial change(s): ${message.partialOperationIds.join(", ")}.` : ""}`,
          );
          const completion = toolCompletion.current;
          if (completion?.batchId === message.batchId) {
            toolCompletion.current = null;
            completion.onResult(message);
          }
        }
        return;
      }
      if (message.type === "tool-delete-consent-result") {
        setToolStatus(message.message);
        return;
      }
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
        if (
          toolBatchId.current &&
          (!message.requestId || message.requestId === toolBatchId.current)
        ) {
          failToolBatch(message.requestId ?? toolBatchId.current, message.message, false);
          return;
        }
        if (message.requestId && message.requestId !== currentRequest.current) return;
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

  useEffect(() => {
    void generationBridge({ type: "generation-context", requestId: "initial-generation-context" })
      .then((context) => {
        setDocumentId(context.documentId ?? null);
        if (context.generationId)
          setDraftNotice(
            "Saved generation reference found. Connect the local companion to recover its validated content.",
          );
      })
      .catch(() =>
        setDraftNotice("Document identity unavailable; reload the plugin before generating."),
      );
  }, []);

  useEffect(() => {
    if (!generationStarted || !generationInFlight) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setElapsedSeconds(Math.floor((now - generationStarted) / 1000));
      setSecondsSinceProgress(lastProgressAt ? Math.floor((now - lastProgressAt) / 1000) : 0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generationStarted, generationInFlight, lastProgressAt]);

  useEffect(() => {
    if (!companionToken || !documentId) return;
    let active = true;
    void loadSavedDraft(companionToken, documentId)
      .then((draft) => {
        if (!active) return;
        setSavedDraft(draft);
        setDraftNotice(
          draft
            ? `${draft.screens.length} of ${draft.manifest.request.screenCount * (draft.manifest.request.target === "both" ? 2 : 1)} validated screens restored from durable local storage. Resume reconciles existing frames and generates only missing content.`
            : "No saved draft for this document/page and account.",
        );
      })
      .catch((error) => {
        if (active) {
          setSavedDraft(null);
          setDraftNotice(error instanceof Error ? error.message : "Draft recovery failed.");
        }
      });
    return () => {
      active = false;
    };
  }, [companionToken, documentId, companionStatus?.auth]);

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

  const runToolOperations = (
    operations: FigmaToolOperation[],
    completion?: {
      onResult: (message: ChatToolResult) => void;
      onFailure: (message: string) => void;
    },
  ) => {
    if (!operations.length) {
      completion?.onFailure("The operation list was empty.");
      return;
    }
    if (toolBatchId.current) {
      completion?.onFailure("Another native operation is still running. Wait before retrying.");
      return;
    }
    const batchId = `phase56-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    toolBatchId.current = batchId;
    if (completion) toolCompletion.current = { batchId, ...completion };
    setToolBusy(true);
    if (!completion) setLastToolOperation(operations.at(-1) ?? null);
    setToolStatus(`Starting ${operations.length} local operation(s)…`);
    toolWatchdog.current = window.setTimeout(() => {
      failToolBatch(
        batchId,
        "No plugin response arrived within 45 seconds. Cancellation was requested; inspect the canvas before retrying. Retrying reuses operation IDs to prevent duplicates.",
      );
    }, TOOL_RESPONSE_TIMEOUT_MS);
    if (!postToPlugin({ type: "tool-execute", protocolVersion: 1, batchId, operations }))
      failToolBatch(
        batchId,
        "Could not send the operation to the Figma plugin. Reload the plugin and retry.",
        false,
      );
  };

  const sendChatMessage = async (retry = false) => {
    if (chatRunning.current || toolBatchId.current || !chatTaskLoaded) return;
    if (!companionToken || !selectedCompanionModel || !chatReady) return;
    if (!retry && chatTask.current && chatTask.current.status !== "completed") return;
    const text = chatInput.trim();
    if (!retry && !text) return;
    chatStopRequested.current = false;
    chatRunning.current = true;
    setChatBusy(true);
    const controller = new AbortController();
    chatAbort.current = controller;
    let assistantId = chatTask.current?.id ?? "";
    try {
      if (!retry) {
        const loaded = await chatTaskBridge({ type: "chat-task-load", requestId: nextRequestId() });
        if (loaded.task && loaded.task.status !== "completed")
          throw new Error(
            "A saved task is pending on this page. Reload the plugin to restore it rather than overwrite its checkpoint.",
          );
        const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        assistantId = id;
        chatTask.current = {
          version: 1,
          id,
          documentId: loaded.documentId,
          prompt: text,
          context:
            chatTask.current?.documentId === loaded.documentId
              ? chatModelInput.current
              : loaded.task
                ? chatTaskInput(loaded.task).filter((item) => "role" in item)
                : [],
          stages: [],
          ledger: [],
          pending: [],
          recent: [],
          starts: chatTask.current?.starts ?? [],
          rounds: 0,
          batches: 0,
          lastResponseCalls: 0,
          status: "ready",
          text: "",
        };
        setChatMessages((messages) => [
          ...messages,
          { id: `${id}-user`, role: "user", content: text },
          { id, role: "assistant", content: "" },
        ]);
        setChatInput("");
      }
      const task = chatTask.current;
      if (!task) return;
      setChatRetryMessageId(null);
      setChatPendingTool(true);
      setChatMessages((messages) =>
        messages.map((message) =>
          message.id === assistantId ? { ...message, error: undefined } : message,
        ),
      );
      await runChatTask(task, {
        signal: controller.signal,
        save: async (checkpoint) => {
          await chatTaskBridge({
            type: "chat-task-save",
            requestId: nextRequestId(),
            documentId: checkpoint.documentId,
            task: checkpoint,
          });
          setChatTaskSnapshot(structuredClone(checkpoint));
        },
        progress: setChatActivity,
        model: (input) =>
          streamAuthorizedChat(
            companionToken,
            nextRequestId(),
            selectedCompanionModel,
            input,
            fetch,
            controller.signal,
            () => setChatActivity("Receiving the next bounded stage…"),
            (elapsedMs) => setChatActivity(`Model is working · ${Math.ceil(elapsedMs / 1_000)}s`),
          ),
        execute: (operations) =>
          new Promise<ChatToolResult>((resolve, reject) =>
            runToolOperations(operations, {
              onResult: resolve,
              onFailure: (message) => reject(new Error(message)),
            }),
          ),
      });
      chatModelInput.current = chatTaskInput({ ...task, recent: [] }).filter(
        (item) => "role" in item,
      );
      setChatPendingTool(false);
      setChatRetryMessageId(null);
      setChatMessages((messages) =>
        messages.map((message) =>
          message.id === assistantId
            ? { ...message, content: safeChatProse(task.text), error: undefined }
            : message,
        ),
      );
      setChatActivity(chatTaskProgress(task));
    } catch (error) {
      if (chatTask.current) setChatTaskSnapshot(structuredClone(chatTask.current));
      const stopped = chatStopRequested.current || controller.signal.aborted;
      const message = stopped
        ? "Stopped. Confirmed changes remain on Canvas. Resume reconciles in-flight operation IDs before continuing."
        : error instanceof CompanionClientError && error.safeMessage
          ? error.safeMessage
          : error instanceof Error && error.message !== "chat_stopped"
            ? error.message
            : companionErrorText(error);
      setChatMessages((messages) =>
        messages.map((item) => (item.id === assistantId ? { ...item, error: message } : item)),
      );
      setChatRetryMessageId(
        chatTask.current && chatTask.current.status !== "completed" ? assistantId : null,
      );
      setChatActivity(stopped ? "Stopped" : message);
    } finally {
      if (chatAbort.current === controller) chatAbort.current = null;
      chatRunning.current = false;
      setChatBusy(false);
    }
  };

  const stopChat = () => {
    chatStopRequested.current = true;
    chatAbort.current?.abort();
    if (toolBatchId.current) cancelToolBatch();
    setChatActivity("Stopping; the current native operation will finish or time out…");
  };

  const clearChat = () => {
    if (chatBusy || toolBusy) return;
    const documentId = chatTask.current?.documentId;
    if (
      chatTask.current &&
      chatTask.current.status !== "completed" &&
      !window.confirm(
        "Discard the saved task? Existing canvas changes will remain, but this task will no longer be resumable.",
      )
    )
      return;
    if (documentId)
      void chatTaskBridge({
        type: "chat-task-save",
        requestId: nextRequestId(),
        documentId,
        task: null,
      })
        .then(() => {
          chatTask.current = null;
          setChatTaskSnapshot(null);
          setChatPendingTool(false);
          setChatMessages([]);
          chatModelInput.current = [];
          setChatRetryMessageId(null);
          setChatActivity("");
        })
        .catch((error: Error) => setChatActivity(error.message));
    else {
      chatModelInput.current = [];
      setChatMessages([]);
      setChatActivity("");
    }
  };

  const runFixtureStep = (start: number, end: number) =>
    runToolOperations(phase56FixtureOperations().slice(start, end));

  const replayLastToolOperation = () => {
    if (!lastToolOperation) return;
    runToolOperations([lastToolOperation]);
  };

  const cancelToolBatch = () => {
    const batchId = toolBatchId.current;
    if (!batchId) return;
    setToolStatus(
      "Cancellation requested; the active native operation will finish or time out before the batch stops.",
    );
    if (!postToPlugin({ type: "tool-cancel", protocolVersion: 1, batchId }))
      failToolBatch(
        batchId,
        "Could not send cancellation. Waiting for the bounded operation timeout.",
        false,
      );
  };

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
    setSavedDraft(null);
    setScreenStages({});
    setGenerationPreview(null);
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
    if (!documentId) {
      setGenerationErrors(["Wait for document identity before generating."]);
      setGenerationState("failed");
      return;
    }

    const requestId = nextRequestId();
    const controller = new AbortController();
    const totalStartedAt = performance.now();
    generationRequest.current = requestId;
    generationAbort.current = controller;
    generationPauseRequested.current = false;
    setPauseRequested(false);
    setGenerationPaused(false);
    setGenerationPreview(null);
    setGenerationErrors([]);
    setGenerationState("planning");
    setGenerationStarted(Date.now());
    setLastProgressAt(Date.now());
    setElapsedSeconds(0);
    setStageMetrics({});
    setScreenStages({});
    setSectionStages({});
    setCurrentSection(null);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (controller.signal.aborted) {
      generationRequest.current = null;
      generationAbort.current = null;
      setGenerationState("cancelled");
      setGenerationErrors([
        "Generation was cancelled. No model-generated Figma content was created.",
      ]);
      return;
    }

    const draftKey = JSON.stringify({
      model: selectedCompanionModel,
      request: planResult.data.request,
    });
    let draft: GenerationDraft = {
      screens: [],
      transactions: [],
      manifest: {
        version: 1,
        documentId,
        generationId: `generation-${nextRequestId()}`,
        model: selectedCompanionModel,
        request: planResult.data.request,
        createdAt: Date.now(),
      },
    };
    setGenerationScreenProgress({
      completed: 0,
      total: planResult.data.screens.length,
      retrying: false,
    });
    const nativeWarnings: string[] = [];
    let activeSectionKey: string | undefined;
    let legacyScreenIds = new Set<string>();
    let firstSectionRecorded = false;
    let firstNativeNodeRecorded = false;
    let repairAttempts = 0;

    const sectionKey = (screenId: string, sectionId: string) => `${screenId}:${sectionId}`;
    const markSection = (screenId: string, sectionId: string, stage: SectionStage) => {
      setSectionStages((current) => ({ ...current, [sectionKey(screenId, sectionId)]: stage }));
      setLastProgressAt(Date.now());
    };
    const composeScreens = (): GeneratedDesign["screens"] => {
      const groups = new Map<string, GenerationDraft["transactions"]>();
      for (const transaction of draft.transactions) {
        const id = transaction.transaction.screen_id;
        const group = groups.get(id) ?? [];
        group.push(transaction);
        groups.set(id, group);
      }
      return planResult.data.screens.flatMap((screen) => {
        const group = [...(groups.get(screen.id) ?? [])].sort(
          (a, b) => a.transaction.sequence - b.transaction.sequence,
        );
        if (group?.length)
          return [
            {
              id: screen.id,
              children: group.flatMap((item) => item.design.screens[0]!.children),
            },
          ];
        const legacy = draft.screens.find(({ id }) => id === screen.id);
        return legacy ? [legacy] : [];
      });
    };
    const updateScreenProgress = () => {
      const complete = planResult.data.screens.filter(
        (screen) =>
          legacyScreenIds.has(screen.id) ||
          draft.transactions.some(
            (item) => item.transaction.screen_id === screen.id && item.transaction.screen_completed,
          ),
      ).length;
      setGenerationScreenProgress({
        completed: complete,
        total: planResult.data.screens.length,
        retrying: false,
      });
    };
    const waitForResume = async (screenId: string, sectionId: string) => {
      while (generationPauseRequested.current) {
        setGenerationPaused(true);
        setGenerationState("paused");
        markSection(screenId, sectionId, "paused");
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => controller.signal.removeEventListener("abort", abort);
          const abort = () => {
            generationResume.current = null;
            cleanup();
            reject(new CompanionClientError("request_cancelled"));
          };
          generationResume.current = () => {
            generationResume.current = null;
            cleanup();
            resolve();
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
      setGenerationPaused(false);
      if (generationRequest.current === requestId) setGenerationState("generating");
    };
    const onNativeSectionVisible =
      (screenId: string, sectionId: string) => (_nodeId: string, pluginElapsedMs: number) => {
        const totalMs = Math.round(performance.now() - totalStartedAt);
        setStageMetrics((metrics) => ({
          ...metrics,
          [`${screenId}.${sectionId}.pluginRenderMs`]: pluginElapsedMs,
          ...(!firstNativeNodeRecorded ? { firstNativeNodeMs: totalMs } : {}),
        }));
        firstNativeNodeRecorded = true;
        setLastProgressAt(Date.now());
      };
    const renderSection = async (saved: SavedDraft["transactions"][number]) => {
      const transaction = saved.transaction;
      const key = sectionKey(transaction.screen_id, transaction.section_id);
      markSection(transaction.screen_id, transaction.section_id, "applying");
      setGenerationState("rendering");
      const started = performance.now();
      const rendered = await generationBridge(
        {
          type: "generation-apply-section",
          requestId: nextRequestId(),
          manifest: draft.manifest,
          transaction,
          design: saved.design,
        },
        onNativeSectionVisible(transaction.screen_id, transaction.section_id),
      );
      if (!rendered.nodeId) throw new Error("Figma did not acknowledge the section root.");
      nativeWarnings.push(...(rendered.warnings ?? []));
      setStageMetrics((metrics) => ({
        ...metrics,
        [`${key}.renderMs`]: Math.round(performance.now() - started),
      }));
      // Render may already have committed when cancellation arrives; reconcile its durable marker before stopping.
      await draftRequest(companionToken!, documentId!, "mark-section-applied", {
        generationId: draft.manifest.generationId,
        transaction,
        nodeId: rendered.nodeId,
      });
      draft.transactions = draft.transactions.map((item) =>
        item.transaction.idempotency_key === transaction.idempotency_key
          ? { ...item, rendered: true, nodeId: rendered.nodeId }
          : item,
      );
      markSection(transaction.screen_id, transaction.section_id, "completed");
      if (followGenerationRef.current)
        await generationBridge({
          type: "generation-select",
          requestId: nextRequestId(),
          generationId: draft.manifest.generationId,
          screenId: transaction.screen_id,
          sectionId: transaction.section_id,
        });
      if (controller.signal.aborted) throw new CompanionClientError("request_cancelled");
    };

    try {
      const activeContext = await generationBridge({
        type: "generation-context",
        requestId: nextRequestId(),
      });
      if (activeContext.documentId !== documentId)
        throw new Error(
          "Figma page changed; reopen the plugin in the intended page before resuming.",
        );
      const recovered = await loadSavedDraft(companionToken, documentId);
      if (recovered) {
        if (
          JSON.stringify({
            model: recovered.manifest.model,
            request: recovered.manifest.request,
          }) !== draftKey
        )
          throw new Error(
            "A different saved draft exists for this document/page. Resume it or explicitly clear its checkpoint before starting another project.",
          );
        draft = {
          manifest: recovered.manifest,
          screens: recovered.screens.flatMap(({ design }) => design.screens),
          transactions: recovered.transactions,
          projectName: recovered.screens[0]?.design.projectName,
          palette: recovered.screens[0]?.design.palette,
        };
      } else {
        await draftRequest(
          companionToken,
          documentId,
          "start",
          { manifest: draft.manifest },
          controller.signal,
        );
      }
      await generationBridge({
        type: "generation-remember",
        requestId: nextRequestId(),
        generationId: draft.manifest.generationId,
      });
      setActiveGenerationId(draft.manifest.generationId);

      const transactionScreenIds = new Set(
        draft.transactions.map(({ transaction }) => transaction.screen_id),
      );
      legacyScreenIds = new Set(
        draft.screens.map(({ id }) => id).filter((id) => !transactionScreenIds.has(id)),
      );
      for (const screen of draft.screens) {
        if (!legacyScreenIds.has(screen.id)) continue;
        const savedDesign = {
          projectName: draft.projectName!,
          palette: draft.palette!,
          screens: [screen],
        };
        const started = performance.now();
        const rendered = await generationBridge({
          type: "generation-render",
          requestId: nextRequestId(),
          manifest: draft.manifest,
          design: savedDesign,
        });
        if (!rendered.nodeId) throw new Error("Figma did not acknowledge the saved screen.");
        await draftRequest(
          companionToken,
          documentId,
          "save-screen",
          {
            generationId: draft.manifest.generationId,
            design: savedDesign,
            nodeId: rendered.nodeId,
          },
          controller.signal,
        );
        setStageMetrics((metrics) => ({
          ...metrics,
          [`${screen.id}.legacyRenderMs`]: Math.round(performance.now() - started),
        }));
        setScreenStages((stages) => ({
          ...stages,
          [screen.id]: "rendered from saved screen checkpoint",
        }));
      }
      updateScreenProgress();

      const skeletonScreenIds = planResult.data.screens
        .filter((screen) => !legacyScreenIds.has(screen.id))
        .map(({ id }) => id);
      if (skeletonScreenIds.length) {
        setGenerationState("generating");
        await generationBridge({
          type: "generation-prepare",
          requestId: nextRequestId(),
          manifest: draft.manifest,
          screenIds: skeletonScreenIds,
          focusInitial: !recovered,
        });
      }

      for (const screen of planResult.data.screens) {
        if (legacyScreenIds.has(screen.id)) continue;
        const screenPlan = { ...planResult.data, screens: [screen] };
        const sections = createDesignSections(planResult.data);
        setScreenStages((stages) => ({ ...stages, [screen.id]: "generating sections" }));
        for (const section of sections) {
          activeSectionKey = sectionKey(screen.id, section.id);
          setCurrentSection({ screenId: screen.id, sectionId: section.id });
          const persisted = draft.transactions.find(
            (item) =>
              item.transaction.idempotency_key ===
              `fad:v1:${draft.manifest.generationId}:${screen.id}:${section.id}`,
          );
          await waitForResume(screen.id, section.id);
          if (persisted) {
            await renderSection(persisted);
            continue;
          }
          if (controller.signal.aborted) throw new CompanionClientError("request_cancelled");

          const screenRequestId = nextRequestId();
          let repairIssues: string[] = [];
          let completed:
            | {
                design: GeneratedDesign;
                transaction: ReturnType<typeof createGenerationTransaction>;
              }
            | undefined;
          for (let attempt = 0; attempt <= 1; attempt++) {
            markSection(screen.id, section.id, attempt ? "needs-repair" : "generating");
            setGenerationState(attempt ? "repairing" : "generating");
            const inferenceStarted = performance.now();
            const raw = await generateAuthorizedDesign(
              companionToken,
              screenRequestId,
              selectedCompanionModel,
              planResult.data.request,
              repairIssues,
              fetch,
              controller.signal,
              [screen.id],
              () => setGenerationScreenProgress((progress) => ({ ...progress, retrying: true })),
              [],
              (metrics) =>
                setStageMetrics((current) => ({
                  ...current,
                  ...Object.fromEntries(
                    Object.entries(metrics).map(([key, value]) => [
                      `${screen.id}.${section.id}.${key}`,
                      value,
                    ]),
                  ),
                })),
              (diagnostic) => {
                setGenerationState("generating");
                markSection(screen.id, section.id, "generating");
                setStageMetrics((metrics) => ({
                  ...metrics,
                  [`${screen.id}.${section.id}.activeElapsedMs`]: diagnostic.elapsedMs ?? 0,
                  [`${screen.id}.${section.id}.idleMs`]: diagnostic.idleMs ?? 0,
                  [`${screen.id}.${section.id}.events`]: diagnostic.eventCount ?? 0,
                  [`${screen.id}.${section.id}.generatedBytes`]: diagnostic.generatedBytes ?? 0,
                }));
              },
              { id: section.id, sequence: section.sequence },
            );
            setStageMetrics((metrics) => ({
              ...metrics,
              [`${screen.id}.${section.id}.${attempt ? "repair" : "inference"}Ms`]: Math.round(
                performance.now() - inferenceStarted,
              ),
            }));
            setGenerationScreenProgress((progress) => ({ ...progress, retrying: false }));
            if (controller.signal.aborted) throw new CompanionClientError("request_cancelled");
            if (generationRequest.current !== requestId) return;
            setGenerationState("validating");
            markSection(screen.id, section.id, "validating");
            await new Promise((resolve) => window.setTimeout(resolve, 0));
            if (controller.signal.aborted) throw new CompanionClientError("request_cancelled");
            if (generationRequest.current !== requestId) return;

            const validationStarted = performance.now();
            const validated = normalizeGeneratedDesignResponse(raw, screenPlan);
            const issues = validated.success ? [] : validated.errors;
            if (validated.success) {
              const generated = {
                ...validated.data.design,
                projectName: draft.projectName ?? validated.data.design.projectName,
                palette: draft.palette ?? validated.data.design.palette,
              };
              const sectionRoot = generated.screens[0]?.children[0];
              if (
                generated.screens[0]?.children.length !== 1 ||
                sectionRoot?.type !== "frame" ||
                sectionRoot.width > screen.width - 40 ||
                sectionRoot.height > (screen.devicePreset === "mobile" ? 210 : 240) ||
                sectionRoot.layout === "none"
              ) {
                issues.push(
                  "The section must contain one bounded Auto Layout frame with all content inside it.",
                );
              } else {
                try {
                  const transaction = createGenerationTransaction({
                    generationId: draft.manifest.generationId,
                    documentScope: documentId,
                    screenId: screen.id,
                    sectionId: section.id,
                    transactionId: screenRequestId,
                    design: generated,
                  });
                  validateDraftSection(draft.manifest, transaction, generated);
                  completed = { design: generated, transaction };
                  if (!firstSectionRecorded) {
                    setStageMetrics((metrics) => ({
                      ...metrics,
                      firstCompleteSectionMs: Math.round(performance.now() - totalStartedAt),
                    }));
                    firstSectionRecorded = true;
                  }
                } catch {
                  issues.push(
                    "The section failed its bounded transaction, size, nesting, or node-count contract.",
                  );
                }
              }
            }
            setStageMetrics((metrics) => ({
              ...metrics,
              [`${screen.id}.${section.id}.validationMs`]: Math.round(
                performance.now() - validationStarted,
              ),
            }));
            if (!completed) {
              if (attempt === 0) {
                repairIssues = issues.slice(0, 8);
                // A section retry requests the complete bounded section, not an untyped subtree patch.
                repairAttempts++;
                setGenerationErrors(repairIssues);
                markSection(screen.id, section.id, "needs-repair");
                continue;
              }
              throw new Error(
                `Section ${section.title} failed validation after one bounded repair: ${issues.join(" ")}`,
              );
            }
            break;
          }
          if (!completed)
            throw new Error(
              `Section ${section.title} did not produce a complete validated transaction.`,
            );
          setGenerationErrors([]);
          if (controller.signal.aborted) throw new CompanionClientError("request_cancelled");

          draft.projectName ??= completed.design.projectName;
          draft.palette ??= completed.design.palette;
          markSection(screen.id, section.id, "saving");
          const saveStarted = performance.now();
          await draftRequest(
            companionToken,
            documentId,
            "save-section",
            {
              generationId: draft.manifest.generationId,
              transaction: completed.transaction,
              design: completed.design,
            },
            controller.signal,
          );
          draft.transactions = [
            ...draft.transactions,
            {
              transaction: completed.transaction,
              design: completed.design,
              rendered: false,
            },
          ];
          draft.screens = composeScreens();
          setStageMetrics((metrics) => ({
            ...metrics,
            [`${screen.id}.${section.id}.persistenceMs`]: Math.round(
              performance.now() - saveStarted,
            ),
          }));
          markSection(screen.id, section.id, "saved");
          if (controller.signal.aborted) throw new CompanionClientError("request_cancelled");
          await renderSection(draft.transactions[draft.transactions.length - 1]!);
          updateScreenProgress();
        }
        setScreenStages((stages) => ({ ...stages, [screen.id]: "completed" }));
      }

      const completeScreens = composeScreens();
      if (
        completeScreens.length !== planResult.data.screens.length ||
        !draft.projectName ||
        !draft.palette
      )
        throw new Error(
          "Some requested sections are still missing; run Generate Design again to resume only unfinished work.",
        );
      const raw = JSON.stringify({
        projectName: draft.projectName,
        palette: draft.palette,
        screens: completeScreens,
      } satisfies GeneratedDesign);
      const prepared = prepareGeneratedDesign(raw, planResult.data);
      if (!prepared.success)
        throw new Error(
          `Saved sections did not compose into a valid complete design. ${prepared.errors.join(" ")}`,
        );
      const audit = auditVisualQuality(prepared.data.batch);
      const warnings = [
        ...nativeWarnings,
        "Sections are independent completed Responses requests; actual provider latency depends on account/model availability.",
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
      setDraftNotice(
        `${draft.transactions.length} section transactions are durably saved and reconciled. Reopen resumes from the first unfinished section.`,
      );
      setSavedDraft(await loadSavedDraft(companionToken, documentId));
    } catch (error) {
      if (generationRequest.current !== requestId) return;
      const resumeMessage = draft.transactions.length
        ? ` ${draft.transactions.length} section transactions are checkpointed; Generate Design resumes without repeating them.`
        : "";
      if (
        controller.signal.aborted ||
        (error instanceof CompanionClientError && error.category === "request_cancelled")
      ) {
        setGenerationState("cancelled");
        setGenerationErrors([
          `Generation cancelled. Completed section transactions are retained.${resumeMessage}`,
        ]);
        if (activeSectionKey) {
          const failedKey = activeSectionKey;
          const saved = draft.transactions.some(
            (item) => `${item.transaction.screen_id}:${item.transaction.section_id}` === failedKey,
          );
          setSectionStages((stages) => ({
            ...stages,
            [failedKey]: saved ? "saved" : "paused",
          }));
        }
      } else {
        setGenerationState("failed");
        if (activeSectionKey) {
          const failedKey = activeSectionKey;
          setSectionStages((stages) => ({ ...stages, [failedKey]: "failed" }));
        }
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
            /* Keep the sanitized failure. */
          }
        }
      }
    } finally {
      if (generationRequest.current === requestId)
        setStageMetrics((metrics) => ({
          ...metrics,
          totalMs: Math.round(performance.now() - totalStartedAt),
        }));
      if (generationRequest.current === requestId) generationRequest.current = null;
      if (generationAbort.current === controller) generationAbort.current = null;
      generationPauseRequested.current = false;
      generationResume.current = null;
      setPauseRequested(false);
      setGenerationPaused(false);
    }
  };

  const pauseDesignGeneration = () => {
    generationPauseRequested.current = true;
    setPauseRequested(true);
  };

  const resumeDesignGeneration = () => {
    generationPauseRequested.current = false;
    setPauseRequested(false);
    setGenerationPaused(false);
    generationResume.current?.();
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
  const developerToolsBusy = toolBusy || chatBusy;
  const chatCanSubmit = chatReady && chatTaskLoaded && !toolBusy && !chatPendingTool;

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
        {chatBusy && (
          <button className="text-button muted" type="button" onClick={stopChat}>
            Stop chat
          </button>
        )}
        {toolBusy && !chatBusy && (
          <button className="text-button muted" type="button" onClick={cancelToolBatch}>
            Cancel operation
          </button>
        )}
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
              ["chat", "AI Chat"],
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
      ) : activeView === "chat" ? (
        <section className="chat-home" aria-labelledby="chat-title">
          <div className="page-heading">
            <div>
              <span className="page-eyebrow">AUTHENTICATED · NATIVE FIGMA TOOLS</span>
              <h1 id="chat-title">AI Chat</h1>
              <p className="page-description">
                Describe a change in Persian or English. Canvas operations are validated locally
                before they run.
              </p>
            </div>
            <button
              className="text-button muted"
              type="button"
              disabled={chatBusy || toolBusy || !chatMessages.length}
              onClick={clearChat}
            >
              New chat
            </button>
          </div>
          <div
            className="chat-transcript"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {!chatMessages.length ? (
              <div className="chat-welcome">
                <span className="section-kicker">YOUR DESIGN ASSISTANT</span>
                <h2>What would you like to make?</h2>
                <p>
                  Try “Create a mobile storefront frame” or “Make the title on my selected frame
                  right-aligned.”
                </p>
              </div>
            ) : (
              chatMessages.map((message) => (
                <article className={`chat-message is-${message.role}`} key={message.id}>
                  <span className="chat-message-role">
                    {message.role === "user" ? "You" : "Assistant"}
                  </span>
                  {message.content && <p dir="auto">{message.content}</p>}
                  {message.error && (
                    <div className="chat-message-error" role="alert">
                      <p>{safeChatProse(message.error)}</p>
                      {chatRetryMessageId === message.id && (
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={chatBusy || toolBusy}
                          onClick={() => void sendChatMessage(true)}
                        >
                          {chatTaskSnapshot?.status === "failed" ? "Retry Failed Stage" : "Resume"}
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
          {chatTaskSnapshot && (
            <section className="chat-task-progress" aria-label="Canvas task progress">
              <p role="status">{chatTaskProgress(chatTaskSnapshot)}</p>
              <ol>
                {chatTaskSnapshot.stages.map((stage, index) => (
                  <li key={`${index}-${stage.title}`}>
                    {stage.completed ? "✓" : "○"} {stage.title}
                  </li>
                ))}
              </ol>
              <small>
                Task {chatTaskSnapshot.id} · {chatTaskSnapshot.rounds} model rounds ·{" "}
                {chatTaskSnapshot.batches} batches · {chatTaskSnapshot.lastResponseCalls} calls in
                last response · {chatTaskSnapshot.ledger.length} scheduled operations
              </small>
              {chatBusy && (
                <button type="button" className="secondary-action" onClick={stopChat}>
                  Stop
                </button>
              )}
            </section>
          )}
          {chatActivity && (
            <div className="chat-activity" role="status" aria-live="polite">
              <span
                className={chatBusy ? "chat-activity-dot is-active" : "chat-activity-dot"}
                aria-hidden="true"
              />
              <span>{safeChatProse(chatActivity)}</span>
            </div>
          )}
          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendChatMessage();
            }}
          >
            <label htmlFor="chat-input">Message</label>
            <textarea
              id="chat-input"
              value={chatInput}
              maxLength={8_000}
              rows={3}
              dir={/[\u0600-\u06ff]/u.test(chatInput) ? "rtl" : "auto"}
              placeholder="Describe a design or change… / تغییر موردنظرت را توضیح بده…"
              disabled={chatBusy}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendChatMessage();
                }
              }}
              aria-describedby="chat-help"
            />
            <div className="chat-composer-footer">
              <span id="chat-help">
                Enter to send · Shift+Enter for a new line
                {!chatReady &&
                  ` · ${inferenceEligibility.eligible ? "Select an authenticated model in Settings." : inferenceEligibility.message}`}
                {toolBusy && " · Wait for the active native operation to finish."}
              </span>
              <button
                type="submit"
                className="primary-action"
                disabled={!chatInput.trim() || !chatCanSubmit || chatBusy}
              >
                Send
              </button>
            </div>
          </form>
          <details className="tool-harness">
            <summary className="tool-harness-summary">
              <span>
                <span className="section-kicker">DEVELOPER ONLY</span>
                <strong id="tool-harness-title">Native operation harness</strong>
              </span>
              <span className={`system-status ${toolBusy ? "" : "is-ready"}`}>
                {toolBusy ? "Running" : "Ready"}
              </span>
            </summary>
            <p className="tool-harness-copy">
              Direct local executor checks. These buttons bypass the model and do not require JSON.
            </p>
            <div className="tool-harness-grid">
              <button
                type="button"
                disabled={developerToolsBusy}
                onClick={() => runFixtureStep(0, 1)}
              >
                1 · Create 390 × 844 frame
              </button>
              <button
                type="button"
                disabled={developerToolsBusy}
                onClick={() => runFixtureStep(1, 2)}
              >
                2 · Add Persian title
              </button>
              <button
                type="button"
                disabled={developerToolsBusy}
                onClick={() => runFixtureStep(2, 4)}
              >
                3 · Add editable input
              </button>
              <button
                type="button"
                disabled={developerToolsBusy}
                onClick={() => runFixtureStep(4, 6)}
              >
                4 · Add button
              </button>
              <button
                type="button"
                disabled={developerToolsBusy}
                onClick={() => runFixtureStep(6, 7)}
              >
                5 · Change button color only
              </button>
              <button
                type="button"
                disabled={developerToolsBusy}
                onClick={() =>
                  runToolOperations([
                    developerToolOperation("phase56-invalid-layout", {
                      tool: "set_auto_layout",
                      ref: PHASE56_TITLE_REF,
                      layout: { direction: "vertical" },
                    }),
                  ])
                }
              >
                Safe invalid-layout check
              </button>
            </div>
            <div className="tool-harness-actions">
              <button
                className="secondary-action"
                type="button"
                disabled={developerToolsBusy || !lastToolOperation}
                onClick={replayLastToolOperation}
              >
                Replay last operation
              </button>
              <button
                className="text-button muted"
                type="button"
                disabled={!toolBusy}
                onClick={cancelToolBatch}
              >
                Cancel between operations
              </button>
              <button
                className="text-button muted"
                type="button"
                disabled={developerToolsBusy}
                onClick={() =>
                  runToolOperations([
                    developerToolOperation(`phase56-context-${Date.now()}`, {
                      tool: "get_document_context",
                    }),
                  ])
                }
              >
                Inspect page context
              </button>
            </div>
            <p className="tool-harness-status" role="status" aria-live="polite">
              {toolStatus}
            </p>
          </details>
          <p className="tool-safety-note">
            Existing layers are never replaced by this fixture. Delete and broad-replacement tools
            require separate, scoped user consent and are not exposed here.
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
                  max={200}
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
              "Each validated screen is saved locally, rendered as editable Figma layers, then selected and zoomed. JSON review remains optional."}
          </p>
          <section className="generation-result" aria-label="Durable generation draft">
            <p>{draftNotice || "Checking document-scoped recovery…"}</p>
            {savedDraft && (
              <button
                type="button"
                disabled={generationInFlight}
                onClick={() => {
                  const request = savedDraft.manifest.request;
                  setPrompt(request.prompt);
                  setGenerationTarget(request.target);
                  setGenerationScreenCount(request.screenCount);
                  setGenerationScreenNames(request.screenNames?.join(", ") ?? "");
                  setGenerationLanguage(request.language);
                  setGenerationStyle(request.style);
                  setGenerationProjectType(request.projectType);
                  setGenerationTheme(request.theme);
                  setSelectedCompanionModel(savedDraft.manifest.model);
                  setDraftNotice(
                    `Restored ${savedDraft.screens.length} saved screens. Verify the exact selected model if needed, then press Generate to resume.`,
                  );
                }}
              >
                Restore saved project ({savedDraft.screens.length} saved)
              </button>
            )}
            <button
              type="button"
              disabled={generationInFlight || !companionToken || !documentId}
              onClick={() => {
                if (
                  !window.confirm(
                    "Delete this document/page's local draft? Existing Figma frames will not be deleted.",
                  )
                )
                  return;
                void draftRequest(companionToken!, documentId!, "clear")
                  .then(() => {
                    setSavedDraft(null);
                    setScreenStages({});
                    setDraftNotice("Local draft deleted; existing Figma frames preserved.");
                    return generationBridge({
                      type: "generation-remember",
                      requestId: nextRequestId(),
                      generationId: null,
                    });
                  })
                  .catch((error) => setDraftNotice(error.message));
              }}
            >
              Delete local draft
            </button>
            <button
              type="button"
              disabled={generationInFlight || !companionToken || !documentId}
              onClick={() => {
                void loadSavedDraft(companionToken!, documentId!)
                  .then((draft) => {
                    if (!draft) throw new Error("No saved draft to export.");
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(draft)], { type: "application/json" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = "figma-generation-recovery.json";
                    link.click();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                  .catch((error) => setDraftNotice(error.message));
              }}
            >
              Export recovery JSON
            </button>
            <label>
              Import recovery JSON (contains your brief and copy)
              <input
                type="file"
                accept=".json,application/json"
                disabled={generationInFlight || !companionToken || !documentId}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 64 * 1024 * 1024) {
                    setDraftNotice("Recovery file exceeds 64 MiB.");
                    return;
                  }
                  const controller = new AbortController();
                  generationAbort.current = controller;
                  setGenerationState("saving");
                  setGenerationStarted(Date.now());
                  setElapsedSeconds(0);
                  void file
                    .text()
                    .then((text) =>
                      importSavedDraft(
                        companionToken!,
                        documentId!,
                        JSON.parse(text),
                        controller.signal,
                      ),
                    )
                    .then(() => loadSavedDraft(companionToken!, documentId!))
                    .then((draft) => {
                      setSavedDraft(draft);
                      setDraftNotice(
                        "Recovery imported; restore and resume to reconcile canvas frames.",
                      );
                      setGenerationState("idle");
                    })
                    .catch((error) => {
                      setDraftNotice(
                        error instanceof Error
                          ? error.message
                          : "Recovery import failed; committed screens remain saved.",
                      );
                      setGenerationState(controller.signal.aborted ? "cancelled" : "failed");
                    })
                    .finally(() => {
                      if (generationAbort.current === controller) generationAbort.current = null;
                    });
                }}
              />
            </label>
          </section>

          {generationInFlight && (
            <div className="generation-progress" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>
                {elapsedSeconds}s elapsed · {generationState} · {generationScreenProgress.completed}{" "}
                saved ·{" "}
                {
                  Object.values(screenStages).filter(
                    (stage) => stage === "completed" || stage.startsWith("rendered"),
                  ).length
                }{" "}
                rendered ·{" "}
                {Object.values(sectionStages).filter((stage) => stage === "completed").length}{" "}
                sections completed · last progress {secondsSinceProgress}s ago ·{" "}
                {generationScreenProgress.retrying
                  ? `Retrying screen ${generationScreenProgress.completed + 1} of ${generationScreenProgress.total}; incomplete output was discarded.`
                  : generationScreenProgress.total
                    ? `${generationProgressText(generationState)} Screen ${generationScreenProgress.completed + (generationState === "generating" ? 1 : 0)} of ${generationScreenProgress.total}.`
                    : generationProgressText(generationState)}
              </span>
              {generationPaused ? (
                <button className="text-button" type="button" onClick={resumeDesignGeneration}>
                  Resume
                </button>
              ) : (
                <button
                  className="text-button"
                  type="button"
                  disabled={pauseRequested}
                  onClick={pauseDesignGeneration}
                >
                  {pauseRequested ? "Pausing after this section…" : "Pause after section"}
                </button>
              )}
              <button className="text-button" type="button" onClick={cancelDesignGeneration}>
                Cancel
              </button>
              <label className="inline-toggle">
                <input
                  type="checkbox"
                  checked={followGeneration}
                  onChange={(event) => {
                    followGenerationRef.current = event.currentTarget.checked;
                    setFollowGeneration(event.currentTarget.checked);
                  }}
                />
                Follow generation
              </label>
              {currentSection && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() =>
                    void generationBridge({
                      type: "generation-select",
                      requestId: nextRequestId(),
                      generationId:
                        activeGenerationId ??
                        savedDraft?.manifest.generationId ??
                        "generation-pending",
                      screenId: currentSection.screenId,
                      sectionId: currentSection.sectionId,
                    }).catch(() =>
                      setDraftNotice(
                        "Could not focus the current section; the canvas is unchanged.",
                      ),
                    )
                  }
                >
                  Jump to current section
                </button>
              )}
            </div>
          )}

          {generationState === "failed" || generationState === "cancelled" ? (
            <section className="generation-result generation-failure" role="alert">
              <strong>
                {generationState === "cancelled"
                  ? "Generation cancelled"
                  : "Generation stopped — section checkpoints are resumable"}
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
                      {` · ${screenStages[screen.id] ?? "queued"}`}
                    </span>
                    <ul
                      className="planned-section-list"
                      aria-label={`${screen.name} section timeline`}
                    >
                      {createDesignSections(generationPlan.data).map((section) => {
                        const status =
                          sectionStages[`${screen.id}:${section.id}`] ??
                          (savedDraft?.transactions.some(
                            (item) =>
                              item.transaction.screen_id === screen.id &&
                              item.transaction.section_id === section.id &&
                              item.rendered,
                          )
                            ? "completed"
                            : "queued");
                        return (
                          <li key={section.id}>
                            <span>{section.title}</span>
                            <span>{status}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {generationState === "ready" && generationPreview && (
            <section className="generation-result" aria-labelledby="generation-result-title">
              <div className="section-title-row">
                <h2 id="generation-result-title">Design saved and rendered</h2>
                <span className="section-caption">EDITABLE FIGMA LAYERS</span>
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
                Inspect or export generated JSON
              </button>
            </section>
          )}
          {Object.keys(stageMetrics).length > 0 && (
            <details>
              <summary>Sanitized stage timings and counts (Ms, Bytes, events)</summary>
              <ul>
                {Object.entries(stageMetrics).map(([stage, value]) => (
                  <li key={stage}>
                    {stage}: {value}
                  </li>
                ))}
              </ul>
            </details>
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
      "The selected model or account did not complete the function-calling smoke test. Check the sanitized diagnostic below or choose another supported account-visible model.",
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
    response_too_large:
      "The response exceeded a bounded safety limit (8 MiB generated screen / 32 MiB SSE stream). Simplify that screen or split the project; earlier saved screens remain recoverable.",
    empty_response:
      "The model completed without a text reply or canvas action. Retry or rephrase the request.",
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
    ...(diagnostic.responseStatus ? [`response_status=${diagnostic.responseStatus}`] : []),
    ...(diagnostic.outputItemTypes?.length
      ? [`output_types=${diagnostic.outputItemTypes.join(",")}`]
      : []),
    ...(diagnostic.outputItemCount !== undefined
      ? [`output_items=${diagnostic.outputItemCount}`]
      : []),
    ...(diagnostic.functionCallCount !== undefined
      ? [`function_calls=${diagnostic.functionCallCount}`]
      : []),
    ...(diagnostic.chatState ? [`chat_state=${diagnostic.chatState}`] : []),
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
      generating: "Generating the current section with the selected account model…",
      validating: "Validating the completed section transaction…",
      preparing: "Preparing the screen plan and working frames…",
      saving: "Persisting the validated section before native apply…",
      rendering: "Applying the section as editable native Figma layers…",
      repairing: "One bounded repair of the failed section only…",
      paused: "Paused at a section boundary; committed work is preserved.",
      ready: "Ready for review",
      failed: "Generation failed",
      cancelled: "Generation cancelled",
    } satisfies Record<GenerationState, string>
  )[state];
}
