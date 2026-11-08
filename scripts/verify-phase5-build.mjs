import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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
const uiMarker = "figma.showUI(";
const uiStart = pluginBundle.indexOf(uiMarker);
const quote = pluginBundle[uiStart + uiMarker.length];
const uiEndMarker = quote === "`" ? "</html>\n`" : `</html>\\n${quote}`;
const uiEnd = pluginBundle.indexOf(uiEndMarker, uiStart);
const pkg = await readJson("package.json");
const manifest = await readJson("manifest.json");
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
assert.ok(uiHtml.includes("AI Chat"), "UI bundle is missing the AI Chat navigation entry.");
assert.ok(
  uiHtml.includes("Native operation harness"),
  "UI bundle is missing the local developer harness.",
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
  ["src/plugin/figma-tool-executor.ts", "dist/plugin.js"],
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
