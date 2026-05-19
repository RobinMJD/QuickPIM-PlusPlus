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
  isHighPrivilegeItem,
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

interface LoadingProgress {
  current: number;
  total: number;
  label: string;
}

const LOADING_STEPS: LoadingProgress[] = [
  { current: 1, total: 4, label: "Preparing local settings" },
  { current: 2, total: 4, label: "Checking portal tokens" },
  { current: 3, total: 4, label: "Loading eligible and active data" },
  { current: 4, total: 4, label: "Preparing the role list" }
];

const ACTIVATION_STEPS: LoadingProgress[] = [
  { current: 1, total: 3, label: "Sending activation request" },
  { current: 2, total: 3, label: "Saving activation result" },
  { current: 3, total: 3, label: "Refreshing activation status" }
];

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
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress>(LOADING_STEPS[0]);
  const [activationProgress, setActivationProgress] = useState<LoadingProgress | null>(null);
  const [isActivating, setIsActivating] = useState(false);

  useEffect(() => {
    void refresh({ force: false });
  }, []);

  useEffect(() => {
    setSortMode(settings.preferences.defaultSort);
    setDurationHours(settings.preferences.defaultDurationHours);
  }, [settings.preferences.defaultDurationHours, settings.preferences.defaultSort]);

  useEffect(() => {
    document.body.classList.toggle("dark-mode", settings.preferences.darkMode);
  }, [settings.preferences.darkMode]);

  const displayItems = useMemo(
    () => mergeEligibleWithActive(eligibleItems, activeItems),
    [activeItems, eligibleItems]
  );
  const itemsById = useMemo(() => new Map(displayItems.map((item) => [item.id, item])), [displayItems]);
  const hiddenPopupTabs = useMemo(() => new Set(settings.preferences.hiddenPopupTabs || []), [settings.preferences.hiddenPopupTabs]);
  const itemTypesWithData = useMemo(() => new Set(displayItems.map((item) => item.type)), [displayItems]);
  const roleTabs = useMemo<RoleTab[]>(
    () =>
      (["directoryRole", "pimGroup", "azureRole"] as RoleTab[]).filter(
        (roleTab) => !hiddenPopupTabs.has(roleTab) && (isLoading || itemTypesWithData.has(roleTab))
      ),
    [hiddenPopupTabs, isLoading, itemTypesWithData]
  );
  const visibleTabs = useMemo<PopupTab[]>(() => {
    const tabs: PopupTab[] = [...roleTabs];
    if (!hiddenPopupTabs.has("bundles")) {
      tabs.push("bundles");
    }
    return tabs;
  }, [hiddenPopupTabs, roleTabs]);
  const favoriteIds = useMemo(() => new Set(settings.favoriteItemIds || []), [settings.favoriteItemIds]);
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

  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.includes(tab)) {
      setTab(visibleTabs[0]);
    }
  }, [tab, visibleTabs]);

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

  async function refresh(options: { force: boolean; showLoading?: boolean; suppressMessage?: boolean }) {
    const showLoading = options.showLoading !== false;
    if (showLoading) {
      setIsLoading(true);
      setLoadingProgress(LOADING_STEPS[0]);
    }
    if (!options.suppressMessage) {
      setError("");
    }
    try {
      const localDataPromise = Promise.all([
        loadSettings(),
        loadDataCache(),
        loadReferenceData()
      ]);
      const tokenPromise = sendMessage<TokenStatus>({ action: "getTokenStatus" });
      const [loadedSettings, currentCache, loadedReferenceData] = await localDataPromise;
      setLoadingProgress(LOADING_STEPS[1]);
      const loadedTokens = await tokenPromise;

      const now = Date.now();
      const tokenCacheKey = buildTokenCacheKey(loadedTokens);
      setLoadingProgress(LOADING_STEPS[2]);
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

      setLoadingProgress(LOADING_STEPS[3]);
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
      if (!options.suppressMessage) {
        setMessage(formatLoadMessages([...loadErrors, cacheMessage].filter(Boolean)).join("\n"));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
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

  async function toggleFavorite(itemId: string) {
    const favoriteItemIds = settings.favoriteItemIds.includes(itemId)
      ? settings.favoriteItemIds.filter((id) => id !== itemId)
      : [itemId, ...settings.favoriteItemIds];
    const updated = {
      ...settings,
      favoriteItemIds
    };
    try {
      await saveSettings(updated);
      setSettings(updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
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
      ticketSystem: ticketSystem || undefined,
      ticketNumber: ticketNumber || undefined
    };

    if (getActivationRequirements(activatableItems).needsJustification && !effectiveJustification.trim()) {
      setError("Enter a justification or choose a saved one.");
      return;
    }

    setIsActivating(true);
    setActivationProgress(ACTIVATION_STEPS[0]);
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
      setActivationProgress(ACTIVATION_STEPS[1]);
      const successItems = response.results
        .filter((result) => result.success)
        .map((result) => activatableItems.find((item) => item.id === result.itemId))
        .filter((item): item is ActivationItem => Boolean(item));

      let updatedSettings = addRecentJustification(settings, effectiveJustification);
      updatedSettings = recordActivations(updatedSettings, successItems, new Date().toISOString(), bundle?.name);
      await saveSettings(updatedSettings);
      setSettings(updatedSettings);
      setSelectedIds(new Set());
      setActivationProgress(ACTIVATION_STEPS[2]);
      if (response.errors.length) {
        setError(response.errors.map((item) => `${item.itemName}: ${item.error}`).join(" "));
      }
      if (successItems.length) {
        await refresh({ force: true, showLoading: false, suppressMessage: true });
      }
      setMessage(formatActivationConfirmation(successItems.length, response.errors.length));
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : String(activationError));
    } finally {
      setActivationProgress(null);
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
    setTicketSystem("");
    setTicketNumber("");
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

  function openSettingsSection(section: "access" | "bundles" | "preferences") {
    const url = chrome.runtime.getURL(`settings.html#${section}`);
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

  const activeTabIsVisible = visibleTabs.includes(tab);
  const currentRoleTab = activeTabIsVisible && roleTabs.includes(tab as RoleTab) ? tab as RoleTab : undefined;
  const portalUrl = activeTabIsVisible ? getPortalUrlForTab(tab) : undefined;
  const portalLabel = currentRoleTab ? tabLabel(currentRoleTab) : "Microsoft Entra";

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
          onFix={() => openSettingsSection("access")}
          onDetails={() => openSettingsSection("access")}
          onIgnore={() => void ignorePermissionWarning()}
        />
      ) : null}

      {visibleTabs.length ? (
        <nav className="tab-bar">
          {visibleTabs.map((visibleTab) => (
            <button className={`tab-button ${tab === visibleTab ? "active" : ""}`} onClick={() => setTab(visibleTab)} key={visibleTab}>
              {tabLabel(visibleTab)}
            </button>
          ))}
        </nav>
      ) : null}

      {error ? <p className="message error">{error}</p> : null}
      {message ? <p className="message">{message}</p> : null}
      {isLoading ? <LoadingState progress={loadingProgress} /> : null}
      {activationProgress ? <ActivationProgressPanel progress={activationProgress} /> : null}

      {currentRoleTab ? (
        <>
          <section className="toolbar">
            <div className="control-with-icon filter-field">
              <span className="field-icon" aria-hidden="true">
                <FilterIcon />
              </span>
              <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or scope" aria-label="Filter roles" />
            </div>
            <div className="control-with-icon sort-field">
              <span className="field-icon" aria-hidden="true">
                <SortIcon />
              </span>
              <select className="select" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Sort roles">
                <option value="name">Name</option>
                <option value="lastUsed">Last use</option>
                <option value="activationCount">Activation count</option>
                <option value="type">Type</option>
                <option value="scope">Scope</option>
              </select>
            </div>
          </section>
          <section className="content">
            <RoleList
              items={visibleEligibleItems}
              settings={settings}
              referenceData={referenceData}
              selectedIds={selectedIds}
              favoriteIds={favoriteIds}
              onToggle={toggleSelected}
              onToggleFavorite={(itemId) => void toggleFavorite(itemId)}
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
            onClearSelection={() => setSelectedIds(new Set())}
          />
        </>
      ) : null}

      {activeTabIsVisible && tab === "bundles" ? (
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
                      {isActivating ? "Activating..." : "Activate bundle"}
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState text="Create role bundles from Settings." />
          )}
          <button className="btn" onClick={() => openSettingsSection("bundles")}>
            Open settings
          </button>
        </section>
      ) : null}

      {!isLoading && !visibleTabs.length ? (
        <section className="content item-list empty-state">
          <p>No popup tabs are visible. Change hidden tab preferences in Settings or refresh data.</p>
          <button className="btn" onClick={() => openSettingsSection("preferences")}>
            Settings
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

function LoadingState({ progress }: { progress: LoadingProgress }) {
  return (
    <section className="loading-panel" aria-live="polite">
      <span className="spinner large" aria-hidden="true" />
      <span>
        Loading access data (step {progress.current}/{progress.total}): {progress.label}
      </span>
    </section>
  );
}

function ActivationProgressPanel({ progress }: { progress: LoadingProgress }) {
  return (
    <section className="activation-progress-panel" aria-live="polite">
      <span className="spinner large" aria-hidden="true" />
      <span>
        Activation in progress (step {progress.current}/{progress.total}): {progress.label}
      </span>
    </section>
  );
}

function RoleList({
  items,
  settings,
  referenceData,
  selectedIds,
  favoriteIds,
  onToggle,
  onToggleFavorite,
  readonly = false
}: {
  items: ActivationItem[];
  settings: QuickPimSettings;
  referenceData?: ReferenceDataCache;
  selectedIds: Set<string>;
  favoriteIds: Set<string>;
  onToggle?: (itemId: string) => void;
  onToggleFavorite?: (itemId: string) => void;
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
        const displayName = getDisplayName(item, settings, referenceData);
        const isFavorite = favoriteIds.has(item.id);
        const activeTitle = getActiveStatusTitle(item);
        const body = (
          <>
            <button
              type="button"
              className={`favorite-button ${isFavorite ? "active" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite?.(item.id);
              }}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-label={`${isFavorite ? "Remove" : "Add"} ${displayName} ${isFavorite ? "from" : "to"} favorites`}
            >
              <StarIcon filled={isFavorite} />
            </button>
            <div>
              <p className="role-title">
                <span>{displayName}</span>
                {isHighPrivilegeItem(item) ? <CrownIcon /> : null}
              </p>
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
          <div className={`role-row ${selected ? "selected" : ""}`} key={item.id}>
            <input type="checkbox" checked={selected} onChange={() => onToggle?.(item.id)} />
            {body}
          </div>
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
  onClearSelection: () => void;
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
            {props.isActivating ? "Activating..." : `Activate ${props.selectedCount} selected`}
          </button>
        ) : null}
        {hasSelection ? (
          <button className="btn subtle" onClick={props.onClearSelection} disabled={props.isActivating}>
            Unselect all
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

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="field-icon-svg">
      <path d="M4 5h16" />
      <path d="M7 12h10" />
      <path d="M10 19h4" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="field-icon-svg">
      <path d="M7 4v16" />
      <path d="M4 7l3-3 3 3" />
      <path d="M17 20V4" />
      <path d="M14 17l3 3 3-3" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="star-icon">
      <path d="m12 3.7 2.5 5.1 5.6.8-4 3.9.9 5.5-5-2.6-5 2.6.9-5.5-4-3.9 5.6-.8L12 3.7Z" fill={filled ? "currentColor" : "none"} />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="crown-icon">
      <path d="m3 7 5 4 4-7 4 7 5-4-2 12H5L3 7Z" />
      <path d="M5 19h14" />
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

function formatActivationConfirmation(successCount: number, errorCount: number): string {
  const itemLabel = (count: number) => `item${count === 1 ? "" : "s"}`;
  if (successCount && !errorCount) {
    return `Activation confirmed for ${successCount} ${itemLabel(successCount)}.`;
  }
  if (successCount && errorCount) {
    return `Activation confirmed for ${successCount} ${itemLabel(successCount)}; ${errorCount} failed.`;
  }
  return `Activation failed for ${errorCount} ${itemLabel(errorCount)}.`;
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
  if (!response?.success) {
    throw new Error(response?.error || "QuickPIM background request failed.");
  }
  return response.data as T;
}

createRoot(document.getElementById("root")!).render(<PopupApp />);
