import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  chatTaskCommittedOperationCount,
  mutationAccounting,
  chatTaskRetryLabel,
  type ChatTask,
} from "../shared/chat-task";
import type { PluginToUIMessage } from "../shared/messages";
import { taskNativeBridge } from "./task-native-bridge";
import { chatTaskDiagnosticJson } from "./diagnostic-export";

type NativeInspection = Extract<PluginToUIMessage, { type: "task-native-inspection-result" }>;
type NativeNode = NonNullable<NativeInspection["nodes"]>[number];
type TaskDetailView = "results" | "layers";

function taskRequestId(): string {
  return `task-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function taskLogicalRefs(task: ChatTask): string[] {
  const refs = task.stages.flatMap((stage) => stage.logicalRefs);
  for (const entry of task.ledger) {
    const action = entry.call.action;
    if ("ref" in action && typeof action.ref === "string") refs.push(action.ref);
    if ("refs" in action) refs.push(...action.refs);
    if ("childRef" in action) refs.push(action.childRef);
    if ("parentRef" in action) refs.push(action.parentRef);
  }
  return [...new Set(refs)].slice(0, 500);
}

export type TaskStageDisplayState =
  "completed" | "active" | "pending" | "failed" | "paused" | "recovery";

export function taskStageDisplayStates(
  task: ChatTask,
  isRunning: boolean,
): Array<{ index: number; title: string; state: TaskStageDisplayState; confirmed: number }> {
  const incomplete = task.stages.findIndex((stage) => !stage.completed);
  const failureStage = task.failure?.operationId
    ? task.ledger.find((entry) => entry.operationId === task.failure?.operationId)?.stage
    : undefined;
  const current = failureStage ?? incomplete;
  return task.stages.map((stage, index) => {
    let state: TaskStageDisplayState = stage.completed ? "completed" : "pending";
    if (!stage.completed && task.status === "failed" && index === current) state = "failed";
    else if (!stage.completed && task.status === "stopped" && index === current) state = "paused";
    else if (!stage.completed && task.status === "running" && index === current)
      state = isRunning ? "active" : "recovery";
    return {
      index,
      title: stage.title,
      state,
      confirmed: mutationAccounting(task.ledger.filter((entry) => entry.stage === index))
        .confirmedMutations,
    };
  });
}

export function taskResultStatus(
  task: ChatTask,
  verifiedScreenCount: number,
  isRunning: boolean,
): string {
  if (task.status === "completed")
    return verifiedScreenCount
      ? "Task completed · native screen frames found"
      : "Task completed · no current screen frame verified";
  if (task.status === "failed")
    return verifiedScreenCount
      ? "Partial result · generation failed"
      : "Generation failed · no verified native frame";
  if (task.status === "stopped")
    return verifiedScreenCount
      ? "Partial result · generation stopped"
      : "Generation stopped · no verified native frame";
  if (task.status === "running")
    return isRunning
      ? "Generation active · completion not confirmed"
      : "Checkpoint saved · recovery required";
  return "Task prepared · generation not confirmed";
}

export function GenerationProgressView({
  task,
  isRunning,
  canResume,
  onStop,
  onResume,
  onNavigate,
}: {
  task: ChatTask;
  isRunning: boolean;
  canResume: boolean;
  onStop: () => void;
  onResume: () => void;
  onNavigate: (view: "chat" | "results" | "layers" | "activity") => void;
}) {
  const stages = taskStageDisplayStates(task, isRunning);
  const currentStage = stages.find(({ state }) => state !== "completed");
  const currentOperation = task.ledger.find((entry) => entry.status === "running");
  const confirmed = chatTaskCommittedOperationCount(task);
  const stageLabel = (state: TaskStageDisplayState) =>
    ({
      completed: "Completed",
      active: "Active",
      pending: "Pending",
      failed: "Failed",
      paused: "Stopped",
      recovery: "Awaiting recovery",
    })[state];

  return (
    <>
      <article className="detail-summary-card progress-summary">
        <span
          className={`history-state is-${isRunning ? "running" : task.status === "running" ? "stopped" : task.status}`}
        >
          {isRunning
            ? "Running in this session"
            : task.status === "running"
              ? "Saved checkpoint · recovery needed"
              : task.status}
        </span>
        <strong>
          {currentStage
            ? `Current stage · ${currentStage.title}`
            : task.status === "failed"
              ? "Task failed after the last planned stage"
              : "All planned stages complete"}
        </strong>
        {currentStage && <small>Separate screen name: not provided in the saved task plan.</small>}
        <small>
          {stages.filter(({ state }) => state === "completed").length}/{stages.length} stages
          completed · {confirmed} confirmed native mutations
        </small>
        {currentOperation && isRunning && (
          <small>
            Current native operation · {currentOperation.call.action.tool.replaceAll("_", " ")}
          </small>
        )}
      </article>

      <section className="route-card progress-card" aria-label="Generation progress">
        <div className="section-title-row">
          <h2>Task progress</h2>
          <span className="section-caption">REAL CHECKPOINT DATA</span>
        </div>
        <div
          className={`indeterminate-progress ${isRunning ? "is-active" : ""}`}
          role="progressbar"
          aria-label="Generation progress"
          aria-valuetext={`${stages.filter(({ state }) => state === "completed").length} of ${stages.length} stages completed; ${confirmed} native mutations confirmed`}
        >
          <span />
        </div>
        <p className="honest-capability-note">
          No reliable time or percentage estimate is available. Progress is shown as verified stage
          and native-operation counts.
        </p>
        {stages.length ? (
          <ol className="progress-stage-list">
            {stages.map((stage) => (
              <li
                className={`progress-stage is-${stage.state}`}
                key={`${stage.index}-${stage.title}`}
              >
                <span className="stage-mark" aria-hidden="true">
                  {stage.state === "completed"
                    ? "✓"
                    : stage.state === "active"
                      ? "◌"
                      : stage.state === "failed"
                        ? "!"
                        : "·"}
                </span>
                <span className="progress-stage-copy">
                  <strong>{stage.title}</strong>
                  <small>
                    {stageLabel(stage.state)} · {stage.confirmed} native mutation
                    {stage.confirmed === 1 ? "" : "s"} confirmed
                  </small>
                </span>
                <span className={`history-state is-${stage.state}`}>{stageLabel(stage.state)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="route-status">No stage plan has been saved yet.</p>
        )}
      </section>

      {task.status === "running" && !isRunning && (
        <p className="recovery-note" role="status">
          The last checkpoint was saved while execution was active, but no native operation is
          running in this plugin session. Resume to reconcile in-flight operation IDs before work
          continues.
        </p>
      )}
      {task.failure && (
        <section className="route-card task-failure-card" role="alert">
          <h2>{task.status === "failed" ? "Stage needs recovery" : "Saved failure details"}</h2>
          <p>
            {task.failure.category.replaceAll("_", " ")} · {task.failure.code.replaceAll("_", " ")}{" "}
            · {task.failure.committedOperations} committed native operation(s).
          </p>
          <small>Confirmed canvas work is retained. Inspect the task before retrying.</small>
        </section>
      )}

      <div className="task-detail-links">
        <button type="button" className="text-button" onClick={() => onNavigate("results")}>
          Results
        </button>
        <button type="button" className="text-button" onClick={() => onNavigate("layers")}>
          Layers &amp; Structure
        </button>
        <button type="button" className="text-button" onClick={() => onNavigate("activity")}>
          Activity &amp; Diagnostics
        </button>
        <button type="button" className="text-button" onClick={() => onNavigate("chat")}>
          Continue in AI Chat
        </button>
      </div>

      <details className="route-card advanced-task-details">
        <summary>Advanced task diagnostic</summary>
        <p>
          Sanitized checkpoint diagnostic; prompts, credentials and raw model responses are omitted.
        </p>
        <pre>{chatTaskDiagnosticJson(task)}</pre>
      </details>

      <div className="task-progress-actions">
        {isRunning ? (
          <button className="danger-action" type="button" onClick={onStop}>
            Stop generation
          </button>
        ) : task.status !== "completed" ? (
          <button className="primary-action" type="button" disabled={!canResume} onClick={onResume}>
            {chatTaskRetryLabel(task)}
          </button>
        ) : null}
      </div>
    </>
  );
}

function formatDimension(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

function TaskLayerTree({
  nodes,
  onFocus,
  focusBusy,
}: {
  nodes: NativeNode[];
  onFocus: (nodeId: string) => void;
  focusBusy: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const nodeIds = useMemo(() => new Set(nodes.map(({ id }) => id)), [nodes]);
  const children = useMemo(() => {
    const map = new Map<string, NativeNode[]>();
    for (const node of nodes) {
      if (!node.parentId || !nodeIds.has(node.parentId)) continue;
      const siblings = map.get(node.parentId) ?? [];
      siblings.push(node);
      map.set(node.parentId, siblings);
    }
    return map;
  }, [nodeIds, nodes]);
  const roots = nodes.filter((node) => !node.parentId || !nodeIds.has(node.parentId));
  const renderNode = (node: NativeNode, depth: number): ReactNode => {
    const nested = children.get(node.id) ?? [];
    const open = expanded.has(node.id);
    const hasLayout = node.layoutMode && node.layoutMode !== "NONE";
    return (
      <li
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={nested.length ? open : undefined}
        key={node.id}
      >
        <div className="native-layer-row">
          {nested.length ? (
            <button
              type="button"
              className="layer-tree-toggle"
              aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
              aria-expanded={open}
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              {open ? "⌄" : "›"}
            </button>
          ) : (
            <span className="layer-tree-spacer" aria-hidden="true" />
          )}
          <span className="native-node-type">{node.type.replaceAll("_", " ").toLowerCase()}</span>
          <span className="native-node-name" title={node.name}>
            {node.name || "Untitled layer"}
          </span>
          <small className="native-node-size">
            {formatDimension(node.width)} × {formatDimension(node.height)}
          </small>
          <button
            className="text-button native-select-button"
            type="button"
            disabled={focusBusy}
            onClick={() => onFocus(node.id)}
          >
            Select in Figma
          </button>
        </div>
        {hasLayout && (
          <small className="native-layout-meta">
            {node.layoutMode?.toLowerCase()} auto layout
            {node.itemSpacing !== undefined ? ` · ${formatDimension(node.itemSpacing)} px gap` : ""}
            {node.padding
              ? ` · padding ${formatDimension(node.padding.top)}/${formatDimension(node.padding.right)}/${formatDimension(node.padding.bottom)}/${formatDimension(node.padding.left)}`
              : ""}
            {node.primaryAxisSizingMode
              ? ` · primary ${node.primaryAxisSizingMode.toLowerCase()}`
              : ""}
            {node.counterAxisSizingMode
              ? ` · counter ${node.counterAxisSizingMode.toLowerCase()}`
              : ""}
          </small>
        )}
        {open && nested.length > 0 && (
          <ul role="group" className="native-layer-children">
            {nested.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className="native-layer-tree" role="tree" aria-label="Task-owned native Figma layers">
      {roots.map((node) => renderNode(node, 0))}
    </ul>
  );
}

export function TaskNativeDetailView({
  view,
  task,
  isRunning,
  onNavigate,
}: {
  view: TaskDetailView;
  task: ChatTask;
  isRunning: boolean;
  onNavigate: (view: "chat" | "activity" | "layers") => void;
}) {
  const [inspection, setInspection] = useState<NativeInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusMessage, setFocusMessage] = useState("");
  const refs = useMemo(() => taskLogicalRefs(task), [task]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setRefreshError("");
    try {
      const result = await taskNativeBridge({
        type: "task-native-inspect",
        requestId: taskRequestId(),
        documentId: task.documentId,
        taskId: task.id,
        refs,
      });
      if (result.type !== "task-native-inspection-result" || result.taskId !== task.id)
        throw new Error("Figma returned a mismatched task-layer response.");
      setInspection(result);
    } catch (error) {
      setInspection(null);
      setRefreshError(
        error instanceof Error ? error.message : "Task-owned layers could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, [refs, task.documentId, task.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh, task.ledger.length, task.status]);

  const focusNodes = async (nodeIds: string[], mode: "select" | "zoom") => {
    setFocusBusy(true);
    setFocusMessage("");
    try {
      const result = await taskNativeBridge({
        type: "task-native-focus",
        requestId: taskRequestId(),
        documentId: task.documentId,
        taskId: task.id,
        nodeIds,
        mode,
      });
      if (result.type !== "task-native-focus-result")
        throw new Error("Figma returned an unexpected layer-focus response.");
      setFocusMessage(
        mode === "select"
          ? "Task-owned layer selected and focused in Figma."
          : "Figma viewport zoomed to the verified task screens; selection was not changed.",
      );
    } catch (error) {
      setFocusMessage(
        error instanceof Error ? error.message : "The task layer could not be focused.",
      );
    } finally {
      setFocusBusy(false);
    }
  };

  const nodes = inspection?.nodes ?? [];
  const roots = nodes.filter(
    (node) => !node.parentId || !nodes.some(({ id }) => id === node.parentId),
  );
  const screenFrames = roots.filter((node) => node.type === "FRAME" || node.type === "COMPONENT");
  const unresolved = inspection?.unresolvedRefs ?? [];
  const isResults = view === "results";
  const resultStatus = taskResultStatus(task, screenFrames.length, isRunning);

  return (
    <>
      <article className="detail-summary-card">
        <span
          className={`history-state is-${isRunning ? "running" : task.status === "running" ? "stopped" : task.status}`}
        >
          {resultStatus}
        </span>
        <strong>{chatTaskCommittedOperationCount(task)} native mutations confirmed</strong>
        <small>
          {inspection
            ? `${nodes.length} task-owned native layer${nodes.length === 1 ? "" : "s"} verified on the active Figma page`
            : "Native layer verification has not completed"}
        </small>
      </article>

      {isResults ? (
        <>
          <section className="route-card task-screen-results">
            <div className="section-title-row">
              <h2>Generated screens</h2>
              <button
                className="text-button"
                type="button"
                disabled={loading}
                onClick={() => void refresh()}
              >
                {loading ? "Refreshing…" : "Refresh from Figma"}
              </button>
            </div>
            {loading && !inspection ? (
              <p role="status">Reading task-owned native layers…</p>
            ) : refreshError ? (
              <p className="route-status" role="alert">
                {refreshError}
              </p>
            ) : screenFrames.length ? (
              <>
                {screenFrames.length > 1 && (
                  <button
                    className="primary-action"
                    type="button"
                    disabled={focusBusy}
                    onClick={() =>
                      void focusNodes(
                        screenFrames.map(({ id }) => id),
                        "zoom",
                      )
                    }
                  >
                    Zoom to generated screens
                  </button>
                )}
                <ul className="result-screen-list">
                  {screenFrames.map((screen) => (
                    <li key={screen.id}>
                      <span className="result-screen-icon" aria-hidden="true">
                        ▧
                      </span>
                      <span className="result-screen-copy">
                        <strong>{screen.name || "Untitled frame"}</strong>
                        <small>
                          {formatDimension(screen.width)} × {formatDimension(screen.height)} px ·
                          Native Figma {screen.type.toLowerCase()}
                        </small>
                        <small>
                          {screen.ref &&
                          task.stages.some(
                            (stage) =>
                              stage.logicalRefs.includes(screen.ref!) &&
                              stage.completed &&
                              stage.verified,
                          )
                            ? "Task stage native verification confirmed"
                            : "Frame found on canvas · screen completion is not confirmed"}
                        </small>
                      </span>
                      <button
                        className="secondary-action"
                        type="button"
                        disabled={focusBusy}
                        onClick={() => void focusNodes([screen.id], "select")}
                      >
                        Select in Figma
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : inspection ? (
              <div className="capability-state compact-capability-state">
                <strong>No screen-level frame has been verified</strong>
                <p>
                  Any confirmed native layers remain visible in the Layers view; no screen is
                  reported as complete without native verification.
                </p>
                {nodes.length > 0 && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onNavigate("layers")}
                  >
                    Inspect native layers
                  </button>
                )}
              </div>
            ) : null}
            {inspection?.truncated && (
              <p className="honest-capability-note">
                Showing the first 500 task-owned layers. Refresh after narrowing the task if more
                are needed.
              </p>
            )}
          </section>
          <p className="honest-capability-note">
            The Figma canvas is the authoritative preview. This view lists only native frames that
            were found on the active page and tagged to this task; it does not create a raster
            mockup.
          </p>
        </>
      ) : (
        <section className="route-card task-layers-card">
          <div className="section-title-row">
            <h2>Native layer hierarchy</h2>
            <button
              className="text-button"
              type="button"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <p className="route-caption">
            Task-owned native nodes only · inspection does not edit the canvas.
          </p>
          {loading && !inspection ? (
            <p role="status">Reading task-owned native layers…</p>
          ) : refreshError ? (
            <p className="route-status" role="alert">
              {refreshError}
            </p>
          ) : nodes.length ? (
            <TaskLayerTree
              nodes={nodes}
              focusBusy={focusBusy}
              onFocus={(nodeId) => void focusNodes([nodeId], "select")}
            />
          ) : inspection ? (
            <div className="capability-state compact-capability-state">
              <strong>No task-owned native layers found</strong>
              <p>
                No nodes are created by inspection. Resume or inspect a task with confirmed native
                output.
              </p>
            </div>
          ) : null}
          {inspection?.truncated && (
            <p className="honest-capability-note">
              The hierarchy is limited to the first 500 task-owned native layers.
            </p>
          )}
          {unresolved.length > 0 && (
            <section className="unresolved-ref-list" aria-labelledby="unresolved-refs-heading">
              <h3 id="unresolved-refs-heading">Missing or stale task references</h3>
              <ul>
                {unresolved.map(({ ref, status }) => (
                  <li key={`${ref}-${status}`}>
                    <code>{ref}</code>
                    <span>{status.replaceAll("_", " ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      )}
      {focusMessage && (
        <p className="route-status" role="status">
          {focusMessage}
        </p>
      )}
      <div className="task-detail-links">
        <button type="button" className="text-button" onClick={() => onNavigate("activity")}>
          Open task details
        </button>
        <button type="button" className="text-button" onClick={() => onNavigate("chat")}>
          Continue editing in AI Chat
        </button>
      </div>
    </>
  );
}
