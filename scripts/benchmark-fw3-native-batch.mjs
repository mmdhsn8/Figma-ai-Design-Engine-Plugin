import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

const projectRoot = process.cwd();
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const benchmark = await server.ssrLoadModule("/tests/fixtures/fw3-native-batch-benchmark.ts");
  const originalLog = console.log;
  let output;
  try {
    console.log = () => {};
    output = await benchmark.runFw3NativeBatchBenchmark();
  } finally {
    console.log = originalLog;
  }
  const outputPath = resolve(projectRoot, "docs/figwright-integration/fw-03/03-local-benchmark.json");
  mkdirSync(resolve(projectRoot, "docs/figwright-integration/fw-03"), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, fixtures: output.results.map(({ fixtureId }) => fixtureId) })}\n`);
} finally {
  await server.close();
}
