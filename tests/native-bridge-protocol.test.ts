import { afterEach, expect, it, vi } from "vitest";
import {
  renderDesignProgramBridge,
  type DesignProgramRenderRequest,
} from "../src/ui/design-program-bridge";
import { taskNativeBridge } from "../src/ui/task-native-bridge";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { renderDesignProgramLocal } from "../src/plugin/design-program-spike";
import { createMockApi } from "./figma-mock";
import { designProgramFixtures } from "./fixtures/design-programs";
import { UIToPluginSchema, type PluginToUIMessage } from "../src/shared/messages";
import { projectNativeLayoutExpectations } from "../src/shared/fw4-geometry";
import { DesignProgramV1Schema } from "../src/shared/design-program";

const taskId = "chat-task-0001";
const requestId = "native-request-0001";
const inspection = {
  type: "task-native-inspect",
  requestId,
  taskId,
  documentId: "native-doc-0001",
  refs: ["root"],
} as const;

function bridgeHarness() {
  vi.useFakeTimers();
  const events = new EventTarget();
  vi.stubGlobal("window", Object.assign(events, { setTimeout, clearTimeout }));
  const postMessage = vi.fn();
  vi.stubGlobal("parent", { postMessage });
  return {
    send(pluginMessage: unknown) {
      events.dispatchEvent(new MessageEvent("message", { data: { pluginMessage } }));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["render", "readback"] as const)(
  "classifies an invalid correlated native %s reply before the timeout",
  async (operation) => {
    const harness = bridgeHarness();
    const promise =
      operation === "render"
        ? renderDesignProgramBridge({
            type: "design-program-render",
            requestId,
            taskId,
            program: { screens: [] },
          } as unknown as DesignProgramRenderRequest)
        : taskNativeBridge({ ...inspection, refs: [...inspection.refs] });
    const outcome = promise.catch((error: unknown) => error);
    harness.send({
      type:
        operation === "render" ? "design-program-render-result" : "task-native-inspection-result",
      requestId,
      taskId,
      success: "invalid",
    });
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ code: `native_${operation}_protocol_error` });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("ignores a readback for another task even if its request ID matches", async () => {
  const harness = bridgeHarness();
  const pending = taskNativeBridge({ ...inspection, refs: [...inspection.refs] });
  const response = { type: "task-native-inspection-result", requestId, success: true, nodes: [] };
  harness.send({ ...response, taskId: "another-task" });
  harness.send({ ...response, taskId });
  await expect(pending).resolves.toMatchObject({ ...response, taskId });
});

it("carries a transient native geometry retry through the UI/plugin task-inspection boundary", async () => {
  const mock = createMockApi();
  const unrelated = mock.api.createRectangle();
  const outbound: PluginToUIMessage[] = [];
  const events = new EventTarget();
  let dispatch: Promise<void> | undefined;
  const executorRef: { current?: ReturnType<typeof createFigmaToolExecutor> } = {};
  const parentShim = {
    postMessage(value: { pluginMessage: unknown }) {
      const request = UIToPluginSchema.parse(value.pluginMessage);
      dispatch = executorRef.current!(request as Parameters<NonNullable<typeof executorRef.current>>[0]);
    },
  };
  vi.stubGlobal("window", Object.assign(events, { setTimeout, clearTimeout }));
  vi.stubGlobal("parent", parentShim);
  const executor = createFigmaToolExecutor(mock.api, (message) => {
    outbound.push(message);
    events.dispatchEvent(new MessageEvent("message", { data: { pluginMessage: message } }));
  });
  executorRef.current = executor;
  const program = DesignProgramV1Schema.parse(designProgramFixtures[0]);
  const rendered = await renderDesignProgramLocal(mock.api, program, {
    taskId, documentId: "file-test-56-page_current", pageId: "page:current", executor,
  });
  expect(rendered.success).toBe(true);
  if (!rendered.success) return;
  const root = mock.nodes.find(({ id }) => id === rendered.roots[0]!.nodeId)!;
  const text = mock.nodes.find((node) => node.type === "TEXT")!;
  const bounds = Object.getOwnPropertyDescriptor(text, "absoluteRenderBounds")!;
  let unavailableReads = 1;
  Object.defineProperty(text, "absoluteRenderBounds", {
    configurable: true,
    get() { if (unavailableReads > 0) { unavailableReads--; return null; } return bounds.get!.call(text); },
  });
  const request = UIToPluginSchema.parse({
    type: "task-native-inspect", requestId: "native-geometry-retry-01", taskId,
    documentId: "file-test-56-page_current", refs: [rendered.roots[0]!.ref],
    geometry: {
      programFingerprint: rendered.fingerprint, requireReceipt: true,
      expectedRootNodeId: root.id,
      expectedLayout: projectNativeLayoutExpectations(program, program.screens[0]!.id),
    },
  }) as Extract<Parameters<typeof executor>[0], { type: "task-native-inspect" }>;
  const inspectionPromise = taskNativeBridge(request);
  await dispatch;
  const inspection = await inspectionPromise;
  if (inspection.type !== "task-native-inspection-result") throw new Error("Expected compiled task native readback response.");
  expect(inspection).toMatchObject({
    type: "task-native-inspection-result", success: true, taskId,
    expectedRootStatus: "present", unresolvedRefs: [],
    geometry: { coverage: "complete", readAttempts: 2, receipt: expect.stringMatching(/^v1-/u) },
  });
  expect(inspection.nodes?.find(({ ref }) => ref === request.refs[0])?.id).toBe(root.id);
  expect(mock.api.currentPage.children).toContain(unrelated);
  expect(mock.api.currentPage.children.filter((node) => node.id === root.id)).toHaveLength(1);
  expect(outbound.at(-1)).toMatchObject({ type: "task-native-inspection-result", success: true });
});
