import { afterEach, describe, expect, it, vi } from "vitest";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { CONTEXT_COMPONENT_KEY, prepareContextReuse } from "../src/plugin/design-context-reuse";
import { captureDesignContext } from "../src/plugin/design-context";
import { DesignProgramV1Schema, type DesignProgramV1 } from "../src/shared/design-program";
import { FW4_GEOMETRY_NODE_LIMIT, projectNativeLayoutExpectations } from "../src/shared/fw4-geometry";
import { UIToPluginSchema, type PluginToUIMessage, type UIToPluginMessage } from "../src/shared/messages";
import { createMockApi, type MockNode } from "./figma-mock";

const taskId = "fw4-layout-task-0001";
const documentId = "file-test-56-page_current";

function makeProgram(): DesignProgramV1 {
  return DesignProgramV1Schema.parse({
    programVersion: 1,
    id: "fw4-rtl-geometry",
    revision: 1,
    goal: "Present a short bilingual building notice.",
    audience: "Residents",
    locale: { language: "fa-IR", direction: "rtl" },
    visualIntent: "A compact, legible notice with editable native text.",
    contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", "rtl"],
    tokens: {
      colors: { ink: "#20283A", surface: "#FFFFFF" },
      spacing: [8, 12, 16],
      headingFont: "Inter",
      bodyFont: "Inter",
    },
    references: [],
    screens: [{
      id: "screen-01",
      title: "Building notice",
      purpose: "Read a bilingual resident notice.",
      order: 0,
      viewport: { preset: "mobile", width: 390, height: 844 },
      scroll: "none",
      dependsOn: [],
      root: {
        type: "container",
        id: "notice-content",
        name: "Notice content",
        semanticRole: "notice-content",
        width: { mode: "fixed", value: 342 },
        height: { mode: "fixed", value: 260 },
        layout: {
          axis: "column",
          gap: 12,
          padding: { top: 12, right: 12, bottom: 12, left: 12 },
          align: "start",
          crossAlign: "start",
        },
        children: [{
          type: "text",
          id: "notice-title",
          name: "Notice title",
          semanticRole: "heading",
          interaction: "none",
          width: { mode: "fill", value: 318 },
          height: { mode: "fixed", value: 28 },
          text: "اطلاعیه ۱۲۳ · Update",
          color: "token:ink",
          fontSize: 18,
          weight: "semibold",
        }, {
          type: "text",
          id: "notice-copy",
          name: "Notice copy",
          semanticRole: "body",
          interaction: "none",
          width: { mode: "hug", value: 230 },
          height: { mode: "hug", value: 60 },
          text: "ورودی ساختمان تا ساعت ۱۸ باز است.",
          color: "token:ink",
          fontSize: 16,
          weight: "regular",
        }],
      },
    }],
  });
}

async function renderWithGate(
  enabled: boolean,
  mockOptions: Parameters<typeof createMockApi>[0] = {},
  includeUnrelatedRoot = false,
) {
  vi.resetModules();
  vi.stubEnv("VITE_FW4_GEOMETRY", enabled ? "fw4-geometry-v1" : "");
  const { renderDesignProgramLocal } = await import("../src/plugin/design-program-spike");
  const mock = createMockApi(mockOptions);
  const unrelated = includeUnrelatedRoot ? mock.api.createFrame() as unknown as MockNode : undefined;
  if (unrelated) {
    unrelated.name = "Unrelated user layer";
    unrelated.resize(120, 80);
    unrelated.setPluginData("fad.tool.task-id.v1", "different-task-owner");
  }
  const unrelatedBefore = unrelated ? snapshot(unrelated) : undefined;
  const messages: PluginToUIMessage[] = [];
  const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
  const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const result = await renderDesignProgramLocal(mock.api, makeProgram(), {
    taskId,
    documentId,
    pageId: "page:current",
    executor,
    requestId: `fw4_render_${enabled ? "on" : "off"}`,
  });
  logs.mockRestore();
  vi.unstubAllEnvs();
  const root = result.success ? mock.nodes.find(({ id }) => id === result.roots[0]?.nodeId) : undefined;
  return { mock, messages, executor, result, root, unrelated, unrelatedBefore };
}

function snapshot(node: MockNode): unknown {
  return {
    type: node.type,
    name: node.name,
    width: node.width,
    height: node.height,
    layoutMode: node.layoutMode,
    horizontal: node.layoutSizingHorizontal,
    vertical: node.layoutSizingVertical,
    textAutoResize: node.type === "TEXT" ? node.textAutoResize : undefined,
    characters: node.type === "TEXT" ? node.characters : undefined,
    children: node.children.map(snapshot),
  };
}

function taskNativeRequest(value: unknown) {
  return UIToPluginSchema.parse(value) as Extract<UIToPluginMessage, { type: "task-native-inspect" }>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("FW-4 production geometry convergence", () => {
  it("keeps the gate-off native tree unchanged and restores a sibling sizing mode only when enabled", async () => {
    const baseline = await renderWithGate(false);
    const enabled = await renderWithGate(true);
    expect(baseline.result.success).toBe(true);
    expect(enabled.result.success).toBe(true);
    if (!baseline.result.success || !enabled.result.success || !baseline.root || !enabled.root) return;
    expect(snapshot(enabled.root)).toEqual(snapshot(baseline.root));
    expect(enabled.result.geometryReadbacks).toBe(1);
    expect(baseline.result.geometryReadbacks).toBe(1);

    const offFault = await renderWithGate(false, { resetSiblingSizingOnAppend: true });
    const onFault = await renderWithGate(true, { resetSiblingSizingOnAppend: true });
    expect(offFault.result.success).toBe(true);
    expect(onFault.result.success).toBe(true);
    if (!offFault.result.success || !onFault.result.success || !offFault.root || !onFault.root) return;
    const firstExpectedRef = projectNativeLayoutExpectations(makeProgram(), "screen-01").find(({ logicalRef }) => logicalRef.endsWith("notice-title"))?.logicalRef;
    expect(firstExpectedRef).toBeTruthy();
    const offTitle = offFault.mock.nodes.find((node) => node.getPluginData("fad.design.logical-ref") === firstExpectedRef)!;
    const onTitle = onFault.mock.nodes.find((node) => node.getPluginData("fad.design.logical-ref") === firstExpectedRef)!;
    expect(offTitle.layoutSizingHorizontal).toBe("FIXED");
    expect(offTitle.textAutoResize).toBe("WIDTH_AND_HEIGHT");
    expect(onTitle.layoutSizingHorizontal).toBe("FILL");
    expect(onTitle.textAutoResize).toBe("HEIGHT");
    expect(onFault.result.geometryRepairs).toBeGreaterThan(0);
    expect(onFault.result.geometryReadbacks).toBe(2);
  });

  it("checks actual native sizing and text auto-resize on the later task-owned readback", async () => {
    const rendered = await renderWithGate(true);
    expect(rendered.result.success).toBe(true);
    if (!rendered.result.success || !rendered.root) return;
    const expectations = projectNativeLayoutExpectations(makeProgram(), "screen-01");
    expect(JSON.stringify(expectations)).not.toContain("اطلاعیه");
    expect(expectations).toEqual(expect.arrayContaining([
      expect.objectContaining({ logicalRef: "fw4-rtl-geometry.screen-01.notice-title", horizontalSizing: "FILL", verticalSizing: "FIXED", textAutoResize: "HEIGHT" }),
      expect.objectContaining({ logicalRef: "fw4-rtl-geometry.screen-01.notice-copy", horizontalSizing: "HUG", verticalSizing: "HUG", textAutoResize: "WIDTH_AND_HEIGHT" }),
    ]));
    const title = rendered.mock.nodes.find(({ name }) => name === "Notice title")!;
    title.layoutSizingHorizontal = "FIXED";
    const request = taskNativeRequest({
      type: "task-native-inspect",
      requestId: "fw4_readback_request",
      documentId,
      taskId,
      refs: [rendered.result.roots[0]!.ref],
      geometry: {
        programFingerprint: rendered.result.fingerprint,
        requireReceipt: true,
        expectedRootNodeId: rendered.root.id,
        expectedLayout: expectations,
      },
    });
    await rendered.executor(request);
    const response = rendered.messages.at(-1);
    expect(response?.type).toBe("task-native-inspection-result");
    if (response?.type !== "task-native-inspection-result") return;
    expect(response.geometry?.coverage).toBe("complete");
    expect(response.geometry?.findings).toContainEqual(expect.objectContaining({
      code: "native_layout_sizing_mismatch",
      nodeId: title.id,
      expectedLayout: expect.objectContaining({ horizontalSizing: "FILL" }),
      observedLayout: expect.objectContaining({ horizontalSizing: "FIXED" }),
    }));

    const missingExpectationRequest = taskNativeRequest({
      type: "task-native-inspect",
      requestId: "fw4_missing_layout_ref",
      documentId,
      taskId,
      refs: [rendered.result.roots[0]!.ref],
      geometry: {
        programFingerprint: rendered.result.fingerprint,
        requireReceipt: true,
        expectedRootNodeId: rendered.root.id,
        expectedLayout: [...expectations, {
          logicalRef: "fw4-rtl-geometry.screen-01.missing-node",
          parentLogicalRef: "fw4-rtl-geometry.screen-01.notice-content",
          horizontalSizing: "FILL",
          verticalSizing: "FIXED",
        }],
      },
    });
    await rendered.executor(missingExpectationRequest);
    const missingResponse = rendered.messages.at(-1);
    expect(missingResponse?.type).toBe("task-native-inspection-result");
    if (missingResponse?.type === "task-native-inspection-result") {
      expect(missingResponse.geometry?.coverage).toBe("incomplete");
      expect(missingResponse.geometry?.findings).toContainEqual(expect.objectContaining({
        code: "native_layout_expectation_missing",
        logicalRef: "fw4-rtl-geometry.screen-01.missing-node",
      }));
    }
  });

  it("rejects duplicate, unknown, and over-limit native layout readback expectations", () => {
    const expectation = projectNativeLayoutExpectations(makeProgram(), "screen-01")[0]!;
    const base = {
      type: "task-native-inspect",
      requestId: "fw4_schema_check",
      documentId,
      taskId,
      refs: ["screen-root"],
      geometry: {
        programFingerprint: "dpv1-0123456789abcdef",
        requireReceipt: true,
        expectedLayout: [expectation],
      },
    };
    expect(UIToPluginSchema.safeParse(base).success).toBe(true);
    expect(UIToPluginSchema.safeParse({
      ...base,
      geometry: { ...base.geometry, expectedLayout: [expectation, expectation] },
    }).success).toBe(false);
    expect(UIToPluginSchema.safeParse({
      ...base,
      geometry: { ...base.geometry, expectedLayout: [{ ...expectation, arbitraryCode: "return 1" }] },
    }).success).toBe(false);
    expect(UIToPluginSchema.safeParse({
      ...base,
      geometry: { ...base.geometry, expectedLayout: Array.from({ length: FW4_GEOMETRY_NODE_LIMIT + 1 }, (_, index) => ({
        logicalRef: `node-${index}`,
        parentLogicalRef: "screen-root",
        horizontalSizing: "FIXED",
        verticalSizing: "FIXED",
      })) },
    }).success).toBe(false);
  });

  it("retains the attached root when the bounded sizing correction itself fails", async () => {
    const rendered = await renderWithGate(true, {
      resetSiblingSizingOnAppend: true,
      rejectSizingRestoreAfterAppend: true,
    }, true);
    expect(rendered.result.success).toBe(false);
    const roots = rendered.mock.api.currentPage.children as unknown as MockNode[];
    const taskRoots = roots.filter((node) => node.getPluginData("fad.design.program-task.v1") === taskId);
    expect(taskRoots).toHaveLength(1);
    expect(taskRoots[0]?.children).toHaveLength(1);
    expect(rendered.mock.nodes.some((node) => node.name === "Notice title" && !node.removed)).toBe(true);
    expect(rendered.unrelated).toBeTruthy();
    expect(snapshot(rendered.unrelated!)).toEqual(rendered.unrelatedBefore);
    expect(rendered.unrelated?.getPluginData("fad.tool.task-id.v1")).toBe("different-task-owner");
    expect(taskRoots[0]?.children[0]?.children.map(({ name }) => name)).toEqual(["Notice content"]);
  });

  it("repairs the screen text beside FW-2 native reuse without changing its shared component master", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_FW4_GEOMETRY", "fw4-geometry-v1");
    const { renderDesignProgramLocal } = await import("../src/plugin/design-program-spike");
    const mock = createMockApi({ resetSiblingSizingOnAppend: true });
    const host = mock.api.createFrame() as unknown as MockNode;
    host.name = "User reference host";
    const set = mock.api.createFrame() as unknown as MockNode;
    Object.assign(set, { type: "COMPONENT_SET", name: "Reference set" });
    host.appendChild(set);
    const masterFrame = mock.api.createFrame() as unknown as MockNode;
    masterFrame.name = "White reference card";
    masterFrame.resize(48, 48);
    masterFrame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    const master = mock.api.createComponentFromNode(masterFrame) as unknown as MockNode;
    Object.assign(master, { blendMode: "PASS_THROUGH", cornerSmoothing: 0, variantProperties: { State: "Idle" } });
    set.appendChild(master);
    mock.api.currentPage.selection = [host];
    const snapshotBefore = await captureDesignContext(mock.api, "selection");
    expect(snapshotBefore.resources).toContainEqual(expect.objectContaining({ id: master.id, shape: [48, 48, 0, "#FFFFFF"] }));
    const reusable = await prepareContextReuse(mock.api, snapshotBefore, () => true);
    const masterBefore = {
      id: master.id, parentId: master.parent?.id, type: master.type, name: master.name,
      width: master.width, height: master.height, fills: JSON.stringify(master.fills),
      childIds: master.children.map(({ id }) => id), pluginData: [...master.pluginData.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
    const program = makeProgram();
    const children = program.screens[0]!.root;
    if (children.type !== "container") throw new Error("Expected the container regression fixture.");
    children.children.splice(1, 1, {
      type: "rectangle", id: "reused-surface", name: "Reusable surface", semanticRole: "surface",
      interaction: "none", width: { mode: "fixed", value: 48 }, height: { mode: "fixed", value: 48 }, fill: "token:surface",
    });
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const result = await renderDesignProgramLocal(mock.api, program, {
      taskId, documentId, pageId: "page:current", executor, contextReuse: async () => reusable,
      assertCurrentScope: () => undefined,
    });
    vi.unstubAllEnvs();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.geometryRepairs).toBeGreaterThan(0);
    expect(result.contextFindings ?? []).toEqual([]);
    const instance = mock.nodes.find((node) => node.type === "INSTANCE" && node.getPluginData(CONTEXT_COMPONENT_KEY) === "1");
    expect(instance).toBeTruthy();
    expect({
      id: master.id, parentId: master.parent?.id, type: master.type, name: master.name,
      width: master.width, height: master.height, fills: JSON.stringify(master.fills),
      childIds: master.children.map(({ id }) => id), pluginData: [...master.pluginData.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }).toEqual(masterBefore);
  });
});
