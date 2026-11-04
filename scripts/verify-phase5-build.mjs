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
const pkg = await readJson("package.json");
const manifest = await readJson("manifest.json");
assert.match(
  pkg.scripts.companion,
  /tsc -p tsconfig\.companion\.json && node dist-companion\/companion\/main\.js/u,
);
assert.equal(manifest.main, "dist/plugin.js");
assert.equal(manifest.ui, "dist/ui.html");
for (const [source, output] of [
  ["src/companion/main.ts", "dist-companion/companion/main.js"],
  ["src/companion/server.ts", "dist-companion/companion/server.js"],
  ["src/shared/design-generation.ts", "dist-companion/shared/design-generation.js"],
  ["src/companion/draft-store.ts", "dist-companion/companion/draft-store.js"],
  ["src/ui/App.tsx", "dist/ui.html"],
  ["src/plugin/generation-controller.ts", "dist/plugin.js"],
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
