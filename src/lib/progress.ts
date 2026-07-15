export type OperationProgressStatus = "running" | "complete" | "error";

export interface ProgressStepDefinition {
  id: string;
  label: string;
  weight: number;
  expectedDurationMs: number;
}

export interface OperationProgress {
  operationId: string;
  steps: readonly ProgressStepDefinition[];
  current: number;
  label: string;
  stepStartedAt: number;
  status: OperationProgressStatus;
  error?: string;
}

export interface ProgressStepRange {
  start: number;
  end: number;
}

const MIN_STEP_DURATION_MS = 100;

export function createOperationProgress(
  operationId: string,
  steps: readonly ProgressStepDefinition[],
  options: { current?: number; label?: string; now?: number } = {}
): OperationProgress {
  if (!steps.length) {
    throw new Error("A progress operation requires at least one step.");
  }
  const current = clampStep(options.current ?? 1, steps.length);
  return {
    operationId,
    steps,
    current,
    label: options.label || steps[current - 1].label,
    stepStartedAt: options.now ?? Date.now(),
    status: "running"
  };
}

export function advanceOperationProgress(
  progress: OperationProgress,
  current: number,
  options: {
    label?: string;
    steps?: readonly ProgressStepDefinition[];
    now?: number;
  } = {}
): OperationProgress {
  const steps = options.steps || progress.steps;
  if (!steps.length) {
    return progress;
  }
  const nextCurrent = clampStep(current, steps.length);
  const stepChanged = nextCurrent !== progress.current;
  return {
    ...progress,
    steps,
    current: nextCurrent,
    label: options.label || steps[nextCurrent - 1].label,
    stepStartedAt: stepChanged ? options.now ?? Date.now() : progress.stepStartedAt,
    status: "running",
    error: undefined
  };
}

export function completeOperationProgress(
  progress: OperationProgress,
  label = progress.steps[progress.steps.length - 1].label,
  now = Date.now()
): OperationProgress {
  return {
    ...progress,
    current: progress.steps.length,
    label,
    stepStartedAt: progress.current === progress.steps.length ? progress.stepStartedAt : now,
    status: "complete",
    error: undefined
  };
}

export function failOperationProgress(
  progress: OperationProgress,
  error: string,
  label = progress.label
): OperationProgress {
  return {
    ...progress,
    label,
    status: "error",
    error
  };
}

export function getProgressStepRange(
  steps: readonly ProgressStepDefinition[],
  current: number
): ProgressStepRange {
  if (!steps.length) {
    return { start: 0, end: 100 };
  }
  const normalizedWeights = steps.map((step) => normalizeWeight(step.weight));
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  const stepIndex = clampStep(current, steps.length) - 1;
  const completedWeight = normalizedWeights.slice(0, stepIndex).reduce((sum, weight) => sum + weight, 0);
  const currentWeight = normalizedWeights[stepIndex];
  return {
    start: (completedWeight / totalWeight) * 100,
    end: ((completedWeight + currentWeight) / totalWeight) * 100
  };
}

export function getOperationProgressPercent(progress: OperationProgress, now = Date.now()): number {
  if (progress.status === "complete") {
    return 100;
  }
  const range = getProgressStepRange(progress.steps, progress.current);
  const step = progress.steps[clampStep(progress.current, progress.steps.length) - 1];
  const stepEnd = progress.current === progress.steps.length ? Math.min(99, range.end) : range.end;
  const expectedDurationMs = Math.max(MIN_STEP_DURATION_MS, finiteOr(step.expectedDurationMs, MIN_STEP_DURATION_MS));
  const elapsedMs = Math.max(0, now - progress.stepStartedAt);
  const elapsedRatio = Math.min(1, elapsedMs / expectedDurationMs);
  return range.start + (stepEnd - range.start) * elapsedRatio;
}

export function getMonotonicProgressPercent(
  previousPercent: number,
  progress: OperationProgress,
  now = Date.now()
): number {
  return Math.min(100, Math.max(previousPercent, getOperationProgressPercent(progress, now)));
}

function normalizeWeight(value: number): number {
  return Math.max(Number.EPSILON, finiteOr(value, 1));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clampStep(current: number, total: number): number {
  return Math.min(total, Math.max(1, Math.trunc(current) || 1));
}
