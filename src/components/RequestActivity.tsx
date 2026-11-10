import { useCallback, useEffect, useRef, useState } from "react";
import { sanitizeErrorMessage } from "../lib/security";
import { formatLoadMessages } from "../lib/popupModel";
import { loadRequestOperations, markRequestOperationResultsSeen, requestOperationMatchesIdentity, REQUEST_OPERATIONS_LOCAL_KEY } from "../lib/requestOperations";
import { loadTrackedRequests, REQUEST_TRACKING_KEY } from "../lib/requestTracking";
import { getRequestActivitySummary, getRequestResultVisibleUntil, getRequestItemProgress, isRequestOperationFinished, shouldShowPopupRequest } from "../lib/requestActivity";
import { formatExtensionDuration } from "../lib/requestExtension";
import type { RequestProgressResolver } from "../lib/requestActivity";
import { sendRuntimeMessage } from "../lib/runtimeMessaging";
import type { RequestOperationRecord, TrackedPimRequest } from "../lib/types";

export function useRequestActivity() {
  const [operations, setOperations] = useState<RequestOperationRecord[]>([]);
  const [tracked, setTracked] = useState<TrackedPimRequest[]>([]);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now);
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const retryRef = useRef<() => Promise<void>>(async () => undefined);
  const reload = useCallback(() => reloadRef.current(), []);
  const retry = useCallback(() => retryRef.current(), []);
  useEffect(() => {
    let disposed = false, storageFailed = false, runtimeFailed = false;
    let reading: Promise<void> | undefined, polling: Promise<void> | undefined;
    let again = false;
    let fastPolling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const updateError = () => { if (!disposed) setError(storageFailed || runtimeFailed
      ? "Request status is temporarily unavailable. Your submitted work continues in the background." : ""); };
    const read = (): Promise<void> => {
      if (reading) { again = true; return reading; }
      reading = Promise.all([loadRequestOperations(), loadTrackedRequests()]).then(([next, store]) => {
        if (!disposed) {
          setOperations((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
          setTracked((current) => JSON.stringify(current) === JSON.stringify(store.requests) ? current : store.requests);
          const now = Date.now();
          const needsClock = next.some((operation) => !isRequestOperationFinished(operation, store.requests)
            || getRequestResultVisibleUntil(operation, store.requests) > now - 50_000);
          if (needsClock && !fastPolling && !polling) {
            clearTimeout(timer);
            timer = setTimeout(() => void poll(), 3_000);
          }
          if (needsClock || fastPolling) setClock(now);
          fastPolling = needsClock;
          storageFailed = false; updateError();
        }
      }).catch(() => { storageFailed = true; updateError(); })
        .finally(() => { reading = undefined; if (again && !disposed) { again = false; void read(); } });
      return reading;
    };
    const poll = (): Promise<void> => {
      if (polling) return polling;
      clearTimeout(timer);
      polling = (async () => {
        try { await sendRuntimeMessage({ action: "getRequestOperations" }, { timeoutMs: 4_000 }); runtimeFailed = false; }
        catch { runtimeFailed = true; }
        updateError();
        if (!disposed) await read();
      })().finally(() => {
        polling = undefined;
        if (!disposed) timer = setTimeout(() => void poll(), fastPolling || storageFailed || runtimeFailed ? 3_000 : 30_000);
      });
      return polling;
    };
    reloadRef.current = read;
    retryRef.current = poll;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes[REQUEST_OPERATIONS_LOCAL_KEY] || changes[REQUEST_TRACKING_KEY])) void read();
    };
    chrome.storage.onChanged?.addListener(changed);
    void read(); void poll();
    return () => {
      disposed = true; clearTimeout(timer); chrome.storage.onChanged?.removeListener(changed);
      reloadRef.current = retryRef.current = async () => undefined;
    };
  }, []);
  return { operations, tracked, error, reload, retry, clock };
}

export function RequestActivity({ operations, tracked, error, identity = {}, onOpenAccess, mode = "popup", onDismiss, onRetry, getProgress = getRequestItemProgress }: {
  operations: RequestOperationRecord[]; tracked: TrackedPimRequest[]; error?: string;
  identity?: { tenantId?: string; principalId?: string };
  onOpenAccess?: () => void;
  mode?: "popup" | "history";
  onDismiss?: (id: string) => Promise<void>;
  onRetry?: () => Promise<void>;
  getProgress?: RequestProgressResolver;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const section = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const previousIdentity = useRef<{ tenantId?: string; principalId?: string }>({});
  const restoreFocusAfterRemoval = () => {
    const containedFocus = section.current?.contains(document.activeElement);
    const fallback = section.current?.closest(".app-shell")?.querySelector<HTMLElement>(".activation-settings-button")
      || section.current?.closest(".panel")?.querySelector<HTMLElement>(".panel-title-row h2");
    return () => { if (containedFocus) requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
      const target = dialog.current?.open ? dialog.current.querySelector<HTMLButtonElement>("button")
        : toggle.current || (fallback?.isConnected ? fallback : undefined);
      if (target) { if (!target.matches("button, [tabindex]")) target.tabIndex = -1; target.focus(); }
    }); };
  };
  const archived = useRef(new Set<string>());
  const [, updateClock] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const matching = operations.filter((operation) => requestOperationMatchesIdentity(operation, identity));
  useEffect(() => {
    const next = { tenantId: identity.tenantId?.toLowerCase(), principalId: identity.principalId?.toLowerCase() };
    const previous = previousIdentity.current;
    const changed = (previous.tenantId && next.tenantId && previous.tenantId !== next.tenantId)
      || (previous.principalId && next.principalId && previous.principalId !== next.principalId);
    if (changed) {
      archived.current.clear(); setDismissed([]); setExpanded(false); setActionError("");
    }
    previousIdentity.current = changed ? next : { tenantId: next.tenantId || previous.tenantId, principalId: next.principalId || previous.principalId };
  }, [identity.tenantId, identity.principalId]);
  const now = Date.now();
  const isFinished = (operation: RequestOperationRecord) => isRequestOperationFinished(operation, tracked)
    && !operation.items?.some((item) => getProgress(operation, item, tracked).pending);
  const visible = matching.filter((operation) => mode === "history" ||
    (!isRequestOperationFinished(operation, tracked) || (!operation.popupResultSeenAt && !dismissed.includes(operation.id)
      && (!isFinished(operation) || shouldShowPopupRequest(operation, tracked, now)))));
  useEffect(() => {
    if (mode !== "popup") return;
    const final = matching.filter((operation) => isFinished(operation) && !operation.popupResultSeenAt && !archived.current.has(operation.id));
    if (!final.length) return;
    const deadline = Math.min(...final.map((operation) => getRequestResultVisibleUntil(operation, tracked)));
    const timer = setTimeout(() => {
      const restoreFocus = restoreFocusAfterRemoval();
      const expired = final.filter((operation) => getRequestResultVisibleUntil(operation, tracked) <= Date.now()).map((operation) => operation.id);
      for (const id of expired) archived.current.add(id);
      setDismissed((current) => [...new Set([...current, ...expired])]);
      updateClock((current) => current + 1);
      // This is presentation housekeeping. History and execution are retained;
      // the absolute timeout also applies if acknowledgement cannot be saved.
      if (expired.length) void markRequestOperationResultsSeen(expired).catch(() => undefined);
      restoreFocus();
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [operations, tracked, mode, identity.tenantId, identity.principalId, dismissed, getProgress]);
  useEffect(() => { if (!visible.length) setExpanded(false); }, [visible.length]);
  useEffect(() => {
    const element = dialog.current;
    if (expanded && element && !element.open) element.showModal();
    else if (!expanded && element?.open) element.close();
  }, [expanded]);
  const dismissResult = async (id: string) => {
    const restoreFocus = restoreFocusAfterRemoval();
    try {
      if (mode === "history") await onDismiss?.(id);
      else {
        const acknowledged = await markRequestOperationResultsSeen([id]);
        if (!acknowledged.includes(id)) return;
        setDismissed((current) => [...new Set([...current, id])]);
      }
      setActionError(""); restoreFocus();
    } catch { setActionError("Could not dismiss this result. Try again."); }
  };
  const retryStatus = async () => {
    if (!onRetry || retrying) return;
    const restoreFocus = restoreFocusAfterRemoval(); setRetrying(true);
    try { await onRetry(); setActionError(""); }
    catch { setActionError("Could not refresh request status. Try again."); }
    finally { setRetrying(false); restoreFocus(); }
  };
  if (!visible.length && !error && !actionError) return null;
  const summary = mode === "history" && visible.every((operation) => isRequestOperationFinished(operation, tracked))
    ? `${visible.length} recent request${visible.length === 1 ? "" : "s"}` : getRequestActivitySummary(visible, tracked, getProgress);
  const pending = visible.some((operation) => operation.items?.some((item) => getProgress(operation, item, tracked).pending));
  return <section className={`request-activity${expanded ? " is-expanded" : ""}${pending ? " has-pending" : ""}`} aria-label="Requests" ref={section}>
    <div className="request-activity-heading">
      <span role="status" aria-live="polite">{error ? "Request status temporarily unavailable" : !visible.length ? "Request notice" : summary}</span>
      {visible.length ? <button ref={toggle} className="btn subtle" aria-expanded={expanded} aria-haspopup="dialog" aria-controls={expanded ? "request-activity-dialog" : undefined} onClick={() => {
        const restoreFocus = restoreFocusAfterRemoval();
        setExpanded((current) => !current); restoreFocus();
      }}>View requests</button> : null}
      {error && onRetry ? <button className="btn subtle" aria-label="Retry request status" disabled={retrying} onClick={() => void retryStatus()}>{retrying ? "Checking…" : "Retry status"}</button> : null}
      {!visible.length && actionError && !error ? <button className="btn subtle" onClick={() => {
        const restoreFocus = restoreFocusAfterRemoval(); setActionError(""); restoreFocus();
      }}>Dismiss message</button> : null}
    </div>
    {!visible.length ? <p className="request-activity-empty" role="status">{actionError || error}</p> : null}
    {pending ? <div className="request-activity-progress" role="progressbar" aria-label="Request progress" aria-valuetext={error ? "Request status temporarily unavailable" : summary}><span /></div> : null}
    {expanded ? <dialog ref={dialog} className="request-activity-dialog" id="request-activity-dialog" aria-label="Request details" onClose={() => setExpanded(false)}>
      <div className="request-activity-heading"><span>Request details</span><button className="btn subtle" onClick={() => {
        const restoreFocus = restoreFocusAfterRemoval(); dialog.current?.close(); setExpanded(false); restoreFocus();
      }}>Hide requests</button></div>
      {pending ? <div className="request-activity-progress" role="progressbar" aria-label="Request details progress" aria-valuetext={summary}><span /></div> : null}
      <div className="request-activity-details" id="request-activity-details">
      <p className="muted">{mode === "popup" ? "Requests continue when you close this popup. Completed notices clear automatically after 10 seconds. Full history stays in Activity & Usage." : "Request journal, including completed results and their original parameters."}</p>
      {error || actionError ? <p role="status">{actionError || error}</p> : null}
      {visible.map((operation) => {
        const progress = (operation.items || []).map((item) => getProgress(operation, item, tracked));
        const canDismiss = isFinished(operation);
        const verb = operation.kind === "extension" ? "Extend" : operation.action === "activate" ? "Activate" : "Deactivate";
        return <article key={operation.id} className="request-activity-card" data-operation-id={operation.id} aria-label={`${verb} ${operation.bundleName || operation.items?.[0]?.itemName || "request"}`}>
          <strong>{verb}{operation.bundleName ? ` bundle ${operation.bundleName}` : ""}{operation.itemIds.length > 1 ? ` · ${operation.itemIds.length} items` : ""}</strong>
          <time dateTime={new Date(operation.startedAt).toISOString()}>{new Date(operation.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <ul>{operation.items?.map((item, index) => <li key={item.itemId}>
            <span><strong>{item.itemName}</strong><span className="muted"> · {item.scopeLabel || "Scope unavailable"}{operation.durationHours ? ` · ${formatExtensionDuration(operation.durationHours)}` : ""}</span></span>
            <span className={`request-result-label ${progress[index].attention ? "request-attention" : "muted"}`}>{progress[index].label}</span>
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
          {canDismiss && (mode === "popup" || onDismiss) ? <button className="btn subtle" onClick={() => void dismissResult(operation.id)}>Dismiss result</button> : null}
        </article>;
      })}
    </div></dialog> : null}
  </section>;
}
