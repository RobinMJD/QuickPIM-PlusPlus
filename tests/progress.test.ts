import { describe, expect, test } from "vitest";
import {
  advanceOperationProgress,
  completeOperationProgress,
  createOperationProgress,
  failOperationProgress,
  getMonotonicProgressPercent,
  getOperationProgressPercent,
  getProgressStepRange,
  type ProgressStepDefinition
} from "../src/lib/progress";

const STEPS: readonly ProgressStepDefinition[] = [
  { id: "local", label: "Reading local state", weight: 1, expectedDurationMs: 1_000 },
  { id: "network", label: "Fetching data", weight: 7, expectedDurationMs: 7_000 },
  { id: "save", label: "Saving data", weight: 2, expectedDurationMs: 2_000 }
];

describe("weighted operation progress", () => {
  test("uses proportional step ranges instead of equal step slices", () => {
    expect(getProgressStepRange(STEPS, 1)).toEqual({ start: 0, end: 10 });
    expect(getProgressStepRange(STEPS, 2)).toEqual({ start: 10, end: 80 });
    expect(getProgressStepRange(STEPS, 3)).toEqual({ start: 80, end: 100 });
  });

  test("moves through a step until its boundary and waits there", () => {
    const progress = createOperationProgress("refresh-1", STEPS, { now: 1_000 });
    expect(getOperationProgressPercent(progress, 1_000)).toBe(0);
    expect(getOperationProgressPercent(progress, 1_500)).toBe(5);
    expect(getOperationProgressPercent(progress, 2_000)).toBe(10);
    expect(getOperationProgressPercent(progress, 9_000)).toBe(10);
  });

  test("jumps to the next weighted boundary when a step finishes early", () => {
    const initial = createOperationProgress("refresh-2", STEPS, { now: 1_000 });
    const next = advanceOperationProgress(initial, 2, { now: 1_250 });
    expect(getOperationProgressPercent(next, 1_250)).toBe(10);
  });

  test("never moves backward when a live operation adopts a different weighted plan", () => {
    const initial = createOperationProgress("refresh-2b", STEPS, { current: 2, now: 1_000 });
    const previousPercent = getOperationProgressPercent(initial, 5_000);
    const expandedPlan: readonly ProgressStepDefinition[] = [
      STEPS[0],
      { id: "access", label: "Recovering access", weight: 20, expectedDurationMs: 20_000 },
      STEPS[1],
      STEPS[2]
    ];
    const replanned = advanceOperationProgress(initial, 2, { steps: expandedPlan, now: 5_000 });
    expect(getOperationProgressPercent(replanned, 5_000)).toBeLessThan(previousPercent);
    expect(getMonotonicProgressPercent(previousPercent, replanned, 5_000)).toBe(previousPercent);
  });

  test("preserves the current step and percentage basis on failure", () => {
    const initial = createOperationProgress("refresh-3", STEPS, { current: 2, now: 1_000 });
    const failed = failOperationProgress(initial, "Network unavailable", "Refresh stopped");
    expect(failed.current).toBe(2);
    expect(failed.label).toBe("Refresh stopped");
    expect(failed.error).toBe("Network unavailable");
    expect(getOperationProgressPercent(failed, 4_500)).toBe(45);
  });

  test("only reports 100 percent after real completion", () => {
    const finalStep = createOperationProgress("refresh-4", STEPS, { current: 3, now: 1_000 });
    expect(getOperationProgressPercent(finalStep, 2_000)).toBe(89.5);
    expect(getOperationProgressPercent(finalStep, 10_000)).toBe(99);
    expect(getOperationProgressPercent(completeOperationProgress(finalStep), 2_000)).toBe(100);
  });
});
