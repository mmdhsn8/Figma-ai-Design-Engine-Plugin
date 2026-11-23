import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

const projectRoot = process.cwd();
const originalValue = process.env.VITE_FW4_GEOMETRY;
const variants = [];

try {
  for (const [path, value] of [["gate_off", ""], ["gate_on", "fw4-geometry-v1"]]) {
    process.env.VITE_FW4_GEOMETRY = value;
    const server = await createServer({
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "error",
    });
    try {
      const benchmark = await server.ssrLoadModule("/tests/fixtures/fw4-native-geometry-benchmark.ts");
      const originalLog = console.log;
      let output;
      try {
        console.log = () => {};
        output = await benchmark.runFw4NativeGeometryBenchmark();
      } finally {
        console.log = originalLog;
      }
      variants.push({ path, ...output });
    } finally {
      await server.close();
    }
  }
} finally {
  if (originalValue === undefined) delete process.env.VITE_FW4_GEOMETRY;
  else process.env.VITE_FW4_GEOMETRY = originalValue;
}

const scenarios = variants.flatMap(({ path, scenarios: results }) => results.map((item) => ({ ...item, path })));
const output = {
  schemaVersion: 1,
  runAt: new Date().toISOString(),
  featureGate: { variable: "VITE_FW4_GEOMETRY", enabledValue: "fw4-geometry-v1", default: "off" },
  runtime: "LOCAL_FAKE_FIGMA_RUNTIME",
  variants: ["gate_off", "gate_on"],
  scenarios,
  evidenceNotes: [
    "This is a deterministic local harness; no Figma Desktop file, provider, OAuth session, or model was used.",
    "Renderer function invocations are counted. UI bridge messages and acknowledgements are not observed in this harness.",
    "Figma API calls and node mutations are counted on the fake runtime. UI ChatTask checkpoint operations are not invoked.",
    "Each scenario runs both without injection and with a mock that resets earlier sibling sizing after append. The latter is a fault test, not a claim about Desktop behavior.",
    "Local JavaScript execution time is not Figma Desktop render latency or perceived speed.",
  ],
};

const outputPath = resolve(projectRoot, "docs/figwright-integration/fw-04/04-local-before-after-metrics.json");
mkdirSync(resolve(projectRoot, "docs/figwright-integration/fw-04"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, scenarioCount: scenarios.length, screenCounts: [...new Set(scenarios.map(({ screenCount }) => screenCount))] })}\n`);
