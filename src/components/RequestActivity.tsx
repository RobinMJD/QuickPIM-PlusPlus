import { useCallback, useEffect, useRef, useState } from "react";
import { sanitizeErrorMessage } from "../lib/security";
import { formatLoadMessages } from "../lib/popupModel";
import { loadRequestOperations, requestOperationMatchesIdentity, REQUEST_OPERATIONS_LOCAL_KEY } from "../lib/requestOperations";
import { loadTrackedRequests, REQUEST_TRACKING_KEY } from "../lib/requestTracking";
import { getRequestActivitySummary, getRequestItemProgress } from "../lib/requestActivity";
import { formatExtensionDuration } from "../lib/requestExtension";
import { sendRuntimeMessage } from "../lib/runtimeMessaging";
import type { RequestOperationRecord, TrackedPimRequest } from "../lib/types";

export function useRequestActivity() {
  const [operations, setOperations] = useState<RequestOperationRecord[]>([]);
  const [tracked, setTracked] = useState<TrackedPimRequest[]>([]);
  const [error, setError] = useState("");
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    let disposed = false;
    let reading: Promise<void> | undefined;
    let again = false;
    const read = (): Promise<void> => {
      if (reading) { again = true; return reading; }
      reading = Promise.all([loadRequestOperations(), loadTrackedRequests()]).then(([next, store]) => {
        if (!disposed) { setOperations(next); setTracked(store.requests); }
      }).catch(() => { if (!disposed) setError("Request status is temporarily unavailable. Your submitted work continues in the background."); })
        .finally(() => { reading = undefined; if (again && !disposed) { again = false; void read(); } });
      return reading;
    };
    reloadRef.current = read;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes[REQUEST_OPERATIONS_LOCAL_KEY] || changes[REQUEST_TRACKING_KEY])) void read();
    };
    chrome.storage.onChanged?.addListener(changed);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await sendRuntimeMessage({ action: "getRequestOperations" }, { timeoutMs: 4_000 });
        if (!disposed) setError("");
      } catch { if (!disposed) setError("Request status is temporarily unavailable. Your submitted work continues in the background."); }
      if (!disposed) { await read(); timer = setTimeout(() => void poll(), 3_000); }
    };
    void read();
    void poll();
    return () => { disposed = true; clearTimeout(timer); chrome.storage.onChanged?.removeListener(changed); };
  }, []);
  return { operations, tracked, error, reload };
}

export function RequestActivity({ operations, tracked, error, identity = {}, onDismiss, onOpenAccess }: {
  operations: RequestOperationRecord[]; tracked: TrackedPimRequest[]; error?: string;
  identity?: { tenantId?: string; principalId?: string };
  onDismiss?: (id: string) => Promise<void>;
  onOpenAccess?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState("");
  const visible = operations.filter((operation) => requestOperationMatchesIdentity(operation, identity));
  if (!visible.length) return null;
  const summary = getRequestActivitySummary(visible, tracked);
  const pending = visible.some((operation) => operation.items?.some((item) => getRequestItemProgress(operation, item, tracked).pending));
  return <section className={`request-activity${expanded ? " is-expanded" : ""}${pending ? " has-pending" : ""}`} aria-label="Requests">
    <div className="request-activity-heading">
      <span role="status" aria-live="polite">{error ? "Request status temporarily unavailable" : summary}</span>
      <button className="btn subtle" aria-expanded={expanded} aria-controls="request-activity-details" onClick={() => setExpanded((current) => !current)}>{expanded ? "Hide requests" : "View requests"}</button>
    </div>
    {pending ? <div className="request-activity-progress" role="progressbar" aria-label="Request progress" aria-valuetext={error ? "Request status temporarily unavailable" : summary}><span /></div> : null}
    {expanded ? <div className="request-activity-details" id="request-activity-details">
      <p className="muted">You can close this popup or start another request. Submitted requests keep their original parameters.</p>
      {error || actionError ? <p role="status">{actionError || error}</p> : null}
      {visible.map((operation) => {
        const progress = (operation.items || []).map((item) => getRequestItemProgress(operation, item, tracked));
        const canDismiss = ["complete", "error"].includes(operation.state) && !progress.some((item) => item.pending || item.label.startsWith("Outcome unknown") || item.label === "Status unavailable");
        const verb = operation.kind === "extension" ? "Extend" : operation.action === "activate" ? "Activate" : "Deactivate";
        return <article className="request-activity-card" key={operation.id} aria-label={`${verb} ${operation.bundleName || operation.items?.[0]?.itemName || "request"}`}>
          <strong>{verb}{operation.bundleName ? ` bundle ${operation.bundleName}` : ""}{operation.itemIds.length > 1 ? ` · ${operation.itemIds.length} items` : ""}</strong>
          <time dateTime={new Date(operation.startedAt).toISOString()}>{new Date(operation.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <ul>{operation.items?.map((item, index) => <li key={item.itemId}>
            <span><strong>{item.itemName}</strong><span className="muted"> · {item.scopeLabel || "Scope unavailable"}{operation.durationHours ? ` · ${formatExtensionDuration(operation.durationHours)}` : ""}</span></span>
            <span className={progress[index].attention ? "request-attention" : "muted"}>{progress[index].label}</span>
          </li>)}</ul>
          <details><summary>Parameters and result</summary><dl>
            <dt>Tenant</dt><dd>{operation.tenantId || "Unavailable"}</dd>
            <dt>Account ID</dt><dd>{operation.principalId || "Unavailable"}</dd>
            {operation.scheduledStartAt ? <><dt>Starts</dt><dd>{new Date(operation.scheduledStartAt).toLocaleString()}</dd></> : null}
            {operation.justification ? <><dt>Justification</dt><dd>{operation.justification}</dd></> : null}
            {operation.ticketInfo?.ticketNumber ? <><dt>Ticket</dt><dd>{operation.ticketInfo.ticketSystem} · {operation.ticketInfo.ticketNumber}</dd></> : null}
            {operation.waitingForAccess ? <><dt>Resume before</dt><dd>{new Date(operation.startedAt + 15 * 60_000).toLocaleTimeString()}</dd></> : null}
            <dt>Operation ID</dt><dd>{operation.id}</dd>
          </dl>
          {operation.error ? <p>{operation.error}</p> : null}
          {operation.items?.map((item) => <div key={item.itemId}>
            {item.requestId ? <p>{item.itemName}: Microsoft request {item.requestId}</p> : null}
            {item.scopeId ? <p>{item.itemName}: scope {item.scopeId}{item.accessId ? ` · ${item.accessId}` : ""}</p> : null}
            {item.error || item.result?.error ? <p className="request-attention">{item.itemName}: {formatLoadMessages([sanitizeErrorMessage(item.error || item.result?.error)])[0]}</p> : null}
          </div>)}
          </details>
          {progress.some((item) => item.attention) && onOpenAccess ? <button className="btn subtle" onClick={onOpenAccess}>Access details</button> : null}
          {canDismiss && onDismiss ? <button className="btn subtle" onClick={() => void onDismiss(operation.id).catch(() => setActionError("Could not dismiss this result. Try again."))}>Dismiss result</button> : null}
        </article>;
      })}
    </div> : null}
  </section>;
}
