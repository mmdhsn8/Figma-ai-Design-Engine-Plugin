import { ChatFunctionCallSchema, type ChatInputItem } from "../shared/chat-tools";
import { FigmaToolBatchSchema, type FigmaToolOperation } from "../shared/figma-tools";
import { type PluginToUIMessage } from "../shared/messages";
import { utf8Bytes } from "../shared/generation-limits";
import {
  CHAT_STAGE_MAX_OPERATIONS,
  CHAT_TASK_MAX_OPERATIONS,
  ChatTaskSchema,
  type ChatTask,
} from "../shared/chat-task";
import type { AuthorizedChatTurn } from "./companion-client";

type Result = Extract<PluginToUIMessage, { type: "tool-result" }>;
type Dependencies = {
  model(input: ChatInputItem[]): Promise<AuthorizedChatTurn>;
  execute(operations: FigmaToolOperation[]): Promise<Result>;
  save(task: ChatTask): Promise<void>;
  progress(message: string): void;
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function waitForChatCapacity(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new Error("Stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

// Only complete call/output pairs survive compaction; the durable ledger is the source of truth.
export function chatTaskInput(task: ChatTask): ChatInputItem[] {
  const confirmed = task.ledger
    .filter((entry) => entry.status === "completed" || entry.status === "failed")
    .map(({ call, operationId, status, stage, output }) => {
      const action = call.action;
      return {
        operationId,
        status,
        stage,
        tool: action.tool,
        ...("ref" in action ? { ref: action.ref } : {}),
        ...("name" in action ? { name: action.name } : {}),
        ...(status === "failed" ? { error: JSON.parse(output ?? "{}").error } : {}),
      };
    });
  const state = JSON.stringify({ taskId: task.id, stages: task.stages, confirmed });
  const summaries: ChatInputItem[] = [];
  for (let index = 0; index < state.length; index += 7_500)
    summaries.push({
      role: "assistant",
      content: `Confirmed task checkpoint (${index / 7_500 + 1}): ${state.slice(index, index + 7_500)}`,
    });
  let input: ChatInputItem[] = [
    ...task.context,
    { role: "user", content: task.prompt },
    ...summaries,
    ...task.recent,
  ];
  if (utf8Bytes(JSON.stringify(input)) > 56 * 1024) {
    const calls = task.recent.filter((item) => "type" in item && item.type === "function_call");
    const outputs = task.recent.filter(
      (item) => "type" in item && item.type === "function_call_output",
    );
    if (
      calls.length &&
      calls.every((call) => outputs.some((item) => item.call_id === call.call_id))
    ) {
      const results = JSON.stringify(outputs);
      const compact: ChatInputItem[] = [];
      for (let index = 0; index < results.length; index += 7_500)
        compact.push({
          role: "assistant",
          content: `Confirmed tool results: ${results.slice(index, index + 7_500)}`,
        });
      input = [...task.context, { role: "user", content: task.prompt }, ...summaries, ...compact];
    }
  }
  if (input.length > 40 || utf8Bytes(JSON.stringify(input)) > 56 * 1024)
    throw new Error(
      "Task context reached its bounded capacity. Committed work is saved; inspect the canvas before continuing in a new chat.",
    );
  return input;
}

export async function runChatTask(task: ChatTask, deps: Dependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? waitForChatCapacity;
  const check = () => {
    if (deps.signal.aborted) throw new Error("Stopped");
  };
  const save = async () => {
    const parsed = ChatTaskSchema.safeParse(task);
    if (!parsed.success)
      throw new Error(
        "Task checkpoint reached its safety budget or contains invalid state. Canvas changes are retained; no further batch was started.",
      );
    await deps.save(parsed.data);
  };
  const output = (callId: string, payload: unknown): ChatInputItem => ({
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(payload),
  });
  const wasRetry =
    task.status === "failed" || task.status === "stopped" || task.status === "running";
  task.status = "running";
  delete task.error;
  await save();
  try {
    while (true) {
      check();
      if (task.pending.length) {
        const calls = task.pending;
        const planning = calls.filter(
          (call) =>
            call.action.tool === "plan_canvas_task" || call.action.tool === "complete_canvas_stage",
        );
        if (planning.length) {
          if (calls.length !== 1) {
            task.recent.push(
              ...calls.map((call) =>
                output(call.callId, {
                  success: false,
                  error:
                    "Call planning or stage completion alone, separately from native changes. None of these calls were executed.",
                }),
              ),
            );
            task.pending = [];
            await save();
            continue;
          }
          const call = planning[0]!;
          const action = call.action;
          try {
            if (action.tool === "plan_canvas_task") {
              if (task.stages.length)
                throw new Error(
                  "The model attempted to replace an existing plan. Committed work was preserved.",
                );
              task.stages = action.stages.map((title) => ({
                title,
                completed: false,
                operations: 0,
                rounds: 0,
              }));
            } else if (action.tool === "complete_canvas_stage") {
              const stage = task.stages.find((item) => !item.completed);
              for (const operationId of action.resolvedOperationIds) {
                const failedIndex = task.ledger.findIndex(
                  (entry) => entry.operationId === operationId && entry.status === "failed",
                );
                const failed = task.ledger[failedIndex];
                if (!failed || !stage || failed.stage !== task.stages.indexOf(stage))
                  throw new Error("The repair references an unknown failed operation.");
                const failedAction = failed.call.action;
                const repair = task.ledger.slice(failedIndex + 1).some((entry) => {
                  const repairAction = entry.call.action;
                  if (
                    entry.status !== "completed" ||
                    entry.stage !== failed.stage ||
                    repairAction.tool !== failedAction.tool
                  )
                    return false;
                  if (
                    "ref" in failedAction &&
                    (!("ref" in repairAction) || repairAction.ref !== failedAction.ref)
                  )
                    return false;
                  if (
                    failedAction.tool === "set_properties" &&
                    repairAction.tool === "set_properties"
                  ) {
                    const properties = repairAction.properties;
                    return Object.entries(failedAction.properties).every(
                      ([key, value]) =>
                        JSON.stringify(properties[key as keyof typeof properties]) ===
                        JSON.stringify(value),
                    );
                  }
                  return true;
                });
                if (!repair)
                  throw new Error(
                    "A failed operation needs a confirmed same-tool, same-ref repair before the stage can finish.",
                  );
                failed.status = "repaired";
              }
              if (
                !stage ||
                task.ledger.some(
                  (entry) =>
                    entry.stage === task.stages.indexOf(stage) &&
                    entry.status !== "completed" &&
                    entry.status !== "repaired",
                )
              )
                throw new Error(
                  "A stage cannot complete with failed or unconfirmed operations. Inspect and repair the failed stage.",
                );
              if (!stage.operations)
                throw new Error(
                  "No native operations were confirmed for this stage; it cannot be marked complete.",
                );
              stage.completed = true;
            }
            task.recent.push(
              output(call.callId, {
                success: true,
                stages: task.stages,
                nextStage: task.stages.find((stage) => !stage.completed)?.title ?? null,
              }),
            );
          } catch (error) {
            task.recent.push(
              output(call.callId, {
                success: false,
                error: error instanceof Error ? error.message : "Stage not confirmed.",
              }),
            );
          }
          task.pending = [];
          await save();
          continue;
        }

        const stageIndex = task.stages.findIndex((stage) => !stage.completed);
        if (stageIndex < 0) {
          task.recent.push(
            ...calls.map((call) =>
              output(call.callId, {
                success: false,
                error:
                  "No active stage. Call plan_canvas_task alone before any canvas operations, or respond with completion if all stages are already confirmed. Nothing was executed.",
              }),
            ),
          );
          task.pending = [];
          await save();
          continue;
        }
        const stage = task.stages[stageIndex]!;
        for (const call of calls) {
          const prior = task.ledger.find((entry) => entry.call.callId === call.callId);
          if (prior) {
            if (JSON.stringify(prior.call.action) !== JSON.stringify(call.action))
              throw new Error("A reused call ID changed its action; execution was refused.");
            continue;
          }
          if (
            task.ledger.length >= CHAT_TASK_MAX_OPERATIONS ||
            stage.operations >= CHAT_STAGE_MAX_OPERATIONS
          )
            throw new Error(
              `Task capacity reached: ${task.ledger.length}/${CHAT_TASK_MAX_OPERATIONS} operations, stage ${stage.operations}/${CHAT_STAGE_MAX_OPERATIONS}. Confirmed work is retained; this stage needs a smaller plan.`,
            );
          task.ledger.push({
            call,
            operationId: `${task.id}-op-${task.ledger.length + 1}`,
            stage: stageIndex,
            status: "pending",
          });
          stage.operations++;
        }
        await save();
        let rateRetries = 0;
        while (true) {
          check();
          const remaining = calls
            .map((call) => task.ledger.find((entry) => entry.call.callId === call.callId)!)
            .filter((entry) => entry.status === "pending" || entry.status === "running");
          if (!remaining.length) break;
          let entries = remaining.slice(0, 3);
          const operationsFor = () =>
            entries.map(({ call, operationId }) => ({
              operationId,
              idempotencyKey: `chat:${operationId}`,
              action: call.action,
            }));
          while (
            entries.length > 1 &&
            utf8Bytes(
              JSON.stringify({
                type: "tool-execute",
                protocolVersion: 1,
                batchId: "chat-batch-placeholder",
                operations: operationsFor(),
              }),
            ) >
              48 * 1024
          )
            entries = entries.slice(0, -1);
          const batch = FigmaToolBatchSchema.parse({
            type: "tool-execute",
            protocolVersion: 1,
            batchId: "chat-batch-placeholder",
            operations: operationsFor(),
          });
          if (utf8Bytes(JSON.stringify(batch)) > 60 * 1024)
            throw new Error("One operation exceeds the safe batch byte budget; it was not sent.");
          task.starts = task.starts.filter((started) => started > now() - 60_100);
          if (task.starts.length + entries.length > 36) {
            deps.progress("Waiting for local canvas capacity; confirmed changes remain visible…");
            await wait(Math.max(1, task.starts[0]! + 60_100 - now()), deps.signal);
            continue;
          }
          entries.forEach((entry) => {
            entry.status = "running";
            task.starts.push(now());
          });
          task.batches++;
          await save();
          deps.progress(
            `Applying ${stage.title} · ${task.ledger.filter((entry) => entry.status === "completed").length} operations confirmed…`,
          );
          const result = await deps.execute(batch.operations);
          if (
            result.results.some(
              (item) => !entries.some((entry) => entry.operationId === item.operationId),
            )
          )
            throw new Error("Figma returned results for an unexpected operation; task paused.");
          if (
            new Set(result.results.map((item) => item.operationId)).size !==
              result.results.length ||
            (result.success &&
              entries.some(
                (entry) =>
                  !result.results.some(
                    (item) => item.operationId === entry.operationId && item.success,
                  ),
              ))
          )
            throw new Error(
              "Figma returned incomplete or duplicate confirmations; task paused for reconciliation.",
            );
          let limited = false;
          let failed = false;
          for (const entry of entries) {
            const item = result.results.find((item) => item.operationId === entry.operationId);
            if (!item) {
              entry.status = "pending";
              continue;
            }
            if (!item.success && /Local tool rate limit reached/u.test(item.error ?? "")) {
              entry.status = "pending";
              limited = true;
              continue;
            }
            entry.status = item.success ? "completed" : "failed";
            const payload = {
              success: item.success,
              logicalRef: item.logicalRef,
              summary: item.summary,
              error: item.error,
              data: item.data,
            };
            entry.output = JSON.stringify(payload);
            if (entry.output.length > 7_500)
              entry.output = JSON.stringify({ ...payload, data: undefined });
            failed ||= !item.success;
          }
          await save();
          check();
          if (limited) {
            if (++rateRetries > 2)
              throw new Error(
                "Local capacity is still busy. Resume after one minute; no confirmed work will be repeated.",
              );
            deps.progress(
              "Figma local rate limit reached; waiting one minute before retrying the same operation IDs…",
            );
            await wait(60_100, deps.signal);
            continue;
          }
          if (failed) {
            for (const call of calls) {
              const entry = task.ledger.find((entry) => entry.call.callId === call.callId)!;
              if (entry.status === "pending") {
                entry.status = "failed";
                entry.output = JSON.stringify({
                  success: false,
                  error:
                    "Not attempted because an earlier operation failed. Repair the dependency and issue this action again with a new call ID.",
                  operationId: entry.operationId,
                });
              }
            }
            await save();
          }
          if (failed || (!result.success && !result.cancelled))
            throw new Error(
              result.results.find((item) => !item.success)?.error ??
                "Figma did not confirm this batch. Retry reconciles the same IDs; inspect possible partial changes.",
            );
          if (result.cancelled) throw new Error("Stopped between native operations.");
        }
        const failed = calls.some(
          (call) =>
            task.ledger.find((entry) => entry.call.callId === call.callId)?.status === "failed",
        );
        if (failed && !wasRetry)
          throw new Error(
            "The current stage has a failed operation. Retry Failed Stage to inspect and repair it; earlier changes are retained.",
          );
        for (const call of calls) {
          const entry = task.ledger.find((entry) => entry.call.callId === call.callId)!;
          task.recent.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({
              ...JSON.parse(entry.output ?? "{}"),
              operationId: entry.operationId,
            }),
          });
        }
        task.pending = [];
        await save();
        continue;
      }
      check();
      const current = task.stages.find((stage) => !stage.completed);
      if (
        task.rounds >= 100 ||
        (current && current.rounds >= 8) ||
        (!task.stages.length && task.rounds >= 4)
      )
        throw new Error(
          "Stage planning budget reached. Confirmed canvas work is retained; inspect this stage before continuing.",
        );
      deps.progress(
        current
          ? `Planning ${current.title}…`
          : task.stages.length
            ? "Checking completion against Figma confirmations…"
            : "Planning bounded canvas stages…",
      );
      const input = chatTaskInput(task);
      let turn: AuthorizedChatTurn | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          turn = await deps.model(input);
          break;
        } catch (error) {
          if (
            deps.signal.aborted ||
            !(
              error &&
              typeof error === "object" &&
              "category" in error &&
              (error.category === "quota_or_rate_limit" || error.category === "inference_busy")
            ) ||
            attempt === 2
          )
            throw error;
          deps.progress("Model capacity is busy; waiting before continuing the saved stage…");
          await wait(60_100 * (attempt + 1), deps.signal);
        }
      }
      if (!turn) throw new Error("No completed model response was received.");
      check();
      task.rounds++;
      if (current) current.rounds++;
      if (turn.kind === "done") {
        task.lastResponseCalls = 0;
        if (task.stages.some((stage) => !stage.completed)) {
          task.recent = [
            {
              role: "user",
              content:
                "Continue the current unfinished stage. Do not omit any planned content or claim completion. Call complete_canvas_stage only after its canvas operations are confirmed, then execute the next stage.",
            },
          ];
          await save();
          continue;
        }
        task.text = turn.text.slice(0, 8_000);
        task.status = "completed";
        task.recent = [];
        await save();
        return;
      }
      const calls = turn.calls.map((call) => ChatFunctionCallSchema.parse(call));
      if (!calls.length || calls.length > 10)
        throw new Error("The model returned an invalid bounded stage.");
      task.pending = calls;
      task.lastResponseCalls = calls.length;
      task.recent = calls.map((call) => call.functionCall);
      await save();
    }
  } catch (error) {
    task.status = deps.signal.aborted ? "stopped" : "failed";
    task.error = deps.signal.aborted
      ? "Stopped. Confirmed canvas changes are retained. Resume reconciles in-flight IDs before continuing."
      : (error instanceof Error ? error.message : "Stage failed safely.").slice(0, 500);
    await save();
    throw error;
  }
}
