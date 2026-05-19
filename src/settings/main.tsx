import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { buildAccessCapabilityItems, buildTokenCacheKey, getAccessSetupTargets, getPortalUrlsForTargets } from "../lib/access";
import { DEFAULT_ELIGIBLE_CACHE_TTL_MS, formatCacheAge, getDataWithCache, loadDataCache, saveDataCache } from "../lib/cache";
import { coerceDurationForItems, getDurationOptions, tabLabel as popupTabLabel } from "../lib/popupModel";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  createBundleId,
  getDisplayName,
  getUsage,
  getScopeLabel,
  loadSettings,
  mergeSettings,
  saveSettings
} from "../lib/settings";
import {
  applyReferenceDataToItems,
  clearReferenceData,
  learnReferenceDataFromItems,
  loadReferenceData,
  saveReferenceData
} from "../lib/referenceData";
import {
  GENERIC_JUSTIFICATION_WARNING,
  getGenericJustificationWarning
} from "../lib/justifications";
import type { AccessSetupTarget, ActivationItem, PopupTab, QuickPimBundle, QuickPimDataCache, QuickPimSettings, ReferenceDataCache, SortMode, TokenStatus } from "../lib/types";

type SettingsTab = "about" | "access" | "aliases" | "justifications" | "bundles" | "preferences" | "data";

const ORIGINAL_AUTHOR = "Daniel Bradley";
const REPOSITORY_URL = "https://github.com/RobinMJD/QuickPIM";

interface MessageResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function SettingsApp() {
  const [tab, setTab] = useState<SettingsTab>(() => tabFromHash());
  const [settings, setSettings] = useState<QuickPimSettings>(DEFAULT_SETTINGS);
  const [items, setItems] = useState<ActivationItem[]>([]);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [dataCache, setDataCache] = useState<QuickPimDataCache>({});
  const [referenceData, setReferenceData] = useState<ReferenceDataCache | undefined>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [exportText, setExportText] = useState("");
  const [isRefreshingEligible, setIsRefreshingEligible] = useState(false);
  const [isRefreshingAccess, setIsRefreshingAccess] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    document.body.classList.toggle("dark-mode", settings.preferences.darkMode);
  }, [settings.preferences.darkMode]);

  useEffect(() => {
    function handleHashChange() {
      setTab(tabFromHash());
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  async function refresh(options: { showProgress?: boolean } = {}) {
    if (options.showProgress) {
      setIsRefreshingEligible(true);
      setMessage("Refreshing eligible items...");
    }
    setError("");
    try {
      const [loadedSettings, loadedTokens, loadedCache, loadedReferenceData] = await Promise.all([
        loadSettings(),
        sendMessage<TokenStatus>({ action: "getTokenStatus" }),
        loadDataCache(),
        loadReferenceData()
      ]);
      const tokenCacheKey = buildTokenCacheKey(loadedTokens);
      const eligible = await getDataWithCache(
        "eligible",
        loadedCache,
        DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        Boolean(options.showProgress),
        () => sendMessage<{ items: ActivationItem[]; errors: string[]; diagnostics?: any[] }>({ action: "getActivationItems" }),
        Date.now(),
        tokenCacheKey
      );
      const cachedActive = loadedCache.active?.cacheKey === tokenCacheKey ? loadedCache.active : undefined;
      const nextCache: QuickPimDataCache = {
        ...(eligible.cache.eligible ? { eligible: eligible.cache.eligible } : {}),
        ...(cachedActive ? { active: cachedActive } : {})
      };
      if (!eligible.fromCache || loadedCache.active !== cachedActive) {
        await saveDataCache(nextCache);
      }
      const nextReferenceData = learnReferenceDataFromItems(loadedReferenceData, eligible.entry.items);
      await saveReferenceData(nextReferenceData);
      setSettings(loadedSettings);
      setItems(applyDisplayData(eligible.entry.items, loadedSettings, nextReferenceData));
      setTokenStatus(loadedTokens);
      setDataCache(nextCache);
      setReferenceData(nextReferenceData);
      setExportText(JSON.stringify(loadedSettings, null, 2));
      if (options.showProgress) {
        setMessage(
          eligible.fromCache
            ? `Using cached eligible items from ${formatCacheAge(eligible.entry.fetchedAt)}.`
            : "Eligible items refreshed."
        );
      }
    } catch (loadError) {
      if (options.showProgress) {
        setMessage("");
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (options.showProgress) {
        setIsRefreshingEligible(false);
      }
    }
  }

  async function forceRefreshAccessData(tokens?: TokenStatus) {
    setIsRefreshingAccess(true);
    setError("");
    setMessage("Refreshing access data...");
    try {
      const latestTokens = tokens ?? await sendMessage<TokenStatus>({ action: "getTokenStatus" });
      const tokenCacheKey = buildTokenCacheKey(latestTokens);
      const [eligible, active] = await Promise.all([
        sendMessage<{ items: ActivationItem[]; errors: string[]; diagnostics?: any[] }>({ action: "getActivationItems" }),
        sendMessage<{ items: ActivationItem[]; errors: string[]; diagnostics?: any[] }>({ action: "getActiveItems" })
      ]);
      const fetchedAt = Date.now();
      const nextCache: QuickPimDataCache = {
        eligible: { ...eligible, fetchedAt, cacheKey: tokenCacheKey },
        active: { ...active, fetchedAt, cacheKey: tokenCacheKey }
      };
      await saveDataCache(nextCache);
      const nextReferenceData = learnReferenceDataFromItems(referenceData || await loadReferenceData(), [
        ...eligible.items,
        ...active.items
      ]);
      await saveReferenceData(nextReferenceData);
      setTokenStatus(latestTokens);
      setDataCache(nextCache);
      setReferenceData(nextReferenceData);
      setItems(applyDisplayData(eligible.items, settings, nextReferenceData));
      const limitedAreas = buildAccessCapabilityItems(latestTokens, nextCache).filter((item) => item.status !== "ready").length;
      setMessage(
        limitedAreas
          ? `Access data refreshed. ${limitedAreas} area(s) still need portal access or are limited by the captured portal token.`
          : "Access data refreshed."
      );
    } catch (refreshError) {
      setMessage("");
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setIsRefreshingAccess(false);
    }
  }

  async function persist(next: QuickPimSettings, successMessage = "Settings saved.") {
    const merged = mergeSettings(next);
    await saveSettings(merged);
    setSettings(merged);
    setExportText(JSON.stringify(merged, null, 2));
    setMessage(successMessage);
  }

  async function clearCapturedTokens() {
    await sendMessage<boolean>({ action: "clearToken" });
    setTokenStatus({
      graph: { hasToken: false },
      azureManagement: { hasToken: false }
    });
    setMessage("Captured tokens cleared.");
  }

  async function clearLearnedReferences() {
    await clearReferenceData();
    setReferenceData(undefined);
    setMessage("Learned names cleared.");
  }

  function selectTab(nextTab: SettingsTab) {
    setTab(nextTab);
    if (window.location.hash !== `#${nextTab}`) {
      window.history.replaceState(null, "", `#${nextTab}`);
    }
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM Settings</h1>
            <p>Aliases, saved reasons, bundles, and local preferences.</p>
          </div>
        </div>
        <button className="btn" onClick={() => void refresh({ showProgress: true })} disabled={isRefreshingEligible}>
          {isRefreshingEligible ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>Refreshing eligible items...</span>
            </span>
          ) : (
            "Refresh eligible items"
          )}
        </button>
      </header>

      <section className="settings-content">
        {error ? <p className="message error">{error}</p> : null}
        {message ? <p className="message">{message}</p> : null}
        <div className="settings-layout">
          <nav className="settings-nav">
            {(["about", "access", "aliases", "justifications", "bundles", "preferences", "data"] as SettingsTab[]).map((item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>
                {tabLabel(item)}
              </button>
            ))}
          </nav>
          <div>
            {tab === "about" ? <AboutPanel tokenStatus={tokenStatus} onClearTokens={() => void clearCapturedTokens()} /> : null}
            {tab === "access" ? (
              <AccessSetupPanel
                settings={settings}
                tokenStatus={tokenStatus}
                dataCache={dataCache}
                isRefreshingAccess={isRefreshingAccess}
                onSave={persist}
                onRefreshAccessData={forceRefreshAccessData}
                onClearReferenceData={clearLearnedReferences}
              />
            ) : null}
            {tab === "aliases" ? <AliasesPanel settings={settings} items={items} referenceData={referenceData} onSave={persist} /> : null}
            {tab === "justifications" ? <JustificationsPanel settings={settings} onSave={persist} /> : null}
            {tab === "bundles" ? <BundlesPanel settings={settings} items={items} referenceData={referenceData} onSave={persist} /> : null}
            {tab === "preferences" ? <PreferencesPanel settings={settings} onSave={persist} /> : null}
            {tab === "data" ? (
              <DataPanel
                settings={settings}
                exportText={exportText}
                setExportText={setExportText}
                onSave={persist}
                onClearMessage={() => setMessage("")}
              />
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function AboutPanel({
  tokenStatus,
  onClearTokens
}: {
  tokenStatus: TokenStatus | null;
  onClearTokens: () => void;
}) {
  const manifest = chrome.runtime.getManifest();
  return (
    <section className="panel about-panel">
      <div>
        <h2>{manifest.name} {manifest.version}</h2>
        <p className="muted">Quick activation for Microsoft Entra roles, Azure roles, and PIM groups.</p>
      </div>
      <div className="about-grid">
        <div>
          <strong>Original author: {ORIGINAL_AUTHOR}</strong>
          <p className="muted">v2 continues the QuickPIM project with the React rewrite, PIM groups, bundles, and security hardening.</p>
        </div>
        <div>
          <strong>Privacy</strong>
          <p className="muted">Tokens and settings stay in this browser profile. QuickPIM only calls Microsoft Graph and Azure Management APIs.</p>
        </div>
        <div>
          <strong>Repository</strong>
          <p className="muted">
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              {REPOSITORY_URL}
            </a>
          </p>
        </div>
        <div>
          <strong>Captured tokens</strong>
          <p className="muted">
            Graph: {tokenStatus?.graph.hasToken ? "captured" : "missing"} / Azure:{" "}
            {tokenStatus?.azureManagement.hasToken ? "captured" : "missing"}
          </p>
          <button className="btn danger settings-inline-action" onClick={onClearTokens}>
            Clear captured tokens
          </button>
        </div>
      </div>
    </section>
  );
}

function AccessSetupPanel({
  settings,
  tokenStatus,
  dataCache,
  isRefreshingAccess,
  onSave,
  onRefreshAccessData,
  onClearReferenceData
}: {
  settings: QuickPimSettings;
  tokenStatus: TokenStatus | null;
  dataCache: QuickPimDataCache;
  isRefreshingAccess: boolean;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<void>;
  onRefreshAccessData: (tokens?: TokenStatus) => Promise<void>;
  onClearReferenceData: () => Promise<void>;
}) {
  const [isRunningSetup, setIsRunningSetup] = useState(false);
  const accessStatus = useMemo(() => buildAccessCapabilityItems(tokenStatus, dataCache), [dataCache, tokenStatus]);
  const setupTargets = useMemo(() => getAccessSetupTargets(accessStatus), [accessStatus]);
  const warningIgnored = Boolean(settings.preferences.permissionWarningIgnored);

  async function setIgnored(ignored: boolean) {
    await onSave(
      {
        ...settings,
        preferences: {
          ...settings.preferences,
          permissionWarningIgnored: ignored,
          permissionWarningIgnoredAt: ignored ? new Date().toISOString() : undefined
        }
      },
      ignored ? "Permission warning ignored." : "Permission warning enabled."
    );
  }

  async function runPortalSetup() {
    const targets = setupTargets;
    const urls = getPortalUrlsForTargets(targets);
    for (const url of urls) {
      if (chrome.tabs?.create) {
        void chrome.tabs.create({ url });
      } else {
        window.open(url, "_blank", "noopener");
      }
    }

    setIsRunningSetup(true);
    try {
      const latestTokens = await waitForPortalTokens(targets);
      await onRefreshAccessData(latestTokens);
    } finally {
      setIsRunningSetup(false);
    }
  }

  async function waitForPortalTokens(targets: AccessSetupTarget[]): Promise<TokenStatus> {
    let latestTokens = tokenStatus || await sendMessage<TokenStatus>({ action: "getTokenStatus" });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      latestTokens = await sendMessage<TokenStatus>({ action: "getTokenStatus" });
      if (targets.every((target) => hasRequiredPortalToken(target, latestTokens))) {
        return latestTokens;
      }
      await delay(3000);
    }
    return latestTokens;
  }

  return (
    <section className="panel permissions-panel">
      <div className="panel-title-row">
        <div>
          <h2>Access Setup</h2>
          <p className="muted">
            {setupTargets.length
              ? `${setupTargets.length} area(s) need a portal refresh or are limited by the captured portal token.`
              : "QuickPIM can use the currently captured portal tokens for all feature areas."}
          </p>
        </div>
        <button className={`btn ${warningIgnored ? "" : "subtle"}`} onClick={() => void setIgnored(!warningIgnored)}>
          {warningIgnored ? "Show access warning" : "Ignore access warning"}
        </button>
      </div>

      <div className="button-row settings-action-lead">
        <button className="btn primary" onClick={() => void runPortalSetup()} disabled={isRunningSetup || isRefreshingAccess || !setupTargets.length}>
          {isRunningSetup ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>Checking portal access...</span>
            </span>
          ) : (
            "Open missing portal pages"
          )}
        </button>
        <button className="btn" onClick={() => void onRefreshAccessData()} disabled={isRunningSetup || isRefreshingAccess}>
          {isRefreshingAccess ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>Rechecking access...</span>
            </span>
          ) : (
            "Recheck now"
          )}
        </button>
        <button className="btn danger" onClick={() => void onClearReferenceData()}>
          Clear learned names
        </button>
      </div>
      {isRunningSetup ? (
        <section className="loading-panel" aria-live="polite">
          <span className="spinner large" aria-hidden="true" />
          <span>Waiting for Microsoft portal token capture...</span>
        </section>
      ) : null}
      {isRefreshingAccess ? (
        <section className="loading-panel" aria-live="polite">
          <span className="spinner large" aria-hidden="true" />
          <span>Refreshing access data...</span>
        </section>
      ) : null}
      <p className="muted">
        QuickPIM only uses tokens captured from Microsoft portal pages. If a page asks you to sign in or load PIM data, complete that
        step in the opened tab, then return here.
      </p>

      <div className="permission-list">
        {accessStatus.map((item) => (
          <AccessStatusRow item={item} key={item.target} />
        ))}
      </div>

      <div className="panel">
        <h3>Quick Tutorial</h3>
        <ol className="tutorial-list">
          <li>Use Open missing portal pages to open the Microsoft pages that normally request the needed Graph or Azure tokens.</li>
          <li>Let the portal pages finish loading. Switch to them if sign-in, tenant selection, or page consent is required.</li>
          <li>Return to QuickPIM and use Recheck now if the automatic refresh has not picked up the new portal token yet.</li>
          <li>QuickPIM keeps learned role, group, subscription, and scope names locally so old friendly names can still be displayed later.</li>
        </ol>
      </div>
    </section>
  );
}

function AccessStatusRow({ item }: { item: ReturnType<typeof buildAccessCapabilityItems>[number] }) {
  return (
    <article className={`permission-row ${item.status === "ready" ? "ok" : "missing"}`}>
      <div className="permission-row-header">
        <span className={`permission-state ${item.status === "ready" ? "ok" : "missing"}`}>{statusLabel(item.status)}</span>
        <div>
          <h3>{item.label}</h3>
          <p>{item.target === "azureRole" ? "Azure Management portal token" : "Microsoft Graph portal token"}</p>
        </div>
      </div>
      <div className="permission-detail-grid">
        <div>
          <strong>Status</strong>
          <p>{item.detail}</p>
        </div>
        <div>
          <strong>{item.status === "ready" ? "Last success" : "What is limited"}</strong>
          <p>{item.status === "ready" ? item.lastSuccessAt || "Token is available." : item.lastError || "Open the matching portal page to refresh access."}</p>
        </div>
      </div>
    </article>
  );
}

function statusLabel(status: ReturnType<typeof buildAccessCapabilityItems>[number]["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "limited") return "Limited";
  return "Needs portal refresh";
}

function hasRequiredPortalToken(target: AccessSetupTarget, tokenStatus: TokenStatus): boolean {
  return target === "azureRole"
    ? Boolean(tokenStatus.azureManagement.hasToken && !tokenStatus.azureManagement.isExpired)
    : Boolean(tokenStatus.graph.hasToken && !tokenStatus.graph.isExpired);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function AliasesPanel({
  settings,
  items,
  referenceData,
  onSave
}: {
  settings: QuickPimSettings;
  items: ActivationItem[];
  referenceData?: ReferenceDataCache;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<void>;
}) {
  const [itemId, setItemId] = useState("");
  const [alias, setAlias] = useState("");
  const selectedItem = items.find((item) => item.id === itemId);

  async function saveAlias() {
    if (!selectedItem || !alias.trim()) return;
    await onSave({
      ...settings,
      aliasesByItemId: {
        ...settings.aliasesByItemId,
        [selectedItem.id]: alias.trim()
      }
    });
    setAlias("");
  }

  async function removeAlias(id: string) {
    const aliasesByItemId = { ...settings.aliasesByItemId };
    delete aliasesByItemId[id];
    await onSave({ ...settings, aliasesByItemId });
  }

  return (
    <section className="panel">
      <h2>Custom Role Names</h2>
      <div className="form-grid">
        <div className="field">
          <label>Role or group</label>
          <select className="select" value={itemId} onChange={(event) => setItemId(event.target.value)}>
            <option value="">Choose an eligible item</option>
            {items.map((item) => (
              <option value={item.id} key={item.id}>
                {getDisplayName(item, settings, referenceData)} / {getScopeLabel(item, referenceData)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Alias</label>
          <input className="input" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="Display name" />
        </div>
      </div>
      <div className="button-row settings-form-actions">
        <button className="btn primary" onClick={() => void saveAlias()} disabled={!itemId || !alias.trim()}>
          Save alias
        </button>
      </div>
      <div className="panel">
        <h3>Saved aliases</h3>
        {Object.entries(settings.aliasesByItemId).length ? (
          Object.entries(settings.aliasesByItemId).map(([id, value]) => (
            <div className="alias-row" key={id}>
              <div>
                <strong>{value}</strong>
                <p className="muted">{items.find((item) => item.id === id)?.sourceName || id}</p>
              </div>
              <button className="btn danger" onClick={() => void removeAlias(id)}>
                Remove
              </button>
            </div>
          ))
        ) : (
          <p className="muted">No aliases saved yet.</p>
        )}
      </div>
    </section>
  );
}

function JustificationsPanel({
  settings,
  onSave
}: {
  settings: QuickPimSettings;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [validationWarning, setValidationWarning] = useState("");

  async function add() {
    const trimmed = value.trim();
    if (!trimmed) return;
    const genericJustificationWarning = getGenericJustificationWarning(trimmed);
    if (genericJustificationWarning) {
      setValidationWarning(genericJustificationWarning);
      return;
    }
    setValidationWarning("");
    const exists = settings.savedJustifications.some((item) => item.toLowerCase() === trimmed.toLowerCase());
    await onSave({
      ...settings,
      savedJustifications: exists ? settings.savedJustifications : [trimmed, ...settings.savedJustifications]
    });
    setValue("");
  }

  async function removeSaved(target: string) {
    await onSave({
      ...settings,
      savedJustifications: settings.savedJustifications.filter((item) => item !== target)
    });
  }

  return (
    <section className="panel">
      <h2>Justifications</h2>
      <div className="form-row">
        <input
          className="input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (validationWarning) setValidationWarning("");
          }}
          placeholder="Reusable justification"
        />
        <button className="btn primary" onClick={() => void add()} disabled={!value.trim()}>
          Add
        </button>
      </div>
      <p className="field-warning settings-field-gap">{validationWarning || GENERIC_JUSTIFICATION_WARNING}</p>
      <div className="two-column settings-section-gap">
        <div className="panel">
          <h3>Saved</h3>
          {settings.savedJustifications.map((item) => (
            <div className="settings-row" key={item}>
              <span>{item}</span>
              <button className="btn danger" onClick={() => void removeSaved(item)}>
                Remove
              </button>
            </div>
          ))}
          {!settings.savedJustifications.length ? <p className="muted">No saved justifications.</p> : null}
        </div>
        <div className="panel">
          <h3>Recent</h3>
          {settings.recentJustifications.map((item) => (
            <div className="settings-row" key={item}>
              <span>{item}</span>
            </div>
          ))}
          <button className="btn danger" onClick={() => void onSave({ ...settings, recentJustifications: [] }, "Recent history cleared.")}>
            Clear recent
          </button>
        </div>
      </div>
    </section>
  );
}

function BundlesPanel({
  settings,
  items,
  referenceData,
  onSave
}: {
  settings: QuickPimSettings;
  items: ActivationItem[];
  referenceData?: ReferenceDataCache;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [durationHours, setDurationHours] = useState(settings.preferences.defaultDurationHours);
  const [justification, setJustification] = useState("");
  const [editingBundleId, setEditingBundleId] = useState<string | undefined>();
  const [draftMode, setDraftMode] = useState<"create" | "edit" | "duplicate">("create");
  const [draftSourceName, setDraftSourceName] = useState("");
  const [validationWarning, setValidationWarning] = useState("");
  const sortedItems = useMemo(
    () => [...items].sort((a, b) => getDisplayName(a, settings, referenceData).localeCompare(getDisplayName(b, settings, referenceData))),
    [items, referenceData, settings]
  );
  const selectedItems = useMemo(
    () => items.filter((item) => selectedItemIds.has(item.id)),
    [items, selectedItemIds]
  );
  const durationOptions = useMemo(() => getDurationOptions(selectedItems), [selectedItems]);

  useEffect(() => {
    if (durationOptions.length) {
      setDurationHours((current) => coerceDurationForItems(current, selectedItems));
    }
  }, [durationOptions, selectedItems]);

  async function saveBundle() {
    if (!name.trim() || !selectedItemIds.size) return;
    const genericJustificationWarning = getGenericJustificationWarning(justification);
    if (genericJustificationWarning) {
      setValidationWarning(genericJustificationWarning);
      return;
    }
    setValidationWarning("");
    const effectiveDuration = coerceDurationForItems(durationHours, selectedItems);
    const bundle: QuickPimBundle = {
      id: editingBundleId || createBundleId(name),
      name: name.trim(),
      itemIds: [...selectedItemIds],
      defaultDurationHours: effectiveDuration,
      defaultJustification: justification.trim() || undefined
    };
    const bundles = editingBundleId
      ? settings.bundles.map((item) => (item.id === editingBundleId ? bundle : item))
      : [bundle, ...settings.bundles.filter((item) => item.id !== bundle.id)];
    await onSave({ ...settings, bundles });
    resetDraft();
  }

  async function removeBundle(bundleId: string) {
    await onSave({ ...settings, bundles: settings.bundles.filter((bundle) => bundle.id !== bundleId) });
    if (editingBundleId === bundleId) {
      resetDraft();
    }
  }

  function toggle(itemId: string) {
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function editBundle(bundle: QuickPimBundle) {
    loadBundleDraft(bundle, bundle.name);
    setEditingBundleId(bundle.id);
    setDraftMode("edit");
    setDraftSourceName(bundle.name);
  }

  function duplicateBundle(bundle: QuickPimBundle) {
    loadBundleDraft(bundle, getDuplicateBundleName(bundle.name, settings.bundles.map((item) => item.name)));
    setEditingBundleId(undefined);
    setDraftMode("duplicate");
    setDraftSourceName(bundle.name);
  }

  function loadBundleDraft(bundle: QuickPimBundle, nextName: string) {
    setName(nextName);
    setSelectedItemIds(new Set(bundle.itemIds));
    setDurationHours(bundle.defaultDurationHours || settings.preferences.defaultDurationHours);
    setJustification(bundle.defaultJustification || "");
  }

  function resetDraft() {
    setName("");
    setSelectedItemIds(new Set());
    setDurationHours(settings.preferences.defaultDurationHours);
    setJustification("");
    setEditingBundleId(undefined);
    setDraftMode("create");
    setDraftSourceName("");
    setValidationWarning("");
  }

  return (
    <section className="panel">
      <h2>Role Bundles</h2>
      {draftMode === "edit" ? <p className="muted">Editing {draftSourceName}</p> : null}
      {draftMode === "duplicate" ? <p className="muted">Duplicating {draftSourceName}</p> : null}
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily operations" />
        </div>
        <div className="field">
          <label>Duration</label>
          <select
            className="select"
            value={String(durationOptions.some((option) => option.value === durationHours) ? durationHours : durationOptions[0]?.value || durationHours)}
            onChange={(event) => setDurationHours(Number(event.target.value))}
            disabled={!durationOptions.length}
            aria-label="Bundle duration"
          >
            {durationOptions.length ? (
              durationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))
            ) : (
              <option value={durationHours}>Select roles first</option>
            )}
          </select>
        </div>
      </div>
      <div className="field settings-field-gap">
        <label>Justification</label>
        <textarea
          className="textarea justification-textarea"
          rows={2}
          value={justification}
          onChange={(event) => {
            setJustification(event.target.value);
            if (validationWarning) setValidationWarning("");
          }}
          placeholder="Optional default"
          aria-label="Bundle default justification"
        />
        <p className="field-warning">{GENERIC_JUSTIFICATION_WARNING}</p>
      </div>
      {validationWarning ? <p className="message error settings-inline-message">{validationWarning}</p> : null}
      <div className="checkbox-grid settings-section-gap">
        {sortedItems.map((item) => (
          <label className="checkbox-option" key={item.id}>
            <input type="checkbox" checked={selectedItemIds.has(item.id)} onChange={() => toggle(item.id)} />
            <span>
              <strong>{getDisplayName(item, settings, referenceData)}</strong>
              <br />
              <span className="muted">{getScopeLabel(item, referenceData)}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="button-row settings-form-actions">
        <button className="btn primary" onClick={() => void saveBundle()} disabled={!name.trim() || !selectedItemIds.size}>
          {draftMode === "edit" ? "Save changes" : "Save bundle"}
        </button>
        {draftMode !== "create" ? (
          <button className="btn" onClick={resetDraft}>
            Cancel
          </button>
        ) : null}
      </div>
      <div className="panel">
        <h3>Saved bundles</h3>
        {settings.bundles.map((bundle) => (
          <div className="alias-row" key={bundle.id}>
            <div>
              <strong>{bundle.name}</strong>
              <p className="muted">
                {bundle.itemIds.length} item(s)
                {bundle.defaultJustification ? ` / ${bundle.defaultJustification}` : ""}
              </p>
            </div>
            <div className="button-row nowrap">
              <button className="btn" onClick={() => editBundle(bundle)}>
                Edit
              </button>
              <button className="btn" onClick={() => duplicateBundle(bundle)}>
                Duplicate
              </button>
              <button className="btn danger" onClick={() => void removeBundle(bundle.id)}>
                Remove
              </button>
            </div>
          </div>
        ))}
        {!settings.bundles.length ? <p className="muted">No bundles saved yet.</p> : null}
      </div>
    </section>
  );
}

function PreferencesPanel({
  settings,
  onSave
}: {
  settings: QuickPimSettings;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<void>;
}) {
  const [defaultDurationHours, setDefaultDurationHours] = useState(settings.preferences.defaultDurationHours);
  const [defaultSort, setDefaultSort] = useState<SortMode>(settings.preferences.defaultSort);
  const [recentJustificationLimit, setRecentJustificationLimit] = useState(settings.preferences.recentJustificationLimit);
  const [darkMode, setDarkMode] = useState(settings.preferences.darkMode);
  const [hiddenPopupTabs, setHiddenPopupTabs] = useState<Set<PopupTab>>(new Set(settings.preferences.hiddenPopupTabs));

  useEffect(() => {
    setDefaultDurationHours(settings.preferences.defaultDurationHours);
    setDefaultSort(settings.preferences.defaultSort);
    setRecentJustificationLimit(settings.preferences.recentJustificationLimit);
    setDarkMode(settings.preferences.darkMode);
    setHiddenPopupTabs(new Set(settings.preferences.hiddenPopupTabs));
  }, [
    settings.preferences.darkMode,
    settings.preferences.defaultDurationHours,
    settings.preferences.defaultSort,
    settings.preferences.hiddenPopupTabs,
    settings.preferences.recentJustificationLimit
  ]);

  async function save() {
    await onSave({
      ...settings,
      preferences: {
        ...settings.preferences,
        defaultDurationHours,
        defaultSort,
        recentJustificationLimit,
        darkMode,
        hiddenPopupTabs: [...hiddenPopupTabs]
      }
    });
  }

  function toggleHiddenPopupTab(tab: PopupTab, hidden: boolean) {
    setHiddenPopupTabs((current) => {
      const next = new Set(current);
      if (hidden) {
        next.add(tab);
      } else {
        next.delete(tab);
      }
      return next;
    });
  }

  return (
    <section className="panel">
      <h2>Preferences</h2>
      <div className="form-grid three">
        <div className="field">
          <label>Default duration</label>
          <input className="input" type="number" min="0.5" max="24" step="0.5" value={defaultDurationHours} onChange={(event) => setDefaultDurationHours(Number(event.target.value))} />
        </div>
        <div className="field">
          <label>Default sort</label>
          <select className="select" value={defaultSort} onChange={(event) => setDefaultSort(event.target.value as SortMode)}>
            <option value="name">Name</option>
            <option value="lastUsed">Last use</option>
            <option value="activationCount">Activation count</option>
            <option value="type">Type</option>
            <option value="scope">Scope</option>
          </select>
        </div>
        <div className="field">
          <label>Recent justification count</label>
          <input className="input" type="number" min="1" max="20" value={recentJustificationLimit} onChange={(event) => setRecentJustificationLimit(Number(event.target.value))} />
        </div>
        <label className="checkbox-option preference-toggle">
          <input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} aria-label="Dark mode" />
          <span>
            <strong>Dark mode</strong>
            <br />
            <span className="muted">Use dark surfaces in the popup and settings.</span>
          </span>
        </label>
      </div>
      <div className="field settings-section-gap">
        <label>Hidden popup tabs</label>
        <div className="checkbox-grid compact">
          {(["directoryRole", "pimGroup", "azureRole", "bundles"] as PopupTab[]).map((popupTab) => (
            <label className="checkbox-option" key={popupTab}>
              <input
                type="checkbox"
                checked={hiddenPopupTabs.has(popupTab)}
                onChange={(event) => toggleHiddenPopupTab(popupTab, event.target.checked)}
                aria-label={`Hide ${popupTabLabel(popupTab)} tab`}
              />
              <span>Hide {popupTabLabel(popupTab)} tab</span>
            </label>
          ))}
        </div>
      </div>
      <div className="button-row settings-form-actions">
        <button className="btn primary" onClick={() => void save()}>
          Save preferences
        </button>
      </div>
      <div className="panel">
        <h3>Usage counters</h3>
        {Object.entries(settings.usageStatsByItemId).map(([id, stats]) => (
          <div className="settings-row" key={id}>
            <span>
              {id}
              <br />
              <span className="muted">
                {stats.activationCount} activation(s)
                {stats.lastUsedAt ? ` / ${new Date(stats.lastUsedAt).toLocaleString()}` : ""}
              </span>
            </span>
          </div>
        ))}
        <button className="btn danger" onClick={() => void onSave({ ...settings, usageStatsByItemId: {}, activationHistory: [] }, "Usage data reset.")}>
          Reset usage data
        </button>
      </div>
    </section>
  );
}

function DataPanel({
  settings,
  exportText,
  setExportText,
  onSave,
  onClearMessage
}: {
  settings: QuickPimSettings;
  exportText: string;
  setExportText: (value: string) => void;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<void>;
  onClearMessage: () => void;
}) {
  async function importSettings() {
    onClearMessage();
    const parsed = JSON.parse(exportText) as Partial<QuickPimSettings>;
    await onSave(mergeSettings(parsed), "Settings imported.");
  }

  return (
    <section className="panel">
      <h2>Import / Export</h2>
      <p className="muted">Settings are stored locally in Chrome storage under {SETTINGS_KEY}.</p>
      <textarea className="textarea code-box" value={exportText} onChange={(event) => setExportText(event.target.value)} />
      <div className="button-row settings-form-actions">
        <button className="btn" onClick={() => setExportText(JSON.stringify(settings, null, 2))}>
          Refresh export
        </button>
        <button className="btn primary" onClick={() => void importSettings()}>
          Import JSON
        </button>
        <button className="btn danger" onClick={() => void onSave(DEFAULT_SETTINGS, "Settings reset.")}>
          Reset all settings
        </button>
      </div>
    </section>
  );
}

function tabLabel(tab: SettingsTab): string {
  const labels: Record<SettingsTab, string> = {
    about: "About",
    access: "Access Setup",
    aliases: "Aliases",
    justifications: "Justifications",
    bundles: "Bundles",
    preferences: "Preferences",
    data: "Import / Export"
  };
  return labels[tab];
}

function tabFromHash(): SettingsTab {
  const value = window.location.hash.replace("#", "");
  if (value === "permissions") {
    return "access";
  }
  if (["about", "access", "aliases", "justifications", "bundles", "preferences", "data"].includes(value)) {
    return value as SettingsTab;
  }
  return "aliases";
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

function getDuplicateBundleName(name: string, existingNames: string[]): string {
  const baseName = `${name} copy`;
  const existing = new Set(existingNames.map((item) => item.trim().toLowerCase()));
  if (!existing.has(baseName.toLowerCase())) {
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${baseName} ${Date.now()}`;
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
  if (!response?.success) {
    throw new Error(response?.error || "QuickPIM background request failed.");
  }
  return response.data as T;
}

createRoot(document.getElementById("root")!).render(<SettingsApp />);
