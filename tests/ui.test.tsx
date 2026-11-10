import { readFileSync } from "node:fs";
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

  it("renders the navy Home dashboard and all advanced destinations in More", () => {
    const home = render("home");
    expect(home).toContain("Design with clarity.");
    expect(home).toContain("Start New Chat");
    expect(home).toContain("Quick access");
    expect(home).toContain("Chat History");

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
    ])
      expect(more).toContain(label.replaceAll("&", "&amp;"));
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

  it("provides the bilingual AI Chat composer and a collapsed native developer harness", () => {
    const html = render("chat");
    expect(html).toContain("AI Chat");
    expect(html).toContain('id="chat-input"');
    expect(html).toContain("Shift+Enter for a new line");
    expect(html).toContain(">Send</button>");
    expect(html).toContain('role="log"');
    expect(html).toContain('<details class="tool-harness">');
    expect(html).not.toContain('<details class="tool-harness" open="">');
    expect(html).not.toContain("function_call");
    expect(html).not.toContain("tool-execute");
    expect(html).toContain("Native operation harness");
    expect(html).toContain("Current generation context");
    expect(html).toContain("BRAND KIT");
    expect(html).toContain("SKILLS");
    expect(html).toContain("Create 390 × 844 frame");
    expect(html).toContain("Change button color only");
    expect(html).toContain("Safe invalid-layout check");
    expect(html).not.toContain('id="json-input"');
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
    expect(html).toContain("Offline JSON");
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

  it("defines responsive four-item navigation and removes the plugin minimum width", () => {
    const css = readFileSync("src/ui/styles.css", "utf8");

    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(css).toContain("@media (max-width: 420px)");
    expect(css).toContain("@media (max-width: 340px)");
    expect(css).toContain("min-width: 0;");
    expect(css).toContain("--bg: #090e1d");
    expect(css).toContain("linear-gradient(115deg, #7655e9");
  });
});
