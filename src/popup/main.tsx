import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  formatCacheAge,
  getDataWithCache,
  loadDataCache,
  saveDataCache
} from "../lib/cache";
import {
  formatLoadMessages,
  getActivationRequirements,
  getDurationOptions,
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
  getUsage,
  loadSettings,
  recordActivations,
  saveSettings,
  sortItems
} from "../lib/settings";
import type {
  ActivationItem,
  ActivationResponse,
  QuickPimBundle,
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

  const itemsById = useMemo(() => new Map(eligibleItems.map((item) => [item.id, item])), [eligibleItems]);
  const selectedItems = useMemo(
    () => [...selectedIds].map((id) => itemsById.get(id)).filter((item): item is ActivationItem => Boolean(item)),
    [itemsById, selectedIds]
  );
  const requirements = useMemo(() => getActivationRequirements(selectedItems), [selectedItems]);

  const visibleEligibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = eligibleItems.filter((item) => {
      const matchesType = item.type === tab;
      const name = getDisplayName(item, settings).toLowerCase();
      const scope = item.scopeLabel.toLowerCase();
      return matchesType && (!term || name.includes(term) || scope.includes(term));
    });
    return sortItems(filtered, settings, sortMode);
  }, [eligibleItems, search, settings, sortMode, tab]);

  async function refresh(options: { force: boolean }) {
    setIsLoading(true);
    setError("");
    try {
      const [loadedSettings, loadedTokens, currentCache] = await Promise.all([
        loadSettings(),
        sendMessage<TokenStatus>({ action: "getTokenStatus" }),
        loadDataCache()
      ]);
      const { entry: eligible, fromCache: eligibleFromCache, cache: nextEligibleCache } = await getDataWithCache(
        "eligible",
        currentCache,
        DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        options.force,
        () => sendMessage<{ items: ActivationItem[]; errors: string[] }>({ action: "getActivationItems" })
      );
      const { entry: active, fromCache: activeFromCache, cache: nextCache } = await getDataWithCache(
        "active",
        nextEligibleCache,
        DEFAULT_ACTIVE_CACHE_TTL_MS,
        options.force,
        () => sendMessage<{ items: ActivationItem[]; errors: string[] }>({ action: "getActiveItems" })
      );

      if (!eligibleFromCache || !activeFromCache) {
        await saveDataCache(nextCache);
      }

      setSettings(loadedSettings);
      setTokenStatus(loadedTokens);
      setEligibleItems(applyAliases(eligible.items, loadedSettings));
      setActiveItems(applyAliases(active.items, loadedSettings));
      const cacheMessage =
        eligibleFromCache && activeFromCache
          ? `Using cached data from ${formatCacheAge(Math.min(eligible.fetchedAt, active.fetchedAt))}.`
          : options.force
            ? "Forced refresh completed."
            : "";
      setMessage(formatLoadMessages([...(eligible.errors || []), ...(active.errors || []), cacheMessage].filter(Boolean)).join("\n"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }

  function toggleSelected(itemId: string) {
    setSelectedIds((current) => {
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
    const effectiveJustification = bundle?.defaultJustification || justification;
    const effectiveDuration = bundle?.defaultDurationHours || durationHours;
    const effectiveTicketInfo: TicketInfo = {
      ticketSystem: bundle?.defaultTicketSystem || ticketSystem || undefined,
      ticketNumber: bundle?.defaultTicketNumber || ticketNumber || undefined
    };

    if (!items.length) {
      setError("Select at least one role or group.");
      return;
    }
    if (getActivationRequirements(items).needsJustification && !effectiveJustification.trim()) {
      setError("Enter a justification or choose a saved one.");
      return;
    }

    setIsActivating(true);
    setError("");
    setMessage("");
    try {
      const response = await sendMessage<ActivationResponse>({
        action: "activateItems",
        items,
        durationHours: effectiveDuration,
        justification: effectiveJustification,
        ticketInfo: effectiveTicketInfo
      });
      const successItems = response.results
        .filter((result) => result.success)
        .map((result) => items.find((item) => item.id === result.itemId))
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
    const expansion = expandBundle(bundle, eligibleItems);
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

  const roleTabs: RoleTab[] = ["directoryRole", "pimGroup", "azureRole"];
  const portalUrl = getPortalUrlForTab(tab);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM</h1>
            <p>
              {isLoading ? (
                <span className="loading-inline">
                  <span className="spinner" aria-hidden="true" />
                  Loading access state
                </span>
              ) : (
                `${eligibleItems.length} eligible items`
              )}
            </p>
          </div>
        </div>
        <div className="status-stack">
          <TokenPill label="Graph" status={tokenStatus?.graph} />
          <TokenPill label="Azure" status={tokenStatus?.azureManagement} />
        </div>
      </header>

      <nav className="tab-bar">
        {roleTabs.map((roleTab) => (
          <button className={`tab-button ${tab === roleTab ? "active" : ""}`} onClick={() => setTab(roleTab)} key={roleTab}>
            {tabLabel(roleTab)}
          </button>
        ))}
        <button className={`tab-button ${tab === "active" ? "active" : ""}`} onClick={() => setTab("active")}>
          Active
        </button>
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
            <button className="btn icon-btn" onClick={() => void refresh({ force: true })} disabled={isLoading} title="Force refresh all data" aria-label="Force refresh all data">
              <RefreshIcon />
            </button>
            <button className="btn icon-btn" onClick={openPortalForCurrentTab} disabled={!portalUrl} title={`Open ${tabLabel(tab)} in Microsoft Entra`} aria-label={`Open ${tabLabel(tab)} in Microsoft Entra`}>
              <LinkIcon />
            </button>
          </section>
          <section className="filter-row">
            <select className="select" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
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
            selectedCount={selectedItems.length}
            isActivating={isActivating}
            onActivate={() => void activate(selectedItems)}
            onSaveJustification={() => void saveCurrentJustification()}
          />
        </>
      ) : null}

      {tab === "active" ? (
        <section className="content">
          <RoleList items={sortItems(activeItems, settings, "name")} settings={settings} selectedIds={new Set()} readonly />
        </section>
      ) : null}

      {tab === "bundles" ? (
        <section className="content item-list">
          {settings.bundles.length ? (
            settings.bundles.map((bundle) => {
              const expansion = expandBundle(bundle, eligibleItems);
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
  selectedIds,
  onToggle,
  readonly = false
}: {
  items: ActivationItem[];
  settings: QuickPimSettings;
  selectedIds: Set<string>;
  onToggle?: (itemId: string) => void;
  readonly?: boolean;
}) {
  if (!items.length) {
    return <EmptyState text={readonly ? "No active roles or groups found." : "No eligible roles or groups found."} />;
  }

  return (
    <div className="item-list">
      {items.map((item) => {
        const usage = getUsage(item, settings);
        const selected = selectedIds.has(item.id);
        const body = (
          <>
            <div>
              <p className="role-title">{getDisplayName(item, settings)}</p>
              <div className="role-meta">
                <span className={`badge ${item.type}`}>{typeLabel(item.type)}</span>
                <span>{item.scopeLabel}</span>
                <span>{usage.activationCount} activations</span>
                {usage.lastUsedAt ? <span>last {new Date(usage.lastUsedAt).toLocaleDateString()}</span> : null}
              </div>
            </div>
            <span className="badge">{item.status}</span>
          </>
        );

        if (readonly) {
          return (
            <div className="role-row readonly" key={item.id}>
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
  selectedCount: number;
  isActivating: boolean;
  onActivate: () => void;
  onSaveJustification: () => void;
}) {
  const justificationOptions = [...props.settings.savedJustifications, ...props.settings.recentJustifications];
  const durationOptions = getDurationOptions();
  return (
    <section className="activation-bar">
      <div className="field">
        <label>Activation time</label>
        <select
          className="select"
          value={String(props.durationHours)}
          onChange={(event) => props.setDurationHours(Number(event.target.value))}
          title="Activation duration"
        >
          {durationOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {props.requirements.needsJustification ? (
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
      {props.requirements.needsJustification && justificationOptions.length ? (
        <div className="chip-row">
          {justificationOptions.slice(0, 4).map((item) => (
            <button className="justification-chip" key={item} onClick={() => props.setJustification(item)}>
              {item}
            </button>
          ))}
        </div>
      ) : null}
      {props.requirements.needsTicket ? (
        <div className="activation-grid" style={{ marginTop: 8 }}>
          <input className="input" value={props.ticketSystem} onChange={(event) => props.setTicketSystem(event.target.value)} placeholder="Ticket system" />
          <input className="input" value={props.ticketNumber} onChange={(event) => props.setTicketNumber(event.target.value)} placeholder="Ticket number" />
        </div>
      ) : null}
      <div className="button-row">
        {props.requirements.needsJustification ? (
          <button className="btn subtle" onClick={props.onSaveJustification} disabled={!props.justification.trim()}>
            Save justification
          </button>
        ) : null}
        <button className="btn primary" onClick={props.onActivate} disabled={!props.selectedCount || props.isActivating}>
          Activate {props.selectedCount || ""} selected
        </button>
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

function applyAliases(items: ActivationItem[], settings: QuickPimSettings): ActivationItem[] {
  return items.map((item) => ({ ...item, displayName: getDisplayName(item, settings) }));
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
