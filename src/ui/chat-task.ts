import {
  ChatFunctionCallSchema,
  parseResponsesFunctionCalls,
  modelPlanStages,
  CHAT_PLAN_VERSION,
  type ChatInputItem,
} from "../shared/chat-tools";
import {
  FigmaToolBatchSchema,
  INSPECT_NODES_LIMITS,
  FigmaToolOperationSchema,
  type FigmaToolOperation,
} from "../shared/figma-tools";
import { type PluginToUIMessage } from "../shared/messages";
import { utf8Bytes } from "../shared/generation-limits";
import { auditNativeSection, NativeVisualNodeSchema } from "../shared/native-visual-quality";
import {
  CHAT_STAGE_MAX_OPERATIONS,
  CHAT_TASK_MAX_OPERATIONS,
  CHAT_TASK_MAX_VALIDATION_CORRECTIONS,
  ChatTaskSchema,
  chatTaskCommittedOperationCount,
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
        ...(output ? { logicalRef: JSON.parse(output).logicalRef } : {}),
        ...("ref" in action ? { ref: action.ref } : {}),
        ...("name" in action ? { name: action.name } : {}),
        ...(status === "failed" ? { error: JSON.parse(output ?? "{}").error } : {}),
      };
    });
  const state = JSON.stringify({
    taskId: task.id,
    brief: task.brief,
    planVersion: CHAT_PLAN_VERSION,
    stages: modelPlanStages(task.stages),
    execution: {
      completedStageIndexes: task.stages.flatMap((stage, index) =>
        stage.completed ? [index] : [],
      ),
      activeStageIndex: task.stages.findIndex((stage) => !stage.completed),
    },
    confirmed,
    referencePolicy:
      "Creation refs are task-local aliases. Repeated creation of a confirmed alias reuses its node without applying new styling. Use set_properties for edits. For follow-up edits use the exact logicalRef returned by inspect_nodes or earlier results; never guess an alias from another task. Inspect selection when ownership is uncertain.",
  });
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
    ...(task.validationFeedback
      ? [{ role: "user" as const, content: task.validationFeedback }]
      : []),
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
      input = [
        ...task.context,
        { role: "user", content: task.prompt },
        ...summaries,
        ...(task.validationFeedback
          ? [{ role: "user" as const, content: task.validationFeedback }]
          : []),
        ...compact,
      ];
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
  const knownRef = (ref: string): string => {
    const entry = task.ledger.find(
      (item) =>
        item.status === "completed" &&
        "ref" in item.call.action &&
        item.call.action.ref === ref &&
        item.output,
    );
    const logicalRef: unknown = entry?.output ? JSON.parse(entry.output).logicalRef : undefined;
    return typeof logicalRef === "string" ? logicalRef : ref;
  };
  const check = () => {
    if (deps.signal.aborted) throw new Error("Stopped");
  };
  const guardRepeatedFailure = (signature: string) => {
    signature = signature.slice(0, 2_000);
    const progress =
      chatTaskCommittedOperationCount(task) + task.stages.filter((stage) => stage.completed).length;
    if (task.lastFailureSignature === signature && task.lastFailureProgress === progress)
      throw new Error(
        `no_progress_repeated_error: ${signature.slice(0, 260)}. The same failure repeated without a new canvas commit or completed stage. Inspect the safe diagnostic; automatic correction stopped.`,
      );
    task.lastFailureSignature = signature;
    task.lastFailureProgress = progress;
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
  if (task.status === "failed") {
    const stage = task.stages.find((item) => !item.completed);
    if (stage) {
      stage.qaAttempts = 0;
      stage.verified = false;
    }
  }
  task.status = "running";
  delete task.error;
  delete task.failure;
  await save();
  try {
    while (true) {
      check();
      if (task.pending.length) {
        const calls = task.pending;
        if (
          calls.some((call) => call.action.tool === "get_document_context") &&
          calls.length !== 1
        ) {
          task.recent.push(
            ...calls.map((call) =>
              output(call.callId, {
                success: false,
                error:
                  "Read document context alone before requesting more context or planning changes.",
              }),
            ),
          );
          task.pending = [];
          await save();
          continue;
        }
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
            if (action.tool === "plan_canvas_task" && task.stages.length)
              guardRepeatedFailure("planning:plan_already_saved");
            if (action.tool === "plan_canvas_task") {
              if (
                !task.ledger.some(
                  (entry) =>
                    entry.call.action.tool === "get_document_context" &&
                    entry.status === "completed",
                )
              )
                throw new Error(
                  "Read the current document context and local styles before proposing a canvas plan. No canvas changes were made.",
                );
              if (!task.stages.length) {
                task.brief = action.brief;
                task.stages = action.stages.map((planned) => ({
                  ...planned,
                  completed: false,
                  operations: 0,
                  rounds: 0,
                  qaAttempts: 0,
                  verificationOperations: 0,
                  verified: false,
                }));
              }
            } else if (action.tool === "complete_canvas_stage") {
              const stage = task.stages.find((item) => !item.completed);
              const stageIndex = stage ? task.stages.indexOf(stage) : -1;
              for (const operationId of action.resolvedOperationIds) {
                const failedIndex = task.ledger.findIndex(
                  (entry) => entry.operationId === operationId && entry.status === "failed",
                );
                const failed = task.ledger[failedIndex];
                if (!failed || !stage || failed.stage !== stageIndex)
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
                    (!("ref" in repairAction) ||
                      knownRef(repairAction.ref) !== knownRef(failedAction.ref))
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
                    entry.stage === stageIndex &&
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
              if (!stage.verified) {
                if (stage.qaAttempts >= 3)
                  throw new Error(
                    "Structural quality still fails after three bounded checks. Retry the failed stage after reviewing its findings.",
                  );
                const attempt = stage.qaAttempts + 1;
                const verificationNumber = stage.verificationOperations + 1;
                const refs = stage.logicalRefs.length
                  ? stage.logicalRefs
                  : task.ledger
                      .filter((entry) => entry.stage === stageIndex && "ref" in entry.call.action)
                      .map((entry) => ("ref" in entry.call.action ? entry.call.action.ref : ""))
                      .filter(Boolean)
                      .slice(0, 20);
                const inspection = parseResponsesFunctionCalls([
                  {
                    type: "function_call",
                    call_id: `${task.id}_qa_${stageIndex + 1}_${verificationNumber}`,
                    name: "inspect_nodes",
                    arguments: JSON.stringify({ refs, selection: false, depth: 4, maxNodes: 25 }),
                  },
                ])[0]!;
                let inspectionEntry = task.ledger.find(
                  (entry) =>
                    entry.stage === stageIndex &&
                    entry.call.action.tool === "inspect_nodes" &&
                    (entry.status === "pending" || entry.status === "running"),
                );
                if (!inspectionEntry) {
                  if (
                    task.ledger.length >= CHAT_TASK_MAX_OPERATIONS ||
                    stage.operations + stage.verificationOperations >= CHAT_STAGE_MAX_OPERATIONS ||
                    !refs.length
                  )
                    throw new Error(
                      "No bounded logical refs are available for required stage verification; committed work remains. Inspect or retry the stage.",
                    );
                  inspectionEntry = {
                    call: inspection,
                    operationId: `${task.id}-qa-${stageIndex + 1}-${verificationNumber}`,
                    stage: stageIndex,
                    status: "pending",
                  };
                  task.ledger.push(inspectionEntry);
                  stage.qaAttempts = attempt;
                  stage.verificationOperations++;
                }
                const inspectionOperation = FigmaToolOperationSchema.parse({
                  operationId: inspectionEntry.operationId,
                  idempotencyKey: `chat:${inspectionEntry.operationId}`,
                  ...(task.referenceScope ? { taskId: task.id } : {}),
                  action: inspection.action,
                });
                let inspectionResult: Result;
                let result: Result["results"][number] | undefined;
                let rateRetries = 0;
                while (true) {
                  check();
                  task.starts = task.starts.filter((started) => started > now() - 60_100);
                  if (task.starts.length >= 36) {
                    deps.progress(
                      "Waiting for local canvas capacity; committed changes remain visible…",
                    );
                    await wait(Math.max(1, task.starts[0]! + 60_100 - now()), deps.signal);
                    continue;
                  }
                  if (task.batches >= 1_000)
                    throw new Error(
                      "The saved batch limit was reached before section verification.",
                    );
                  inspectionEntry.status = "running";
                  task.starts.push(now());
                  task.batches++;
                  await save();
                  deps.progress(`Reviewing ${stage.title} geometry and editable layers…`);
                  inspectionResult = await deps.execute([inspectionOperation]);
                  result =
                    inspectionResult.results.length === 1 &&
                    inspectionResult.results[0]!.operationId === inspectionEntry.operationId
                      ? inspectionResult.results[0]
                      : undefined;
                  if (
                    !inspectionResult.success &&
                    result &&
                    !result.success &&
                    /Local tool rate limit reached/u.test(result.error ?? "")
                  ) {
                    inspectionEntry.status = "pending";
                    await save();
                    if (++rateRetries > 2)
                      throw new Error(
                        "Local capacity is still busy. Resume after one minute; no confirmed work will be repeated.",
                      );
                    deps.progress(
                      "Figma local rate limit reached; waiting one minute before retrying the same verification ID…",
                    );
                    await wait(60_100, deps.signal);
                    continue;
                  }
                  break;
                }
                if (!inspectionResult.success || !result?.success) {
                  inspectionEntry.status = "failed";
                  inspectionEntry.output = JSON.stringify({
                    success: false,
                    error: result?.error ?? "Figma did not confirm the section inspection.",
                  });
                  await save();
                  throw new Error(
                    result?.error ??
                      "Figma did not confirm the section inspection; committed changes remain.",
                  );
                }
                const parsedNodes = NativeVisualNodeSchema.array()
                  .max(25)
                  .safeParse(result.data?.nodes);
                if (!parsedNodes.success) {
                  inspectionEntry.status = "failed";
                  inspectionEntry.output = JSON.stringify({
                    success: false,
                    error: "The bounded inspection returned invalid geometry data.",
                  });
                  await save();
                  throw new Error(
                    "The bounded section inspection returned invalid geometry; committed changes remain.",
                  );
                }
                const verifiedRefs = refs.map(knownRef);
                const findings = auditNativeSection(parsedNodes.data, verifiedRefs);
                inspectionEntry.status = "completed";
                inspectionEntry.output = JSON.stringify({
                  success: true,
                  inspectedNodes: parsedNodes.data.length,
                  findingCount: findings.length,
                  findings: findings.slice(0, 12),
                });
                if (findings.length) {
                  stage.verified = false;
                  task.recent.push(
                    output(call.callId, {
                      success: false,
                      stage: stage.title,
                      inspectedNodes: parsedNodes.data.length,
                      qualityFindings: findings
                        .slice(0, 12)
                        .map(({ code, ref, message }) => ({ code, ref, message })),
                      instruction:
                        "Repair only the listed existing logical refs. Do not recreate the stage. After corrections request complete_canvas_stage again.",
                    }),
                  );
                  task.pending = [];
                  await save();
                  continue;
                }
                stage.verified = true;
              }
              stage.completed = true;
            }
            task.recent.push(
              output(call.callId, {
                success: true,
                ...(call.normalizedPlanningMetadata
                  ? {
                      normalization:
                        "planning_runtime_metadata_ignored; runtime state is locally initialized",
                    }
                  : {}),
                planVersion: CHAT_PLAN_VERSION,
                stages: modelPlanStages(task.stages),
                instruction:
                  "The plan is saved. Do not replan. Execute only the next unfinished stage using native tools.",
                nextStage: task.stages.find((stage) => !stage.completed)?.title ?? null,
              }),
            );
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("no_progress_repeated_error"))
              throw error;
            guardRepeatedFailure(
              `planning:${error instanceof Error ? error.message : "stage_not_confirmed"}`,
            );
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
        const prePlanReadOnly =
          stageIndex < 0 &&
          calls.every(
            (call) =>
              call.action.tool === "get_document_context" || call.action.tool === "inspect_nodes",
          );
        if (stageIndex < 0 && !prePlanReadOnly) {
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
        const stage = stageIndex >= 0 ? task.stages[stageIndex] : undefined;
        const newCalls = calls.filter(
          (call) => !task.ledger.some((entry) => entry.call.callId === call.callId),
        );
        if (
          task.ledger.length + newCalls.length > CHAT_TASK_MAX_OPERATIONS ||
          (stage &&
            stage.operations + stage.verificationOperations + newCalls.length >=
              CHAT_STAGE_MAX_OPERATIONS)
        )
          throw new Error(
            `Task capacity reached: ${task.ledger.length}/${CHAT_TASK_MAX_OPERATIONS} operations${stage ? `, stage ${stage.operations + stage.verificationOperations}/${CHAT_STAGE_MAX_OPERATIONS} including reserved verification` : " during pre-plan inspection"}. Confirmed work is retained; this stage needs a smaller plan.`,
          );
        for (const call of calls) {
          const prior = task.ledger.find((entry) => entry.call.callId === call.callId);
          if (prior) {
            if (JSON.stringify(prior.call.action) !== JSON.stringify(call.action))
              throw new Error("A reused call ID changed its action; execution was refused.");
            continue;
          }
          task.ledger.push({
            call,
            operationId: `${task.id}-op-${task.ledger.length + 1}`,
            stage: Math.max(0, stageIndex),
            status: "pending",
          });
          if (stage) stage.operations++;
        }
        await save();
        let rateRetries = 0;
        let referenceCorrection = false;
        while (true) {
          check();
          const remaining = calls
            .map((call) => task.ledger.find((entry) => entry.call.callId === call.callId)!)
            .filter((entry) => entry.status === "pending" || entry.status === "running");
          if (!remaining.length) break;
          let entries = remaining.slice(0, 3);
          const operationsFor = () =>
            entries.map(({ call, operationId }) => {
              const ref = "ref" in call.action ? call.action.ref : undefined;
              const original =
                ref &&
                ["create_frame", "create_text", "create_rectangle"].includes(call.action.tool)
                  ? task.ledger.find(
                      (entry) =>
                        entry.operationId !== operationId &&
                        entry.status === "completed" &&
                        !entry.reused &&
                        "ref" in entry.call.action &&
                        entry.call.action.ref === ref &&
                        ["create_frame", "create_text", "create_rectangle"].includes(
                          entry.call.action.tool,
                        ),
                    )
                  : undefined;
              return {
                operationId,
                idempotencyKey: `chat:${operationId}`,
                ...(task.referenceScope ? { taskId: task.id } : {}),
                ...(original ? { expectedCreationOperationId: original.operationId } : {}),
                action: call.action,
              };
            });
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
            `${stage ? `Applying ${stage.title}` : "Reading document styles and page context"} · ${chatTaskCommittedOperationCount(task)} canvas operations confirmed…`,
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
            if (item.data?.reused === true) entry.reused = true;
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
          if (!failed && !limited) delete task.failure;
          await save();
          check();
          if (limited) {
            task.failure = {
              category: "rate_limit",
              code: "local_tool_rate_limit",
              committedOperations: chatTaskCommittedOperationCount(task),
              operationId: entries[0]!.operationId,
            };
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
            const failedResult = result.results.find((item) => !item.success);
            task.failure = {
              category: failedResult?.data?.referenceResolution
                ? "ambiguous_recovery"
                : /rate limit/iu.test(failedResult?.error ?? "")
                  ? "rate_limit"
                  : /timed out/iu.test(failedResult?.error ?? "")
                    ? "timeout"
                    : /interrupted|reconcil|unconfirmed/iu.test(failedResult?.error ?? "")
                      ? "ambiguous_recovery"
                      : result.committedOperationIds.length || chatTaskCommittedOperationCount(task)
                        ? "partial_commit"
                        : /invalid|safety limit|must be unique|does not support|can only|requires|must use/iu.test(
                              failedResult?.error ?? "",
                            )
                          ? "executor_validation"
                          : "figma_runtime",
              code: failedResult?.data?.referenceResolution
                ? "reference_resolution"
                : "native_operation_failed",
              committedOperations: chatTaskCommittedOperationCount(task),
              ...(failedResult ? { operationId: failedResult.operationId } : {}),
            };
            task.failure.code = {
              ambiguous_recovery: "inspection_required",
              rate_limit: "local_tool_rate_limit",
              timeout: "native_operation_timeout",
              partial_commit: "native_batch_partial_commit",
              executor_validation: "executor_contract_rejected",
              figma_runtime: "native_api_failed",
              planning: "planning_failed",
              model_schema: "tool_arguments_invalid",
            }[task.failure.category];
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
          if (
            failed &&
            task.referenceCorrections < 2 &&
            result.results.some((item) => item.data?.referenceResolution)
          ) {
            guardRepeatedFailure(
              `reference:${JSON.stringify(result.results.flatMap((item) => (item.data?.referenceResolution ? [item.data.referenceResolution] : [])))}`,
            );
            task.referenceCorrections++;
            referenceCorrection = true;
            await save();
            break;
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
        if (failed && !wasRetry && !referenceCorrection)
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
              ...(call.normalizedInspectionParameters && call.action.tool === "inspect_nodes"
                ? {
                    normalization: {
                      maxNodes: call.action.maxNodes,
                      depth: call.action.depth,
                      note: "Read-only inspection bounds were clamped locally; the 25-node exposure limit is unchanged.",
                    },
                  }
                : {}),
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
      if (turn.kind === "tool_validation") {
        const inspectionIssues = turn.issues.flatMap((issue) => {
          if (issue.toolName !== "inspect_nodes" || !issue.callId) return [];
          const field = issue.fieldPaths.includes("arguments.maxNodes")
            ? ("maxNodes" as const)
            : issue.fieldPaths.includes("arguments.depth")
              ? ("depth" as const)
              : undefined;
          if (!field) return [];
          const allowedErrorCodes = [
            "too_big",
            "too_small",
            "invalid_type",
            "invalid_format",
            "custom",
            "schema_validation",
          ] as const;
          const errorCode = allowedErrorCodes.includes(
            issue.errorCode as (typeof allowedErrorCodes)[number],
          )
            ? (issue.errorCode as (typeof allowedErrorCodes)[number])
            : "schema_validation";
          return [
            {
              callId: issue.callId,
              field,
              errorCode,
              ...(issue.receivedType ? { receivedType: issue.receivedType } : {}),
              ...(issue.receivedNumber ? { receivedNumber: issue.receivedNumber } : {}),
            },
          ];
        });
        task.failure = {
          category: "model_schema",
          code: "tool_arguments_invalid",
          committedOperations: chatTaskCommittedOperationCount(task),
          ...(inspectionIssues.length ? { inspectionIssues: inspectionIssues.slice(0, 8) } : {}),
        };
        guardRepeatedFailure(
          `model_schema:${JSON.stringify(turn.issues.map(({ toolName, stage, errorCode, fieldPaths }) => ({ toolName, stage, errorCode, fieldPaths })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))}`,
        );
        const details = turn.issues
          .slice(0, 8)
          .map((issue) => {
            const inspectionField =
              issue.toolName === "inspect_nodes"
                ? issue.fieldPaths.find(
                    (path) => path === "arguments.maxNodes" || path === "arguments.depth",
                  )
                : undefined;
            if (inspectionField) {
              const isMaxNodes = inspectionField === "arguments.maxNodes";
              const parameter = isMaxNodes ? "maxNodes" : "depth";
              const bounds = isMaxNodes
                ? INSPECT_NODES_LIMITS.maxNodes
                : INSPECT_NODES_LIMITS.depth;
              const received = issue.receivedType
                ? ` Received type ${issue.receivedType}${issue.receivedNumber ? ` (${issue.receivedNumber})` : ""}; no type conversion is performed.`
                : "";
              return `inspect_nodes${issue.callId ? ` (${issue.callId})` : ""}: arguments.${parameter} must be an integer from ${bounds.min}–${bounds.max} (omitted defaults to ${bounds.default}); finite numeric values outside that range are clamped locally, while invalid types and in-range fractions are rejected.${received}`;
            }
            return `${issue.toolName ?? "unknown tool"}${issue.callId ? ` (${issue.callId})` : ""}: ${issue.stage}/${issue.errorCode} at ${issue.fieldPaths
              .slice(0, 4)
              .map((path) => path.slice(0, 100))
              .join(", ")}`;
          })
          .join("; ");
        task.lastResponseCalls = 0;
        if (task.validationCorrections >= CHAT_TASK_MAX_VALIDATION_CORRECTIONS)
          throw new Error(
            `The model returned invalid canvas calls after ${CHAT_TASK_MAX_VALIDATION_CORRECTIONS} targeted corrections (${details.slice(0, 220)}). No calls from the rejected response were executed; ${retainedCanvasChanges(task)}.`,
          );
        task.validationCorrections++;
        task.validationFeedback =
          `The entire previous tool-call response was discarded before execution. Correct the listed fields and continue only the current unfinished stage from the saved checkpoint. Never regenerate a completed stage or repeat an operation already recorded as committed. Validation details: ${details}`.slice(
            0,
            7_500,
          );
        deps.progress(
          `Rejected model tool call${turn.issues.length === 1 ? "" : "s"} (${turn.issues
            .slice(0, 3)
            .map(
              ({ toolName, fieldPaths }) =>
                `${toolName ?? "unknown"}: ${fieldPaths[0] ?? "arguments"}`,
            )
            .join(
              "; ",
            )}); none from this response executed. ${retainedCanvasChanges(task)} Requesting a bounded correction…`,
        );
        await save();
        continue;
      }
      if (turn.kind === "done") {
        delete task.validationFeedback;
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
        delete task.failure;
        task.recent = [];
        await save();
        return;
      }
      delete task.validationFeedback;
      delete task.failure;
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
    const transportCategory =
      error && typeof error === "object" && "category" in error ? String(error.category) : "";
    task.failure ??= {
      category:
        transportCategory === "quota_or_rate_limit" || transportCategory === "inference_busy"
          ? "rate_limit"
          : transportCategory === "request_timed_out" || /timed out|timeout/iu.test(task.error)
            ? "timeout"
            : transportCategory === "response_invalid"
              ? "model_schema"
              : /validation|Zod|bounded stage|invalid request/iu.test(task.error)
                ? "executor_validation"
                : /interrupted|reconcil|Lost.*result|Lost.*acknowledgement/iu.test(task.error)
                  ? "ambiguous_recovery"
                  : "planning",
      code: /^[a-z_]{1,80}$/u.test(transportCategory)
        ? transportCategory
        : task.error.startsWith("no_progress_repeated_error")
          ? "no_progress_repeated_error"
          : task.error.startsWith("Stage planning budget reached")
            ? "planning_budget_exhausted"
            : "task_paused",
      committedOperations: chatTaskCommittedOperationCount(task),
    };
    if (task.error.startsWith("no_progress_repeated_error"))
      task.failure.code = "no_progress_repeated_error";
    await save();
    throw error;
  }
}

function retainedCanvasChanges(task: ChatTask): string {
  const count = chatTaskCommittedOperationCount(task);
  return count
    ? `${count} previously committed canvas operation${count === 1 ? " is" : "s are"} retained.`
    : "No canvas operations were committed before this response.";
}
