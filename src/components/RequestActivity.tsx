import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { sanitizeErrorMessage } from "../lib/security";
import { formatLoadMessages } from "../lib/popupModel";
import { loadRequestOperations, markRequestOperationResultsSeen, requestOperationMatchesIdentity, REQUEST_OPERATIONS_LOCAL_KEY } from "../lib/requestOperations";
import { loadTrackedRequests, REQUEST_TRACKING_KEY } from "../lib/requestTracking";
import { getRequestActivitySummary, getRequestItemProgress, isRequestOperationFinished, shouldShowPopupRequest } from "../lib/requestActivity";
import { formatExtensionDuration } from "../lib/requestExtension";
import { sendRuntimeMessage } from "../lib/runtimeMessaging";
import type { RequestOperationRecord, TrackedPimRequest } from "../lib/types";

export function useRequestActivity() {
  const [operations, setOperations] = useState<RequestOperationRecord[]>([]);
  const [tracked, setTracked] = useState<TrackedPimRequest[]>([]);
  const [error, setError] = useState("");
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const retryRef = useRef<() => Promise<void>>(async () => undefined);
  const reload = useCallback(() => reloadRef.current(), []);
  const retry = useCallback(() => retryRef.current(), []);
  useEffect(() => {
    let disposed = false, storageFailed = false, runtimeFailed = false;
    let reading: Promise<void> | undefined, polling: Promise<void> | undefined;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const updateError = () => { if (!disposed) setError(storageFailed || runtimeFailed
      ? "Request status is temporarily unavailable. Your submitted work continues in the background." : ""); };
    const read = (): Promise<void> => {
      if (reading) { again = true; return reading; }
      reading = Promise.all([loadRequestOperations(), loadTrackedRequests()]).then(([next, store]) => {
        if (!disposed) { setOperations(next); setTracked(store.requests); storageFailed = false; updateError(); }
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
        if (!disposed) timer = setTimeout(() => void poll(), 3_000);
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
  return { operations, tracked, error, reload, retry };
}

function RequestResult({ id, label, finished, onViewed, children }: { id: string; label: string; finished: boolean; onViewed: (id: string) => void; children: ReactNode }) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const results = [...(card.current?.querySelectorAll(".request-result-label") || [])];
    if (!finished || !results.length || typeof IntersectionObserver === "undefined") return;
    const viewed = new Set<Element>();
    const footer = card.current?.closest(".app-shell")?.querySelector<HTMLElement>(".activation-bar");
    let observer: IntersectionObserver | undefined;
    const observe = () => {
      observer?.disconnect();
      // The sticky footer can cover part of a crowded popup. Covered outcomes
      // must not be counted as read just because they intersect the viewport.
      const covered = footer ? Math.max(0, Math.min(innerHeight, innerHeight - footer.getBoundingClientRect().top)) : 0;
      observer = new IntersectionObserver((entries) => {
        if (document.visibilityState !== "visible") return;
        for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= 0.99) viewed.add(entry.target);
        if (viewed.size === results.length) onViewed(id);
      }, { threshold: 0.99, rootMargin: `0px 0px -${covered}px 0px` });
      for (const result of results) observer.observe(result);
    };
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(observe) : undefined;
    if (footer) resize?.observe(footer);
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => { observer?.disconnect(); resize?.disconnect(); document.removeEventListener("visibilitychange", observe); };
  }, [finished, id, onViewed]);
  return <article ref={card} className="request-activity-card" data-operation-id={id} aria-label={label}>{children}</article>;
}

export function RequestActivity({ operations, tracked, error, identity = {}, onOpenAccess, mode = "popup", onDismiss, onRetry }: {
  operations: RequestOperationRecord[]; tracked: TrackedPimRequest[]; error?: string;
  identity?: { tenantId?: string; principalId?: string };
  onOpenAccess?: () => void;
  mode?: "popup" | "history";
  onDismiss?: (id: string) => Promise<void>;
  onRetry?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const previousIdentity = useRef<{ tenantId?: string; principalId?: string }>({});
  const restoreFocusAfterRemoval = () => {
    const containedFocus = section.current?.contains(document.activeElement);
    const fallback = section.current?.closest(".app-shell")?.querySelector<HTMLElement>(".activation-settings-button")
      || section.current?.closest(".panel")?.querySelector<HTMLElement>(".panel-title-row h2");
    return () => { if (containedFocus) requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
      const target = toggle.current || (fallback?.isConnected ? fallback : undefined);
      if (target) { if (!target.matches("button, [tabindex]")) target.tabIndex = -1; target.focus(); }
    }); };
  };
  const shownThisPopup = useRef(new Set<string>());
  const knownOperations = useRef(new Set<string>());
  const [dismissed, setDismissed] = useState<string[]>([]);
  const matching = operations.filter((operation) => requestOperationMatchesIdentity(operation, identity));
  useEffect(() => {
    const next = { tenantId: identity.tenantId?.toLowerCase(), principalId: identity.principalId?.toLowerCase() };
    const previous = previousIdentity.current;
    const changed = (previous.tenantId && next.tenantId && previous.tenantId !== next.tenantId)
      || (previous.principalId && next.principalId && previous.principalId !== next.principalId);
    if (changed) {
      shownThisPopup.current.clear(); knownOperations.current.clear(); setDismissed([]); setExpanded(false); setActionError("");
    }
    previousIdentity.current = changed ? next : { tenantId: next.tenantId || previous.tenantId, principalId: next.principalId || previous.principalId };
  }, [identity.tenantId, identity.principalId]);
  useEffect(() => {
    const hasNewRequest = matching.some((operation) => !knownOperations.current.has(operation.id));
    knownOperations.current = new Set(matching.map((operation) => operation.id));
    if (mode !== "popup" || !hasNewRequest || !shownThisPopup.current.size) return;
    const cards = [...(section.current?.querySelectorAll<HTMLElement>("[data-operation-id]") || [])];
    const viewed = [...shownThisPopup.current].filter((id) => {
      const card = cards.find((candidate) => candidate.dataset.operationId === id);
      return !card || !(card.contains(document.activeElement) || card.querySelector("details[open]") || card.matches(":hover"));
    });
    if (!viewed.length) return;
    for (const id of viewed) shownThisPopup.current.delete(id);
    setDismissed((current) => [...new Set([...current, ...viewed])]);
  }, [operations, mode, identity.tenantId, identity.principalId]);
  const recordViewed = useCallback((id: string) => {
    if (shownThisPopup.current.has(id)) return;
    shownThisPopup.current.add(id);
    void markRequestOperationResultsSeen([id]).then((acknowledged) => {
      if (!acknowledged.includes(id)) shownThisPopup.current.delete(id);
      else setActionError("");
    }).catch(() => {
      shownThisPopup.current.delete(id);
      setActionError("Could not remember this result as viewed. It will remain available.");
    });
  }, []);
  const visible = matching.filter((operation) => (mode === "history" || ((!isRequestOperationFinished(operation, tracked) || !dismissed.includes(operation.id))
    && shouldShowPopupRequest(operation, tracked, shownThisPopup.current.has(operation.id)))));
  useEffect(() => { if (!visible.length) setExpanded(false); }, [visible.length]);
  const dismissResult = async (id: string) => {
    const restoreFocus = restoreFocusAfterRemoval();
    try {
      if (mode === "history") await onDismiss?.(id);
      else {
        const acknowledged = await markRequestOperationResultsSeen([id]);
        if (!acknowledged.includes(id)) return;
        shownThisPopup.current.delete(id); setDismissed((current) => [...new Set([...current, id])]);
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
    ? `${visible.length} recent request${visible.length === 1 ? "" : "s"}` : getRequestActivitySummary(visible, tracked);
  const pending = visible.some((operation) => operation.items?.some((item) => getRequestItemProgress(operation, item, tracked).pending));
  return <section className={`request-activity${expanded ? " is-expanded" : ""}${pending ? " has-pending" : ""}`} aria-label="Requests" ref={section}>
    <div className="request-activity-heading">
      <span role="status" aria-live="polite">{error ? "Request status temporarily unavailable" : !visible.length ? "Request notice" : summary}</span>
      {visible.length ? <button ref={toggle} className="btn subtle" aria-expanded={expanded} aria-controls={expanded ? "request-activity-details" : undefined} onClick={() => {
        const restoreFocus = restoreFocusAfterRemoval();
        if (expanded) shownThisPopup.current.clear();
        setExpanded((current) => !current); restoreFocus();
      }}>{expanded ? "Hide requests" : "View requests"}</button> : null}
      {error && onRetry ? <button className="btn subtle" aria-label="Retry request status" disabled={retrying} onClick={() => void retryStatus()}>{retrying ? "Checking…" : "Retry status"}</button> : null}
      {!visible.length && actionError && !error ? <button className="btn subtle" onClick={() => {
        const restoreFocus = restoreFocusAfterRemoval(); setActionError(""); restoreFocus();
      }}>Dismiss message</button> : null}
    </div>
    {!visible.length ? <p className="request-activity-empty" role="status">{actionError || error}</p> : null}
    {pending ? <div className="request-activity-progress" role="progressbar" aria-label="Request progress" aria-valuetext={error ? "Request status temporarily unavailable" : summary}><span /></div> : null}
    {expanded ? <div className="request-activity-details" id="request-activity-details">
      <p className="muted">{mode === "popup" ? "You can close this popup or start another request. Finished results appear once; full history stays in Activity & Usage." : "Request journal, including completed results and their original parameters."}</p>
      {error || actionError ? <p role="status">{actionError || error}</p> : null}
      {visible.map((operation) => {
        const progress = (operation.items || []).map((item) => getRequestItemProgress(operation, item, tracked));
        const canDismiss = isRequestOperationFinished(operation, tracked);
        const verb = operation.kind === "extension" ? "Extend" : operation.action === "activate" ? "Activate" : "Deactivate";
        return <RequestResult key={operation.id} id={operation.id} label={`${verb} ${operation.bundleName || operation.items?.[0]?.itemName || "request"}`} finished={canDismiss && mode === "popup"} onViewed={recordViewed}>
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
        </RequestResult>;
      })}
    </div> : null}
  </section>;
}
