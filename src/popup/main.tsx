import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  getActivationDataWithCache,
  loadDataCache,
  saveDataCache
} from "../lib/cache";
import {
  buildAccessCapabilityItems,
  buildTokenCacheKey,
  getAccessSetupTargets,
  type AccessCapabilityItem
} from "../lib/access";
import { filterLoadErrorsForAccessState } from "../lib/accessMessages";
import {
  coerceDurationForItems,
  formatLoadMessages,
  getActivationRequirements,
  getActivatableItems,
  getActiveStatusTitle,
  getDurationOptions,
  mergeEligibleWithActive,
  getPortalUrlForTab,
  tabLabel,
  tokenStatusText,
  tokenStatusTone,
  type PopupTab,
  type RoleTab
} from "../lib/popupModel";
import {
  DEFAULT_SETTINGS,
  addRecentJustification,
  addSavedJustification,
  expandBundle,
  getDisplayName,
  getScopeLabel,
  getUsage,
  loadSettings,
  recordActivations,
  saveSettings,
  sortItems
} from "../lib/settings";
import {
  applyReferenceDataToItems,
  learnReferenceDataFromItems,
  loadReferenceData,
  saveReferenceData
} from "../lib/referenceData";
import type {
  ActivationItem,
  ActivationResponse,
  QuickPimBundle,
  ReferenceDataCache,
  QuickPimSettings,
  SortMode,
  TicketInfo,
  TokenStatus
} from "../lib/types";

interface MessageResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function PopupApp() {
  const [tab, setTab] = useState<PopupTab>("directoryRole");
  const [settings, setSettings] = useState<QuickPimSettings>(DEFAULT_SETTINGS);
  const [eligibleItems, setEligibleItems] = useState<ActivationItem[]>([]);
  const [activeItems, setActiveItems] = useState<ActivationItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [referenceData, setReferenceData] = useState<ReferenceDataCache | undefined>();
  const [accessCapabilities, setAccessCapabilities] = useState<AccessCapabilityItem[]>([]);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [durationHours, setDurationHours] = useState(DEFAULT_SETTINGS.preferences.defaultDurationHours);
  const [justification, setJustification] = useState("");
  const [ticketSystem, setTicketSystem] = useState("");
  const [ticketNumber, setTicketNumber] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isActivating, setIsActivating] = useState(false);

  useEffect(() => {
    void refresh({ force: false });
  }, []);

  useEffect(() => {
    setSortMode(settings.preferences.defaultSort);
    setDurationHours(settings.preferences.defaultDurationHours);
  }, [settings.preferences.defaultDurationHours, settings.preferences.defaultSort]);

  const displayItems = useMemo(
    () => mergeEligibleWithActive(eligibleItems, activeItems),
    [activeItems, eligibleItems]
  );
  const itemsById = useMemo(() => new Map(displayItems.map((item) => [item.id, item])), [displayItems]);
  const selectedItems = useMemo(
    () => getActivatableItems([...selectedIds].map((id) => itemsById.get(id)).filter((item): item is ActivationItem => Boolean(item))),
    [itemsById, selectedIds]
  );
  const requirements = useMemo(() => getActivationRequirements(selectedItems), [selectedItems]);
  const durationOptions = useMemo(() => getDurationOptions(selectedItems), [selectedItems]);
  const accessSetupTargets = useMemo(() => getAccessSetupTargets(accessCapabilities), [accessCapabilities]);
  const showPermissionWarning = useMemo(
    () => tokenStatus !== null && !settings.preferences.permissionWarningIgnored && accessSetupTargets.length > 0,
    [accessSetupTargets.length, settings, tokenStatus]
  );

  useEffect(() => {
    if (durationOptions.length) {
      setDurationHours((current) => coerceDurationForItems(current, selectedItems));
    }
  }, [durationOptions, selectedItems]);

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => itemsById.get(id)?.status === "eligible"));
      return next.size === current.size ? current : next;
    });
  }, [itemsById]);

  const visibleEligibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = displayItems.filter((item) => {
      const matchesType = item.type === tab;
      const name = getDisplayName(item, settings, referenceData).toLowerCase();
      const scope = getScopeLabel(item, referenceData).toLowerCase();
      return matchesType && (!term || name.includes(term) || scope.includes(term));
    });
    return sortItems(filtered, settings, sortMode, referenceData);
  }, [displayItems, referenceData, search, settings, sortMode, tab]);

  async function refresh(options: { force: boolean }) {
    setIsLoading(true);
    setError("");
    try {
      const [loadedSettings, loadedTokens, currentCache, loadedReferenceData] = await Promise.all([
        loadSettings(),
        sendMessage<TokenStatus>({ action: "getTokenStatus" }),
        loadDataCache(),
        loadReferenceData()
      ]);
      const now = Date.now();
      const tokenCacheKey = buildTokenCacheKey(loadedTokens);
      const { eligible, active, cache: nextCache } = await getActivationDataWithCache({
        cache: currentCache,
        eligibleTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        activeTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS,
        force: options.force,
        now,
        tokenCacheKey,
        fetchEligible: () =>
          sendMessage<{ items: ActivationItem[]; errors: string[]; diagnostics?: any[] }>({ action: "getActivationItems" }),
        fetchActive: () =>
          sendMessage<{ items: ActivationItem[]; errors: string[]; diagnostics?: any[] }>({ action: "getActiveItems" })
      });

      if (!eligible.fromCache || !active.fromCache) {
        await saveDataCache(nextCache);
      }
      const nextReferenceData = learnReferenceDataFromItems(loadedReferenceData, [...eligible.entry.items, ...active.entry.items]);
      await saveReferenceData(nextReferenceData);

      const nextAccessCapabilities = buildAccessCapabilityItems(loadedTokens, nextCache);
      const loadErrors = filterLoadErrorsForAccessState(
        [...(eligible.entry.errors || []), ...(active.entry.errors || [])],
        nextAccessCapabilities
      );

      setSettings(loadedSettings);
      setTokenStatus(loadedTokens);
      setReferenceData(nextReferenceData);
      setAccessCapabilities(nextAccessCapabilities);
      setEligibleItems(applyDisplayData(eligible.entry.items, loadedSettings, nextReferenceData));
      setActiveItems(applyDisplayData(active.entry.items, loadedSettings, nextReferenceData));
      const cacheMessage = options.force ? "Forced refresh completed." : "";
      setMessage(formatLoadMessages([...loadErrors, cacheMessage].filter(Boolean)).join("\n"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }

  function toggleSelected(itemId: string) {
    setSelectedIds((current) => {
      if (itemsById.get(itemId)?.status !== "eligible") {
        return current;
      }
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }

  async function activate(items: ActivationItem[], bundle?: QuickPimBundle) {
    const activatableItems = getActivatableItems(items);
    if (!activatableItems.length) {
      setError(items.length ? "All selected items are already active." : "Select at least one role or group.");
      return;
    }

    const effectiveJustification = bundle?.defaultJustification || justification;
    const effectiveDuration = coerceDurationForItems(bundle?.defaultDurationHours || durationHours, activatableItems);
    const effectiveTicketInfo: TicketInfo = {
      ticketSystem: bundle?.defaultTicketSystem || ticketSystem || undefined,
      ticketNumber: bundle?.defaultTicketNumber || ticketNumber || undefined
    };

    if (getActivationRequirements(activatableItems).needsJustification && !effectiveJustification.trim()) {
      setError("Enter a justification or choose a saved one.");
      return;
    }

    setIsActivating(true);
    setError("");
    setMessage("");
    try {
      const response = await sendMessage<ActivationResponse>({
        action: "activateItems",
        items: activatableItems,
        durationHours: effectiveDuration,
        justification: effectiveJustification,
        ticketInfo: effectiveTicketInfo
      });
      const successItems = response.results
        .filter((result) => result.success)
        .map((result) => activatableItems.find((item) => item.id === result.itemId))
        .filter((item): item is ActivationItem => Boolean(item));

      let updatedSettings = addRecentJustification(settings, effectiveJustification);
      updatedSettings = recordActivations(updatedSettings, successItems, new Date().toISOString(), bundle?.name);
      await saveSettings(updatedSettings);
      setSettings(updatedSettings);
      setSelectedIds(new Set());
      setMessage(response.success ? `Activated ${successItems.length} item(s).` : `Activated ${successItems.length}; ${response.errors.length} failed.`);
      if (response.errors.length) {
        setError(response.errors.map((item) => `${item.itemName}: ${item.error}`).join(" "));
      }
      await refresh({ force: true });
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : String(activationError));
    } finally {
      setIsActivating(false);
    }
  }

  async function saveCurrentJustification() {
    const updated = addSavedJustification(settings, justification);
    await saveSettings(updated);
    setSettings(updated);
  }

  function useBundleDefaults(bundle: QuickPimBundle) {
    const expansion = expandBundle(bundle, displayItems);
    setSelectedIds(new Set(expansion.items.map((item) => item.id)));
    if (expansion.durationHours) setDurationHours(expansion.durationHours);
    if (expansion.justification) setJustification(expansion.justification);
    setTicketSystem(expansion.ticketInfo.ticketSystem || "");
    setTicketNumber(expansion.ticketInfo.ticketNumber || "");
    setTab("directoryRole");
  }

  function openPortalForCurrentTab() {
    const url = getPortalUrlForTab(tab);
    if (!url) return;
    if (chrome.tabs?.create) {
      void chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  function openPermissionDetails() {
    const url = chrome.runtime.getURL("settings.html#access");
    if (chrome.tabs?.create) {
      void chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  async function ignorePermissionWarning() {
    const updated = {
      ...settings,
      preferences: {
        ...settings.preferences,
        permissionWarningIgnored: true,
        permissionWarningIgnoredAt: new Date().toISOString()
      }
    };
    await saveSettings(updated);
    setSettings(updated);
  }

  const roleTabs: RoleTab[] = ["directoryRole", "pimGroup", "azureRole"];
  const portalUrl = getPortalUrlForTab(tab);
  const portalLabel = roleTabs.includes(tab as RoleTab) ? tabLabel(tab as RoleTab) : "Microsoft Entra";

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM</h1>
            <p>
              {isLoading ? null : `${displayItems.length} eligible items`}
            </p>
          </div>
        </div>
        <div className="status-stack">
          <TokenPill label="Graph" status={tokenStatus?.graph} />
          <TokenPill label="Azure" status={tokenStatus?.azureManagement} />
          <div className="header-actions" aria-label="Popup actions">
            <button className="btn icon-btn" onClick={() => void refresh({ force: true })} disabled={isLoading} title="Force refresh all data" aria-label="Force refresh all data">
              <RefreshIcon />
            </button>
            <button className="btn icon-btn" onClick={openPortalForCurrentTab} disabled={!portalUrl} title={`Open ${portalLabel} in Microsoft Entra`} aria-label={`Open ${portalLabel} in Microsoft Entra`}>
              <LinkIcon />
            </button>
          </div>
        </div>
      </header>

      {showPermissionWarning ? (
        <PermissionWarningBanner
          missingCount={accessSetupTargets.length}
          onFix={openPermissionDetails}
          onDetails={openPermissionDetails}
          onIgnore={() => void ignorePermissionWarning()}
        />
      ) : null}

      <nav className="tab-bar">
        {roleTabs.map((roleTab) => (
          <button className={`tab-button ${tab === roleTab ? "active" : ""}`} onClick={() => setTab(roleTab)} key={roleTab}>
            {tabLabel(roleTab)}
          </button>
        ))}
        <button className={`tab-button ${tab === "bundles" ? "active" : ""}`} onClick={() => setTab("bundles")}>
          Bundles
        </button>
      </nav>

      {error ? <p className="message error">{error}</p> : null}
      {message ? <p className="message">{message}</p> : null}
      {isLoading ? <LoadingState /> : null}

      {roleTabs.includes(tab as RoleTab) ? (
        <>
          <section className="toolbar">
            <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or scope" />
            <select className="select" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Sort roles">
              <option value="name">Name</option>
              <option value="lastUsed">Last use</option>
              <option value="activationCount">Activation count</option>
              <option value="type">Type</option>
              <option value="scope">Scope</option>
            </select>
          </section>
          <section className="content">
            <RoleList
              items={visibleEligibleItems}
              settings={settings}
              referenceData={referenceData}
              selectedIds={selectedIds}
              onToggle={toggleSelected}
            />
          </section>
          <ActivationBar
            durationHours={durationHours}
            setDurationHours={setDurationHours}
            justification={justification}
            setJustification={setJustification}
            ticketSystem={ticketSystem}
            setTicketSystem={setTicketSystem}
            ticketNumber={ticketNumber}
            setTicketNumber={setTicketNumber}
            settings={settings}
            requirements={requirements}
            durationOptions={durationOptions}
            selectedCount={selectedItems.length}
            isActivating={isActivating}
            onActivate={() => void activate(selectedItems)}
            onSaveJustification={() => void saveCurrentJustification()}
          />
        </>
      ) : null}

      {tab === "bundles" ? (
        <section className="content item-list">
          {settings.bundles.length ? (
            settings.bundles.map((bundle) => {
              const expansion = expandBundle(bundle, displayItems);
              return (
                <div className="bundle-card" key={bundle.id}>
                  <h3>{bundle.name}</h3>
                  <p className="muted">
                    {expansion.items.length} available item(s)
                    {bundle.defaultJustification ? ` / ${bundle.defaultJustification}` : ""}
                  </p>
                  <div className="button-row">
                    <button className="btn" onClick={() => useBundleDefaults(bundle)}>
                      Use defaults
                    </button>
                    <button className="btn primary" onClick={() => void activate(expansion.items, bundle)} disabled={!expansion.items.length || isActivating}>
                      Activate bundle
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState text="Create role bundles from Settings." />
          )}
          <button className="btn" onClick={() => chrome.runtime.openOptionsPage()}>
            Open settings
          </button>
        </section>
      ) : null}
    </main>
  );
}

function PermissionWarningBanner({
  missingCount,
  onFix,
  onDetails,
  onIgnore
}: {
  missingCount: number;
  onFix: () => void;
  onDetails: () => void;
  onIgnore: () => void;
}) {
  return (
    <section className="permission-banner" role="status">
      <div>
        <strong>Some QuickPIM data is missing or stale.</strong>
        <p>{missingCount} area{missingCount === 1 ? "" : "s"} need portal refresh or have limited API access.</p>
      </div>
      <div className="button-row nowrap">
        <button className="btn primary" onClick={onFix}>
          Fix access
        </button>
        <button className="btn" onClick={onDetails}>
          Details
        </button>
        <button className="btn subtle" onClick={onIgnore}>
          Ignore
        </button>
      </div>
    </section>
  );
}

function TokenPill({ label, status }: { label: string; status?: TokenStatus["graph"] }) {
  return <span className={`token-pill ${tokenStatusTone(status)}`}>{tokenStatusText(label, status)}</span>;
}

function LoadingState() {
  return (
    <section className="loading-panel" aria-live="polite">
      <span className="spinner large" aria-hidden="true" />
      <span>Loading access data</span>
    </section>
  );
}

function RoleList({
  items,
  settings,
  referenceData,
  selectedIds,
  onToggle,
  readonly = false
}: {
  items: ActivationItem[];
  settings: QuickPimSettings;
  referenceData?: ReferenceDataCache;
  selectedIds: Set<string>;
  onToggle?: (itemId: string) => void;
  readonly?: boolean;
}) {
  if (!items.length) {
    return <EmptyState text="No eligible roles or groups found." />;
  }

  return (
    <div className="item-list">
      {items.map((item) => {
        const usage = getUsage(item, settings);
        const isSelectable = !readonly && item.status === "eligible";
        const selected = isSelectable && selectedIds.has(item.id);
        const activeTitle = getActiveStatusTitle(item);
        const body = (
          <>
            <div>
              <p className="role-title">{getDisplayName(item, settings, referenceData)}</p>
              <div className="role-meta">
                <span className={`badge ${item.type}`}>{typeLabel(item.type)}</span>
                <span className="scope-label">{getScopeLabel(item, referenceData)}</span>
                {usage.lastUsedAt ? <span>last {new Date(usage.lastUsedAt).toLocaleDateString()}</span> : null}
              </div>
            </div>
            <div className="role-status-stack">
              <span className="activation-count" title={`${usage.activationCount} activation${usage.activationCount === 1 ? "" : "s"}`}>
                {usage.activationCount}
              </span>
              <span className={`badge status-badge ${item.status}`} title={activeTitle}>
                {item.status}
              </span>
            </div>
          </>
        );

        if (!isSelectable) {
          return (
            <div className={`role-row readonly ${item.status === "active" ? "active-row" : ""}`} key={item.id}>
              {body}
            </div>
          );
        }

        return (
          <label className={`role-row ${selected ? "selected" : ""}`} key={item.id}>
            <input type="checkbox" checked={selected} onChange={() => onToggle?.(item.id)} />
            {body}
          </label>
        );
      })}
    </div>
  );
}

function ActivationBar(props: {
  durationHours: number;
  setDurationHours: (value: number) => void;
  justification: string;
  setJustification: (value: string) => void;
  ticketSystem: string;
  setTicketSystem: (value: string) => void;
  ticketNumber: string;
  setTicketNumber: (value: string) => void;
  settings: QuickPimSettings;
  requirements: ReturnType<typeof getActivationRequirements>;
  durationOptions: Array<{ value: number; label: string }>;
  selectedCount: number;
  isActivating: boolean;
  onActivate: () => void;
  onSaveJustification: () => void;
}) {
  const justificationOptions = [...props.settings.savedJustifications, ...props.settings.recentJustifications];
  const hasSelection = props.selectedCount > 0;
  const selectedDuration = props.durationOptions.some((option) => option.value === props.durationHours)
    ? props.durationHours
    : props.durationOptions[0]?.value;
  return (
    <section className="activation-bar">
      {hasSelection && props.durationOptions.length ? (
        <div className="field">
          <label>Activation time</label>
          <select
            className="select"
            value={String(selectedDuration)}
            onChange={(event) => props.setDurationHours(Number(event.target.value))}
            title="Activation duration"
          >
            {props.durationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {hasSelection && props.requirements.needsJustification ? (
        <div className="field" style={{ marginTop: 8 }}>
          <label>Justification</label>
          <textarea
            className="textarea justification-textarea"
            rows={2}
            value={props.justification}
            onChange={(event) => props.setJustification(event.target.value)}
            placeholder="Why do you need this activation?"
          />
        </div>
      ) : null}
      {hasSelection && props.requirements.needsJustification && justificationOptions.length ? (
        <div className="chip-row">
          {justificationOptions.slice(0, 4).map((item) => (
            <button className="justification-chip" key={item} onClick={() => props.setJustification(item)}>
              {item}
            </button>
          ))}
        </div>
      ) : null}
      {hasSelection && props.requirements.needsTicket ? (
        <div className="activation-grid" style={{ marginTop: 8 }}>
          <input className="input" value={props.ticketSystem} onChange={(event) => props.setTicketSystem(event.target.value)} placeholder="Ticket system" />
          <input className="input" value={props.ticketNumber} onChange={(event) => props.setTicketNumber(event.target.value)} placeholder="Ticket number" />
        </div>
      ) : null}
      <div className="button-row">
        {hasSelection && props.requirements.needsJustification ? (
          <button className="btn subtle" onClick={props.onSaveJustification} disabled={!props.justification.trim()}>
            Save justification
          </button>
        ) : null}
        {hasSelection ? (
          <button className="btn primary" onClick={props.onActivate} disabled={props.isActivating}>
            Activate {props.selectedCount} selected
          </button>
        ) : null}
        <button className="btn" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
    </section>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon">
      <path d="M20 6v5h-5" />
      <path d="M4 18v-5h5" />
      <path d="M18.2 9A7 7 0 0 0 6.7 6.7L4 9" />
      <path d="M5.8 15a7 7 0 0 0 11.5 2.3L20 15" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon">
      <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
    </svg>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function applyDisplayData(
  items: ActivationItem[],
  settings: QuickPimSettings,
  referenceData: ReferenceDataCache
): ActivationItem[] {
  return applyReferenceDataToItems(items, referenceData).map((item) => ({
    ...item,
    displayName: getDisplayName(item, settings, referenceData),
    scopeLabel: getScopeLabel(item, referenceData)
  }));
}

function typeLabel(type: ActivationItem["type"]) {
  if (type === "directoryRole") return "Entra";
  if (type === "azureRole") return "Azure";
  return "PIM group";
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
  if (!response?.success) {
    throw new Error(response?.error || "QuickPIM background request failed.");
  }
  return response.data as T;
}

createRoot(document.getElementById("root")!).render(<PopupApp />);
