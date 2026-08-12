import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { buildAccessCapabilityItems, buildTargetCacheKey, buildTokenCacheKey, buildTargetCacheKeys, getAccessSetupTargets, hasRequiredPortalToken } from "../lib/access";
import { formatDateOnly, formatLocalDateTime, formatUtcDateTime } from "../lib/dateFormat";
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
import { DEFAULT_DURATION_OPTIONS, ENTRA_PORTAL_URLS, coerceDurationForItems, formatLoadMessages, getDurationOptions, tabLabel as popupTabLabel } from "../lib/popupModel";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  buildFeatureCacheKey,
  createBundleId,
  getDisplayName,
  getEnabledRoleFeatures,
  getScopeLabel,
  loadSettings,
  mergeSettings,
  mutateSettings
} from "../lib/settings";
import {
  clearReferenceData,
  learnReferenceDataFromItems,
  loadReferenceData,
  saveReferenceData
} from "../lib/referenceData";
import { MAX_USER_JUSTIFICATION_LENGTH, getGenericJustificationWarning } from "../lib/justifications";
import { APP_BUILD_TIMESTAMP, APP_NAME, APP_RELEASE_TAG, APP_VERSION } from "../lib/appMetadata";
import { TOKEN_STORAGE_KEYS } from "../lib/tokenStorage";
import { isOperationTimeoutError } from "../lib/async";
import { sendRuntimeMessage } from "../lib/runtimeMessaging";
import { savePopupDraft } from "../lib/popupDraft";
import { sanitizePortalRecoveryStatus } from "../lib/portalRecoveryTabs";
import { EXTENSION_DURATION_OPTIONS, buildTrackedRequestExtensionPlan, formatExtensionDuration } from "../lib/requestExtension";
import { getIdentityContext } from "../lib/identityContext";
import { stringifySupportReport } from "../lib/supportReport";
import {
  CHROME_WEB_STORE_URL,
  EDGE_ADDONS_URL,
  browserFamilyLabel,
  distributionLabel,
  getExtensionDistributionInfo,
  type ExtensionDistributionInfo
} from "../lib/distribution";
import {
  BROWSER_SYNC_LOCAL_STATE_KEY,
  BROWSER_SYNC_VERIFICATION_FRESHNESS_MS,
  formatBrowserSyncInstallationId,
  sanitizeBrowserSyncStatus,
  type BrowserSyncDevice,
  type BrowserSyncStatus
} from "../lib/browserSync";
import { MAX_SETTINGS_BACKUP_BYTES, buildSettingsExportFileName, validateSettingsBackup } from "../lib/settingsBackup";
import { SmartProgressPanel } from "../components/SmartProgressPanel";
import {
  advanceOperationProgress,
  completeOperationProgress,
  createOperationProgress,
  failOperationProgress,
  type OperationProgress,
  type ProgressStepDefinition
} from "../lib/progress";
import {
  REQUEST_TRACKING_KEY,
  clearTrackedRequests,
  getEffectiveTrackedRequestStatus,
  getPendingTrackedRequestCount,
  loadTrackedRequests,
  sanitizeTrackedRequestStore,
  trackedRequestStatusLabel
} from "../lib/requestTracking";
import type { AccessSetupTarget, ActivationItem, ActivationSnapshot, ActivityAction, ActivityResult, PortalRecoveryFocusResult, PortalRecoveryOpenResult, PortalRecoveryStatus, PortalTokenRefreshResult, QuickPimBundle, QuickPimDataCache, QuickPimFeature, QuickPimSettings, ReferenceDataCache, TokenStatus, TrackedPimRequest, TrackedPimRequestStatus, TrackedPimRequestStore, TrackedRequestExtensionResult } from "../lib/types";

type SettingsTab = "home" | "role-access" | "appearance" | "aliases" | "activation" | "justifications" | "bundles" | "activity" | "sync" | "diagnostics" | "backup" | "reset" | "about";
type PreferencePage = "appearance" | "activation";

const CONCEPT_CREATOR = "Daniel Bradley";
const INSPIRATION_REPOSITORY_URL = "https://github.com/DanielBradley1/QuickPIM";
const REPOSITORY_URL = "https://github.com/RobinMJD/QuickPIM-PlusPlus";
const GITHUB_API_BASE = "https://api.github.com/repos/RobinMJD/QuickPIM-PlusPlus";
const CHANGELOG_CACHE_KEY = "quickPimChangelog.v2";
const CHANGELOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CHANGELOG_FETCH_TIMEOUT_MS = 5000;
const PORTAL_TOKEN_WAIT_TIMEOUT_MS = 12_000;
const PORTAL_TOKEN_POLL_INTERVAL_MS = 1500;
const TOKEN_STATUS_TIMEOUT_MS = 8_000;
const PORTAL_TOKEN_REFRESH_TIMEOUT_MS = 17_000;
const ACTIVATION_SNAPSHOT_TIMEOUT_MS = 25_000;
const SETTINGS_REFRESH_STEPS: readonly ProgressStepDefinition[] = [
  { id: "local", label: "Reading settings and local data", weight: 2, expectedDurationMs: 2_000 },
  { id: "sources", label: "Refreshing enabled role sources", weight: 15, expectedDurationMs: 15_000 },
  { id: "save", label: "Saving role data and learned names", weight: 3, expectedDurationMs: 3_000 }
];
const ACCESS_REFRESH_STEPS: readonly ProgressStepDefinition[] = [
  { id: "local", label: "Reading local access state", weight: 2, expectedDurationMs: 2_000 },
  { id: "sources", label: "Checking enabled Microsoft role sources", weight: 15, expectedDurationMs: 15_000 },
  { id: "save", label: "Saving access diagnostics and learned names", weight: 3, expectedDurationMs: 3_000 }
];

const NAV_SECTIONS: Array<{ title: string; tabs: SettingsTab[] }> = [
  { title: "Overview", tabs: ["home"] },
  { title: "Access", tabs: ["role-access"] },
  { title: "Personalization", tabs: ["appearance", "aliases"] },
  { title: "Activation", tabs: ["activation", "justifications", "bundles"] },
  { title: "Review", tabs: ["activity"] },
  { title: "Data & Support", tabs: ["sync", "diagnostics", "backup", "reset"] },
  { title: "Product", tabs: ["about"] }
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
  const [trackedRequests, setTrackedRequests] = useState<TrackedPimRequestStore>({ version: 1, requests: [] });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [exportText, setExportText] = useState("");
  const [exportBaselineText, setExportBaselineText] = useState("");
  const [exportExternalChange, setExportExternalChange] = useState(false);
  const [isRefreshingEligible, setIsRefreshingEligible] = useState(false);
  const [isRefreshingAccess, setIsRefreshingAccess] = useState(false);
  const [eligibleRefreshProgress, setEligibleRefreshProgress] = useState<OperationProgress | null>(null);
  const [accessRefreshProgress, setAccessRefreshProgress] = useState<OperationProgress | null>(null);
  const [isSettingsReady, setIsSettingsReady] = useState(false);
  const [sessionTokenRevision, setSessionTokenRevision] = useState(0);
  const exportTextDirty = useRef(false);
  const accessRefreshQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingAccessRefreshes = useRef(0);
  const pendingSessionTokenTargets = useRef(new Set<AccessSetupTarget>());
  const suppressSessionTokenRefreshUntil = useRef(0);
  const explicitPortalScanDepth = useRef(0);
  const settingsProgressRunId = useRef(0);
  const settingsMutationQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingTabFlushRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const pendingPreferenceFlush = useRef<Promise<void>>(Promise.resolve());
  const eligibleProgressClearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const accessProgressClearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function replaceExportText(value: string, dirty = false) {
    exportTextDirty.current = dirty;
    setExportText(value);
    if (!dirty) {
      setExportBaselineText(value);
      setExportExternalChange(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => () => {
    if (eligibleProgressClearTimer.current) {
      clearTimeout(eligibleProgressClearTimer.current);
    }
    if (accessProgressClearTimer.current) {
      clearTimeout(accessProgressClearTimer.current);
    }
  }, []);

  useEffect(() => {
    const storageChangeEvent = chrome.storage?.onChanged;
    if (!storageChangeEvent) {
      return;
    }
    function handleStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName === "session") {
        if (explicitPortalScanDepth.current > 0 || Date.now() < suppressSessionTokenRefreshUntil.current) {
          return;
        }
        const targets = getTargetsForTokenStorageChanges(changes);
        if (targets.length) {
          targets.forEach((target) => pendingSessionTokenTargets.current.add(target));
          setSessionTokenRevision((current) => current + 1);
        }
        return;
      }
      if (areaName !== "local") {
        return;
      }
      if (changes[REQUEST_TRACKING_KEY]) {
        setTrackedRequests(sanitizeTrackedRequestStore(changes[REQUEST_TRACKING_KEY].newValue));
      }
      if (!changes[SETTINGS_KEY]) {
        return;
      }
      const merged = mergeSettings(changes[SETTINGS_KEY].newValue as Partial<QuickPimSettings> | undefined);
      setSettings(merged);
      const serialized = JSON.stringify(merged, null, 2);
      if (!exportTextDirty.current) {
        replaceExportText(serialized);
      } else {
        setExportBaselineText(serialized);
        setExportExternalChange(true);
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
      void transitionToTab(tabFromHash(), false);
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  async function refresh(options: { showProgress?: boolean } = {}) {
    const refreshStartedAt = Date.now();
    let progress: OperationProgress | null = null;
    let progressCompleted = false;
    let refreshIssues: string[] = [];
    const showProgressStep = (current: number, label?: string) => {
      if (!progress) {
        return;
      }
      progress = advanceOperationProgress(progress, current, { label });
      setEligibleRefreshProgress(progress);
    };
    if (options.showProgress) {
      setIsRefreshingEligible(true);
      setMessage("");
      setAccessRefreshProgress(null);
      if (eligibleProgressClearTimer.current) {
        clearTimeout(eligibleProgressClearTimer.current);
        eligibleProgressClearTimer.current = undefined;
      }
      progress = createOperationProgress(
        `settings-eligible-${++settingsProgressRunId.current}`,
        SETTINGS_REFRESH_STEPS
      );
      setEligibleRefreshProgress(progress);
    }
    setError("");
    try {
      const loadedSettings = await loadSettings();
      setSettings(loadedSettings);
      if (!exportTextDirty.current) {
        replaceExportText(JSON.stringify(loadedSettings, null, 2));
      }
      setIsSettingsReady(true);
      const [loadedTokens, loadedCache, loadedReferenceData, loadedTrackedRequests] = await Promise.all([
        sendMessage<TokenStatus>(
          { action: "getTokenStatus" },
          { timeoutMs: TOKEN_STATUS_TIMEOUT_MS, timeoutMessage: "Token status check timed out. Saved settings and cached data remain available." }
        ),
        loadDataCache(),
        loadReferenceData(),
        loadTrackedRequests()
      ]);
      setTrackedRequests(loadedTrackedRequests);
      const tokenCacheKey = buildTokenCacheKey(loadedTokens);
      const enabledRoleFeatures = getEnabledRoleFeatures(loadedSettings);
      let effectiveTokenStatus = loadedTokens;
      let targetCacheKeys = buildTargetCacheKeys(effectiveTokenStatus, enabledRoleFeatures);
      let legacyCacheKey = buildFeatureCacheKey(tokenCacheKey, enabledRoleFeatures);
      let nextCache = loadedCache;
      if (options.showProgress && enabledRoleFeatures.length) {
        showProgressStep(2);
        const snapshot = await fetchActivationSnapshot(enabledRoleFeatures);
        refreshIssues = formatLoadMessages([
          ...(snapshot.eligible.errors || []),
          ...(snapshot.active.errors || [])
        ]);
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
          snapshotTargetCacheKeys,
          refreshStartedAt
        );
        nextCache = updateCacheFromTargetResults(
          nextCache,
          "active",
          enabledRoleFeatures,
          snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, enabledRoleFeatures),
          fetchedAt,
          snapshotTargetCacheKeys,
          refreshStartedAt
        );
        showProgressStep(3);
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
      showProgressStep(3);
      await saveReferenceData(nextReferenceData);
      setItems(applyDisplayData(eligible.items, loadedSettings, nextReferenceData));
      setTokenStatus(effectiveTokenStatus);
      setDataCache(nextCache);
      setReferenceData(nextReferenceData);
      if (options.showProgress) {
        if (refreshIssues.length) {
          throw new Error(refreshIssues.join("\n"));
        }
        setMessage(
          eligible.items.length
            ? `Eligible items refreshed from ${formatCacheAge(eligible.fetchedAt)}.`
            : "Eligible items refreshed."
        );
        if (progress) {
          progress = completeOperationProgress(progress, "Eligible items refreshed");
          progressCompleted = true;
          setEligibleRefreshProgress(progress);
        }
      }
    } catch (loadError) {
      const detail = loadError instanceof Error ? loadError.message : String(loadError);
      setMessage("");
      setError(detail);
      if (progress) {
        progress = failOperationProgress(progress, detail, "Eligible-item refresh stopped at this step");
        setEligibleRefreshProgress(progress);
      }
    } finally {
      if (options.showProgress) {
        setIsRefreshingEligible(false);
        if (progressCompleted && progress) {
          const operationId = progress.operationId;
          eligibleProgressClearTimer.current = setTimeout(() => {
            setEligibleRefreshProgress((current) => current?.operationId === operationId ? null : current);
            eligibleProgressClearTimer.current = undefined;
          }, 350);
        }
      }
    }
  }

  function forceRefreshAccessData(
    tokens?: TokenStatus,
    targets?: AccessSetupTarget[],
    options: AccessRefreshOptions = {}
  ): Promise<void> {
    if (accessProgressClearTimer.current) {
      clearTimeout(accessProgressClearTimer.current);
      accessProgressClearTimer.current = undefined;
    }
    let progress = createOperationProgress(
      `settings-access-${++settingsProgressRunId.current}`,
      ACCESS_REFRESH_STEPS,
      { label: pendingAccessRefreshes.current ? "Waiting for the current access refresh" : undefined }
    );
    let progressCompleted = false;
    const showProgressStep = (current: number, label?: string) => {
      progress = advanceOperationProgress(progress, current, { label });
      setAccessRefreshProgress(progress);
    };
    pendingAccessRefreshes.current += 1;
    setIsRefreshingAccess(true);
    setEligibleRefreshProgress(null);
    setAccessRefreshProgress(progress);
    const refreshRun = accessRefreshQueue.current.then(() => {
      // Clear feedback when this queued run actually starts. Clearing it while
      // enqueuing allows an older run to publish a stale error after the clear.
      setError("");
      setMessage("");
      showProgressStep(1, "Reading local access state");
      return performAccessDataRefresh(tokens, targets, options, showProgressStep);
    });
    accessRefreshQueue.current = refreshRun.then(() => undefined, () => undefined);

    return refreshRun.then(() => {
      setError("");
      progress = completeOperationProgress(progress, "Access data refreshed");
      progressCompleted = true;
      setAccessRefreshProgress(progress);
    }).catch((refreshError) => {
      const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
      setMessage("");
      setError(detail);
      progress = failOperationProgress(progress, detail, "Access refresh stopped at this step");
      setAccessRefreshProgress(progress);
    }).finally(() => {
      pendingAccessRefreshes.current -= 1;
      if (!pendingAccessRefreshes.current) {
        setIsRefreshingAccess(false);
      }
      if (progressCompleted) {
        const operationId = progress.operationId;
        accessProgressClearTimer.current = setTimeout(() => {
          setAccessRefreshProgress((current) => current?.operationId === operationId ? null : current);
          accessProgressClearTimer.current = undefined;
        }, 350);
      }
    });
  }

  async function performAccessDataRefresh(
    tokens: TokenStatus | undefined,
    targets: AccessSetupTarget[] | undefined,
    options: AccessRefreshOptions,
    onProgress: (current: number, label?: string) => void
  ): Promise<void> {
    const refreshStartedAt = Date.now();
    const [loadedSettings, currentCache, currentReferenceData, loadedTokens] = await Promise.all([
      loadSettings(),
      loadDataCache(),
      loadReferenceData(),
      tokens
        ? Promise.resolve(tokens)
        : sendMessage<TokenStatus>(
          { action: "getTokenStatus" },
          { timeoutMs: TOKEN_STATUS_TIMEOUT_MS, timeoutMessage: "Token status check timed out. Cached access data remains available." }
        )
    ]);
    const latestTokens = loadedTokens;
    const enabledRoleFeatures = getEnabledRoleFeatures(loadedSettings);
    let refreshTargets = normalizeRefreshTargets(targets?.length ? targets : enabledRoleFeatures, enabledRoleFeatures);
    if (options.skipTargetsWithCurrentTokenCache) {
      refreshTargets = refreshTargets.filter((target) => !isTargetCacheCurrentForToken(currentCache, latestTokens, target));
    }
    onProgress(
      2,
      refreshTargets.length
        ? `Refreshing ${refreshTargets.length} enabled role source${refreshTargets.length === 1 ? "" : "s"}`
        : "Enabled role sources are already current"
    );

    setSettings(loadedSettings);
    setTokenStatus(latestTokens);
    setDataCache(currentCache);
    if (!refreshTargets.length) {
      onProgress(3, "Finalizing current access data");
      setMessage(options.completionMessage || "Access data is already current.");
      return;
    }

    const snapshot = await fetchActivationSnapshot(refreshTargets);
    const fetchedAt = Date.now();
    const snapshotTokenStatus = snapshot.tokenStatus || latestTokens;
    const snapshotTargetCacheKeys = buildTargetCacheKeys(snapshotTokenStatus, enabledRoleFeatures);
    const legacyCacheKey = buildFeatureCacheKey(buildTokenCacheKey(snapshotTokenStatus), enabledRoleFeatures);
    const eligibleResultsByTarget = snapshot.eligibleByTarget || splitActivationResultByTarget(snapshot.eligible, refreshTargets);
    const activeResultsByTarget = snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, refreshTargets);
    let nextCache = updateCacheFromTargetResults(
      currentCache,
      "eligible",
      refreshTargets,
      eligibleResultsByTarget,
      fetchedAt,
      snapshotTargetCacheKeys,
      refreshStartedAt
    );
    nextCache = updateCacheFromTargetResults(
      nextCache,
      "active",
      refreshTargets,
      activeResultsByTarget,
      fetchedAt,
      snapshotTargetCacheKeys,
      refreshStartedAt
    );
    onProgress(3, "Saving access diagnostics and learned names");
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
    const accessCapabilities = buildAccessCapabilityItems(snapshotTokenStatus, nextCache, enabledRoleFeatures);
    const limitedAreas = accessCapabilities.filter((item) => item.status !== "ready").length;
    const refreshErrors = formatLoadMessages(refreshTargets.flatMap((target) => [
      ...(eligibleResultsByTarget[target]?.errors || []),
      ...(activeResultsByTarget[target]?.errors || [])
    ]));
    const completedRecoveryTargets = refreshTargets.filter((target) => {
      const eligibleResult = eligibleResultsByTarget[target];
      const activeResult = activeResultsByTarget[target];
      return Boolean(eligibleResult && activeResult && !eligibleResult.errors.length && !activeResult.errors.length);
    });
    if (completedRecoveryTargets.length) {
      try {
        await sendMessage<AccessSetupTarget[]>({ action: "closePortalRecoveryTabs", targets: completedRecoveryTargets });
      } catch {
        // Access data remains valid even if the browser rejects optional temporary-tab cleanup.
      }
    }
    const completionPrefix = options.completionMessage || "Access data refreshed.";
    if (refreshErrors.length) {
      throw new Error(refreshErrors.join("\n"));
    }
    setMessage(
      limitedAreas
        ? `${completionPrefix} ${limitedAreas} area(s) still need portal access or are limited by the captured portal token.`
        : completionPrefix
    );
  }

  async function scanPortalTabsForTokens(): Promise<TokenStatus> {
    explicitPortalScanDepth.current += 1;
    try {
      const result = await sendMessage<PortalTokenRefreshResult>(
        { action: "refreshPortalTokens" },
        { timeoutMs: PORTAL_TOKEN_REFRESH_TIMEOUT_MS, timeoutMessage: "Portal token scan timed out. Continuing with the currently captured tokens." }
      );
      return result.tokenStatus;
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      return tokenStatus || {
        graph: { hasToken: false },
        azureManagement: { hasToken: false }
      };
    } finally {
      explicitPortalScanDepth.current = Math.max(0, explicitPortalScanDepth.current - 1);
      suppressSessionTokenRefreshUntil.current = Date.now() + 2_000;
    }
  }

  async function persist(next: QuickPimSettings, successMessage = "Settings saved.") {
    if (!isSettingsReady) {
      setError("Wait for saved settings to finish loading before making changes.");
      return false;
    }
    const changedSections = [
      "aliasesByItemId", "favoriteItemIds", "savedJustifications", "recentJustifications", "bundles",
      "usageStatsByItemId", "activityHistory", "activationHistory", "preferences"
    ] as const;
    const sectionsToSave = changedSections.filter((key) => JSON.stringify(next[key]) !== JSON.stringify(settings[key]));
    const operation = settingsMutationQueue.current.then(async () => {
      try {
        const merged = await mutateSettings((latest) => {
          const mergedInput: QuickPimSettings = { ...latest };
          for (const key of sectionsToSave) {
            (mergedInput as unknown as Record<string, unknown>)[key] = next[key];
          }
          return mergedInput;
        });
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
    });
    settingsMutationQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
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

  async function resetExtensionData(): Promise<boolean> {
    try {
      await pendingPreferenceFlush.current;
      await pendingTabFlushRef.current?.();
      await pendingPreferenceFlush.current;
      await sendMessage<boolean>(
        { action: "resetExtensionData" },
        { timeoutMs: 15_000, timeoutMessage: "QuickPIM++ data reset timed out. No success was confirmed." }
      );
      setSettings(DEFAULT_SETTINGS);
      setItems([]);
      setTokenStatus({ graph: { hasToken: false }, azureManagement: { hasToken: false } });
      setDataCache({});
      setReferenceData(undefined);
      setTrackedRequests({ version: 1, requests: [] });
      replaceExportText(JSON.stringify(DEFAULT_SETTINGS, null, 2));
      setError("");
      setMessage("All QuickPIM++ data was cleared.");
      if (!isTestRuntime()) {
        window.location.hash = "#home";
        window.location.reload();
      }
      return true;
    } catch (resetError) {
      setMessage("");
      setError(resetError instanceof Error ? resetError.message : String(resetError));
      return false;
    }
  }

  function transitionToTab(nextTab: SettingsTab, updateHash = true) {
    const flush = pendingTabFlushRef.current?.();
    if (flush) {
      pendingPreferenceFlush.current = flush.catch(() => undefined);
    }
    setTab(nextTab);
    if (updateHash && window.location.hash !== `#${nextTab}`) {
      window.history.replaceState(null, "", `#${nextTab}`);
    }
  }

  function selectTab(nextTab: SettingsTab) {
    transitionToTab(nextTab);
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM++ Settings</h1>
            <p>Set up role access, personalize the popup, configure activation, and manage local data.</p>
          </div>
        </div>
        <button className="btn" onClick={() => void refresh({ showProgress: true })} disabled={isRefreshingEligible || isRefreshingAccess}>
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
        {error && eligibleRefreshProgress?.status !== "error" && accessRefreshProgress?.status !== "error" ? (
          <p className="message error" role="alert">{error}</p>
        ) : null}
        {message ? <p className={message === "Settings saved." ? "message success" : "message"} role="status">{message}</p> : null}
        {eligibleRefreshProgress ? (
          <SmartProgressPanel
            key={eligibleRefreshProgress.operationId}
            title="Refreshing eligible items"
            progress={eligibleRefreshProgress}
          />
        ) : null}
        {accessRefreshProgress ? (
          <SmartProgressPanel
            key={accessRefreshProgress.operationId}
            title="Refreshing access data"
            progress={accessRefreshProgress}
          />
        ) : null}
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
            {tab === "home" ? <HomePanel onNavigate={selectTab} /> : null}
            {tab === "about" ? <AboutPanel tokenStatus={tokenStatus} /> : null}
            {tab === "role-access" ? (
              <section className="panel role-access-page">
                <div className="preferences-title-row">
                  <div>
                    <h2>Role Access</h2>
                    <p className="muted">Review captured Microsoft access, recover missing role data, and manage local access artifacts.</p>
                  </div>
                </div>
                <AccessSetupPanel
                  embedded
                  settings={settings}
                  tokenStatus={tokenStatus}
                  dataCache={dataCache}
                  isRefreshingAccess={isRefreshingAccess}
                  isRefreshingEligible={isRefreshingEligible}
                  onSave={persist}
                  onFlushPreferences={async () => {
                    await pendingPreferenceFlush.current;
                    await pendingTabFlushRef.current?.();
                    await pendingPreferenceFlush.current;
                    const latest = await loadSettings();
                    setSettings(latest);
                    return latest;
                  }}
                  onRefreshAccessData={forceRefreshAccessData}
                  onScanPortalTabsForTokens={scanPortalTabsForTokens}
                  onClearTokens={clearCapturedTokens}
                />
              </section>
            ) : null}
            {tab === "activity" ? (
              <ActivityPanel
                settings={settings}
                items={items}
                referenceData={referenceData}
                trackedRequests={trackedRequests}
                onTrackedRequestsChange={setTrackedRequests}
                onSave={persist}
              />
            ) : null}
            {tab === "aliases" ? (
              <AliasesPanel
                settings={settings}
                items={items}
                referenceData={referenceData}
                onSave={persist}
                onClearReferenceData={clearLearnedReferences}
              />
            ) : null}
            {tab === "justifications" ? <JustificationsPanel settings={settings} onSave={persist} /> : null}
            {tab === "bundles" ? <BundlesPanel settings={settings} items={items} referenceData={referenceData} onSave={persist} /> : null}
            {tab === "activation" ? (
              <PreferencesPanel page="activation" settings={settings} onSave={persist} navigationFlushRef={pendingTabFlushRef} />
            ) : null}
            {tab === "appearance" ? (
              <PreferencesPanel page="appearance" settings={settings} onSave={persist} navigationFlushRef={pendingTabFlushRef} />
            ) : null}
            {tab === "backup" && isSettingsReady ? (
              <DataPanel
                settings={settings}
                exportText={exportText}
                exportBaselineText={exportBaselineText}
                externalChange={exportExternalChange}
                setExportText={replaceExportText}
                onSave={persist}
                onClearMessage={() => setMessage("")}
                onError={setError}
              />
            ) : null}
            {tab === "backup" && !isSettingsReady ? (
              <section className="panel" aria-busy="true">
                <h2>Backup & Restore</h2>
                <p className="muted">Loading saved settings...</p>
              </section>
            ) : null}
            {tab === "diagnostics" ? (
              <DiagnosticsPanel
                tokenStatus={tokenStatus}
                dataCache={dataCache}
                settings={settings}
                trackedRequests={trackedRequests}
              />
            ) : null}
            {tab === "sync" ? <BrowserSyncPanel settings={settings} /> : null}
            {tab === "reset" ? <ResetDataPanel onNavigate={selectTab} onReset={resetExtensionData} /> : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function HomePanel({ onNavigate }: { onNavigate: (tab: SettingsTab) => void }) {
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
        <div className="button-row home-quick-links" aria-label="Settings shortcuts">
          <button className="btn" onClick={() => onNavigate("role-access")}>Role Access</button>
          <button className="btn" onClick={() => onNavigate("appearance")}>Popup & Appearance</button>
          <button className="btn" onClick={() => onNavigate("activation")}>Activation & Notifications</button>
          <button className="btn" onClick={() => onNavigate("activity")}>Activity & Usage</button>
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
    "role-access": ["M12 3l7 3v5c0 4.5-2.8 8.1-7 10-4.2-1.9-7-5.5-7-10V6l7-3z", "M9.5 12.5l1.8 1.8 3.8-4.4"],
    appearance: ["M3 5h18v12H3z", "M8 21h8", "M12 17v4"],
    activation: ["M12 3v3", "M12 18v3", "M6.6 6.6l2.1 2.1", "M15.3 15.3l2.1 2.1", "M5 12h3", "M16 12h3", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
    activity: ["M4 19h16", "M7 16V8", "M12 16V5", "M17 16v-6"],
    aliases: ["M4 7h16", "M7 4v6", "M17 4v6", "M6 14h7", "M6 18h11"],
    justifications: ["M6 4h9l3 3v13H6z", "M14 4v4h4", "M9 12h6", "M9 16h6"],
    bundles: ["M5 7h14v5H5z", "M7 12v5h10v-5", "M9 7V5h6v2"],
    sync: ["M7 7a5 5 0 0 1 8.6-3.5L18 6", "M17 17a5 5 0 0 1-8.6 3.5L6 18", "M18 2v4h-4", "M6 22v-4h4"],
    diagnostics: ["M4 5h16", "M4 12h16", "M4 19h16", "M8 5v14", "M16 5v14"],
    backup: ["M5 5h14v14H5z", "M8 9h8", "M8 13h8", "M8 17h5"],
    reset: ["M4 7h16", "M9 7V4h6v3", "M7 7l1 14h8l1-14", "M10 11v6", "M14 11v6"],
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
  tokenStatus
}: {
  tokenStatus: TokenStatus | null;
}) {
  const manifest = chrome.runtime.getManifest();
  const appName = sanitizeManifestText(manifest.name) || APP_NAME;
  return (
    <section className="panel about-panel">
      <div>
        <h2>{appName} {APP_VERSION}</h2>
        <p className="muted">Quick activation for Microsoft Entra roles, Azure roles, and PIM groups.</p>
        <p className="muted">Build: {formatUtcDateTime(APP_BUILD_TIMESTAMP)}</p>
      </div>
      <div className="about-grid">
        <div>
          <strong>
            Concept credit:{" "}
            <a href={INSPIRATION_REPOSITORY_URL} target="_blank" rel="noreferrer">
              {CONCEPT_CREATOR}
            </a>
          </strong>
          <p className="muted">
            QuickPIM++ was inspired by Daniel Bradley&apos;s original QuickPIM idea. The current extension is an
            independent React and TypeScript implementation with a fully rewritten application codebase, adding PIM
            groups, Azure roles, role bundles, saved justifications, favorites, aliases, dark mode, learned names,
            access setup, and much more!
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
        </div>
      </div>
    </section>
  );
}

function AccessSetupPanel({
  embedded = false,
  settings,
  tokenStatus,
  dataCache,
  isRefreshingAccess,
  isRefreshingEligible,
  onSave,
  onFlushPreferences,
  onRefreshAccessData,
  onScanPortalTabsForTokens,
  onClearTokens
}: {
  embedded?: boolean;
  settings: QuickPimSettings;
  tokenStatus: TokenStatus | null;
  dataCache: QuickPimDataCache;
  isRefreshingAccess: boolean;
  isRefreshingEligible: boolean;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
  onFlushPreferences: () => Promise<QuickPimSettings>;
  onRefreshAccessData: (tokens?: TokenStatus, targets?: AccessSetupTarget[], options?: AccessRefreshOptions) => Promise<void>;
  onScanPortalTabsForTokens: () => Promise<TokenStatus>;
  onClearTokens: () => Promise<void>;
}) {
  const [isRunningSetup, setIsRunningSetup] = useState(false);
  const [isRecheckingPortalTabs, setIsRecheckingPortalTabs] = useState(false);
  const [portalRecoveryStatus, setPortalRecoveryStatus] = useState<PortalRecoveryStatus>(() => emptyPortalRecoveryStatus());
  const [portalRecoveryError, setPortalRecoveryError] = useState("");
  const enabledRoleFeatures = useMemo(() => getEnabledRoleFeatures(settings), [settings]);
  const accessStatus = useMemo(() => buildAccessCapabilityItems(tokenStatus, dataCache, enabledRoleFeatures), [dataCache, enabledRoleFeatures, tokenStatus]);
  const setupTargets = useMemo(() => getAccessSetupTargets(accessStatus), [accessStatus]);
  const identity = useMemo(() => getIdentityContext(tokenStatus), [tokenStatus]);
  const warningIgnored = Boolean(settings.preferences.permissionWarningIgnored);

  useEffect(() => {
    let active = true;
    const updateStatus = async () => {
      const next = await readPortalRecoveryStatus();
      if (active) {
        setPortalRecoveryStatus(next);
      }
    };
    void updateStatus();
    if (portalRecoveryStatus.state === "idle") {
      return () => { active = false; };
    }
    const timer = window.setInterval(() => void updateStatus(), PORTAL_TOKEN_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [portalRecoveryStatus.state]);

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
    if (portalRecoveryStatus.state === "interactionRequired") {
      await continueMicrosoftSignIn();
      return;
    }
    setIsRunningSetup(true);
    setPortalRecoveryError("");
    try {
      const latestSettings = await onFlushPreferences();
      const currentFeatures = getEnabledRoleFeatures(latestSettings);
      const initialTargets = getAccessSetupTargets(buildAccessCapabilityItems(tokenStatus, dataCache, currentFeatures));
      const scannedTokens = await onScanPortalTabsForTokens();
      const remainingTargets = getAccessSetupTargets(
        buildAccessCapabilityItems(scannedTokens, dataCache, currentFeatures)
      ).filter((target) => initialTargets.includes(target));
      if (remainingTargets.length) {
        await sendMessage<PortalRecoveryOpenResult>({ action: "openPortalRecoveryTabs", targets: remainingTargets });
        setPortalRecoveryStatus(await readPortalRecoveryStatus());
      }

      if (!remainingTargets.length) {
        await onRefreshAccessData(scannedTokens, initialTargets, { skipTargetsWithCurrentTokenCache: true });
        return;
      }

      const tokenRefresh = await waitForPortalTokens(remainingTargets, scannedTokens, onScanPortalTabsForTokens);
      setPortalRecoveryStatus(tokenRefresh.recoveryStatus);
      if (tokenRefresh.changedTargets.length) {
        await onRefreshAccessData(tokenRefresh.tokens, tokenRefresh.changedTargets, { skipTargetsWithCurrentTokenCache: true });
      }
      if (tokenRefresh.recoveryStatus.state === "interactionRequired") {
        return;
      }
      const unchangedTargets = remainingTargets.filter((target) => !tokenRefresh.changedTargets.includes(target));
      if (unchangedTargets.length) {
        await onRefreshAccessData(tokenRefresh.tokens, unchangedTargets);
      }
    } finally {
      setIsRunningSetup(false);
      setPortalRecoveryStatus(await readPortalRecoveryStatus());
    }
  }

  async function continueMicrosoftSignIn() {
    setPortalRecoveryError("");
    try {
      const result = await sendMessage<PortalRecoveryFocusResult>({ action: "focusPortalRecoveryTabs" });
      setPortalRecoveryStatus(sanitizePortalRecoveryStatus(result?.status));
      if (!result?.focused) {
        setPortalRecoveryError("The Microsoft sign-in tab is no longer available. Open the missing portal pages again.");
      }
    } catch (focusError) {
      setPortalRecoveryError(focusError instanceof Error ? focusError.message : String(focusError));
    }
  }

  async function recheckPortalAccess() {
    setIsRecheckingPortalTabs(true);
    try {
      const latestSettings = await onFlushPreferences();
      const currentFeatures = getEnabledRoleFeatures(latestSettings);
      const scannedTokens = await onScanPortalTabsForTokens();
      const recoveryStatus = await readPortalRecoveryStatus();
      setPortalRecoveryStatus(recoveryStatus);
      if (recoveryStatus.state === "interactionRequired") {
        return;
      }
      const currentTargets = getAccessSetupTargets(buildAccessCapabilityItems(scannedTokens, dataCache, currentFeatures));
      await onRefreshAccessData(scannedTokens, currentTargets.length ? currentTargets : currentFeatures);
    } finally {
      setIsRecheckingPortalTabs(false);
    }
  }

  return (
    <section className={`${embedded ? "access-setup-section" : "panel"} permissions-panel`}>
      <div className="panel-title-row">
        <div>
          <h2>Access status & recovery</h2>
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

      {identity.label ? (
        <div className={`access-identity ${identity.mismatch ? "mismatch" : ""}`} title={identity.detail}>
          <strong>Microsoft context</strong>
          <span className="access-identity-value">
            {identity.principalName || identity.principalId || "Microsoft account"}
            {identity.tenantId ? ` / tenant ${identity.tenantId}` : ""}
          </span>
          {identity.mismatch ? <span>Different accounts or tenants were captured. Refresh from one account before submitting requests.</span> : null}
        </div>
      ) : null}

      <div className="button-row settings-action-lead">
        <button className="btn primary" onClick={() => void runPortalSetup()} disabled={isRunningSetup || isRecheckingPortalTabs || isRefreshingAccess || isRefreshingEligible || (!setupTargets.length && portalRecoveryStatus.state === "idle")}>
          {isRunningSetup ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>Checking portal access...</span>
            </span>
          ) : (
            portalRecoveryStatus.state === "interactionRequired" ? "Continue Microsoft sign-in" : "Open missing portal pages"
          )}
        </button>
        <button
          className="btn"
          onClick={() => void recheckPortalAccess()}
          disabled={isRunningSetup || isRecheckingPortalTabs || isRefreshingAccess || isRefreshingEligible}
        >
          {isRecheckingPortalTabs && !isRefreshingAccess ? (
            <span className="loading-inline">
              <span className="spinner" aria-hidden="true" />
              <span>{isRecheckingPortalTabs ? "Scanning portal tabs..." : "Rechecking access..."}</span>
            </span>
          ) : (
            "Recheck now"
          )}
        </button>
        <button className="btn danger" onClick={() => void onClearTokens()} disabled={isRunningSetup || isRecheckingPortalTabs || isRefreshingAccess || isRefreshingEligible}>
          Clear captured tokens
        </button>
      </div>
      {portalRecoveryStatus.state === "interactionRequired" ? (
        <section className="portal-interaction-panel" role="status">
          <span className="portal-interaction-icon" aria-hidden="true">!</span>
          <div>
            <strong>
              {portalRecoveryStatus.interactionReason === "signIn"
                ? "Microsoft sign-in needed"
                : "Microsoft needs your attention"}
            </strong>
            <p>
              {portalRecoveryStatus.interactionReason === "signIn"
                ? "Choose an account or finish signing in from the QuickPIM++ access refresh tab. Access checks resume automatically afterward."
                : "Complete the Microsoft prompt in the QuickPIM++ access refresh tab. Access checks resume automatically afterward."}
            </p>
          </div>
        </section>
      ) : (isRunningSetup || portalRecoveryStatus.state === "waiting") && !isRefreshingAccess ? (
        <section className="loading-panel" aria-live="polite">
          <span className="spinner large" aria-hidden="true" />
          <span>Waiting for Microsoft portal access...</span>
        </section>
      ) : null}
      {portalRecoveryError ? <p className="message error" role="alert">{portalRecoveryError}</p> : null}
      <p className="muted">
        QuickPIM++ only uses tokens captured from Microsoft portal pages. Recovery pages open in a collapsed background group and close
        automatically when access is ready. Expand the group only if Microsoft requires sign-in, tenant selection, or another prompt.
      </p>

      <div className="permission-list">
        {accessStatus.map((item) => (
          <AccessStatusRow item={item} key={item.target} />
        ))}
        {!accessStatus.length ? <p className="muted">Enable Entra Roles, PIM Groups, or Azure Roles in Popup & Appearance to add access checks.</p> : null}
      </div>

      <div className="settings-subsection tutorial-section">
        <h3>Quick Tutorial</h3>
        <ol className="tutorial-list">
          <li>Use Open missing portal pages to load the required Microsoft pages in a collapsed background tab group.</li>
          <li>QuickPIM++ closes its temporary pages after access is captured. Expand the group only if Microsoft requires interaction.</li>
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
          <p>{item.recommendedAction || (item.status === "ready" ? "No action needed." : "Use Role Access to reload the matching portal page.")}</p>
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

function emptyPortalRecoveryStatus(): PortalRecoveryStatus {
  return sanitizePortalRecoveryStatus(undefined);
}

async function readPortalRecoveryStatus(): Promise<PortalRecoveryStatus> {
  try {
    return sanitizePortalRecoveryStatus(
      await sendMessage<PortalRecoveryStatus>(
        { action: "getPortalRecoveryStatus" },
        { timeoutMs: 2_500, timeoutMessage: "Microsoft sign-in status check timed out." }
      )
    );
  } catch {
    return emptyPortalRecoveryStatus();
  }
}

async function waitForPortalTokens(
  targets: AccessSetupTarget[],
  baselineTokens: TokenStatus,
  scanPortalTabsForTokens: () => Promise<TokenStatus>
): Promise<{ tokens: TokenStatus; changedTargets: AccessSetupTarget[]; recoveryStatus: PortalRecoveryStatus }> {
  let latestTokens = baselineTokens;
  let changedTargets: AccessSetupTarget[] = [];
  let recoveryStatus = emptyPortalRecoveryStatus();
  const deadline = Date.now() + PORTAL_TOKEN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    [latestTokens, recoveryStatus] = await Promise.all([
      scanPortalTabsForTokens(),
      readPortalRecoveryStatus()
    ]);
    changedTargets = targets.filter((target) => hasTargetPortalTokenChanged(target, baselineTokens, latestTokens));
    if (changedTargets.length === targets.length) {
      break;
    }
    if (recoveryStatus.state === "interactionRequired") {
      break;
    }
    await delay(Math.min(PORTAL_TOKEN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  if (changedTargets.length !== targets.length && recoveryStatus.state !== "interactionRequired") {
    recoveryStatus = await readPortalRecoveryStatus();
  }
  return { tokens: latestTokens, changedTargets, recoveryStatus };
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
  items,
  referenceData,
  trackedRequests,
  onTrackedRequestsChange,
  onSave
}: {
  settings: QuickPimSettings;
  items: ActivationItem[];
  referenceData?: ReferenceDataCache;
  trackedRequests: TrackedPimRequestStore;
  onTrackedRequestsChange: (store: TrackedPimRequestStore) => void;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
}) {
  const [view, setView] = useState<"requests" | "history" | "usage">("requests");
  const [requestSearch, setRequestSearch] = useState("");
  const [requestStatusFilter, setRequestStatusFilter] = useState<"all" | "pending" | "active" | "attention" | "finished">("all");
  const [selectedRequestId, setSelectedRequestId] = useState<string>();
  const [isRefreshingRequests, setIsRefreshingRequests] = useState(false);
  const [extendingRequestId, setExtendingRequestId] = useState<string>();
  const [requestMessage, setRequestMessage] = useState("");
  const [requestError, setRequestError] = useState("");
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<ActivityAction | "all">("all");
  const [resultFilter, setResultFilter] = useState<ActivityResult | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ActivationItem["type"] | "all">("all");
  const [historyLimit, setHistoryLimit] = useState(settings.preferences.activityHistoryLimit);
  const [browserSyncStatus, setBrowserSyncStatus] = useState<BrowserSyncStatus | null>(null);
  const now = Date.now();
  const selectedRequest = trackedRequests.requests.find((request) => request.id === selectedRequestId);
  const filteredRequests = useMemo(() => {
    const term = requestSearch.trim().toLowerCase();
    return trackedRequests.requests.filter((request) => {
      const status = getEffectiveTrackedRequestStatus(request);
      if (!matchesTrackedRequestFilter(status, requestStatusFilter)) return false;
      if (!term) return true;
      const source = resolveActivitySource(request.sourceInstallationId, request.sourceDeviceName, browserSyncStatus);
      return [request.itemName, request.scopeLabel, request.bundleName, request.justification, request.requestId, trackedRequestStatusLabel(status), source?.name, source?.shortId]
        .some((value) => value?.toLowerCase().includes(term));
    });
  }, [browserSyncStatus, requestSearch, requestStatusFilter, trackedRequests.requests]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return settings.activityHistory.filter((entry) => {
      if (actionFilter !== "all" && entry.action !== actionFilter) return false;
      if (resultFilter !== "all" && entry.result !== resultFilter) return false;
      if (typeFilter !== "all" && entry.itemType !== typeFilter) return false;
      if (!term) return true;
      const source = resolveActivitySource(entry.sourceInstallationId, entry.sourceDeviceName, browserSyncStatus);
      return [entry.itemName, entry.scopeLabel, entry.bundleName, entry.justification, entry.error, source?.name, source?.shortId].some((value) =>
        value?.toLowerCase().includes(term)
      );
    });
  }, [actionFilter, browserSyncStatus, resultFilter, search, settings.activityHistory, typeFilter]);
  const usageEntries = useMemo(() => {
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const historyNamesById = new Map<string, string>();
    for (const entry of settings.activityHistory) {
      if (!historyNamesById.has(entry.itemId) && entry.itemName.trim()) {
        historyNamesById.set(entry.itemId, entry.itemName);
      }
    }
    return Object.entries(settings.usageStatsByItemId)
      .map(([id, stats]) => {
        const item = itemsById.get(id);
        const name = item
          ? getDisplayName(item, settings, referenceData)
          : settings.aliasesByItemId[id] || historyNamesById.get(id) || id;
        return { id, name, stats };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [items, referenceData, settings]);

  useEffect(() => {
    setHistoryLimit(settings.preferences.activityHistoryLimit);
  }, [settings.preferences.activityHistoryLimit]);

  useEffect(() => {
    let active = true;
    void sendMessage<BrowserSyncStatus>(
      { action: "getBrowserSyncStatus" },
      { timeoutMs: 4_000, timeoutMessage: "Browser sync device lookup timed out." }
    ).then(async (value) => {
      let next = sanitizeBrowserSyncStatus(value);
      if (active && next) setBrowserSyncStatus(next);
      if (next?.supported && next.enabled) {
        next = sanitizeBrowserSyncStatus(await sendMessage<BrowserSyncStatus>(
          { action: "syncBrowserData" },
          { timeoutMs: 15_000, timeoutMessage: "Browser sync will continue in the background." }
        ));
        if (active && next) setBrowserSyncStatus(next);
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (selectedRequestId && !trackedRequests.requests.some((request) => request.id === selectedRequestId)) {
      setSelectedRequestId(undefined);
    }
  }, [selectedRequestId, trackedRequests.requests]);

  async function refreshRequestStatuses(requestIds?: string[]) {
    setIsRefreshingRequests(true);
    setRequestMessage("");
    setRequestError("");
    try {
      const nextStore = await sendMessage<TrackedPimRequestStore>(
        { action: "refreshTrackedRequests", ...(requestIds?.length ? { requestIds } : {}) },
        { timeoutMs: 30_000, timeoutMessage: "Microsoft request status refresh timed out. Saved request details remain available." }
      );
      onTrackedRequestsChange(sanitizeTrackedRequestStore(nextStore));
      setRequestMessage("Request status checked.");
    } catch (refreshError) {
      setRequestError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setIsRefreshingRequests(false);
    }
  }

  async function clearRequests() {
    await clearTrackedRequests();
    onTrackedRequestsChange({ version: 1, requests: [] });
    setSelectedRequestId(undefined);
    setRequestError("");
    setRequestMessage("Tracked requests cleared.");
  }

  async function saveHistoryLimit() {
    if (!Number.isInteger(historyLimit) || historyLimit < 10 || historyLimit > 200 || historyLimit === settings.preferences.activityHistoryLimit) {
      return;
    }
    await onSave({
      ...settings,
      preferences: { ...settings.preferences, activityHistoryLimit: historyLimit },
      activityHistory: settings.activityHistory.slice(0, historyLimit)
    }, "");
  }

  async function resetUsageCounters() {
    await onSave({ ...settings, usageStatsByItemId: {}, activationHistory: [] }, "Usage counters reset.");
  }

  async function prepareRequestInPopup(request: TrackedPimRequest, requestMode: "activate" | "deactivate") {
    setRequestError("");
    setRequestMessage("");
    await savePopupDraft({
      tab: request.itemType,
      search: "",
      sortMode: settings.preferences.defaultSort,
      sortDirection: settings.preferences.defaultSortDirection,
      selectedIds: [request.itemId],
      durationHours: request.durationHours || settings.preferences.defaultDurationHours,
      justification: request.justification || "",
      ticketSystem: "",
      ticketNumber: "",
      isActivationReviewOpen: true,
      requestMode
    });
    try {
      if (!chrome.action?.openPopup) {
        throw new Error("Popup opening is not supported by this browser version.");
      }
      await chrome.action.openPopup();
    } catch {
      setRequestMessage(`The ${requestMode === "activate" ? "activation" : "deactivation"} is prepared. Open QuickPIM++ from the toolbar to review it.`);
    }
  }

  async function extendRequest(request: TrackedPimRequest) {
    setRequestError("");
    setRequestMessage("");
    setExtendingRequestId(request.id);
    try {
      const result = await sendMessage<TrackedRequestExtensionResult>(
        { action: "extendTrackedRequest", requestId: request.id },
        { timeoutMs: 110_000, timeoutMessage: "The extension request is still being checked. Review Microsoft PIM before retrying." }
      );
      if (result.success) {
        setRequestMessage(result.message);
      } else {
        setRequestError(result.message);
      }
      onTrackedRequestsChange(await loadTrackedRequests());
    } catch (extensionError) {
      setRequestError(extensionError instanceof Error ? extensionError.message : String(extensionError));
    } finally {
      setExtendingRequestId(undefined);
    }
  }

  function openMatchingPortal(request: TrackedPimRequest) {
    void chrome.tabs.create({ url: ENTRA_PORTAL_URLS[request.itemType] });
  }

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Activity & Usage</h2>
          <p className="muted">Follow submitted requests, review local history, and inspect role usage counters.</p>
        </div>
        {view === "requests" ? (
          <button className="btn danger" disabled={!trackedRequests.requests.length} onClick={() => void clearRequests()}>
            Clear requests
          </button>
        ) : view === "history" ? (
          <button className="btn danger" disabled={!settings.activityHistory.length} onClick={() => void onSave({ ...settings, activityHistory: [] }, "Activity history cleared.")}>
            Clear history
          </button>
        ) : (
          <button className="btn danger" disabled={!usageEntries.length} onClick={() => void resetUsageCounters()}>
            Reset counters
          </button>
        )}
      </div>
      <div className="segmented-control activity-view-switch" role="tablist" aria-label="Activity view">
        <button className={view === "requests" ? "active" : ""} role="tab" aria-selected={view === "requests"} onClick={() => setView("requests")}>
          Requests
          {getPendingTrackedRequestCount(trackedRequests) ? <span className="request-count">{getPendingTrackedRequestCount(trackedRequests)}</span> : null}
        </button>
        <button className={view === "history" ? "active" : ""} role="tab" aria-selected={view === "history"} onClick={() => setView("history")}>
          History
        </button>
        <button className={view === "usage" ? "active" : ""} role="tab" aria-selected={view === "usage"} onClick={() => setView("usage")}>
          Usage
        </button>
      </div>
      {view !== "requests" && browserSyncStatus?.supported && browserSyncStatus.enabled && browserSyncStatus.crossDeviceState === "waiting" ? (
        <p className="message settings-inline-message">
          Cross-device delivery is not verified yet, so activity from another computer may be missing. Open Browser Sync for the verification steps.
        </p>
      ) : null}
      {view === "requests" ? (
        <>
          <div className="toolbar settings-section-gap request-toolbar">
            <input className="input" value={requestSearch} onChange={(event) => setRequestSearch(event.target.value)} placeholder="Search requests" aria-label="Search requests" />
            <select className="select" value={requestStatusFilter} onChange={(event) => setRequestStatusFilter(event.target.value as typeof requestStatusFilter)} aria-label="Filter request status">
              <option value="all">All statuses</option>
              <option value="pending">In progress</option>
              <option value="active">Active</option>
              <option value="attention">Needs attention</option>
              <option value="finished">Finished</option>
            </select>
            <button className="btn" disabled={isRefreshingRequests || !trackedRequests.requests.length} onClick={() => void refreshRequestStatuses()}>
              {isRefreshingRequests ? <span className="loading-inline"><span className="spinner" aria-hidden="true" /> Checking...</span> : "Check status"}
            </button>
          </div>
          {requestError ? <p className="message error settings-inline-message" role="alert">{requestError}</p> : null}
          {requestMessage ? <p className="message success settings-inline-message" role="status">{requestMessage}</p> : null}
          <div className={`request-center ${selectedRequest ? "has-details" : ""}`}>
            <div className="request-list" aria-label="Tracked PIM requests">
              {filteredRequests.map((request) => {
                const status = getEffectiveTrackedRequestStatus(request, now);
                return (
                  <button
                    className={`request-row ${selectedRequestId === request.id ? "selected" : ""}`}
                    key={request.id}
                    onClick={() => setSelectedRequestId(request.id)}
                    aria-expanded={selectedRequestId === request.id}
                  >
                    <span className="request-row-main">
                      <strong>{request.itemName}</strong>
                      <span className="muted">{request.continuationOfRequestId ? "Extend" : request.action === "activate" ? "Enable" : "Disable"} / {popupTabLabel(request.itemType)}{request.scopeLabel ? ` / ${request.scopeLabel}` : ""}</span>
                      <ActivitySourceLabel
                        installationId={request.sourceInstallationId}
                        savedName={request.sourceDeviceName}
                        status={browserSyncStatus}
                      />
                    </span>
                    <span className="request-row-side">
                      <span className={`request-status ${status}`}>{trackedRequestStatusLabel(status)}</span>
                      <ActivityTimestamp value={request.requestedAt} className="muted" />
                    </span>
                  </button>
                );
              })}
              {!filteredRequests.length ? <p className="muted request-empty">No tracked requests match the current filters.</p> : null}
            </div>
            {selectedRequest ? (
              <TrackedRequestDetails
                request={selectedRequest}
                isRefreshing={isRefreshingRequests}
                isExtending={extendingRequestId === selectedRequest.id}
                preferredExtensionDurationHours={settings.preferences.defaultExtensionDurationHours}
                browserSyncStatus={browserSyncStatus}
                onRefresh={() => void refreshRequestStatuses([selectedRequest.id])}
                onOpenPortal={() => openMatchingPortal(selectedRequest)}
                onPrepare={(mode) => void prepareRequestInPopup(selectedRequest, mode)}
                onExtend={() => void extendRequest(selectedRequest)}
                onClose={() => setSelectedRequestId(undefined)}
              />
            ) : null}
          </div>
        </>
      ) : view === "history" ? (
        <>
          <div className="settings-subsection settings-section-gap activity-retention-section">
            <h3>History retention</h3>
            <div className="form-grid compact-preference-fields">
              <div className="field">
                <label>Activity history limit</label>
                <input
                  className="input"
                  type="number"
                  min="10"
                  max="200"
                  value={historyLimit}
                  aria-invalid={!Number.isInteger(historyLimit) || historyLimit < 10 || historyLimit > 200}
                  onChange={(event) => setHistoryLimit(Number(event.target.value))}
                  onBlur={() => void saveHistoryLimit()}
                />
                <p className="muted">Maximum local activation and deactivation entries to keep.</p>
              </div>
            </div>
          </div>
          <div className="toolbar settings-section-gap activity-toolbar">
            <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search history" aria-label="Search activity" />
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
                  {entry.justification ? (
                    <div className="activity-justification-row">
                      <p>{entry.justification}</p>
                      <CopyTextButton text={entry.justification} label="justification" />
                    </div>
                  ) : null}
                  {entry.error ? <p className="message error settings-inline-message">{entry.error}</p> : null}
                  <ActivitySourceLabel
                    installationId={entry.sourceInstallationId}
                    savedName={entry.sourceDeviceName}
                    status={browserSyncStatus}
                  />
                </div>
                <div className="activity-time">
                  <ActivityTimestamp value={entry.completedAt || entry.requestedAt} />
                  {entry.durationHours ? <span>{entry.durationHours}h</span> : null}
                  {entry.bundleName ? <span>{entry.bundleName}</span> : null}
                </div>
              </article>
            ))}
            {!filtered.length ? <p className="muted">No activity matches the current filters.</p> : null}
          </div>
        </>
      ) : (
        <div className="settings-subsection settings-section-gap usage-list">
          <div>
            <h3>Usage counters</h3>
            <p className="muted">Local counts used for sorting and optional popup details.</p>
          </div>
          {usageEntries.map(({ id, name, stats }) => (
            <div className="settings-row usage-row" key={id}>
              <span>
                <strong>{name}</strong>
                <span className="muted usage-item-id">{name === id ? "Saved role identifier" : id}</span>
              </span>
              <span className="usage-summary">
                <strong>{stats.activationCount}</strong>
                <span className="muted">activation{stats.activationCount === 1 ? "" : "s"}</span>
                {formatDateOnly(stats.lastUsedAt) ? <span className="muted">Last used {formatDateOnly(stats.lastUsedAt)}</span> : null}
              </span>
              {stats.byInstallationId && Object.keys(stats.byInstallationId).length ? (
                <div className="usage-device-breakdown">
                  {Object.entries(stats.byInstallationId)
                    .sort(([left], [right]) => resolveActivitySource(left, undefined, browserSyncStatus)!.name.localeCompare(resolveActivitySource(right, undefined, browserSyncStatus)!.name))
                    .map(([installationId, sourceStats]) => {
                      const source = resolveActivitySource(installationId, undefined, browserSyncStatus)!;
                      return (
                        <span key={installationId} title={installationId}>
                          <strong>{source.name}</strong> ({source.shortId}): {sourceStats.activationCount}
                        </span>
                      );
                    })}
                  {stats.legacyActivationCount ? <span>Earlier activity (source unavailable): {stats.legacyActivationCount}</span> : null}
                </div>
              ) : null}
            </div>
          ))}
          {!usageEntries.length ? <p className="muted">No local usage counters recorded.</p> : null}
        </div>
      )}
    </section>
  );
}

function TrackedRequestDetails({
  request,
  isRefreshing,
  isExtending,
  preferredExtensionDurationHours,
  browserSyncStatus,
  onRefresh,
  onOpenPortal,
  onPrepare,
  onExtend,
  onClose
}: {
  request: TrackedPimRequest;
  isRefreshing: boolean;
  isExtending: boolean;
  preferredExtensionDurationHours: number;
  browserSyncStatus: BrowserSyncStatus | null;
  onRefresh: () => void;
  onOpenPortal: () => void;
  onPrepare: (mode: "activate" | "deactivate") => void;
  onExtend: () => void;
  onClose: () => void;
}) {
  const status = getEffectiveTrackedRequestStatus(request);
  const canRetry = ["denied", "failed", "canceled", "statusUnavailable"].includes(status);
  const canPrepareDisable = request.action === "activate" && status === "active";
  let extensionDurationHours: number | undefined;
  if (canPrepareDisable) {
    try {
      extensionDurationHours = buildTrackedRequestExtensionPlan(request, preferredExtensionDurationHours).durationHours;
    } catch {
      // Legacy and incomplete tracked requests remain viewable without offering an unreliable action.
    }
  }
  return (
    <aside className="request-details" aria-label={`${request.itemName} request details`}>
      <div className="panel-title-row compact">
        <div>
          <span className={`request-status ${status}`}>{trackedRequestStatusLabel(status)}</span>
          <h3>{request.itemName}</h3>
          <p className="muted">{request.continuationOfRequestId ? "Extension request" : request.action === "activate" ? "Enable request" : "Disable request"} / {popupTabLabel(request.itemType)}</p>
        </div>
        <button className="icon-btn request-details-close" onClick={onClose} title="Close request details" aria-label="Close request details">×</button>
      </div>
      <dl className="request-detail-grid">
        <div><dt>Requested</dt><dd><ActivityTimestamp value={request.requestedAt} /></dd></div>
        <div><dt>Last checked</dt><dd><ActivityTimestamp value={request.lastCheckedAt || request.updatedAt} /></dd></div>
        {request.scopeLabel ? <div><dt>Scope</dt><dd>{request.scopeLabel}</dd></div> : null}
        {request.durationHours ? <div><dt>Duration</dt><dd>{formatExtensionDuration(request.durationHours)}</dd></div> : null}
        {request.activeFrom ? <div><dt>Starts</dt><dd><ActivityTimestamp value={request.activeFrom} /></dd></div> : null}
        {request.activeUntil ? <div><dt>Active until</dt><dd><ActivityTimestamp value={request.activeUntil} /></dd></div> : null}
        {request.continuationOfRequestId ? <div className="request-detail-wide"><dt>Continuation of</dt><dd className="monospace wrap-anywhere">{request.continuationOfRequestId}</dd></div> : null}
        {request.extensionAttemptState ? <div><dt>Extension</dt><dd>{request.extensionAttemptState === "queued" ? "Queued" : request.extensionAttemptState === "uncertain" ? "Outcome unknown" : "Submitting"}</dd></div> : null}
        {request.bundleName ? <div><dt>Bundle</dt><dd>{request.bundleName}</dd></div> : null}
        {request.sourceInstallationId ? (
          <div className="request-detail-wide">
            <dt>Source computer</dt>
            <dd><ActivitySourceLabel installationId={request.sourceInstallationId} savedName={request.sourceDeviceName} status={browserSyncStatus} includePrefix={false} /></dd>
          </div>
        ) : null}
        {request.rawStatus ? <div><dt>Microsoft status</dt><dd>{request.rawStatus}</dd></div> : null}
        <div className="request-detail-wide"><dt>Request ID</dt><dd className="monospace wrap-anywhere">{request.requestId}</dd></div>
        {request.approvalId ? <div className="request-detail-wide"><dt>Approval ID</dt><dd className="monospace wrap-anywhere">{request.approvalId}</dd></div> : null}
        {request.justification ? (
          <div className="request-detail-wide">
            <dt>Justification</dt>
            <dd className="request-justification-value">
              <span>{request.justification}</span>
              <CopyTextButton text={request.justification} label="justification" />
            </dd>
          </div>
        ) : null}
      </dl>
      {request.lastError ? <p className="message error settings-inline-message">{request.lastError}</p> : null}
      <div className="button-row request-detail-actions">
        <button className="btn" onClick={onRefresh} disabled={isRefreshing}>Check status</button>
        <button className="btn" onClick={onOpenPortal}>Open Microsoft PIM</button>
        {extensionDurationHours ? <button className="btn primary" onClick={onExtend} disabled={isExtending}>{isExtending ? "Queuing..." : `Extend ${formatExtensionDuration(extensionDurationHours)}`}</button> : null}
        {canRetry ? (
          <button className="btn primary" onClick={() => onPrepare(request.action)}>
            Retry {request.action === "activate" ? "activation" : "deactivation"}
          </button>
        ) : null}
        {canPrepareDisable ? <button className="btn danger" onClick={() => onPrepare("deactivate")}>Prepare disable</button> : null}
      </div>
    </aside>
  );
}

function ActivityTimestamp({ value, className }: { value: string | undefined; className?: string }) {
  const formatted = formatLocalDateTime(value);
  if (!value) return null;
  if (!formatted) return <span className={className}>{value}</span>;
  return <time className={className} dateTime={value} title={formatUtcDateTime(value)}>{formatted}</time>;
}

function ActivitySourceLabel({
  installationId,
  savedName,
  status,
  includePrefix = true
}: {
  installationId?: string;
  savedName?: string;
  status: BrowserSyncStatus | null;
  includePrefix?: boolean;
}) {
  const source = resolveActivitySource(installationId, savedName, status);
  if (!source) return null;
  return (
    <span className="activity-source" title={installationId}>
      {includePrefix ? "From " : ""}{source.name} <span className="activity-source-id">{source.shortId}</span>
    </span>
  );
}

function resolveActivitySource(
  installationId: string | undefined,
  savedName: string | undefined,
  status: BrowserSyncStatus | null
): { name: string; shortId: string } | undefined {
  if (!installationId) return undefined;
  const device = status?.devices.find((entry) => entry.installationId === installationId);
  const isCurrent = status?.installationId === installationId;
  return {
    name: device?.name || (isCurrent ? status?.deviceName : undefined) || savedName || "QuickPIM++ installation",
    shortId: formatBrowserSyncInstallationId(installationId)
  };
}

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
  }, []);

  async function copyText() {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("error");
    }
    resetTimer.current = window.setTimeout(() => setState("idle"), 2_000);
  }

  const actionLabel = state === "copied" ? `${label} copied` : state === "error" ? `Retry copying ${label}` : `Copy ${label}`;
  return (
    <button
      type="button"
      className={`inline-copy-button ${state}`}
      onClick={() => void copyText()}
      title={actionLabel}
      aria-label={actionLabel}
    >
      {state === "copied" ? <SmallCheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="inline-copy-icon">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function SmallCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="inline-copy-icon">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function matchesTrackedRequestFilter(
  status: TrackedPimRequestStatus,
  filter: "all" | "pending" | "active" | "attention" | "finished"
): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return status === "submitted" || status === "pendingApproval" || status === "provisioning" || status === "scheduled";
  if (filter === "active") return status === "active";
  if (filter === "attention") return status === "denied" || status === "failed" || status === "canceled" || status === "statusUnavailable";
  return status === "completed" || status === "expired";
}

function BrowserSyncPanel({ settings }: { settings: QuickPimSettings }) {
  const [status, setStatus] = useState<BrowserSyncStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const lastSavedDeviceName = useRef("");
  const isMounted = useRef(true);

  async function loadStatus(synchronize = false): Promise<BrowserSyncStatus | null> {
    try {
      const next = sanitizeBrowserSyncStatus(await sendMessage<BrowserSyncStatus>(
        { action: synchronize ? "syncBrowserData" : "getBrowserSyncStatus" },
        {
          timeoutMs: synchronize ? 15_000 : 4_000,
          timeoutMessage: synchronize
            ? "Browser sync will continue in the background."
            : "Browser sync status check timed out."
        }
      ));
      if (next && isMounted.current) {
        setError("");
        setStatus(next);
        const previousSavedName = lastSavedDeviceName.current;
        setDeviceName((current) => !current || current === previousSavedName ? next.deviceName : current);
        lastSavedDeviceName.current = next.deviceName;
      }
      return next;
    } catch (statusError) {
      if (isMounted.current) setError(statusError instanceof Error ? statusError.message : String(statusError));
      return null;
    }
  }

  useEffect(() => {
    let active = true;
    void loadStatus().then((next) => {
      if (active && next?.supported && next.enabled) void loadStatus(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => {
    isMounted.current = false;
  }, []);

  useEffect(() => {
    const storageChangeEvent = chrome.storage?.onChanged;
    if (!storageChangeEvent) return;
    let timer: number | undefined;
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "sync" && !(areaName === "local" && changes[BROWSER_SYNC_LOCAL_STATE_KEY])) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadStatus(), 150);
    };
    storageChangeEvent.addListener(handleStorageChange);
    return () => {
      if (timer) window.clearTimeout(timer);
      storageChangeEvent.removeListener(handleStorageChange);
    };
  }, []);

  useEffect(() => {
    const trimmed = deviceName.trim();
    if (!status?.supported || !trimmed || trimmed === lastSavedDeviceName.current) return;
    const timer = window.setTimeout(() => {
      void runAction(
        { action: "updateBrowserSyncDeviceName", name: trimmed },
        "Installation name saved."
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [deviceName, status?.supported]);

  async function runAction(
    request: Record<string, unknown>,
    successMessage: string | ((next: BrowserSyncStatus | null) => string)
  ): Promise<boolean> {
    setIsBusy(true);
    setMessage("");
    setError("");
    try {
      const next = sanitizeBrowserSyncStatus(await sendMessage<BrowserSyncStatus>(
        request,
        { timeoutMs: 15_000, timeoutMessage: "Browser sync did not finish in time. It will retry in the background." }
      ));
      if (next) {
        setStatus(next);
        setDeviceName((current) => request.action === "updateBrowserSyncDeviceName"
          && current.trim() !== request.name
          ? current
          : next.deviceName);
        lastSavedDeviceName.current = next.deviceName;
      }
      const attemptedDataSync = request.action === "syncBrowserData"
        || (request.action === "setBrowserSyncEnabled" && request.enabled === true);
      if (attemptedDataSync && next?.lastError) {
        setMessage("");
        setError(next.lastError);
        return false;
      }
      setMessage(typeof successMessage === "function" ? successMessage(next) : successMessage);
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function purgeSyncedData() {
    await runAction({ action: "purgeBrowserSyncData" }, "Synced settings and history were deleted. Sync is now off on this installation.");
    setConfirmingPurge(false);
  }

  const otherDevices = status?.devices.filter((device) => device.installationId !== status.installationId) || [];
  const otherInstallationIds = new Set(otherDevices.map((device) => device.installationId));
  const receivedActivityCount = status
    ? settings.activityHistory.filter((entry) => entry.sourceInstallationId && otherInstallationIds.has(entry.sourceInstallationId)).length
    : 0;
  const verificationTitle = status?.crossDeviceState === "verified"
    ? `Verified with ${status.otherInstallationCount} other installation${status.otherInstallationCount === 1 ? "" : "s"}`
    : status?.crossDeviceState === "waiting"
      ? "Waiting for another installation"
      : "Cross-device sync is off";
  const verificationDetail = status?.crossDeviceState === "verified"
    ? `QuickPIM++ has received an installation record through ${status.ecosystemLabel || "browser sync"}.`
    : status?.crossDeviceState === "waiting"
      ? otherDevices.length
        ? "Other installation records exist, but none has synchronized recently with sync enabled."
        : "Data is stored in this browser's sync area, but no other QuickPIM++ installation has been observed yet."
      : "Enable sync to store portable QuickPIM++ data in this browser's sync area.";
  const storeUrl = status?.browserLabel === "Microsoft Edge" ? EDGE_ADDONS_URL : CHROME_WEB_STORE_URL;
  const storeLabel = status?.browserLabel === "Microsoft Edge" ? "Microsoft Edge Add-ons" : "Chrome Web Store";
  const showBothStoreOptions = status?.browserLabel !== "Microsoft Edge" && status?.browserLabel !== "Google Chrome";

  return (
    <section className="panel browser-sync-panel">
      <div className="preferences-title-row">
        <div>
          <h2>Browser Sync</h2>
          <p className="muted">Keep useful QuickPIM++ settings and local activity available on your other signed-in browser installations.</p>
        </div>
        {status ? <span className={`sync-capability-badge ${status.supported ? status.crossDeviceState === "verified" ? "ready" : status.enabled ? "waiting" : "off" : "limited"}`}>
          {status.supported ? status.crossDeviceState === "verified" ? "Cross-device verified" : status.enabled ? "Not yet verified" : "Sync off" : "Limited"}
        </span> : null}
      </div>

      {!status ? <div className="settings-subsection"><p className="muted">Checking browser sync...</p></div> : null}
      {status && !status.supported ? (
        <div className="settings-subsection sync-limitation-card">
          <h3>Native sync is unavailable for this installation</h3>
          <p>{status.reason}</p>
          <p className="muted">Detected: {status.browserLabel} / {status.sourceLabel}.</p>
          {showBothStoreOptions ? <p className="muted">For native sync, use the matching official QuickPIM++ edition in Google Chrome or Microsoft Edge. Otherwise, use Backup &amp; Restore.</p> : null}
          <div className="button-row">
            {showBothStoreOptions ? (
              <>
                <a className="btn primary" href={CHROME_WEB_STORE_URL} target="_blank" rel="noreferrer">Chrome edition</a>
                <a className="btn primary" href={EDGE_ADDONS_URL} target="_blank" rel="noreferrer">Edge edition</a>
              </>
            ) : <a className="btn primary" href={storeUrl} target="_blank" rel="noreferrer">Open {storeLabel}</a>}
            <button className="btn" disabled={isBusy} onClick={() => void runAction({ action: "dismissBrowserSyncReminder", mode: "daily" }, "The popup reminder will return tomorrow.")}>Remind me tomorrow</button>
            <button className="btn subtle" disabled={isBusy || status.reminderMode === "never"} onClick={() => void runAction({ action: "dismissBrowserSyncReminder", mode: "never" }, "The popup reminder is off for this installation.")}>Do not remind me</button>
          </div>
        </div>
      ) : null}

      {status?.supported ? (
        <>
          <div className="settings-subsection sync-overview-section">
            <div className="sync-control-header">
              <label className="preference-toggle sync-master-toggle">
                <input
                  type="checkbox"
                  checked={status.enabled}
                  disabled={isBusy}
                  onChange={(event) => void runAction(
                    { action: "setBrowserSyncEnabled", enabled: event.target.checked },
                    event.target.checked ? "Browser sync enabled." : "Browser sync disabled on this installation."
                  )}
                />
                <span className="preference-toggle-copy">
                  <strong>Sync settings and activity</strong>
                  <span className="muted">Enabled by default. Chrome and Edge use separate sync services.</span>
                </span>
              </label>
              <button
                className="btn primary"
                disabled={isBusy || !status.enabled}
                onClick={() => void runAction(
                  { action: "syncBrowserData" },
                  (next) => next?.crossDeviceState === "verified"
                    ? `Send and receive completed. ${next.otherInstallationCount} other installation${next.otherInstallationCount === 1 ? "" : "s"} detected.`
                    : "Saved in this browser's sync area. Open QuickPIM++ on the other computer to verify cross-device delivery."
                )}
              >
                {isBusy ? "Syncing..." : "Send & receive now"}
              </button>
            </div>
            <div className={`sync-verification-summary ${status.crossDeviceState}`}>
              <div>
                <strong>{verificationTitle}</strong>
                <span>{verificationDetail}</span>
              </div>
              <span className={`sync-verification-chip ${status.crossDeviceState}`}>
                {status.crossDeviceState === "verified" ? "Verified" : status.crossDeviceState === "waiting" ? "Unverified" : "Off"}
              </span>
            </div>
            <dl className="sync-facts">
              <div><dt>Last run here</dt><dd>{formatSyncTimestamp(status.lastSuccessAt)}</dd></div>
              <div><dt>Service</dt><dd>{status.ecosystemLabel || "Browser sync"}</dd></div>
              <div><dt>Activity received</dt><dd>{receivedActivityCount} event{receivedActivityCount === 1 ? "" : "s"} from other installations</dd></div>
              <div><dt>Last other run</dt><dd>{formatSyncTimestamp(status.lastOtherInstallationSyncAt)}</dd></div>
              <div><dt>Store edition</dt><dd>{status.sourceLabel}</dd></div>
            </dl>
            {status.crossDeviceState === "waiting" ? (
              <details className="sync-help-details">
                <summary>Why is my other computer not appearing?</summary>
                <div>
                  <p>A successful write here cannot confirm that the browser account transported it to another computer.</p>
                  <ol>
                    <li>Use the official {status.sourceLabel} edition on both computers.</li>
                    <li>In the same {status.browserLabel} work profile, confirm browser sync is enabled and allowed by your organization.</li>
                    <li>Open QuickPIM++ on the other computer and use Browser Sync &gt; Send &amp; receive now. Verification remains current for seven days after that installation&apos;s last run.</li>
                  </ol>
                  {status.browserLabel === "Microsoft Edge" ? (
                    <a href="https://learn.microsoft.com/en-us/deployedge/microsoft-edge-enterprise-sync" target="_blank" rel="noreferrer">Microsoft Edge enterprise sync requirements</a>
                  ) : null}
                </div>
              </details>
            ) : null}
            {status.crossDeviceState === "verified" && receivedActivityCount === 0 ? (
              <p className="message settings-inline-message">Another installation is visible, but no activity from it is stored here yet. Use Send &amp; receive now on that computer after its QuickPIM++ activity is recorded.</p>
            ) : null}
            {status.lastError ? <p className="message error settings-inline-message">{status.lastError}</p> : null}
            {status.omittedCategories.length ? (
              <p className="message settings-inline-message">
                Browser quota limits the synchronized copy of {formatLimitedSyncCategories(status.omittedCategories)}. Complete local data is preserved; use Backup &amp; Restore when the full dataset is required on another installation.
              </p>
            ) : null}
          </div>

          <div className="settings-subsection">
            <h3>Installations</h3>
            <p className="muted">Use a recognizable name because browser extension APIs do not expose the computer hostname.</p>
            <div className="form-grid sync-device-name-row">
              <div className="field">
                <label htmlFor="sync-device-name">Installation name</label>
                <input id="sync-device-name" className="input" value={deviceName} maxLength={60} disabled={isBusy} onChange={(event) => setDeviceName(event.target.value)} />
              </div>
              <div className="sync-current-device-summary">
                <strong>{status.browserLabel} / {status.platform}</strong>
                <span>QuickPIM++ {APP_VERSION}</span>
                <span className="sync-installation-id" title={status.installationId}>
                  ID {formatBrowserSyncInstallationId(status.installationId)}
                  <CopyTextButton text={status.installationId} label="installation ID" />
                </span>
              </div>
            </div>
            <p className="muted sync-id-help">The generated ID stays with this extension installation until its data is reset or the extension is reinstalled.</p>
            <div className="sync-other-installations">
              <h4>Other installations</h4>
              <p className="muted">These installations have written to the same browser sync account. Times use this computer&apos;s local time.</p>
              <div className="sync-device-list">
                {otherDevices.map((device) => (
                  <BrowserSyncDeviceEditor
                    key={device.installationId}
                    device={device}
                    disabled={isBusy || !status.enabled}
                    onRename={(name) => runAction(
                      { action: "renameBrowserSyncDevice", installationId: device.installationId, name },
                      `${formatBrowserSyncInstallationId(device.installationId)} renamed.`
                    )}
                  />
                ))}
                {!otherDevices.length ? <p className="muted">No other installation record has reached this browser yet.</p> : null}
              </div>
            </div>
          </div>

          <div className="settings-subsection sync-data-scope">
            <h3>What syncs</h3>
            <div className="sync-scope-grid">
              <div><strong>Included</strong><p>Popup and activation preferences, enabled tabs, aliases, favorites, saved and recent justifications, bundles, usage counters, and recent activity history.</p></div>
              <div><strong>Always local</strong><p>Microsoft tokens, API caches, learned names, popup drafts, in-progress requests, and notification permission.</p></div>
            </div>
            <p className="muted">Chrome Sync and Microsoft Edge Sync are separate services. Use Backup &amp; Restore when moving data between Chrome and Edge.</p>
            <p className="muted">Activity events and counters from installations used at the same time are merged without double-counting. Microsoft remains authoritative if two installations submit the same role request simultaneously.</p>
          </div>

          <div className="settings-danger-zone sync-purge-zone">
            <div><h3>Delete browser-synced data</h3><p className="muted">Keeps this installation&apos;s local data, deletes the cloud copy, and pauses sync. Other installations pause when they receive the deletion marker.</p></div>
            <button className="btn danger" disabled={isBusy} onClick={() => setConfirmingPurge(true)}>Delete synced data</button>
          </div>
          {confirmingPurge ? (
            <div className="settings-confirmation danger" role="alertdialog" aria-label="Delete browser-synced QuickPIM++ data">
              <span>Delete synced settings, history, and the installation list? Local data on this computer will remain.</span>
              <div className="button-row nowrap">
                <button className="btn danger" disabled={isBusy} onClick={() => void purgeSyncedData()}>Delete synced data</button>
                <button className="btn" disabled={isBusy} onClick={() => setConfirmingPurge(false)}>Cancel</button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {message ? <p className="message success settings-inline-message" role="status">{message}</p> : null}
      {error ? <p className="message error settings-inline-message" role="alert">{error}</p> : null}
    </section>
  );
}

function formatLimitedSyncCategories(categories: string[]): string {
  const labels: Record<string, string> = {
    activityHistory: "activity history",
    usageStatsByItemId: "usage counters",
    recentJustifications: "recent justifications"
  };
  return categories.map((category) => labels[category] || category).join(", ");
}

function BrowserSyncDeviceEditor({
  device,
  disabled,
  onRename
}: {
  device: BrowserSyncDevice;
  disabled: boolean;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(device.name);
  const trimmed = name.trim();
  const unchanged = trimmed === device.name;
  const lastSyncIso = toIsoTimestamp(device.lastSyncAt);
  const syncAge = Date.now() - device.lastSyncAt;
  const isRecentlyActive = device.syncEnabled
    && syncAge >= -5 * 60_000
    && syncAge <= BROWSER_SYNC_VERIFICATION_FRESHNESS_MS;

  useEffect(() => setName(device.name), [device.name]);

  return (
    <div className="sync-device-row">
      <div className="sync-device-editor-main">
        <label htmlFor={`sync-device-${device.installationId}`}>Installation name</label>
        <div className="sync-device-editor-control">
          <input
            id={`sync-device-${device.installationId}`}
            className="input"
            value={name}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="btn compact"
            disabled={disabled || !trimmed || unchanged}
            onClick={() => void onRename(trimmed)}
          >
            Rename
          </button>
        </div>
        <span>{device.browser} / {device.platform} / QuickPIM++ {device.appVersion}</span>
      </div>
      <div className="sync-device-meta">
        <span className="sync-installation-id" title={device.installationId}>
          {formatBrowserSyncInstallationId(device.installationId)}
          <CopyTextButton text={device.installationId} label="installation ID" />
        </span>
        <span>{!device.syncEnabled ? "Sync off" : isRecentlyActive ? "Sync current" : "Not seen recently"}</span>
        {lastSyncIso
          ? <time dateTime={lastSyncIso}>{formatSyncTimestamp(device.lastSyncAt)}</time>
          : <span>Not yet</span>}
      </div>
    </div>
  );
}

function formatSyncTimestamp(value: number | undefined): string {
  const iso = toIsoTimestamp(value);
  return iso ? formatLocalDateTime(iso) || "Not yet" : "Not yet";
}

function toIsoTimestamp(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function DiagnosticsPanel({
  tokenStatus,
  dataCache,
  settings,
  trackedRequests
}: {
  tokenStatus: TokenStatus | null;
  dataCache: QuickPimDataCache;
  settings: QuickPimSettings;
  trackedRequests: TrackedPimRequestStore;
}) {
  const [reportStatus, setReportStatus] = useState("");
  const [distributionInfo, setDistributionInfo] = useState<ExtensionDistributionInfo | null>(null);
  const [browserSyncStatus, setBrowserSyncStatus] = useState<BrowserSyncStatus | null>(null);
  const identity = getIdentityContext(tokenStatus);
  useEffect(() => {
    void getExtensionDistributionInfo().then(setDistributionInfo).catch(() => setDistributionInfo(null));
    void sendMessage<BrowserSyncStatus>(
      { action: "getBrowserSyncStatus" },
      { timeoutMs: 4_000, timeoutMessage: "Browser sync status check timed out." }
    ).then((value) => setBrowserSyncStatus(sanitizeBrowserSyncStatus(value))).catch(() => setBrowserSyncStatus(null));
  }, []);
  const diagnostics = useMemo(() => {
    const allDiagnostics = [
      dataCache.eligible,
      dataCache.active,
      ...Object.values(dataCache.eligibleByTarget || {}),
      ...Object.values(dataCache.activeByTarget || {})
    ]
      .flatMap((entry) => entry?.diagnostics || [])
      .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt));
    const uniqueDiagnostics = new Map<string, (typeof allDiagnostics)[number]>();
    for (const diagnostic of allDiagnostics) {
      const key = JSON.stringify([
        diagnostic.target,
        diagnostic.operation || "",
        diagnostic.endpointLabel || "",
        diagnostic.success,
        diagnostic.failureKind || "",
        diagnostic.error || ""
      ]);
      if (!uniqueDiagnostics.has(key)) uniqueDiagnostics.set(key, diagnostic);
    }
    return [...uniqueDiagnostics.values()];
  }, [dataCache]);

  function createReport(): string {
    return stringifySupportReport({
      appVersion: APP_VERSION,
      buildTimestamp: APP_BUILD_TIMESTAMP,
      settings,
      tokenStatus,
      dataCache,
      trackedRequests,
      distribution: distributionInfo,
      browserSync: browserSyncStatus,
      userAgent: navigator.userAgent
    });
  }

  async function copyReport() {
    const report = createReport();
    try {
      await navigator.clipboard.writeText(report);
      setReportStatus("Support report copied.");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = report;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      setReportStatus(copied ? "Support report copied." : "Copy was blocked. Download the report instead.");
    }
  }

  function downloadReport() {
    const blob = new Blob([createReport()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quickpim-support-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setReportStatus("Support report downloaded.");
  }

  return (
    <section className="panel">
      <h2>Diagnostics</h2>
      <p className="muted">Safe local status information for troubleshooting. Tokens and raw authorization headers are not displayed.</p>
      <div className="diagnostics-report-card settings-section-gap">
        <div>
          <h3>Sanitized support report</h3>
          <p className="muted">Exports aggregate cache, capability, and request status only. Role names, object IDs, tickets, reasons, and tokens are excluded.</p>
        </div>
        <div className="button-row">
          <button className="btn primary" onClick={() => void copyReport()}>Copy report</button>
          <button className="btn" onClick={downloadReport}>Download JSON</button>
        </div>
        {reportStatus ? <p className="message success settings-inline-message" role="status">{reportStatus}</p> : null}
      </div>
      <div className="permission-detail-grid settings-section-gap">
        <div>
          <strong>Installation</strong>
          <p>
            {distributionInfo
              ? `${browserFamilyLabel(distributionInfo.browser)} / ${distributionLabel(distributionInfo.distribution)}`
              : "Checking browser and Store source..."}
          </p>
          {distributionInfo?.blockedInEdge ? (
            <p className="diagnostic-warning">Unsupported combination: install the Microsoft Edge Add-ons edition.</p>
          ) : null}
        </div>
        <div>
          <strong>Current account</strong>
          <p title={identity.detail}>{identity.label || "No signed-in token context"}</p>
          {identity.mismatch ? <p className="diagnostic-warning">Tokens belong to different accounts or tenants.</p> : null}
        </div>
        <div>
          <strong>Graph token</strong>
          <p>{tokenStatus?.graph.hasToken ? "Captured in this browser session" : "Missing"}</p>
        </div>
        <div>
          <strong>Azure token</strong>
          <p>{tokenStatus?.azureManagement.hasToken ? "Captured in this browser session" : "Missing"}</p>
        </div>
        <div>
          <strong>Browser Sync</strong>
          <p>{browserSyncStatus
            ? browserSyncStatus.supported
              ? browserSyncStatus.enabled ? `Enabled via ${browserSyncStatus.ecosystemLabel || "browser sync"}` : "Available but disabled on this installation"
              : `Limited: ${browserSyncStatus.sourceLabel}`
            : "Checking sync capability..."}</p>
          {browserSyncStatus?.installationId ? (
            <p title={browserSyncStatus.installationId}>
              Source ID: {formatBrowserSyncInstallationId(browserSyncStatus.installationId)}
            </p>
          ) : null}
          {browserSyncStatus?.lastError ? <p className="diagnostic-warning">Last sync did not complete successfully.</p> : null}
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

function AliasesPanel({
  settings,
  items,
  referenceData,
  onSave,
  onClearReferenceData
}: {
  settings: QuickPimSettings;
  items: ActivationItem[];
  referenceData?: ReferenceDataCache;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
  onClearReferenceData: () => Promise<void>;
}) {
  const [itemId, setItemId] = useState("");
  const [alias, setAlias] = useState("");
  const selectedItem = items.find((item) => item.id === itemId);
  const aliasPickerGroups = useMemo(() => {
    const compareRawItems = (left: ActivationItem, right: ActivationItem) =>
      left.sourceName.localeCompare(right.sourceName, undefined, { sensitivity: "base" })
      || getScopeLabel(left, referenceData).localeCompare(getScopeLabel(right, referenceData), undefined, { sensitivity: "base" });
    return {
      roles: items.filter((item) => item.type !== "pimGroup").sort(compareRawItems),
      groups: items.filter((item) => item.type === "pimGroup").sort(compareRawItems)
    };
  }, [items, referenceData]);
  const learnedNameCount = referenceData
    ? Object.keys(referenceData.directoryRoleDefinitions).length
      + Object.keys(referenceData.pimGroups).length
      + Object.keys(referenceData.azureRoleDefinitions).length
      + Object.keys(referenceData.azureSubscriptions).length
      + Object.keys(referenceData.scopes).length
      + Object.keys(referenceData.directoryScopes).length
    : 0;

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
      <h2>Names & Aliases</h2>
      <p className="muted">Override API and learned display names without changing the Microsoft role or group.</p>
      <div className="settings-subsection settings-section-gap">
        <h3>Add an alias</h3>
        <div className="form-grid">
          <div className="field">
            <label>Role or group</label>
            <select className="select" value={itemId} onChange={(event) => setItemId(event.target.value)} aria-label="Role or group">
              <option value="">Choose an eligible item</option>
              {aliasPickerGroups.roles.length ? (
                <optgroup label="Roles">
                  {aliasPickerGroups.roles.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.sourceName} / {getScopeLabel(item, referenceData)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {aliasPickerGroups.groups.length ? (
                <optgroup label="Groups">
                  {aliasPickerGroups.groups.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.sourceName} / {getScopeLabel(item, referenceData)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
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
      </div>
      <div className="settings-subsection">
        <h3>Learned names</h3>
        <p className="muted">
          QuickPIM++ has retained {learnedNameCount} Microsoft name{learnedNameCount === 1 ? "" : "s"} locally for fast display fallback.
          Manual aliases always take priority. Clearing learned names does not remove aliases.
        </p>
        <div className="button-row settings-form-actions">
          <button className="btn danger" onClick={() => void onClearReferenceData()} disabled={!learnedNameCount}>
            Clear learned names
          </button>
        </div>
      </div>
      <div className="settings-subsection">
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
  const [recentLimit, setRecentLimit] = useState(settings.preferences.recentJustificationLimit);
  const [confirmRestore, setConfirmRestore] = useState(false);

  useEffect(() => {
    setRecentLimit(settings.preferences.recentJustificationLimit);
  }, [settings.preferences.recentJustificationLimit]);

  async function saveRecentLimit() {
    if (!Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > 20 || recentLimit === settings.preferences.recentJustificationLimit) {
      return;
    }
    await onSave({
      ...settings,
      preferences: { ...settings.preferences, recentJustificationLimit: recentLimit }
    }, "");
  }

  async function restoreRecentLimit() {
    setConfirmRestore(false);
    const defaultLimit = DEFAULT_SETTINGS.preferences.recentJustificationLimit;
    setRecentLimit(defaultLimit);
    await onSave({
      ...settings,
      preferences: { ...settings.preferences, recentJustificationLimit: defaultLimit }
    }, "Justification picker default restored.");
  }

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
      <div className="panel-title-row">
        <div>
          <h2>Justifications</h2>
          <p className="muted">Manage reusable reasons and the recent-reason picker used during activation.</p>
        </div>
        <button
          className="btn secondary restore-defaults-button"
          disabled={recentLimit === DEFAULT_SETTINGS.preferences.recentJustificationLimit}
          onClick={() => setConfirmRestore(true)}
        >
          <ResetIcon />
          <span>Restore defaults</span>
        </button>
      </div>
      {confirmRestore ? (
        <div className="settings-confirmation" role="alertdialog" aria-label="Restore Justifications defaults">
          <span>Restore the recent-history limit? Saved and recent justifications will not be removed.</span>
          <div className="button-row nowrap">
            <button className="btn primary" onClick={() => void restoreRecentLimit()}>Restore</button>
            <button className="btn" onClick={() => setConfirmRestore(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="settings-subsection">
        <h3>Recent history</h3>
        <div className="form-grid compact-preference-fields">
          <div className="field">
            <label>Recent justification history limit</label>
            <input
              className="input"
              type="number"
              min="1"
              max="20"
              value={recentLimit}
              aria-invalid={!Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > 20}
              onChange={(event) => setRecentLimit(Number(event.target.value))}
              onBlur={() => void saveRecentLimit()}
            />
            <p className="muted">Number of recent reasons kept in the popup picker.</p>
          </div>
        </div>
      </div>
      <div className="settings-subsection">
        <h3>Add a saved justification</h3>
      <div className="form-row">
        <input
          className="input"
          value={value}
          maxLength={MAX_USER_JUSTIFICATION_LENGTH}
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
      </div>
      <div className="two-column justification-columns settings-section-gap">
        <div className="settings-subsection">
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
        <div className="settings-subsection">
          <h3>Recent</h3>
          {settings.recentJustifications.map((item) => (
            <div className="settings-row recent-justification-row" key={item}>
              <span>{item}</span>
              <CopyTextButton text={item} label="recent justification" />
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
      <h2>Bundles</h2>
      <p className="muted">Create reusable activation selections with policy-aware duration and an optional default justification.</p>
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
          maxLength={MAX_USER_JUSTIFICATION_LENGTH}
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

const PREFERENCE_AUTOSAVE_DELAY_MS = 300;
const PREFERENCE_AUTOSAVE_RETRY_DELAY_MS = 750;
const PREFERENCE_AUTOSAVE_MAX_RETRIES = 2;
const PREFERENCE_FEATURES: QuickPimFeature[] = ["directoryRole", "pimGroup", "azureRole", "bundles"];

type PreferenceSaveState = "idle" | "pending" | "saving" | "saved" | "invalid" | "error";

interface PreferenceDraft {
  defaultDurationHours: number;
  defaultExtensionDurationHours: number;
  recentJustificationLimit: number;
  activityHistoryLimit: number;
  darkMode: boolean;
  showAssignedRoles: boolean;
  showRemainingActivationTime: boolean;
  showActivationCounters: boolean;
  showEnablementDetails: boolean;
  showLastEnablementDate: boolean;
  backgroundPreRefreshEnabled: boolean;
  requestNotificationsEnabled: boolean;
  expiryReminderMinutes: number;
  enabledFeatures: QuickPimFeature[];
}

function createPreferenceDraft(settings: QuickPimSettings): PreferenceDraft {
  return {
    defaultDurationHours: settings.preferences.defaultDurationHours,
    defaultExtensionDurationHours: settings.preferences.defaultExtensionDurationHours,
    recentJustificationLimit: settings.preferences.recentJustificationLimit,
    activityHistoryLimit: settings.preferences.activityHistoryLimit,
    darkMode: settings.preferences.darkMode,
    showAssignedRoles: settings.preferences.showAssignedRoles,
    showRemainingActivationTime: settings.preferences.showRemainingActivationTime,
    showActivationCounters: settings.preferences.showActivationCounters,
    showEnablementDetails: settings.preferences.showEnablementDetails,
    showLastEnablementDate: settings.preferences.showLastEnablementDate,
    backgroundPreRefreshEnabled: settings.preferences.backgroundPreRefreshEnabled,
    requestNotificationsEnabled: settings.preferences.requestNotificationsEnabled,
    expiryReminderMinutes: settings.preferences.expiryReminderMinutes,
    enabledFeatures: PREFERENCE_FEATURES.filter((feature) => settings.preferences.enabledFeatures.includes(feature))
  };
}

function isAppearancePreferenceDefault(draft: PreferenceDraft): boolean {
  const defaults = DEFAULT_SETTINGS.preferences;
  return draft.darkMode === defaults.darkMode
    && draft.showAssignedRoles === defaults.showAssignedRoles
    && draft.showRemainingActivationTime === defaults.showRemainingActivationTime
    && draft.showActivationCounters === defaults.showActivationCounters
    && draft.showEnablementDetails === defaults.showEnablementDetails
    && draft.showLastEnablementDate === defaults.showLastEnablementDate
    && draft.enabledFeatures.includes("bundles") === defaults.enabledFeatures.includes("bundles");
}

function isActivationPreferenceDefault(draft: PreferenceDraft): boolean {
  const defaults = DEFAULT_SETTINGS.preferences;
  return draft.defaultDurationHours === defaults.defaultDurationHours
    && draft.defaultExtensionDurationHours === defaults.defaultExtensionDurationHours
    && draft.requestNotificationsEnabled === defaults.requestNotificationsEnabled
    && draft.expiryReminderMinutes === defaults.expiryReminderMinutes;
}

function isPreferenceDraftValid(draft: PreferenceDraft): boolean {
  return Number.isFinite(draft.recentJustificationLimit)
    && draft.recentJustificationLimit >= 1
    && draft.recentJustificationLimit <= 20
    && Number.isFinite(draft.activityHistoryLimit)
    && draft.activityHistoryLimit >= 10
    && draft.activityHistoryLimit <= 200;
}

function PreferenceSaveIndicator({ state }: { state: PreferenceSaveState }) {
  const labels: Record<PreferenceSaveState, string> = {
    idle: "Autosave on",
    pending: "Changes pending",
    saving: "Saving...",
    saved: "Saved",
    invalid: "Check values",
    error: "Save failed"
  };
  return (
    <span className={`autosave-status ${state}`} role="status" aria-live="polite">
      {state === "saving" ? <span className="spinner" aria-hidden="true" /> : null}
      {state === "saved" ? <span className="autosave-check" aria-hidden="true">✓</span> : null}
      <span>{labels[state]}</span>
    </span>
  );
}

function PreferenceToggleText({
  title,
  description,
  defaultEnabled
}: {
  title: string;
  description: string;
  defaultEnabled: boolean;
}) {
  return (
    <span className="preference-toggle-copy">
      <strong>{title}</strong>
      <span className="muted">{description}</span>
      <span className={`preference-default-state ${defaultEnabled ? "enabled" : "disabled"}`}>
        {defaultEnabled ? "Enabled by default" : "Disabled by default"}
      </span>
    </span>
  );
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon">
      <path d="M4 4v6h6" />
      <path d="M5.5 15a7 7 0 1 0 1.5-7.5L4 10" />
    </svg>
  );
}

function PreferencesPanel({
  page,
  settings,
  onSave,
  navigationFlushRef
}: {
  page: PreferencePage;
  settings: QuickPimSettings;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
  navigationFlushRef: MutableRefObject<(() => Promise<void>) | undefined>;
}) {
  const [draft, setDraft] = useState<PreferenceDraft>(() => createPreferenceDraft(settings));
  const [saveState, setSaveState] = useState<PreferenceSaveState>("idle");
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [notificationPermissionError, setNotificationPermissionError] = useState("");
  const [isRequestingNotificationPermission, setIsRequestingNotificationPermission] = useState(false);
  const settingsRef = useRef(settings);
  const onSaveRef = useRef(onSave);
  const draftRef = useRef(draft);
  const revisionRef = useRef(0);
  const queuedRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const autosaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveRetryTimerRef = useRef<number | undefined>(undefined);
  const autosaveRetryCountRef = useRef(0);
  const isMountedRef = useRef(true);
  const lastSavedNotificationsRef = useRef(settings.preferences.requestNotificationsEnabled);
  const notificationPermissionGrantedRef = useRef(false);

  settingsRef.current = settings;
  onSaveRef.current = onSave;
  draftRef.current = draft;

  useLayoutEffect(() => {
    if (revisionRef.current !== savedRevisionRef.current) {
      return;
    }
    const nextDraft = createPreferenceDraft(settings);
    draftRef.current = nextDraft;
    lastSavedNotificationsRef.current = settings.preferences.requestNotificationsEnabled;
    setDraft(nextDraft);
  }, [settings]);

  useEffect(() => {
    const revision = revisionRef.current;
    if (revision <= savedRevisionRef.current || revision <= queuedRevisionRef.current) {
      return;
    }
    if (!isPreferenceDraftValid(draft)) {
      setSaveState("invalid");
      return;
    }
    setSaveState("pending");
    const timer = window.setTimeout(() => {
      queueAutosave(draftRef.current, revisionRef.current);
    }, PREFERENCE_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    isMountedRef.current = true;
    function flushPendingPreferences() {
      queueAutosave(draftRef.current, revisionRef.current);
    }
    window.addEventListener("pagehide", flushPendingPreferences);
    return () => {
      window.removeEventListener("pagehide", flushPendingPreferences);
      if (autosaveRetryTimerRef.current !== undefined) {
        window.clearTimeout(autosaveRetryTimerRef.current);
        autosaveRetryTimerRef.current = undefined;
      }
      flushPendingPreferences();
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const flushBeforeNavigation = () => queueAutosave(draftRef.current, revisionRef.current);
    navigationFlushRef.current = flushBeforeNavigation;
    return () => {
      if (navigationFlushRef.current === flushBeforeNavigation) {
        navigationFlushRef.current = undefined;
      }
    };
  }, [navigationFlushRef]);

  function updateDraft(patch: Partial<PreferenceDraft>) {
    if (autosaveRetryTimerRef.current !== undefined) {
      window.clearTimeout(autosaveRetryTimerRef.current);
      autosaveRetryTimerRef.current = undefined;
    }
    autosaveRetryCountRef.current = 0;
    const next = { ...draftRef.current, ...patch };
    revisionRef.current += 1;
    draftRef.current = next;
    setDraft(next);
    setSaveState(isPreferenceDraftValid(next) ? "pending" : "invalid");
  }

  function queueAutosave(snapshot: PreferenceDraft, revision: number): Promise<void> {
    if (
      revision <= savedRevisionRef.current
      || revision <= queuedRevisionRef.current
      || !isPreferenceDraftValid(snapshot)
    ) {
      return autosaveQueueRef.current;
    }
    queuedRevisionRef.current = revision;
    autosaveQueueRef.current = autosaveQueueRef.current.then(async () => {
      if (isMountedRef.current) {
        setSaveState("saving");
      }
      const current = settingsRef.current;
      const saved = await onSaveRef.current({
        ...current,
        preferences: {
          ...current.preferences,
          ...snapshot,
          enabledFeatures: [...snapshot.enabledFeatures],
          autoEnabledFeaturesInitialized: true
        }
      }, "");
      if (!saved) {
        handleAutosaveFailure(snapshot, revision);
        return;
      }

      if (
        !snapshot.requestNotificationsEnabled
        && (lastSavedNotificationsRef.current || notificationPermissionGrantedRef.current)
      ) {
        try {
          await chrome.permissions.remove({ permissions: ["notifications"] });
        } catch {
          // The preference remains disabled even if this browser retains the optional permission.
        }
        notificationPermissionGrantedRef.current = false;
      }
      lastSavedNotificationsRef.current = snapshot.requestNotificationsEnabled;
      savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
      autosaveRetryCountRef.current = 0;
      if (isMountedRef.current && revision === revisionRef.current) {
        setSaveState("saved");
      }
    }).catch(() => {
      handleAutosaveFailure(snapshot, revision);
    });
    return autosaveQueueRef.current;
  }

  function handleAutosaveFailure(snapshot: PreferenceDraft, revision: number) {
    if (queuedRevisionRef.current === revision) {
      queuedRevisionRef.current = savedRevisionRef.current;
    }
    if (!isMountedRef.current || revision !== revisionRef.current) {
      return;
    }
    setSaveState("error");
    if (autosaveRetryCountRef.current >= PREFERENCE_AUTOSAVE_MAX_RETRIES) {
      return;
    }
    autosaveRetryCountRef.current += 1;
    const retryDelay = PREFERENCE_AUTOSAVE_RETRY_DELAY_MS * autosaveRetryCountRef.current;
    autosaveRetryTimerRef.current = window.setTimeout(() => {
      autosaveRetryTimerRef.current = undefined;
      queueAutosave(snapshot, revision);
    }, retryDelay);
  }

  async function toggleRequestNotifications(enabled: boolean) {
    setNotificationPermissionError("");
    if (!enabled) {
      updateDraft({ requestNotificationsEnabled: false });
      return;
    }
    setIsRequestingNotificationPermission(true);
    try {
      const granted = await chrome.permissions.request({ permissions: ["notifications"] });
      if (!granted) {
        setNotificationPermissionError("Notification permission was not granted. Request tracking still works in Settings > Activity & Usage.");
        return;
      }
      notificationPermissionGrantedRef.current = true;
      updateDraft({ requestNotificationsEnabled: true });
    } catch {
      setNotificationPermissionError("This browser could not enable request notifications. Request tracking still works in Settings > Activity & Usage.");
    } finally {
      setIsRequestingNotificationPermission(false);
    }
  }

  function toggleFeature(feature: QuickPimFeature, enabled: boolean) {
    const nextFeatures = new Set(draftRef.current.enabledFeatures);
    if (enabled) {
      nextFeatures.add(feature);
    } else {
      nextFeatures.delete(feature);
    }
    updateDraft({ enabledFeatures: PREFERENCE_FEATURES.filter((item) => nextFeatures.has(item)) });
  }

  function restorePageDefaults() {
    setConfirmRestore(false);
    if (page === "appearance") {
      const roleFeatures = new Set<QuickPimFeature>(draftRef.current.enabledFeatures.filter((feature) => feature !== "bundles"));
      if (DEFAULT_SETTINGS.preferences.enabledFeatures.includes("bundles")) {
        roleFeatures.add("bundles");
      }
      updateDraft({
        darkMode: DEFAULT_SETTINGS.preferences.darkMode,
        showAssignedRoles: DEFAULT_SETTINGS.preferences.showAssignedRoles,
        showRemainingActivationTime: DEFAULT_SETTINGS.preferences.showRemainingActivationTime,
        showActivationCounters: DEFAULT_SETTINGS.preferences.showActivationCounters,
        showEnablementDetails: DEFAULT_SETTINGS.preferences.showEnablementDetails,
        showLastEnablementDate: DEFAULT_SETTINGS.preferences.showLastEnablementDate,
        enabledFeatures: PREFERENCE_FEATURES.filter((feature) => roleFeatures.has(feature))
      });
      return;
    }
    if (page === "activation") {
      updateDraft({
        defaultDurationHours: DEFAULT_SETTINGS.preferences.defaultDurationHours,
        defaultExtensionDurationHours: DEFAULT_SETTINGS.preferences.defaultExtensionDurationHours,
        requestNotificationsEnabled: DEFAULT_SETTINGS.preferences.requestNotificationsEnabled,
        expiryReminderMinutes: DEFAULT_SETTINGS.preferences.expiryReminderMinutes
      });
    }
  }

  const canRestoreDefaults = page === "appearance"
    ? !isAppearancePreferenceDefault(draft)
    : !isActivationPreferenceDefault(draft);
  const pageCopy: Record<PreferencePage, { title: string; description: string }> = {
    appearance: {
      title: "Popup & Appearance",
      description: "Choose visible tabs and refresh behavior, then control role details and appearance."
    },
    activation: {
      title: "Activation & Notifications",
      description: "Choose activation and extension defaults, then configure request follow-up."
    }
  };
  const copy = pageCopy[page];
  const restoreDescription = page === "appearance"
    ? "Restore dark mode, Bundles visibility, assigned roles, remaining time, counters, enablement details, and last-enablement date?"
    : "Restore activation duration, extension duration, request notifications, and expiry reminder?";

  return (
    <section className="panel preferences-panel" data-preference-page={page}>
      <div className="preferences-title-row">
        <div>
          <h2>{copy.title}</h2>
          <p className="muted">{copy.description} Changes are saved automatically.</p>
        </div>
        <div className="settings-page-actions">
          <button className="btn secondary restore-defaults-button" disabled={!canRestoreDefaults} onClick={() => setConfirmRestore(true)}>
            <ResetIcon />
            <span>Restore defaults</span>
          </button>
          <PreferenceSaveIndicator state={saveState} />
        </div>
      </div>
      {confirmRestore ? (
        <div className="settings-confirmation" role="alertdialog" aria-label={`Restore ${copy.title} defaults`}>
          <span>{restoreDescription} Saved aliases, justifications, and bundles will not be changed.</span>
          <div className="button-row nowrap">
            <button className="btn primary" onClick={restorePageDefaults}>Restore</button>
            <button className="btn" onClick={() => setConfirmRestore(false)}>Cancel</button>
          </div>
        </div>
      ) : null}

      {page === "activation" ? (
        <>
          <div className="preference-section">
            <h3>Activation and extension timing</h3>
            <p className="muted">Microsoft role policies can still reduce the available duration.</p>
            <div className="form-grid settings-section-gap popup-defaults-grid">
              <div className="field">
                <label>Default activation duration</label>
                <select
                  className="select"
                  value={String(draft.defaultDurationHours)}
                  onChange={(event) => updateDraft({ defaultDurationHours: Number(event.target.value) })}
                  aria-label="Default activation duration"
                >
                  {DEFAULT_DURATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <p className="muted">Preselected when selected roles allow it.</p>
              </div>
              <div className="field">
                <label>Default extension duration</label>
                <select
                  className="select"
                  value={draft.defaultExtensionDurationHours}
                  onChange={(event) => updateDraft({ defaultExtensionDurationHours: Number(event.target.value) })}
                  aria-label="Default PIM extension duration"
                >
                  {EXTENSION_DURATION_OPTIONS.map((duration) => (
                    <option key={duration} value={duration}>{formatExtensionDuration(duration)}</option>
                  ))}
                </select>
                <p className="muted">Used by Extend actions; stricter role policies still apply.</p>
              </div>
            </div>
          </div>
          <div className="preference-section">
            <h3>Request follow-up</h3>
            <div className="preference-toggle-list">
              <label className="checkbox-option preference-toggle">
                <input
                  type="checkbox"
                  checked={draft.requestNotificationsEnabled}
                  disabled={isRequestingNotificationPermission}
                  onChange={(event) => void toggleRequestNotifications(event.target.checked)}
                  aria-label="Notify me about request updates"
                />
                <span><strong>Request status notifications</strong><span className="muted">Notify when a request is approved, denied, completed, or close to expiry. Disabled by default.</span></span>
              </label>
            </div>
            <div className="form-grid settings-section-gap compact-preference-fields">
              <div className="field">
                <label>Expiry reminder</label>
                <select
                  className="select"
                  value={draft.expiryReminderMinutes}
                  disabled={!draft.requestNotificationsEnabled}
                  onChange={(event) => updateDraft({ expiryReminderMinutes: Number(event.target.value) })}
                  aria-label="Request expiry reminder"
                >
                  <option value={5}>5 minutes before</option>
                  <option value={15}>15 minutes before</option>
                  <option value={30}>30 minutes before</option>
                  <option value={60}>1 hour before</option>
                </select>
                <p className="muted">Used only when Microsoft returns an activation end time.</p>
              </div>
            </div>
            {notificationPermissionError ? <p className="message error settings-inline-message" role="alert">{notificationPermissionError}</p> : null}
          </div>
        </>
      ) : null}

      {page === "appearance" ? (
        <>
          <div className="preference-section theme-preference-section">
            <div className="theme-preference-copy">
              <h3>Color theme</h3>
              <p className="muted">Choose the appearance used by both the popup and Settings.</p>
            </div>
            <button
              type="button"
              className="theme-mode-switch"
              role="switch"
              aria-checked={draft.darkMode}
              aria-label="Dark mode"
              onClick={() => updateDraft({ darkMode: !draft.darkMode })}
            >
              <span className={!draft.darkMode ? "active" : undefined}>Light mode</span>
              <span className={draft.darkMode ? "active" : undefined}>Dark mode</span>
            </button>
          </div>
          <div className="preference-section">
            <h3>Enabled tabs</h3>
            <p className="muted">Choose which role sources and saved bundles appear in the popup. Disabled role sources are not requested or refreshed; empty role tabs remain hidden automatically.</p>
            <div className="checkbox-grid compact settings-section-gap enabled-features-grid">
              {PREFERENCE_FEATURES.map((feature) => (
                <label className="checkbox-option preference-toggle" key={feature}>
                  <input
                    type="checkbox"
                    checked={draft.enabledFeatures.includes(feature)}
                    onChange={(event) => toggleFeature(feature, event.target.checked)}
                    aria-label={`Enable ${popupTabLabel(feature)} feature`}
                  />
                  <span>
                    <strong>{popupTabLabel(feature)}</strong>
                    <span className="muted">
                      {feature === "bundles" ? "Show saved activation bundles." : "Fetch and show this Microsoft role source."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="preference-section">
            <h3>Refresh behavior</h3>
            <div className="preference-toggle-list">
              <label className="checkbox-option preference-toggle">
                <input type="checkbox" checked={draft.backgroundPreRefreshEnabled} onChange={(event) => updateDraft({ backgroundPreRefreshEnabled: event.target.checked })} aria-label="Enable background pre-refresh" />
                <span><strong>Background pre-refresh</strong><span className="muted">Refresh stale enabled role data every 10 minutes while browser alarms are available.</span></span>
              </label>
            </div>
          </div>
          <div className="preference-section">
            <h3>Role row details</h3>
            <p className="muted">Optional information shown beneath or beside each role in the popup.</p>
            <div className="preference-toggle-list">
              <label className="checkbox-option preference-toggle">
                <input type="checkbox" checked={draft.showRemainingActivationTime} onChange={(event) => updateDraft({ showRemainingActivationTime: event.target.checked })} aria-label="Show remaining activation time in popup" />
                <PreferenceToggleText
                  title="Show remaining activation time"
                  description="Display a live countdown under PIM-active roles."
                  defaultEnabled={DEFAULT_SETTINGS.preferences.showRemainingActivationTime}
                />
              </label>
              <label className="checkbox-option preference-toggle">
                <input type="checkbox" checked={draft.showAssignedRoles} onChange={(event) => updateDraft({ showAssignedRoles: event.target.checked })} aria-label="Show assigned active roles in popup" />
                <PreferenceToggleText
                  title="Show assigned active roles"
                  description="Include direct active assignments that were not activated through PIM."
                  defaultEnabled={DEFAULT_SETTINGS.preferences.showAssignedRoles}
                />
              </label>
              <label className="checkbox-option preference-toggle">
                <input type="checkbox" checked={draft.showActivationCounters} onChange={(event) => updateDraft({ showActivationCounters: event.target.checked })} aria-label="Show activation counters in popup" />
                <PreferenceToggleText
                  title="Show activation counters"
                  description="Display the compact usage number on each popup row."
                  defaultEnabled={DEFAULT_SETTINGS.preferences.showActivationCounters}
                />
              </label>
              <label className="checkbox-option preference-toggle">
                <input type="checkbox" checked={draft.showEnablementDetails} onChange={(event) => updateDraft({ showEnablementDetails: event.target.checked })} aria-label="Show enablement details in popup" />
                <PreferenceToggleText
                  title="Show enablement details"
                  description="Display max duration, required reason, ticket, and approval policy details."
                  defaultEnabled={DEFAULT_SETTINGS.preferences.showEnablementDetails}
                />
              </label>
              <label className="checkbox-option preference-toggle">
                <input type="checkbox" checked={draft.showLastEnablementDate} onChange={(event) => updateDraft({ showLastEnablementDate: event.target.checked })} aria-label="Show last enablement date in popup" />
                <PreferenceToggleText
                  title="Show last enablement date"
                  description="Display the last enablement date as yyyy-MM-dd."
                  defaultEnabled={DEFAULT_SETTINGS.preferences.showLastEnablementDate}
                />
              </label>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function DataPanel({
  settings,
  exportText,
  exportBaselineText,
  externalChange,
  setExportText,
  onSave,
  onClearMessage,
  onError
}: {
  settings: QuickPimSettings;
  exportText: string;
  exportBaselineText: string;
  externalChange: boolean;
  setExportText: (value: string, dirty?: boolean) => void;
  onSave: (settings: QuickPimSettings, message?: string) => Promise<boolean>;
  onClearMessage: () => void;
  onError: (message: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [stagedFileName, setStagedFileName] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const validation = useMemo(() => validateSettingsBackup(exportText, settings), [exportText, settings]);
  const isDirty = exportText !== exportBaselineText;

  async function saveEditor() {
    onClearMessage();
    onError("");
    setActionMessage("");
    if (!validation.settings) {
      onError(validation.error || "The JSON cannot be saved.");
      return;
    }
    if (await onSave(validation.settings, "Settings restored from JSON.")) {
      setExportText(JSON.stringify(validation.settings, null, 2), false);
      setStagedFileName("");
    }
  }

  async function copyJson() {
    onError("");
    setActionMessage("");
    if (!validation.settings) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(exportText);
      setActionMessage("Settings JSON copied.");
    } catch (copyError) {
      onError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }

  function downloadJson() {
    onError("");
    setActionMessage("");
    if (!validation.settings) return;
    const blob = new Blob([exportText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildSettingsExportFileName(new Date());
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setActionMessage("Settings JSON downloaded.");
  }

  async function loadJsonFile(file: File | undefined) {
    if (!file) return;
    onClearMessage();
    onError("");
    setActionMessage("");
    try {
      if (!file.name.toLowerCase().endsWith(".json")) {
        throw new Error("Choose a .json settings file.");
      }
      if (file.size > MAX_SETTINGS_BACKUP_BYTES) {
        throw new Error("The settings file is larger than 1 MiB.");
      }
      const text = await file.text();
      const nextValidation = validateSettingsBackup(text, settings);
      if (!nextValidation.settings) {
        throw new Error(nextValidation.error || "The selected file is not a valid QuickPIM++ settings backup.");
      }
      const formatted = JSON.stringify(JSON.parse(text) as unknown, null, 2);
      setExportText(formatted, formatted !== exportBaselineText);
      setStagedFileName(file.name);
    } catch (fileError) {
      onError(fileError instanceof Error ? fileError.message : String(fileError));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function reloadSaved() {
    onClearMessage();
    onError("");
    setActionMessage("Saved settings reloaded.");
    setStagedFileName("");
    setExportText(exportBaselineText, false);
  }

  async function resetAllSettings() {
    setConfirmReset(false);
    if (await onSave(DEFAULT_SETTINGS, "Settings reset to defaults.")) {
      setExportText(JSON.stringify(DEFAULT_SETTINGS, null, 2), false);
      setActionMessage("");
      setStagedFileName("");
    }
  }

  return (
    <section className="panel backup-panel">
      <div className="panel-title-row">
        <div>
          <h2>Backup & Restore</h2>
          <p className="muted">Copy, download, review, or restore portable QuickPIM++ data. Backups include preferences, aliases, favorites, bundles, justifications, counters, and activity history. Access tokens and temporary caches are intentionally excluded.</p>
        </div>
        <span className={`backup-dirty-state ${isDirty ? "dirty" : "saved"}`}>{isDirty ? "Unsaved JSON changes" : "Matches saved settings"}</span>
      </div>
      <div className="button-row backup-file-actions">
        <button className="btn" disabled={!validation.settings} onClick={() => void copyJson()}>
          <CopyIcon />
          <span>Copy JSON</span>
        </button>
        <button className="btn" disabled={!validation.settings} onClick={downloadJson}>
          <DownloadIcon />
          <span>Download JSON</span>
        </button>
        <button className="btn" onClick={() => fileInputRef.current?.click()}>
          <UploadIcon />
          <span>Load JSON file</span>
        </button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept=".json,application/json"
          onChange={(event) => void loadJsonFile(event.target.files?.[0])}
          aria-label="Load QuickPIM++ settings JSON file"
        />
      </div>
      {stagedFileName && isDirty && validation.settings ? (
        <div className="settings-confirmation warning backup-staged-confirmation" role="status">
          <span><strong>{stagedFileName}</strong> is loaded but has not been restored yet.</span>
          <button className="btn primary" onClick={() => void saveEditor()}>
            <SaveIcon />
            <span>Apply loaded backup</span>
          </button>
        </div>
      ) : null}
      {externalChange && isDirty ? <p className="message warning settings-inline-message">Saved settings changed elsewhere. Reload to use the latest saved version, or save this editor to replace it.</p> : null}
      {validation.error ? <p className="message error settings-inline-message" role="alert">{validation.error}</p> : null}
      {actionMessage ? <p className="message success settings-inline-message" role="status">{actionMessage}</p> : null}
      <div className="field settings-section-gap">
        <label>Settings JSON</label>
        <textarea
          aria-label="QuickPIM++ settings JSON"
          className="textarea code-box"
          value={exportText}
          spellCheck={false}
          onChange={(event) => {
            setStagedFileName("");
            setExportText(event.target.value, event.target.value !== exportBaselineText);
          }}
        />
        <p className="muted">Loading a file does not change this installation until you apply it. Manual editor changes are also not autosaved.</p>
      </div>
      <div className="button-row settings-form-actions backup-editor-actions">
        <button className="btn primary" disabled={!isDirty || !validation.settings} onClick={() => void saveEditor()}>
          <SaveIcon />
          <span>Save changes</span>
        </button>
        <button className="btn" disabled={!isDirty} onClick={reloadSaved}>
          <ResetIcon />
          <span>Reload saved</span>
        </button>
      </div>
      <div className="settings-danger-zone">
        <div>
          <h3>Reset settings</h3>
          <p className="muted">Restore all QuickPIM++ settings and locally stored preferences to their defaults.</p>
        </div>
        <button className="btn danger" onClick={() => setConfirmReset(true)}>Reset all settings</button>
      </div>
      {confirmReset ? (
        <div className="settings-confirmation danger" role="alertdialog" aria-label="Reset all QuickPIM++ settings">
          <span>This resets aliases, favorites, justifications, bundles, usage data, history, and preferences. Captured tokens are not changed.</span>
          <div className="button-row nowrap">
            <button className="btn danger" onClick={() => void resetAllSettings()}>Reset everything</button>
            <button className="btn" onClick={() => setConfirmReset(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>;
}

function UploadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon"><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M5 3h14" /></svg>;
}

function SaveIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon"><path d="M5 4h12l2 2v14H5z" /><path d="M8 4v6h8V4" /><path d="M8 20v-6h8v6" /></svg>;
}

function ResetDataPanel({
  onNavigate,
  onReset
}: {
  onNavigate: (tab: SettingsTab) => void;
  onReset: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  async function resetEverything() {
    setIsResetting(true);
    try {
      if (await onReset()) {
        setConfirming(false);
        setAcknowledged(false);
      }
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <section className="panel reset-data-panel">
      <div className="panel-title-row">
        <div>
          <h2>Reset QuickPIM++</h2>
          <p className="muted">Erase all extension data from this browser profile and return QuickPIM++ to its first-run state.</p>
        </div>
      </div>
      <div className="settings-subsection backup-recommendation">
        <h3>Back up first</h3>
        <p className="muted">Download a JSON backup before resetting if you may need your aliases, justifications, bundles, preferences, or local history again.</p>
        <button className="btn" onClick={() => onNavigate("backup")}>
          Open Backup & Restore
        </button>
      </div>
      <div className="settings-danger-zone reset-extension-zone">
        <div>
          <h3>Start from scratch</h3>
          <p className="muted">This removes settings, aliases, favorites, justifications, bundles, usage and request history, learned names, caches, drafts, tracked requests, and captured session tokens.</p>
        </div>
        <button className="btn danger" onClick={() => setConfirming(true)}>Erase all extension data</button>
      </div>
      {confirming ? (
        <div className="settings-confirmation danger reset-extension-confirmation" role="alertdialog" aria-label="Erase all QuickPIM++ data">
          <label className="checkbox-option">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>I understand this cannot be undone without a backup.</span>
          </label>
          <div className="button-row nowrap">
            <button className="btn danger" disabled={!acknowledged || isResetting} onClick={() => void resetEverything()}>
              {isResetting ? "Erasing..." : "Erase everything"}
            </button>
            <button className="btn" disabled={isResetting} onClick={() => { setConfirming(false); setAcknowledged(false); }}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function tabLabel(tab: SettingsTab): string {
  const labels: Record<SettingsTab, string> = {
    home: "Home",
    "role-access": "Role Access",
    appearance: "Popup & Appearance",
    aliases: "Names & Aliases",
    activation: "Activation & Notifications",
    justifications: "Justifications",
    bundles: "Bundles",
    activity: "Activity & Usage",
    sync: "Browser Sync",
    diagnostics: "Diagnostics",
    backup: "Backup & Restore",
    reset: "Reset QuickPIM++",
    about: "About"
  };
  return labels[tab];
}

function tabFromHash(): SettingsTab {
  const value = window.location.hash.replace("#", "");
  const legacyRoutes: Record<string, SettingsTab> = {
    permissions: "role-access",
    access: "role-access",
    sources: "appearance",
    preferences: "appearance",
    display: "appearance",
    defaults: "activation",
    automation: "activation",
    data: "backup"
  };
  if (legacyRoutes[value]) {
    return legacyRoutes[value];
  }
  if (value === "reset-data") {
    return "reset";
  }
  if (["home", "role-access", "appearance", "aliases", "activation", "justifications", "bundles", "activity", "sync", "diagnostics", "backup", "reset", "about"].includes(value)) {
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
    const snapshot = await sendMessage<ActivationSnapshot>(
      {
        action: "getActivationSnapshot",
        targets
      },
      { timeoutMs: ACTIVATION_SNAPSHOT_TIMEOUT_MS, timeoutMessage: `${targets.map(popupTabLabel).join(", ")} refresh timed out. Cached data remains available.` }
    );
    if (isActivationSnapshot(snapshot)) {
      return snapshot;
    }
  } catch (error) {
    if (isOperationTimeoutError(error)) {
      throw error;
    }
    // Fall through to the legacy paired calls for compatibility with older/background test runtimes.
  }

  const [eligible, active] = await Promise.all([
    sendMessage<ActivationSnapshot["eligible"]>(
      { action: "getActivationItems", targets },
      { timeoutMs: ACTIVATION_SNAPSHOT_TIMEOUT_MS, timeoutMessage: "Eligible assignment refresh timed out. Cached data remains available." }
    ),
    sendMessage<ActivationSnapshot["active"]>(
      { action: "getActiveItems", targets },
      { timeoutMs: ACTIVATION_SNAPSHOT_TIMEOUT_MS, timeoutMessage: "Active assignment refresh timed out. Cached data remains available." }
    )
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

function sendMessage<T>(
  message: Record<string, unknown>,
  options?: { timeoutMs?: number; timeoutMessage?: string }
): Promise<T> {
  return sendRuntimeMessage<T>(message, options);
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
