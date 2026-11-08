import { describe, expect, it, vi } from "vitest";
import { ChatTaskSchema } from "../src/shared/chat-task";
import {
  chatTaskDiagnosticJson,
  copyDiagnosticJson,
  downloadDiagnosticJson,
} from "../src/ui/diagnostic-export";

function copyDocument(copyResult = true) {
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const previousFocus = { focus: vi.fn() };
  const document = {
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => copyResult),
    activeElement: previousFocus,
  } as unknown as Document;
  return { document, textarea, previousFocus };
}

describe("sanitized diagnostic export", () => {
  it("uses the clipboard API when it succeeds", async () => {
    const writeText = vi.fn(async () => {});
    const fallback = copyDocument();
    await expect(
      copyDiagnosticJson("safe-json", { clipboard: { writeText }, document: fallback.document }),
    ).resolves.toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith("safe-json");
    expect(fallback.document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a selected textarea when clipboard permission is denied", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const fallback = copyDocument();
    await expect(
      copyDiagnosticJson("safe-json", { clipboard: { writeText }, document: fallback.document }),
    ).resolves.toBe("fallback");
    expect(fallback.textarea.value).toBe("safe-json");
    expect(fallback.document.execCommand).toHaveBeenCalledWith("copy");
    expect(fallback.textarea.remove).toHaveBeenCalled();
    expect(fallback.previousFocus.focus).toHaveBeenCalled();
  });

  it("uses the textarea fallback when the clipboard API is unavailable", async () => {
    const fallback = copyDocument();
    await expect(copyDiagnosticJson("safe-json", { document: fallback.document })).resolves.toBe(
      "fallback",
    );
    expect(fallback.document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure if clipboard and fallback are both blocked", async () => {
    const fallback = copyDocument(false);
    await expect(copyDiagnosticJson("safe-json", { document: fallback.document })).rejects.toThrow(
      "Download the diagnostic JSON",
    );
    expect(fallback.textarea.remove).toHaveBeenCalled();
  });

  it("downloads JSON without consulting clipboard permissions", () => {
    vi.useFakeTimers();
    const link = {
      href: "",
      download: "",
      style: {} as Record<string, string>,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const document = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => link),
    } as unknown as Document;
    const url = {
      createObjectURL: vi.fn(() => "blob:diagnostic"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL;

    try {
      downloadDiagnosticJson('{"safe":true}', "diagnostic.json", { document, url });
      expect(link.href).toBe("blob:diagnostic");
      expect(link.download).toBe("diagnostic.json");
      expect(link.click).toHaveBeenCalledOnce();
      expect(link.remove).toHaveBeenCalledOnce();
      expect(url.createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ type: "application/json;charset=utf-8" }),
      );
      vi.runAllTimers();
      expect(url.revokeObjectURL).toHaveBeenCalledWith("blob:diagnostic");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports structural rules and repair attempts without prompts, credentials, or model output", () => {
    const task = ChatTaskSchema.parse({
      version: 1,
      id: "diagnostic-task-01",
      documentId: "document-page",
      prompt: "PRIVATE PROMPT",
      lifecycle: "EXECUTING_STAGE",
      lifecycleTransitions: 4,
      context: [],
      stages: [
        {
          title: "Home",
          goal: "Build private user design",
          logicalRefs: ["home-title"],
          completionCriteria: ["Private criteria"],
          completed: false,
          estimatedMutations: 3,
          operations: 2,
          readOnlyOperations: 0,
          segments: [],
          rounds: 8,
          qaAttempts: 2,
          verificationOperations: 2,
          verified: false,
          verificationHistory: [
            {
              attempt: 1,
              findings: [
                {
                  code: "hidden-node",
                  refs: ["home-title"],
                  expected: "visible=true",
                  actual: "visible=false",
                },
              ],
            },
          ],
          qualityFindings: [
            {
              code: "hidden-node",
              refs: ["home-title"],
              expected: "visible=true",
              actual: "visible=false",
            },
          ],
          repairOperationsExecuted: 1,
          repairOperationsAttempted: 1,
          awaitingQualityRepair: true,
        },
      ],
      ledger: [],
      pending: [],
      recent: [{ role: "assistant", content: "PRIVATE MODEL RESPONSE and access_token" }],
      starts: [],
      rounds: 8,
      batches: 4,
      status: "failed",
      text: "PRIVATE FINAL RESPONSE",
      failure: { category: "planning", code: "task_paused", committedOperations: 2 },
    });

    const exported = chatTaskDiagnosticJson(task);
    expect(exported).toContain('"code": "hidden-node"');
    expect(exported).toContain('"refs": [\n            "home-title"');
    expect(exported).toContain('"expected": "visible=true"');
    expect(exported).toContain('"actual": "visible=false"');
    expect(exported).toContain('"verificationAttempts": 2');
    expect(exported).toContain('"repairsExecuted": true');
    expect(exported).toContain('"repairOperationsAttempted": 1');
    for (const privateValue of ["PRIVATE", "access_token", "Private criteria"])
      expect(exported).not.toContain(privateValue);
  });
});
