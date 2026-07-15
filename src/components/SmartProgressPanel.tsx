import { useEffect, useRef, useState } from "react";
import {
  getMonotonicProgressPercent,
  type OperationProgress
} from "../lib/progress";

const PROGRESS_TICK_MS = 150;

export function SmartProgressPanel({
  title,
  progress,
  helperText,
  className = ""
}: {
  title: string;
  progress: OperationProgress;
  helperText?: string;
  className?: string;
}) {
  const percent = useMonotonicProgressPercent(progress);
  const roundedPercent = Math.round(percent);
  const isError = progress.status === "error";
  const classes = [
    "activation-progress-panel",
    "refresh-progress-panel",
    "smart-progress-panel",
    isError ? "error" : "",
    className
  ].filter(Boolean).join(" ");

  return (
    <section className={classes} aria-live="polite">
      <div className="progress-line">
        <strong>{title}</strong>
        <span className="progress-fraction">Step {progress.current}/{progress.steps.length}</span>
      </div>
      {helperText ? <p className="progress-helper">{helperText}</p> : null}
      <p className="progress-detail">{progress.label}</p>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${title}: step ${progress.current} of ${progress.steps.length}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPercent}
      >
        <span className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {isError && progress.error ? <p className="progress-error" role="alert">{progress.error}</p> : null}
    </section>
  );
}

export function useMonotonicProgressPercent(progress: OperationProgress): number {
  const operationId = useRef(progress.operationId);
  const maximum = useRef(0);
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    if (operationId.current !== progress.operationId) {
      operationId.current = progress.operationId;
      maximum.current = 0;
    }

    const update = () => {
      maximum.current = getMonotonicProgressPercent(maximum.current, progress);
      setPercent((current) => current === maximum.current ? current : maximum.current);
    };

    update();
    if (progress.status !== "running") {
      return;
    }
    const timer = window.setInterval(update, PROGRESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [progress]);

  return percent;
}
