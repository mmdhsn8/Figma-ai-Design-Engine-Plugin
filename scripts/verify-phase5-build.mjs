import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompanionServer } from "../dist-companion/companion/server.js";
import { createDraftStore } from "../dist-companion/companion/draft-store.js";
import {
  createDesignPlan,
  normalizeGeneratedDesignResponse,
} from "../dist-companion/shared/design-generation.js";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const pluginBundle = await readFile(new URL("dist/plugin.js", root), "utf8");
const uiHtml = await readFile(new URL("dist/ui.html", root), "utf8");
const companionServer = await readFile(new URL("dist-companion/companion/server.js", root), "utf8");
const nativeQualitySource = await readFile(
  new URL("src/shared/native-visual-quality.ts", root),
  "utf8",
);
const companionDesignGeneration = await readFile(
  new URL("dist-companion/shared/design-generation.js", root),
  "utf8",
);
const uiMarker = "figma.showUI(";
const uiStart = pluginBundle.indexOf(uiMarker);
const quote = pluginBundle[uiStart + uiMarker.length];
const uiEndMarker = quote === "`" ? "</html>\n`" : `</html>\\n${quote}`;
const uiEnd = pluginBundle.indexOf(uiEndMarker, uiStart);
const pkg = await readJson("package.json");
const manifest = await readJson("manifest.json");
if (process.env.APPDATA) {
  let settings;
  try {
    settings = JSON.parse(
      await readFile(resolve(process.env.APPDATA, "Figma", "settings.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const registrations = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.lastKnownPluginId === manifest.id && typeof value.manifestPath === "string")
      registrations.push(resolve(value.manifestPath));
    Object.values(value).forEach(visit);
  };
  visit(settings);
  if (registrations.length) {
    const registeredPaths = [...new Set(registrations.map((path) => path.toLowerCase()))];
    assert.equal(
      registeredPaths.length,
      1,
      "Multiple development manifests have this plugin ID; resolve the active Figma registration before claiming runtime verification.",
    );
    assert.equal(
      registeredPaths[0],
      fileURLToPath(new URL("manifest.json", root)).toLowerCase(),
      `Figma Desktop registers a different project: ${registrations.join(", ")}. Rebuild its manifest-loaded outputs instead.`,
    );
    console.log(`Figma Desktop manifest registration verified: ${registrations[0]}`);
  }
}
assert.match(
  pkg.scripts.companion,
  /tsc -p tsconfig\.companion\.json && node dist-companion\/companion\/main\.js/u,
);
assert.equal(manifest.main, "dist/plugin.js");
assert.equal(manifest.ui, "dist/ui.html");
assert.ok(uiStart >= 0 && uiEnd > uiStart, "Could not isolate the embedded plugin UI.");
const controllerBundle =
  pluginBundle.slice(0, uiStart) + pluginBundle.slice(uiEnd + uiEndMarker.length);
assert.doesNotMatch(
  controllerBundle,
  /\b(?:TextEncoder|TextDecoder|Buffer)\b|\bprocess\.|\bwindow\.|\bfetch\(/u,
  "Compiled Plugin Main must not depend on browser or Node-only globals.",
);
assert.ok(
  pluginBundle.includes("fad.figma-tools.v1"),
  "Plugin bundle is missing the native tool executor.",
);
assert.ok(
  pluginBundle.includes("tool-execute"),
  "Plugin bundle is missing the versioned tool protocol.",
);
assert.ok(
  controllerBundle.includes("structural_verification") &&
    controllerBundle.includes("native_hierarchy_measurement") &&
    controllerBundle.includes("measured_foreground_contrast"),
  "Registered plugin controller is missing complete native QA and deterministic repair planning.",
);
assert.match(nativeQualitySource, /MAX_NATIVE_QUALITY_SCAN_NODES = 5_000/u);
assert.match(nativeQualitySource, /MAX_NATIVE_QUALITY_SCAN_DEPTH = 48/u);
assert.match(nativeQualitySource, /MAX_NATIVE_QUALITY_OVERLAP_PAIRS = 50_000/u);
assert.ok(
  controllerBundle.includes("overlap-analysis-limit") &&
    controllerBundle.includes("qualityCoverage") &&
    uiHtml.includes("native_verification_capacity_exceeded"),
  "Registered plugin/UI artifacts are missing bounded-QA markers or fail-closed incomplete-coverage handling.",
);
assert.ok(
  uiHtml.includes("native-quality-repair-v2") && uiHtml.includes("native_quality_unrepairable"),
  "Registered UI is missing repair dispatch and versioned diagnostics.",
);
assert.ok(uiHtml.includes("AI Chat"), "UI bundle is missing the AI Chat navigation entry.");
assert.ok(
  uiHtml.includes("Inspection status:") &&
    uiHtml.includes("read_only_inspection_confirmed") &&
    controllerBundle.includes("pagesVisited") &&
    controllerBundle.includes("continuationAvailable") &&
    controllerBundle.includes("discovery_cursor_stalled") &&
    companionServer.includes("deterministic progressive inspection controller"),
  "Registered artifacts are missing the read-only discovery completion fix.",
);
assert.ok(
  controllerBundle.includes("exactNameMatchCount") &&
    controllerBundle.includes("fad.document-discovery.v1") &&
    uiHtml.includes("EDIT_TARGETING") &&
    uiHtml.includes("EDIT_PLANNING") &&
    uiHtml.includes("target_not_inspected") &&
    uiHtml.includes("targetRefs"),
  "Registered artifacts are missing deterministic edit target verification and planning gates.",
);
assert.ok(
  !uiHtml.includes("Native operation harness"),
  "UI bundle unexpectedly exposes the removed local developer harness.",
);
assert.ok(uiHtml.includes("Enter to send"), "UI bundle is missing the conversational composer.");
assert.ok(
  uiHtml.includes("Generation Progress") && uiHtml.includes("Task-owned native nodes only"),
  "UI bundle is missing task progress and task-owned native layer inspection.",
);
assert.ok(
  pluginBundle.includes("task-native-inspect") && pluginBundle.includes("task-native-focus"),
  "Plugin bundle is missing the read-only native inspection and validated focus protocol.",
);
assert.ok(
  pluginBundle.includes("Fresh native text differs from the validated design copy") &&
    pluginBundle.includes("Fresh native color differs from the validated palette token") &&
    pluginBundle.includes("Fresh native Auto Layout direction differs") &&
    companionDesignGeneration.includes("Required composition patterns for this screen") &&
    uiHtml.includes("high_fidelity"),
  "Registered plugin/UI artifacts are missing high-fidelity design generation and fresh native value verification.",
);
assert.ok(
  uiHtml.includes("Retry Failed Stage") && uiHtml.includes("Resume"),
  "UI is missing task recovery controls.",
);
assert.ok(
  pluginBundle.includes("chat-task-save"),
  "Plugin bundle is missing durable chat-task checkpoints.",
);
assert.ok(
  pluginBundle.includes("chat-history-upsert"),
  "Plugin bundle is missing persisted chat history.",
);
assert.ok(
  companionServer.includes("plan_canvas_task"),
  "Companion is missing bounded stage planning.",
);
assert.ok(companionServer.includes('"/v1/chat"'), "Compiled companion is missing the chat route.");
for (const [source, output] of [
  ["src/companion/main.ts", "dist-companion/companion/main.js"],
  ["src/companion/server.ts", "dist-companion/companion/server.js"],
  ["src/shared/design-generation.ts", "dist-companion/shared/design-generation.js"],
  ["src/shared/generation-draft.ts", "dist-companion/shared/generation-draft.js"],
  ["src/shared/generation-transaction.ts", "dist-companion/shared/generation-transaction.js"],
  ["src/shared/generation-limits.ts", "dist-companion/shared/generation-limits.js"],
  ["src/shared/chat-tools.ts", "dist-companion/shared/chat-tools.js"],
  ["src/shared/figma-tools.ts", "dist-companion/shared/figma-tools.js"],
  ["src/companion/draft-store.ts", "dist-companion/companion/draft-store.js"],
  ["src/ui/App.tsx", "dist/ui.html"],
  ["src/ui/chat-history-view.tsx", "dist/ui.html"],
  ["src/ui/chat-delete-dialog.tsx", "dist/ui.html"],
  ["src/ui/home-dashboard.tsx", "dist/ui.html"],
  ["src/ui/workspace-detail-view.tsx", "dist/ui.html"],
  ["src/ui/task-workspace-view.tsx", "dist/ui.html"],
  ["src/ui/task-native-bridge.ts", "dist/ui.html"],
  ["src/ui/workspace-navigation.tsx", "dist/ui.html"],
  ["src/shared/chat-history.ts", "dist/ui.html"],
  ["src/shared/chat-history.ts", "dist/plugin.js"],
  ["src/ui/chat-task.ts", "dist/ui.html"],
  ["src/ui/chat-task-bridge.ts", "dist/ui.html"],
  ["src/plugin/chat-history-storage.ts", "dist/plugin.js"],
  ["src/shared/chat-task.ts", "dist/plugin.js"],
  ["src/plugin/chat-task-storage.ts", "dist/plugin.js"],
  ["src/plugin/generation-controller.ts", "dist/plugin.js"],
  ["src/plugin/native-design-verification.ts", "dist/plugin.js"],
  ["src/plugin/figma-tool-executor.ts", "dist/plugin.js"],
  ["src/plugin/auto-layout-repair.ts", "dist/plugin.js"],
  ["src/shared/native-quality-repair.ts", "dist/plugin.js"],
  ["src/shared/native-quality-repair.ts", "dist/ui.html"],
  ["src/shared/native-visual-quality.ts", "dist/plugin.js"],
  ["src/shared/native-visual-quality.ts", "dist/ui.html"],
  ["src/shared/visual-design-spec.ts", "dist/ui.html"],
  ["src/shared/visual-design-spec.ts", "dist/plugin.js"],
  ["src/shared/visual-design-spec.ts", "dist-companion/shared/visual-design-spec.js"],
  ["src/shared/design-patterns.ts", "dist/ui.html"],
  ["src/shared/design-patterns.ts", "dist/plugin.js"],
  ["src/shared/design-patterns.ts", "dist-companion/shared/design-patterns.js"],
  ["src/shared/design-icons.ts", "dist/ui.html"],
  ["src/shared/design-icons.ts", "dist/plugin.js"],
  ["src/shared/design-icons.ts", "dist-companion/shared/design-icons.js"],
  ["src/shared/figma-tools.ts", "dist/plugin.js"],
  ["src/shared/messages.ts", "dist/plugin.js"],
  ["src/shared/messages.ts", "dist/ui.html"],
  ["src/ui/styles.css", "dist/ui.html"],
]) {
  const sourceStat = await stat(new URL(source, root));
  const outputStat = await stat(new URL(output, root));
  assert.ok(
    outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs,
    `Stale or missing ${output}; rebuild it.`,
  );
}
assert.equal(typeof createDraftStore, "function");
assert.equal(typeof normalizeGeneratedDesignResponse, "function");
assert.ok(
  createDesignPlan({
    prompt: "Create a two-screen mobile storefront.",
    target: "mobile",
    screenCount: 2,
    screenNames: ["Home", "Detail"],
    language: "fa",
    style: "",
  }).success,
);
const server = createCompanionServer({
  port: 0,
  installationStore: {
    load: async () => ({ extAgentHostId: "urn:uuid:123e4567-e89b-42d3-a456-426614174000" }),
    saveClientId: async () => {},
    clearRegistration: async () => {},
  },
  fetchImpl: async () => {
    throw new Error("This compiled-entrypoint test must not make authorized provider requests.");
  },
});
const handle = await server.start();
try {
  const health = await globalThis.fetch(`http://localhost:${handle.port}/v1/health`, {
    headers: { Origin: "null" },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { companion: "running" });
  console.log(
    "Compiled companion boots on ephemeral loopback; current plugin/UI/companion entrypoints verified. No OAuth or Figma Desktop acceptance performed.",
  );
} finally {
  await handle.close();
}
