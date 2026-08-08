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
  className = "",
  onDismiss
}: {
  title: string;
  progress: OperationProgress;
  helperText?: string;
  className?: string;
  onDismiss?: () => void;
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
    <section className={classes} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} aria-atomic="true">
      <div className="progress-line">
        <strong>{title}</strong>
        <span className="progress-status-actions">
          <span className="progress-fraction">Step {progress.current}/{progress.steps.length}</span>
          {isError && onDismiss ? (
            <button className="message-dismiss-button" type="button" onClick={onDismiss} title="Dismiss error" aria-label="Dismiss error">
              <DismissIcon />
            </button>
          ) : null}
        </span>
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

function DismissIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
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
