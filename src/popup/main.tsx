import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  hasRequiredPortalToken,
  type AccessCapabilityItem
} from "../lib/access";
import { filterLoadErrorsForAccessState } from "../lib/accessMessages";
import {
  coerceDurationForItems,
  filterAssignedActiveItems,
  formatActivationItemStatusLabel,
  formatRemainingActivationTime,
  formatLoadMessages,
  getActivationRequirements,
  getActivationStatusTitle,
  getActivatableItems,
  applyQuickFilters,
  getDeactivatableItems,
  getBundlePreflight,
  getDurationOptions,
  getEffectiveActiveAssignmentType,
  getRemainingActivationTimeUpdateDelay,
  getRemainingSelectedIdsAfterActivationResults,
  isHighPrivilegeItem,
  getRowActionState,
  getRowPolicySummary,
  shouldShowRemainingActivationTime,
  mergeEligibleWithActive,
  getPortalUrlForTab,
  tabLabel,
  tokenStatusText,
  tokenStatusTone,
  type QuickFilter,
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
  recordActivityResults,
  recordActivations,
  saveSettings,
  sortItems
} from "../lib/settings";
import {
  learnReferenceDataFromItems,
  loadReferenceData,
  saveReferenceData
} from "../lib/referenceData";
import { MAX_USER_JUSTIFICATION_LENGTH, getGenericJustificationWarning } from "../lib/justifications";
import { getPortalTokenRecoveryTargets } from "../lib/portalTokenRefresh";
import {
  getPortalRecoveryTokenSignature,
  hasPortalRecoveryTokenChanged,
  sanitizePortalRecoveryStatus
} from "../lib/portalRecoveryTabs";
import { isOperationTimeoutError } from "../lib/async";
import { sendRuntimeMessage } from "../lib/runtimeMessaging";
import {
  getAccessRecoveryTargets,
  mergeRetriedActivationResponse,
  replaceAccessRecoveryErrors
} from "../lib/requestRecovery";
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
  RequestOperationRecord,
  QuickPimSettings,
  PopupRequestMode,
  PortalRecoveryFocusResult,
  PortalRecoveryOpenResult,
  PortalRecoveryStatus,
  PortalTokenRefreshResult,
  SortMode,
  TicketInfo,
  TokenStatus
} from "../lib/types";

interface ActivationFailureNotice {
  errors: string[];
  claimsChallengeTargets: RoleTab[];
}

const ACTIVATION_STEPS: readonly ProgressStepDefinition[] = [
  { id: "request", label: "Sending activation request", weight: 20, expectedDurationMs: 20_000 },
  { id: "record", label: "Saving activation result", weight: 2, expectedDurationMs: 2_000 },
  { id: "refresh", label: "Refreshing activation status", weight: 6, expectedDurationMs: 8_000 }
];
const DEACTIVATION_STEPS: readonly ProgressStepDefinition[] = [
  { id: "request", label: "Sending deactivation request", weight: 20, expectedDurationMs: 20_000 },
  { id: "record", label: "Saving deactivation result", weight: 2, expectedDurationMs: 2_000 },
  { id: "refresh", label: "Refreshing deactivation status", weight: 6, expectedDurationMs: 8_000 }
];
const REFRESH_LOCAL_STEP: ProgressStepDefinition = {
  id: "local",
  label: "Reading local state",
  weight: 1.2,
  expectedDurationMs: 1_200
};
const REFRESH_ACCESS_STEP: ProgressStepDefinition = {
  id: "access",
  label: "Checking cache and portal access",
  weight: 1.8,
  expectedDurationMs: 1_800
};
const REFRESH_PORTAL_STEP: ProgressStepDefinition = {
  id: "portal",
  label: "Recovering Microsoft portal access",
  weight: 15,
  expectedDurationMs: 15_000
};
const REFRESH_SOURCES_STEP: ProgressStepDefinition = {
  id: "sources",
  label: "Refreshing role sources in parallel",
  weight: 12,
  expectedDurationMs: 12_000
};
const REFRESH_SAVE_STEP: ProgressStepDefinition = {
  id: "save",
  label: "Saving refreshed data",
  weight: 1.5,
  expectedDurationMs: 1_500
};
const TOKEN_STATUS_TIMEOUT_MS = 8_000;
const PORTAL_TOKEN_REFRESH_TIMEOUT_MS = 17_000;
const PORTAL_RECOVERY_WAIT_TIMEOUT_MS = 15_000;
const PORTAL_RECOVERY_POLL_INTERVAL_MS = 750;
const PORTAL_RECOVERY_BACKGROUND_POLL_INTERVAL_MS = 1_000;
const ACTIVATION_SNAPSHOT_TIMEOUT_MS = 25_000;
const ACTIVATION_REQUEST_TIMEOUT_MS = 180_000;
const REQUEST_TOKEN_MIN_VALIDITY_MS = 5 * 60_000;
const REQUEST_OPERATION_POLL_INTERVAL_MS = 750;

function createRequestOperationId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `request_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

function buildRefreshProgressSteps(includePortalRecovery: boolean): readonly ProgressStepDefinition[] {
  return includePortalRecovery
    ? [REFRESH_LOCAL_STEP, REFRESH_ACCESS_STEP, REFRESH_PORTAL_STEP, REFRESH_SOURCES_STEP, REFRESH_SAVE_STEP]
    : [REFRESH_LOCAL_STEP, REFRESH_ACCESS_STEP, REFRESH_SOURCES_STEP, REFRESH_SAVE_STEP];
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

async function waitForManagedPortalRecovery(
  targets: AccessSetupTarget[],
  baselineTokens: TokenStatus,
  isCurrentRun: () => boolean
): Promise<{ tokens: TokenStatus; changedTargets: AccessSetupTarget[]; recoveryStatus: PortalRecoveryStatus }> {
  const baselineSignatures = Object.fromEntries(
    targets.map((target) => [target, getPortalRecoveryTokenSignature(baselineTokens, target)])
  ) as Partial<Record<AccessSetupTarget, string>>;
  let latestTokens = baselineTokens;
  let changedTargets: AccessSetupTarget[] = [];
  let recoveryStatus = emptyPortalRecoveryStatus();
  const deadline = Date.now() + PORTAL_RECOVERY_WAIT_TIMEOUT_MS;

  while (isCurrentRun() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PORTAL_RECOVERY_POLL_INTERVAL_MS));
    try {
      const [nextTokens, nextRecoveryStatus] = await Promise.all([
        sendMessage<TokenStatus>(
          { action: "getTokenStatus" },
          { timeoutMs: 2_500, timeoutMessage: "Waiting for Microsoft portal access timed out." }
        ),
        readPortalRecoveryStatus()
      ]);
      latestTokens = nextTokens;
      recoveryStatus = nextRecoveryStatus;
    } catch {
      continue;
    }
    changedTargets = targets.filter((target) =>
      hasPortalRecoveryTokenChanged(target, baselineSignatures[target], latestTokens)
    );
    if (changedTargets.length === targets.length) {
      break;
    }
    if (recoveryStatus.state === "interactionRequired") {
      break;
    }
  }

  if (changedTargets.length !== targets.length && recoveryStatus.state !== "interactionRequired") {
    recoveryStatus = await readPortalRecoveryStatus();
  }
  return { tokens: latestTokens, changedTargets, recoveryStatus };
}

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

function hasRequestReadyPortalToken(target: AccessSetupTarget, tokenStatus: TokenStatus, now = Date.now()): boolean {
  if (!hasRequiredPortalToken(target, tokenStatus)) {
    return false;
  }
  const token = target === "azureRole"
    ? tokenStatus.azureManagement
    : tokenStatus.graphTargets?.[target] || tokenStatus.graph;
  const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.NaN;
  return !Number.isFinite(expiresAt) || expiresAt > now + REQUEST_TOKEN_MIN_VALIDITY_MS;
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
  const [portalRecoveryStatus, setPortalRecoveryStatus] = useState<PortalRecoveryStatus>(() => emptyPortalRecoveryStatus());
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [quickFilters, setQuickFilters] = useState<Set<QuickFilter>>(new Set());
  const [durationHours, setDurationHours] = useState(DEFAULT_SETTINGS.preferences.defaultDurationHours);
  const [justification, setJustification] = useState("");
  const [ticketSystem, setTicketSystem] = useState("");
  const [ticketNumber, setTicketNumber] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<OperationProgress | null>(null);
  const [refreshSuccessKey, setRefreshSuccessKey] = useState(0);
  const [isActivationReviewOpen, setIsActivationReviewOpen] = useState(false);
  const [activationProgress, setActivationProgress] = useState<OperationProgress | null>(null);
  const [activationFailureNotice, setActivationFailureNotice] = useState<ActivationFailureNotice | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  const [requestMode, setRequestMode] = useState<PopupRequestMode | undefined>();
  const [isPopupDraftReady, setIsPopupDraftReady] = useState(false);
  const [hasRestoredPopupDraft, setHasRestoredPopupDraft] = useState(false);
  const [hasActivationDataLoaded, setHasActivationDataLoaded] = useState(false);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSuccessTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshProgressClearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestProgressClearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshRunId = useRef(0);
  const activeRefreshRunId = useRef<number | undefined>(undefined);
  const requestProgressRunId = useRef(0);
  const activationRequestInFlight = useRef(false);
  const ownedRequestOperationIds = useRef(new Set<string>());
  const reconciledRequestOperationIds = useRef(new Set<string>());
  const latestPopupDraft = useRef<PopupDraftInput | undefined>(undefined);
  const settingsMutationQueue = useRef<Promise<void>>(Promise.resolve());

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
    if (refreshProgressClearTimer.current) {
      clearTimeout(refreshProgressClearTimer.current);
    }
    if (requestProgressClearTimer.current) {
      clearTimeout(requestProgressClearTimer.current);
    }
  }, []);

  const displayItems = useMemo(
    () => filterAssignedActiveItems(
      mergeEligibleWithActive(eligibleItems, activeItems, { includeActiveOnly: true }),
      settings.preferences.showAssignedRoles
    ),
    [activeItems, eligibleItems, settings.preferences.showAssignedRoles]
  );
  const activatableItemCount = useMemo(() => getActivatableItems(displayItems).length, [displayItems]);
  const itemsById = useMemo(() => new Map(
    displayItems.flatMap((item) => [[item.id, item] as const, [item.id.toLowerCase(), item] as const])
  ), [displayItems]);
  const enabledFeatures = useMemo(() => new Set<QuickPimFeature>(settings.preferences.enabledFeatures || []), [settings.preferences.enabledFeatures]);
  const enabledRoleFeatures = useMemo(() => getEnabledRoleFeatures(settings), [settings.preferences.enabledFeatures]);
  const itemTypesWithData = useMemo(() => new Set(displayItems.map((item) => item.type)), [displayItems]);
  const roleTabs = useMemo<RoleTab[]>(
    () =>
      (["directoryRole", "pimGroup", "azureRole"] as RoleTab[]).filter(
        (roleTab) => enabledFeatures.has(roleTab) && (isLoading || isRefreshing || itemTypesWithData.has(roleTab))
      ),
    [enabledFeatures, isLoading, isRefreshing, itemTypesWithData]
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
      const items = [...selectedIds].map((id) => getItemByPersistedId(itemsById, id)).filter((item): item is ActivationItem => Boolean(item));
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
  const showInitialAccessState = hasActivationDataLoaded
    && !isLoading
    && !isRefreshing
    && displayItems.length === 0
    && enabledRoleFeatures.length > 0
    && accessSetupTargets.length > 0;
  const showPermissionWarning = useMemo(
    () => hasActivationDataLoaded
      && tokenStatus !== null
      && !settings.preferences.permissionWarningIgnored
      && accessSetupTargets.length > 0
      && !showInitialAccessState,
    [accessSetupTargets.length, hasActivationDataLoaded, settings, showInitialAccessState, tokenStatus]
  );

  useEffect(() => {
    if (
      portalRecoveryStatus.state === "idle"
      || activeRefreshRunId.current !== undefined
      || isLoading
      || isRefreshing
      || !enabledRoleFeatures.length
    ) {
      return;
    }

    let active = true;
    const pollRecovery = async () => {
      const nextStatus = await readPortalRecoveryStatus();
      if (!active) {
        return;
      }
      setPortalRecoveryStatus(nextStatus);
      if (nextStatus.state === "idle" && activeRefreshRunId.current === undefined) {
        void refresh({
          force: false,
          showLoading: false,
          targets: enabledRoleFeatures,
          recoverMissingPortalAccess: false
        });
      }
    };
    const timer = window.setInterval(() => void pollRecovery(), PORTAL_RECOVERY_BACKGROUND_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabledRoleFeatures.join("|"), isLoading, isRefreshing, portalRecoveryStatus.state]);

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
      const mode = requestMode || getRequestModeForItem(
        [...current].map((id) => getItemByPersistedId(itemsById, id)).find(Boolean)
      );
      const next = new Set<string>();
      for (const id of current) {
        const item = getItemByPersistedId(itemsById, id);
        if (item && (mode ? getRequestModeForItem(item) === mode : Boolean(getRequestModeForItem(item)))) {
          next.add(item.id);
        }
      }
      if (!next.size && current.size) {
        if (draftSaveTimer.current) {
          clearTimeout(draftSaveTimer.current);
          draftSaveTimer.current = undefined;
        }
        setRequestMode(undefined);
        setIsActivationReviewOpen(false);
      }
      if (next.size && !requestMode && mode) {
        setRequestMode(mode);
      }
      return setsEqual(current, next) ? current : next;
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
      void clearPopupDraft();
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
    quickFilters,
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

  useEffect(() => {
    if (!isPopupDraftReady) {
      return;
    }

    let active = true;
    let timer: number | undefined;
    const schedule = () => {
      if (active) {
        timer = window.setTimeout(() => void poll(), REQUEST_OPERATION_POLL_INTERVAL_MS);
      }
    };
    const poll = async () => {
      try {
        const operations = await sendMessage<RequestOperationRecord[]>(
          { action: "getRequestOperations" },
          { timeoutMs: 3_000, timeoutMessage: "Background request status check timed out." }
        );
        if (!active) {
          return;
        }
        if (!Array.isArray(operations)) {
          return;
        }
        const operation = operations.find((item) =>
          !ownedRequestOperationIds.current.has(item.id)
          && !reconciledRequestOperationIds.current.has(item.id)
        );
        if (!operation) {
          return;
        }

        if (operation.state === "running") {
          activationRequestInFlight.current = true;
          setIsActivating(true);
          setRequestMode(operation.action);
          setIsActivationReviewOpen(true);
          if (operation.durationHours !== undefined) {
            setDurationHours(operation.durationHours);
          }
          if (operation.justification !== undefined) {
            setJustification(operation.justification);
          }
          setSelectedIds((current) => {
            const next = new Set(current);
            operation.itemIds.forEach((id) => {
              const item = getItemByPersistedId(itemsById, id);
              if (item) next.add(item.id);
            });
            return setsEqual(current, next) ? current : next;
          });
          setActivationProgress((current) => {
            const progressId = `background-${operation.id}`;
            if (current?.operationId === progressId) {
              return current;
            }
            const steps = operation.action === "activate" ? ACTIVATION_STEPS : DEACTIVATION_STEPS;
            return advanceOperationProgress(createOperationProgress(progressId, steps), 1, {
              label: "Request continues in the background"
            });
          });
          return;
        }

        if (!hasActivationDataLoaded) {
          return;
        }
        reconciledRequestOperationIds.current.add(operation.id);
        await reconcileDetachedRequestOperation(operation);
      } catch {
        // A short-lived service-worker wake-up must not disturb the current popup state.
      } finally {
        schedule();
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [hasActivationDataLoaded, isPopupDraftReady, itemsById]);

  const visibleEligibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = displayItems.filter((item) => {
      const matchesType = item.type === tab;
      const name = getDisplayName(item, settings, referenceData).toLowerCase();
      const scope = getScopeLabel(item, referenceData).toLowerCase();
      return matchesType && (!term || name.includes(term) || scope.includes(term));
    });
    const quickFiltered = applyQuickFilters(filtered, [...quickFilters], favoriteIds);
    return sortItems(quickFiltered, settings, sortMode, referenceData);
  }, [displayItems, favoriteIds, quickFilters, referenceData, search, settings, sortMode, tab]);

  function toggleQuickFilter(filter: QuickFilter) {
    setQuickFilters((current) => {
      const next = new Set(current);
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }
      return next;
    });
  }

  async function initializePopup() {
    try {
      const draft = await loadPopupDraft();
      if (draft) {
        setTab(draft.tab);
        setSearch(draft.search);
        setSortMode(draft.sortMode);
        setQuickFilters(new Set(draft.quickFilters));
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
      quickFilters: [...quickFilters],
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
    setActivationProgress(null);
    latestPopupDraft.current = undefined;
    await clearPopupDraft();
  }

  async function refresh(options: {
    force: boolean;
    showLoading?: boolean;
    suppressMessage?: boolean;
    targets?: AccessSetupTarget[];
    recoverMissingPortalAccess?: boolean;
  }) {
    const refreshStartedAt = Date.now();
    const runId = ++refreshRunId.current;
    activeRefreshRunId.current = runId;
    const isCurrentRun = () => refreshRunId.current === runId;
    const showBlockingLoading = options.showLoading !== false;
    const shouldShowProgress = !options.suppressMessage;
    let refreshSteps = buildRefreshProgressSteps(false);
    let liveProgress: OperationProgress | null = null;
    let refreshCompleted = false;

    const showProgressStep = (
      current: number,
      label: string,
      steps: readonly ProgressStepDefinition[] = refreshSteps
    ) => {
      if (!shouldShowProgress || !liveProgress) {
        return;
      }
      refreshSteps = steps;
      liveProgress = advanceOperationProgress(liveProgress, current, { label, steps });
      setRefreshProgress(liveProgress);
    };
    const showProgressError = (detail: string, label?: string) => {
      setError(detail);
      setMessage("");
      if (shouldShowProgress && liveProgress) {
        liveProgress = failOperationProgress(liveProgress, detail, label);
        setRefreshProgress(liveProgress);
      }
    };
    const showProgressComplete = (label: string) => {
      refreshCompleted = true;
      if (shouldShowProgress && liveProgress) {
        liveProgress = completeOperationProgress(liveProgress, label);
        setRefreshProgress(liveProgress);
      }
    };

    if (shouldShowProgress) {
      setError("");
      setActivationFailureNotice(null);
      setActivationProgress(null);
      setRefreshSuccessKey(0);
      if (refreshProgressClearTimer.current) {
        clearTimeout(refreshProgressClearTimer.current);
        refreshProgressClearTimer.current = undefined;
      }
      if (refreshSuccessTimer.current) {
        clearTimeout(refreshSuccessTimer.current);
        refreshSuccessTimer.current = undefined;
      }
      liveProgress = createOperationProgress(`refresh-${runId}`, refreshSteps, {
        label: showBlockingLoading ? "Reading local state" : "Checking local data"
      });
      setRefreshProgress(liveProgress);
    }
    try {
      const [
        loadedSettings,
        currentCache,
        loadedReferenceData,
        loadedTokens,
        loadedRecoveryStatus
      ] = await Promise.all([
        loadSettings(),
        loadDataCache(),
        loadReferenceData(),
        sendMessage<TokenStatus>(
          { action: "getTokenStatus" },
          { timeoutMs: TOKEN_STATUS_TIMEOUT_MS, timeoutMessage: "Token status check timed out. Cached role data remains available." }
        ),
        readPortalRecoveryStatus()
      ]);
      if (!isCurrentRun()) {
        return;
      }

      const now = Date.now();
      const enabledRoleFeatures = getEnabledRoleFeatures(loadedSettings);
      const refreshTargets = normalizeRefreshTargets(options.targets || enabledRoleFeatures, enabledRoleFeatures);
      setSettings(loadedSettings);
      setTokenStatus(loadedTokens);
      setPortalRecoveryStatus(loadedRecoveryStatus);
      setReferenceData(loadedReferenceData);
      setAccessCapabilities(buildAccessCapabilityItems(loadedTokens, currentCache, enabledRoleFeatures));
      const initialCacheView = getActivationCacheView(currentCache, loadedTokens, enabledRoleFeatures, now);
      let currentCacheView = initialCacheView;
      let progressiveCache = currentCache;
      let progressiveTokens = loadedTokens;
      let progressiveReferenceData = learnReferenceDataFromItems(
        loadedReferenceData,
        [...initialCacheView.eligible.items, ...initialCacheView.active.items]
      );
      const canShowCachedData = !options.force && (
        initialCacheView.eligible.items.length > 0 || initialCacheView.active.items.length > 0
      );

      if (canShowCachedData) {
        renderLoadedActivationData(
          loadedSettings,
          loadedTokens,
          currentCache,
          progressiveReferenceData,
          initialCacheView.eligible,
          initialCacheView.active
        );
        setIsLoading(false);
      } else if (showBlockingLoading) {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      let staleTargets = refreshTargets.filter(
        (target) => options.force || !initialCacheView.eligibleCache[target]?.isFresh || !initialCacheView.activeCache[target]?.isFresh
      );
      const portalTokenRecoveryTargets = getPortalTokenRecoveryTargets({
        cache: currentCache,
        enabledTargets: refreshTargets,
        staleTargets,
        tokenStatus: loadedTokens,
        force: options.force,
        now
      });
      refreshSteps = buildRefreshProgressSteps(portalTokenRecoveryTargets.length > 0);
      showProgressStep(
        2,
        portalTokenRecoveryTargets.length
          ? "Checking cache and Microsoft portal access"
          : "Checking cache and token status",
        refreshSteps
      );
      const portalProgressStep = portalTokenRecoveryTargets.length ? 3 : undefined;
      const sourceProgressStep = portalTokenRecoveryTargets.length ? 4 : 3;
      const saveProgressStep = refreshSteps.length;
      let managedPortalRecoveryCompleted = false;
      if (options.recoverMissingPortalAccess && portalTokenRecoveryTargets.length) {
        showProgressStep(
          portalProgressStep!,
          `Opening Microsoft portal access for ${portalTokenRecoveryTargets.map(tabLabel).join(", ")}`
        );
        const recovery = await openPortalPagesForTargets(portalTokenRecoveryTargets);
        if (!isCurrentRun()) {
          return;
        }
        if (!recovery.managedCount) {
          setHasActivationDataLoaded(true);
          showProgressError(
            "Microsoft portal pages could not be opened. Use Access Setup for details.",
            "Microsoft portal access could not be opened"
          );
          return;
        }
        setPortalRecoveryStatus(await readPortalRecoveryStatus());
        showProgressStep(portalProgressStep!, "Waiting for Microsoft portal access");
        const recovered = await waitForManagedPortalRecovery(portalTokenRecoveryTargets, loadedTokens, isCurrentRun);
        if (!isCurrentRun()) {
          return;
        }
        setPortalRecoveryStatus(recovered.recoveryStatus);
        if (recovered.recoveryStatus.state === "interactionRequired") {
          progressiveTokens = recovered.tokens;
          setTokenStatus(progressiveTokens);
          setAccessCapabilities(buildAccessCapabilityItems(progressiveTokens, currentCache, enabledRoleFeatures));
          setHasActivationDataLoaded(true);
          setError("");
          setMessage("");
          return;
        }
        if (recovered.changedTargets.length !== portalTokenRecoveryTargets.length) {
          setHasActivationDataLoaded(true);
          showProgressError(
            `Microsoft portal access was not captured in time${recovery.grouped ? " from the QuickPIM++ access refresh group" : ""}. Expand it only if Microsoft requires sign-in or another prompt.`,
            "Waiting for Microsoft portal access timed out"
          );
          return;
        }
        progressiveTokens = recovered.tokens;
        setTokenStatus(progressiveTokens);
        setAccessCapabilities(buildAccessCapabilityItems(progressiveTokens, currentCache, enabledRoleFeatures));
        currentCacheView = getActivationCacheView(currentCache, progressiveTokens, enabledRoleFeatures, Date.now());
        staleTargets = refreshTargets.filter(
          (target) => options.force || !currentCacheView.eligibleCache[target]?.isFresh || !currentCacheView.activeCache[target]?.isFresh
        );
        managedPortalRecoveryCompleted = true;
      }

      if (portalTokenRecoveryTargets.length && !managedPortalRecoveryCompleted) {
        setIsRefreshing(true);
        showProgressStep(portalProgressStep!, "Checking existing Microsoft portal tabs");
        try {
          const tokenRefresh = await sendMessage<PortalTokenRefreshResult>(
            { action: "refreshPortalTokens" },
            { timeoutMs: PORTAL_TOKEN_REFRESH_TIMEOUT_MS, timeoutMessage: "Portal token scan timed out. Continuing with the currently captured tokens." }
          );
          if (!isCurrentRun()) {
            return;
          }
          progressiveTokens = tokenRefresh.tokenStatus;
          setTokenStatus(progressiveTokens);
          setAccessCapabilities(buildAccessCapabilityItems(progressiveTokens, currentCache, enabledRoleFeatures));
          currentCacheView = getActivationCacheView(currentCache, progressiveTokens, enabledRoleFeatures, Date.now());
          staleTargets = refreshTargets.filter(
            (target) => options.force || !currentCacheView.eligibleCache[target]?.isFresh || !currentCacheView.activeCache[target]?.isFresh
          );
        } catch {
          // Existing tokens and cached data remain usable when no portal tab can answer the optional scan.
        }
      }
      showProgressStep(
        sourceProgressStep,
        staleTargets.length
          ? `Fetching latest data from ${staleTargets.length} role source${staleTargets.length === 1 ? "" : "s"} in parallel`
          : "Role data is already current"
      );
      if (!staleTargets.length) {
        if (!canShowCachedData) {
          renderLoadedActivationData(
            loadedSettings,
            progressiveTokens,
            currentCache,
            progressiveReferenceData,
            currentCacheView.eligible,
            currentCacheView.active
          );
        }
        setHasActivationDataLoaded(true);
        if (!options.suppressMessage) {
          setMessage("");
        }
        showProgressStep(saveProgressStep, "Finalizing current data");
        showProgressComplete("Access data is current");
        return;
      }

      setIsRefreshing(true);
      if (!options.suppressMessage) {
        setMessage("");
      }

      const preferredTarget = staleTargets[0];
      const eligibleResultsByTarget: Partial<Record<AccessSetupTarget, ActivationSnapshot["eligible"]>> = {};
      const activeResultsByTarget: Partial<Record<AccessSetupTarget, ActivationSnapshot["active"]>> = {};
      const successfulRefreshTargets = new Set<AccessSetupTarget>();
      const transportErrors: string[] = [];
      const cachePersistence: Promise<void>[] = [];
      let completedTargets = 0;

      await Promise.all(staleTargets.map(async (target) => {
        let targetSucceeded = false;
        try {
          const snapshot = await fetchActivationSnapshot([target]);
          if (!isCurrentRun()) {
            return;
          }

          const fetchedAt = Date.now();
          progressiveTokens = snapshot.tokenStatus || progressiveTokens;
          const targetCacheKeys = buildTargetCacheKeys(progressiveTokens, enabledRoleFeatures);
          const eligibleResult = snapshot.eligibleByTarget?.[target]
            || splitActivationResultByTarget(snapshot.eligible, [target])[target]
            || { items: [], errors: [] };
          const activeResult = snapshot.activeByTarget?.[target]
            || splitActivationResultByTarget(snapshot.active, [target])[target]
            || { items: [], errors: [] };
          eligibleResultsByTarget[target] = eligibleResult;
          activeResultsByTarget[target] = activeResult;
          progressiveCache = updateCacheFromTargetResults(
            progressiveCache,
            "eligible",
            [target],
            { [target]: eligibleResult },
            fetchedAt,
            targetCacheKeys,
            refreshStartedAt
          );
          progressiveCache = updateCacheFromTargetResults(
            progressiveCache,
            "active",
            [target],
            { [target]: activeResult },
            fetchedAt,
            targetCacheKeys,
            refreshStartedAt
          );
          progressiveReferenceData = learnReferenceDataFromItems(
            progressiveReferenceData,
            [...eligibleResult.items, ...activeResult.items]
          );

          const progressiveView = getActivationCacheView(
            progressiveCache,
            progressiveTokens,
            enabledRoleFeatures,
            fetchedAt
          );
          renderLoadedActivationData(
            loadedSettings,
            progressiveTokens,
            progressiveCache,
            progressiveReferenceData,
            progressiveView.eligible,
            progressiveView.active
          );
          cachePersistence.push(saveDataCache(progressiveCache));
          targetSucceeded = !eligibleResult.errors.length && !activeResult.errors.length;
          if (targetSucceeded) {
            successfulRefreshTargets.add(target);
          }
        } catch (targetError) {
          if (isCurrentRun()) {
            const detail = targetError instanceof Error ? targetError.message : String(targetError);
            transportErrors.push(`${tabLabel(target)}: ${detail}`);
          }
        } finally {
          if (!isCurrentRun()) {
            return;
          }
          completedTargets += 1;
          if (showBlockingLoading && (target === preferredTarget || completedTargets === staleTargets.length)) {
            setIsLoading(false);
          }
          showProgressStep(
            sourceProgressStep,
            `${tabLabel(target)} ${targetSucceeded ? "ready" : "checked with an issue"} (${completedTargets}/${staleTargets.length})`
          );
        }
      }));

      if (!isCurrentRun()) {
        return;
      }

      let nextSettings = loadedSettings;
      const allFeatureResultsResolved = enabledRoleFeatures.every((target) => {
        const eligibleResult = eligibleResultsByTarget[target];
        const activeResult = activeResultsByTarget[target];
        const eligibleResolved = initialCacheView.eligibleCache[target]?.isUsable || Boolean(
          eligibleResult && (!eligibleResult.errors.length || eligibleResult.diagnostics?.some((diagnostic) => diagnostic.success))
        );
        const activeResolved = initialCacheView.activeCache[target]?.isUsable || Boolean(
          activeResult && (!activeResult.errors.length || activeResult.diagnostics?.some((diagnostic) => diagnostic.success))
        );
        return Boolean(eligibleResolved && activeResolved);
      });
      if (!loadedSettings.preferences.autoEnabledFeaturesInitialized && allFeatureResultsResolved) {
        const resolvedItems = enabledRoleFeatures.flatMap((target) => [
          ...(progressiveCache.eligibleByTarget?.[target]?.items || []),
          ...(progressiveCache.activeByTarget?.[target]?.items || [])
        ]);
        nextSettings = {
          ...loadedSettings,
          preferences: {
            ...loadedSettings.preferences,
            enabledFeatures: getAutoEnabledFeatures(
              resolvedItems,
              loadedSettings.preferences.enabledFeatures?.includes("bundles") !== false
            ),
            autoEnabledFeaturesInitialized: true
          }
        };
      }

      const finalEnabledRoleFeatures = getEnabledRoleFeatures(nextSettings);
      const finalView = getActivationCacheView(progressiveCache, progressiveTokens, finalEnabledRoleFeatures, Date.now());
      renderLoadedActivationData(
        nextSettings,
        progressiveTokens,
        progressiveCache,
        progressiveReferenceData,
        finalView.eligible,
        finalView.active
      );
      setHasActivationDataLoaded(true);
      showProgressStep(saveProgressStep, "Saving refreshed data");
      await Promise.all([
        ...cachePersistence,
        saveReferenceData(progressiveReferenceData),
        ...(nextSettings === loadedSettings ? [] : [saveSettings(nextSettings)])
      ]);
      const nextAccessCapabilities = buildAccessCapabilityItems(progressiveTokens, progressiveCache, finalEnabledRoleFeatures);
      const completedRecoveryTargets = portalTokenRecoveryTargets.filter((target) => successfulRefreshTargets.has(target));
      if (completedRecoveryTargets.length) {
        try {
          await sendMessage<AccessSetupTarget[]>({ action: "closePortalRecoveryTabs", targets: completedRecoveryTargets });
        } catch {
          // Role data is ready even if the browser rejects optional temporary-tab cleanup.
        }
      }
      setPortalRecoveryStatus(await readPortalRecoveryStatus());
      const loadErrors = filterLoadErrorsForAccessState([
        ...Object.values(eligibleResultsByTarget).flatMap((result) => result.errors || []),
        ...Object.values(activeResultsByTarget).flatMap((result) => result.errors || []),
        ...transportErrors
      ], nextAccessCapabilities);
      const formattedLoadErrors = formatLoadMessages(loadErrors);
      const remainingAccessTargets = getAccessSetupTargets(nextAccessCapabilities);
      const isInitialAccessRequired = !finalView.eligible.items.length
        && !finalView.active.items.length
        && remainingAccessTargets.length > 0
        && !options.force;
      if (formattedLoadErrors.length && !isInitialAccessRequired) {
        showProgressError(formattedLoadErrors.join("\n"), "Refresh completed with an issue");
      } else {
        setError("");
        if (!options.suppressMessage) {
          setMessage("");
        }
        showProgressComplete(remainingAccessTargets.length ? "Available role data loaded" : "Refresh complete");
        if (options.force && !loadErrors.length && !remainingAccessTargets.length) {
          setRefreshSuccessKey(Date.now());
          refreshSuccessTimer.current = setTimeout(() => {
            setRefreshSuccessKey(0);
            refreshSuccessTimer.current = undefined;
          }, 4_000);
        }
      }
    } catch (loadError) {
      setActivationFailureNotice(null);
      showProgressError(
        loadError instanceof Error ? loadError.message : String(loadError),
        "Refresh stopped at this step"
      );
    } finally {
      if (activeRefreshRunId.current === runId) {
        activeRefreshRunId.current = undefined;
      }
      if (isCurrentRun()) {
        setIsLoading(false);
        setIsRefreshing(false);
        if (shouldShowProgress && refreshCompleted) {
          refreshProgressClearTimer.current = setTimeout(() => {
            if (refreshRunId.current === runId) {
              setRefreshProgress(null);
            }
            refreshProgressClearTimer.current = undefined;
          }, 350);
        } else if (shouldShowProgress && liveProgress?.status !== "error") {
          setRefreshProgress(null);
        }
      }
    }
  }

  function renderLoadedActivationData(
    nextSettings: QuickPimSettings,
    nextTokens: TokenStatus,
    nextCache: QuickPimDataCache,
    nextReferenceData: ReferenceDataCache,
    eligible: { items: ActivationItem[]; errors: string[] },
    active: { items: ActivationItem[]; errors: string[] }
  ) {
    setSettings(nextSettings);
    setTokenStatus(nextTokens);
    setReferenceData(nextReferenceData);
    setAccessCapabilities(buildAccessCapabilityItems(nextTokens, nextCache, getEnabledRoleFeatures(nextSettings)));
    setEligibleItems(applyDisplayData(eligible.items, nextSettings, nextReferenceData));
    setActiveItems(applyDisplayData(active.items, nextSettings, nextReferenceData));
  }

  function toggleSelected(itemId: string) {
    if (isActivating) {
      return;
    }
    setSelectedIds((current) => {
      const item = getItemByPersistedId(itemsById, itemId);
      const itemMode = getRequestModeForItem(item);
      if (!item || !itemMode || (requestMode && requestMode !== itemMode)) {
        return current;
      }
      const next = new Set(current);
      const selectedItemId = [...next].find((id) => id.toLowerCase() === item.id.toLowerCase());
      if (selectedItemId) {
        next.delete(selectedItemId);
      } else {
        next.add(item.id);
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
    try {
      await mutatePopupSettings((latest) => ({
        ...latest,
        favoriteItemIds: latest.favoriteItemIds.includes(itemId)
          ? latest.favoriteItemIds.filter((id) => id !== itemId)
          : [itemId, ...latest.favoriteItemIds]
      }));
    } catch (saveError) {
      setActivationFailureNotice(null);
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  async function recoverRequestPortalAccess(
    targets: AccessSetupTarget[],
    onProgress: (label: string) => void
  ): Promise<{ ready: boolean; error?: string }> {
    const applyTokenStatus = (nextTokens: TokenStatus) => {
      setTokenStatus(nextTokens);
      setAccessCapabilities(buildAccessCapabilityItems(nextTokens, undefined, enabledRoleFeatures));
    };
    const missingTargets = (status: TokenStatus) => targets.filter((target) => !hasRequestReadyPortalToken(target, status));
    let currentTokens = await sendMessage<TokenStatus>(
      { action: "getTokenStatus" },
      { timeoutMs: TOKEN_STATUS_TIMEOUT_MS, timeoutMessage: "Microsoft portal access check timed out." }
    );
    applyTokenStatus(currentTokens);
    let remainingTargets = missingTargets(currentTokens);
    if (!remainingTargets.length) {
      return { ready: true };
    }

    onProgress("Checking existing Microsoft portal tabs for activation access");
    try {
      const refreshed = await sendMessage<PortalTokenRefreshResult>(
        { action: "refreshPortalTokens" },
        { timeoutMs: PORTAL_TOKEN_REFRESH_TIMEOUT_MS, timeoutMessage: "Existing Microsoft portal tab scan timed out." }
      );
      currentTokens = refreshed.tokenStatus;
      applyTokenStatus(currentTokens);
      remainingTargets = missingTargets(currentTokens);
    } catch {
      // Opening a dedicated background page remains available when existing tabs cannot be scanned.
    }
    if (!remainingTargets.length) {
      return { ready: true };
    }

    onProgress(`Preparing ${remainingTargets.map(tabLabel).join(" and ")} activation access`);
    const recovery = await openPortalPagesForTargets(remainingTargets);
    currentTokens = await sendMessage<TokenStatus>(
      { action: "getTokenStatus" },
      { timeoutMs: TOKEN_STATUS_TIMEOUT_MS, timeoutMessage: "Microsoft portal access check timed out." }
    );
    applyTokenStatus(currentTokens);
    remainingTargets = missingTargets(currentTokens);
    if (!remainingTargets.length) {
      return { ready: true };
    }
    if (!recovery.managedCount) {
      return {
        ready: false,
        error: "QuickPIM++ could not open the Microsoft portal page needed for this request. Your selection and inputs are saved; use Refresh and retry."
      };
    }

    setPortalRecoveryStatus(await readPortalRecoveryStatus());
    onProgress(`Waiting for ${remainingTargets.map(tabLabel).join(" and ")} activation access`);
    const recovered = await waitForManagedPortalRecovery(
      remainingTargets,
      currentTokens,
      () => activationRequestInFlight.current
    );
    currentTokens = recovered.tokens;
    applyTokenStatus(currentTokens);
    setPortalRecoveryStatus(recovered.recoveryStatus);
    remainingTargets = missingTargets(currentTokens);
    if (!remainingTargets.length) {
      return { ready: true };
    }
    if (recovered.recoveryStatus.state === "interactionRequired") {
      return {
        ready: false,
        error: "Microsoft sign-in is required before this request can continue. Use the highlighted Refresh button to continue sign-in, then retry; your selection and inputs are saved."
      };
    }
    return {
      ready: false,
      error: `QuickPIM++ could not capture ${remainingTargets.map(tabLabel).join(" and ")} activation access in time. Your selection and inputs are saved; use Refresh and retry.`
    };
  }

  async function retryAfterPortalAccessRecovery(
    initialResponse: ActivationResponse,
    requestItems: ActivationItem[],
    operation: "activation" | "deactivation",
    onProgress: (label: string) => void,
    retry: (items: ActivationItem[]) => Promise<ActivationResponse>
  ): Promise<ActivationResponse> {
    const recoveryTargets = getAccessRecoveryTargets(initialResponse);
    if (!recoveryTargets.length) {
      return initialResponse;
    }
    const retryItemIds = new Set(
      initialResponse.errors
        .filter((result) => result.accessRecoveryTarget)
        .map((result) => result.itemId)
    );
    const retryItems = requestItems.filter((item) => retryItemIds.has(item.id));
    if (!retryItems.length) {
      return initialResponse;
    }

    try {
      const recovery = await recoverRequestPortalAccess(recoveryTargets, onProgress);
      if (!recovery.ready) {
        return replaceAccessRecoveryErrors(initialResponse, recovery.error || "Microsoft portal access could not be refreshed automatically.");
      }
      onProgress(`Retrying ${operation} with refreshed Microsoft portal access`);
      return mergeRetriedActivationResponse(initialResponse, await retry(retryItems));
    } catch (recoveryError) {
      const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      return replaceAccessRecoveryErrors(
        initialResponse,
        `QuickPIM++ could not refresh Microsoft portal access automatically: ${detail}. Your selection and inputs are saved.`
      );
    }
  }

  async function reconcileDetachedRequestOperation(operation: RequestOperationRecord): Promise<void> {
    const operationLabel = operation.action === "activate" ? "activation" : "deactivation";
    const steps = operation.action === "activate" ? ACTIVATION_STEPS : DEACTIVATION_STEPS;
    let requestProgress = advanceOperationProgress(
      createOperationProgress(`background-${operation.id}`, steps),
      2,
      { label: "Background request completed" }
    );
    activationRequestInFlight.current = false;
    setIsActivating(false);
    setActivationProgress(requestProgress);
    if (operation.durationHours !== undefined) {
      setDurationHours(operation.durationHours);
    }
    if (operation.justification !== undefined) {
      setJustification(operation.justification);
    }

    try {
      if (operation.state === "error" || !operation.response) {
        const detail = operation.error || "The background request stopped before a result was available.";
        const restorableIds = operation.itemIds.flatMap((id) => {
          const item = getItemByPersistedId(itemsById, id);
          return item ? [item.id] : [];
        });
        setActivationFailureNotice(null);
        setError(detail);
        setSelectedIds(new Set(restorableIds));
        setRequestMode(operation.action);
        setIsActivationReviewOpen(true);
        await flushPopupDraft({
          selectedIds: restorableIds,
          durationHours: operation.durationHours ?? durationHours,
          justification: operation.justification ?? justification,
          isActivationReviewOpen: true,
          requestMode: operation.action
        });
        requestProgress = failOperationProgress(
          requestProgress,
          detail,
          `${operationLabel === "activation" ? "Activation" : "Deactivation"} stopped in the background`
        );
        setActivationProgress(requestProgress);
        return;
      }

      const response = operation.response;
      const operationItems = operation.itemIds
        .map((id) => getItemByPersistedId(itemsById, id))
        .filter((item): item is ActivationItem => Boolean(item));
      const successfulIds = new Set(response.results.filter((result) => result.success).map((result) => result.itemId));
      const failedIds = new Set(response.errors.map((result) => result.itemId));
      const failedSelectionIds = operation.itemIds.flatMap((id) => {
        const item = getItemByPersistedId(itemsById, id);
        return item && failedIds.has(id) ? [item.id] : [];
      });
      const successCount = successfulIds.size;
      const failureNotice = response.errors.length
        ? buildActivationFailureNotice(response.errors, operationItems)
        : null;

      setError("");
      setActivationFailureNotice(failureNotice);
      setSelectedIds((current) => {
        const next = new Set(
          [...current].filter((id) => !successfulIds.has(id))
        );
        failedSelectionIds.forEach((id) => next.add(id));
        return next;
      });
      setMessage(formatRequestConfirmation(operationLabel, successCount, response.errors.length));

      if (failedSelectionIds.length) {
        setRequestMode(operation.action);
        setIsActivationReviewOpen(true);
        await flushPopupDraft({
          selectedIds: failedSelectionIds,
          durationHours: operation.durationHours ?? durationHours,
          justification: operation.justification ?? justification,
          isActivationReviewOpen: true,
          requestMode: operation.action
        });
      } else {
        setRequestMode(undefined);
        setIsActivationReviewOpen(false);
        latestPopupDraft.current = undefined;
        await clearPopupDraft();
      }

      if (successCount) {
        await refresh({
          force: true,
          showLoading: false,
          suppressMessage: true,
          targets: operation.targets
        });
      }

      if (failureNotice) {
        requestProgress = failOperationProgress(
          requestProgress,
          failureNotice.errors.join("\n"),
          `${operationLabel === "activation" ? "Activation" : "Deactivation"} completed with an issue`
        );
      } else {
        requestProgress = completeOperationProgress(
          requestProgress,
          `${operationLabel === "activation" ? "Activation" : "Deactivation"} complete`
        );
        requestProgressClearTimer.current = setTimeout(() => {
          setActivationProgress(null);
          requestProgressClearTimer.current = undefined;
        }, 350);
      }
      setActivationProgress(requestProgress);
    } finally {
      await acknowledgeRequestOperations([operation.id]);
    }
  }

  async function acknowledgeRequestOperations(operationIds: string[]): Promise<void> {
    if (!operationIds.length) {
      return;
    }
    try {
      await sendMessage<boolean>(
        { action: "dismissRequestOperations", operationIds },
        { timeoutMs: 3_000, timeoutMessage: "Background request cleanup timed out." }
      );
      operationIds.forEach((id) => ownedRequestOperationIds.current.delete(id));
    } catch {
      // Keeping the local ownership marker prevents duplicate reconciliation in this popup.
    }
  }

  async function activate(items: ActivationItem[], bundle?: QuickPimBundle) {
    if (activationRequestInFlight.current) {
      return;
    }
    const activatableItems = getActivatableItems(items);
    if (!activatableItems.length) {
      setActivationFailureNotice(null);
      setError(items.length ? "No selected items are currently eligible to activate." : "Select at least one role or group.");
      return;
    }

    const activationRequirements = getActivationRequirements(activatableItems);
    const effectiveJustification = activationRequirements.needsJustification ? bundle?.defaultJustification || justification : "";
    const effectiveDuration = coerceDurationForItems(bundle?.defaultDurationHours || durationHours, activatableItems);
    const effectiveTicketInfo: TicketInfo = activationRequirements.needsTicket
      ? { ticketSystem: ticketSystem.trim(), ticketNumber: ticketNumber.trim() }
      : {};

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
    if (activationRequirements.needsTicket && (!effectiveTicketInfo.ticketSystem || !effectiveTicketInfo.ticketNumber)) {
      setActivationFailureNotice(null);
      setError("Enter both the ticket system and ticket number required by the selected policy.");
      return;
    }

    if (requestProgressClearTimer.current) {
      clearTimeout(requestProgressClearTimer.current);
      requestProgressClearTimer.current = undefined;
    }
    if (refreshProgressClearTimer.current) {
      clearTimeout(refreshProgressClearTimer.current);
      refreshProgressClearTimer.current = undefined;
    }
    setRefreshProgress(null);
    let requestProgress = createOperationProgress(
      `request-${++requestProgressRunId.current}`,
      ACTIVATION_STEPS
    );
    let requestCompleted = false;
    let requestContinuesInBackground = false;
    activationRequestInFlight.current = true;
    setIsActivating(true);
    setActivationProgress(requestProgress);
    scrollPopupToTop();
    setError("");
    setActivationFailureNotice(null);
    setMessage("");
    const operationIds: string[] = [];
    const sendActivationOperation = (
      requestItems: ActivationItem[],
      timeoutMessage: string
    ) => {
      const operationId = createRequestOperationId();
      operationIds.push(operationId);
      ownedRequestOperationIds.current.add(operationId);
      return sendMessage<ActivationResponse>(
        {
          action: "activateItems",
          items: requestItems,
          durationHours: effectiveDuration,
          justification: effectiveJustification,
          ticketInfo: effectiveTicketInfo,
          bundleName: bundle?.name,
          operationId
        },
        { timeoutMs: ACTIVATION_REQUEST_TIMEOUT_MS, timeoutMessage }
      );
    };
    try {
      await flushPopupDraft({
        selectedIds: activatableItems.map((item) => item.id),
        durationHours: effectiveDuration,
        justification: effectiveJustification,
        isActivationReviewOpen: true,
        requestMode: "activate"
      }).catch(() => undefined);
      const requestedAt = new Date().toISOString();
      let response = await sendActivationOperation(
        activatableItems,
        "The activation request timed out. QuickPIM++ will keep checking it in the background; do not submit a duplicate request."
      );
      response = await retryAfterPortalAccessRecovery(
        response,
        activatableItems,
        "activation",
        (label) => {
          requestProgress = advanceOperationProgress(requestProgress, 1, { label });
          setActivationProgress(requestProgress);
        },
        (retryItems) => sendActivationOperation(
          retryItems,
          "The retried activation request timed out. QuickPIM++ will keep checking it in the background; do not submit another request."
        )
      );
      requestProgress = advanceOperationProgress(requestProgress, 2);
      setActivationProgress(requestProgress);
      const successItems = response.results
        .filter((result) => result.success)
        .map((result) => activatableItems.find((item) => item.id === result.itemId))
        .filter((item): item is ActivationItem => Boolean(item));

      await mutatePopupSettings((latest) => {
        let updatedSettings = addRecentJustification(latest, effectiveJustification);
        updatedSettings = recordActivations(updatedSettings, successItems, new Date().toISOString(), bundle?.name);
        return recordActivityResults(updatedSettings, {
          action: "activate",
          items: activatableItems,
          response,
          requestedAt,
          completedAt: new Date().toISOString(),
          durationHours: effectiveDuration,
          justification: effectiveJustification,
          bundleName: bundle?.name
        });
      });
      const remainingSelectedIds = getRemainingSelectedIdsAfterActivationResults(selectedIds, response.results);
      setSelectedIds(remainingSelectedIds);
      requestProgress = advanceOperationProgress(requestProgress, 3);
      setActivationProgress(requestProgress);
      const failureNotice = response.errors.length
        ? buildActivationFailureNotice(response.errors, activatableItems)
        : null;
      if (response.errors.length) {
        setActivationFailureNotice(failureNotice);
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
      if (failureNotice) {
        requestProgress = failOperationProgress(
          requestProgress,
          failureNotice.errors.join("\n"),
          "Activation completed with an issue"
        );
        setActivationProgress(requestProgress);
      } else {
        requestProgress = completeOperationProgress(requestProgress, "Activation complete");
        requestCompleted = true;
        setActivationProgress(requestProgress);
      }
      await acknowledgeRequestOperations(operationIds);
    } catch (activationError) {
      const detail = activationError instanceof Error ? activationError.message : String(activationError);
      setActivationFailureNotice(null);
      setError(detail);
      requestProgress = failOperationProgress(requestProgress, detail, "Activation stopped at this step");
      setActivationProgress(requestProgress);
      if (isOperationTimeoutError(activationError)) {
        requestContinuesInBackground = true;
        operationIds.forEach((id) => ownedRequestOperationIds.current.delete(id));
      } else {
        await acknowledgeRequestOperations(operationIds);
      }
    } finally {
      if (!requestContinuesInBackground) {
        activationRequestInFlight.current = false;
        setIsActivating(false);
      }
      if (requestCompleted) {
        requestProgressClearTimer.current = setTimeout(() => {
          setActivationProgress(null);
          requestProgressClearTimer.current = undefined;
        }, 350);
      }
    }
  }

  async function deactivate(items: ActivationItem[]) {
    if (activationRequestInFlight.current) {
      return;
    }
    const deactivatableItems = getDeactivatableItems(items);
    if (!deactivatableItems.length) {
      setActivationFailureNotice(null);
      setError(items.length ? "No selected items are currently active." : "Select at least one active role or group.");
      return;
    }

    if (requestProgressClearTimer.current) {
      clearTimeout(requestProgressClearTimer.current);
      requestProgressClearTimer.current = undefined;
    }
    if (refreshProgressClearTimer.current) {
      clearTimeout(refreshProgressClearTimer.current);
      refreshProgressClearTimer.current = undefined;
    }
    setRefreshProgress(null);
    let requestProgress = createOperationProgress(
      `request-${++requestProgressRunId.current}`,
      DEACTIVATION_STEPS
    );
    let requestCompleted = false;
    let requestContinuesInBackground = false;
    activationRequestInFlight.current = true;
    setIsActivating(true);
    setActivationProgress(requestProgress);
    scrollPopupToTop();
    setError("");
    setActivationFailureNotice(null);
    setMessage("");
    const operationIds: string[] = [];
    const sendDeactivationOperation = (
      requestItems: ActivationItem[],
      timeoutMessage: string
    ) => {
      const operationId = createRequestOperationId();
      operationIds.push(operationId);
      ownedRequestOperationIds.current.add(operationId);
      return sendMessage<ActivationResponse>(
        {
          action: "deactivateItems",
          items: requestItems,
          justification,
          ticketInfo: {},
          operationId
        },
        { timeoutMs: ACTIVATION_REQUEST_TIMEOUT_MS, timeoutMessage }
      );
    };
    try {
      await flushPopupDraft({
        selectedIds: deactivatableItems.map((item) => item.id),
        justification,
        isActivationReviewOpen: true,
        requestMode: "deactivate"
      }).catch(() => undefined);
      const requestedAt = new Date().toISOString();
      let response = await sendDeactivationOperation(
        deactivatableItems,
        "The deactivation request timed out. QuickPIM++ will keep checking it in the background; do not submit a duplicate request."
      );
      response = await retryAfterPortalAccessRecovery(
        response,
        deactivatableItems,
        "deactivation",
        (label) => {
          requestProgress = advanceOperationProgress(requestProgress, 1, { label });
          setActivationProgress(requestProgress);
        },
        (retryItems) => sendDeactivationOperation(
          retryItems,
          "The retried deactivation request timed out. QuickPIM++ will keep checking it in the background; do not submit another request."
        )
      );
      requestProgress = advanceOperationProgress(requestProgress, 2);
      setActivationProgress(requestProgress);
      const successItems = response.results
        .filter((result) => result.success)
        .map((result) => deactivatableItems.find((item) => item.id === result.itemId))
        .filter((item): item is ActivationItem => Boolean(item));

      if (justification.trim()) {
        await mutatePopupSettings((latest) => {
          const updatedSettings = addRecentJustification(latest, justification);
          return recordActivityResults(updatedSettings, {
            action: "deactivate",
            items: deactivatableItems,
            response,
            requestedAt,
            completedAt: new Date().toISOString(),
            justification
          });
        });
      } else {
        await mutatePopupSettings((latest) => recordActivityResults(latest, {
          action: "deactivate",
          items: deactivatableItems,
          response,
          requestedAt,
          completedAt: new Date().toISOString()
        }));
      }

      const remainingSelectedIds = getRemainingSelectedIdsAfterActivationResults(selectedIds, response.results);
      setSelectedIds(remainingSelectedIds);
      requestProgress = advanceOperationProgress(requestProgress, 3);
      setActivationProgress(requestProgress);
      const failureNotice = response.errors.length
        ? buildActivationFailureNotice(response.errors, deactivatableItems)
        : null;
      if (response.errors.length) {
        setActivationFailureNotice(failureNotice);
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
      if (failureNotice) {
        requestProgress = failOperationProgress(
          requestProgress,
          failureNotice.errors.join("\n"),
          "Deactivation completed with an issue"
        );
        setActivationProgress(requestProgress);
      } else {
        requestProgress = completeOperationProgress(requestProgress, "Deactivation complete");
        requestCompleted = true;
        setActivationProgress(requestProgress);
      }
      await acknowledgeRequestOperations(operationIds);
    } catch (activationError) {
      const detail = activationError instanceof Error ? activationError.message : String(activationError);
      setActivationFailureNotice(null);
      setError(detail);
      requestProgress = failOperationProgress(requestProgress, detail, "Deactivation stopped at this step");
      setActivationProgress(requestProgress);
      if (isOperationTimeoutError(activationError)) {
        requestContinuesInBackground = true;
        operationIds.forEach((id) => ownedRequestOperationIds.current.delete(id));
      } else {
        await acknowledgeRequestOperations(operationIds);
      }
    } finally {
      if (!requestContinuesInBackground) {
        activationRequestInFlight.current = false;
        setIsActivating(false);
      }
      if (requestCompleted) {
        requestProgressClearTimer.current = setTimeout(() => {
          setActivationProgress(null);
          requestProgressClearTimer.current = undefined;
        }, 350);
      }
    }
  }

  async function saveCurrentJustification() {
    const genericJustificationWarning = getGenericJustificationWarning(justification);
    if (genericJustificationWarning) {
      setActivationFailureNotice(null);
      setError(genericJustificationWarning);
      return;
    }
    await mutatePopupSettings((latest) => addSavedJustification(latest, justification));
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
    await openPortalUrls([url]);
  }

  async function openPortalPagesForTargets(targets: AccessSetupTarget[]): Promise<PortalRecoveryOpenResult> {
    await flushPopupDraft();
    return sendMessage<PortalRecoveryOpenResult>({ action: "openPortalRecoveryTabs", targets });
  }

  async function continueMicrosoftSignIn() {
    await flushPopupDraft();
    try {
      const result = await sendMessage<PortalRecoveryFocusResult>({ action: "focusPortalRecoveryTabs" });
      setPortalRecoveryStatus(sanitizePortalRecoveryStatus(result?.status));
      if (!result?.focused) {
        setError("The Microsoft sign-in tab is no longer available. Use Refresh to open it again.");
      }
    } catch (focusError) {
      setError(focusError instanceof Error ? focusError.message : String(focusError));
    }
  }

  async function openPortalUrls(urls: string[]): Promise<number> {
    const uniqueUrls = [...new Set(urls)];
    const results = await Promise.all(uniqueUrls.map(async (url) => {
      if (chrome.tabs?.create) {
        try {
          await chrome.tabs.create({ url, active: true });
          return true;
        } catch {
          // Fall through to extension-page navigation when tab creation is unavailable.
        }
      }
      return Boolean(window.open(url, "_blank", "noopener"));
    }));
    return results.filter(Boolean).length;
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
    await mutatePopupSettings((latest) => ({
      ...latest,
      preferences: {
        ...latest.preferences,
        permissionWarningIgnored: true,
        permissionWarningIgnoredAt: new Date().toISOString()
      }
    }));
  }

  async function mutatePopupSettings(updater: (latest: QuickPimSettings) => QuickPimSettings): Promise<QuickPimSettings> {
    let result = settings;
    const operation = settingsMutationQueue.current.then(async () => {
      const latest = await loadSettings();
      result = updater(latest);
      await saveSettings(result);
      setSettings(result);
    });
    settingsMutationQueue.current = operation.catch(() => undefined);
    await operation;
    return result;
  }

  const activeTabIsVisible = visibleTabs.includes(tab);
  const currentRoleTab = activeTabIsVisible && roleTabs.includes(tab as RoleTab) ? tab as RoleTab : undefined;
  const portalUrl = activeTabIsVisible ? getPortalUrlForTab(tab) : undefined;
  const portalLabel = currentRoleTab ? tabLabel(currentRoleTab) : "Microsoft Entra";
  const manualRefreshTargets: AccessSetupTarget[] = enabledRoleFeatures;
  const isPortalInteractionRequired = portalRecoveryStatus.state === "interactionRequired";
  const manualRefreshLabel = isPortalInteractionRequired
    ? "Continue Microsoft sign-in"
    : "Refresh all enabled data and recover missing portal access";
  const needsRefreshAttention = showInitialAccessState || showPermissionWarning;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/img/QuickPim48.png" alt="" />
          <div>
            <h1>QuickPIM++</h1>
            <p>
              {isLoading ? null : showInitialAccessState ? "Ready to load roles" : `${activatableItemCount} eligible items${isRefreshing ? " so far" : ""}`}
            </p>
          </div>
        </div>
        <div className="status-stack">
          <TokenPill label="Graph" status={tokenStatus?.graph} />
          <TokenPill label="Azure" status={tokenStatus?.azureManagement} />
          <div className="header-actions" aria-label="Popup actions">
            <button
              className={`btn icon-btn refresh-button ${isRefreshing ? "spinning" : ""} ${needsRefreshAttention && !isRefreshing ? "needs-attention" : ""}`}
              onClick={() => {
                if (isPortalInteractionRequired) {
                  void continueMicrosoftSignIn();
                  return;
                }
                if (showInitialAccessState && enabledRoleFeatures.length) {
                  setIsRefreshing(true);
                  setTab(enabledRoleFeatures[0]);
                }
                void refresh({
                  force: true,
                  showLoading: false,
                  targets: manualRefreshTargets,
                  recoverMissingPortalAccess: true
                });
              }}
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
            {portalUrl ? (
              <button className="btn icon-btn" onClick={openPortalForCurrentTab} title={`Open ${portalLabel} in Microsoft Entra`} aria-label={`Open ${portalLabel} in Microsoft Entra`}>
                <LinkIcon />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {showPermissionWarning ? (
        <PermissionWarningBanner
          missingCount={accessSetupTargets.length}
          signInRequired={isPortalInteractionRequired}
          onContinueSignIn={() => void continueMicrosoftSignIn()}
          onDetails={() => openSettingsSection("access")}
          onDismiss={() => void ignorePermissionWarning()}
        />
      ) : null}

      {!showInitialAccessState && visibleTabs.length ? (
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
      ) : error && refreshProgress?.status !== "error" && activationProgress?.status !== "error" ? (
        <p className="message error">{error}</p>
      ) : null}
      {message && !(showInitialAccessState && isMissingAccessSummary(message)) ? <p className="message">{message}</p> : null}
      {isLoading ? (
        refreshProgress ? (
          <SmartProgressPanel
            key={refreshProgress.operationId}
            title="Loading access data"
            progress={refreshProgress}
            helperText="Role types appear as soon as they are ready. This can take up to 15 seconds."
          />
        ) : <LoadingState />
      ) : null}
      {!isLoading && refreshProgress ? (
        <SmartProgressPanel
          key={refreshProgress.operationId}
          title="Refreshing access data"
          progress={refreshProgress}
        />
      ) : null}
      {activationProgress ? (
        <SmartProgressPanel
          key={activationProgress.operationId}
          title={`${requestMode === "deactivate" ? "Deactivation" : "Activation"} in progress`}
          progress={activationProgress}
        />
      ) : null}

      {showInitialAccessState ? (
        <InitialAccessState
          recoveryStatus={portalRecoveryStatus}
          onContinueSignIn={() => void continueMicrosoftSignIn()}
          onDetails={() => void openSettingsSection("access")}
        />
      ) : null}

      {!showInitialAccessState && currentRoleTab ? (
        <>
          <section className="toolbar">
            <div className="control-with-icon filter-field">
              <span className="field-icon" aria-hidden="true">
                <FilterIcon />
              </span>
              <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or scope" aria-label="Filter roles" />
              {search ? (
                <button
                  type="button"
                  className="field-clear-button"
                  onClick={() => setSearch("")}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <ClearIcon />
                </button>
              ) : null}
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
          <QuickFilterBar activeFilters={quickFilters} onToggle={toggleQuickFilter} />
          <section className="content">
            <RoleList
              items={visibleEligibleItems}
              settings={settings}
              referenceData={referenceData}
              selectedIds={selectedIds}
              favoriteIds={favoriteIds}
              requestMode={requestMode}
              showActivationCounters={settings.preferences.showActivationCounters}
              showEnablementDetails={settings.preferences.showEnablementDetails}
              showLastEnablementDate={settings.preferences.showLastEnablementDate}
              showRemainingActivationTime={settings.preferences.showRemainingActivationTime}
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

      {!showInitialAccessState && activeTabIsVisible && tab === "bundles" ? (
        <section className="content item-list">
          {settings.bundles.length ? (
            settings.bundles.map((bundle) => {
              const expansion = expandBundle(bundle, displayItems);
              const preflight = getBundlePreflight(bundle, displayItems, justification);
              return (
                <div className="bundle-card" key={bundle.id}>
                  <h3>{bundle.name}</h3>
                  <p className="muted">
                    {expansion.items.length} available item(s)
                    {bundle.defaultJustification ? ` / ${bundle.defaultJustification}` : ""}
                  </p>
                  <p className="bundle-preflight">
                    {preflight.readyCount} ready / {preflight.alreadyActiveCount} already active / {preflight.pendingApprovalCount} pending
                    {preflight.missingCount ? ` / ${preflight.missingCount} missing` : ""}
                    {preflight.strictestMaxDurationHours ? ` / max ${preflight.strictestMaxDurationHours}h` : ""}
                  </p>
                  {preflight.blockedReason ? <p className="muted">{preflight.blockedReason}</p> : null}
                  <div className="button-row">
                    <button className="btn" onClick={() => useBundleDefaults(bundle)}>
                      Use defaults
                    </button>
                    <button className="btn primary" onClick={() => void activate(preflight.readyItems, bundle)} disabled={preflight.isBlocked || isActivating}>
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

      {!isLoading && !showInitialAccessState && !visibleTabs.length ? (
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
  signInRequired,
  onContinueSignIn,
  onDetails,
  onDismiss
}: {
  missingCount: number;
  signInRequired: boolean;
  onContinueSignIn: () => void;
  onDetails: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="permission-banner" role="status">
      <div>
        <strong>
          {signInRequired
            ? "Microsoft sign-in is needed to finish refreshing access."
            : missingCount === 1 ? "One role source needs a refresh." : `${missingCount} role sources need a refresh.`}
        </strong>
        <p>{signInRequired ? "Continue the account prompt; available roles remain usable." : "Use Refresh in the top-right. Available roles remain usable."}</p>
      </div>
      <div className="button-row permission-actions">
        {signInRequired ? (
          <button className="btn primary" onClick={onContinueSignIn}>
            Continue sign-in
          </button>
        ) : null}
        <button className="btn" onClick={onDetails}>
          Details
        </button>
        <button className="btn subtle" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}

function InitialAccessState({
  recoveryStatus,
  onContinueSignIn,
  onDetails
}: {
  recoveryStatus: PortalRecoveryStatus;
  onContinueSignIn: () => void;
  onDetails: () => void;
}) {
  const needsInteraction = recoveryStatus.state === "interactionRequired";
  const isWaiting = recoveryStatus.state === "waiting";
  const needsSignIn = needsInteraction && recoveryStatus.interactionReason === "signIn";
  return (
    <section className="initial-access-state" role="status" aria-labelledby="initial-access-title">
      <div className={`initial-access-arrow ${needsInteraction ? "sign-in" : ""}`} aria-hidden="true">
        {needsInteraction ? <SignInIcon /> : isWaiting ? <span className="spinner large" /> : <ArrowUpRightIcon />}
      </div>
      <div className="initial-access-copy">
        <h2 id="initial-access-title">
          {needsInteraction
            ? needsSignIn ? "Microsoft sign-in needed" : "Microsoft needs your attention"
            : isWaiting ? "Preparing Microsoft access" : "Load your PIM roles"}
        </h2>
        <p>
          {needsInteraction
            ? needsSignIn
              ? "Choose an account or finish signing in from the QuickPIM++ access refresh tab."
              : "Complete the Microsoft prompt in the QuickPIM++ access refresh tab."
            : isWaiting ? "The temporary Microsoft pages are still loading in the background." : "Use the highlighted Refresh button above."}
        </p>
        <p className="muted">
          {needsInteraction
            ? "QuickPIM++ continues automatically after sign-in and closes its temporary tabs when access is ready."
            : "QuickPIM++ opens the Microsoft pages it needs in the background and closes them when access is ready."}
        </p>
      </div>
      <div className="button-row initial-access-actions">
        {needsInteraction ? <button className="btn primary" onClick={onContinueSignIn}>Continue sign-in</button> : null}
        <button className="btn subtle" onClick={onDetails}>Access details</button>
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

function QuickFilterBar({
  activeFilters,
  onToggle
}: {
  activeFilters: Set<QuickFilter>;
  onToggle: (filter: QuickFilter) => void;
}) {
  const filters: Array<{ id: QuickFilter; label: string }> = [
    { id: "favorites", label: "Favorites" },
    { id: "eligible", label: "Eligible" },
    { id: "active", label: "Active" },
    { id: "requiresJustification", label: "Needs reason" }
  ];
  return (
    <div className="quick-filter-row" aria-label="Quick filters">
      {filters.map((filter) => (
        <button
          type="button"
          className={`filter-chip ${activeFilters.has(filter.id) ? "active" : ""}`}
          onClick={() => onToggle(filter.id)}
          key={filter.id}
          aria-pressed={activeFilters.has(filter.id)}
        >
          {filter.label}
        </button>
      ))}
    </div>
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
  showEnablementDetails,
  showLastEnablementDate,
  showRemainingActivationTime,
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
  showEnablementDetails: boolean;
  showLastEnablementDate: boolean;
  showRemainingActivationTime: boolean;
  onToggle?: (itemId: string) => void;
  onToggleFavorite?: (itemId: string) => void;
  readonly?: boolean;
}) {
  const [, refreshExpiredActionStates] = useState(0);
  const handleActivationExpired = useCallback(() => {
    refreshExpiredActionStates((current) => current + 1);
  }, []);

  if (!items.length) {
    return <EmptyState text="No eligible roles or groups found." />;
  }

  return (
    <div className="item-list">
      {items.map((item) => {
        const usage = getUsage(item, settings);
        const actionState = getRowActionState(item);
        const itemMode = actionState.mode;
        const isActionable = !readonly && actionState.selectable && Boolean(itemMode);
        const isSelectable = Boolean(isActionable && (!requestMode || requestMode === itemMode));
        const selected = isSelectable && selectedIds.has(item.id);
        const displayName = getDisplayName(item, settings, referenceData);
        const isFavorite = favoriteIds.has(item.id);
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
        const policySummary = showEnablementDetails ? getRowPolicySummary(item) : [];
        const rowTitle = actionState.reason || (!isSelectable && requestMode && itemMode ? `Clear the current selection to ${itemMode === "activate" ? "activate" : "deactivate"} this item.` : undefined);
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
              {policySummary.length ? (
                <details className="role-details" onClick={(event) => event.stopPropagation()}>
                  <summary>Details</summary>
                  <ul>
                    {policySummary.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
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
            </div>
          </>
        );

        if (!isActionable) {
          return (
            <div
              className={`role-row readonly ${statusRowClass}`}
              key={item.id}
              title={rowTitle}
            >
              {body}
            </div>
          );
        }

        return (
          <div
            className={`role-row selectable ${selected ? "selected" : ""} ${!isSelectable ? "disabled" : ""} ${statusRowClass}`}
            key={item.id}
            onClick={() => {
              if (isSelectable) {
                onToggle?.(item.id);
              }
            }}
            title={rowTitle}
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

function RemainingActivationTime({
  activeUntil,
  onExpired
}: {
  activeUntil: string;
  onExpired?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timeoutId: number | undefined;
    const scheduleNextUpdate = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const delay = getRemainingActivationTimeUpdateDelay(activeUntil, currentTime);
      if (delay !== undefined) {
        timeoutId = window.setTimeout(scheduleNextUpdate, delay);
      } else if (Date.parse(activeUntil) <= currentTime) {
        onExpired?.();
      }
    };
    scheduleNextUpdate();
    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeUntil, onExpired]);

  const remaining = formatRemainingActivationTime(activeUntil, now);
  if (!remaining) {
    return null;
  }
  return (
    <time
      className="remaining-activation-time"
      dateTime={activeUntil}
      title="Remaining PIM activation time"
      aria-label={`${remaining} remaining on PIM activation`}
    >
      {remaining}
    </time>
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
            maxLength={MAX_USER_JUSTIFICATION_LENGTH}
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

function ArrowUpRightIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="initial-access-arrow-icon">
      <path d="M5 19 19 5" />
      <path d="M9 5h10v10" />
    </svg>
  );
}

function SignInIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="initial-access-arrow-icon">
      <path d="M14 8l4 4-4 4" />
      <path d="M18 12H8" />
      <path d="M11 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5" />
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

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="field-icon-svg">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
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

function isMissingAccessSummary(message: string): boolean {
  const lines = message.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) =>
    /(?:graph|azure(?: management)?).*token.*(?:missing|expired)/i.test(line)
    || /(?:pim groups|microsoft graph) access is limited/i.test(line)
    || /captured token expired/i.test(line)
  );
}

function getItemByPersistedId(
  itemsById: ReadonlyMap<string, ActivationItem>,
  itemId: string
): ActivationItem | undefined {
  return itemsById.get(itemId) || itemsById.get(itemId.toLowerCase());
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function getActivationCacheView(
  cache: QuickPimDataCache,
  tokenStatus: TokenStatus,
  enabledRoleFeatures: AccessSetupTarget[],
  now: number
) {
  const tokenCacheKey = buildTokenCacheKey(tokenStatus);
  const targetCacheKeys = buildTargetCacheKeys(tokenStatus, enabledRoleFeatures);
  const legacyCacheKey = buildFeatureCacheKey(tokenCacheKey, enabledRoleFeatures);
  const eligibleCache = getTargetEntriesFromCache(cache, "eligible", enabledRoleFeatures, targetCacheKeys, {
    legacyCacheKey,
    now,
    freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS,
    usableTtlMs: STALE_ELIGIBLE_CACHE_TTL_MS
  });
  const activeCache = getTargetEntriesFromCache(cache, "active", enabledRoleFeatures, targetCacheKeys, {
    legacyCacheKey,
    now,
    freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
  });
  return {
    eligibleCache,
    activeCache,
    eligible: mergeTargetEntries(enabledRoleFeatures.map((target) => eligibleCache[target]?.entry), now, legacyCacheKey),
    active: mergeTargetEntries(enabledRoleFeatures.map((target) => activeCache[target]?.entry), now, legacyCacheKey)
  };
}

function getRequestModeForItem(item: ActivationItem | undefined): PopupRequestMode | undefined {
  const actionState = getRowActionState(item);
  return actionState.selectable ? actionState.mode : undefined;
}

async function fetchActivationSnapshot(targets: AccessSetupTarget[]): Promise<ActivationSnapshot> {
  try {
    const snapshot = await sendMessage<ActivationSnapshot>(
      {
        action: "getActivationSnapshot",
        targets
      },
      { timeoutMs: ACTIVATION_SNAPSHOT_TIMEOUT_MS, timeoutMessage: `${targets.map(tabLabel).join(", ")} refresh timed out. Cached data remains available.` }
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
