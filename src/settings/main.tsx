import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { buildAccessCapabilityItems, buildTargetCacheKey, buildTokenCacheKey, buildTargetCacheKeys, getAccessSetupTargets, getPortalUrlsForTargets, hasRequiredPortalToken } from "../lib/access";
import { formatDateOnly } from "../lib/dateFormat";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  STALE_ELIGIBLE_CACHE_TTL_MS,
  formatCacheAge,
  getTargetEntriesFromCache,
  loadDataCache,
  mergeTargetEntries,
  saveDataCache,
  splitActivationResultByTarget,
  updateCacheFromTargetResults
} from "../lib/cache";
import { DEFAULT_DURATION_OPTIONS, coerceDurationForItems, getDurationOptions, tabLabel as popupTabLabel } from "../lib/popupModel";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  buildFeatureCacheKey,
  createBundleId,
  getDisplayName,
  getEnabledRoleFeatures,
  getScopeLabel,
  loadSettings,
  mergeImportedSettings,
  mergeSettings,
  saveSettings
} from "../lib/settings";
import {
  clearReferenceData,
  learnReferenceDataFromItems,
  loadReferenceData,
  saveReferenceData
} from "../lib/referenceData";
import { getGenericJustificationWarning } from "../lib/justifications";
import { APP_NAME, APP_RELEASE_TAG, APP_VERSION } from "../lib/appMetadata";
import { TOKEN_STORAGE_KEYS } from "../lib/tokenStorage";
import type { AccessSetupTarget, ActivationItem, ActivationSnapshot, ActivityAction, ActivityResult, PortalTokenRefreshResult, QuickPimBundle, QuickPimDataCache, QuickPimFeature, QuickPimSettings, ReferenceDataCache, SortMode, TokenStatus } from "../lib/types";

type SettingsTab = "home" | "access" | "activity" | "justifications" | "bundles" | "aliases" | "preferences" | "data" | "diagnostics" | "about";

const ORIGINAL_AUTHOR = "Daniel Bradley";
const ORIGINAL_REPOSITORY_URL = "https://github.com/DanielBradley1/QuickPIM";
const REPOSITORY_URL = "https://github.com/RobinMJD/QuickPIM-PlusPlus";
const GITHUB_API_BASE = "https://api.github.com/repos/RobinMJD/QuickPIM-PlusPlus";
const CHANGELOG_CACHE_KEY = "quickPimChangelog.v2";
const CHANGELOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CHANGELOG_FETCH_TIMEOUT_MS = 5000;
const PORTAL_TOKEN_WAIT_TIMEOUT_MS = 12_000;
const PORTAL_TOKEN_POLL_INTERVAL_MS = 1500;

const NAV_SECTIONS: Array<{ title: string; tabs: SettingsTab[] }> = [
  { title: "Overview", tabs: ["home"] },
  { title: "Setup", tabs: ["access"] },
  { title: "Daily Use", tabs: ["activity", "justifications", "bundles", "aliases"] },
  { title: "Preferences", tabs: ["preferences"] },
  { title: "Maintenance", tabs: ["data", "diagnostics"] },
  { title: "About", tabs: ["about"] }
];

interface ChangelogItem {
  title: string;
  description: string;
  url: string;
  date?: string;
}

interface ChangelogCache {
  fetchedAt: number;
  releaseTag: string;
  items: ChangelogItem[];
}

interface MessageResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface AccessRefreshOptions {
  skipTargetsWithCurrentTokenCache?: boolean;
  completionMessage?: string;
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
  const [isSettingsReady, setIsSettingsReady] = useState(false);
  const [sessionTokenRevision, setSessionTokenRevision] = useState(0);
  const exportTextDirty = useRef(false);
  const accessRefreshQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingAccessRefreshes = useRef(0);
  const pendingSessionTokenTargets = useRef(new Set<AccessSetupTarget>());
  const suppressSessionTokenRefreshUntil = useRef(0);

  function replaceExportText(value: string, dirty = false) {
    exportTextDirty.current = dirty;
    setExportText(value);
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const storageChangeEvent = chrome.storage?.onChanged;
    if (!storageChangeEvent) {
      return;
    }
    function handleStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName === "session") {
        if (Date.now() < suppressSessionTokenRefreshUntil.current) {
          return;
        }
        const targets = getTargetsForTokenStorageChanges(changes);
        if (targets.length) {
          targets.forEach((target) => pendingSessionTokenTargets.current.add(target));
          setSessionTokenRevision((current) => current + 1);
        }
        return;
      }
      if (areaName !== "local" || !changes[SETTINGS_KEY]) {
        return;
      }
      const merged = mergeSettings(changes[SETTINGS_KEY].newValue as Partial<QuickPimSettings> | undefined);
      setSettings(merged);
      if (!exportTextDirty.current) {
        replaceExportText(JSON.stringify(merged, null, 2));
      }
    }
    storageChangeEvent.addListener(handleStorageChange);
    return () => storageChangeEvent.removeListener(handleStorageChange);
  }, []);

  useEffect(() => {
    if (!isSettingsReady || !sessionTokenRevision) {
      return;
    }
    const timer = setTimeout(() => {
      const targets = [...pendingSessionTokenTargets.current];
      pendingSessionTokenTargets.current.clear();
      if (targets.length) {
        void forceRefreshAccessData(undefined, targets, {
          skipTargetsWithCurrentTokenCache: true,
          completionMessage: "Portal access updated."
        });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [isSettingsReady, sessionTokenRevision]);

  useEffect(() => {
    document.body.classList.toggle("dark-mode", settings.preferences.darkMode);
  }, [settings.preferences.darkMode]);

  useEffect(() => {
    if (!isSettingsReady) {
      return;
    }
    setItems((current) => applyDisplayData(current, settings, referenceData));
  }, [isSettingsReady, referenceData, settings.aliasesByItemId]);

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
      const loadedSettings = await loadSettings();
      setSettings(loadedSettings);
      if (!exportTextDirty.current) {
        replaceExportText(JSON.stringify(loadedSettings, null, 2));
      }
      setIsSettingsReady(true);
      const [loadedTokens, loadedCache, loadedReferenceData] = await Promise.all([
        sendMessage<TokenStatus>({ action: "getTokenStatus" }),
        loadDataCache(),
        loadReferenceData()
      ]);
      const tokenCacheKey = buildTokenCacheKey(loadedTokens);
      const enabledRoleFeatures = getEnabledRoleFeatures(loadedSettings);
      let effectiveTokenStatus = loadedTokens;
      let targetCacheKeys = buildTargetCacheKeys(effectiveTokenStatus, enabledRoleFeatures);
      let legacyCacheKey = buildFeatureCacheKey(tokenCacheKey, enabledRoleFeatures);
      let nextCache = loadedCache;
      if (options.showProgress && enabledRoleFeatures.length) {
        const snapshot = await fetchActivationSnapshot(enabledRoleFeatures);
        const fetchedAt = Date.now();
        effectiveTokenStatus = snapshot.tokenStatus || loadedTokens;
        const snapshotTargetCacheKeys = buildTargetCacheKeys(effectiveTokenStatus, enabledRoleFeatures);
        targetCacheKeys = snapshotTargetCacheKeys;
        legacyCacheKey = buildFeatureCacheKey(buildTokenCacheKey(effectiveTokenStatus), enabledRoleFeatures);
        nextCache = updateCacheFromTargetResults(
          nextCache,
          "eligible",
          enabledRoleFeatures,
          snapshot.eligibleByTarget || splitActivationResultByTarget(snapshot.eligible, enabledRoleFeatures),
          fetchedAt,
          snapshotTargetCacheKeys
        );
        nextCache = updateCacheFromTargetResults(
          nextCache,
          "active",
          enabledRoleFeatures,
          snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, enabledRoleFeatures),
          fetchedAt,
          snapshotTargetCacheKeys
        );
        await saveDataCache(nextCache);
      }

      const now = Date.now();
      const eligibleCache = getTargetEntriesFromCache(nextCache, "eligible", enabledRoleFeatures, targetCacheKeys, {
        legacyCacheKey,
        now,
        freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
      });
      const eligible = mergeTargetEntries(enabledRoleFeatures.map((target) => eligibleCache[target]?.entry), now, legacyCacheKey);
      const nextReferenceData = learnReferenceDataFromItems(loadedReferenceData, eligible.items);
      await saveReferenceData(nextReferenceData);
      setItems(applyDisplayData(eligible.items, loadedSettings, nextReferenceData));
      setTokenStatus(effectiveTokenStatus);
      setDataCache(nextCache);
      setReferenceData(nextReferenceData);
      if (options.showProgress) {
        setMessage(
          eligible.items.length
            ? `Eligible items refreshed from ${formatCacheAge(eligible.fetchedAt)}.`
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

  function forceRefreshAccessData(
    tokens?: TokenStatus,
    targets?: AccessSetupTarget[],
    options: AccessRefreshOptions = {}
  ): Promise<void> {
    pendingAccessRefreshes.current += 1;
    setIsRefreshingAccess(true);
    setError("");
    setMessage("Refreshing access data...");

    const refreshRun = accessRefreshQueue.current.then(() => performAccessDataRefresh(tokens, targets, options));
    accessRefreshQueue.current = refreshRun.then(() => undefined, () => undefined);

    return refreshRun.catch((refreshError) => {
      setMessage("");
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }).finally(() => {
      pendingAccessRefreshes.current -= 1;
      if (!pendingAccessRefreshes.current) {
        setIsRefreshingAccess(false);
      }
    });
  }

  async function performAccessDataRefresh(
    tokens: TokenStatus | undefined,
    targets: AccessSetupTarget[] | undefined,
    options: AccessRefreshOptions
  ): Promise<void> {
    const [loadedSettings, currentCache, currentReferenceData, loadedTokens] = await Promise.all([
      loadSettings(),
      loadDataCache(),
      loadReferenceData(),
      tokens ? Promise.resolve(tokens) : sendMessage<TokenStatus>({ action: "getTokenStatus" })
    ]);
    const latestTokens = loadedTokens;
    const enabledRoleFeatures = getEnabledRoleFeatures(loadedSettings);
    let refreshTargets = normalizeRefreshTargets(targets?.length ? targets : enabledRoleFeatures, enabledRoleFeatures);
    if (options.skipTargetsWithCurrentTokenCache) {
      refreshTargets = refreshTargets.filter((target) => !isTargetCacheCurrentForToken(currentCache, latestTokens, target));
    }

    setSettings(loadedSettings);
    setTokenStatus(latestTokens);
    setDataCache(currentCache);
    if (!refreshTargets.length) {
      setMessage(options.completionMessage || "Access data is already current.");
      return;
    }

    const snapshot = await fetchActivationSnapshot(refreshTargets);
    const fetchedAt = Date.now();
    const snapshotTokenStatus = snapshot.tokenStatus || latestTokens;
    const snapshotTargetCacheKeys = buildTargetCacheKeys(snapshotTokenStatus, enabledRoleFeatures);
    const legacyCacheKey = buildFeatureCacheKey(buildTokenCacheKey(snapshotTokenStatus), enabledRoleFeatures);
    let nextCache = updateCacheFromTargetResults(
      currentCache,
      "eligible",
      refreshTargets,
      snapshot.eligibleByTarget || splitActivationResultByTarget(snapshot.eligible, refreshTargets),
      fetchedAt,
      snapshotTargetCacheKeys
    );
    nextCache = updateCacheFromTargetResults(
      nextCache,
      "active",
      refreshTargets,
      snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, refreshTargets),
      fetchedAt,
      snapshotTargetCacheKeys
    );
    await saveDataCache(nextCache);
    const eligibleCache = getTargetEntriesFromCache(nextCache, "eligible", enabledRoleFeatures, snapshotTargetCacheKeys, {
      legacyCacheKey,
      now: fetchedAt,
      freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
      usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
    });
    const activeCache = getTargetEntriesFromCache(nextCache, "active", enabledRoleFeatures, snapshotTargetCacheKeys, {
      legacyCacheKey,
      now: fetchedAt,
      freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
    });
    const eligible = mergeTargetEntries(enabledRoleFeatures.map((target) => eligibleCache[target]?.entry), fetchedAt, legacyCacheKey);
    const active = mergeTargetEntries(enabledRoleFeatures.map((target) => activeCache[target]?.entry), fetchedAt, legacyCacheKey);
    const nextReferenceData = learnReferenceDataFromItems(currentReferenceData, [...eligible.items, ...active.items]);
    await saveReferenceData(nextReferenceData);
    setTokenStatus(snapshotTokenStatus);
    setDataCache(nextCache);
    setReferenceData(nextReferenceData);
    setItems(applyDisplayData(eligible.items, loadedSettings, nextReferenceData));
    const limitedAreas = buildAccessCapabilityItems(snapshotTokenStatus, nextCache, enabledRoleFeatures).filter((item) => item.status !== "ready").length;
    const completionPrefix = options.completionMessage || "Access data refreshed.";
    setMessage(
      limitedAreas
        ? `${completionPrefix} ${limitedAreas} area(s) still need portal access or are limited by the captured portal token.`
        : completionPrefix
    );
  }

  async function persist(next: QuickPimSettings, successMessage = "Settings saved.") {
    if (!isSettingsReady) {
      setError("Wait for saved settings to finish loading before making changes.");
      return false;
    }
    try {
      const latest = await loadSettings();
      const mergedInput: QuickPimSettings = { ...latest };
      for (const key of [
        "aliasesByItemId", "favoriteItemIds", "savedJustifications", "recentJustifications", "bundles",
        "usageStatsByItemId", "activityHistory", "activationHistory", "preferences"
      ] as const) {
        if (JSON.stringify(next[key]) !== JSON.stringify(settings[key])) {
          (mergedInput as unknown as Record<string, unknown>)[key] = next[key];
        }
      }
      const merged = mergeSettings(mergedInput);
      await saveSettings(merged);
      setSettings(merged);
      if (!exportTextDirty.current) {
        replaceExportText(JSON.stringify(merged, null, 2));
      }
      setError("");
      setMessage(successMessage);
      return true;
    } catch (saveError) {
      setMessage("");
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return false;
    }
  }

  async function clearCapturedTokens() {
    try {
      suppressSessionTokenRefreshUntil.current = Date.now() + 1000;
      await sendMessage<boolean>({ action: "clearToken" });
      setTokenStatus({
        graph: { hasToken: false },
        azureManagement: { hasToken: false }
      });
      setError("");
      setMessage("Captured tokens cleared.");
    } catch (clearError) {
      setMessage("");
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    }
  }

  async function clearLearnedReferences() {
    try {
      await clearReferenceData();
      setReferenceData(undefined);
      setItems((current) => applyDisplayData(current, settings, undefined));
      setError("");
      setMessage("Learned names cleared.");
    } catch (clearError) {
      setMessage("");
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    }
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
            <h1>QuickPIM++ Settings</h1>
            <p>Manage activation defaults, access setup, saved justifications, bundles, aliases, and local data.</p>
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
        {error ? <p className="message error" role="alert">{error}</p> : null}
        {message ? <p className={message === "Settings saved." ? "message success" : "message"} role="status">{message}</p> : null}
        <div className={`settings-layout ${isSettingsReady ? "" : "settings-loading"}`} aria-busy={!isSettingsReady}>
          <nav className="settings-nav" aria-label="Settings sections">
            {NAV_SECTIONS.map((section) => (
              <div className="settings-nav-group" key={section.title}>
                <p className="settings-nav-heading">{section.title}</p>
                {section.tabs.map((item) => (
                  <button key={item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>
                    <SettingsNavIcon tab={item} />
                    <span>{tabLabel(item)}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div>
            {tab === "home" ? <HomePanel /> : null}
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
            {tab === "activity" ? <ActivityPanel settings={settings} onSave={persist} /> : null}
            {tab === "aliases" ? <AliasesPanel settings={settings} items={items} referenceData={referenceData} onSave={persist} /> : null}
            {tab === "justifications" ? <JustificationsPanel settings={settings} onSave={persist} /> : null}
            {tab === "bundles" ? <BundlesPanel settings={settings} items={items} referenceData={referenceData} onSave={persist} /> : null}
            {tab === "preferences" ? <PreferencesPanel settings={settings} onSave={persist} /> : null}
            {tab === "data" ? (
              <DataPanel
                settings={settings}
                exportText={exportText}
                setExportText={replaceExportText}
                onSave={persist}
                onClearMessage={() => setMessage("")}
                onError={setError}
              />
            ) : null}
            {tab === "diagnostics" ? <DiagnosticsPanel tokenStatus={tokenStatus} dataCache={dataCache} /> : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function HomePanel() {
  const [changelog, setChangelog] = useState<ChangelogItem[]>([]);
  const [isLoadingChangelog, setIsLoadingChangelog] = useState(true);
  const [changelogError, setChangelogError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoadingChangelog(true);
      setChangelogError("");
      try {
        const items = await loadGithubChangelog();
        if (!cancelled) {
          setChangelog(items);
        }
      } catch (error) {
        if (!cancelled) {
          setChangelogError(error instanceof Error ? error.message : "GitHub changelog could not be loaded.");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingChangelog(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="home-stack">
      <div className="panel home-hero">
        <div>
          <h2>QuickPIM++ is a local-first activation console</h2>
          <p className="muted">
            Use one compact popup to activate eligible Microsoft Entra roles, PIM groups, and Azure roles with saved reasons,
            bundles, aliases, favorites, and local learned names.
          </p>
        </div>
        <div className="home-feature-grid">
          <div>
            <strong>Daily activation</strong>
            <span>Select roles, continue, then review duration and justification only when needed.</span>
          </div>
          <div>
            <strong>Local setup</strong>
            <span>Settings stay in this browser profile and portal tokens are captured from Microsoft pages.</span>
          </div>
          <div>
            <strong>Cleaner management</strong>
            <span>Manage aliases, justifications, bundles, popup defaults, access setup, and import/export in one place.</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Changelog</h2>
            <p className="muted">Loaded from the QuickPIM++ GitHub repository.</p>
          </div>
          <a className="btn" href={`${REPOSITORY_URL}/releases`} target="_blank" rel="noreferrer">
            Open GitHub
          </a>
        </div>
        {isLoadingChangelog ? (
          <section className="loading-panel settings-local-loading" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>Loading changelog from GitHub...</span>
          </section>
        ) : null}
        {changelogError ? (
          <p className="message error settings-inline-message">
            Could not load the GitHub changelog. Open GitHub to review the latest changes.
          </p>
        ) : null}
        {!isLoadingChangelog && !changelogError ? (
          <div className="changelog-list">
            {changelog.map((item) => (
              <a className="changelog-item" href={item.url} target="_blank" rel="noreferrer" key={`${item.title}-${item.url}`}>
                <span>
                  <strong>{item.title}</strong>
                  {formatDateOnly(item.date) ? <small>{formatDateOnly(item.date)}</small> : null}
                </span>
                <p>{item.description}</p>
              </a>
            ))}
            {!changelog.length ? <p className="muted">No GitHub releases or commits were returned.</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SettingsNavIcon({ tab }: { tab: SettingsTab }) {
  const pathByTab: Record<SettingsTab, string[]> = {
    home: ["M3 11.5 12 4l9 7.5", "M5 10.5V20h14v-9.5", "M9 20v-6h6v6"],
    access: ["M12 3l7 3v5c0 4.5-2.8 8.1-7 10-4.2-1.9-7-5.5-7-10V6l7-3z", "M9.5 12.5l1.8 1.8 3.8-4.4"],
    activity: ["M4 19h16", "M7 16V8", "M12 16V5", "M17 16v-6"],
    aliases: ["M4 7h16", "M7 4v6", "M17 4v6", "M6 14h7", "M6 18h11"],
    justifications: ["M6 4h9l3 3v13H6z", "M14 4v4h4", "M9 12h6", "M9 16h6"],
    bundles: ["M5 7h14v5H5z", "M7 12v5h10v-5", "M9 7V5h6v2"],
    preferences: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 2v3", "M12 19v3", "M4.9 4.9 7 7", "M17 17l2.1 2.1", "M2 12h3", "M19 12h3"],
    data: ["M5 5h14v14H5z", "M8 9h8", "M8 13h8", "M8 17h5"],
    diagnostics: ["M4 5h16", "M4 12h16", "M4 19h16", "M8 5v14", "M16 5v14"],
    about: ["M12 17v-5", "M12 8h.01", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"]
  };
  return (
    <span className="settings-nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        {pathByTab[tab].map((path) => (
          <path d={path} key={path} />
        ))}
      </svg>
    </span>
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
  const appName = sanitizeManifestText(manifest.name) || APP_NAME;
  return (
    <section className="panel about-panel">
      <div>
        <h2>{appName} {APP_VERSION}</h2>
        <p className="muted">Quick activation for Microsoft Entra roles, Azure roles, and PIM groups.</p>
      </div>
      <div className="about-grid">
        <div>
          <strong>
            Original author:{" "}
            <a href={ORIGINAL_REPOSITORY_URL} target="_blank" rel="noreferrer">
              {ORIGINAL_AUTHOR}
            </a>
          </strong>
          <p className="muted">
            v2 continues the original QuickPIM project as QuickPIM++ with the React rewrite, PIM groups, Azure roles,
            role bundles, saved justifications, favorites, aliases, dark mode, learned names, access setup, and much more!
          </p>
        </div>
        <div>
          <strong>Privacy</strong>
          <p className="muted">Tokens and settings stay in this browser profile. QuickPIM++ only calls Microsoft Graph and Azure Management APIs.</p>
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
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
  onRefreshAccessData: (tokens?: TokenStatus, targets?: AccessSetupTarget[], options?: AccessRefreshOptions) => Promise<void>;
  onClearReferenceData: () => Promise<void>;
}) {
  const [isRunningSetup, setIsRunningSetup] = useState(false);
  const [isRecheckingPortalTabs, setIsRecheckingPortalTabs] = useState(false);
  const enabledRoleFeatures = useMemo(() => getEnabledRoleFeatures(settings), [settings]);
  const accessStatus = useMemo(() => buildAccessCapabilityItems(tokenStatus, dataCache, enabledRoleFeatures), [dataCache, enabledRoleFeatures, tokenStatus]);
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
    const initialTargets = setupTargets;
    setIsRunningSetup(true);
    try {
      const scannedTokens = await scanExistingPortalTabsForTokens();
      const remainingTargets = getAccessSetupTargets(
        buildAccessCapabilityItems(scannedTokens, dataCache, enabledRoleFeatures)
      ).filter((target) => initialTargets.includes(target));
      const urls = getPortalUrlsForTargets(remainingTargets);
      await Promise.all(urls.map(async (url) => {
        if (chrome.tabs?.create) {
          try {
            await chrome.tabs.create({ url });
            return;
          } catch {
            // Fall back to a normal extension-page navigation if tab creation is unavailable.
          }
        }
        safeOpenUrl(url);
      }));

      if (!remainingTargets.length) {
        await onRefreshAccessData(scannedTokens, initialTargets, { skipTargetsWithCurrentTokenCache: true });
        return;
      }

      const tokenRefresh = await waitForPortalTokens(remainingTargets, scannedTokens);
      if (tokenRefresh.changedTargets.length) {
        await onRefreshAccessData(tokenRefresh.tokens, tokenRefresh.changedTargets, { skipTargetsWithCurrentTokenCache: true });
      }
      const unchangedTargets = remainingTargets.filter((target) => !tokenRefresh.changedTargets.includes(target));
      if (unchangedTargets.length) {
        await onRefreshAccessData(tokenRefresh.tokens, unchangedTargets);
      }
    } finally {
      setIsRunningSetup(false);
    }
  }

  async function recheckPortalAccess() {
    setIsRecheckingPortalTabs(true);
    try {
      const scannedTokens = await scanExistingPortalTabsForTokens();
      await onRefreshAccessData(scannedTokens, setupTargets.length ? setupTargets : enabledRoleFeatures);
    } finally {
      setIsRecheckingPortalTabs(false);
    }
  }

  return (
    <section className="panel permissions-panel">
      <div className="panel-title-row">
        <div>
          <h2>Access Setup</h2>
          <p className="muted">
            {setupTargets.length
              ? `${setupTargets.length} area(s) need a portal refresh or are limited by the captured portal token.`
              : enabledRoleFeatures.length
                ? "QuickPIM++ can use the currently captured portal tokens for all enabled feature areas."
                : "No role features are enabled, so no portal access is required."}
          </p>
        </div>
        <button className={`btn ${warningIgnored ? "" : "subtle"}`} onClick={() => void setIgnored(!warningIgnored)}>
          {warningIgnored ? "Show access warning" : "Ignore access warning"}
        </button>
      </div>

      <div className="button-row settings-action-lead">
        <button className="btn primary" onClick={() => void runPortalSetup()} disabled={isRunningSetup || isRecheckingPortalTabs || isRefreshingAccess || !setupTargets.length}>
          {isRunningSetup ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>Checking portal access...</span>
            </span>
          ) : (
            "Open missing portal pages"
          )}
        </button>
        <button
          className="btn"
          onClick={() => void recheckPortalAccess()}
          disabled={isRunningSetup || isRecheckingPortalTabs || isRefreshingAccess}
        >
          {isRecheckingPortalTabs || isRefreshingAccess ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>{isRecheckingPortalTabs ? "Scanning portal tabs..." : "Rechecking access..."}</span>
            </span>
          ) : (
            "Recheck now"
          )}
        </button>
        <button className="btn danger" onClick={() => void onClearReferenceData()} disabled={isRunningSetup || isRecheckingPortalTabs || isRefreshingAccess}>
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
        QuickPIM++ only uses tokens captured from Microsoft portal pages. If a page asks you to sign in or load PIM data, complete that
        step in the opened tab, then return here.
      </p>

      <div className="permission-list">
        {accessStatus.map((item) => (
          <AccessStatusRow item={item} key={item.target} />
        ))}
        {!accessStatus.length ? <p className="muted">Enable Entra Roles, PIM Groups, or Azure Roles in Preferences to add access checks.</p> : null}
      </div>

      <div className="panel">
        <h3>Quick Tutorial</h3>
        <ol className="tutorial-list">
          <li>Use Open missing portal pages to open the Microsoft pages that normally request the needed Graph or Azure tokens.</li>
          <li>Let the portal pages finish loading. Switch to them if sign-in, tenant selection, or page consent is required.</li>
          <li>Return to QuickPIM++ and use Recheck now if the automatic refresh has not picked up the new portal token yet.</li>
          <li>QuickPIM++ keeps learned role, group, subscription, and scope names locally so old friendly names can still be displayed later.</li>
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
          <strong>Last success</strong>
          <p>{item.lastSuccessAt ? `${formatAccessOperation(item.lastSuccessOperation)} at ${formatDateOnly(item.lastSuccessAt) || item.lastSuccessAt}` : "No successful API check recorded yet."}</p>
        </div>
        <div>
          <strong>Last failure</strong>
          <p>
            {item.lastFailureAt
              ? `${formatAccessOperation(item.lastFailureOperation)}${item.lastFailureEndpoint ? ` / ${item.lastFailureEndpoint}` : ""}: ${item.lastError || "Unknown failure"}${item.failureKind ? ` (${item.failureKind})` : ""}`
              : item.status === "ready" ? "No recent failure." : item.lastError || "Open the matching portal page to refresh access."}
          </p>
        </div>
        <div>
          <strong>Next action</strong>
          <p>{item.recommendedAction || (item.status === "ready" ? "No action needed." : "Open Access Setup and reload the matching portal page.")}</p>
        </div>
      </div>
    </article>
  );
}

function formatAccessOperation(operation: ReturnType<typeof buildAccessCapabilityItems>[number]["lastSuccessOperation"]): string {
  if (operation === "active") return "Active assignments";
  if (operation === "eligible") return "Eligible assignments";
  if (operation === "policy") return "Policy lookup";
  if (operation === "nameLookup") return "Name lookup";
  if (operation === "activation") return "Activation request";
  if (operation === "deactivation") return "Deactivation request";
  return "API check";
}

function statusLabel(status: ReturnType<typeof buildAccessCapabilityItems>[number]["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "limited") return "Limited";
  return "Needs portal refresh";
}

async function scanExistingPortalTabsForTokens(): Promise<TokenStatus> {
  const result = await sendMessage<PortalTokenRefreshResult>({ action: "refreshPortalTokens" });
  return result.tokenStatus;
}

async function waitForPortalTokens(
  targets: AccessSetupTarget[],
  baselineTokens: TokenStatus
): Promise<{ tokens: TokenStatus; changedTargets: AccessSetupTarget[] }> {
  let latestTokens = baselineTokens;
  let changedTargets: AccessSetupTarget[] = [];
  const deadline = Date.now() + PORTAL_TOKEN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    latestTokens = await scanExistingPortalTabsForTokens();
    changedTargets = targets.filter((target) => hasTargetPortalTokenChanged(target, baselineTokens, latestTokens));
    if (changedTargets.length === targets.length) {
      break;
    }
    await delay(Math.min(PORTAL_TOKEN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  return { tokens: latestTokens, changedTargets };
}

function hasTargetPortalTokenChanged(target: AccessSetupTarget, before: TokenStatus, after: TokenStatus): boolean {
  if (!hasRequiredPortalToken(target, after)) {
    return false;
  }
  if (!hasRequiredPortalToken(target, before)) {
    return true;
  }
  const beforeToken = getTargetTokenStatus(before, target);
  const afterToken = getTargetTokenStatus(after, target);
  if ((afterToken?.capturedAt || 0) > (beforeToken?.capturedAt || 0)) {
    return true;
  }
  return buildTargetCacheKey(before, target) !== buildTargetCacheKey(after, target);
}

function isTargetCacheCurrentForToken(
  cache: QuickPimDataCache,
  tokenStatus: TokenStatus,
  target: AccessSetupTarget
): boolean {
  const eligible = cache.eligibleByTarget?.[target];
  const active = cache.activeByTarget?.[target];
  const expectedCacheKey = buildTargetCacheKey(tokenStatus, target);
  if (!eligible || !active || eligible.cacheKey !== expectedCacheKey || active.cacheKey !== expectedCacheKey) {
    return false;
  }
  const capturedAt = getTargetTokenStatus(tokenStatus, target)?.capturedAt;
  return !capturedAt || (eligible.fetchedAt >= capturedAt && active.fetchedAt >= capturedAt);
}

function getTargetTokenStatus(tokenStatus: TokenStatus, target: AccessSetupTarget) {
  if (target === "azureRole") {
    return tokenStatus.azureManagement;
  }
  return tokenStatus.graphTargets?.[target] || tokenStatus.graph;
}

function getTargetsForTokenStorageChanges(
  changes: Record<string, chrome.storage.StorageChange>
): AccessSetupTarget[] {
  const changedKeys = new Set(Object.keys(changes).filter((key) => TOKEN_STORAGE_KEYS.includes(key)));
  const targets = new Set<AccessSetupTarget>();
  const directoryRoleChanged = ["graphDirectoryRoleToken", "graphDirectoryRoleTokenTimestamp", "graphDirectoryRoleTokenSource"].some((key) => changedKeys.has(key));
  const pimGroupChanged = ["graphPimGroupToken", "graphPimGroupTokenTimestamp", "graphPimGroupTokenSource"].some((key) => changedKeys.has(key));
  if (directoryRoleChanged) {
    targets.add("directoryRole");
  }
  if (pimGroupChanged) {
    targets.add("pimGroup");
  }
  if (!directoryRoleChanged && !pimGroupChanged && ["graphToken", "tokenTimestamp", "tokenSource"].some((key) => changedKeys.has(key))) {
    targets.add("directoryRole");
    targets.add("pimGroup");
  }
  if (["azureManagementToken", "azureManagementTokenTimestamp", "azureManagementTokenSource"].some((key) => changedKeys.has(key))) {
    targets.add("azureRole");
  }
  return [...targets];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ActivityPanel({
  settings,
  onSave
}: {
  settings: QuickPimSettings;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
}) {
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<ActivityAction | "all">("all");
  const [resultFilter, setResultFilter] = useState<ActivityResult | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ActivationItem["type"] | "all">("all");
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return settings.activityHistory.filter((entry) => {
      if (actionFilter !== "all" && entry.action !== actionFilter) return false;
      if (resultFilter !== "all" && entry.result !== resultFilter) return false;
      if (typeFilter !== "all" && entry.itemType !== typeFilter) return false;
      if (!term) return true;
      return [entry.itemName, entry.scopeLabel, entry.bundleName, entry.justification, entry.error].some((value) =>
        value?.toLowerCase().includes(term)
      );
    });
  }, [actionFilter, resultFilter, search, settings.activityHistory, typeFilter]);

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Activity</h2>
          <p className="muted">Local activation and deactivation outcomes for troubleshooting and audit context.</p>
        </div>
        <button className="btn danger" onClick={() => void onSave({ ...settings, activityHistory: [] }, "Activity history cleared.")}>
          Clear activity
        </button>
      </div>
      <div className="toolbar settings-section-gap activity-toolbar">
        <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search activity" aria-label="Search activity" />
        <select className="select" value={actionFilter} onChange={(event) => setActionFilter(event.target.value as ActivityAction | "all")} aria-label="Filter activity action">
          <option value="all">All actions</option>
          <option value="activate">Activations</option>
          <option value="deactivate">Deactivations</option>
        </select>
        <select className="select" value={resultFilter} onChange={(event) => setResultFilter(event.target.value as ActivityResult | "all")} aria-label="Filter activity result">
          <option value="all">All results</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>
        <select className="select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as ActivationItem["type"] | "all")} aria-label="Filter activity type">
          <option value="all">All types</option>
          <option value="directoryRole">Entra Roles</option>
          <option value="pimGroup">PIM Groups</option>
          <option value="azureRole">Azure Roles</option>
        </select>
      </div>
      <div className="activity-list">
        {filtered.map((entry) => (
          <article className={`activity-row ${entry.result}`} key={entry.id}>
            <div>
              <strong>{entry.itemName}</strong>
              <p className="muted">
                {entry.action} / {entry.result} / {popupTabLabel(entry.itemType)}
                {entry.scopeLabel ? ` / ${entry.scopeLabel}` : ""}
              </p>
              {entry.justification ? <p>{entry.justification}</p> : null}
              {entry.error ? <p className="message error settings-inline-message">{entry.error}</p> : null}
            </div>
            <div className="activity-time">
              <span>{formatDateOnly(entry.completedAt || entry.requestedAt) || entry.completedAt || entry.requestedAt}</span>
              {entry.durationHours ? <span>{entry.durationHours}h</span> : null}
              {entry.bundleName ? <span>{entry.bundleName}</span> : null}
            </div>
          </article>
        ))}
        {!filtered.length ? <p className="muted">No activity matches the current filters.</p> : null}
      </div>
    </section>
  );
}

function DiagnosticsPanel({
  tokenStatus,
  dataCache
}: {
  tokenStatus: TokenStatus | null;
  dataCache: QuickPimDataCache;
}) {
  const diagnostics = [
    dataCache.eligible,
    dataCache.active,
    ...Object.values(dataCache.eligibleByTarget || {}),
    ...Object.values(dataCache.activeByTarget || {})
  ].flatMap((entry) => entry?.diagnostics || []);

  return (
    <section className="panel">
      <h2>Diagnostics</h2>
      <p className="muted">Safe local status information for troubleshooting. Tokens and raw authorization headers are not displayed.</p>
      <div className="permission-detail-grid settings-section-gap">
        <div>
          <strong>Graph token</strong>
          <p>{tokenStatus?.graph.hasToken ? "Captured in this browser session" : "Missing"}</p>
        </div>
        <div>
          <strong>Azure token</strong>
          <p>{tokenStatus?.azureManagement.hasToken ? "Captured in this browser session" : "Missing"}</p>
        </div>
      </div>
      <div className="activity-list">
        {diagnostics.map((diagnostic, index) => (
          <article className={`activity-row ${diagnostic.success ? "success" : "failed"}`} key={`${diagnostic.target}:${diagnostic.checkedAt}:${index}`}>
            <div>
              <strong>{popupTabLabel(diagnostic.target)}</strong>
              <p className="muted">
                {formatAccessOperation(diagnostic.operation)} / {diagnostic.endpointLabel || "API check"} / {diagnostic.success ? "success" : diagnostic.failureKind || "failed"}
                {diagnostic.fromCache ? " / cache" : ""}
              </p>
              {diagnostic.error ? <p>{diagnostic.error}</p> : null}
            </div>
            <div className="activity-time">
              <span>{formatDateOnly(diagnostic.checkedAt) || diagnostic.checkedAt}</span>
            </div>
          </article>
        ))}
        {!diagnostics.length ? <p className="muted">No diagnostics recorded yet.</p> : null}
      </div>
    </section>
  );
}

function safeOpenUrl(url: string): void {
  if (isTestRuntime()) {
    return;
  }
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    // Some test and restricted browser contexts expose window.open but block it.
  }
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
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
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
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
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

  async function moveSaved(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= settings.savedJustifications.length) return;

    const savedJustifications = [...settings.savedJustifications];
    const [item] = savedJustifications.splice(index, 1);
    savedJustifications.splice(targetIndex, 0, item);
    await onSave({
      ...settings,
      savedJustifications
    }, "Saved justifications reordered.");
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
      {validationWarning ? <p className="field-warning settings-field-gap">{validationWarning}</p> : null}
      <div className="two-column settings-section-gap">
        <div className="panel">
          <h3>Saved</h3>
          {settings.savedJustifications.map((item, index) => (
            <div className="settings-row saved-justification-row" key={item}>
              <span>{item}</span>
              <div className="button-row nowrap settings-row-actions">
                <button
                  className="btn icon-btn compact-icon-btn"
                  onClick={() => void moveSaved(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  aria-label={`Move ${item} up`}
                >
                  <MoveIcon direction="up" />
                </button>
                <button
                  className="btn icon-btn compact-icon-btn"
                  onClick={() => void moveSaved(index, 1)}
                  disabled={index === settings.savedJustifications.length - 1}
                  title="Move down"
                  aria-label={`Move ${item} down`}
                >
                  <MoveIcon direction="down" />
                </button>
                <button className="btn danger" onClick={() => void removeSaved(item)}>
                  Remove
                </button>
              </div>
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

function MoveIcon({ direction }: { direction: "up" | "down" }) {
  const arrowPath = direction === "up" ? "M12 5l-6 6" : "M12 19l-6-6";
  const mirroredPath = direction === "up" ? "M12 5l6 6" : "M12 19l6-6";
  const linePath = direction === "up" ? "M12 6v13" : "M12 18V5";
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon">
      <path d={arrowPath} />
      <path d={mirroredPath} />
      <path d={linePath} />
    </svg>
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
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
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
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
}) {
  const [defaultDurationHours, setDefaultDurationHours] = useState(settings.preferences.defaultDurationHours);
  const [defaultSort, setDefaultSort] = useState<SortMode>(settings.preferences.defaultSort);
  const [recentJustificationLimit, setRecentJustificationLimit] = useState(settings.preferences.recentJustificationLimit);
  const [activityHistoryLimit, setActivityHistoryLimit] = useState(settings.preferences.activityHistoryLimit);
  const [darkMode, setDarkMode] = useState(settings.preferences.darkMode);
  const [showActivationCounters, setShowActivationCounters] = useState(settings.preferences.showActivationCounters);
  const [showEnablementDetails, setShowEnablementDetails] = useState(settings.preferences.showEnablementDetails);
  const [showLastEnablementDate, setShowLastEnablementDate] = useState(settings.preferences.showLastEnablementDate);
  const [backgroundPreRefreshEnabled, setBackgroundPreRefreshEnabled] = useState(settings.preferences.backgroundPreRefreshEnabled);
  const [enabledFeatures, setEnabledFeatures] = useState<Set<QuickPimFeature>>(new Set(settings.preferences.enabledFeatures));
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (isDirty) {
      return;
    }
    setDefaultDurationHours(settings.preferences.defaultDurationHours);
    setDefaultSort(settings.preferences.defaultSort);
    setRecentJustificationLimit(settings.preferences.recentJustificationLimit);
    setActivityHistoryLimit(settings.preferences.activityHistoryLimit);
    setDarkMode(settings.preferences.darkMode);
    setShowActivationCounters(settings.preferences.showActivationCounters);
    setShowEnablementDetails(settings.preferences.showEnablementDetails);
    setShowLastEnablementDate(settings.preferences.showLastEnablementDate);
    setBackgroundPreRefreshEnabled(settings.preferences.backgroundPreRefreshEnabled);
    setEnabledFeatures(new Set(settings.preferences.enabledFeatures));
  }, [
    settings.preferences.activityHistoryLimit,
    settings.preferences.backgroundPreRefreshEnabled,
    settings.preferences.darkMode,
    settings.preferences.defaultDurationHours,
    settings.preferences.defaultSort,
    settings.preferences.enabledFeatures,
    settings.preferences.recentJustificationLimit,
    settings.preferences.showActivationCounters,
    settings.preferences.showEnablementDetails,
    settings.preferences.showLastEnablementDate,
    isDirty
  ]);

  async function save() {
    const saved = await onSave({
      ...settings,
      preferences: {
        ...settings.preferences,
        defaultDurationHours,
        defaultSort,
        recentJustificationLimit,
        activityHistoryLimit,
        darkMode,
        showActivationCounters,
        showEnablementDetails,
        showLastEnablementDate,
        backgroundPreRefreshEnabled,
        enabledFeatures: [...enabledFeatures],
        autoEnabledFeaturesInitialized: true
      }
    });
    if (saved) {
      setIsDirty(false);
    }
  }

  function toggleFeature(feature: QuickPimFeature, enabled: boolean) {
    setIsDirty(true);
    setEnabledFeatures((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(feature);
      } else {
        next.delete(feature);
      }
      return next;
    });
  }

  return (
    <section className="panel">
      <h2>Preferences</h2>
      <div className="preference-section">
        <h3>Popup defaults</h3>
        <p className="muted">These values are preselected when the popup opens. Role policies can still cap duration choices.</p>
        <div className="form-grid three settings-section-gap popup-defaults-grid">
          <div className="field">
            <label>Default activation duration</label>
            <select
              className="select"
              value={String(defaultDurationHours)}
              onChange={(event) => {
                setDefaultDurationHours(Number(event.target.value));
                setIsDirty(true);
              }}
              aria-label="Default activation duration"
            >
              {DEFAULT_DURATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="muted">Preselected in the popup when selected roles allow it.</p>
          </div>
          <div className="field">
            <label>Default sort order</label>
            <select className="select" value={defaultSort} onChange={(event) => {
              setDefaultSort(event.target.value as SortMode);
              setIsDirty(true);
            }}>
              <option value="name">Name</option>
              <option value="lastUsed">Last use</option>
              <option value="activationCount">Activation count</option>
              <option value="type">Type</option>
              <option value="scope">Scope</option>
            </select>
            <p className="muted">Initial sort used in role tabs.</p>
          </div>
          <div className="field">
            <label>Recent justification history limit</label>
            <input className="input" type="number" min="1" max="20" value={recentJustificationLimit} onChange={(event) => {
              setRecentJustificationLimit(Number(event.target.value));
              setIsDirty(true);
            }} />
            <p className="muted">How many recent reasons the picker keeps.</p>
          </div>
        </div>
      </div>
      <div className="preference-section">
        <h3>Display</h3>
        <label className="checkbox-option preference-toggle">
          <input type="checkbox" checked={darkMode} onChange={(event) => {
            setDarkMode(event.target.checked);
            setIsDirty(true);
          }} aria-label="Dark mode" />
          <span>
            <strong>Dark mode</strong>
            <br />
            <span className="muted">Use dark surfaces in the popup and settings.</span>
          </span>
        </label>
      </div>
      <div className="preference-section">
        <h3>Advanced settings</h3>
        <p className="muted">Optional detail, usage, and cache controls for users who want more visibility.</p>
        <label className="checkbox-option preference-toggle">
          <input
            type="checkbox"
            checked={showActivationCounters}
            onChange={(event) => {
              setShowActivationCounters(event.target.checked);
              setIsDirty(true);
            }}
            aria-label="Show activation counters in popup"
          />
          <span>
            <strong>Show activation counters</strong>
            <br />
            <span className="muted">Display the compact usage number on each popup row.</span>
          </span>
        </label>
        <label className="checkbox-option preference-toggle">
          <input
            type="checkbox"
            checked={showEnablementDetails}
            onChange={(event) => {
              setShowEnablementDetails(event.target.checked);
              setIsDirty(true);
            }}
            aria-label="Show enablement details in popup"
          />
          <span>
            <strong>Show enablement details</strong>
            <br />
            <span className="muted">Display per-row policy details such as max duration, required reason, ticket, and approval.</span>
          </span>
        </label>
        <label className="checkbox-option preference-toggle">
          <input
            type="checkbox"
            checked={showLastEnablementDate}
            onChange={(event) => {
              setShowLastEnablementDate(event.target.checked);
              setIsDirty(true);
            }}
            aria-label="Show last enablement date in popup"
          />
          <span>
            <strong>Show last enablement date</strong>
            <br />
            <span className="muted">Display the last enablement date on popup rows as yyyy-MM-dd.</span>
          </span>
        </label>
        <label className="checkbox-option preference-toggle">
          <input
            type="checkbox"
            checked={backgroundPreRefreshEnabled}
            onChange={(event) => {
              setBackgroundPreRefreshEnabled(event.target.checked);
              setIsDirty(true);
            }}
            aria-label="Enable background pre-refresh"
          />
          <span>
            <strong>Background pre-refresh</strong>
            <br />
            <span className="muted">Refresh stale enabled role data every 10 minutes while browser alarms are available.</span>
          </span>
        </label>
        <div className="field settings-field-gap">
          <label>Activity history limit</label>
          <input
            className="input"
            type="number"
            min="10"
            max="200"
            value={activityHistoryLimit}
            onChange={(event) => {
              setActivityHistoryLimit(Number(event.target.value));
              setIsDirty(true);
            }}
          />
          <p className="muted">Maximum local activation/deactivation activity entries to keep.</p>
        </div>
      </div>
      <div className="preference-section">
        <h3>Enabled features</h3>
        <p className="muted">Only enabled role features are fetched, shown in the popup, and checked by Access Setup. Empty enabled role tabs are still hidden automatically.</p>
        <div className="checkbox-grid compact settings-section-gap">
          {(["directoryRole", "pimGroup", "azureRole", "bundles"] as QuickPimFeature[]).map((feature) => (
            <label className="checkbox-option" key={feature}>
              <input
                type="checkbox"
                checked={enabledFeatures.has(feature)}
                onChange={(event) => toggleFeature(feature, event.target.checked)}
                aria-label={`Enable ${popupTabLabel(feature)} feature`}
              />
              <span>Enable {popupTabLabel(feature)}</span>
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
                {formatDateOnly(stats.lastUsedAt) ? ` / ${formatDateOnly(stats.lastUsedAt)}` : ""}
              </span>
            </span>
          </div>
        ))}
        <button className="btn danger" onClick={() => void onSave({ ...settings, usageStatsByItemId: {}, activationHistory: [], activityHistory: [] }, "Usage data reset.")}>
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
  onClearMessage,
  onError
}: {
  settings: QuickPimSettings;
  exportText: string;
  setExportText: (value: string, dirty?: boolean) => void;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
  onClearMessage: () => void;
  onError: (message: string) => void;
}) {
  async function importSettings() {
    onClearMessage();
    onError("");
    try {
      const parsed: unknown = JSON.parse(exportText);
      if (!isSettingsImportObject(parsed)) {
        throw new Error("Import JSON must be a QuickPIM++ settings object with at least one recognized section.");
      }
      const imported = mergeImportedSettings(settings, parsed);
      if (await onSave(imported, "Settings imported.")) {
        setExportText(JSON.stringify(imported, null, 2));
      }
    } catch (importError) {
      onError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  return (
    <section className="panel">
      <h2>Import / Export</h2>
      <p className="muted">Settings are stored locally in Chrome storage under {SETTINGS_KEY}.</p>
      <textarea aria-label="QuickPIM++ settings JSON" className="textarea code-box" value={exportText} onChange={(event) => setExportText(event.target.value, true)} />
      <div className="button-row settings-form-actions">
        <button className="btn" onClick={() => setExportText(JSON.stringify(settings, null, 2))}>
          Refresh export
        </button>
        <button className="btn primary" onClick={() => void importSettings()}>
          Import JSON
        </button>
        <button className="btn danger" onClick={() => void (async () => {
          if (await onSave(DEFAULT_SETTINGS, "Settings reset.")) {
            setExportText(JSON.stringify(DEFAULT_SETTINGS, null, 2));
          }
        })()}>
          Reset all settings
        </button>
      </div>
    </section>
  );
}

function isSettingsImportObject(value: unknown): value is Partial<QuickPimSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = new Set(Object.keys(value));
  return ["aliasesByItemId", "favoriteItemIds", "savedJustifications", "recentJustifications", "bundles", "usageStatsByItemId", "activityHistory", "preferences"]
    .some((key) => keys.has(key));
}

function tabLabel(tab: SettingsTab): string {
  const labels: Record<SettingsTab, string> = {
    home: "Home",
    access: "Access Setup",
    activity: "Activity",
    aliases: "Aliases",
    justifications: "Justifications",
    bundles: "Bundles",
    preferences: "Preferences",
    data: "Import / Export",
    diagnostics: "Diagnostics",
    about: "About"
  };
  return labels[tab];
}

function tabFromHash(): SettingsTab {
  const value = window.location.hash.replace("#", "");
  if (value === "permissions") {
    return "access";
  }
  if (["home", "about", "access", "activity", "aliases", "justifications", "bundles", "preferences", "data", "diagnostics"].includes(value)) {
    return value as SettingsTab;
  }
  return "home";
}

function applyDisplayData(
  items: ActivationItem[],
  settings: QuickPimSettings,
  referenceData: ReferenceDataCache | undefined
): ActivationItem[] {
  return items.map((item) => {
    const canonical = {
      ...item,
      displayName: item.sourceName,
      scopeLabel: item.sourceScopeLabel || item.scopeLabel,
      sourceScopeLabel: item.sourceScopeLabel || item.scopeLabel
    } as ActivationItem;
    return {
      ...canonical,
      displayName: getDisplayName(canonical, settings, referenceData),
      scopeLabel: getScopeLabel(canonical, referenceData)
    } as ActivationItem;
  });
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

async function loadGithubChangelog(now = Date.now()): Promise<ChangelogItem[]> {
  const cached = await loadCachedChangelog(now);
  if (cached) {
    return cached;
  }

  const currentRelease = await loadCurrentRelease();
  if (currentRelease) {
    await saveChangelogCache([currentRelease], now);
    return [currentRelease];
  }

  const releases = await fetchGithubJson(`${GITHUB_API_BASE}/releases?per_page=5`);
  if (Array.isArray(releases) && releases.length) {
    const items = releases
      .filter((item): item is Record<string, unknown> => item && typeof item === "object")
      .slice(0, 5)
      .map((release) => ({
        title: sanitizeChangelogText(release.name || release.tag_name || "Release", 100) || "Release",
        description: getSummaryText(release.body) || "Release notes are available on GitHub.",
        url: sanitizeGithubUrl(release.html_url),
        date: sanitizeChangelogDate(release.published_at)
      }));
    await saveChangelogCache(items, now);
    return items;
  }

  const commits = await fetchGithubJson(`${GITHUB_API_BASE}/commits?per_page=5`);
  const items = Array.isArray(commits)
    ? commits
      .filter((item): item is Record<string, unknown> => item && typeof item === "object")
      .slice(0, 5)
      .map((item) => {
        const commit = item.commit && typeof item.commit === "object" ? item.commit as Record<string, unknown> : {};
        return {
          title: getSummaryText(commit.message) || sanitizeChangelogText(item.sha, 7) || "Commit",
          description: "Latest repository commit.",
          url: sanitizeGithubUrl(item.html_url),
          date: getCommitDate(commit)
        };
      })
    : [];
  await saveChangelogCache(items, now);
  return items;
}

async function loadCurrentRelease(): Promise<ChangelogItem | undefined> {
  try {
    const release = await fetchGithubJson(`${GITHUB_API_BASE}/releases/tags/${APP_RELEASE_TAG}`);
    if (!release || typeof release !== "object" || Array.isArray(release)) {
      return undefined;
    }
    return buildChangelogItem(release as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function buildChangelogItem(release: Record<string, unknown>): ChangelogItem {
  return {
    title: sanitizeChangelogText(release.name || release.tag_name || "Release", 100) || "Release",
    description: getSummaryText(release.body) || "Release notes are available on GitHub.",
    url: sanitizeGithubUrl(release.html_url),
    date: sanitizeChangelogDate(release.published_at)
  };
}

async function fetchGithubJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CHANGELOG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function getSummaryText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 180) || "";
}

function getCommitDate(commit: Record<string, unknown>): string | undefined {
  const author = commit.author && typeof commit.author === "object" ? commit.author as Record<string, unknown> : undefined;
  return sanitizeChangelogDate(author?.date);
}

async function loadCachedChangelog(now: number): Promise<ChangelogItem[] | undefined> {
  const result = await chrome.storage.local.get(CHANGELOG_CACHE_KEY);
  const cache = coerceChangelogCache(result[CHANGELOG_CACHE_KEY]);
  if (!cache || cache.releaseTag !== APP_RELEASE_TAG || now - cache.fetchedAt > CHANGELOG_CACHE_TTL_MS) {
    return undefined;
  }
  return cache.items;
}

async function saveChangelogCache(items: ChangelogItem[], fetchedAt: number): Promise<void> {
  await chrome.storage.local.set({
    [CHANGELOG_CACHE_KEY]: {
      fetchedAt,
      releaseTag: APP_RELEASE_TAG,
      items: coerceChangelogItems(items)
    }
  });
}

function coerceChangelogCache(value: unknown): ChangelogCache | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const fetchedAt = Number(record.fetchedAt);
  const releaseTag = sanitizeChangelogText(record.releaseTag, 32);
  const items = coerceChangelogItems(record.items);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || !releaseTag || !items.length) {
    return undefined;
  }
  return { fetchedAt, releaseTag, items };
}

function coerceChangelogItems(value: unknown): ChangelogItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, 5)
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const record = item as Record<string, unknown>;
      const title = sanitizeChangelogText(record.title, 100);
      if (!title) {
        return [];
      }
      return [{
        title,
        description: sanitizeChangelogText(record.description, 180) || "Release notes are available on GitHub.",
        url: sanitizeGithubUrl(record.url),
        date: sanitizeChangelogDate(record.date)
      }];
    });
}

function sanitizeChangelogText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function sanitizeManifestText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sanitizeGithubUrl(value: unknown): string {
  if (typeof value !== "string") {
    return REPOSITORY_URL;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.pathname.startsWith("/RobinMJD/QuickPIM-PlusPlus")
      ? parsed.toString()
      : REPOSITORY_URL;
  } catch {
    return REPOSITORY_URL;
  }
}

function sanitizeChangelogDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

function normalizeRefreshTargets(targets: AccessSetupTarget[], enabledRoleFeatures: AccessSetupTarget[]): AccessSetupTarget[] {
  const enabled = new Set(enabledRoleFeatures);
  return targets.filter((target, index) => enabled.has(target) && targets.indexOf(target) === index);
}

async function fetchActivationSnapshot(targets: AccessSetupTarget[]): Promise<ActivationSnapshot> {
  try {
    const snapshot = await sendMessage<ActivationSnapshot>({
      action: "getActivationSnapshot",
      targets
    });
    if (isActivationSnapshot(snapshot)) {
      return snapshot;
    }
  } catch {
    // Fall through to the legacy paired calls for compatibility with older/background test runtimes.
  }

  const [eligible, active] = await Promise.all([
    sendMessage<ActivationSnapshot["eligible"]>({
      action: "getActivationItems",
      targets
    }),
    sendMessage<ActivationSnapshot["active"]>({
      action: "getActiveItems",
      targets
    })
  ]);
  return {
    eligible,
    active,
    eligibleByTarget: splitActivationResultByTarget(eligible, targets),
    activeByTarget: splitActivationResultByTarget(active, targets)
  };
}

function isActivationSnapshot(value: unknown): value is ActivationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isActivationDataResult(record.eligible) && isActivationDataResult(record.active);
}

function isActivationDataResult(value: unknown): value is ActivationSnapshot["eligible"] {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).items));
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
  if (!response?.success) {
    throw new Error(response?.error || "QuickPIM++ background request failed.");
  }
  return response.data as T;
}

function isTestRuntime() {
  return typeof process !== "undefined" && process.env.NODE_ENV === "test";
}

const rootElement = document.getElementById("root");
if (rootElement) {
  const testWindow = window as Window & { __quickPimSettingsUnmount?: () => void };
  if (isTestRuntime()) {
    testWindow.__quickPimSettingsUnmount?.();
  }
  const root = createRoot(rootElement);
  root.render(<SettingsApp />);
  if (isTestRuntime()) {
    testWindow.__quickPimSettingsUnmount = () => root.unmount();
  }
}
