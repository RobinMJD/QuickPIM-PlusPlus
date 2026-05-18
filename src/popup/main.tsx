import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
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

type Tab = "eligible" | "active" | "bundles";
type FilterType = "all" | ActivationItem["type"];

interface MessageResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function PopupApp() {
  const [tab, setTab] = useState<Tab>("eligible");
  const [settings, setSettings] = useState<QuickPimSettings>(DEFAULT_SETTINGS);
  const [eligibleItems, setEligibleItems] = useState<ActivationItem[]>([]);
  const [activeItems, setActiveItems] = useState<ActivationItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [durationHours, setDurationHours] = useState(1);
  const [justification, setJustification] = useState("");
  const [ticketSystem, setTicketSystem] = useState("");
  const [ticketNumber, setTicketNumber] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isActivating, setIsActivating] = useState(false);

  useEffect(() => {
    void refresh();
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

  const visibleEligibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = eligibleItems.filter((item) => {
      const matchesType = filterType === "all" || item.type === filterType;
      const name = getDisplayName(item, settings).toLowerCase();
      const scope = item.scopeLabel.toLowerCase();
      return matchesType && (!term || name.includes(term) || scope.includes(term));
    });
    return sortItems(filtered, settings, sortMode);
  }, [eligibleItems, filterType, search, settings, sortMode]);

  async function refresh() {
    setIsLoading(true);
    setError("");
    try {
      const [loadedSettings, loadedTokens, eligible, active] = await Promise.all([
        loadSettings(),
        sendMessage<TokenStatus>({ action: "getTokenStatus" }),
        sendMessage<{ items: ActivationItem[]; errors: string[] }>({ action: "getActivationItems" }),
        sendMessage<{ items: ActivationItem[]; errors: string[] }>({ action: "getActiveItems" })
      ]);
      setSettings(loadedSettings);
      setTokenStatus(loadedTokens);
      setEligibleItems(applyAliases(eligible.items, loadedSettings));
      setActiveItems(applyAliases(active.items, loadedSettings));
      setMessage([...(eligible.errors || []), ...(active.errors || [])].filter(Boolean).join(" "));
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
    if (!effectiveJustification.trim()) {
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
      await refresh();
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
    setTab("eligible");
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM</h1>
            <p>{isLoading ? "Loading access state" : `${eligibleItems.length} eligible items`}</p>
          </div>
        </div>
        <div className="status-stack">
          <TokenPill label="Graph" status={tokenStatus?.graph} />
          <TokenPill label="Azure" status={tokenStatus?.azureManagement} />
        </div>
      </header>

      <nav className="tab-bar">
        <button className={`tab-button ${tab === "eligible" ? "active" : ""}`} onClick={() => setTab("eligible")}>
          Eligible
        </button>
        <button className={`tab-button ${tab === "active" ? "active" : ""}`} onClick={() => setTab("active")}>
          Active
        </button>
        <button className={`tab-button ${tab === "bundles" ? "active" : ""}`} onClick={() => setTab("bundles")}>
          Bundles
        </button>
      </nav>

      {error ? <p className="message error">{error}</p> : null}
      {message ? <p className="message">{message}</p> : null}

      {tab === "eligible" ? (
        <>
          <section className="toolbar">
            <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or scope" />
            <button className="btn" onClick={() => void refresh()} disabled={isLoading}>
              Refresh
            </button>
          </section>
          <section className="filter-row">
            <select className="select" value={filterType} onChange={(event) => setFilterType(event.target.value as FilterType)}>
              <option value="all">All types</option>
              <option value="directoryRole">Entra roles</option>
              <option value="azureRole">Azure roles</option>
              <option value="pimGroup">PIM groups</option>
            </select>
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
  const className = !status?.hasToken ? "token-pill warn" : status.isExpired ? "token-pill warn" : "token-pill ok";
  const text = !status?.hasToken ? "missing" : status.isExpired ? "expired" : `${status.tokenAge}m`;
  return (
    <span className={className}>
      {label}: {text}
    </span>
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
        return (
          <label className={`role-row ${selected ? "selected" : ""}`} key={item.id}>
            <input type="checkbox" checked={selected} disabled={readonly} onChange={() => onToggle?.(item.id)} />
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
  selectedCount: number;
  isActivating: boolean;
  onActivate: () => void;
  onSaveJustification: () => void;
}) {
  const justificationOptions = [...props.settings.savedJustifications, ...props.settings.recentJustifications];
  return (
    <section className="activation-bar">
      <div className="activation-grid">
        <input
          className="input"
          type="number"
          min="0.5"
          max="24"
          step="0.5"
          value={props.durationHours}
          onChange={(event) => props.setDurationHours(Number(event.target.value))}
          title="Duration in hours"
        />
        <input
          className="input"
          value={props.justification}
          onChange={(event) => props.setJustification(event.target.value)}
          placeholder="Justification"
        />
      </div>
      {justificationOptions.length ? (
        <div className="chip-row">
          {justificationOptions.slice(0, 4).map((item) => (
            <button className="justification-chip" key={item} onClick={() => props.setJustification(item)}>
              {item}
            </button>
          ))}
        </div>
      ) : null}
      <div className="activation-grid" style={{ marginTop: 8 }}>
        <input className="input" value={props.ticketSystem} onChange={(event) => props.setTicketSystem(event.target.value)} placeholder="Ticket system" />
        <input className="input" value={props.ticketNumber} onChange={(event) => props.setTicketNumber(event.target.value)} placeholder="Ticket number" />
      </div>
      <div className="button-row">
        <button className="btn subtle" onClick={props.onSaveJustification} disabled={!props.justification.trim()}>
          Save justification
        </button>
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
