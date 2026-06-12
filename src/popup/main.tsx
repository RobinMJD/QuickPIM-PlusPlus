import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  STALE_ELIGIBLE_CACHE_TTL_MS,
  getTargetEntriesFromCache,
  loadDataCache,
  mergeTargetEntries,
  saveDataCache,
  splitActivationResultByTarget,
  updateCacheFromTargetResults
} from "../lib/cache";
import { CLAIMS_CHALLENGE_MESSAGE } from "../lib/apiErrors";
import { formatDateOnly } from "../lib/dateFormat";
import {
  buildAccessCapabilityItems,
  buildTokenCacheKey,
  buildTargetCacheKeys,
  getAccessSetupTargets,
  type AccessCapabilityItem
} from "../lib/access";
import { filterLoadErrorsForAccessState } from "../lib/accessMessages";
import {
  coerceDurationForItems,
  formatActivationStatusLabel,
  formatLoadMessages,
  getActivationRequirements,
  getActivationStatusTitle,
  getActivatableItems,
  getDeactivatableItems,
  getDurationOptions,
  getRemainingSelectedIdsAfterActivationResults,
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
  buildFeatureCacheKey,
  expandBundle,
  getAutoEnabledFeatures,
  getDisplayName,
  getEnabledRoleFeatures,
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
import { getGenericJustificationWarning } from "../lib/justifications";
import {
  clearPopupDraft,
  hasPopupDraftContent,
  loadPopupDraft,
  savePopupDraft,
  type PopupDraftInput
} from "../lib/popupDraft";
import type {
  AccessSetupTarget,
  ActivationSnapshot,
  ActivationItem,
  ActivationResponse,
  QuickPimBundle,
  QuickPimFeature,
  QuickPimDataCache,
  ReferenceDataCache,
  QuickPimSettings,
  PopupRequestMode,
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

interface ActivationFailureNotice {
  errors: string[];
  claimsChallengeTargets: RoleTab[];
}

const ACTIVATION_STEPS: LoadingProgress[] = [
  { current: 1, total: 3, label: "Sending activation request" },
  { current: 2, total: 3, label: "Saving activation result" },
  { current: 3, total: 3, label: "Refreshing activation status" }
];
const DEACTIVATION_STEPS: LoadingProgress[] = [
  { current: 1, total: 3, label: "Sending deactivation request" },
  { current: 2, total: 3, label: "Saving deactivation result" },
  { current: 3, total: 3, label: "Refreshing deactivation status" }
];
const REFRESH_TOTAL_STEPS = 4;

function buildActivationFailureNotice(
  errors: ActivationResponse["errors"],
  activatableItems: ActivationItem[]
): ActivationFailureNotice {
  const itemsById = new Map(activatableItems.map((item) => [item.id, item.type]));
  const claimsChallengeTargets = new Set<RoleTab>();
  const formattedErrors = errors.map((errorItem) => {
    const rawError = errorItem.error || "";
    const formatted = formatActivationError(errorItem);
    if (formatLoadMessages([rawError]).includes(CLAIMS_CHALLENGE_MESSAGE)) {
      const target = itemsById.get(errorItem.itemId) || inferRoleTabFromItemId(errorItem.itemId);
      if (target) {
        claimsChallengeTargets.add(target);
      }
    }
    return formatted;
  });

  return {
    errors: formattedErrors,
    claimsChallengeTargets: [...claimsChallengeTargets]
  };
}

function formatActivationError(item: ActivationResponse["errors"][number]): string {
  const error = item.error || "Activation failed.";
  const formatted = formatLoadMessages([error])[0] || error;
  return `${item.itemName}: ${formatted}`;
}

function inferRoleTabFromItemId(itemId: string): RoleTab | undefined {
  const [prefix] = itemId.split(":");
  if (prefix === "directoryRole" || prefix === "pimGroup" || prefix === "azureRole") {
    return prefix;
  }
  return undefined;
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<LoadingProgress | null>(null);
  const [refreshSuccessKey, setRefreshSuccessKey] = useState(0);
  const [isActivationReviewOpen, setIsActivationReviewOpen] = useState(false);
  const [activationProgress, setActivationProgress] = useState<LoadingProgress | null>(null);
  const [activationFailureNotice, setActivationFailureNotice] = useState<ActivationFailureNotice | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  const [requestMode, setRequestMode] = useState<PopupRequestMode | undefined>();
  const [isPopupDraftReady, setIsPopupDraftReady] = useState(false);
  const [hasRestoredPopupDraft, setHasRestoredPopupDraft] = useState(false);
  const [hasActivationDataLoaded, setHasActivationDataLoaded] = useState(false);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSuccessTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestPopupDraft = useRef<PopupDraftInput | undefined>(undefined);

  useEffect(() => {
    void initializePopup();
  }, []);

  useEffect(() => {
    if (!isPopupDraftReady || hasRestoredPopupDraft) {
      return;
    }
    setSortMode(settings.preferences.defaultSort);
    setDurationHours(settings.preferences.defaultDurationHours);
  }, [hasRestoredPopupDraft, isPopupDraftReady, settings.preferences.defaultDurationHours, settings.preferences.defaultSort]);

  useEffect(() => {
    document.body.classList.toggle("dark-mode", settings.preferences.darkMode);
  }, [settings.preferences.darkMode]);

  useEffect(() => () => {
    if (refreshSuccessTimer.current) {
      clearTimeout(refreshSuccessTimer.current);
    }
  }, []);

  const displayItems = useMemo(
    () => mergeEligibleWithActive(eligibleItems, activeItems, { includeActiveOnly: true }),
    [activeItems, eligibleItems]
  );
  const activatableItemCount = useMemo(() => getActivatableItems(displayItems).length, [displayItems]);
  const itemsById = useMemo(() => new Map(displayItems.map((item) => [item.id, item])), [displayItems]);
  const enabledFeatures = useMemo(() => new Set<QuickPimFeature>(settings.preferences.enabledFeatures || []), [settings.preferences.enabledFeatures]);
  const itemTypesWithData = useMemo(() => new Set(displayItems.map((item) => item.type)), [displayItems]);
  const roleTabs = useMemo<RoleTab[]>(
    () =>
      (["directoryRole", "pimGroup", "azureRole"] as RoleTab[]).filter(
        (roleTab) => enabledFeatures.has(roleTab) && (isLoading || itemTypesWithData.has(roleTab))
      ),
    [enabledFeatures, isLoading, itemTypesWithData]
  );
  const visibleTabs = useMemo<PopupTab[]>(() => {
    const tabs: PopupTab[] = [...roleTabs];
    if (enabledFeatures.has("bundles")) {
      tabs.push("bundles");
    }
    return tabs;
  }, [enabledFeatures, roleTabs]);
  const favoriteIds = useMemo(() => new Set(settings.favoriteItemIds || []), [settings.favoriteItemIds]);
  const selectedItems = useMemo(
    () => {
      const items = [...selectedIds].map((id) => itemsById.get(id)).filter((item): item is ActivationItem => Boolean(item));
      return requestMode === "deactivate" ? getDeactivatableItems(items) : getActivatableItems(items);
    },
    [itemsById, requestMode, selectedIds]
  );
  const selectedDirectoryRoleCount = useMemo(
    () => requestMode === "activate" ? selectedItems.filter((item) => item.type === "directoryRole").length : 0,
    [requestMode, selectedItems]
  );
  const requirements = useMemo(() => getActivationRequirements(requestMode === "activate" ? selectedItems : []), [requestMode, selectedItems]);
  const durationOptions = useMemo(() => getDurationOptions(requestMode === "activate" ? selectedItems : []), [requestMode, selectedItems]);
  const accessSetupTargets = useMemo(() => getAccessSetupTargets(accessCapabilities), [accessCapabilities]);
  const showPermissionWarning = useMemo(
    () => tokenStatus !== null && !settings.preferences.permissionWarningIgnored && accessSetupTargets.length > 0,
    [accessSetupTargets.length, settings, tokenStatus]
  );

  useEffect(() => {
    if (!hasActivationDataLoaded) {
      return;
    }
    if (durationOptions.length) {
      setDurationHours((current) => coerceDurationForItems(current, selectedItems));
    }
  }, [durationOptions, hasActivationDataLoaded, selectedItems]);

  useEffect(() => {
    if (!hasActivationDataLoaded) {
      return;
    }
    setSelectedIds((current) => {
      const mode = requestMode || getRequestModeForItem([...current].map((id) => itemsById.get(id)).find(Boolean));
      const next = new Set(
        [...current].filter((id) => {
          const item = itemsById.get(id);
          return mode ? getRequestModeForItem(item) === mode : Boolean(getRequestModeForItem(item));
        })
      );
      if (!next.size && current.size) {
        if (draftSaveTimer.current) {
          clearTimeout(draftSaveTimer.current);
          draftSaveTimer.current = undefined;
        }
        latestPopupDraft.current = undefined;
        setRequestMode(undefined);
        void clearPopupDraft();
      }
      if (next.size && !requestMode && mode) {
        setRequestMode(mode);
      }
      return next.size === current.size ? current : next;
    });
  }, [hasActivationDataLoaded, itemsById, requestMode]);

  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.includes(tab)) {
      setTab(visibleTabs[0]);
    }
  }, [tab, visibleTabs]);

  useEffect(() => {
    if (hasActivationDataLoaded && !selectedItems.length) {
      setIsActivationReviewOpen(false);
    }
  }, [hasActivationDataLoaded, selectedItems.length]);

  useEffect(() => {
    if (!isPopupDraftReady) {
      return;
    }

    const draft = buildCurrentPopupDraft();
    latestPopupDraft.current = draft;
    if (!hasPopupDraftContent(draft)) {
      return;
    }

    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
    }
    draftSaveTimer.current = setTimeout(() => {
      void savePopupDraft(draft);
    }, 200);

    return () => {
      if (draftSaveTimer.current) {
        clearTimeout(draftSaveTimer.current);
      }
    };
  }, [
    durationHours,
    isActivationReviewOpen,
    isPopupDraftReady,
    justification,
    search,
    selectedIds,
    sortMode,
    tab,
    ticketNumber,
    ticketSystem,
    requestMode
  ]);

  useEffect(() => {
    if (!isPopupDraftReady) {
      return;
    }

    const saveLatestDraft = () => {
      const draft = latestPopupDraft.current;
      if (draft && hasPopupDraftContent(draft)) {
        void savePopupDraft(draft);
      } else {
        void clearPopupDraft();
      }
    };

    window.addEventListener("pagehide", saveLatestDraft);
    window.addEventListener("beforeunload", saveLatestDraft);
    return () => {
      window.removeEventListener("pagehide", saveLatestDraft);
      window.removeEventListener("beforeunload", saveLatestDraft);
    };
  }, [isPopupDraftReady]);

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

  async function initializePopup() {
    try {
      const draft = await loadPopupDraft();
      if (draft) {
        setTab(draft.tab);
        setSearch(draft.search);
        setSortMode(draft.sortMode);
        setSelectedIds(new Set(draft.selectedIds));
        setDurationHours(draft.durationHours);
        setJustification(draft.justification);
        setTicketSystem(draft.ticketSystem);
        setTicketNumber(draft.ticketNumber);
        setIsActivationReviewOpen(draft.isActivationReviewOpen);
        setRequestMode(draft.requestMode);
        setHasRestoredPopupDraft(true);
      }
    } finally {
      setIsPopupDraftReady(true);
      void refresh({ force: false });
    }
  }

  function buildCurrentPopupDraft(overrides: Partial<PopupDraftInput> = {}): PopupDraftInput {
    return {
      tab,
      search,
      sortMode,
      selectedIds: [...selectedIds],
      durationHours,
      justification,
      ticketSystem,
      ticketNumber,
      isActivationReviewOpen,
      requestMode,
      ...overrides
    };
  }

  async function flushPopupDraft(overrides: Partial<PopupDraftInput> = {}) {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = undefined;
    }
    const draft = buildCurrentPopupDraft(overrides);
    if (hasPopupDraftContent(draft)) {
      latestPopupDraft.current = draft;
      await savePopupDraft(draft);
    } else {
      latestPopupDraft.current = undefined;
      await clearPopupDraft();
    }
  }

  async function clearSelectionAndDraft() {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = undefined;
    }
    setSelectedIds(new Set());
    setIsActivationReviewOpen(false);
    setJustification("");
    setTicketSystem("");
    setTicketNumber("");
    setRequestMode(undefined);
    latestPopupDraft.current = undefined;
    await clearPopupDraft();
  }

  async function refresh(options: { force: boolean; showLoading?: boolean; suppressMessage?: boolean; targets?: AccessSetupTarget[] }) {
    const showBlockingLoading = options.showLoading !== false;
    const shouldShowProgress = !options.suppressMessage;
    if (!options.suppressMessage) {
      setError("");
      setActivationFailureNotice(null);
      setRefreshSuccessKey(0);
      if (refreshSuccessTimer.current) {
        clearTimeout(refreshSuccessTimer.current);
        refreshSuccessTimer.current = undefined;
      }
      setRefreshProgress({
        current: 1,
        total: REFRESH_TOTAL_STEPS,
        label: showBlockingLoading ? "Reading local state" : "Checking local data"
      });
    }
    try {
      const [
        loadedSettings,
        currentCache,
        loadedReferenceData,
        loadedTokens
      ] = await Promise.all([
        loadSettings(),
        loadDataCache(),
        loadReferenceData(),
        sendMessage<TokenStatus>({ action: "getTokenStatus" })
      ]);
      const now = Date.now();
      const tokenCacheKey = buildTokenCacheKey(loadedTokens);
      const enabledRoleFeatures = getEnabledRoleFeatures(loadedSettings);
      const refreshTargets = normalizeRefreshTargets(options.targets || enabledRoleFeatures, enabledRoleFeatures);
      const targetCacheKeys = buildTargetCacheKeys(loadedTokens, enabledRoleFeatures);
      const legacyCacheKey = buildFeatureCacheKey(tokenCacheKey, enabledRoleFeatures);
      const eligibleCache = getTargetEntriesFromCache(currentCache, "eligible", enabledRoleFeatures, targetCacheKeys, {
        legacyCacheKey,
        now,
        freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
      });
      const activeCache = getTargetEntriesFromCache(currentCache, "active", enabledRoleFeatures, targetCacheKeys, {
        legacyCacheKey,
        now,
        freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
      });
      const cachedEligible = mergeTargetEntries(enabledRoleFeatures.map((target) => eligibleCache[target]?.entry), now, legacyCacheKey);
      const cachedActive = mergeTargetEntries(enabledRoleFeatures.map((target) => activeCache[target]?.entry), now, legacyCacheKey);
      const canShowCachedData = !options.force && cachedEligible.items.length > 0;
      if (shouldShowProgress) {
        setRefreshProgress({
          current: 2,
          total: REFRESH_TOTAL_STEPS,
          label: "Checking cache and tokens"
        });
      }

      if (canShowCachedData) {
        await applyLoadedActivationData(loadedSettings, loadedTokens, currentCache, loadedReferenceData, cachedEligible, cachedActive);
        setIsLoading(false);
      } else if (showBlockingLoading) {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      const staleTargets = refreshTargets.filter(
        (target) => options.force || !eligibleCache[target]?.isFresh || !activeCache[target]?.isFresh
      );
      if (shouldShowProgress) {
        setRefreshProgress({
          current: 3,
          total: REFRESH_TOTAL_STEPS,
          label: "Checking what needs refresh"
        });
      }
      if (!staleTargets.length) {
        if (!canShowCachedData) {
          await applyLoadedActivationData(loadedSettings, loadedTokens, currentCache, loadedReferenceData, cachedEligible, cachedActive);
        }
        if (!options.suppressMessage) {
          setMessage("");
        }
        return;
      }

      if (canShowCachedData || !showBlockingLoading) {
        setIsRefreshing(true);
        if (!options.suppressMessage) {
          setMessage("");
        }
      }

      if (shouldShowProgress) {
        setRefreshProgress({
          current: 3,
          total: REFRESH_TOTAL_STEPS,
          label: "Fetching latest data"
        });
      }
      const snapshot = await fetchActivationSnapshot(staleTargets);
      const fetchedAt = Date.now();
      let nextCache = updateCacheFromTargetResults(
        currentCache,
        "eligible",
        staleTargets,
        snapshot.eligibleByTarget || splitActivationResultByTarget(snapshot.eligible, staleTargets),
        fetchedAt,
        targetCacheKeys
      );
      nextCache = updateCacheFromTargetResults(
        nextCache,
        "active",
        staleTargets,
        snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, staleTargets),
        fetchedAt,
        targetCacheKeys
      );

      let nextSettings = loadedSettings;
      if (
        !loadedSettings.preferences.autoEnabledFeaturesInitialized &&
        snapshot.eligible.items.length > 0
      ) {
        nextSettings = {
          ...loadedSettings,
          preferences: {
            ...loadedSettings.preferences,
            enabledFeatures: getAutoEnabledFeatures(
              snapshot.eligible.items,
              loadedSettings.preferences.enabledFeatures?.includes("bundles") !== false
            ),
            autoEnabledFeaturesInitialized: true
          }
        };
        await saveSettings(nextSettings);
      }

      await saveDataCache(nextCache);
      if (shouldShowProgress) {
        setRefreshProgress({
          current: 4,
          total: REFRESH_TOTAL_STEPS,
          label: "Saving refreshed data"
        });
      }
      const nextTargetCacheKeys = buildTargetCacheKeys(loadedTokens, getEnabledRoleFeatures(nextSettings));
      const nextEligibleCache = getTargetEntriesFromCache(nextCache, "eligible", getEnabledRoleFeatures(nextSettings), nextTargetCacheKeys, {
        legacyCacheKey: buildFeatureCacheKey(tokenCacheKey, getEnabledRoleFeatures(nextSettings)),
        now: fetchedAt,
        freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
        usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
      });
      const nextActiveCache = getTargetEntriesFromCache(nextCache, "active", getEnabledRoleFeatures(nextSettings), nextTargetCacheKeys, {
        legacyCacheKey: buildFeatureCacheKey(tokenCacheKey, getEnabledRoleFeatures(nextSettings)),
        now: fetchedAt,
        freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
      });
      const nextEligible = mergeTargetEntries(getEnabledRoleFeatures(nextSettings).map((target) => nextEligibleCache[target]?.entry), fetchedAt);
      const nextActive = mergeTargetEntries(getEnabledRoleFeatures(nextSettings).map((target) => nextActiveCache[target]?.entry), fetchedAt);
      await applyLoadedActivationData(nextSettings, loadedTokens, nextCache, loadedReferenceData, nextEligible, nextActive);
      const nextAccessCapabilities = buildAccessCapabilityItems(loadedTokens, nextCache, getEnabledRoleFeatures(nextSettings));
      const loadErrors = filterLoadErrorsForAccessState([...(snapshot.eligible.errors || []), ...(snapshot.active.errors || [])], nextAccessCapabilities);
      if (!options.suppressMessage) {
        setMessage(formatLoadMessages(loadErrors).join("\n"));
        if (options.force && !loadErrors.length) {
          setRefreshSuccessKey(Date.now());
          refreshSuccessTimer.current = setTimeout(() => {
            setRefreshSuccessKey(0);
            refreshSuccessTimer.current = undefined;
          }, 4_000);
        }
      }
    } catch (loadError) {
      setActivationFailureNotice(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
      setRefreshProgress(null);
    }
  }

  async function applyLoadedActivationData(
    nextSettings: QuickPimSettings,
    nextTokens: TokenStatus,
    nextCache: QuickPimDataCache,
    loadedReferenceData: ReferenceDataCache | undefined,
    eligible: { items: ActivationItem[]; errors: string[] },
    active: { items: ActivationItem[]; errors: string[] }
  ) {
    const nextReferenceData = learnReferenceDataFromItems(loadedReferenceData || await loadReferenceData(), [...eligible.items, ...active.items]);
    await saveReferenceData(nextReferenceData);
    setSettings(nextSettings);
    setTokenStatus(nextTokens);
    setReferenceData(nextReferenceData);
    setAccessCapabilities(buildAccessCapabilityItems(nextTokens, nextCache, getEnabledRoleFeatures(nextSettings)));
    setEligibleItems(applyDisplayData(eligible.items, nextSettings, nextReferenceData));
    setActiveItems(applyDisplayData(active.items, nextSettings, nextReferenceData));
    setHasActivationDataLoaded(true);
  }

  function toggleSelected(itemId: string) {
    setSelectedIds((current) => {
      const item = itemsById.get(itemId);
      const itemMode = getRequestModeForItem(item);
      if (!itemMode || (requestMode && requestMode !== itemMode)) {
        return current;
      }
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      if (!next.size) {
        setRequestMode(undefined);
        setIsActivationReviewOpen(false);
      } else if (!requestMode) {
        setRequestMode(itemMode);
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
      setActivationFailureNotice(null);
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  async function activate(items: ActivationItem[], bundle?: QuickPimBundle) {
    const activatableItems = getActivatableItems(items);
    if (!activatableItems.length) {
      setActivationFailureNotice(null);
      setError(items.length ? "No selected items are currently eligible to activate." : "Select at least one role or group.");
      return;
    }

    const activationRequirements = getActivationRequirements(activatableItems);
    const effectiveJustification = activationRequirements.needsJustification ? bundle?.defaultJustification || justification : "";
    const effectiveDuration = coerceDurationForItems(bundle?.defaultDurationHours || durationHours, activatableItems);
    const effectiveTicketInfo: TicketInfo = {
      ticketSystem: ticketSystem || undefined,
      ticketNumber: ticketNumber || undefined
    };

    if (activationRequirements.needsJustification) {
      if (!effectiveJustification.trim()) {
        setActivationFailureNotice(null);
        setError("Enter a justification or choose a saved one.");
        return;
      }
      const genericJustificationWarning = getGenericJustificationWarning(effectiveJustification);
      if (genericJustificationWarning) {
        setActivationFailureNotice(null);
        setError(genericJustificationWarning);
        return;
      }
    }

    setIsActivating(true);
    setActivationProgress(ACTIVATION_STEPS[0]);
    scrollPopupToTop();
    setError("");
    setActivationFailureNotice(null);
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
      const remainingSelectedIds = getRemainingSelectedIdsAfterActivationResults(selectedIds, response.results);
      setSelectedIds(remainingSelectedIds);
      setActivationProgress(ACTIVATION_STEPS[2]);
      if (response.errors.length) {
        setActivationFailureNotice(buildActivationFailureNotice(response.errors, activatableItems));
      } else {
        setActivationFailureNotice(null);
      }
      if (successItems.length) {
        await refresh({
          force: true,
          showLoading: false,
          suppressMessage: true,
          targets: [...new Set(successItems.map((item) => item.type))]
        });
      }
      if (remainingSelectedIds.size) {
        await flushPopupDraft({ selectedIds: [...remainingSelectedIds], isActivationReviewOpen: true, requestMode: "activate" });
      } else {
        setRequestMode(undefined);
        latestPopupDraft.current = undefined;
        await clearPopupDraft();
      }
      setMessage(formatRequestConfirmation("activation", successItems.length, response.errors.length));
    } catch (activationError) {
      setActivationFailureNotice(null);
      setError(activationError instanceof Error ? activationError.message : String(activationError));
    } finally {
      setActivationProgress(null);
      setIsActivating(false);
    }
  }

  async function deactivate(items: ActivationItem[]) {
    const deactivatableItems = getDeactivatableItems(items);
    if (!deactivatableItems.length) {
      setActivationFailureNotice(null);
      setError(items.length ? "No selected items are currently active." : "Select at least one active role or group.");
      return;
    }

    setIsActivating(true);
    setActivationProgress(DEACTIVATION_STEPS[0]);
    scrollPopupToTop();
    setError("");
    setActivationFailureNotice(null);
    setMessage("");
    try {
      const response = await sendMessage<ActivationResponse>({
        action: "deactivateItems",
        items: deactivatableItems,
        justification,
        ticketInfo: {}
      });
      setActivationProgress(DEACTIVATION_STEPS[1]);
      const successItems = response.results
        .filter((result) => result.success)
        .map((result) => deactivatableItems.find((item) => item.id === result.itemId))
        .filter((item): item is ActivationItem => Boolean(item));

      if (justification.trim()) {
        const updatedSettings = addRecentJustification(settings, justification);
        await saveSettings(updatedSettings);
        setSettings(updatedSettings);
      }

      const remainingSelectedIds = getRemainingSelectedIdsAfterActivationResults(selectedIds, response.results);
      setSelectedIds(remainingSelectedIds);
      setActivationProgress(DEACTIVATION_STEPS[2]);
      if (response.errors.length) {
        setActivationFailureNotice(buildActivationFailureNotice(response.errors, deactivatableItems));
      } else {
        setActivationFailureNotice(null);
      }
      if (successItems.length) {
        await refresh({
          force: true,
          showLoading: false,
          suppressMessage: true,
          targets: [...new Set(successItems.map((item) => item.type))]
        });
      }
      if (remainingSelectedIds.size) {
        await flushPopupDraft({ selectedIds: [...remainingSelectedIds], isActivationReviewOpen: true, requestMode: "deactivate" });
      } else {
        setRequestMode(undefined);
        latestPopupDraft.current = undefined;
        await clearPopupDraft();
      }
      setMessage(formatRequestConfirmation("deactivation", successItems.length, response.errors.length));
    } catch (activationError) {
      setActivationFailureNotice(null);
      setError(activationError instanceof Error ? activationError.message : String(activationError));
    } finally {
      setActivationProgress(null);
      setIsActivating(false);
    }
  }

  async function saveCurrentJustification() {
    const genericJustificationWarning = getGenericJustificationWarning(justification);
    if (genericJustificationWarning) {
      setActivationFailureNotice(null);
      setError(genericJustificationWarning);
      return;
    }
    const updated = addSavedJustification(settings, justification);
    await saveSettings(updated);
    setSettings(updated);
  }

  function useBundleDefaults(bundle: QuickPimBundle) {
    const expansion = expandBundle(bundle, displayItems);
    setRequestMode(expansion.items.length ? "activate" : undefined);
    setSelectedIds(new Set(expansion.items.map((item) => item.id)));
    if (expansion.durationHours) setDurationHours(expansion.durationHours);
    if (expansion.justification) setJustification(expansion.justification);
    setTicketSystem("");
    setTicketNumber("");
    setTab("directoryRole");
  }

  async function openPortalForTarget(target: PopupTab) {
    await flushPopupDraft();
    const url = getPortalUrlForTab(target);
    if (!url) return;
    if (chrome.tabs?.create) {
      void chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  function openPortalForCurrentTab() {
    void openPortalForTarget(tab);
  }

  async function openSettingsSection(section: "access" | "bundles" | "preferences") {
    await flushPopupDraft();
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
  const manualRefreshTargets: AccessSetupTarget[] = currentRoleTab ? [currentRoleTab] : getEnabledRoleFeatures(settings);
  const manualRefreshLabel = currentRoleTab ? `Refresh ${tabLabel(currentRoleTab)} data` : "Refresh enabled data";

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM++</h1>
            <p>
              {isLoading ? null : `${activatableItemCount} eligible items`}
            </p>
          </div>
        </div>
        <div className="status-stack">
          <TokenPill label="Graph" status={tokenStatus?.graph} />
          <TokenPill label="Azure" status={tokenStatus?.azureManagement} />
          <div className="header-actions" aria-label="Popup actions">
            <button
              className={`btn icon-btn refresh-button ${isRefreshing ? "spinning" : ""}`}
              onClick={() => void refresh({ force: true, showLoading: false, targets: manualRefreshTargets })}
              disabled={isLoading || isRefreshing}
              title={manualRefreshLabel}
              aria-label={manualRefreshLabel}
            >
              <RefreshIcon />
              {refreshSuccessKey ? (
                <span className="refresh-success-indicator" key={refreshSuccessKey} aria-label="Refresh completed">
                  <CheckIcon />
                </span>
              ) : null}
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

      {activationFailureNotice ? (
        <ActivationFailureBanner
          notice={activationFailureNotice}
          onOpenPortal={(target) => void openPortalForTarget(target)}
          onOpenAccessSetup={() => void openSettingsSection("access")}
        />
      ) : error ? (
        <p className="message error">{error}</p>
      ) : null}
      {message ? <p className="message">{message}</p> : null}
      {isLoading ? (
        refreshProgress ? <AccessProgressPanel title="Loading access data" progress={refreshProgress} helperText="This can take up to 15 seconds" /> : <LoadingState />
      ) : null}
      {!isLoading && refreshProgress ? <AccessProgressPanel title="Refreshing access data" progress={refreshProgress} /> : null}
      {activationProgress ? <ActivationProgressPanel progress={activationProgress} mode={requestMode || "activate"} /> : null}

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
              requestMode={requestMode}
              showActivationCounters={settings.preferences.showActivationCounters}
              showLastEnablementDate={settings.preferences.showLastEnablementDate}
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
            selectedDirectoryRoleCount={selectedDirectoryRoleCount}
            requestMode={requestMode}
            isReviewOpen={isActivationReviewOpen}
            isActivating={isActivating}
            onContinue={() => setIsActivationReviewOpen(true)}
            onActivate={() => void activate(selectedItems)}
            onDeactivate={() => void deactivate(selectedItems)}
            onSaveJustification={() => void saveCurrentJustification()}
            onClearSelection={() => void clearSelectionAndDraft()}
            onOpenSettings={() => void openSettingsSection("preferences")}
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
          <button className="btn" onClick={() => void openSettingsSection("bundles")}>
            Open settings
          </button>
        </section>
      ) : null}

      {!isLoading && !visibleTabs.length ? (
        <section className="content item-list empty-state">
          <p>No enabled features have data yet. Enable features in Settings or refresh data.</p>
          <button className="btn" onClick={() => void openSettingsSection("preferences")}>
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
        <strong>Some QuickPIM++ data is missing or stale.</strong>
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
      <span>Loading access data (this can take up to 15 seconds)</span>
    </section>
  );
}

function AccessProgressPanel({ title, progress, helperText }: { title: string; progress: LoadingProgress; helperText?: string }) {
  return (
    <section className="activation-progress-panel refresh-progress-panel" aria-live="polite">
      <div className="progress-line">
        <span>{title}</span>
        <span className="progress-fraction">Step {progress.current}/{progress.total}</span>
      </div>
      {helperText ? <p className="progress-helper">{helperText}</p> : null}
      <p className="progress-detail">{progress.label}</p>
      <div className="progress-track" aria-hidden="true">
        <span style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }} />
      </div>
    </section>
  );
}

function ActivationProgressPanel({ progress, mode }: { progress: LoadingProgress; mode: PopupRequestMode }) {
  const label = mode === "deactivate" ? "Deactivation" : "Activation";
  return (
    <section className="activation-progress-panel" aria-live="polite">
      <span className="spinner large" aria-hidden="true" />
      <span>
        {label} in progress (step {progress.current}/{progress.total}): {progress.label}
      </span>
    </section>
  );
}

function ActivationFailureBanner({
  notice,
  onOpenPortal,
  onOpenAccessSetup
}: {
  notice: ActivationFailureNotice;
  onOpenPortal: (target: RoleTab) => void;
  onOpenAccessSetup: () => void;
}) {
  const hasClaimsChallenge = notice.claimsChallengeTargets.length > 0;
  return (
    <section className="message error activation-error-panel" role="alert" aria-live="assertive">
      <div className="activation-error-list">
        {notice.errors.map((errorMessage, index) => (
          <p key={`${index}:${errorMessage}`}>{errorMessage}</p>
        ))}
      </div>
      {hasClaimsChallenge ? (
        <>
          <p className="activation-error-help">
            Complete the Microsoft prompt in the matching portal page, then retry the still-selected item.
          </p>
          <div className="button-row activation-error-actions">
            {notice.claimsChallengeTargets.map((target) => (
              <button className="btn primary" type="button" key={target} onClick={() => onOpenPortal(target)}>
                Open {tabLabel(target)} portal
              </button>
            ))}
            <button className="btn" type="button" onClick={onOpenAccessSetup}>
              Access Setup
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function RoleList({
  items,
  settings,
  referenceData,
  selectedIds,
  favoriteIds,
  requestMode,
  showActivationCounters,
  showLastEnablementDate,
  onToggle,
  onToggleFavorite,
  readonly = false
}: {
  items: ActivationItem[];
  settings: QuickPimSettings;
  referenceData?: ReferenceDataCache;
  selectedIds: Set<string>;
  favoriteIds: Set<string>;
  requestMode?: PopupRequestMode;
  showActivationCounters: boolean;
  showLastEnablementDate: boolean;
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
        const itemMode = getRequestModeForItem(item);
        const isActionable = !readonly && Boolean(itemMode);
        const isSelectable = Boolean(isActionable && (!requestMode || requestMode === itemMode));
        const selected = isSelectable && selectedIds.has(item.id);
        const displayName = getDisplayName(item, settings, referenceData);
        const isFavorite = favoriteIds.has(item.id);
        const statusTitle = getActivationStatusTitle(item);
        const lastEnabledDate = showLastEnablementDate ? formatDateOnly(usage.lastUsedAt) : "";
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
            </div>
            <div className="role-status-stack">
              {showActivationCounters ? (
                <span className="activation-count" title={`${usage.activationCount} activation${usage.activationCount === 1 ? "" : "s"}`}>
                  {usage.activationCount}
                </span>
              ) : null}
              <span className={`badge status-badge ${item.status}`} title={statusTitle}>
                {formatActivationStatusLabel(item.status)}
              </span>
            </div>
          </>
        );

        if (!isActionable) {
          return (
            <div className={`role-row readonly ${item.status === "active" ? "active-row" : item.status === "pendingApproval" ? "pending-row" : ""}`} key={item.id}>
              {body}
            </div>
          );
        }

        return (
          <div
            className={`role-row selectable ${selected ? "selected" : ""} ${!isSelectable ? "disabled" : ""} ${item.status === "active" ? "active-row" : ""}`}
            key={item.id}
            onClick={() => {
              if (isSelectable) {
                onToggle?.(item.id);
              }
            }}
            title={!isSelectable && requestMode ? `Clear the current selection to ${itemMode === "activate" ? "activate" : "deactivate"} this item.` : undefined}
          >
            <input
              type="checkbox"
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
  selectedDirectoryRoleCount: number;
  requestMode?: PopupRequestMode;
  isReviewOpen: boolean;
  isActivating: boolean;
  onContinue: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onSaveJustification: () => void;
  onClearSelection: () => void;
  onOpenSettings: () => void;
}) {
  const [isSavedListOpen, setIsSavedListOpen] = useState(false);
  const hasSelection = props.selectedCount > 0;
  const isDeactivateMode = props.requestMode === "deactivate";
  const isActivateMode = props.requestMode !== "deactivate";
  const savedJustifications = props.settings.savedJustifications;
  const savedLookup = new Set(savedJustifications.map((item) => item.toLowerCase()));
  const recentJustifications = props.settings.recentJustifications.filter((item) => !savedLookup.has(item.toLowerCase()));
  const showJustificationField = isDeactivateMode || props.requirements.needsJustification;
  const showJustificationShortcuts = showJustificationField && (recentJustifications.length > 0 || savedJustifications.length > 0);
  const selectedDuration = props.durationOptions.some((option) => option.value === props.durationHours)
    ? props.durationHours
    : props.durationOptions[0]?.value;

  useEffect(() => {
    if (!hasSelection || !props.isReviewOpen || !showJustificationField || !savedJustifications.length) {
      setIsSavedListOpen(false);
    }
  }, [hasSelection, props.isReviewOpen, showJustificationField, savedJustifications.length]);

  return (
    <section className="activation-bar">
      {hasSelection && !props.isReviewOpen ? (
        <div className="button-row">
          <button className="btn primary" onClick={props.onContinue} disabled={props.isActivating}>
            Continue
          </button>
          <button className="btn subtle" onClick={props.onClearSelection} disabled={props.isActivating}>
            Unselect all
          </button>
          <button className="btn" onClick={props.onOpenSettings}>
            Settings
          </button>
        </div>
      ) : null}
      {hasSelection && props.isReviewOpen && isActivateMode && props.selectedDirectoryRoleCount > 4 ? (
        <div className="practice-warning" role="status">
          <strong>Select only what you need.</strong>
          <span>
            PIM works best when roles are activated only for a specific need. Selecting many Entra roles by default reduces the value of just-in-time access.
          </span>
        </div>
      ) : null}
      {hasSelection && props.isReviewOpen && isActivateMode && props.durationOptions.length ? (
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
      {hasSelection && props.isReviewOpen && showJustificationField ? (
        <div className="field activation-form-field">
          <div className="justification-label-row">
            <label>
              {isDeactivateMode ? "Optional note" : "Justification"} {props.requirements.needsJustification ? <span className="required-marker" aria-label="required">*</span> : null}
            </label>
            <button
              className="btn icon-btn save-justification-button"
              onClick={props.onSaveJustification}
              disabled={!props.justification.trim()}
              title="Save this justification for reuse"
              aria-label="Save justification"
            >
              <SaveIcon />
            </button>
          </div>
          <textarea
            className="textarea justification-textarea"
            rows={2}
            value={props.justification}
            onChange={(event) => props.setJustification(event.target.value)}
            placeholder={isDeactivateMode ? "Why are you disabling this access early?" : "Why do you need this activation?"}
          />
        </div>
      ) : null}
      {hasSelection && props.isReviewOpen && showJustificationShortcuts ? (
        <div className="justification-shortcuts">
          <div className="chip-row justification-recent-row">
            {recentJustifications.slice(0, 3).map((item) => (
              <button className="justification-chip" key={`recent:${item}`} onClick={() => props.setJustification(item)}>
                {item}
              </button>
            ))}
            {savedJustifications.length ? (
              <button
                className="btn saved-justification-toggle"
                type="button"
                onClick={() => setIsSavedListOpen((value) => !value)}
                aria-expanded={isSavedListOpen}
                aria-controls="saved-justification-list"
              >
                Saved
              </button>
            ) : null}
          </div>
          {isSavedListOpen ? (
            <div className="saved-justification-menu" id="saved-justification-list" aria-label="Saved justifications">
              {savedJustifications.map((item) => (
                <button
                  className="saved-justification-option"
                  type="button"
                  key={`saved:${item}`}
                  onClick={() => {
                    props.setJustification(item);
                    setIsSavedListOpen(false);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {hasSelection && props.isReviewOpen && isActivateMode && props.requirements.needsTicket ? (
        <div className="activation-grid">
          <input className="input" value={props.ticketSystem} onChange={(event) => props.setTicketSystem(event.target.value)} placeholder="Ticket system" />
          <input className="input" value={props.ticketNumber} onChange={(event) => props.setTicketNumber(event.target.value)} placeholder="Ticket number" />
        </div>
      ) : null}
      {props.isReviewOpen || !hasSelection ? (
        <div className="button-row">
          {hasSelection && props.isReviewOpen ? (
            <button className="btn primary" onClick={isDeactivateMode ? props.onDeactivate : props.onActivate} disabled={props.isActivating}>
              {props.isActivating
                ? isDeactivateMode ? "Disabling..." : "Activating..."
                : isDeactivateMode ? `Disable ${props.selectedCount} selected` : `Activate ${props.selectedCount} selected`}
            </button>
          ) : null}
          {hasSelection ? (
            <button className="btn subtle" onClick={props.onClearSelection} disabled={props.isActivating}>
              Unselect all
            </button>
          ) : null}
          <button className="btn" onClick={props.onOpenSettings}>
            Settings
          </button>
        </div>
      ) : null}
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="refresh-success-icon">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="button-icon save-icon">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
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

function formatRequestConfirmation(requestType: "activation" | "deactivation", successCount: number, errorCount: number): string {
  const itemLabel = (count: number) => `item${count === 1 ? "" : "s"}`;
  const noun = requestType === "deactivation" ? "Deactivation" : "Activation";
  if (successCount && !errorCount) {
    return `${noun} request submitted for ${successCount} ${itemLabel(successCount)}.`;
  }
  if (successCount && errorCount) {
    return `${noun} request submitted for ${successCount} ${itemLabel(successCount)}; ${errorCount} failed.`;
  }
  return `${noun} failed for ${errorCount} ${itemLabel(errorCount)}.`;
}

function scrollPopupToTop(): void {
  const scrollingElement = document.scrollingElement || document.documentElement;
  if (typeof scrollingElement.scrollTo === "function") {
    scrollingElement.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  scrollingElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function normalizeRefreshTargets(targets: AccessSetupTarget[], enabledRoleFeatures: AccessSetupTarget[]): AccessSetupTarget[] {
  const enabled = new Set(enabledRoleFeatures);
  return targets.filter((target, index) => enabled.has(target) && targets.indexOf(target) === index);
}

function getRequestModeForItem(item: ActivationItem | undefined): PopupRequestMode | undefined {
  if (item?.status === "eligible") {
    return "activate";
  }
  if (item?.status === "active") {
    return "deactivate";
  }
  return undefined;
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
  const testWindow = window as Window & { __quickPimPopupUnmount?: () => void };
  if (isTestRuntime()) {
    testWindow.__quickPimPopupUnmount?.();
  }
  const root = createRoot(rootElement);
  root.render(<PopupApp />);
  if (isTestRuntime()) {
    testWindow.__quickPimPopupUnmount = () => root.unmount();
  }
}
