import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

const projectRoot = process.cwd();
const originalEnvironment = {
  fw5: process.env.VITE_FW5_VISUAL_QA,
  fw4: process.env.VITE_FW4_GEOMETRY,
  fw2: process.env.VITE_FW2_CONTEXT,
};
const variants = [];

try {
  for (const [gate, value] of [["OFF", ""], ["ON", "fw5-visual-qa-v1"]]) {
    process.env.VITE_FW5_VISUAL_QA = value;
    process.env.VITE_FW4_GEOMETRY = "";
    process.env.VITE_FW2_CONTEXT = "";
    const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
    try {
      const benchmark = await server.ssrLoadModule("/tests/fixtures/fw5-visual-qa-benchmark.ts");
      const originalLog = console.log;
      try {
        console.log = () => {};
        variants.push({ gate, ...(await benchmark.runFw5VisualQaBenchmark()) });
      } finally {
        console.log = originalLog;
      }
    } finally {
      await server.close();
    }
  }
} finally {
  if (originalEnvironment.fw5 === undefined) delete process.env.VITE_FW5_VISUAL_QA;
  else process.env.VITE_FW5_VISUAL_QA = originalEnvironment.fw5;
  if (originalEnvironment.fw4 === undefined) delete process.env.VITE_FW4_GEOMETRY;
  else process.env.VITE_FW4_GEOMETRY = originalEnvironment.fw4;
  if (originalEnvironment.fw2 === undefined) delete process.env.VITE_FW2_CONTEXT;
  else process.env.VITE_FW2_CONTEXT = originalEnvironment.fw2;
}

const off = variants.find(({ gate }) => gate === "OFF");
const on = variants.find(({ gate }) => gate === "ON");
if (!off || !on) throw new Error("Expected both FW-5 gate variants.");
const comparisons = ["F0", "F1", "F3", "F10"].map((scenario) => {
  const offResult = off.scenarios.find((entry) => entry.scenario === scenario);
  const onResult = on.scenarios.find((entry) => entry.scenario === scenario);
  const nativeEquivalent = scenario === "F0" ? null :
    JSON.stringify(offResult?.paritySnapshot ?? []) === JSON.stringify(onResult?.paritySnapshot ?? []) &&
    JSON.stringify(offResult?.measured?.nativeRootIds ?? []) === JSON.stringify(onResult?.measured?.nativeRootIds ?? []);
  return {
    scenario,
    gateOff: offResult?.measured ?? null,
    gateOn: onResult?.measured ?? null,
    nativeTreeAndRootIdentityEquivalent: nativeEquivalent,
    liveDesktopResult: "NOT_RUN",
  };
});
const output = {
  schemaVersion: 1,
  runAt: new Date().toISOString(),
  featureGate: { variable: "VITE_FW5_VISUAL_QA", enabledValue: "fw5-visual-qa-v1", default: "off" },
  runtime: "LOCAL_FAKE_FIGMA_RUNTIME",
  variants,
  comparisons,
  interpretation: [
    "Gate-off and gate-on use the same deterministic fixture programs and fake Figma runtime within separate isolated module-load runs.",
    "The gate-on path adds one bounded native export per newly rendered and readback-confirmed screen. This harness demonstrates export dispatch, not visual accuracy or perceived speed.",
    "There is no registered reviewer, so every screenshot-bearing outcome remains UNVERIFIED. No visual quality PASS is inferred.",
    "Checkpoint writes and reads are owned by the UI ChatTask path and are not invoked by this plugin-side harness; see integrated checkpoint tests.",
    "Actual UI bridge serialization, real Desktop layout, rendering latency, Figma API timing, and memory high-water marks are not measured here.",
  ],
};

const directory = resolve(projectRoot, "docs/figwright-integration/fw-05");
mkdirSync(directory, { recursive: true });
const outputPath = resolve(directory, "04-gate-off-on-metrics.json");
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, comparisons: comparisons.map(({ scenario, nativeTreeAndRootIdentityEquivalent }) => ({ scenario, nativeTreeAndRootIdentityEquivalent })) })}\n`);
