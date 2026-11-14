import type { CompanionModel, CompanionStatus } from "./companion-client";
import type { InferenceEligibility } from "./inference-eligibility";

type ModelDiscoveryState = "idle" | "loading" | "loaded" | "empty" | "error";

export const MODEL_CATALOG_TTL_MS = 15 * 60 * 1_000;

export function modelCatalogIsFresh(loadedAt: number | null, now = Date.now()): boolean {
  return loadedAt !== null && Number.isFinite(loadedAt) && now - loadedAt < MODEL_CATALOG_TTL_MS;
}

export type ModelReadinessPhase =
  | "disconnected"
  | "connecting"
  | "authentication_required"
  | "discovering_models"
  | "model_selection_required"
  | "model_unavailable"
  | "awaiting_test_consent"
  | "verifying"
  | "ready"
  | "retryable_error"
  | "blocked";

export function shouldAutomaticallyDiscoverModels(input: {
  connected: boolean;
  status: CompanionStatus | null;
  preferenceLoaded: boolean;
  discovery: ModelDiscoveryState;
}): boolean {
  return (
    input.connected &&
    input.preferenceLoaded &&
    input.discovery === "idle" &&
    input.status?.planUseAuthorized === true &&
    (input.status.auth === "scope_granted" || input.status.auth === "ready")
  );
}

export function modelReadinessPhase(input: {
  connected: boolean;
  status: CompanionStatus | null;
  discovery: ModelDiscoveryState;
  models: CompanionModel[];
  selectedModel: string;
  smokeInFlight: boolean;
  eligibility: InferenceEligibility;
}): ModelReadinessPhase {
  if (!input.connected) return "disconnected";
  if (!input.status) return "connecting";
  if (!input.status.planUseAuthorized) {
    return input.status.auth === "session_expired" || input.status.auth === "blocked"
      ? "blocked"
      : "authentication_required";
  }
  if (input.discovery === "loading" || input.discovery === "idle") return "discovering_models";
  if (input.discovery === "error") return "retryable_error";
  if (input.discovery === "empty") return "model_unavailable";
  if (!input.selectedModel) return "model_selection_required";
  if (!input.models.some(({ slug }) => slug === input.selectedModel)) return "model_unavailable";
  if (input.eligibility.eligible) return "ready";
  if (input.smokeInFlight) return "verifying";
  if (input.status.auth !== "scope_granted" && input.status.auth !== "ready") return "blocked";
  return "awaiting_test_consent";
}

interface Flight<T> {
  key: string;
  revision: number;
  epoch: number;
  controller: AbortController;
  promise: Promise<ReadinessOperationResult<T>>;
}

export interface ReadinessOperationResult<T> {
  current: boolean;
  value?: T;
  error?: unknown;
}

/** Keeps account/model-scoped readiness requests single-flight and fences stale results. */
export class ModelReadinessRequests {
  private epoch = 0;
  private catalogRevision = 0;
  private smokeRevision = 0;
  private catalogFlight: Flight<unknown> | null = null;
  private smokeFlight: Flight<unknown> | null = null;

  invalidate(): void {
    this.epoch += 1;
    this.catalogRevision += 1;
    this.smokeRevision += 1;
    this.catalogFlight?.controller.abort();
    this.smokeFlight?.controller.abort();
    this.catalogFlight = null;
    this.smokeFlight = null;
  }

  cancelSmoke(): void {
    this.smokeRevision += 1;
    this.smokeFlight?.controller.abort();
    this.smokeFlight = null;
  }

  isRunning(kind: "catalog" | "smoke", key: string): boolean {
    const flight = kind === "catalog" ? this.catalogFlight : this.smokeFlight;
    return flight?.key === key && !flight.controller.signal.aborted;
  }

  runCatalog<T>(
    key: string,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<ReadinessOperationResult<T>> {
    return this.run("catalog", key, execute);
  }

  runSmoke<T>(
    key: string,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<ReadinessOperationResult<T>> {
    return this.run("smoke", key, execute);
  }

  private run<T>(
    kind: "catalog" | "smoke",
    key: string,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<ReadinessOperationResult<T>> {
    const revisionField = kind === "catalog" ? "catalogRevision" : "smokeRevision";
    const flightField = kind === "catalog" ? "catalogFlight" : "smokeFlight";
    const existing = this[flightField] as Flight<T> | null;
    if (existing?.key === key) return existing.promise;
    existing?.controller.abort();

    const revision = ++this[revisionField];
    const epoch = this.epoch;
    const controller = new AbortController();
    const flight: Flight<T> = {
      key,
      revision,
      epoch,
      controller,
      promise: Promise.resolve({ current: false }),
    };
    this[flightField] = flight as Flight<unknown>;
    flight.promise = (async () => {
      try {
        const value = await execute(controller.signal);
        const latest = this[flightField] as Flight<T> | null;
        return {
          current:
            !controller.signal.aborted &&
            this.epoch === epoch &&
            latest === flight &&
            latest.revision === revision,
          value,
        };
      } catch (error) {
        const latest = this[flightField] as Flight<T> | null;
        return {
          current:
            !controller.signal.aborted &&
            this.epoch === epoch &&
            latest === flight &&
            latest.revision === revision,
          error,
        };
      } finally {
        if (this[flightField] === flight) this[flightField] = null;
      }
    })();
    return flight.promise;
  }
}

export class ModelReadinessConsent {
  private decisions = new Map<string, "accepted" | "declined">();
  private attempts = new Map<string, number>();

  shouldPrompt(scope: string): boolean {
    if (this.decisions.has(scope)) return false;
    this.decisions.set(scope, "declined");
    return true;
  }

  accept(scope: string): void {
    this.decisions.set(scope, "accepted");
  }

  decline(scope: string): void {
    this.decisions.set(scope, "declined");
  }

  beginSmoke(scope: string): number {
    const attempt = (this.attempts.get(scope) ?? 0) + 1;
    this.attempts.set(scope, attempt);
    return attempt;
  }

  canOfferOneRetry(scope: string): boolean {
    return this.attempts.get(scope) === 1;
  }

  attemptCount(scope: string): number {
    return this.attempts.get(scope) ?? 0;
  }

  clear(): void {
    this.decisions.clear();
    this.attempts.clear();
  }
}
