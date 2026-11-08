import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatTaskSchema, type ChatTask } from "../src/shared/chat-task";
import { parseResponsesFunctionCalls } from "../src/shared/chat-tools";
import {
  GenerationProgressView,
  taskResultStatus,
  taskStageDisplayStates,
} from "../src/ui/task-workspace-view";

function task(status: ChatTask["status"] = "running"): ChatTask {
  const call = parseResponsesFunctionCalls([
    {
      type: "function_call",
      call_id: "task_progress_create_home",
      name: "create_frame",
      arguments: JSON.stringify({
        ref: "home-screen",
        name: "Home",
        parent: { kind: "page" },
        size: { width: 390, height: 844 },
      }),
    },
  ])[0]!;
  return ChatTaskSchema.parse({
    version: 1,
    id: "chat-task-0001",
    referenceScope: "task-v1",
    documentId: "file-test-page_1",
    prompt: "Create two mobile screens",
    context: [],
    stages: [
      {
        title: "Home Screen",
        logicalRefs: ["home-screen"],
        completed: true,
        operations: 1,
        rounds: 0,
        verified: true,
      },
      {
        title: "Product Screen",
        logicalRefs: ["product-screen"],
        completed: false,
        operations: 0,
        rounds: 0,
      },
    ],
    ledger: [
      {
        call,
        operationId: "chat-task-0001-op-1",
        stage: 0,
        status: "completed",
        category: "mutation",
        acknowledgementStatus: "confirmed_mutation",
      },
    ],
    pending: [],
    recent: [],
    starts: [],
    rounds: 1,
    status,
    text: "",
    ...(status === "failed"
      ? {
          failure: {
            category: "figma_runtime" as const,
            code: "native_operation_failed",
            committedOperations: 1,
          },
        }
      : {}),
  });
}

describe("task workspace progress and results", () => {
  it("distinguishes live stages from a running checkpoint restored after plugin reload", () => {
    const saved = task();
    expect(taskStageDisplayStates(saved, true)).toMatchObject([
      { state: "completed", confirmed: 1 },
      { state: "active", confirmed: 0 },
    ]);
    expect(taskStageDisplayStates(saved, false)).toMatchObject([
      { state: "completed", confirmed: 1 },
      { state: "recovery", confirmed: 0 },
    ]);
  });

  it("reports partial/failure/completion without inventing a percentage or preview", () => {
    const failed = task("failed");
    expect(taskStageDisplayStates(failed, false)[1]?.state).toBe("failed");
    expect(taskResultStatus(failed, 1, false)).toContain("Partial result");
    expect(taskResultStatus(failed, 0, false)).toContain("no verified native frame");
    expect(taskResultStatus({ ...failed, status: "completed" }, 0, false)).toContain(
      "no current screen frame verified",
    );
  });

  it("renders only real checkpoint counts in an indeterminate progress indicator", () => {
    const html = renderToStaticMarkup(
      <GenerationProgressView
        task={task()}
        isRunning={false}
        canResume
        onStop={() => undefined}
        onResume={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain(
      'aria-valuetext="1 of 2 stages completed; 1 native mutations confirmed"',
    );
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain("Awaiting recovery");
    expect(html).toContain("Resume saved task");
    expect(html).not.toContain("Stop generation");
    const liveHtml = renderToStaticMarkup(
      <GenerationProgressView
        task={task()}
        isRunning
        canResume
        onStop={() => undefined}
        onResume={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(liveHtml).toContain("Stop generation");
    expect(liveHtml).not.toContain("Resume saved task");
  });
});
