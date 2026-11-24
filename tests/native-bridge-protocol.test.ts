import { afterEach, expect, it, vi } from "vitest";
import {
  renderDesignProgramBridge,
  type DesignProgramRenderRequest,
} from "../src/ui/design-program-bridge";
import { taskNativeBridge } from "../src/ui/task-native-bridge";

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
