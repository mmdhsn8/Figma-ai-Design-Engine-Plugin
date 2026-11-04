import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesignPlan,
  normalizeGeneratedDesignResponse,
} from "../dist-companion/shared/design-generation.js";

const plan = createDesignPlan({
  prompt: "یک فروشگاه فارسی با صفحه خانه و جزئیات محصول طراحی کن.",
  target: "mobile",
  screenCount: 2,
  screenNames: ["Home", "Detail"],
  language: "fa",
  style: "",
});
if (!plan.success) throw new Error("fixture plan failed");
const button = {
  type: "text",
  name: "خرید",
  text: "خرید",
  palette: "text",
  width: 24,
  height: 24,
  fontSize: 16,
  fontStyle: "Regular",
  textAlign: "right",
  cornerRadius: 0,
  elevation: "none",
  layout: "none",
  gap: 8,
  padding: 0,
  qualityRole: "button",
  children: [],
};
const raw = JSON.stringify({
  projectName: "Benchmark",
  palette: {
    brand: "#223344",
    accent: "#CC7744",
    page: "#F7F5F0",
    surface: "#FFFFFF",
    text: "#17212B",
    muted: "#647080",
    border: "#D8DEE6",
  },
  screens: plan.data.screens.map(({ id }) => ({
    id,
    children: [
      {
        ...button,
        type: "frame",
        text: null,
        qualityRole: "decorative",
        width: 350,
        height: 80,
        layout: "horizontal",
        children: Array.from({ length: 4 }, () => ({ ...button })),
      },
    ],
  })),
});
const iterations = 200;
for (let i = 0; i < 20; i++) normalizeGeneratedDesignResponse(raw, plan.data);
let start = performance.now();
for (let i = 0; i < iterations; i++) JSON.parse(raw);
const parseMs = (performance.now() - start) / iterations;
start = performance.now();
let accepted = 0;
for (let i = 0; i < iterations; i++)
  if (normalizeGeneratedDesignResponse(raw, plan.data).success) accepted++;
const normalizationMs = (performance.now() - start) / iterations;
const directory = await mkdtemp(
  join(
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir(),
    "phase5-benchmark-",
  ),
);
const spool = {};
try {
  const payload = "x".repeat(11_491);
  const deltas = payload.match(/.{1,5}/gu);
  for (const mode of ["perDelta", "buffered64KiB"]) {
    const path = join(directory, `${mode}.json`);
    const file = await open(path, "wx");
    const began = performance.now();
    let writes = 0;
    try {
      if (mode === "perDelta")
        for (const delta of deltas) {
          await file.writeFile(delta);
          writes++;
        }
      else {
        await file.writeFile(deltas.join(""));
        writes++;
      }
    } finally {
      await file.close();
    }
    spool[mode] = {
      elapsedMs: performance.now() - began,
      writes,
      bytes: Buffer.byteLength(await readFile(path)),
    };
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      fixture: "two-screen-persian-text-controls",
      bytes: Buffer.byteLength(raw),
      iterations,
      parseMs,
      normalizeAndValidateMs: normalizationMs,
      accepted,
      spoolStrategyMicrobenchmark: spool,
      inference: "not measured; no authorized live request",
      render: "not measured by this microbenchmark",
    },
    null,
    2,
  ),
);
