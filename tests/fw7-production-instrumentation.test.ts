import { describe, expect, it, vi } from "vitest";
import { FW7_BUILD_ID, FW7_DIAGNOSTICS_ENABLED, FW7_FEATURE_FLAGS } from "../src/shared/fw7-feature";
import { fw7Telemetry } from "../src/plugin/fw7-runtime";
import { fw7CorrelationHash } from "../src/shared/fw7-observability";
import { renderDesignProgramLocal } from "../src/plugin/design-program-spike";
import type { DesignProgramNode, DesignProgramV1 } from "../src/shared/design-program";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { createMockApi } from "./figma-mock";
import { designProgramFixtures } from "./fixtures/design-programs";

function prefixNode(node: DesignProgramNode, prefix: string): DesignProgramNode {
  if (node.type === "container") return { ...node, id: `${prefix}-${node.id}`.slice(0, 60), children: node.children.map((child) => prefixNode(child, prefix)) };
  return { ...node, id: `${prefix}-${node.id}`.slice(0, 60) };
}

function fixtureWithScreens(count: number): DesignProgramV1 {
  const program = structuredClone(designProgramFixtures[0]) as unknown as DesignProgramV1;
  const sourceScreen = program.screens[0]!;
  program.id = `fw7-bench-${count}`;
  program.screens = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(sourceScreen),
    id: `fw7-screen-${String(index + 1).padStart(2, "0")}`,
    title: `Local harness screen ${index + 1}`,
    order: index,
    dependsOn: [],
    root: prefixNode(sourceScreen.root, `s${String(index + 1).padStart(2, "0")}`),
  }));
  return program;
}

describe("FW-7 production instrumentation on fake Figma runtime", () => {
  it("renders 1/3/10 screen local scenarios and reports only measured event counters", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const traceLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const measurements = [];
    try {
      for (const count of [1, 3, 10]) {
        const taskId = `fw7-fake-task-${count}`;
        const mock = createMockApi();
        const executor = createFigmaToolExecutor(mock.api, () => undefined);
        const startedAt = performance.now();
        const result = await renderDesignProgramLocal(mock.api, fixtureWithScreens(count), {
          taskId, documentId: "file-test-56-page_current", pageId: "page:current", executor,
        });
        const localHarnessMs = Math.max(0, performance.now() - startedAt);
        expect(result.success, JSON.stringify(result.success ? [] : result.findings)).toBe(true);
        if (!result.success) continue;
        expect(result.roots).toHaveLength(count);
        expect(new Set(result.roots.map(({ nodeId }) => nodeId)).size).toBe(count);
        expect(result.roots.every(({ nodeId }) => mock.page.children.some((node) => node.id === nodeId))).toBe(true);
        const snapshot = fw7Telemetry.snapshot(taskId)[0];
        if (FW7_DIAGNOSTICS_ENABLED) {
          expect(snapshot).toBeDefined();
          expect(snapshot?.counters.figmaCreateCalls).toBeGreaterThan(0);
          expect(snapshot?.counters.figmaAppendCalls).toBeGreaterThan(0);
          expect(snapshot?.counters.nativeReadbackOperations).toBeGreaterThanOrEqual(count);
          expect(snapshot?.counters.providerRequests).toBeNull();
        } else {
          expect(snapshot).toBeUndefined();
        }
        measurements.push({
          evidenceSource: "FAKE_RUNTIME",
          diagnostics: FW7_DIAGNOSTICS_ENABLED ? "ON" : "OFF",
          buildId: FW7_BUILD_ID,
          featureFlags: FW7_FEATURE_FLAGS,
          screenCount: count,
          verifiedRoots: result.roots.length,
          createdNodes: result.nodeCount,
          rootIdHashes: result.roots.map(({ nodeId }) => fw7CorrelationHash(nodeId)),
          counters: snapshot?.counters ?? null,
          figmaCreateCalls: snapshot?.counters.figmaCreateCalls ?? null,
          figmaAppendCalls: snapshot?.counters.figmaAppendCalls ?? null,
          figmaResizeCalls: snapshot?.counters.figmaResizeCalls ?? null,
          nativeReadbackOperations: snapshot?.counters.nativeReadbackOperations ?? null,
          uiPluginDispatches: snapshot?.counters.uiPluginDispatches ?? null,
          localHarnessMs,
        });
      }
    } finally {
      logSpy.mockRestore();
      traceLogSpy.mockRestore();
    }
    console.log(`[FW7_FAKE_BENCHMARK] ${JSON.stringify(measurements)}`);
    expect(measurements.map(({ screenCount }) => screenCount)).toEqual([1, 3, 10]);
  });
});
