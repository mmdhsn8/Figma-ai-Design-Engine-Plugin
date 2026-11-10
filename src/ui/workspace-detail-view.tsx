import { useState, type ReactNode } from "react";
import {
  chatTaskLedgerCategory,
  chatTaskProgress,
  chatTaskRetryLabel,
  mutationAccounting,
  type ChatTask,
} from "../shared/chat-task";
import type { PluginView } from "./workspace-routes";
import {
  chatTaskDiagnosticJson,
  copyDiagnosticJson,
  downloadDiagnosticJson,
} from "./diagnostic-export";
import {
  GenerationProgressView,
  TaskNativeDetailView,
  taskStageDisplayStates,
} from "./task-workspace-view";

const unavailable: Partial<Record<PluginView, { title: string; eyebrow: string; detail: string }>> =
  {
    "brand-kit": {
      title: "Brand Kit",
      eyebrow: "BRAND WORKSPACE",
      detail:
        "Brand Kit creation, editing, and generation integration are not available in this Phase A build. No brand selection is being applied to generation.",
    },
    "brand-kit-create": {
      title: "Create Brand Kit",
      eyebrow: "BRAND WORKSPACE",
      detail:
        "Brand Kit persistence and validation are scheduled for a later implementation phase. No kit has been created.",
    },
    skills: {
      title: "Skills Manager",
      eyebrow: "LOCAL GUIDANCE",
      detail:
        "SKILL.md import, trust controls, and generation integration are not available in this Phase A build. No skill text is loaded or executed.",
    },
    "skill-detail": {
      title: "Skill Details",
      eyebrow: "LOCAL GUIDANCE",
      detail: "There are no imported skills to inspect in this build.",
    },
    "skill-add": {
      title: "Add a Skill",
      eyebrow: "LOCAL GUIDANCE",
      detail:
        "Local SKILL.md parsing and import are scheduled for a later implementation phase. No file is read or executed here.",
    },
  };

function RouteShell({
  title,
  eyebrow,
  description,
  onNavigate,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  onNavigate: (view: PluginView) => void;
  children: ReactNode;
}) {
  return (
    <section className="route-page detail-page" aria-labelledby="route-heading">
      <button className="text-button route-back" type="button" onClick={() => onNavigate("more")}>
        ‹ More
      </button>
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">{eyebrow}</span>
          <h1 id="route-heading" tabIndex={-1}>
            {title}
          </h1>
          <p className="page-description">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function ActivityTaskDetails({
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
  onNavigate: (view: PluginView) => void;
}) {
  const [diagnosticMessage, setDiagnosticMessage] = useState("");
  const stages = taskStageDisplayStates(task, isRunning);
  const accounting = mutationAccounting(task.ledger);
  const recovery = isRunning
    ? "Execution is active in this plugin session. Stop waits for the bounded native operation to settle."
    : task.status === "running"
      ? "This checkpoint was last saved during execution. No native operation is active now; resume reconciles in-flight operation IDs before continuing."
      : task.status === "stopped"
        ? "The task was stopped. Confirmed native changes remain on the canvas; resume continues from the saved checkpoint."
        : task.status === "failed"
          ? "Inspect the failed stage and its safe diagnostic before retrying. Confirmed native changes are retained."
          : task.status === "completed"
            ? "All planned stages were confirmed complete. Continue editing from AI Chat if needed."
            : "The task is saved and can be resumed when model access is available.";

  return (
    <>
      <article className="detail-summary-card">
        <span className={`history-state is-${isRunning ? "running" : task.status}`}>
          {isRunning
            ? "Active in this session"
            : task.status === "running"
              ? "Awaiting recovery"
              : task.status}
        </span>
        <strong>{chatTaskProgress(task)}</strong>
        <small>
          {accounting.confirmedMutations} confirmed · {accounting.attemptedMutations} attempted ·{" "}
          {accounting.rejectedMutations} rejected · {accounting.ambiguousMutations} ambiguous
        </small>
      </article>

      <section className="route-card activity-recovery-card">
        <h2>Recovery status</h2>
        <p>{recovery}</p>
        {task.failure && (
          <small>
            Failure category: {task.failure.category.replaceAll("_", " ")} · {task.failure.code}
            {task.failure.operationId ? ` · operation ${task.failure.operationId}` : ""}
          </small>
        )}
        <div className="task-progress-actions">
          {isRunning ? (
            <button className="danger-action" type="button" onClick={onStop}>
              Stop generation
            </button>
          ) : task.status !== "completed" ? (
            <button
              className="primary-action"
              type="button"
              disabled={!canResume}
              onClick={onResume}
            >
              {chatTaskRetryLabel(task)}
            </button>
          ) : null}
          <button className="text-button" type="button" onClick={() => onNavigate("chat")}>
            Open AI Chat
          </button>
        </div>
      </section>

      <section className="route-card">
        <h2>Stage lifecycle</h2>
        {stages.length ? (
          <ol className="operation-timeline">
            {stages.map((stage) => (
              <li key={`${stage.index}-${stage.title}`}>
                <span className={`timeline-dot is-${stage.state}`} aria-hidden="true" />
                <span>
                  <strong>{stage.title}</strong>
                  <small>
                    Stage {stage.index + 1} · {stage.state.replaceAll("_", " ")} · {stage.confirmed}{" "}
                    confirmed native mutation(s)
                  </small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No planned stage lifecycle has been saved.</p>
        )}
      </section>

      <section className="route-card">
        <h2>Native execution &amp; verification</h2>
        {task.ledger.length ? (
          <ol className="operation-timeline">
            {task.ledger.slice(-60).map((entry, index) => {
              const category = chatTaskLedgerCategory(entry);
              const confirmed =
                category === "mutation" && mutationAccounting([entry]).confirmedMutations > 0;
              return (
                <li key={`${entry.operationId}-${index}`}>
                  <span className={`timeline-dot is-${entry.status}`} aria-hidden="true" />
                  <span>
                    <strong>
                      {category === "verification"
                        ? "Native verification"
                        : category === "read_only"
                          ? "Read-only native inspection"
                          : "Native mutation"}
                      {` · ${entry.call.action.tool.replaceAll("_", " ")}`}
                    </strong>
                    <small>
                      Stage {entry.stage + 1} · {entry.status}
                      {confirmed ? " · confirmed on canvas" : ""}
                      {entry.acknowledgementStatus
                        ? ` · ${entry.acknowledgementStatus.replaceAll("_", " ")}`
                        : ""}
                      {` · ${entry.operationId}`}
                    </small>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p>No native execution or verification operation has been recorded.</p>
        )}
      </section>

      <section className="route-card diagnostic-actions-card">
        <h2>Safe diagnostics</h2>
        <p>
          Exports include task lifecycle and sanitized operation accounting, never prompts,
          credentials, or raw model responses.
        </p>
        <div className="diagnostic-action-row">
          <button
            className="secondary-action"
            type="button"
            onClick={() => {
              void copyDiagnosticJson(chatTaskDiagnosticJson(task))
                .then(() => setDiagnosticMessage("Sanitized diagnostic copied."))
                .catch((error: unknown) =>
                  setDiagnosticMessage(
                    error instanceof Error
                      ? error.message
                      : "Copy failed; download the JSON instead.",
                  ),
                );
            }}
          >
            Copy sanitized diagnostic
          </button>
          <button
            className="secondary-action"
            type="button"
            onClick={() => {
              try {
                downloadDiagnosticJson(
                  chatTaskDiagnosticJson(task),
                  `figma-ai-diagnostic-${task.id.replace(/[^A-Za-z0-9_-]/gu, "_")}.json`,
                );
                setDiagnosticMessage("Sanitized diagnostic download started.");
              } catch (error) {
                setDiagnosticMessage(
                  error instanceof Error ? error.message : "Diagnostic download failed.",
                );
              }
            }}
          >
            Download JSON
          </button>
        </div>
        {diagnosticMessage && (
          <p className="route-status" role="status">
            {diagnosticMessage}
          </p>
        )}
        <details className="advanced-task-details">
          <summary>Advanced sanitized diagnostic</summary>
          <pre>{chatTaskDiagnosticJson(task)}</pre>
        </details>
      </section>
    </>
  );
}

export function WorkspaceDetailView({
  view,
  task,
  isRunning = false,
  canResume = false,
  onStop = () => undefined,
  onResume = () => undefined,
  onNavigate,
}: {
  view: PluginView;
  task: ChatTask | null;
  isRunning?: boolean;
  canResume?: boolean;
  onStop?: () => void;
  onResume?: () => void;
  onNavigate: (view: PluginView) => void;
}) {
  const unavailableView = unavailable[view];
  if (unavailableView) {
    return (
      <RouteShell
        title={unavailableView.title}
        eyebrow={unavailableView.eyebrow}
        description={unavailableView.detail}
        onNavigate={onNavigate}
      >
        <div className="capability-state" role="status">
          <span className="capability-icon" aria-hidden="true">
            ✦
          </span>
          <strong>Not available yet</strong>
          <p>
            This route is intentionally explicit; it does not show a fake form or report a
            successful action.
          </p>
          {view === "brand-kit" && (
            <button
              className="secondary-action"
              type="button"
              onClick={() => onNavigate("brand-kit-create")}
            >
              Create Brand Kit
            </button>
          )}
          {view === "skills" && (
            <button
              className="secondary-action"
              type="button"
              onClick={() => onNavigate("skill-add")}
            >
              Add local SKILL.md
            </button>
          )}
          {view === "skills" && (
            <button
              className="text-button"
              type="button"
              onClick={() => onNavigate("skill-detail")}
            >
              Skill details
            </button>
          )}
          <button className="text-button" type="button" onClick={() => onNavigate("home")}>
            Back to Home
          </button>
        </div>
      </RouteShell>
    );
  }

  if (view === "progress" || view === "results" || view === "layers" || view === "activity") {
    const title =
      view === "progress"
        ? "Generation Progress"
        : view === "results"
          ? "Result & Preview"
          : view === "layers"
            ? "Layers & Structure"
            : "Activity & Diagnostics";
    const eyebrow =
      view === "progress"
        ? "TASK EXECUTION"
        : view === "results"
          ? "VERIFIED NATIVE OUTPUT"
          : view === "layers"
            ? "TASK-OWNED FIGMA NODES"
            : "SAFE TASK TIMELINE";
    const description =
      view === "progress"
        ? "Follow saved task stages and confirmed native work. Progress uses real checkpoint data, not an estimated percentage."
        : view === "results"
          ? "Review native screens verified on the active Figma page. The canvas remains the actual design preview."
          : view === "layers"
            ? "Inspect the read-only native hierarchy created by this task, without exposing unrelated document layers."
            : "Review stage lifecycle, native execution, verification, and safe recovery information.";
    return (
      <RouteShell title={title} eyebrow={eyebrow} description={description} onNavigate={onNavigate}>
        {task ? (
          view === "progress" ? (
            <GenerationProgressView
              task={task}
              isRunning={isRunning}
              canResume={canResume}
              onStop={onStop}
              onResume={onResume}
              onNavigate={onNavigate}
            />
          ) : view === "results" || view === "layers" ? (
            <TaskNativeDetailView
              view={view}
              task={task}
              isRunning={isRunning}
              onNavigate={onNavigate}
            />
          ) : (
            <ActivityTaskDetails
              task={task}
              isRunning={isRunning}
              canResume={canResume}
              onStop={onStop}
              onResume={onResume}
              onNavigate={onNavigate}
            />
          )
        ) : (
          <div className="capability-state">
            <strong>No task data for this chat</strong>
            <p>Start a chat to see real stages and confirmed native changes here.</p>
            <button className="secondary-action" type="button" onClick={() => onNavigate("chat")}>
              Open AI Chat
            </button>
          </div>
        )}
      </RouteShell>
    );
  }

  if (view === "help" || view === "about") {
    const about = view === "about";
    return (
      <RouteShell
        title={about ? "About" : "Help & Guide"}
        eyebrow={about ? "FIGMA PLUGIN" : "SAFE NATIVE WORKFLOW"}
        description={
          about ? "Figma AI Design Engine" : "A short guide to the existing design workflows."
        }
        onNavigate={onNavigate}
      >
        <div className="route-card help-card">
          {about ? (
            <p>
              Structured, editable design workflows for Figma. Model access uses the existing local
              companion and explicit account authorization.
            </p>
          ) : (
            <ul>
              <li>
                Use AI Chat for authenticated, validated native edits; JSON generation remains
                available offline.
              </li>
              <li>Stop and resume reconcile uncertain operation IDs before retrying.</li>
              <li>
                Deleting a chat removes its local metadata and checkpoint only; Figma canvas nodes
                remain untouched.
              </li>
              <li>
                Persian prompts are supported. Canvas text direction is selected from the prompt and
                design data.
              </li>
            </ul>
          )}
          <button className="secondary-action" type="button" onClick={() => onNavigate("home")}>
            Back to Home
          </button>
        </div>
      </RouteShell>
    );
  }

  return null;
}
