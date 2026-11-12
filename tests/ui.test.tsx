import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import phase1Sample from "../src/samples/sample-design.json?raw";
import { parseDesignText } from "../src/shared/schema";
import App, {
  getConnectionSummary,
  getModelAvailabilityMessage,
  navigationReducer,
  type ModelDiscoveryState,
  type PluginView,
} from "../src/ui/App";
import type { CompanionStatus } from "../src/ui/companion-client";
import { NavigationDrawer } from "../src/ui/workspace-navigation";

function render(view: PluginView = "design"): string {
  return renderToStaticMarkup(<App initialView={view} />);
}

function status(auth: CompanionStatus["auth"]): CompanionStatus {
  return {
    companion: "connected",
    auth,
    authLabel: auth,
    planUseAuthorized: auth === "scope_granted" || auth === "ready",
    modelCount: 0,
  };
}

describe("plugin UI navigation and capability states", () => {
  it("moves page navigation into the drawer and removes the top tabs", () => {
    const html = render();

    expect(html).toContain('aria-label="Open page drawer"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('<nav class="primary-nav" aria-label="Main navigation">');
  });

  it("provides active Home, Chat, History, More, and Settings drawer routes", () => {
    const html = renderToStaticMarkup(
      <NavigationDrawer
        activeView="more"
        settingsOpen={false}
        drawerRef={createRef<HTMLElement>()}
        closeButtonRef={createRef<HTMLButtonElement>()}
        onClose={() => undefined}
        onNavigate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(html).toContain('aria-current="page"');
    for (const label of ["Home", "Chat", "History", "More", "Settings"])
      expect(html).toContain(`>${label}</span>`);
  });

  it("renders the navy Home dashboard and all advanced destinations in More", () => {
    const home = render("home");
    expect(home).toContain("Design with clarity.");
    expect(home).toContain("Start New Chat");
    expect(home).toContain("Quick access");
    expect(home).toContain("Chat History");
    expect(home).toContain("Planned for a later phase");

    const more = render("more");
    for (const label of [
      "Design System",
      "Asset Library",
      "Activity & Diagnostics",
      "Help & Guide",
      "About",
      "JSON Advanced",
      "Generation Options",
      "Generation Progress",
      "Open Settings",
      "Coming later",
    ])
      expect(more).toContain(label.replaceAll("&", "&amp;"));
    expect(more).toContain("CONNECTION &amp; MODEL");
    expect(more).not.toContain("Export &amp; Import");
    expect(more).not.toContain("Settings &amp; Model Health");
  });

  it("shows honest Phase A capability states for Brand Kit and Skills routes", () => {
    expect(render("brand-kit")).toContain(
      "Brand Kit creation, editing, and generation integration are not available",
    );
    expect(render("brand-kit-create")).toContain("No kit has been created");
    expect(render("skills")).toContain("No skill text is loaded or executed");
    expect(render("skill-add")).toContain("No file is read or executed here");
  });

  it("exposes saved history loading and the task detail routes", () => {
    const history = render("history");
    expect(history).toContain("Loading saved chats");
    expect(history).not.toContain("A native operation is active");
    expect(render("results")).toContain("canvas remains the actual design preview");
    expect(render("layers")).toContain("read-only native hierarchy");
    expect(render("activity")).toContain("stage lifecycle, native execution, verification");
    expect(render("progress")).toContain("No task data for this chat");
  });

  it("provides the bilingual AI Chat composer with More and model accordions", () => {
    const html = render("chat");
    expect(html).toContain("AI Chat");
    expect(html).toContain('id="chat-input"');
    expect(html).toContain("Shift+Enter for a new line");
    expect(html).toContain(">Send</button>");
    expect(html).toContain('role="log"');
    expect(html).toContain('<details class="chat-more-menu">');
    expect(html).toContain('<details class="chat-model-menu" id="chat-model-menu">');
    expect(html).not.toContain("function_call");
    expect(html).not.toContain("tool-execute");
    expect(html).not.toContain("Native operation harness");
    expect(html).not.toContain("BRAND KIT");
    expect(html).not.toContain("SKILLS");
    expect(html).not.toContain("Existing layers are never replaced");
    expect(html).not.toContain("Offline JSON");
    expect(html).not.toContain('id="json-input"');
  });

  it("locks Chat markup and keeps the execution controller above page rendering", () => {
    const html = render("chat");
    expect(html).toMatchSnapshot("approved Chat page markup");

    const appSource = readFileSync("src/ui/App.tsx", "utf8");
    const controllerRef = appSource.indexOf("const chatTask = useRef<ChatTask | null>(null);");
    const appPageRender = appSource.indexOf("return (\n    <main className={`app-shell");
    expect(controllerRef).toBeGreaterThan(-1);
    expect(appPageRender).toBeGreaterThan(controllerRef);
    expect(appSource).toContain('if (event.key === "Escape")');
    expect(appSource).toContain("event.shiftKey && document.activeElement === first");
    expect(appSource).toContain("drawerTrigger?.focus()");
    expect(appSource).toContain('if (activeView === "chat" && !settingsOpen) return;');
    expect(appSource).toContain("document.getElementById(headingId)?.focus()");
    const chatStart = appSource.indexOf('activeView === "chat" ? (');
    const chatEnd = appSource.indexOf(') : activeView === "design" ? (', chatStart);
    expect(chatStart).toBeGreaterThan(-1);
    expect(chatEnd).toBeGreaterThan(chatStart);
    expect(createHash("sha256").update(appSource.slice(chatStart, chatEnd)).digest("hex")).toBe(
      "56d6d0c34d076ab32942bfcd8feb754f951d67593311864946298383b2e50522",
    );
    expect(appSource).toContain(
      "const executionModel = taskModelForExecution(task.model, selectedCompanionModel);",
    );
    expect(appSource).toContain("model: selectedCompanionModel,");
    expect(appSource).toContain("executionModel,");

    const css = readFileSync("src/ui/styles.css", "utf8");
    const nonChatMarker = "/* Phase 7 non-Chat refinements.";
    const frozenCss = css.slice(0, css.indexOf(nonChatMarker)).trimEnd();
    expect(createHash("sha256").update(frozenCss).digest("hex")).toBe(
      "e268f69387f50a007b7a3ce54b258f711241c9f02c693dbcb1164e4811b2bdf6",
    );
    expect(css.slice(css.indexOf(nonChatMarker))).toContain(".model-management-status");
    expect(css.slice(css.indexOf(nonChatMarker))).toContain(".model-management-task-choice");
  });

  it("switches between areas and Settings without losing the selected area", () => {
    const design = { activeView: "design", settingsOpen: false } as const;
    const json = navigationReducer(design, { type: "navigate", view: "json" });
    expect(json).toEqual({ activeView: "json", settingsOpen: false });
    expect(navigationReducer(json, { type: "toggle-settings" })).toEqual({
      activeView: "json",
      settingsOpen: true,
    });
    expect(navigationReducer({ ...json, settingsOpen: true }, { type: "toggle-settings" })).toEqual(
      json,
    );
    expect(navigationReducer(json, { type: "open-settings" })).toEqual({
      activeView: "json",
      settingsOpen: true,
    });
  });

  it("keeps the offline JSON editor, sample controls, validation, and renderer available", () => {
    const html = render("json");

    expect(html).toContain('id="json-input"');
    expect(html).toContain("Import JSON");
    expect(html).toContain("Phase 1 sample");
    expect(html).toContain("Phase 4 demo");
    expect(html).toContain("Validate JSON");
    expect(html).toContain("Generate in Figma");
    expect(html).not.toContain("Offline JSON");
    expect(parseDesignText(phase1Sample.trim()).success).toBe(true);
    expect(html).not.toContain("Companion &amp; ChatGPT");
  });

  it("shows interactive target planning but keeps AI generation blocked without a verified account model", () => {
    const html = render();

    expect(html).toContain("Describe your app, website, or interface");
    expect(html).toContain('id="prompt-count"');
    const generateButton = html.match(/<button class="design-generate-button[^>]*>/)?.[0];
    expect(generateButton).toContain('aria-describedby="generation-help"');
    expect(generateButton).toContain('disabled=""');
    expect(html).toContain("Enter a design brief with at least 10 characters.");
    expect(html).toContain('aria-pressed="true">Mobile</button>');
    expect(html).toContain(">Mobile + Desktop</button>");
    expect(html).not.toContain(">Web</button>");
    expect(html).toContain("Connect to the local companion in Settings.");
    expect(html).toContain("Persian storefront · 10 screens");
    expect(html).toContain("English dashboard · 2 screens");
    expect(html).toContain("NO AI REQUEST");
    expect(html).toContain("Recent projects aren’t saved yet");
    expect(html).not.toContain("Screen 01");
  });

  it("shows distinct local, account, scope, and inference status labels", () => {
    expect(getConnectionSummary("offline", null)).toBe("Companion offline");
    expect(getConnectionSummary("discovering", null)).toBe("Reconnecting");
    expect(getConnectionSummary("connected", status("session_expired"))).toBe("Sign-in required");
    expect(getConnectionSummary("connected", status("signed_out"))).toBe("Sign-in required");
    expect(getConnectionSummary("connected", status("scope_granted"))).toBe("Connected");
    expect(getConnectionSummary("connected", status("ready"))).toBe("Connected");
    expect(getConnectionSummary("connected", status("blocked"))).toBe("Sign-in required");
  });

  it("renders truthful loading, empty, error, and unconfigured model states", () => {
    const cases: Array<[ModelDiscoveryState, boolean, boolean, string]> = [
      ["loading", true, true, "Loading account-visible models"],
      ["empty", true, true, "No account-visible models were returned"],
      ["error", true, true, "Model discovery failed"],
      ["idle", false, false, "Connect the optional Companion"],
      ["idle", true, false, "Grant plan-use permission"],
      ["idle", true, true, "Models have not been loaded"],
    ];

    for (const [state, hasToken, scope, expected] of cases) {
      expect(getModelAvailabilityMessage(state, hasToken, scope)).toContain(expected);
    }
  });

  it("keeps Assets, Design System, and Quality as separate reachable areas", () => {
    expect(render("assets")).toContain("Asset library");
    expect(render("system")).toContain("Design System");
    expect(render("quality")).toContain("Quality preflight");
    expect(render("quality")).not.toContain("Asset source / license");
  });

  it("defines responsive drawer navigation and removes the plugin minimum width", () => {
    const css = readFileSync("src/ui/styles.css", "utf8");

    expect(css).toContain(".navigation-drawer-links");
    expect(css).toContain(".drawer-button");
    expect(css).toContain("@media (max-width: 420px)");
    expect(css).toContain("@media (max-width: 340px)");
    expect(css).toContain("min-width: 0;");
    expect(css).toContain("--bg: #17181d");
    expect(css).toContain(".more-connection-card");
    expect(css).toContain(".history-integrity-note");
  });
});
