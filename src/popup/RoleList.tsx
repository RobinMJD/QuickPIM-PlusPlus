import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateOnly, formatLocalDateTime } from "../lib/dateFormat";
import {
  formatActivationItemStatusLabel,
  formatRemainingActivationTime,
  getActivationStatusTitle,
  getEffectiveActiveAssignmentType,
  getRemainingActivationTimeUpdateDelay,
  getRowActionState,
  getRowPolicySummary,
  isHighPrivilegeItem,
  shouldShowRemainingActivationTime
} from "../lib/popupModel";
import { getDisplayName, getScopeLabel, getUsage } from "../lib/settings";
import {
  activationItemIdentitiesMatch,
  getActivationItemIdentity,
  getActivationItemIdentityCandidates,
  normalizeActivationItemId
} from "../lib/activationIdentity";
import type { ActivationItem, PopupRequestMode, QuickPimSettings, ReferenceDataCache } from "../lib/types";

const MAX_EXPIRY_TIMER_DELAY_MS = 2_147_000_000;

export function RoleList({
  items,
  settings,
  referenceData,
  selectedIds,
  favoriteIds,
  requestMode,
  showActivationCounters,
  showEnablementDetails,
  showLastEnablementDate,
  showRemainingActivationTime,
  showActiveExpiryDetails = false,
  emptyText = "No eligible roles or groups found.",
  onToggle,
  onToggleFavorite,
  onActivationExpired,
  readonly = false
}: {
  items: ActivationItem[];
  settings: QuickPimSettings;
  referenceData?: ReferenceDataCache;
  selectedIds: Set<string>;
  favoriteIds: Set<string>;
  requestMode?: PopupRequestMode;
  showActivationCounters: boolean;
  showEnablementDetails: boolean;
  showLastEnablementDate: boolean;
  showRemainingActivationTime: boolean;
  showActiveExpiryDetails?: boolean;
  emptyText?: string;
  onToggle?: (itemId: string) => void;
  onToggleFavorite?: (itemId: string) => void;
  onActivationExpired?: (item: ActivationItem) => void;
  readonly?: boolean;
}) {
  const [activeNow, setActiveNow] = useState(() => Date.now());
  const notifiedExpiries = useRef(new Map<string, string>());
  const onActivationExpiredRef = useRef(onActivationExpired);
  onActivationExpiredRef.current = onActivationExpired;

  useEffect(() => {
    const now = Date.now();
    const activeIdentities = new Set<string>();
    let nextExpiry: number | undefined;

    for (const item of items) {
      if (item.status !== "active" || !item.activeUntil) continue;
      const expiresAt = Date.parse(item.activeUntil);
      if (!Number.isFinite(expiresAt)) continue;
      const identity = getActivationItemIdentity(item);
      activeIdentities.add(identity);
      if (expiresAt <= now) {
        if (notifiedExpiries.current.get(identity) !== item.activeUntil) {
          notifiedExpiries.current.set(identity, item.activeUntil);
          onActivationExpiredRef.current?.(item);
        }
        continue;
      }
      if (notifiedExpiries.current.get(identity) !== item.activeUntil) {
        notifiedExpiries.current.delete(identity);
      }
      nextExpiry = nextExpiry === undefined ? expiresAt : Math.min(nextExpiry, expiresAt);
    }

    for (const identity of notifiedExpiries.current.keys()) {
      if (!activeIdentities.has(identity)) notifiedExpiries.current.delete(identity);
    }

    if (nextExpiry === undefined) return;
    const timeoutId = window.setTimeout(
      () => setActiveNow(Date.now()),
      Math.min(MAX_EXPIRY_TIMER_DELAY_MS, Math.max(50, nextExpiry - now + 20))
    );
    return () => window.clearTimeout(timeoutId);
  }, [activeNow, items]);

  const handleActivationExpired = useCallback(() => {
    setActiveNow(Date.now());
  }, []);
  const visibleItems = items.filter((item) => {
    if (item.status !== "active" || !item.activeUntil) return true;
    const expiresAt = Date.parse(item.activeUntil);
    return !Number.isFinite(expiresAt) || expiresAt > activeNow;
  });

  if (!visibleItems.length) {
    return <div className="empty-state">{emptyText}</div>;
  }

  return (
    <div className="item-list">
      {visibleItems.map((item) => {
        const usage = getUsage(item, settings);
        const actionState = getRowActionState(item);
        const itemMode = actionState.mode;
        const isActionable = !readonly && actionState.selectable && Boolean(itemMode);
        const isSelectable = Boolean(isActionable && (!requestMode || requestMode === itemMode));
        const selected = isSelectable && [...selectedIds].some((itemId) =>
          activationItemIdentitiesMatch(itemId, item.id));
        const displayName = getDisplayName(item, settings, referenceData);
        const isFavorite = getActivationItemIdentityCandidates(item)
          .some((identity) => favoriteIds.has(normalizeActivationItemId(identity)));
        const statusTitle = getActivationStatusTitle(item);
        const activeAssignmentType = getEffectiveActiveAssignmentType(item);
        const statusBadgeClass = activeAssignmentType === "assigned"
          ? "assigned"
          : activeAssignmentType === "activated"
            ? "pim-active"
            : item.status;
        const statusRowClass = item.status === "active"
          ? activeAssignmentType === "assigned" ? "assigned-row" : "active-row"
          : item.status === "pendingApproval" ? "pending-row" : "";
        const lastEnabledDate = showLastEnablementDate ? formatDateOnly(usage.lastUsedAt) : "";
        const activeEndDateTime = showActiveExpiryDetails && activeAssignmentType === "activated"
          ? formatLocalDateTime(item.activeUntil)
          : "";
        const policySummary = showEnablementDetails ? getRowPolicySummary(item) : [];
        const rowTitle = actionState.reason || (!isSelectable && requestMode && itemMode ? `Clear the current selection to ${itemMode === "activate" ? "activate" : "deactivate"} this item.` : undefined);
        const body = (
          <>
            <button
              type="button"
              className={`favorite-button ${isFavorite ? "active" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite?.(getActivationItemIdentity(item));
              }}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-label={`${isFavorite ? "Remove" : "Add"} ${displayName} ${isFavorite ? "from" : "to"} favorites`}
            >
              <StarIcon filled={isFavorite} />
            </button>
            <div className="role-main">
              <p className="role-title">
                <span>{displayName}</span>
                {isHighPrivilegeItem(item) ? <CrownIcon /> : null}
              </p>
              <div className="role-meta">
                <span className={`badge ${item.type}`}>{typeLabel(item.type)}</span>
                <span className="scope-label">{getScopeLabel(item, referenceData)}</span>
                {lastEnabledDate ? <span>last enabled {lastEnabledDate}</span> : null}
              </div>
              {policySummary.length ? (
                <details className="role-details" onClick={(event) => event.stopPropagation()}>
                  <summary>Details</summary>
                  <ul>
                    {policySummary.map((detail) => <li key={detail}>{detail}</li>)}
                  </ul>
                </details>
              ) : null}
            </div>
            <div className="role-status-stack">
              {showActivationCounters ? (
                <span className="activation-count" title={`${usage.activationCount} activation${usage.activationCount === 1 ? "" : "s"}`}>
                  {usage.activationCount}
                </span>
              ) : null}
              <span className={`badge status-badge ${statusBadgeClass}`} title={statusTitle}>
                {formatActivationItemStatusLabel(item)}
              </span>
              {shouldShowRemainingActivationTime(item, showRemainingActivationTime) && item.activeUntil ? (
                <RemainingActivationTime activeUntil={item.activeUntil} onExpired={handleActivationExpired} />
              ) : null}
              {activeEndDateTime && item.activeUntil ? (
                <time className="active-end-time" dateTime={item.activeUntil} title="PIM activation end time in your local time zone">
                  until {activeEndDateTime}
                </time>
              ) : null}
            </div>
          </>
        );

        if (!isActionable) {
          return <div className={`role-row readonly ${statusRowClass}`} key={item.id} title={rowTitle}>{body}</div>;
        }

        return (
          <div
            className={`role-row selectable ${selected ? "selected" : ""} ${!isSelectable ? "disabled" : ""} ${statusRowClass}`}
            key={item.id}
            onClick={() => isSelectable && onToggle?.(item.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              if (isSelectable) onToggle?.(item.id);
            }}
            title={rowTitle}
            tabIndex={0}
            role="group"
            aria-label={`${displayName}. ${formatActivationItemStatusLabel(item)}.${rowTitle ? ` ${rowTitle}` : ""}`}
            aria-disabled={!isSelectable}
          >
            <input
              type="checkbox"
              aria-label={`${selected ? "Unselect" : "Select"} ${displayName}`}
              checked={selected}
              disabled={!isSelectable}
              onClick={(event) => event.stopPropagation()}
              onChange={() => onToggle?.(item.id)}
            />
            {body}
          </div>
        );
      })}
    </div>
  );
}

function RemainingActivationTime({ activeUntil, onExpired }: { activeUntil: string; onExpired?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timeoutId: number | undefined;
    const scheduleNextUpdate = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const delay = getRemainingActivationTimeUpdateDelay(activeUntil, currentTime);
      if (delay !== undefined) timeoutId = window.setTimeout(scheduleNextUpdate, delay);
      else if (Date.parse(activeUntil) <= currentTime) onExpired?.();
    };
    scheduleNextUpdate();
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [activeUntil, onExpired]);

  const remaining = formatRemainingActivationTime(activeUntil, now);
  if (!remaining) return null;
  return <time className="remaining-activation-time" dateTime={activeUntil} title="Remaining PIM activation time" aria-label={`${remaining} remaining on PIM activation`}>{remaining}</time>;
}

function StarIcon({ filled }: { filled: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="star-icon"><path d="m12 3.7 2.5 5.1 5.6.8-4 3.9.9 5.5-5-2.6-5 2.6.9-5.5-4-3.9 5.6-.8L12 3.7Z" fill={filled ? "currentColor" : "none"} /></svg>;
}

function CrownIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="crown-icon"><path d="m3 7 5 4 4-7 4 7 5-4-2 12H5L3 7Z" /><path d="M5 19h14" /></svg>;
}

function typeLabel(type: ActivationItem["type"]): string {
  if (type === "directoryRole") return "Entra";
  if (type === "azureRole") return "Azure";
  return "PIM group";
}
