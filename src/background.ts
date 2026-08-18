import {
  applyActivationRequirements,
  buildActivationValidationRequest,
  buildDeactivationRequest,
  buildRolePolicyRequirementMap,
  buildActivationRequest,
  getActiveUntilFromScheduleInfo,
  getRoleDefinitionLookupKeys,
  normalizeActiveAssignmentType,
  normalizeAzureRole,
  normalizeDirectoryRole,
  normalizePimGroup
} from "./lib/pim";
import { azureManagementUrl, encodePathSegment, graphApiUrl } from "./lib/apiUrls";
import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./lib/apiErrors";
import { mapWithConcurrency, mapWithConcurrencySettled } from "./lib/concurrency";
import { collectPaginatedValues } from "./lib/pagination";
import { withAbortableTimeout } from "./lib/async";
import { runWithActivationItemLock } from "./lib/requestGate";
import {
  addRecentJustification,
  compareAndSetSettings,
  getEnabledRoleFeatures,
  loadSettings,
  loadSettingsSnapshot,
  mergeSettings,
  mutateSettings,
  recordOperationActivity,
  runWithSettingsMutationLock,
  SETTINGS_KEY,
  SETTINGS_REVISION_KEY
} from "./lib/settings";
import {
  loadReferenceData,
  learnReferenceDataFromItems,
  saveReferenceData
} from "./lib/referenceData";
import {
  loadDataCache,
  saveDataCache,
  splitActivationResultByTarget,
  updateCacheFromTargetResults
} from "./lib/cache";
import {
  buildNameLookupDiagnostic,
  buildTargetCacheKeys,
  classifyAccessFailure,
  hasRequiredPortalToken
} from "./lib/access";
import {
  PRE_REFRESH_ALARM_NAME,
  getPreRefreshTargets,
  shouldSkipPreRefresh,
  syncPreRefreshAlarm
} from "./lib/preRefresh";
import {
  REQUEST_TRACKING_ALARM_NAME,
  REQUEST_TRACKING_AZURE_CONCURRENCY,
  REQUEST_TRACKING_GRAPH_CONCURRENCY,
  EXPIRY_REMINDER_RETRY_DELAY_MS,
  clearTrackedRequests,
  createTrackedPimRequest,
  getDueTrackedRequests,
  getActivationRequestItemStatus,
  getEffectiveTrackedRequestStatus,
  getPendingTrackedRequestCount,
  getRequestTrackingMaintenanceTime,
  getTrackedExpiryReminderDecision,
  isTrackedRequestPending,
  loadTrackedRequests,
  markTrackedRequestCheckFailure,
  reconcileTrackedRequestWithActiveAssignments,
  mutateTrackedRequests,
  runWithTrackedRequestMutationLock,
  saveTrackedRequests,
  sanitizeTrackedRequestStore,
  reconcileTrackedExtensionSources,
  trackedRequestMatchesValidatedToken,
  trackedRequestStatusLabel,
  updateTrackedRequestFromPayload,
  upsertTrackedRequests,
  REQUEST_TRACKING_KEY
} from "./lib/requestTracking";
import {
  getPortalTokenRecoveryTargets,
  getStaleCacheTargets,
  recordPortalTokenScanDiagnostic,
  scanOpenEntraTabs
} from "./lib/portalTokenRefresh";
import {
  PORTAL_RECOVERY_CLEANUP_ALARM_NAME,
  PORTAL_RECOVERY_SESSION_TTL_MS,
  PORTAL_RECOVERY_VERIFY_ALARM_NAME,
  closeExpiredPortalRecoveryTabs,
  closeOrphanedPortalRecoveryTabs,
  closePortalRecoveryTabsForTargets,
  focusPortalRecoveryTabs,
  getPortalRecoveryJourneyCreatedAt,
  getPortalRecoveryTokenSignature,
  getPortalRecoveryStatus,
  isPortalRecoveryManagedTabId,
  openPortalRecoveryTabsAndReconcile,
  type PortalRecoveryApis
} from "./lib/portalRecoveryTabs";
import { getApiVerifiedPortalRecoveryTargets } from "./lib/portalRecoveryVerification";
import {
  getRequiredGraphActivationScopes,
  getGraphTokenAuthStrengthScore,
  getGraphTokenOverallScore,
  getGraphTokenTargetScore,
  getGraphTokenTargets,
  hasGraphActivationScope,
  type GraphTokenTarget
} from "./lib/graphTokenCapabilities";
import { isTrustedRuntimeSender, validateQuickPimMessage } from "./lib/messages";
import {
  EXTENSION_RESET_PENDING_KEY,
  resetExtensionData,
  resumePendingExtensionReset
} from "./lib/extensionReset";
import { isPrivilegedAzureRoleDefinition } from "./lib/privilegedRoles";
import {
  assertAllowedApiUrl,
  getAllowedTokenKindForUrl,
  isAllowedPortalTokenSource,
  sanitizeErrorMessage,
  validateCapturedToken
} from "./lib/security";
import { assertFreshToken, decodeToken, makeTokenStatus } from "./lib/token";
import { shouldAllowCapturedTokenIdentityChange } from "./lib/tokenCapture";
import { selectBestStoredGraphTokenForTarget, selectPortalTokenCandidates } from "./lib/tokenCandidates";
import {
  beginRequestOperation,
  completeRequestOperation,
  createRequestOperationItems,
  dismissRequestOperations,
  failRequestOperation,
  getRequestOperationFingerprint,
  loadRequestOperations,
  trackedRequestMatchesOperation,
  touchRequestOperation,
  updateRequestOperationItem
} from "./lib/requestOperations";
import {
  activationItemIdentitiesMatch,
  getActivationItemIdentity,
  normalizeActivationItemId
} from "./lib/activationIdentity";
import {
  NOTIFICATION_TEST_ID,
  NOTIFICATION_TEST_RESULT_ID,
  getNotificationTestButtonResult
} from "./lib/notificationTest";
import {
  getAccessRecoveryTargets,
  getClaimsChallengeRecoveryTargets,
  getPortalRecoveryFailureMessage,
  getFreshAccessRecoveryTargets,
  isFreshPortalTokenRequired,
  mergeRetriedActivationResponse,
  replaceAccessRecoveryErrors,
  shouldFocusPortalRecovery
} from "./lib/requestRecovery";
import {
  buildTrackedRequestExtensionPlan,
  formatExtensionDuration,
  requireTrackedRequestExtensionRequestId
} from "./lib/requestExtension";
import {
  formatUnknownWriteOutcome,
  isAmbiguousMicrosoftWriteFailure,
  isTransientMicrosoftFailure
} from "./lib/requestOutcome";
import { retryOnceIf } from "./lib/retry";
import {
  clearStoredTokens,
  getStoredTokensFromSession,
  removeStoredTokenGroupsIfMatching,
  TOKEN_STORAGE_KEYS,
  updateStoredTokensInSession,
  type StoredTokens
} from "./lib/tokenStorage";
import {
  applyDistributionActionIcon,
  getExtensionDistributionInfo,
  type ExtensionDistributionInfo
} from "./lib/distribution";
import {
  BROWSER_SYNC_ALARM_NAME,
  dismissBrowserSyncReminder,
  getBrowserSyncInstallationIdentity,
  getBrowserSyncStatus,
  initializeBrowserSyncAccess,
  isBrowserSyncDeviceStorageKey,
  isBrowserSyncPayloadStorageKey,
  markBrowserSyncReminderShown,
  purgeBrowserSyncData,
  queueBrowserSyncPurgeRetry,
  renameBrowserSyncDevice,
  setBrowserSyncEnabled,
  synchronizeBrowserData,
  updateBrowserSyncDeviceName,
  type BrowserSyncApis,
  type BrowserSyncStatus
} from "./lib/browserSync";
import type {
  ActivationItem,
  ActivationDataResult,
  ActivationRequest,
  ActivationResult,
  ActivationSnapshot,
  ActivationResponse,
  ActivationStatus,
  AccessDiagnostic,
  AccessSetupTarget,
  AzureRoleApi,
  DirectoryRoleDefinitionApi,
  DirectoryRoleApi,
  GroupInfo,
  PimGroupApi,
  PortalTokenRefreshResult,
  RequestOperationRecord,
  RoleManagementPolicyAssignmentApi,
  TicketInfo,
  TokenKind,
  TokenStatus,
  TrackedRequestExtensionResult,
  TrackedPimRequest,
  TrackedPimRequestStatus,
  TrackedPimRequestStore
} from "./lib/types";

type ActivationRequirements = NonNullable<ActivationItem["activationRequirements"]>;
interface ActivationSubmissionOptions {
  startDateTime?: string;
  continuationOfRequestId?: string;
  operationId?: string;
}
interface ActivationWriteResponse {
  payload: unknown;
  location?: string;
}
interface ActivationSnapshotFetchResult {
  eligibleItems: ActivationItem[];
  activeItems: ActivationItem[];
  eligibleError?: string;
  activeError?: string;
}
interface AzureRoleScope {
  scope: string;
  displayName: string;
  subscriptionId?: string;
}
interface AzureRoleScopeResult {
  scopes: AzureRoleScope[];
  warnings: string[];
}
interface AzureRoleLoadResult {
  items: ActivationItem[];
  warnings: string[];
}
interface AzureManagementGroupApi {
  id?: string;
  name?: string;
  properties?: { displayName?: string };
}

class PartialActivationDataError extends Error {
  constructor(message: string, readonly items: ActivationItem[]) {
    super(message);
    this.name = "PartialActivationDataError";
  }
}
interface AzureRoleDefinitionResponse {
  properties?: {
    roleName?: string;
    permissions?: Array<{
      actions?: string[];
      dataActions?: string[];
    }>;
  };
}

interface AzureRoleDefinitionInfo {
  displayName: string;
  isPrivileged?: boolean;
}

interface GraphBatchResponse<T> {
  responses?: Array<{
    id?: string;
    status?: number;
    headers?: Record<string, string>;
    body?: T;
  }>;
}

const REQUEST_HEADER_OPTIONS = ["requestHeaders", "extraHeaders"];
const MICROSOFT_API_READ_TIMEOUT_MS = 12_000;
const MICROSOFT_API_WRITE_TIMEOUT_MS = 45_000;
const MICROSOFT_API_WRITE_TOKEN_MIN_VALIDITY_MS = 5 * 60_000;
const REQUEST_PORTAL_RECOVERY_WAIT_TIMEOUT_MS = 90_000;
const REQUEST_PORTAL_RECOVERY_POLL_INTERVAL_MS = 750;
const TARGET_SNAPSHOT_TIMEOUT_MS = 22_000;
const GRAPH_BATCH_REQUEST_LIMIT = 20;
const TRANSIENT_READ_RETRY_DELAY_MS = 250;
let portalTokenRefreshInFlight: Promise<PortalTokenRefreshResult> | undefined;
let requestTrackingMaintenanceInFlight: Promise<TrackedPimRequestStore> | undefined;
let requestTrackingMaintenanceFollowUp: Promise<TrackedPimRequestStore> | undefined;
const pendingForcedTrackedRequestIds = new Set<string>();
let forceAllTrackedRequestMaintenance = false;
let backgroundPreRefreshInFlight: Promise<void> | undefined;
let portalRecoveryVerificationInFlight: Promise<void> | undefined;
let portalRecoveryVerificationFollowUpRequested = false;
let portalRecoveryVerificationTimer: ReturnType<typeof setTimeout> | undefined;
let portalRecoveryVerificationDueAt = 0;
let browserSyncInFlight: Promise<BrowserSyncStatus> | undefined;
let browserSyncFollowUp: Promise<BrowserSyncStatus> | undefined;
let browserSyncChangeTimer: ReturnType<typeof setTimeout> | undefined;
let browserSyncChangeDueAt = 0;
let distributionInfoPromise: Promise<ExtensionDistributionInfo> | undefined;
let extensionResetInProgress = false;
let suppressBackgroundStorageEventsUntil = 0;
const bestEffortTasks = new Set<Promise<unknown>>();
const requestOperationTasks = new Map<string, { fingerprint: string; task: Promise<ActivationResponse> }>();
const requestExtensionTasks = new Map<string, Promise<TrackedRequestExtensionResult>>();
const REQUEST_TRACKING_NOTIFICATION_PREFIX = "quickpim-request:";
const BROWSER_SYNC_PERIOD_MINUTES = 30;
const BROWSER_SYNC_TRANSIENT_RETRY_MINUTES = 5;
// A changed snapshot needs two ordered cloud writes (chunks, then manifest).
// Waiting for a short quiet period keeps sustained edits below the browser's
// hourly write budget while remote delivery can still be consumed promptly.
const BROWSER_SYNC_LOCAL_CHANGE_DEBOUNCE_MS = 30_000;
const BROWSER_SYNC_REMOTE_CHANGE_DEBOUNCE_MS = 2_000;
const PORTAL_RECOVERY_VERIFY_DELAY_MS = 1_500;
const PORTAL_RECOVERY_VERIFY_RETRY_MS = 30_000;
const PORTAL_RECOVERY_CLEANUP_RETRY_MS = 60_000;

const ENDPOINT_LABELS: Record<AccessSetupTarget, { eligible: string; active: string }> = {
  directoryRole: {
    eligible: "Entra role eligibility",
    active: "Entra role active assignments"
  },
  pimGroup: {
    eligible: "PIM group eligibility",
    active: "PIM group active assignments"
  },
  azureRole: {
    eligible: "Azure role eligibility",
    active: "Azure role active assignments"
  }
};

chrome.webRequest.onSendHeaders.addListener(
  (details) => runBestEffort(runIfExtensionEnabled(() => captureToken(details))),
  { urls: ["https://graph.microsoft.com/*", "https://management.azure.com/*"] },
  REQUEST_HEADER_OPTIONS
);

runBestEffort(initializeBackgroundRuntime());

chrome.runtime.onInstalled?.addListener(() => {
  distributionInfoPromise = undefined;
  runBestEffort(initializeBackgroundRuntime(true));
});

chrome.runtime.onStartup?.addListener(() => {
  distributionInfoPromise = undefined;
  runBestEffort(initializeBackgroundRuntime(true));
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (extensionResetInProgress || Date.now() < suppressBackgroundStorageEventsUntil) return;
  if (areaName === "local" && changes[SETTINGS_KEY]?.newValue) {
    runBestEffort(runIfExtensionEnabled(async () => {
      await Promise.all([
        initializeBackgroundRefresh(),
        initializeRequestTracking(),
        initializePortalRecoveryLifecycle()
      ]);
    }));
    scheduleBrowserSyncAfterStorageChange(BROWSER_SYNC_LOCAL_CHANGE_DEBOUNCE_MS);
  }
  if (areaName === "local" && changes[REQUEST_TRACKING_KEY]) {
    runBestEffort(runIfExtensionEnabled(initializeRequestTracking));
  }
  if (areaName === "sync" && Object.keys(changes).some((key) =>
    isBrowserSyncPayloadStorageKey(key) || isBrowserSyncDeviceStorageKey(key)
  )) {
    // Browser sync can deliver a manifest before its chunks. Queue one
    // follow-up pass even when a sync is already running so the completed
    // generation is consumed as soon as the remaining change events arrive.
    scheduleBrowserSyncAfterStorageChange(BROWSER_SYNC_REMOTE_CHANGE_DEBOUNCE_MS);
  }
});

function notificationPermissionRemoved(permissions: chrome.permissions.Permissions): void {
  if (permissions.permissions?.includes("notifications")) {
    runBestEffort(runIfExtensionEnabled(initializeRequestTracking));
  }
}

function notificationPermissionAdded(permissions: chrome.permissions.Permissions): void {
  if (!permissions.permissions?.includes("notifications")) return;
  registerNotificationListeners();
  runBestEffort(runIfExtensionEnabled(async () => {
    await mutateTrackedRequests((current) => ({
      version: 1,
      requests: current.requests.map((request) => request.expiryReminderSentAt
        ? request
        : { ...request, expiryReminderAttemptedAt: undefined })
    }));
    await initializeRequestTracking();
  }));
}

chrome.permissions?.onAdded?.addListener(notificationPermissionAdded);
chrome.permissions?.onRemoved?.addListener(notificationPermissionRemoved);

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (extensionResetInProgress) return;
  if (alarm.name === PRE_REFRESH_ALARM_NAME) {
    runBestEffort(runIfExtensionEnabled(runBackgroundPreRefresh));
  } else if (alarm.name === REQUEST_TRACKING_ALARM_NAME) {
    runBestEffort(runIfExtensionEnabled(runTrackedRequestMaintenance));
  } else if (alarm.name === PORTAL_RECOVERY_CLEANUP_ALARM_NAME) {
    runBestEffort(maintainPortalRecoveryCleanup());
  } else if (alarm.name === PORTAL_RECOVERY_VERIFY_ALARM_NAME) {
    runBestEffort(runIfExtensionEnabled(runPortalRecoveryVerification));
  } else if (alarm.name === BROWSER_SYNC_ALARM_NAME) {
    runBestEffort(runIfExtensionEnabled(runBrowserSync));
  }
});

let notificationListenersRegistered = false;

function trackedNotificationClicked(notificationId: string): void {
  if (!notificationId.startsWith(REQUEST_TRACKING_NOTIFICATION_PREFIX)) {
    return;
  }
  runBestEffort(runIfExtensionEnabled(async () => {
    await openTrackedRequestDetails();
    await clearNotification(notificationId);
  }));
}

function trackedNotificationButtonClicked(notificationId: string, buttonIndex: number): void {
  if (notificationId === NOTIFICATION_TEST_ID) {
    const result = getNotificationTestButtonResult(buttonIndex);
    if (!result) return;
    runBestEffort(runIfExtensionEnabled(async () => {
      await clearNotification(notificationId);
      await chrome.notifications.create(NOTIFICATION_TEST_RESULT_ID, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("img/QuickPim128.png"),
        title: result.title,
        message: result.message
      });
    }));
    return;
  }
  if (!notificationId.startsWith(REQUEST_TRACKING_NOTIFICATION_PREFIX)) {
    return;
  }
  if (notificationId.endsWith(":expiry-extend") && buttonIndex === 0) {
    runBestEffort(runIfExtensionEnabled(() => runWithServiceWorkerKeepAlive(
      () => handleExtensionNotificationClick(notificationId)
    )));
    return;
  }
  runBestEffort(runIfExtensionEnabled(async () => {
    await openTrackedRequestDetails();
    await clearNotification(notificationId);
  }));
}

function registerNotificationListeners(): void {
  if (notificationListenersRegistered || !chrome.notifications) return;
  chrome.notifications.onClicked?.addListener(trackedNotificationClicked);
  chrome.notifications.onButtonClicked?.addListener(trackedNotificationButtonClicked);
  notificationListenersRegistered = true;
}

registerNotificationListeners();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedRuntimeSender(sender)) {
    sendResponse({ success: false, error: "Untrusted QuickPIM++ message sender." });
    return false;
  }

  let validatedMessage: ReturnType<typeof validateQuickPimMessage>;
  try {
    validatedMessage = validateQuickPimMessage(message);
  } catch (error) {
    sendResponse({ success: false, error: sanitizeErrorMessage(error) });
    return false;
  }

  runIfExtensionEnabled(() => handleMessage(validatedMessage, sender), true)
    .then((data) => sendResponse({ success: true, data }))
    .catch((error: unknown) => {
      const message = sanitizeErrorMessage(error);
      sendResponse({ success: false, error: message });
    });
  return true;
});

async function getDistributionInfo(): Promise<ExtensionDistributionInfo> {
  distributionInfoPromise ||= getExtensionDistributionInfo();
  return distributionInfoPromise;
}

async function runIfExtensionEnabled<T>(operation: () => T | Promise<T>, rejectWhenBlocked = false): Promise<T | undefined> {
  const distribution = await getDistributionInfo();
  if (distribution.blockedInEdge) {
    if (rejectWhenBlocked) {
      throw new Error("This Chrome Web Store copy of QuickPIM++ is disabled in Microsoft Edge. Install the Microsoft Edge Add-ons edition.");
    }
    return undefined;
  }
  if (extensionResetInProgress) {
    if (rejectWhenBlocked) {
      throw new Error("QuickPIM++ is resetting its data. Wait for the reset to finish, then retry.");
    }
    return undefined;
  }
  return operation();
}

async function initializeEnabledBackgroundServices(runPreRefresh = false): Promise<void> {
  const distribution = await getDistributionInfo();
  if (distribution.blockedInEdge) {
    const recoveryApis = getPortalRecoveryApis();
    await Promise.allSettled([
      chrome.alarms?.clear?.(PRE_REFRESH_ALARM_NAME),
      chrome.alarms?.clear?.(REQUEST_TRACKING_ALARM_NAME),
      chrome.alarms?.clear?.(BROWSER_SYNC_ALARM_NAME),
      chrome.alarms?.clear?.(PORTAL_RECOVERY_CLEANUP_ALARM_NAME),
      chrome.alarms?.clear?.(PORTAL_RECOVERY_VERIFY_ALARM_NAME),
      chrome.action?.setBadgeText?.({ text: "" }),
      closePortalRecoveryTabsForTargets(["directoryRole", "pimGroup", "azureRole"], recoveryApis)
    ]);
    await closeOrphanedPortalRecoveryTabs(recoveryApis).catch(() => undefined);
    await applyDistributionActionIcon(distribution);
    return;
  }
  await applyDistributionActionIcon(distribution);
  await Promise.all([
    initializeBackgroundRefresh(),
    initializeRequestTracking(),
    initializeBrowserSync(),
    reconcilePendingRequestOperations(),
    initializePortalRecoveryLifecycle()
  ]);
  if (runPreRefresh) await runBackgroundPreRefresh();
}

async function initializeBackgroundRuntime(runPreRefresh = false): Promise<void> {
  if (extensionResetInProgress) return;
  extensionResetInProgress = true;
  let resumedReset = false;
  try {
    resumedReset = await resumePendingExtensionReset(chrome.storage.local, chrome.storage.session);
  } finally {
    extensionResetInProgress = false;
  }
  if (resumedReset) {
    suppressBackgroundStorageEventsUntil = Date.now() + 2_000;
    await Promise.allSettled([
      chrome.alarms?.clearAll?.(),
      chrome.action?.setBadgeText?.({ text: "" })
    ]);
  }
  await initializeEnabledBackgroundServices(runPreRefresh);
}

function getBrowserSyncApis(distribution?: ExtensionDistributionInfo): BrowserSyncApis {
  return {
    local: chrome.storage.local,
    sync: chrome.storage.sync,
    distribution: distribution || classifyFallbackDistribution()
  };
}

function classifyFallbackDistribution(): ExtensionDistributionInfo {
  return {
    browser: "other",
    distribution: "unknown",
    extensionId: chrome.runtime.id,
    blockedInEdge: false
  };
}

async function initializeBrowserSync(): Promise<void> {
  const distribution = await getDistributionInfo();
  await initializeBrowserSyncAccess(chrome.storage.sync);
  const status = await getBrowserSyncStatus(getBrowserSyncApis(distribution));
  if (status.supported && status.enabled) {
    await runBrowserSync();
  } else {
    await updateBrowserSyncAlarm(status);
  }
}

async function updateBrowserSyncAlarm(status: BrowserSyncStatus): Promise<void> {
  if (!chrome.alarms) return;
  if (status.supported && status.enabled) {
    const existing = await chrome.alarms.get(BROWSER_SYNC_ALARM_NAME);
    const retrySoon = isTransientBrowserSyncError(status.lastError);
    const retryDeadline = status.writeRetryAt && status.writeRetryAt > Date.now()
      ? status.writeRetryAt
      : Date.now() + BROWSER_SYNC_TRANSIENT_RETRY_MINUTES * 60_000;
    const retryDelayMinutes = Math.max(0.5, (retryDeadline - Date.now()) / 60_000);
    if (!existing || (retrySoon && (!existing.scheduledTime || existing.scheduledTime > retryDeadline + 5_000))) {
      chrome.alarms.create(BROWSER_SYNC_ALARM_NAME, {
        delayInMinutes: retrySoon ? retryDelayMinutes : 1,
        periodInMinutes: BROWSER_SYNC_PERIOD_MINUTES
      });
    }
  } else {
    await chrome.alarms.clear(BROWSER_SYNC_ALARM_NAME);
  }
}

function isTransientBrowserSyncError(error: string | undefined): boolean {
  return Boolean(error && /still arriving|temporar|unavailable|network|timed? out|rate limit|write operations|write quota|storage capacity/i.test(error));
}

function scheduleBrowserSyncAfterStorageChange(delayMs: number): void {
  browserSyncChangeDueAt = Math.max(browserSyncChangeDueAt, Date.now() + delayMs);
  if (browserSyncChangeTimer) clearTimeout(browserSyncChangeTimer);
  browserSyncChangeTimer = setTimeout(() => {
    browserSyncChangeTimer = undefined;
    browserSyncChangeDueAt = 0;
    runBestEffort(runIfExtensionEnabled(() => runBrowserSync(true)));
  }, Math.max(0, browserSyncChangeDueAt - Date.now()));
}

async function runBrowserSync(queueFollowUpIfBusy = false): Promise<BrowserSyncStatus> {
  if (browserSyncChangeTimer) {
    clearTimeout(browserSyncChangeTimer);
    browserSyncChangeTimer = undefined;
    browserSyncChangeDueAt = 0;
  }
  if (browserSyncInFlight) {
    if (!queueFollowUpIfBusy) return browserSyncInFlight;
    if (!browserSyncFollowUp) {
      const predecessor = browserSyncInFlight;
      const followUp = predecessor.catch(() => undefined).then(() => {
        if (browserSyncFollowUp === followUp) browserSyncFollowUp = undefined;
        return startBrowserSync();
      });
      browserSyncFollowUp = followUp;
    }
    return browserSyncFollowUp;
  }

  return startBrowserSync();
}

function startBrowserSync(): Promise<BrowserSyncStatus> {
  const task = (async () => {
    const distribution = await getDistributionInfo();
    const status = await synchronizeBrowserData(getBrowserSyncApis(distribution));
    await updateBrowserSyncAlarm(status);
    return status;
  })();
  browserSyncInFlight = task;
  const clearInFlight = () => {
    if (browserSyncInFlight === task) browserSyncInFlight = undefined;
  };
  void task.then(clearInFlight, clearInFlight);
  return task;
}

async function initializeBackgroundRefresh(): Promise<void> {
  if (!chrome.alarms) {
    return;
  }
  try {
    const settings = await loadSettings();
    await syncPreRefreshAlarm(chrome.alarms, settings.preferences.backgroundPreRefreshEnabled);
  } catch {
    await syncPreRefreshAlarm(chrome.alarms, true);
  }
}

function runBestEffort(operation: Promise<unknown>): void {
  bestEffortTasks.add(operation);
  const releaseTimer = setTimeout(() => bestEffortTasks.delete(operation), 2 * 60_000);
  void operation.then(
    () => {
      clearTimeout(releaseTimer);
      bestEffortTasks.delete(operation);
    },
    () => {
      clearTimeout(releaseTimer);
      bestEffortTasks.delete(operation);
    }
  );
}

async function initializeRequestTracking(): Promise<void> {
  try {
    const [store, settings] = await Promise.all([loadTrackedRequests(), loadSettings()]);
    await Promise.all([
      updateTrackedRequestBadge(store),
      scheduleTrackedRequestMaintenance(store, settings)
    ]);
  } catch {
    // Tracking is optional and must never interfere with activation or browser startup.
  }
}

function runTrackedRequestMaintenance(
  requestIds?: string[],
  force = false
): Promise<TrackedPimRequestStore> {
  if (requestTrackingMaintenanceInFlight) {
    if (!force) return requestTrackingMaintenanceInFlight;

    queueForcedTrackedRequestMaintenance(requestIds);
    if (!requestTrackingMaintenanceFollowUp) {
      const predecessor = requestTrackingMaintenanceInFlight;
      const followUp = predecessor.catch(() => undefined).then(() => {
        if (requestTrackingMaintenanceFollowUp === followUp) {
          requestTrackingMaintenanceFollowUp = undefined;
        }
        const queuedRequestIds = forceAllTrackedRequestMaintenance
          ? undefined
          : [...pendingForcedTrackedRequestIds];
        forceAllTrackedRequestMaintenance = false;
        pendingForcedTrackedRequestIds.clear();
        return startTrackedRequestMaintenance(queuedRequestIds, true);
      });
      requestTrackingMaintenanceFollowUp = followUp;
    }
    return requestTrackingMaintenanceFollowUp;
  }

  return startTrackedRequestMaintenance(requestIds, force);
}

function queueForcedTrackedRequestMaintenance(requestIds?: string[]): void {
  if (!requestIds?.length) {
    forceAllTrackedRequestMaintenance = true;
    pendingForcedTrackedRequestIds.clear();
    return;
  }
  if (forceAllTrackedRequestMaintenance) return;
  requestIds.forEach((requestId) => pendingForcedTrackedRequestIds.add(requestId));
}

function startTrackedRequestMaintenance(
  requestIds: string[] | undefined,
  force: boolean
): Promise<TrackedPimRequestStore> {
  const task = performTrackedRequestMaintenance(requestIds, force);
  requestTrackingMaintenanceInFlight = task;
  const clearInFlight = () => {
    if (requestTrackingMaintenanceInFlight === task) {
      requestTrackingMaintenanceInFlight = undefined;
    }
  };
  void task.then(clearInFlight, clearInFlight);
  return task;
}

async function performTrackedRequestMaintenance(
  requestIds: string[] | undefined,
  force: boolean
): Promise<TrackedPimRequestStore> {
  const now = Date.now();
  const [initialStore, settings] = await Promise.all([loadTrackedRequests(), loadSettings()]);
  const forcedIds = force
    ? requestIds?.length
      ? requestIds
      : initialStore.requests
        .filter((request) => isTrackedRequestPending(request) || request.status === "statusUnavailable")
        .map((request) => request.id)
    : requestIds;
  const dueRequests = getDueTrackedRequests(initialStore, now, forcedIds);
  const updates = new Map<string, TrackedPimRequest>();

  if (dueRequests.length) {
    const tokens = await getStoredTokens();
    const directoryRequests = dueRequests.filter((request) => request.itemType === "directoryRole");
    const pimGroupRequests = dueRequests.filter((request) => request.itemType === "pimGroup");
    const azureRequests = dueRequests.filter((request) => request.itemType === "azureRole");
    await Promise.all([
      pollDirectoryTrackedRequests(directoryRequests, tokens, updates, now),
      pollPimGroupTrackedRequests(pimGroupRequests, tokens, updates, now),
      pollAzureTrackedRequests(azureRequests, tokens, updates, now)
    ]);
  }

  const hasEffectiveStatusChanges = initialStore.requests.some(
    (request) => getEffectiveTrackedRequestStatus(request, now) !== request.status
  );
  const hasRetryableExtension = reconcileTrackedExtensionSources(initialStore, now) !== initialStore;
  const updatedStore = updates.size || hasEffectiveStatusChanges || hasRetryableExtension
    ? await mutateTrackedRequests((current) => reconcileTrackedExtensionSources({
      version: 1,
      requests: current.requests.map((request) => {
        const update = updates.get(request.id);
        if (update) {
          return { ...request, ...update };
        }
        const effectiveStatus = getEffectiveTrackedRequestStatus(request, now);
        return effectiveStatus === request.status
          ? request
          : { ...request, status: effectiveStatus, updatedAt: new Date(now).toISOString(), nextCheckAt: undefined };
      })
    }, now))
    : initialStore;
  const notifiedStore = await notifyTrackedRequestChanges(initialStore, updatedStore, settings, now);
  await Promise.all([
    updateTrackedRequestBadge(notifiedStore),
    scheduleTrackedRequestMaintenance(notifiedStore, settings)
  ]);
  return notifiedStore;
}

async function pollDirectoryTrackedRequests(
  requests: TrackedPimRequest[],
  tokens: StoredTokens,
  updates: Map<string, TrackedPimRequest>,
  now: number
): Promise<void> {
  if (!requests.length) return;
  const token = getGraphTokenForTarget(tokens, "directoryRole");
  const trackable = markRequestsWaitingForMatchingToken(requests, token, updates, now);
  if (!token || !trackable.length) return;

  try {
    const payloads = await fetchAllPages<Record<string, unknown>>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      token
    );
    await updateRequestsFromPayloadCollection(
      trackable,
      payloads,
      updates,
      now,
      (request) => fetchJson<Record<string, unknown>>(
        graphApiUrl(`/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/${encodePathSegment(request.requestId)}`),
        token
      )
    );
    await reconcileRequestsWithActiveAssignments(trackable, updates, now, () => getActiveDirectoryRoles(token));
  } catch (error) {
    for (const request of trackable) {
      updates.set(request.id, markTrackedRequestCheckFailure(request, error, now));
    }
  }
}

async function pollPimGroupTrackedRequests(
  requests: TrackedPimRequest[],
  tokens: StoredTokens,
  updates: Map<string, TrackedPimRequest>,
  now: number
): Promise<void> {
  if (!requests.length) return;
  const token = getGraphTokenForTarget(tokens, "pimGroup");
  const trackable = markRequestsWaitingForMatchingToken(requests, token, updates, now);
  if (!token || !trackable.length) return;

  const byPrincipal = new Map<string, TrackedPimRequest[]>();
  for (const request of trackable) {
    const group = byPrincipal.get(request.principalId) || [];
    group.push(request);
    byPrincipal.set(request.principalId, group);
  }
  await mapWithConcurrency([...byPrincipal.entries()], REQUEST_TRACKING_GRAPH_CONCURRENCY, async ([principalId, principalRequests]) => {
    try {
      const filter = new URLSearchParams({ "$filter": `principalId eq '${escapeODataString(principalId)}'` });
      const payloads = await fetchAllPages<Record<string, unknown>>(
        graphApiUrl(`/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests?${filter.toString()}`),
        token
      );
      await updateRequestsFromPayloadCollection(
        principalRequests,
        payloads,
        updates,
        now,
        (request) => fetchJson<Record<string, unknown>>(
          graphApiUrl(`/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/${encodePathSegment(request.requestId)}`),
          token
        )
      );
    } catch (error) {
      for (const request of principalRequests) {
        updates.set(request.id, markTrackedRequestCheckFailure(request, error, now));
      }
    }
  });
  await reconcileRequestsWithActiveAssignments(trackable, updates, now, () => getActivePimGroups(token));
}

async function pollAzureTrackedRequests(
  requests: TrackedPimRequest[],
  tokens: StoredTokens,
  updates: Map<string, TrackedPimRequest>,
  now: number
): Promise<void> {
  if (!requests.length) return;
  const token = tokens.azureManagementToken;
  const trackable = markRequestsWaitingForMatchingToken(requests, token, updates, now);
  if (!token || !trackable.length) return;

  await mapWithConcurrency(trackable, REQUEST_TRACKING_AZURE_CONCURRENCY, async (request) => {
    try {
      const scope = getSafeTrackedAzureScope(request.azureScope);
      const endpoint = azureManagementUrl(
        `${scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${encodePathSegment(request.requestId)}?api-version=2020-10-01`
      );
      const payload = await fetchJson<Record<string, unknown>>(endpoint, token);
      updates.set(request.id, updateTrackedRequestFromPayload(request, payload, now));
    } catch (error) {
      updates.set(request.id, markTrackedRequestCheckFailure(request, error, now));
    }
  });
  await reconcileRequestsWithActiveAssignments(trackable, updates, now, () => getActiveAzureRoles(token));
}

async function reconcileRequestsWithActiveAssignments(
  requests: TrackedPimRequest[],
  updates: Map<string, TrackedPimRequest>,
  now: number,
  loadActiveItems: () => Promise<ActivationItem[]>
): Promise<void> {
  const candidates = requests
    .map((request) => updates.get(request.id) || request)
    .filter((request) => request.action === "activate"
      && getEffectiveTrackedRequestStatus(request, now) === "active"
      && !request.activeUntil);
  if (!candidates.length) return;

  try {
    const activeItems = await loadActiveItems();
    for (const request of candidates) {
      updates.set(request.id, reconcileTrackedRequestWithActiveAssignments(request, activeItems, now));
    }
  } catch (error) {
    for (const request of candidates) {
      updates.set(request.id, markTrackedRequestCheckFailure(request, error, now));
    }
  }
}

function markRequestsWaitingForMatchingToken(
  requests: TrackedPimRequest[],
  token: string | undefined,
  updates: Map<string, TrackedPimRequest>,
  now: number
): TrackedPimRequest[] {
  const trackable: TrackedPimRequest[] = [];
  for (const request of requests) {
    if (token && trackedRequestMatchesValidatedToken(request, token, now)) {
      trackable.push(request);
    } else {
      updates.set(request.id, markTrackedRequestCheckFailure(
        request,
        "Waiting for matching Microsoft portal access.",
        now,
        { waitingForAccess: true }
      ));
    }
  }
  return trackable;
}

async function updateRequestsFromPayloadCollection(
  requests: TrackedPimRequest[],
  payloads: Record<string, unknown>[],
  updates: Map<string, TrackedPimRequest>,
  now: number,
  fetchMissing?: (request: TrackedPimRequest) => Promise<Record<string, unknown>>
): Promise<void> {
  const byId = new Map(payloads.flatMap((payload) => {
    const id = getResponseIdentifier(payload);
    return id ? [[id.toLowerCase(), payload] as const] : [];
  }));
  await mapWithConcurrency(requests, REQUEST_TRACKING_GRAPH_CONCURRENCY, async (request) => {
    const payload = byId.get(request.requestId.toLowerCase());
    if (payload) {
      updates.set(request.id, updateTrackedRequestFromPayload(request, payload, now));
      return;
    }
    if (fetchMissing) {
      try {
        const directPayload = await fetchMissing(request);
        updates.set(request.id, updateTrackedRequestFromPayload(request, directPayload, now));
        return;
      } catch {
        // Eventual consistency is expected immediately after submission. Do not
        // consume the long-running request's retry budget while it is invisible.
      }
    }
    updates.set(request.id, markTrackedRequestCheckFailure(
      request,
      "Microsoft has not exposed this request status yet.",
      now,
      { waitingForVisibility: true }
    ));
  });
}

async function notifyTrackedRequestChanges(
  previousStore: TrackedPimRequestStore,
  nextStore: TrackedPimRequestStore,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  now: number
): Promise<TrackedPimRequestStore> {
  if (!settings.preferences.requestNotificationsEnabled || !(await hasNotificationPermission())) {
    return nextStore;
  }

  const previousById = new Map(previousStore.requests.map((request) => [request.id, request]));
  const patches = new Map<string, Partial<TrackedPimRequest>>();
  const reminderMinutes = settings.preferences.expiryReminderMinutes;
  await mapWithConcurrency(nextStore.requests, 3, async (request) => {
    const previous = previousById.get(request.id);
    const status = getEffectiveTrackedRequestStatus(request, now);
    const lastStatusAttempt = request.notificationLastAttemptAt
      ? Date.parse(request.notificationLastAttemptAt)
      : Number.NaN;
    const statusRetryReady = !Number.isFinite(lastStatusAttempt)
      || now >= lastStatusAttempt + EXPIRY_REMINDER_RETRY_DELAY_MS;
    if (
      previous
      && previous.status !== status
      && isNotifiableRequestStatus(status)
      && request.notifiedStatus !== status
      && statusRetryReady
    ) {
      const delivery = await showTrackedRequestNotification(request, status);
      patches.set(request.id, {
        notificationLastAttemptAt: new Date(now).toISOString(),
        ...(delivery.shown ? { notifiedStatus: status, notificationLastError: undefined } : { notificationLastError: delivery.error })
      });
    }

    const reminderDecision = getTrackedExpiryReminderDecision(request, reminderMinutes, now);
    if (reminderDecision) {
      const delivery = reminderDecision === "upcoming"
        ? await showExpiryReminderNotification(
            request,
            reminderMinutes,
            settings.preferences.defaultExtensionDurationHours
          )
        : await showMissedExpiryReminderNotification(request);
      patches.set(request.id, {
        ...patches.get(request.id),
        expiryReminderAttemptedAt: new Date(now).toISOString(),
        notificationLastAttemptAt: new Date(now).toISOString(),
        ...(delivery.shown
          ? { expiryReminderSentAt: new Date(now).toISOString(), notificationLastError: undefined }
          : { notificationLastError: delivery.error })
      });
    }
  });

  if (!patches.size) {
    return nextStore;
  }
  return mutateTrackedRequests((current) => ({
    version: 1,
    requests: current.requests.map((request) => ({ ...request, ...patches.get(request.id) }))
  }));
}

interface NotificationDeliveryResult {
  shown: boolean;
  error?: string;
}

async function showMissedExpiryReminderNotification(request: TrackedPimRequest): Promise<NotificationDeliveryResult> {
  return createRequestNotification(
    request,
    "PIM access expired",
    `${request.itemName} expired while this browser was unavailable.`,
    "expired",
    "expiry-missed",
    [{ title: "View details" }]
  );
}

async function showTrackedRequestNotification(
  request: TrackedPimRequest,
  status: TrackedPimRequestStatus
): Promise<NotificationDeliveryResult> {
  const action = request.action === "activate" ? "activation" : "deactivation";
  const message = status === "active"
    ? `${request.itemName} is now active.`
    : status === "completed"
      ? `${request.itemName} deactivation completed.`
      : `${request.itemName} ${action} was ${trackedRequestStatusLabel(status).toLowerCase()}.`;
  return createRequestNotification(request, `Request ${trackedRequestStatusLabel(status).toLowerCase()}`, message, status);
}

async function showExpiryReminderNotification(
  request: TrackedPimRequest,
  reminderMinutes: number,
  preferredExtensionDurationHours: number
): Promise<NotificationDeliveryResult> {
  let extensionDurationHours: number | undefined;
  try {
    extensionDurationHours = buildTrackedRequestExtensionPlan(
      request,
      preferredExtensionDurationHours
    ).durationHours;
  } catch {
    // Existing legacy requests may not contain enough metadata for one-click continuation.
  }
  return createRequestNotification(
    request,
    "PIM access expiring soon",
    `${request.itemName} expires in about ${reminderMinutes} minutes.`,
    "active",
    extensionDurationHours ? "expiry-extend" : "expiry-details",
    extensionDurationHours
      ? [
          { title: `Extend ${formatExtensionDuration(extensionDurationHours)}` },
          { title: "View details" }
        ]
      : [{ title: "View details" }]
  );
}

async function createRequestNotification(
  request: TrackedPimRequest,
  title: string,
  message: string,
  status: TrackedPimRequestStatus,
  suffix = "status",
  buttons?: chrome.notifications.ButtonOptions[]
): Promise<NotificationDeliveryResult> {
  try {
    await chrome.notifications.create(
      `${getTrackedNotificationPrefix(request)}${status}:${suffix}`,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("img/QuickPim128.png"),
        title,
        message,
        contextMessage: buttons?.length ? "Choose an action below or click to open details." : "Click to open request details.",
        ...(buttons?.length ? { buttons } : {})
      }
    );
    return { shown: true };
  } catch (error) {
    return { shown: false, error: sanitizeErrorMessage(error) };
  }
}

async function openTrackedRequestDetails(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#activity") });
}

async function handleExtensionNotificationClick(notificationId: string): Promise<void> {
  const store = await loadTrackedRequests();
  const request = store.requests.find((candidate) =>
    notificationId.startsWith(getTrackedNotificationPrefix(candidate))
  );
  if (!request) {
    await createStandaloneRequestNotification(
      "Extension could not be prepared",
      "The tracked request is no longer available. Open Activity for current request details."
    );
    return;
  }

  const result = await extendTrackedRequest(request.id);
  await createStandaloneRequestNotification(
    result.success ? "PIM extension queued" : "PIM extension needs attention",
    result.message
  );
  if (result.success) await clearNotification(notificationId);
}

function getTrackedNotificationPrefix(request: TrackedPimRequest): string {
  return `${REQUEST_TRACKING_NOTIFICATION_PREFIX}${encodeURIComponent(request.id)}:${encodeURIComponent(request.requestId)}:`;
}

async function clearNotification(notificationId: string): Promise<void> {
  if (!chrome.notifications?.clear) return;
  await chrome.notifications.clear(notificationId);
}

async function clearTrackedRequestNotifications(): Promise<void> {
  if (!chrome.notifications?.getAll) return;
  const notifications = await new Promise<object>((resolve) => chrome.notifications.getAll(resolve));
  await Promise.allSettled(Object.keys(notifications)
    .filter((notificationId) => notificationId.startsWith(REQUEST_TRACKING_NOTIFICATION_PREFIX))
    .map((notificationId) => clearNotification(notificationId)));
}

async function createStandaloneRequestNotification(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create(
      `${REQUEST_TRACKING_NOTIFICATION_PREFIX}result:${crypto.randomUUID()}`,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("img/QuickPim128.png"),
        title,
        message,
        contextMessage: "Click to open request details."
      }
    );
  } catch {
    // Request status remains available in Settings > Activity.
  }
}

async function runWithServiceWorkerKeepAlive<T>(task: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo?.().catch(() => undefined);
  }, 20_000);
  try {
    return await task();
  } finally {
    clearInterval(keepAlive);
  }
}

async function hasNotificationPermission(): Promise<boolean> {
  if (!chrome.notifications || !chrome.permissions?.contains) {
    return false;
  }
  try {
    return await chrome.permissions.contains({ permissions: ["notifications"] });
  } catch {
    return false;
  }
}

async function updateTrackedRequestBadge(store: TrackedPimRequestStore): Promise<void> {
  if (!chrome.action?.setBadgeText) return;
  const count = getPendingTrackedRequestCount(store);
  const text = count > 99 ? "99+" : count ? String(count) : "";
  await chrome.action.setBadgeText({ text });
  if (text && chrome.action.setBadgeBackgroundColor) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  }
}

async function scheduleTrackedRequestMaintenance(
  store: TrackedPimRequestStore,
  settings: Awaited<ReturnType<typeof loadSettings>>
): Promise<void> {
  if (!chrome.alarms) return;
  const notificationsEnabled = settings.preferences.requestNotificationsEnabled && await hasNotificationPermission();
  const when = getRequestTrackingMaintenanceTime(store, {
    notificationsEnabled,
    expiryReminderMinutes: settings.preferences.expiryReminderMinutes
  });
  if (!when) {
    await chrome.alarms.clear(REQUEST_TRACKING_ALARM_NAME);
    return;
  }
  const existing = await chrome.alarms.get(REQUEST_TRACKING_ALARM_NAME);
  if (existing && Math.abs(existing.scheduledTime - when) < 1_000) {
    return;
  }
  await chrome.alarms.create(REQUEST_TRACKING_ALARM_NAME, { when });
}

function isNotifiableRequestStatus(status: TrackedPimRequestStatus): boolean {
  return status === "active" || status === "completed" || status === "denied" || status === "failed" || status === "canceled";
}

function getSafeTrackedAzureScope(value: string | undefined): string {
  if (
    !value
    || !value.startsWith("/")
    || value.includes("?")
    || value.includes("#")
    || value.includes("\\")
    || value.split("/").includes("..")
    || !(/^\/subscriptions\/[^/]+(?:\/.*)?$/i.test(value) || /^\/providers\/Microsoft\.Management\/managementGroups\/[^/]+(?:\/.*)?$/i.test(value))
  ) {
    throw new Error("Tracked Azure request scope is invalid.");
  }
  return value.replace(/\/$/, "");
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

async function runBackgroundPreRefresh(): Promise<void> {
  if (backgroundPreRefreshInFlight) {
    return backgroundPreRefreshInFlight;
  }
  const refresh = performBackgroundPreRefresh();
  const refreshWithCleanup = refresh.finally(() => {
    backgroundPreRefreshInFlight = undefined;
  });
  backgroundPreRefreshInFlight = refreshWithCleanup;
  return refreshWithCleanup;
}

async function performBackgroundPreRefresh(): Promise<void> {
  const refreshStartedAt = Date.now();
  const recoveryJourneyCreatedAt = await getPortalRecoveryJourneyCreatedAt(getPortalRecoveryApis());
  const settings = await loadSettings();
  if (!settings.preferences.backgroundPreRefreshEnabled) {
    await syncPreRefreshAlarm(chrome.alarms, false);
    return;
  }

  const enabledRoleFeatures = getEnabledRoleFeatures(settings);
  const [dataCache, initialTokenStatus] = await Promise.all([loadDataCache(), getTokenStatus()]);
  const staleBeforeTokenRecovery = getStaleCacheTargets({
    cache: dataCache,
    enabledTargets: enabledRoleFeatures,
    tokenStatus: initialTokenStatus
  });
  const tokenRecoveryTargets = getPortalTokenRecoveryTargets({
    cache: dataCache,
    enabledTargets: enabledRoleFeatures,
    staleTargets: staleBeforeTokenRecovery,
    tokenStatus: initialTokenStatus
  });
  const tokenStatus = tokenRecoveryTargets.length
    ? (await refreshPortalTokensFromOpenTabs()).tokenStatus
    : initialTokenStatus;
  if (shouldSkipPreRefresh(tokenStatus)) {
    return;
  }

  const targets = getPreRefreshTargets({
    cache: dataCache,
    enabledTargets: enabledRoleFeatures,
    tokenStatus
  });
  if (!targets.length) {
    return;
  }

  const snapshot = await getActivationSnapshot(targets);
  const fetchedAt = Date.now();
  const snapshotTokenStatus = snapshot.tokenStatus || tokenStatus;
  const targetCacheKeys = buildTargetCacheKeys(snapshotTokenStatus, enabledRoleFeatures);
  let nextCache = updateCacheFromTargetResults(
    dataCache,
    "eligible",
    targets,
    snapshot.eligibleByTarget || splitActivationResultByTarget(snapshot.eligible, targets),
    fetchedAt,
    targetCacheKeys,
    refreshStartedAt
  );
  nextCache = updateCacheFromTargetResults(
    nextCache,
    "active",
    targets,
    snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, targets),
    fetchedAt,
    targetCacheKeys,
    refreshStartedAt
  );

  await saveDataCache(nextCache);
  const referenceData = learnReferenceDataFromItems(await loadReferenceData(), [...snapshot.eligible.items, ...snapshot.active.items]);
  await saveReferenceData(referenceData);
  if (recoveryJourneyCreatedAt !== undefined) {
    await closeVerifiedRecoveryTabs(
      await getTokenStatus(),
      await loadDataCache(),
      targets,
      recoveryJourneyCreatedAt
    );
  }
}

async function handleMessage(message: ReturnType<typeof validateQuickPimMessage>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.action) {
    case "getTokenStatus":
      return getTokenStatus();
    case "getSettingsSnapshot":
      return loadSettingsSnapshot();
    case "initializeNotificationDelivery":
      // Optional permissions can become available after an MV3 worker has
      // already started. Re-run registration from an explicit page handshake;
      // the top-level registration still handles later worker restarts.
      registerNotificationListeners();
      await initializeRequestTracking();
      return {
        apiAvailable: Boolean(chrome.notifications),
        listenersRegistered: notificationListenersRegistered
      };
    case "compareAndSetSettings":
      return compareAndSetSettings(message.expectedRevision, message.settings);
    case "getBrowserSyncStatus":
      return getBrowserSyncStatus(getBrowserSyncApis(await getDistributionInfo()));
    case "getBrowserSyncPopupStatus": {
      const apis = getBrowserSyncApis(await getDistributionInfo());
      const status = await getBrowserSyncStatus(apis);
      if (status.reminderDue) await markBrowserSyncReminderShown(apis);
      return status;
    }
    case "syncBrowserData":
      // A user-triggered sync must not be satisfied only by an alarm run that
      // was already in progress when they clicked. Queue one fresh pass so
      // edits made during that run are included before the response resolves.
      return runBrowserSync(true);
    case "setBrowserSyncEnabled": {
      const status = await setBrowserSyncEnabled(
        getBrowserSyncApis(await getDistributionInfo()),
        message.enabled
      );
      await updateBrowserSyncAlarm(status);
      return status;
    }
    case "updateBrowserSyncDeviceName":
      return updateBrowserSyncDeviceName(
        getBrowserSyncApis(await getDistributionInfo()),
        message.name
      );
    case "renameBrowserSyncDevice":
      return renameBrowserSyncDevice(
        getBrowserSyncApis(await getDistributionInfo()),
        message.installationId,
        message.name
      );
    case "dismissBrowserSyncReminder":
      return dismissBrowserSyncReminder(
        getBrowserSyncApis(await getDistributionInfo()),
        message.mode
      );
    case "purgeBrowserSyncData": {
      const status = await purgeBrowserSyncData(getBrowserSyncApis(await getDistributionInfo()));
      await updateBrowserSyncAlarm(status);
      return status;
    }
    case "refreshPortalTokens":
      return refreshPortalTokensFromOpenTabs();
    case "getPortalRecoveryStatus":
      return getPortalRecoveryStatus(getPortalRecoveryApis(), Date.now(), await getTokenStatus());
    case "focusPortalRecoveryTabs":
      return focusPortalRecoveryTabs(getPortalRecoveryApis(), Date.now(), await getTokenStatus());
    case "openPortalRecoveryTabs":
      return openManagedPortalRecoveryTabs(message.targets);
    case "closePortalRecoveryTabs":
      return closeVerifiedRecoveryTabs(
        await getTokenStatus(),
        undefined,
        message.targets,
        message.expectedJourneyCreatedAt
      );
    case "clearToken":
      await clearTokens();
      return true;
    case "resetExtensionData":
      await resetAllExtensionData();
      return true;
    case "getActivationItems":
      return getActivationItems(message.targets);
    case "getActiveItems":
      return getActiveItems(message.targets);
    case "getActivationSnapshot":
      return message.detail === "core" ? getActivationCoreSnapshot(message.targets) : getActivationSnapshot(message.targets);
    case "enrichActivationPolicies":
      return enrichActivationPolicies(message.items);
    case "refreshTrackedRequests":
      return runTrackedRequestMaintenance(message.requestIds, true);
    case "clearTrackedRequests":
      await clearTrackedRequests();
      await clearTrackedRequestNotifications();
      await updateTrackedRequestBadge({ version: 1, requests: [] });
      return true;
    case "restoreTrackedRequests": {
      const store = await saveTrackedRequests(message.store);
      const settings = await loadSettings();
      await Promise.all([
        updateTrackedRequestBadge(store),
        scheduleTrackedRequestMaintenance(store, settings)
      ]);
      return store;
    }
    case "restoreSettingsBackup": {
      const restored = await runWithSettingsMutationLock(() => runWithTrackedRequestMutationLock(async () => {
        const snapshot = await loadSettingsSnapshot();
        const settings = mergeSettings(message.settings);
        const store = sanitizeTrackedRequestStore(message.store);
        await chrome.storage.local.set({
          [SETTINGS_KEY]: settings,
          [SETTINGS_REVISION_KEY]: snapshot.revision + 1,
          [REQUEST_TRACKING_KEY]: store
        });
        return { settings, trackedRequests: store };
      }));
      await Promise.all([
        updateTrackedRequestBadge(restored.trackedRequests),
        scheduleTrackedRequestMaintenance(restored.trackedRequests, restored.settings)
      ]);
      return restored;
    }
    case "extendTrackedRequest":
      return extendTrackedRequest(message.requestId);
    case "getRequestOperations":
      return loadRequestOperationsForPopup();
    case "dismissRequestOperations":
      await dismissRequestOperations(message.operationIds);
      return true;
    case "capturePortalTokens":
      return capturePortalTokens(message.tokens, message.source, sender);
    case "activateItems":
      return runDurableRequestOperation(
        {
          id: message.operationId,
          action: "activate",
          itemIds: message.items.map((item) => item.id),
          targets: uniqueAccessTargets(message.items.map((item) => item.type)),
          tenantId: getSharedTenantId(message.items),
          items: createRequestOperationItems(message.items),
          startedAt: Date.now(),
          durationHours: message.durationHours,
          justification: message.justification,
          ticketInfo: message.ticketInfo,
          bundleName: message.bundleName
        },
        () => activateItemsWithPortalRecovery(
          message.items,
          message.durationHours,
          message.justification,
          message.ticketInfo || {},
          message.bundleName,
          { operationId: message.operationId }
        ),
        message.items
      );
    case "deactivateItems":
      return runDurableRequestOperation(
        {
          id: message.operationId,
          action: "deactivate",
          itemIds: message.items.map((item) => item.id),
          targets: uniqueAccessTargets(message.items.map((item) => item.type)),
          tenantId: getSharedTenantId(message.items),
          items: createRequestOperationItems(message.items),
          startedAt: Date.now(),
          justification: message.justification,
          ticketInfo: message.ticketInfo
        },
        () => deactivateItemsWithPortalRecovery(
          message.items,
          message.justification || "",
          message.ticketInfo || {},
          { operationId: message.operationId }
        ),
        message.items
      );
    default:
      throw new Error("Unsupported QuickPIM++ message");
  }
}

async function resetAllExtensionData(): Promise<void> {
  if (extensionResetInProgress) {
    throw new Error("QuickPIM++ data reset is already in progress.");
  }
  extensionResetInProgress = true;
  let resetCompleted = false;
  try {
    await resetExtensionData({
      loadRequestOperations,
      hasInFlightTasks: () => Boolean(
        bestEffortTasks.size
        || requestOperationTasks.size
        || requestExtensionTasks.size
        || portalTokenRefreshInFlight
        || requestTrackingMaintenanceInFlight
        || requestTrackingMaintenanceFollowUp
        || backgroundPreRefreshInFlight
        || portalRecoveryVerificationInFlight
        || browserSyncInFlight
        || browserSyncFollowUp
      ),
      closePortalRecoveryTabs: () => closePortalRecoveryTabsForTargets(
        ["directoryRole", "pimGroup", "azureRole"],
        getPortalRecoveryApis()
      ),
      clearNotifications: async () => {
        if (!chrome.notifications?.getAll) return;
        const notifications = await new Promise<object>((resolve) => chrome.notifications.getAll(resolve));
        await Promise.all(Object.keys(notifications).map((notificationId) => new Promise<void>((resolve) => {
          chrome.notifications.clear(notificationId, () => resolve());
        })));
      },
      removeNotificationPermission: () => chrome.permissions?.remove
        ? chrome.permissions.remove({ permissions: ["notifications"] })
        : Promise.resolve(false),
      purgeSyncedData: async () => purgeBrowserSyncData(getBrowserSyncApis(await getDistributionInfo())),
      queueSyncedDataPurge: (error) => queueBrowserSyncPurgeRetry(chrome.storage.local, error),
      prepareResetRecovery: () => chrome.storage.local.set({
        [EXTENSION_RESET_PENDING_KEY]: { version: 1, startedAt: Date.now() }
      }),
      clearLocalStorage: () => chrome.storage.local.clear(),
      clearSessionStorage: () => chrome.storage.session.clear(),
      clearAlarms: () => chrome.alarms?.clearAll ? chrome.alarms.clearAll() : Promise.resolve(false),
      clearActionBadge: () => chrome.action?.setBadgeText ? chrome.action.setBadgeText({ text: "" }) : Promise.resolve()
    });
    // Recreate only default runtime services after the destructive clear. The
    // browser-sync purge marker keeps sync paused, while background refresh and
    // request-tracking alarms return to their default state without requiring a
    // browser restart.
    await initializeEnabledBackgroundServices().catch(() => undefined);
    resetCompleted = true;
  } finally {
    // Storage events generated by the reset may be delivered after clear()
    // resolves. Ignore that short tail so default services cannot recreate
    // alarms or synced state immediately after an explicit purge.
    if (resetCompleted) suppressBackgroundStorageEventsUntil = Date.now() + 2_000;
    extensionResetInProgress = false;
  }
}

async function loadRequestOperationsForPopup(): Promise<RequestOperationRecord[]> {
  const operations = await loadRequestOperations();
  const orphaned = operations.filter((operation) =>
    (operation.state === "running" || operation.state === "uncertain") && !requestOperationTasks.has(operation.id)
  );
  if (!orphaned.length) {
    return operations;
  }

  await Promise.allSettled(orphaned.map((operation) => reconcileOrphanedRequestOperation(operation)));
  return loadRequestOperations();
}

async function reconcileOrphanedRequestOperation(operation: RequestOperationRecord): Promise<void> {
  await retryPendingTrackedRequests(operation);
  const refreshedOperation = (await loadRequestOperations()).find((candidate) => candidate.id === operation.id) || operation;
  const store = await loadTrackedRequests().catch(() => undefined);
  const matching = (store?.requests || []).filter((request) => trackedRequestMatchesOperation(request, refreshedOperation));
  const operationItems = refreshedOperation.items?.length
    ? refreshedOperation.items
    : createRequestOperationItems(refreshedOperation.itemIds.map((itemId) => ({
        id: itemId,
        type: inferOperationItemType(itemId),
        sourceName: itemId,
        displayName: itemId,
        principalId: "unknown",
        scopeLabel: "Unknown scope",
        status: refreshedOperation.action === "activate" ? "eligible" as const : "active" as const,
        ...(refreshedOperation.tenantId ? { tenantId: refreshedOperation.tenantId } : {}),
        ...(inferOperationItemType(itemId) === "directoryRole"
          ? { roleDefinitionId: "unknown", directoryScopeId: "/" }
          : inferOperationItemType(itemId) === "pimGroup"
            ? { groupId: "unknown", accessId: "member" as const }
            : { roleDefinitionId: "unknown", scope: "/" })
      } as ActivationItem)), refreshedOperation.startedAt);
  const results: ActivationResult[] = operationItems.map((operationItem) => {
    const itemId = operationItem.itemId;
    const tracked = matching
      .filter((request) => activationItemIdentitiesMatch(itemId, request.itemId))
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
    if (tracked) return buildTrackedReconciliationResult(itemId, tracked);
    if (operationItem.result) return operationItem.result;
    if ((operationItem.state === "accepted" || operationItem.state === "tracking") && operationItem.requestId) {
      return {
        itemId,
        itemName: operationItem.itemName,
        success: true,
        requestId: operationItem.requestId,
        requestStatus: "submitted",
        trackingUnavailable: true
      };
    }
    const outcomeUnknown = operationItem.state === "sending" || operationItem.state === "uncertain";
    return {
      itemId,
      itemName: operationItem.itemName,
      success: false,
      error: outcomeUnknown
        ? "QuickPIM++ restarted while Microsoft may have been processing this item. Check Microsoft PIM before retrying to avoid a duplicate request."
        : "QuickPIM++ restarted before this item was sent. It is safe to start a new request.",
      ...(outcomeUnknown ? { outcomeUnknown: true } : {})
    };
  });
  const errors = results.filter((result) => !result.success);
  await completeRequestOperation(refreshedOperation.id, {
    success: errors.length === 0,
    results,
    errors,
    ...(refreshedOperation.sourceInstallationId ? { sourceInstallationId: refreshedOperation.sourceInstallationId } : {}),
    ...(refreshedOperation.sourceDeviceName ? { sourceDeviceName: refreshedOperation.sourceDeviceName } : {})
  });
}

async function reconcilePendingRequestOperations(): Promise<void> {
  const operations = await loadRequestOperations();
  const orphaned = operations.filter((operation) =>
    (operation.state === "running" || operation.state === "uncertain") && !requestOperationTasks.has(operation.id)
  );
  await Promise.allSettled(orphaned.map(async (operation) => {
    try {
      await reconcileOrphanedRequestOperation(operation);
    } catch (error) {
      await failRequestOperation(
        operation.id,
        `Request recovery could not finish: ${sanitizeErrorMessage(error)}`,
        { uncertain: true }
      ).catch(() => undefined);
    }
  }));
}

async function retryPendingTrackedRequests(operation: RequestOperationRecord): Promise<void> {
  const pendingItems = (operation.items || []).filter((item) => item.pendingTrackedRequest);
  if (!pendingItems.length) return;
  const requests = pendingItems.flatMap((item) => item.pendingTrackedRequest ? [item.pendingTrackedRequest] : []);
  if (!await persistTrackedSubmissionsBestEffort(requests)) return;
  await Promise.allSettled(pendingItems.map((item) => updateRequestOperationItem(operation.id, item.itemId, {
    state: "tracking",
    itemName: item.itemName,
    itemType: item.itemType,
    ...(item.tenantId ? { tenantId: item.tenantId } : {}),
    ...(item.requestId ? { requestId: item.requestId } : {}),
    trackedRequestId: item.pendingTrackedRequest?.id,
    pendingTrackedRequest: undefined
  })));
}

function buildTrackedReconciliationResult(itemId: string, request: TrackedPimRequest): ActivationResult {
  const requestStatus = getEffectiveTrackedRequestStatus(request);
  if (requestStatus === "denied" || requestStatus === "failed" || requestStatus === "canceled" || requestStatus === "expired") {
    return {
      itemId,
      itemName: request.itemName,
      success: false,
      requestId: request.requestId,
      requestStatus,
      error: request.lastError || `Microsoft marked this request as ${requestStatus}.`
    };
  }
  if (requestStatus === "unknown" || requestStatus === "statusUnavailable") {
    return {
      itemId,
      itemName: request.itemName,
      success: false,
      requestId: request.requestId,
      requestStatus,
      error: request.lastError || "Microsoft returned an unrecognized or unavailable request status.",
      outcomeUnknown: true
    };
  }
  return {
    itemId,
    itemName: request.itemName,
    success: true,
    requestId: request.requestId,
    requestStatus
  };
}

function inferOperationItemType(itemId: string): ActivationItem["type"] {
  const normalized = normalizeActivationItemId(itemId).replace(/^tenant:[^:]+:/u, "");
  if (normalized.startsWith("pimGroup:")) return "pimGroup";
  if (normalized.startsWith("azureRole:")) return "azureRole";
  return "directoryRole";
}

async function runDurableRequestOperation(
  operation: Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets" | "startedAt"> &
    Partial<Pick<RequestOperationRecord, "tenantId" | "principalId" | "items" | "durationHours" | "justification" | "ticketInfo" | "bundleName" | "sourceInstallationId" | "sourceDeviceName">>,
  execute: () => Promise<ActivationResponse>,
  activityItems: ActivationItem[]
): Promise<ActivationResponse> {
  const source = await getBrowserSyncInstallationIdentity(
    getBrowserSyncApis(await getDistributionInfo())
  ).catch(() => undefined);
  const operationTenantId = operation.tenantId
    || getSharedTenantId(activityItems)
    || await getTenantIdForOperationTargets(operation.targets);
  const operationPrincipalId = operation.principalId || getSharedPrincipalId(activityItems);
  const sourcedOperation = {
    ...operation,
    ...(operationTenantId ? { tenantId: operationTenantId } : {}),
    ...(operationPrincipalId ? { principalId: operationPrincipalId } : {}),
    ...(operation.items?.length ? {} : { items: createRequestOperationItems(activityItems) }),
    ...(source ? {
      sourceInstallationId: source.installationId,
      sourceDeviceName: source.deviceName
    } : {})
  };
  const fingerprint = getRequestOperationFingerprint(sourcedOperation);
  const existingOperation = requestOperationTasks.get(operation.id);
  if (existingOperation) {
    if (existingOperation.fingerprint !== fingerprint) {
      throw new Error("This request operation ID is already being used for different role work.");
    }
    return existingOperation.task;
  }

  const task = runWithServiceWorkerKeepAlive(async () => {
    const stored = (await loadRequestOperations()).find((item) => item.id === operation.id);
    if (stored && getRequestOperationFingerprint(stored) !== fingerprint) {
      throw new Error("This request operation ID was already used for different role work.");
    }
    if (stored?.state === "complete" && stored.response) {
      return stored.response;
    }
    if (stored?.state === "error") {
      const definitelyUnsent = stored.items?.every((item) => item.state === "prepared") === true;
      if (!definitelyUnsent) {
        throw new Error(stored.error || "The previous QuickPIM++ request failed.");
      }
      await dismissRequestOperations([stored.id]);
    }
    if (stored?.state === "running" || stored?.state === "uncertain") {
      await reconcileOrphanedRequestOperation(stored);
      const reconciled = (await loadRequestOperations()).find((item) => item.id === operation.id);
      if (reconciled?.state === "complete" && reconciled.response) return reconciled.response;
      if (reconciled?.response) return reconciled.response;
      throw new Error(reconciled?.error || "The previous QuickPIM++ request outcome is unknown. Check Microsoft PIM before retrying.");
    }

    const claimed = await beginRequestOperation(sourcedOperation);
    if (!claimed) {
      const claimedOperation = (await loadRequestOperations()).find((item) => item.id === operation.id);
      if (claimedOperation?.state === "complete" && claimedOperation.response) return claimedOperation.response;
      if (claimedOperation?.state === "error") throw new Error(claimedOperation.error || "The previous QuickPIM++ request failed.");
      if (claimedOperation) {
        await reconcileOrphanedRequestOperation(claimedOperation);
        const reconciled = (await loadRequestOperations()).find((item) => item.id === operation.id);
        if (reconciled?.response) return reconciled.response;
      }
      throw new Error("The existing QuickPIM++ request is still being reconciled. Check Microsoft PIM before retrying.");
    }
    const heartbeat = setInterval(() => {
      void touchRequestOperation(operation.id).catch(() => undefined);
    }, 60_000);
    let result: ActivationResponse;
    try {
      result = await execute();
    } catch (error) {
      const detail = sanitizeErrorMessage(error);
      const latestOperation = (await loadRequestOperations()).find((item) => item.id === operation.id);
      const outcomeUnknown = latestOperation?.state === "uncertain"
        || latestOperation?.items?.some((item) => item.state === "uncertain") === true;
      const failedResults = activityItems.map((item) => ({
        itemId: item.id,
        itemName: item.displayName,
        success: false as const,
        error: detail
      }));
      const failedResponse: ActivationResponse = {
        success: false,
        results: failedResults,
        errors: failedResults,
        ...(source?.installationId ? { sourceInstallationId: source.installationId } : {}),
        ...(source?.deviceName ? { sourceDeviceName: source.deviceName } : {})
      };
      await failRequestOperation(operation.id, detail, { uncertain: outcomeUnknown }).catch(() => undefined);
      await mutateSettings((settings) => recordOperationActivity(
        operation.justification?.trim() ? addRecentJustification(settings, operation.justification) : settings,
        {
          operationId: operation.id,
          action: operation.action,
          items: activityItems,
          response: failedResponse,
          requestedAt: new Date(operation.startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationHours: operation.durationHours,
          justification: operation.justification,
          bundleName: operation.bundleName,
          source
        }
      )).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }

    if (source) await annotateTrackedRequestSources(result, source).catch(() => undefined);
    const response: ActivationResponse = {
      ...result,
      ...(source?.installationId ? { sourceInstallationId: source.installationId } : {}),
      ...(source?.deviceName ? { sourceDeviceName: source.deviceName } : {})
    };
    await completeRequestOperation(operation.id, response);
    await mutateSettings((settings) => recordOperationActivity(
      operation.justification?.trim() ? addRecentJustification(settings, operation.justification) : settings,
      {
      operationId: operation.id,
      action: operation.action,
      items: activityItems,
      response,
      requestedAt: new Date(operation.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationHours: operation.durationHours,
      justification: operation.justification,
      bundleName: operation.bundleName,
      source
      }
    )).catch(() => undefined);
    return response;
  });

  requestOperationTasks.set(operation.id, { fingerprint, task });
  void task.then(
    () => requestOperationTasks.delete(operation.id),
    () => requestOperationTasks.delete(operation.id)
  );
  return task;
}

function getSharedPrincipalId(items: ActivationItem[]): string | undefined {
  const principalIds = [...new Set(items.map((item) => item.principalId.trim().toLowerCase()).filter(Boolean))];
  return principalIds.length === 1 ? principalIds[0] : undefined;
}

async function annotateTrackedRequestSources(
  response: ActivationResponse,
  source: { installationId: string; deviceName: string }
): Promise<void> {
  const requestIds = new Set(
    response.results.flatMap((result) => result.success && result.requestId ? [result.requestId] : [])
  );
  if (!requestIds.size) return;
  await mutateTrackedRequests((current) => ({
    ...current,
    requests: current.requests.map((request) => requestIds.has(request.requestId)
      ? {
          ...request,
          sourceInstallationId: source.installationId,
          sourceDeviceName: source.deviceName
        }
      : request)
  }));
}

async function activateItemsWithPortalRecovery(
  items: ActivationItem[],
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo,
  bundleName?: string,
  options: ActivationSubmissionOptions = {}
): Promise<ActivationResponse> {
  return executeWithPortalAccessRecovery(
    items,
    "activation",
    (retryItems) => activateItems(retryItems, durationHours, justification, ticketInfo, bundleName, options)
  );
}

async function deactivateItemsWithPortalRecovery(
  items: ActivationItem[],
  justification: string,
  ticketInfo: TicketInfo,
  options: ActivationSubmissionOptions = {}
): Promise<ActivationResponse> {
  return executeWithPortalAccessRecovery(
    items,
    "deactivation",
    (retryItems) => deactivateItems(retryItems, justification, ticketInfo, options)
  );
}

async function extendTrackedRequest(requestId: string): Promise<TrackedRequestExtensionResult> {
  const existing = requestExtensionTasks.get(requestId);
  if (existing) {
    return existing;
  }
  const task = performTrackedRequestExtension(requestId).finally(() => {
    requestExtensionTasks.delete(requestId);
  });
  requestExtensionTasks.set(requestId, task);
  return task;
}

async function performTrackedRequestExtension(requestId: string): Promise<TrackedRequestExtensionResult> {
  const [initialStore, settings] = await Promise.all([loadTrackedRequests(), loadSettings()]);
  let source = initialStore.requests.find((request) => request.id === requestId || request.requestId === requestId);
  if (!source) {
    return extensionFailure(requestId, "The tracked activation is no longer available. Refresh Activity before trying again.");
  }

  const continuation = initialStore.requests.find((request) =>
    request.continuationOfRequestId === source?.requestId
    && !isTerminalExtensionRequestStatus(getEffectiveTrackedRequestStatus(request))
  );
  if (continuation) {
    return extensionFailure(source.requestId, "An extension is already queued for this activation.");
  }

  if (source.extensionAttemptState === "queued") {
    const failedContinuation = initialStore.requests.find((request) =>
      request.continuationOfRequestId === source?.requestId
      && isTerminalExtensionRequestStatus(getEffectiveTrackedRequestStatus(request))
    );
    if (failedContinuation) {
      source = { ...source, extensionAttemptState: undefined, extensionRequestId: undefined };
    }
  }

  let plan;
  try {
    plan = buildTrackedRequestExtensionPlan(
      source,
      settings.preferences.defaultExtensionDurationHours
    );
  } catch (error) {
    return extensionFailure(source.requestId, sanitizeErrorMessage(error));
  }

  const attemptedAt = new Date().toISOString();
  await patchTrackedExtensionSource(source.id, {
    extensionAttemptState: "submitting",
    extensionRequestedAt: attemptedAt,
    extensionRequestId: undefined,
    extensionLastError: undefined
  });

  try {
    const response = await activateItemsWithPortalRecovery(
      [plan.item],
      plan.durationHours,
      plan.justification,
      plan.ticketInfo,
      undefined,
      {
        startDateTime: plan.startDateTime,
        continuationOfRequestId: source.requestId
      }
    );
    const result = response.results[0];
    if (!result?.success) {
      const detail = result?.error || "Microsoft did not accept the extension request.";
      const ambiguous = isAmbiguousMicrosoftWriteFailure(detail, Boolean(result?.accessRecoveryTarget));
      await patchTrackedExtensionSource(source.id, {
        extensionAttemptState: ambiguous ? "uncertain" : undefined,
        extensionRequestId: undefined,
        extensionLastError: detail
      });
      return extensionFailure(
        source.requestId,
        ambiguous
          ? `${detail} The result may be unknown; check Microsoft PIM before retrying.`
          : detail
      );
    }

    const extensionRequestId = requireTrackedRequestExtensionRequestId(result);

    await patchTrackedExtensionSource(source.id, {
      extensionAttemptState: "queued",
      extensionRequestId,
      extensionLastError: undefined
    });
    return {
      success: true,
      message: `${source.itemName} is queued for ${formatExtensionDuration(plan.durationHours)} more access after its current activation ends.`,
      sourceRequestId: source.requestId,
      requestId: extensionRequestId,
      scheduledStartAt: plan.startDateTime,
      scheduledEndAt: plan.endDateTime,
      durationHours: plan.durationHours
    };
  } catch (error) {
    const detail = sanitizeErrorMessage(error);
    await patchTrackedExtensionSource(source.id, {
      extensionAttemptState: "uncertain",
      extensionRequestId: undefined,
      extensionLastError: detail
    });
    return extensionFailure(
      source.requestId,
      `${detail} The result may be unknown; check Microsoft PIM before retrying.`
    );
  }
}

async function patchTrackedExtensionSource(
  requestId: string,
  patch: Partial<Pick<TrackedPimRequest, "extensionAttemptState" | "extensionRequestedAt" | "extensionRequestId" | "extensionLastError">>
): Promise<void> {
  await mutateTrackedRequests((store) => ({
    version: 1,
    requests: store.requests.map((request) => request.id === requestId ? { ...request, ...patch } : request)
  }));
}

function extensionFailure(sourceRequestId: string, message: string): TrackedRequestExtensionResult {
  return {
    success: false,
    sourceRequestId,
    message: sanitizeErrorMessage(message)
  };
}

function isTerminalExtensionRequestStatus(status: TrackedPimRequestStatus): boolean {
  return status === "denied" || status === "failed" || status === "canceled" || status === "expired";
}

async function executeWithPortalAccessRecovery(
  items: ActivationItem[],
  operation: "activation" | "deactivation",
  execute: (items: ActivationItem[]) => Promise<ActivationResponse>
): Promise<ActivationResponse> {
  const initialResponse = await execute(items);
  const recoveryTargets = getAccessRecoveryTargets(initialResponse);
  if (!recoveryTargets.length) {
    return initialResponse;
  }

  const retryIds = new Set(
    initialResponse.errors
      .filter((result) => result.accessRecoveryTarget)
      .map((result) => result.itemId)
  );
  const retryItems = items.filter((item) => [...retryIds]
    .some((itemId) => activationItemIdentitiesMatch(itemId, getActivationItemIdentity(item))));
  if (!retryItems.length) {
    return initialResponse;
  }

  const recovery = await recoverPortalAccessForRequest(
    recoveryTargets,
    getFreshAccessRecoveryTargets(initialResponse),
    getClaimsChallengeRecoveryTargets(initialResponse)
  );
  if (!recovery.ready) {
    return replaceAccessRecoveryErrors(
      initialResponse,
      recovery.error || `Microsoft portal access required for ${operation} could not be refreshed automatically.`
    );
  }

  const retryResponse = await execute(retryItems);
  const successfulTargets = recoveryTargets.filter((target) => retryItems.some((item) =>
    item.type === target
    && retryResponse.results.some((result) => result.success
      && activationItemIdentitiesMatch(result.itemId, getActivationItemIdentity(item)))
  ));
  if (successfulTargets.length && recovery.journeyCreatedAt !== undefined) {
    await closePortalRecoveryTabsForTargets(
      successfulTargets,
      getPortalRecoveryApis(),
      recovery.journeyCreatedAt
    ).catch(() => undefined);
  }
  return mergeRetriedActivationResponse(initialResponse, retryResponse);
}

async function recoverPortalAccessForRequest(
  targets: AccessSetupTarget[],
  freshTokenTargets: AccessSetupTarget[] = [],
  claimsChallengeTargets: AccessSetupTarget[] = []
): Promise<{ ready: boolean; error?: string; journeyCreatedAt?: number }> {
  const initialTokenStatus = await getTokenStatus();
  const freshTokenBaselines = Object.fromEntries(
    freshTokenTargets.map((target) => [target, getPortalRecoveryTokenSignature(initialTokenStatus, target)])
  ) as Partial<Record<AccessSetupTarget, string>>;

  try {
    await refreshPortalTokensFromOpenTabs();
  } catch {
    // Dedicated background tabs remain available if passive tab scanning fails.
  }

  let tokenStatus = await getTokenStatus();
  let remainingTargets = getRequestMissingAccessTargets(targets, tokenStatus, freshTokenBaselines);
  if (!remainingTargets.length) {
    return {
      ready: true,
      journeyCreatedAt: await getPortalRecoveryJourneyCreatedAt(getPortalRecoveryApis())
    };
  }

  const managedFreshTargets = remainingTargets.filter((target) => freshTokenTargets.includes(target));
  if (managedFreshTargets.length) {
    try {
      const existingJourneyCreatedAt = await getPortalRecoveryJourneyCreatedAt(getPortalRecoveryApis());
      if (existingJourneyCreatedAt !== undefined) {
        await closePortalRecoveryTabsForTargets(
          managedFreshTargets,
          getPortalRecoveryApis(),
          existingJourneyCreatedAt
        );
      }
    } catch {
      // A stale managed-tab record must not block opening a fresh recovery page.
    }
  }
  const opened = await openManagedPortalRecoveryTabs(remainingTargets);
  if (!opened.managedCount) {
    return {
      ready: false,
      error: "QuickPIM++ could not open the Microsoft portal page needed for this request. Your selection and inputs remain saved."
    };
  }
  const journeyCreatedAt = await getPortalRecoveryJourneyCreatedAt(getPortalRecoveryApis());

  const deadline = Date.now() + REQUEST_PORTAL_RECOVERY_WAIT_TIMEOUT_MS;
  const recoveryStartedAt = Date.now();
  let passiveScanAt = 0;
  let focusAttempts = 0;
  while (Date.now() < deadline) {
    await delay(REQUEST_PORTAL_RECOVERY_POLL_INTERVAL_MS);
    if (Date.now() - passiveScanAt >= 3_000) {
      passiveScanAt = Date.now();
      try {
        tokenStatus = (await refreshPortalTokensFromOpenTabs()).tokenStatus;
      } catch {
        tokenStatus = await getTokenStatus();
      }
    } else {
      tokenStatus = await getTokenStatus();
    }
    remainingTargets = getRequestMissingAccessTargets(targets, tokenStatus, freshTokenBaselines);
    if (!remainingTargets.length) {
      return { ready: true, journeyCreatedAt };
    }
    const recoveryStatus = await getPortalRecoveryStatus(getPortalRecoveryApis(), Date.now(), tokenStatus);
    if (shouldFocusPortalRecovery({
      elapsedMs: Date.now() - recoveryStartedAt,
      interactionRequired: recoveryStatus.state === "interactionRequired",
      requiresFreshToken: remainingTargets.some((target) => claimsChallengeTargets.includes(target)),
      focusAttempts
    })) {
      focusAttempts += 1;
      const focusResult = await focusPortalRecoveryTabs(getPortalRecoveryApis(), Date.now(), tokenStatus);
      if (focusResult.focused) {
        focusAttempts = 2;
      }
    }
  }

  const recoveryStatus = await getPortalRecoveryStatus(getPortalRecoveryApis(), Date.now(), tokenStatus);
  const interactionRequired = recoveryStatus.state === "interactionRequired";
  return {
    ready: false,
    error: getPortalRecoveryFailureMessage({
      remainingTargets,
      claimsChallengeTargets,
      interactionRequired,
      targetLabel: accessTargetLabel
    })
  };
}

function getRequestMissingAccessTargets(
  targets: AccessSetupTarget[],
  tokenStatus: TokenStatus,
  freshTokenBaselines: Partial<Record<AccessSetupTarget, string>> = {}
): AccessSetupTarget[] {
  const now = Date.now();
  return targets.filter((target) => {
    if (!hasRequiredPortalToken(target, tokenStatus)) {
      return true;
    }
    const token = target === "azureRole"
      ? tokenStatus.azureManagement
      : tokenStatus.graphTargets?.[target] || tokenStatus.graph;
    const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= now + MICROSOFT_API_WRITE_TOKEN_MIN_VALIDITY_MS) {
      return true;
    }
    const baseline = freshTokenBaselines[target];
    return baseline !== undefined && getPortalRecoveryTokenSignature(tokenStatus, target) === baseline;
  });
}

function uniqueAccessTargets(targets: AccessSetupTarget[]): AccessSetupTarget[] {
  const requested = new Set(targets);
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
}

function getSharedTenantId(items: ActivationItem[]): string | undefined {
  const tenantIds = [...new Set(items
    .map((item) => item.tenantId?.trim().toLowerCase())
    .filter((tenantId): tenantId is string => Boolean(tenantId)))];
  return tenantIds.length === 1 ? tenantIds[0] : undefined;
}

async function getTenantIdForOperationTargets(targets: AccessSetupTarget[]): Promise<string | undefined> {
  const tokens = await getStoredTokens();
  const tenantIds = new Set<string>();
  for (const target of uniqueAccessTargets(targets)) {
    const token = target === "azureRole"
      ? tokens.azureManagementToken
      : getGraphTokenForTarget(tokens, target);
    const tenantId = token ? getTokenTenantId(token)?.trim().toLowerCase() : undefined;
    if (tenantId) tenantIds.add(tenantId);
  }
  return tenantIds.size === 1 ? [...tenantIds][0] : undefined;
}

function accessTargetLabel(target: AccessSetupTarget): string {
  return target === "directoryRole" ? "Entra role" : target === "pimGroup" ? "PIM group" : "Azure role";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function refreshPortalTokensFromOpenTabs(
  options: { scheduleVerification?: boolean } = {}
): Promise<PortalTokenRefreshResult> {
  if (portalTokenRefreshInFlight) {
    return portalTokenRefreshInFlight;
  }

  const refresh = (async (): Promise<PortalTokenRefreshResult> => {
    const scanResult = await scanOpenEntraTabs(chrome.tabs);
    await recordPortalTokenScanDiagnostic(scanResult).catch(() => undefined);
    const tokenStatus = await getTokenStatus();
    if (options.scheduleVerification !== false) {
      const journeyCreatedAt = await getPortalRecoveryJourneyCreatedAt(getPortalRecoveryApis());
      if (journeyCreatedAt !== undefined) {
        await schedulePortalRecoveryVerification();
      }
    }
    return {
      tokenStatus,
      ...scanResult
    };
  })();
  portalTokenRefreshInFlight = refresh.finally(() => {
    portalTokenRefreshInFlight = undefined;
  });
  return portalTokenRefreshInFlight;
}

async function captureToken(details: chrome.webRequest.WebRequestHeadersDetails): Promise<void> {
  const tokenKind = getAllowedTokenKindForUrl(details.url);
  if (!tokenKind) {
    return;
  }

  const portalSource = details.initiator;
  if (!isAllowedPortalTokenSource(portalSource)) {
    return;
  }

  const authHeader = details.requestHeaders?.find((header) => header.name.toLowerCase() === "authorization");
  const bearerMatch = authHeader?.value?.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    return;
  }

  const token = bearerMatch[1];
  const validation = validateCapturedToken(token, tokenKind);
  if (!validation.ok) {
    return;
  }

  const allowIdentityChange = await shouldAllowCapturedTokenIdentityChange(details.tabId, chrome.tabs)
    || await isPortalRecoveryManagedTabId(details.tabId, getPortalRecoveryApis());
  const stored = await storeCapturedToken(
    tokenKind,
    token,
    "Microsoft Entra portal request",
    Date.now(),
    { allowIdentityChange }
  );
  if (stored) {
    await schedulePortalRecoveryVerification();
  }
}

async function capturePortalTokens(
  tokens: string[],
  _source: string | undefined,
  sender: chrome.runtime.MessageSender
): Promise<{ captured: TokenKind[] }> {
  const sourceUrl = sender.url || sender.tab?.url || sender.origin;
  if (!isAllowedPortalTokenSource(sourceUrl)) {
    throw new Error("Portal token capture is only allowed from Microsoft Entra pages.");
  }
  const [storedTokens, settings] = await Promise.all([getStoredTokens(), loadSettings()]);
  const candidates = selectPortalTokenCandidates(tokens, {
    requiredTargets: getEnabledRoleFeatures(settings),
    preferredIdentity: sender.tab?.active === true
      ? undefined
      : getFirstValidStoredTokenIdentity(storedTokens)
  });
  const captured = new Set<TokenKind>();
  for (const candidate of candidates) {
    const stored = await storeCapturedToken(
      candidate.tokenKind,
      candidate.token,
      "Microsoft Entra portal storage",
      Date.now(),
      { allowIdentityChange: sender.tab?.active === true }
    );
    if (stored) {
      captured.add(candidate.tokenKind);
    }
  }
  if (captured.size) {
    await schedulePortalRecoveryVerification();
  }
  return { captured: [...captured] };
}

function getFirstValidStoredTokenIdentity(tokens: StoredTokens, now = Date.now()): string | undefined {
  const candidates: Array<[string | undefined, TokenKind]> = [
    [tokens.graphToken, "graph"],
    [tokens.graphDirectoryRoleToken, "graph"],
    [tokens.graphPimGroupToken, "graph"],
    [tokens.azureManagementToken, "azureManagement"]
  ];
  for (const [token, tokenKind] of candidates) {
    if (!token) continue;
    const validation = validateCapturedToken(token, tokenKind, now);
    if (!validation.ok) continue;
    const identity = getTokenIdentity(validation.decoded);
    if (identity) return identity;
  }
  return undefined;
}

function getPortalRecoveryApis(): PortalRecoveryApis {
  return {
    tabs: chrome.tabs,
    tabGroups: chrome.tabGroups,
    // Recovery ownership is non-secret and must survive a browser restart.
    // Access tokens themselves remain exclusively in storage.session.
    storage: chrome.storage.local,
    windows: chrome.windows
  };
}

async function openManagedPortalRecoveryTabs(targets: AccessSetupTarget[]) {
  const apis = getPortalRecoveryApis();
  try {
    return await openPortalRecoveryTabsAndReconcile(targets, getTokenStatus, apis);
  } finally {
    // The manager persists each created tab before grouping. Schedule the
    // durable lifecycle from a finally block so a grouping/storage failure or
    // popup closure cannot strand a partially opened recovery journey.
    // Schedule unconditionally. If storage failed after a tab was created, the
    // verifier can still find its exact URL marker and close it as an orphan.
    // With no recovery journey these one-shot alarms simply reconcile to idle.
    await Promise.allSettled([
      schedulePortalRecoveryCleanup(),
      schedulePortalRecoveryVerification()
    ]);
  }
}

async function maintainPortalRecoveryCleanup(): Promise<void> {
  const apis = getPortalRecoveryApis();
  try {
    await Promise.all([
      closeExpiredPortalRecoveryTabs(apis),
      closeOrphanedPortalRecoveryTabs(apis)
    ]);
    const status = await getPortalRecoveryStatus(apis, Date.now(), await getTokenStatus());
    if (status.state === "idle") {
      await clearPortalRecoveryAlarms();
      return;
    }
    await schedulePortalRecoveryCleanup();
    if (status.state === "waiting") {
      await schedulePortalRecoveryVerification();
    }
  } catch {
    // A one-shot alarm is consumed before this handler runs. Leave another
    // durable attempt behind when tabs/storage are temporarily unavailable.
    await Promise.allSettled([
      schedulePortalRecoveryCleanup(PORTAL_RECOVERY_CLEANUP_RETRY_MS),
      schedulePortalRecoveryVerification(PORTAL_RECOVERY_VERIFY_RETRY_MS)
    ]);
  }
}

async function initializePortalRecoveryLifecycle(): Promise<void> {
  const apis = getPortalRecoveryApis();
  try {
    await closeExpiredPortalRecoveryTabs(apis);
    await closeOrphanedPortalRecoveryTabs(apis);

    const [settings, tokenStatus] = await Promise.all([loadSettings(), getTokenStatus()]);
    let status = await getPortalRecoveryStatus(apis, Date.now(), tokenStatus);
    if (status.state === "idle") {
      await clearPortalRecoveryAlarms();
      return;
    }

    const journeyCreatedAt = await getPortalRecoveryJourneyCreatedAt(apis);
    const enabledTargets = new Set(getEnabledRoleFeatures(settings));
    const disabledTargets = status.managedTargets.filter((target) => !enabledTargets.has(target));
    if (disabledTargets.length && journeyCreatedAt !== undefined) {
      await closePortalRecoveryTabsForTargets(disabledTargets, apis, journeyCreatedAt);
      status = await getPortalRecoveryStatus(apis, Date.now(), tokenStatus);
    }

    if (status.state === "idle") {
      await clearPortalRecoveryAlarms();
      return;
    }
    await Promise.all([
      schedulePortalRecoveryCleanup(),
      schedulePortalRecoveryVerification()
    ]);
  } catch {
    // Startup may race browser session restoration. Retry instead of letting a
    // transient tabs/storage failure strand a restored QuickPIM++ group.
    await Promise.allSettled([
      schedulePortalRecoveryCleanup(PORTAL_RECOVERY_CLEANUP_RETRY_MS),
      schedulePortalRecoveryVerification(PORTAL_RECOVERY_VERIFY_RETRY_MS)
    ]);
  }
}

async function closeVerifiedRecoveryTabs(
  tokenStatus: TokenStatus,
  cache?: Awaited<ReturnType<typeof loadDataCache>>,
  requestedTargets?: AccessSetupTarget[],
  expectedJourneyCreatedAt?: number
): Promise<AccessSetupTarget[]> {
  const apis = getPortalRecoveryApis();
  const journeyCreatedAt = expectedJourneyCreatedAt
    ?? await getPortalRecoveryJourneyCreatedAt(apis);
  if (journeyCreatedAt === undefined) return [];

  const currentCache = cache || await loadDataCache();
  const targets = requestedTargets || (await getPortalRecoveryStatus(apis, Date.now(), tokenStatus)).managedTargets;
  const verifiedTargets = getApiVerifiedPortalRecoveryTargets({
    tokenStatus,
    cache: currentCache,
    targets,
    journeyCreatedAt
  });
  if (!verifiedTargets.length) return [];
  return closePortalRecoveryTabsForTargets(verifiedTargets, apis, journeyCreatedAt);
}

async function runPortalRecoveryVerification(): Promise<void> {
  if (portalRecoveryVerificationInFlight) {
    portalRecoveryVerificationFollowUpRequested = true;
    return portalRecoveryVerificationInFlight;
  }

  clearPortalRecoveryVerificationTimer();

  const verification = (async () => {
    // Leave a durable retry behind before network work starts. If MV3 suspends
    // the worker mid-check, the recovery journey resumes without the popup.
    await schedulePortalRecoveryAlarm(
      PORTAL_RECOVERY_VERIFY_ALARM_NAME,
      PORTAL_RECOVERY_VERIFY_RETRY_MS
    );
    schedulePortalRecoveryVerificationTimer(PORTAL_RECOVERY_VERIFY_RETRY_MS);
    await performPortalRecoveryVerification();
  })();
  const trackedVerification = verification.finally(async () => {
    portalRecoveryVerificationInFlight = undefined;
    if (portalRecoveryVerificationFollowUpRequested) {
      portalRecoveryVerificationFollowUpRequested = false;
      await schedulePortalRecoveryVerification();
    }
  });
  portalRecoveryVerificationInFlight = trackedVerification;
  return trackedVerification;
}

async function performPortalRecoveryVerification(): Promise<void> {
  const apis = getPortalRecoveryApis();
  let journeyCreatedAt = await getPortalRecoveryJourneyCreatedAt(apis);
  if (journeyCreatedAt === undefined) {
    await closeOrphanedPortalRecoveryTabs(apis);
    await clearPortalRecoveryAlarms();
    return;
  }

  const scannedTokens = (await refreshPortalTokensFromOpenTabs({ scheduleVerification: false })).tokenStatus;
  let status = await getPortalRecoveryStatus(apis, Date.now(), scannedTokens);
  const currentJourneyCreatedAt = await getPortalRecoveryJourneyCreatedAt(apis);
  if (currentJourneyCreatedAt !== journeyCreatedAt) {
    if (currentJourneyCreatedAt !== undefined) await schedulePortalRecoveryVerification();
    return;
  }

  const settings = await loadSettings();
  const enabledTargets = new Set(getEnabledRoleFeatures(settings));
  const disabledTargets = status.managedTargets.filter((target) => !enabledTargets.has(target));
  if (disabledTargets.length) {
    await closePortalRecoveryTabsForTargets(disabledTargets, apis, journeyCreatedAt);
    status = await getPortalRecoveryStatus(apis, Date.now(), scannedTokens);
  }
  if (status.state === "idle") {
    await closeOrphanedPortalRecoveryTabs(apis);
    await clearPortalRecoveryAlarms();
    return;
  }

  journeyCreatedAt = await getPortalRecoveryJourneyCreatedAt(apis);
  if (journeyCreatedAt === undefined) {
    await clearPortalRecoveryAlarms();
    return;
  }
  const verificationTargets = status.managedTargets.filter((target) =>
    enabledTargets.has(target) && hasRequiredPortalToken(target, scannedTokens)
  );
  if (verificationTargets.length) {
    const refreshStartedAt = Date.now();
    const [dataCache, referenceData, snapshot] = await Promise.all([
      loadDataCache(),
      loadReferenceData(),
      getActivationCoreSnapshot(verificationTargets)
    ]);
    const fetchedAt = Date.now();
    const snapshotTokenStatus = snapshot.tokenStatus || scannedTokens;
    const cacheKeys = buildTargetCacheKeys(snapshotTokenStatus, verificationTargets);
    let nextCache = updateCacheFromTargetResults(
      dataCache,
      "eligible",
      verificationTargets,
      snapshot.eligibleByTarget || splitActivationResultByTarget(snapshot.eligible, verificationTargets),
      fetchedAt,
      cacheKeys,
      refreshStartedAt
    );
    nextCache = updateCacheFromTargetResults(
      nextCache,
      "active",
      verificationTargets,
      snapshot.activeByTarget || splitActivationResultByTarget(snapshot.active, verificationTargets),
      fetchedAt,
      cacheKeys,
      refreshStartedAt
    );
    await Promise.all([
      saveDataCache(nextCache),
      saveReferenceData(learnReferenceDataFromItems(
        referenceData,
        [...snapshot.eligible.items, ...snapshot.active.items]
      ))
    ]);
    await closeVerifiedRecoveryTabs(
      await getTokenStatus(),
      await loadDataCache(),
      verificationTargets,
      journeyCreatedAt
    );
  }

  status = await getPortalRecoveryStatus(apis, Date.now(), await getTokenStatus());
  if (status.state === "idle") {
    await closeOrphanedPortalRecoveryTabs(apis);
    await clearPortalRecoveryAlarms();
    return;
  }
  await schedulePortalRecoveryCleanup();
  if (status.state === "waiting") {
    await schedulePortalRecoveryAlarm(
      PORTAL_RECOVERY_VERIFY_ALARM_NAME,
      PORTAL_RECOVERY_VERIFY_RETRY_MS
    );
    schedulePortalRecoveryVerificationTimer(PORTAL_RECOVERY_VERIFY_RETRY_MS);
  }
}

async function schedulePortalRecoveryVerification(delayMs = PORTAL_RECOVERY_VERIFY_DELAY_MS): Promise<void> {
  if (portalRecoveryVerificationInFlight) {
    portalRecoveryVerificationFollowUpRequested = true;
    return;
  }
  schedulePortalRecoveryVerificationTimer(delayMs);
  await schedulePortalRecoveryAlarm(PORTAL_RECOVERY_VERIFY_ALARM_NAME, delayMs);
}

function schedulePortalRecoveryVerificationTimer(delayMs: number): void {
  const dueAt = Date.now() + Math.max(0, delayMs);
  if (portalRecoveryVerificationTimer && portalRecoveryVerificationDueAt <= dueAt + 50) {
    return;
  }
  clearPortalRecoveryVerificationTimer();
  portalRecoveryVerificationDueAt = dueAt;
  portalRecoveryVerificationTimer = setTimeout(() => {
    portalRecoveryVerificationTimer = undefined;
    portalRecoveryVerificationDueAt = 0;
    runBestEffort(runIfExtensionEnabled(runPortalRecoveryVerification));
  }, Math.max(0, dueAt - Date.now()));
}

function clearPortalRecoveryVerificationTimer(): void {
  if (portalRecoveryVerificationTimer) {
    clearTimeout(portalRecoveryVerificationTimer);
    portalRecoveryVerificationTimer = undefined;
  }
  portalRecoveryVerificationDueAt = 0;
}

async function schedulePortalRecoveryCleanup(delayMs = PORTAL_RECOVERY_SESSION_TTL_MS): Promise<void> {
  await schedulePortalRecoveryAlarm(
    PORTAL_RECOVERY_CLEANUP_ALARM_NAME,
    delayMs
  );
}

async function schedulePortalRecoveryAlarm(name: string, delayMs: number): Promise<void> {
  const when = Date.now() + Math.max(0, delayMs);
  let existing: chrome.alarms.Alarm | undefined;
  try {
    existing = chrome.alarms?.get ? await chrome.alarms.get(name) : undefined;
  } catch {
    existing = undefined;
  }
  // Never postpone an earlier reconciliation. Repeated token headers and
  // popup openings therefore coalesce into one bounded verification pass.
  if (existing && existing.scheduledTime <= when + 250) return;
  await chrome.alarms.create(name, { when });
}

async function clearPortalRecoveryAlarms(): Promise<void> {
  clearPortalRecoveryVerificationTimer();
  await Promise.allSettled([
    chrome.alarms?.clear?.(PORTAL_RECOVERY_CLEANUP_ALARM_NAME),
    chrome.alarms?.clear?.(PORTAL_RECOVERY_VERIFY_ALARM_NAME)
  ]);
}

async function storeCapturedToken(
  tokenKind: TokenKind,
  token: string,
  source: string,
  timestamp = Date.now(),
  options: { allowIdentityChange?: boolean } = { allowIdentityChange: true }
): Promise<boolean> {
  const validation = validateCapturedToken(token, tokenKind, timestamp);
  if (!validation.ok) {
    return false;
  }
  await getStoredTokens();
  return updateStoredTokensInSession((storedTokens) => {
    const identityChanged = hasStoredTokenForAnotherIdentity(storedTokens, validation.decoded, timestamp);
    if (identityChanged && options.allowIdentityChange === false) {
      return { result: false };
    }
    const tokens = identityChanged ? {} : storedTokens;
    const remove = identityChanged ? TOKEN_STORAGE_KEYS : undefined;

    if (tokenKind === "graph") {
      const updates = getCapturedGraphTokenUpdate(tokens, token, source, timestamp, validation.decoded);
      return {
        set: updates,
        remove,
        result: Object.keys(updates).length > 0
      };
    }

    const currentToken = tokens.azureManagementToken;
    if (currentToken) {
      const currentValidation = validateCapturedToken(currentToken, tokenKind, timestamp);
      if (currentValidation.ok && shouldKeepCurrentToken(currentValidation.decoded, validation.decoded, tokenKind, timestamp)) {
        return { remove, result: false };
      }
    }

    return {
      set: {
        azureManagementToken: token,
        azureManagementTokenTimestamp: timestamp,
        azureManagementTokenSource: source
      },
      remove,
      result: true
    };
  });
}

function hasStoredTokenForAnotherIdentity(
  tokens: StoredTokens,
  incoming: Record<string, unknown>,
  now: number
): boolean {
  const incomingIdentity = getTokenIdentity(incoming);
  if (!incomingIdentity) {
    return false;
  }
  const existingTokens: Array<[string | undefined, TokenKind]> = [
    [tokens.graphToken, "graph"],
    [tokens.graphDirectoryRoleToken, "graph"],
    [tokens.graphPimGroupToken, "graph"],
    [tokens.azureManagementToken, "azureManagement"]
  ];
  return existingTokens.some(([storedToken, kind]) => {
    if (!storedToken) return false;
    const storedValidation = validateCapturedToken(storedToken, kind, now);
    const storedIdentity = storedValidation.ok ? getTokenIdentity(storedValidation.decoded) : undefined;
    return Boolean(storedIdentity && storedIdentity !== incomingIdentity);
  });
}

function getTokenIdentity(decoded: Record<string, unknown>): string | undefined {
  return typeof decoded.tid === "string" && typeof decoded.oid === "string"
    ? `${decoded.tid.toLowerCase()}:${decoded.oid.toLowerCase()}`
    : undefined;
}

function getCapturedGraphTokenUpdate(
  tokens: StoredTokens,
  token: string,
  source: string,
  timestamp: number,
  decoded: Record<string, unknown>
): Partial<StoredTokens> {
  const updates: Partial<StoredTokens> = {};

  if (shouldStoreGenericGraphToken(tokens.graphToken, decoded, timestamp)) {
    updates.graphToken = token;
    updates.tokenTimestamp = timestamp;
    updates.tokenSource = source;
  }

  for (const target of getGraphTokenTargets(decoded)) {
    if (shouldStoreTargetGraphToken(tokens, target, token, decoded, timestamp)) {
      Object.assign(updates, getGraphTokenStorageUpdate(target, token, source, timestamp));
    }
  }

  return updates;
}

function shouldStoreGenericGraphToken(currentToken: string | undefined, incoming: Record<string, unknown>, timestamp: number): boolean {
  if (!currentToken) {
    return true;
  }
  const currentValidation = validateCapturedToken(currentToken, "graph", timestamp);
  return !currentValidation.ok || !shouldKeepCurrentToken(currentValidation.decoded, incoming, "graph", timestamp);
}

function shouldStoreTargetGraphToken(
  tokens: StoredTokens,
  target: GraphTokenTarget,
  incomingToken: string,
  incoming: Record<string, unknown>,
  timestamp: number
): boolean {
  const currentToken = getStoredGraphTokenForTarget(tokens, target);
  if (!currentToken) {
    return true;
  }
  if (currentToken === incomingToken) {
    return false;
  }

  const currentValidation = validateCapturedToken(currentToken, "graph", timestamp);
  if (!currentValidation.ok) {
    return true;
  }

  const currentScore = getGraphTokenTargetScore(currentValidation.decoded, target);
  const incomingScore = getGraphTokenTargetScore(incoming, target);
  if (currentScore !== incomingScore) {
    return incomingScore > currentScore;
  }
  const currentAuthScore = getGraphTokenAuthStrengthScore(currentValidation.decoded);
  const incomingAuthScore = getGraphTokenAuthStrengthScore(incoming);
  if (currentAuthScore !== incomingAuthScore) {
    return incomingAuthScore > currentAuthScore;
  }
  const lifetimePreference = shouldKeepCurrentForUsableLifetime(currentValidation.decoded, incoming, timestamp);
  if (lifetimePreference !== undefined) {
    return !lifetimePreference;
  }
  const currentExpiry = Number(currentValidation.decoded.exp) || 0;
  const incomingExpiry = Number(incoming.exp) || 0;
  return incomingExpiry >= currentExpiry;
}

function getGraphTokenStorageUpdate(
  target: GraphTokenTarget,
  token: string,
  source: string,
  timestamp: number
): Partial<StoredTokens> {
  if (target === "directoryRole") {
    return {
      graphDirectoryRoleToken: token,
      graphDirectoryRoleTokenTimestamp: timestamp,
      graphDirectoryRoleTokenSource: source
    };
  }
  return {
    graphPimGroupToken: token,
    graphPimGroupTokenTimestamp: timestamp,
    graphPimGroupTokenSource: source
  };
}

function shouldKeepCurrentToken(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  tokenKind: TokenKind,
  now = Date.now()
): boolean {
  const currentScore = getTokenCaptureScore(current, tokenKind);
  const incomingScore = getTokenCaptureScore(incoming, tokenKind);
  if (currentScore !== incomingScore) {
    return currentScore > incomingScore;
  }
  if (tokenKind === "graph") {
    const currentAuthScore = getGraphTokenAuthStrengthScore(current);
    const incomingAuthScore = getGraphTokenAuthStrengthScore(incoming);
    if (currentAuthScore !== incomingAuthScore) {
      return currentAuthScore > incomingAuthScore;
    }
  }
  const lifetimePreference = shouldKeepCurrentForUsableLifetime(current, incoming, now);
  if (lifetimePreference !== undefined) {
    return lifetimePreference;
  }
  const currentExpiry = Number(current.exp) || 0;
  const incomingExpiry = Number(incoming.exp) || 0;
  return currentExpiry >= incomingExpiry;
}

function shouldKeepCurrentForUsableLifetime(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  now: number
): boolean | undefined {
  const usableAfter = Math.floor(now / 1000) + 5 * 60;
  const currentUsable = Number(current.exp) >= usableAfter;
  const incomingUsable = Number(incoming.exp) >= usableAfter;
  return currentUsable === incomingUsable ? undefined : currentUsable;
}

function getTokenCaptureScore(decoded: Record<string, unknown>, tokenKind: TokenKind): number {
  if (tokenKind === "azureManagement") {
    return 1;
  }
  return getGraphTokenOverallScore(decoded) || 1;
}

async function getStoredTokens(): Promise<StoredTokens> {
  return getStoredTokensFromSession();
}

async function clearTokens(): Promise<void> {
  await clearStoredTokens();
}

async function getTokenStatus(): Promise<TokenStatus> {
  const tokens = await getStoredTokens();
  const status = buildTokenStatus(tokens);
  await removeInvalidStoredTokens(tokens);
  return status;
}

function buildTokenStatus(tokens: StoredTokens): TokenStatus {
  const graphStatusToken = selectGraphTokenForStatus(tokens);
  const directoryRoleStatusToken = selectGraphTokenForTargetStatus(tokens, "directoryRole");
  const pimGroupStatusToken = selectGraphTokenForTargetStatus(tokens, "pimGroup");
  const azureValidation = tokens.azureManagementToken
    ? validateCapturedToken(tokens.azureManagementToken, "azureManagement")
    : undefined;

  return {
    graph: graphStatusToken?.token ? makeTokenStatus(graphStatusToken.token, graphStatusToken.timestamp, graphStatusToken.source) : { hasToken: false },
    graphTargets: {
      directoryRole: directoryRoleStatusToken?.token
        ? makeTokenStatus(directoryRoleStatusToken.token, directoryRoleStatusToken.timestamp, directoryRoleStatusToken.source)
        : { hasToken: false },
      pimGroup: pimGroupStatusToken?.token
        ? makeTokenStatus(pimGroupStatusToken.token, pimGroupStatusToken.timestamp, pimGroupStatusToken.source)
        : { hasToken: false }
    },
    azureManagement: azureValidation?.ok
      ? makeTokenStatus(
          tokens.azureManagementToken,
          tokens.azureManagementTokenTimestamp,
          tokens.azureManagementTokenSource
        )
      : { hasToken: false }
  };
}

async function removeInvalidStoredTokens(tokens: StoredTokens): Promise<void> {
  const groups: Array<{ tokenKey: keyof StoredTokens; expectedToken: string; keys: string[] }> = [];
  for (const group of getInvalidGraphTokenGroups(tokens)) {
    groups.push(group);
  }
  if (tokens.azureManagementToken && !validateCapturedToken(tokens.azureManagementToken, "azureManagement").ok) {
    groups.push({
      tokenKey: "azureManagementToken",
      expectedToken: tokens.azureManagementToken,
      keys: ["azureManagementToken", "azureManagementTokenTimestamp", "azureManagementTokenSource"]
    });
  }
  if (groups.length) {
    await removeStoredTokenGroupsIfMatching(groups);
  }
}

function selectGraphTokenForTargetStatus(tokens: StoredTokens, target: GraphTokenTarget): { token?: string; timestamp?: number; source?: string } | undefined {
  const targetCandidate = target === "directoryRole" && tokens.graphDirectoryRoleToken
    ? {
      token: tokens.graphDirectoryRoleToken,
      timestamp: tokens.graphDirectoryRoleTokenTimestamp,
      source: tokens.graphDirectoryRoleTokenSource
    }
    : target === "pimGroup" && tokens.graphPimGroupToken
      ? {
      token: tokens.graphPimGroupToken,
      timestamp: tokens.graphPimGroupTokenTimestamp,
      source: tokens.graphPimGroupTokenSource
      }
      : undefined;
  const genericCandidate = { token: tokens.graphToken, timestamp: tokens.tokenTimestamp, source: tokens.tokenSource };
  return selectBestStoredGraphTokenForTarget(
    [targetCandidate || {}, genericCandidate],
    target
  );
}

function selectGraphTokenForStatus(tokens: StoredTokens): { token?: string; timestamp?: number; source?: string } | undefined {
  const candidates = [
    { token: tokens.graphToken, timestamp: tokens.tokenTimestamp, source: tokens.tokenSource },
    {
      token: tokens.graphDirectoryRoleToken,
      timestamp: tokens.graphDirectoryRoleTokenTimestamp,
      source: tokens.graphDirectoryRoleTokenSource
    },
    {
      token: tokens.graphPimGroupToken,
      timestamp: tokens.graphPimGroupTokenTimestamp,
      source: tokens.graphPimGroupTokenSource
    }
  ];

  return candidates
    .filter((candidate) => Boolean(candidate.token && validateCapturedToken(candidate.token, "graph").ok))
    .sort((a, b) => {
      const aDecoded = decodeToken(a.token || "");
      const bDecoded = decodeToken(b.token || "");
      const scoreDelta = (bDecoded ? getTokenCaptureScore(bDecoded, "graph") : 0) - (aDecoded ? getTokenCaptureScore(aDecoded, "graph") : 0);
      if (scoreDelta) {
        return scoreDelta;
      }
      return (b.timestamp || 0) - (a.timestamp || 0);
    })[0];
}

function getInvalidGraphTokenGroups(tokens: StoredTokens): Array<{ tokenKey: keyof StoredTokens; expectedToken: string; keys: string[] }> {
  const groups: Array<{ tokenKey: keyof StoredTokens; token?: string; keys: string[] }> = [
    { tokenKey: "graphToken", token: tokens.graphToken, keys: ["graphToken", "tokenTimestamp", "tokenSource"] },
    { tokenKey: "graphDirectoryRoleToken", token: tokens.graphDirectoryRoleToken, keys: ["graphDirectoryRoleToken", "graphDirectoryRoleTokenTimestamp", "graphDirectoryRoleTokenSource"] },
    { tokenKey: "graphPimGroupToken", token: tokens.graphPimGroupToken, keys: ["graphPimGroupToken", "graphPimGroupTokenTimestamp", "graphPimGroupTokenSource"] }
  ];
  return groups.flatMap((group) => group.token && !validateCapturedToken(group.token, "graph").ok
    ? [{ tokenKey: group.tokenKey, expectedToken: group.token, keys: group.keys }]
    : []);
}

async function getActivationItems(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<{ items: ActivationItem[]; errors: string[]; diagnostics: AccessDiagnostic[] }> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, () => Promise<{ items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }>> = {
    directoryRole: () => fetchItemGroup("directoryRole", "graph", getGraphTokenForTarget(tokens, "directoryRole"), getDirectoryRoles, "eligible"),
    azureRole: () => fetchItemGroup("azureRole", "azureManagement", tokens.azureManagementToken, getAzureRoles, "eligible"),
    pimGroup: () => fetchItemGroup("pimGroup", "graph", getGraphTokenForTarget(tokens, "pimGroup"), getPimGroups, "eligible")
  };
  const results = await Promise.all(targets.map((target) => fetchers[target]()));

  return {
    items: dedupeItems(results.flatMap((result) => result.items)),
    errors: results.flatMap((result) => result.error ? [result.error] : []),
    diagnostics: results.flatMap((result) => {
      const nameDiagnostic = buildNameLookupDiagnostic(
        result.diagnostic.target,
        result.items,
        "eligible",
        result.diagnostic.checkedAt
      );
      return [result.diagnostic, ...(nameDiagnostic ? [nameDiagnostic] : [])];
    })
  };
}

async function getActiveItems(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<{ items: ActivationItem[]; errors: string[]; diagnostics: AccessDiagnostic[] }> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, () => Promise<{ items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }>> = {
    directoryRole: () => fetchItemGroup("directoryRole", "graph", getGraphTokenForTarget(tokens, "directoryRole"), getActiveDirectoryRoles, "active"),
    azureRole: () => fetchItemGroup("azureRole", "azureManagement", tokens.azureManagementToken, getActiveAzureRoles, "active"),
    pimGroup: () => fetchItemGroup("pimGroup", "graph", getGraphTokenForTarget(tokens, "pimGroup"), getActivePimGroups, "active")
  };
  const results = await Promise.all(targets.map((target) => fetchers[target]()));

  return {
    items: dedupeItems(results.flatMap((result) => result.items)),
    errors: results.flatMap((result) => result.error ? [result.error] : []),
    diagnostics: results.flatMap((result) => {
      const nameDiagnostic = buildNameLookupDiagnostic(
        result.diagnostic.target,
        result.items,
        "active",
        result.diagnostic.checkedAt
      );
      return [result.diagnostic, ...(nameDiagnostic ? [nameDiagnostic] : [])];
    })
  };
}

function makeFailedTargetSnapshot(target: AccessSetupTarget, error: unknown): TargetSnapshotResult {
  const message = sanitizeErrorMessage(error);
  return {
    target,
    eligible: makeSnapshotData(target, [], message, "eligible"),
    active: makeSnapshotData(target, [], message, "active")
  };
}

interface TargetSnapshotResult {
  target: AccessSetupTarget;
  eligible: ActivationDataResult;
  active: ActivationDataResult;
}

async function getActivationSnapshot(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<ActivationSnapshot> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, (signal: AbortSignal) => Promise<TargetSnapshotResult>> = {
    directoryRole: (signal) =>
      fetchSnapshotGroup(
        "directoryRole",
        "graph",
        getGraphTokenForTarget(tokens, "directoryRole"),
        getDirectoryRoleSnapshot,
        getDirectoryRoles,
        getActiveDirectoryRoles,
        signal
      ),
    azureRole: (signal) =>
      fetchSnapshotGroup(
        "azureRole",
        "azureManagement",
        tokens.azureManagementToken,
        getAzureRoleSnapshot,
        getAzureRoles,
        getActiveAzureRoles,
        signal
      ),
    pimGroup: (signal) =>
      fetchSnapshotGroup(
        "pimGroup",
        "graph",
        getGraphTokenForTarget(tokens, "pimGroup"),
        getPimGroupSnapshot,
        getPimGroups,
        getActivePimGroups,
        signal
      )
  };
  const results = await Promise.all(targets.map(async (target) => {
    try {
      return await withAbortableTimeout(
        (signal) => fetchers[target](signal),
        TARGET_SNAPSHOT_TIMEOUT_MS,
        `${ENDPOINT_LABELS[target].eligible} refresh timed out. Cached data remains available.`
      );
    } catch (error) {
      return makeFailedTargetSnapshot(target, error);
    }
  }));
  return {
    eligible: combineSnapshotResults(results, "eligible"),
    active: combineSnapshotResults(results, "active"),
    eligibleByTarget: Object.fromEntries(results.map((result) => [result.target, result.eligible])),
    activeByTarget: Object.fromEntries(results.map((result) => [result.target, result.active])),
    tokenStatus: buildTokenStatus(tokens)
  };
}

async function getActivationCoreSnapshot(targets: AccessSetupTarget[] = ["directoryRole", "azureRole", "pimGroup"]): Promise<ActivationSnapshot> {
  const tokens = await getStoredTokens();
  const fetchers: Record<AccessSetupTarget, (signal: AbortSignal) => Promise<TargetSnapshotResult>> = {
    directoryRole: (signal) =>
      fetchSnapshotGroup(
        "directoryRole",
        "graph",
        getGraphTokenForTarget(tokens, "directoryRole"),
        getDirectoryRoleCoreSnapshot,
        getDirectoryRoles,
        getActiveDirectoryRoles,
        signal
      ),
    azureRole: (signal) =>
      fetchSnapshotGroup(
        "azureRole",
        "azureManagement",
        tokens.azureManagementToken,
        getAzureRoleCoreSnapshot,
        getAzureRoles,
        getActiveAzureRoles,
        signal
      ),
    pimGroup: (signal) =>
      fetchSnapshotGroup(
        "pimGroup",
        "graph",
        getGraphTokenForTarget(tokens, "pimGroup"),
        getPimGroupCoreSnapshot,
        getPimGroups,
        getActivePimGroups,
        signal
      )
  };
  const results = await Promise.all(targets.map(async (target) => {
    try {
      return await withAbortableTimeout(
        (signal) => fetchers[target](signal),
        TARGET_SNAPSHOT_TIMEOUT_MS,
        `${ENDPOINT_LABELS[target].eligible} refresh timed out. Cached data remains available.`
      );
    } catch (error) {
      return makeFailedTargetSnapshot(target, error);
    }
  }));
  return {
    eligible: combineSnapshotResults(results, "eligible"),
    active: combineSnapshotResults(results, "active"),
    eligibleByTarget: Object.fromEntries(results.map((result) => [result.target, result.eligible])),
    activeByTarget: Object.fromEntries(results.map((result) => [result.target, result.active])),
    tokenStatus: buildTokenStatus(tokens)
  };
}

async function enrichActivationPolicies(items: ActivationItem[]): Promise<ActivationItem[]> {
  const tokens = await getStoredTokens();
  const targets = uniqueAccessTargets(items.map((item) => item.type));
  const enrichedGroups = await Promise.all(
    targets.map(async (target) => {
      const targetItems = items.filter((item) => item.type === target);
      if (target === "directoryRole") {
        const token = getGraphTokenForTarget(tokens, "directoryRole");
        if (!token) throw new Error("Graph token is missing.");
        assertFreshToken(token, "graph");
        const requirements = await getDirectoryRolePolicyRequirementsBestEffort(token);
        return targetItems.map((item) => {
          if (item.type !== "directoryRole") return markActivationPolicyReady(item);
          const itemRequirements = getRoleDefinitionLookupKeys(item.roleDefinitionId)
            .map((key) => requirements[key])
            .find(Boolean);
          return itemRequirements
            ? markActivationPolicyReady(applyActivationRequirements(item, itemRequirements))
            : markActivationPolicyPending(item);
        });
      }
      if (target === "pimGroup") {
        const token = getGraphTokenForTarget(tokens, "pimGroup");
        if (!token) throw new Error("Graph token is missing.");
        assertFreshToken(token, "graph");
        const groupIds = [...new Set(targetItems.map((item) => item.type === "pimGroup" ? item.groupId : "").filter(Boolean))];
        const requirements = await getPimGroupPolicyRequirementsBestEffort(token, groupIds);
        return targetItems.map((item) => {
          if (item.type !== "pimGroup") return markActivationPolicyReady(item);
          const groupPolicy = requirements[item.groupId];
          const itemRequirements = groupPolicy?.[item.accessId] || groupPolicy?.default;
          return itemRequirements
            ? markActivationPolicyReady(applyActivationRequirements(item, itemRequirements))
            : markActivationPolicyPending(item);
        });
      }
      const token = tokens.azureManagementToken;
      if (!token) throw new Error("Azure Management token is missing.");
      assertFreshToken(token, "azureManagement");
      return (await applyAzureRolePolicyRequirements(targetItems, token)).map((item) =>
        item.activationRequirements ? markActivationPolicyReady(item) : markActivationPolicyPending(item)
      );
    })
  );
  const enrichedById = new Map(enrichedGroups.flat().map((item) => [item.id, item]));
  return items.map((item) => enrichedById.get(item.id) || item);
}

function markActivationPolicyPending<T extends ActivationItem>(item: T): T {
  return { ...item, activationPolicyState: "pending" };
}

function markActivationPolicyReady<T extends ActivationItem>(item: T): T {
  return { ...item, activationPolicyState: "ready" };
}

async function fetchSnapshotGroup(
  target: AccessSetupTarget,
  tokenKind: TokenKind,
  token: string | undefined,
  fetcher: (token: string, signal?: AbortSignal) => Promise<[ActivationItem[], ActivationItem[]] | ActivationSnapshotFetchResult>,
  eligibleFallback: (token: string, signal?: AbortSignal) => Promise<ActivationItem[]>,
  activeFallback: (token: string, signal?: AbortSignal) => Promise<ActivationItem[]>,
  signal?: AbortSignal
): Promise<TargetSnapshotResult> {
  if (!token) {
    const error = tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.";
    return {
      target,
      eligible: makeSnapshotData(target, [], error, "eligible"),
      active: makeSnapshotData(target, [], error, "active")
    };
  }

  try {
    const fetched = await fetcher(token, signal);
    const [eligibleItems, activeItems, eligibleError, activeError] = Array.isArray(fetched)
      ? [fetched[0], fetched[1], undefined, undefined]
      : [fetched.eligibleItems, fetched.activeItems, fetched.eligibleError, fetched.activeError];
    const [eligibleRetry, activeRetry] = await Promise.all([
      eligibleError && !eligibleItems.length
        ? fetchItemGroup(target, tokenKind, token, eligibleFallback, "eligible", signal)
        : undefined,
      activeError && !activeItems.length
        ? fetchItemGroup(target, tokenKind, token, activeFallback, "active", signal)
        : undefined
    ]);
    return {
      target,
      eligible: eligibleRetry
        ? itemGroupToSnapshotData(eligibleRetry)
        : makeSnapshotData(target, attachTenantIdentity(eligibleItems, token), eligibleError, "eligible"),
      active: activeRetry
        ? itemGroupToSnapshotData(activeRetry)
        : makeSnapshotData(target, attachTenantIdentity(activeItems, token), activeError, "active")
    };
  } catch {
    const [eligible, active] = await Promise.all([
      fetchItemGroup(target, tokenKind, token, eligibleFallback, "eligible", signal),
      fetchItemGroup(target, tokenKind, token, activeFallback, "active", signal)
    ]);
    return {
      target,
      eligible: itemGroupToSnapshotData(eligible),
      active: itemGroupToSnapshotData(active)
    };
  }
}

function itemGroupToSnapshotData(result: { items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }): ActivationDataResult {
  const nameDiagnostic = buildNameLookupDiagnostic(
    result.diagnostic.target,
    result.items,
    result.diagnostic.operation === "active" ? "active" : "eligible",
    result.diagnostic.checkedAt
  );
  return {
    items: result.items,
    errors: result.error ? [result.error] : [],
    diagnostics: [result.diagnostic, ...(nameDiagnostic ? [nameDiagnostic] : [])]
  };
}

function makeSnapshotData(target: AccessSetupTarget, items: ActivationItem[], error?: string, operation: "eligible" | "active" = "eligible"): ActivationDataResult {
  const checkedAt = new Date().toISOString();
  const nameDiagnostic = buildNameLookupDiagnostic(target, items, operation, checkedAt);
  return {
    items,
    errors: error ? [error] : [],
    diagnostics: [{
      target,
      success: !error,
      checkedAt,
      operation,
      endpointLabel: ENDPOINT_LABELS[target][operation],
      ...(error ? { error, failureKind: classifyAccessFailure(error) } : {})
    }, ...(nameDiagnostic ? [nameDiagnostic] : [])]
  };
}

function combineSnapshotResults(results: TargetSnapshotResult[], bucket: "eligible" | "active"): ActivationDataResult {
  return {
    items: dedupeItems(results.flatMap((result) => result[bucket].items)),
    errors: results.flatMap((result) => result[bucket].errors),
    diagnostics: results.flatMap((result) => result[bucket].diagnostics || [])
  };
}

function getGraphTokenForTarget(tokens: StoredTokens, target: GraphTokenTarget): string | undefined {
  return selectGraphTokenForTargetStatus(tokens, target)?.token;
}

function getStoredGraphTokenForTarget(tokens: StoredTokens, target: GraphTokenTarget): string | undefined {
  return target === "directoryRole" ? tokens.graphDirectoryRoleToken : tokens.graphPimGroupToken;
}

async function fetchItemGroup(
  target: AccessSetupTarget,
  tokenKind: TokenKind,
  token: string | undefined,
  fetcher: (token: string, signal?: AbortSignal) => Promise<ActivationItem[]>,
  operation: "eligible" | "active",
  signal?: AbortSignal
): Promise<{ items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }> {
  const checkedAt = new Date().toISOString();
  if (!token) {
    return {
      items: [],
      error: tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.",
      diagnostic: {
        target,
        success: false,
        checkedAt,
        error: tokenKind === "graph" ? "Graph token is missing." : "Azure Management token is missing.",
        operation,
        endpointLabel: ENDPOINT_LABELS[target][operation],
        failureKind: "missingToken"
      }
    };
  }

  try {
    const items = attachTenantIdentity(await fetcher(token, signal), token);
    return {
      items,
      diagnostic: {
        target,
        success: true,
        checkedAt,
        operation,
        endpointLabel: ENDPOINT_LABELS[target][operation]
      }
    };
  } catch (error) {
    const sanitized = sanitizeErrorMessage(error);
    const partialItems = error instanceof PartialActivationDataError
      ? attachTenantIdentity(error.items, token)
      : [];
    return {
      items: partialItems,
      error: sanitized,
      diagnostic: {
        target,
        success: false,
        checkedAt,
        error: sanitized,
        operation,
        endpointLabel: ENDPOINT_LABELS[target][operation],
        failureKind: classifyAccessFailure(sanitized)
      }
    };
  }
}

function attachTenantIdentity(items: ActivationItem[], token: string): ActivationItem[] {
  const tenantId = getTokenTenantId(token);
  return tenantId ? items.map((item) => ({ ...item, tenantId })) : items;
}

async function getDirectoryRoles(graphToken: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const roles = await fetchAllPages<DirectoryRoleApi>(
    graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilityScheduleInstances/filterByCurrentUser(on='principal')?${new URLSearchParams({ "$expand": "roleDefinition" }).toString()}`),
    graphToken,
    signal
  );
  const [definitions, scopeNames, policyRequirements] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken, signal),
    getDirectoryScopeNamesBestEffort(graphToken, roles, signal),
    getDirectoryRolePolicyRequirementsBestEffort(graphToken, signal)
  ]);

  return roles.map((role) => {
    const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
    const item = normalizeDirectoryRole(namedRole);
    return applyActivationRequirements(
      item,
      policyRequirements[item.roleDefinitionId.toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
    );
  });
}

async function getDirectoryRoleSnapshot(graphToken: string, signal?: AbortSignal): Promise<ActivationSnapshotFetchResult> {
  assertFreshToken(graphToken, "graph");
  const [eligibleResult, instancesResult, requestsResult] = await Promise.allSettled([
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilityScheduleInstances/filterByCurrentUser(on='principal')?${new URLSearchParams({ "$expand": "roleDefinition" }).toString()}`),
      graphToken,
      signal
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleInstances/filterByCurrentUser(on='principal')?$expand=roleDefinition"),
      graphToken,
      signal
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    )
  ]);
  if (eligibleResult.status === "rejected" && instancesResult.status === "rejected" && requestsResult.status === "rejected") {
    throw eligibleResult.reason;
  }
  const eligibleRoles = eligibleResult.status === "fulfilled" ? eligibleResult.value : [];
  const assignmentInstances = instancesResult.status === "fulfilled" ? instancesResult.value : [];
  const assignmentRequests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const [definitions, scopeNames, policyRequirements] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken, signal),
    getDirectoryScopeNamesBestEffort(graphToken, [...eligibleRoles, ...assignmentInstances, ...assignmentRequests], signal),
    getDirectoryRolePolicyRequirementsBestEffort(graphToken, signal)
  ]);
  const eligible = eligibleRoles.map((role) => {
    const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
    const item = normalizeDirectoryRole(namedRole);
    return applyActivationRequirements(
      item,
      policyRequirements[item.roleDefinitionId.toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
        policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
    );
  });
  const active = getDirectoryRoleActiveInstanceItems(assignmentInstances, definitions, scopeNames, policyRequirements);
  const pending = getDirectoryRolePendingRequestItems(assignmentRequests, definitions, scopeNames, policyRequirements);
  return {
    eligibleItems: eligible,
    activeItems: [...pending, ...active],
    ...(eligibleResult.status === "rejected" ? { eligibleError: sanitizeErrorMessage(eligibleResult.reason) } : {}),
    ...(instancesResult.status === "rejected" ? { activeError: sanitizeErrorMessage(instancesResult.reason) } : {})
  };
}

async function getDirectoryRoleCoreSnapshot(graphToken: string, signal?: AbortSignal): Promise<ActivationSnapshotFetchResult> {
  assertFreshToken(graphToken, "graph");
  const [eligibleResult, instancesResult, requestsResult] = await Promise.allSettled([
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilityScheduleInstances/filterByCurrentUser(on='principal')?${new URLSearchParams({ "$expand": "roleDefinition" }).toString()}`),
      graphToken,
      signal
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleInstances/filterByCurrentUser(on='principal')?$expand=roleDefinition"),
      graphToken,
      signal
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    )
  ]);
  if (eligibleResult.status === "rejected" && instancesResult.status === "rejected" && requestsResult.status === "rejected") {
    throw eligibleResult.reason;
  }
  const eligibleRoles = eligibleResult.status === "fulfilled" ? eligibleResult.value : [];
  const assignmentInstances = instancesResult.status === "fulfilled" ? instancesResult.value : [];
  const assignmentRequests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const [definitions, scopeNames] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken, signal),
    getDirectoryScopeNamesBestEffort(graphToken, [...eligibleRoles, ...assignmentInstances, ...assignmentRequests], signal)
  ]);
  const eligible = eligibleRoles.map((role) => {
    const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
    return markActivationPolicyPending(normalizeDirectoryRole(namedRole));
  });
  const active = getDirectoryRoleActiveInstanceItems(assignmentInstances, definitions, scopeNames).map(markActivationPolicyPending);
  const pending = getDirectoryRolePendingRequestItems(assignmentRequests, definitions, scopeNames).map(markActivationPolicyPending);
  return {
    eligibleItems: eligible,
    activeItems: [...pending, ...active],
    ...(eligibleResult.status === "rejected" ? { eligibleError: sanitizeErrorMessage(eligibleResult.reason) } : {}),
    ...(instancesResult.status === "rejected" ? { activeError: sanitizeErrorMessage(instancesResult.reason) } : {})
  };
}

function getDirectoryRoleActiveInstanceItems(
  instances: DirectoryRoleApi[],
  definitions: Record<string, DirectoryRoleDefinitionInfo>,
  scopeNames: Record<string, string>,
  policyRequirements: Record<string, Partial<ActivationRequirements>> = {}
): ActivationItem[] {
  const now = Date.now();
  return instances
    .map((role) => ({
      role,
      activeUntil: getActiveUntilFromScheduleInfo({ expiration: { endDateTime: role.endDateTime } })
    }))
    .filter(({ activeUntil }) => !activeUntil || Date.parse(activeUntil) > now)
    .map(({ role, activeUntil }) => {
      const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
      const item = normalizeDirectoryRole(namedRole);
      const activeAssignmentType = normalizeActiveAssignmentType(role.assignmentType);
      const isSelfActivated = activeAssignmentType === "activated";
      return {
        ...applyActivationRequirements(
          item,
          policyRequirements[item.roleDefinitionId.toLowerCase()] ||
            policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
            policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
        ),
        status: "active" as const,
        activeAssignmentType,
        ...(activeUntil ? { activeUntil } : {}),
        ...(isSelfActivated && role.roleAssignmentScheduleId ? { assignmentScheduleId: role.roleAssignmentScheduleId } : {}),
        ...(isSelfActivated && role.id ? { assignmentScheduleInstanceId: role.id } : {})
      };
    });
}

function getDirectoryRolePendingRequestItems(
  requests: DirectoryRoleApi[],
  definitions: Record<string, DirectoryRoleDefinitionInfo>,
  scopeNames: Record<string, string>,
  policyRequirements: Record<string, Partial<ActivationRequirements>> = {}
): ActivationItem[] {
  return requests
    .map((role) => {
      const status = getScheduleRequestActivationStatus(role);
      return { role, status };
    })
    .filter((request): request is { role: DirectoryRoleApi; status: "pendingApproval" } =>
      request.status === "pendingApproval"
    )
    .map(({ role, status }) => {
      const namedRole = withDirectoryRoleScopeName(withDirectoryRoleDefinitionName(role, definitions), scopeNames);
      const item = normalizeDirectoryRole(namedRole);
      return {
        ...applyActivationRequirements(
          item,
          policyRequirements[item.roleDefinitionId.toLowerCase()] ||
            policyRequirements[(namedRole.roleDefinition?.id || "").toLowerCase()] ||
            policyRequirements[(namedRole.roleDefinition?.templateId || "").toLowerCase()]
        ),
        status
      };
    });
}

function getScheduleRequestActivationStatus(request: { action?: string; status?: string }): Exclude<ActivationStatus, "eligible"> | undefined {
  if (!isSelfActivateRequest(request)) {
    return undefined;
  }
  return getActivationRequestItemStatus(request.status);
}

function isSelfActivateRequest(request: { action?: string }): boolean {
  return request.action?.replace(/\s+/g, "").toLowerCase() === "selfactivate";
}

interface DirectoryRoleDefinitionInfo {
  displayName?: string;
  isPrivileged?: boolean;
}

async function getDirectoryRoleDefinitions(graphToken: string, signal?: AbortSignal): Promise<Record<string, DirectoryRoleDefinitionInfo>> {
  const roles = await fetchAllPages<DirectoryRoleDefinitionApi>(
    graphApiUrl("/v1.0/roleManagement/directory/roleDefinitions"),
    graphToken,
    signal
  );
  return buildDirectoryRoleDefinitionInfoMap(roles);
}

async function getDirectoryRoleDefinitionsBestEffort(graphToken: string, signal?: AbortSignal): Promise<Record<string, DirectoryRoleDefinitionInfo>> {
  try {
    return await getDirectoryRoleDefinitions(graphToken, signal);
  } catch {
    return {};
  }
}

async function getDirectoryRolePolicyRequirementsBestEffort(
  graphToken: string,
  signal?: AbortSignal
): Promise<Record<string, Partial<ActivationRequirements>>> {
  const scopeTypes = ["DirectoryRole", "Directory"];
  const results = await Promise.allSettled(
    scopeTypes.map((scopeType) => {
      const query = new URLSearchParams({
        "$filter": `scopeId eq '/' and scopeType eq '${scopeType}'`,
        "$expand": "policy($expand=rules)"
      });
      return fetchAllPages<RoleManagementPolicyAssignmentApi>(
        graphApiUrl(`/beta/policies/roleManagementPolicyAssignments?${query.toString()}`),
        graphToken,
        signal
      );
    })
  );

  return buildRolePolicyRequirementMap(
    results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
  );
}

function buildDirectoryRoleDefinitionInfoMap(roles: DirectoryRoleDefinitionApi[]): Record<string, DirectoryRoleDefinitionInfo> {
  const result: Record<string, DirectoryRoleDefinitionInfo> = {};
  for (const role of roles) {
    const info: DirectoryRoleDefinitionInfo = {
      ...(role.displayName ? { displayName: role.displayName } : {}),
      ...(typeof role.isPrivileged === "boolean" ? { isPrivileged: role.isPrivileged } : {})
    };
    if (role.id) {
      result[role.id.toLowerCase()] = info;
    }
    if (role.templateId) {
      result[role.templateId.toLowerCase()] = info;
    }
  }
  return result;
}

function withDirectoryRoleDefinitionName(role: DirectoryRoleApi, definitions: Record<string, DirectoryRoleDefinitionInfo>): DirectoryRoleApi {
  const roleDefinitionId = role.roleDefinitionId || role.roleDefinition?.id || role.roleDefinition?.templateId || role.id || "";
  const definition =
    definitions[roleDefinitionId.toLowerCase()] ||
    definitions[(role.roleDefinition?.id || "").toLowerCase()] ||
    definitions[(role.roleDefinition?.templateId || "").toLowerCase()];
  return {
    ...role,
    roleName:
      role.roleName ||
      role.roleDefinition?.displayName ||
      definition?.displayName,
    isPrivileged: role.isPrivileged ?? role.roleDefinition?.isPrivileged ?? definition?.isPrivileged
  };
}

async function getDirectoryScopeNamesBestEffort(
  graphToken: string,
  roles: Array<Pick<DirectoryRoleApi, "directoryScopeId">>,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const scopeIds = [
    ...new Set(
      roles
        .map((role) => role.directoryScopeId || "/")
        .filter((scopeId) => scopeId && scopeId !== "/")
    )
  ];
  if (!scopeIds.length) {
    return {};
  }

  const entries = await mapWithConcurrency(scopeIds, 6, async (scopeId) => {
    const displayName = await fetchDirectoryScopeDisplayName(graphToken, scopeId, signal);
    return displayName ? ([scopeId, displayName] as const) : undefined;
  });
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}

async function fetchDirectoryScopeDisplayName(graphToken: string, directoryScopeId: string, signal?: AbortSignal): Promise<string | undefined> {
  const objectId = extractDirectoryScopeObjectId(directoryScopeId);
  if (!objectId) {
    return undefined;
  }

  for (const url of getDirectoryScopeLookupUrls(directoryScopeId, objectId)) {
    try {
      const data = await fetchJson<{ displayName?: string; userPrincipalName?: string }>(url, graphToken, signal);
      const displayName = data.displayName || data.userPrincipalName;
      if (displayName) {
        return displayName;
      }
    } catch {
      // Keep trying narrower fallback endpoints because scope IDs can be typed or raw object paths.
    }
  }
  return undefined;
}

function getDirectoryScopeLookupUrls(directoryScopeId: string, objectId: string): string[] {
  const normalized = directoryScopeId.toLowerCase();
  const encodedId = encodePathSegment(objectId);

  if (normalized.startsWith("/administrativeunits/")) {
    return [graphApiUrl(`/v1.0/directory/administrativeUnits/${encodedId}?$select=id,displayName`)];
  }

  if (normalized.startsWith("/devices/")) {
    return [graphApiUrl(`/v1.0/devices/${encodedId}?$select=id,displayName`)];
  }

  if (normalized.startsWith("/groups/")) {
    return [graphApiUrl(`/v1.0/groups/${encodedId}?$select=id,displayName`)];
  }

  if (normalized.startsWith("/users/")) {
    return [graphApiUrl(`/v1.0/users/${encodedId}?$select=id,displayName,userPrincipalName`)];
  }

  return [
    graphApiUrl(`/v1.0/directoryObjects/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/directory/administrativeUnits/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/devices/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/groups/${encodedId}?$select=id,displayName`),
    graphApiUrl(`/v1.0/users/${encodedId}?$select=id,displayName,userPrincipalName`)
  ];
}

function extractDirectoryScopeObjectId(directoryScopeId: string): string | undefined {
  const parts = directoryScopeId.split("/").filter(Boolean);
  return parts.at(-1);
}

function withDirectoryRoleScopeName(role: DirectoryRoleApi, scopeNames: Record<string, string>): DirectoryRoleApi {
  const directoryScopeId = role.directoryScopeId || "/";
  const scopeName = role.directoryScope?.displayName || scopeNames[directoryScopeId];
  return scopeName ? { ...role, directoryScopeDisplayName: scopeName } : role;
}

async function getPimGroups(graphToken: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const schedules = await fetchAllPages<PimGroupApi>(
    graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances/filterByCurrentUser(on='principal')"),
    graphToken,
    signal
  );
  const groupIds = [...new Set(schedules.map((schedule) => schedule.groupId).filter(Boolean) as string[])];
  const groupInfos = await getGroupInfos(
    graphToken,
    groupIds,
    signal
  );
  const policyRequirements = await getPimGroupPolicyRequirementsBestEffort(graphToken, groupIds, signal);

  return schedules.map((schedule) => {
    const item = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
    const groupPolicy = policyRequirements[item.groupId];
    return applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default);
  });
}

async function getPimGroupSnapshot(graphToken: string, signal?: AbortSignal): Promise<ActivationSnapshotFetchResult> {
  assertFreshToken(graphToken, "graph");
  const [eligibleResult, instancesResult, requestsResult] = await Promise.allSettled([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    )
  ]);
  if (eligibleResult.status === "rejected" && instancesResult.status === "rejected" && requestsResult.status === "rejected") {
    throw eligibleResult.reason;
  }
  const eligibleSchedules = eligibleResult.status === "fulfilled" ? eligibleResult.value : [];
  const activeSchedules = instancesResult.status === "fulfilled" ? instancesResult.value : [];
  const assignmentRequests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const groupIds = [
    ...new Set(
      [...eligibleSchedules, ...activeSchedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const [groupInfos, policyRequirements] = await Promise.all([
    getGroupInfos(graphToken, groupIds, signal),
    getPimGroupPolicyRequirementsBestEffort(
      graphToken,
      groupIds,
      signal
    )
  ]);
  const eligible = eligibleSchedules.map((schedule) => {
    const item = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
    const groupPolicy = policyRequirements[item.groupId];
    return applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default);
  });
  const active = getActivePimGroupInstanceItems(activeSchedules, groupInfos, policyRequirements);
  const pending = getPimGroupPendingRequestItems(assignmentRequests, groupInfos, policyRequirements);
  return {
    eligibleItems: eligible,
    activeItems: [...pending, ...active],
    ...(eligibleResult.status === "rejected" ? { eligibleError: sanitizeErrorMessage(eligibleResult.reason) } : {}),
    ...(instancesResult.status === "rejected" ? { activeError: sanitizeErrorMessage(instancesResult.reason) } : {})
  };
}

async function getPimGroupCoreSnapshot(graphToken: string, signal?: AbortSignal): Promise<ActivationSnapshotFetchResult> {
  assertFreshToken(graphToken, "graph");
  const [eligibleResult, instancesResult, requestsResult] = await Promise.allSettled([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    )
  ]);
  if (eligibleResult.status === "rejected" && instancesResult.status === "rejected" && requestsResult.status === "rejected") {
    throw eligibleResult.reason;
  }
  const eligibleSchedules = eligibleResult.status === "fulfilled" ? eligibleResult.value : [];
  const activeSchedules = instancesResult.status === "fulfilled" ? instancesResult.value : [];
  const assignmentRequests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const groupIds = [
    ...new Set(
      [...eligibleSchedules, ...activeSchedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const groupInfos = await getGroupInfos(graphToken, groupIds, signal);
  const eligible = eligibleSchedules.map((schedule) =>
    markActivationPolicyPending(normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]))
  );
  const active = getActivePimGroupInstanceItems(activeSchedules, groupInfos, {}).map(markActivationPolicyPending);
  const pending = getPimGroupPendingRequestItems(assignmentRequests, groupInfos, {}).map(markActivationPolicyPending);
  return {
    eligibleItems: eligible,
    activeItems: [...pending, ...active],
    ...(eligibleResult.status === "rejected" ? { eligibleError: sanitizeErrorMessage(eligibleResult.reason) } : {}),
    ...(instancesResult.status === "rejected" ? { activeError: sanitizeErrorMessage(instancesResult.reason) } : {})
  };
}

function getActivePimGroupInstanceItems(
  instances: PimGroupApi[],
  groupInfos: Record<string, GroupInfo>,
  policyRequirements: Record<string, Record<string, Partial<ActivationRequirements>>>
): ActivationItem[] {
  const now = Date.now();
  return instances
    .map((schedule) => ({
      schedule,
      activeUntil: getActiveUntilFromScheduleInfo({ expiration: { endDateTime: schedule.endDateTime } })
        || getActiveUntilFromScheduleInfo(schedule.scheduleInfo)
    }))
    .filter(({ activeUntil }) => !activeUntil || Date.parse(activeUntil) > now)
    .map(({ schedule, activeUntil }) => {
      const normalized = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
      const groupPolicy = policyRequirements[normalized.groupId];
      const item = applyActivationRequirements(normalized, groupPolicy?.[normalized.accessId] || groupPolicy?.default);
      const activeAssignmentType = normalizeActiveAssignmentType(schedule.assignmentType);
      const isSelfActivated = activeAssignmentType === "activated";
      return {
        ...item,
        status: "active" as const,
        activeAssignmentType,
        assignmentScheduleId: isSelfActivated ? schedule.assignmentScheduleId : undefined,
        assignmentScheduleInstanceId: isSelfActivated ? schedule.id : undefined,
        ...(activeUntil ? { activeUntil } : {})
      };
    });
}

function getPimGroupPendingRequestItems(
  requests: PimGroupApi[],
  groupInfos: Record<string, GroupInfo>,
  policyRequirements: Record<string, Record<string, Partial<ActivationRequirements>>>
): ActivationItem[] {
  return requests
    .filter((request) => getScheduleRequestActivationStatus(request) === "pendingApproval")
    .map((request) => {
      const item = normalizePimGroup(request, groupInfos[request.groupId || ""]);
      const groupPolicy = policyRequirements[item.groupId];
      return {
        ...applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default),
        status: "pendingApproval" as const
      };
    });
}

async function getPimGroupPolicyRequirementsBestEffort(
  graphToken: string,
  groupIds: string[],
  signal?: AbortSignal
): Promise<Record<string, Record<string, Partial<ActivationRequirements>>>> {
  const entries = await mapWithConcurrency(
    groupIds,
    4,
    async (groupId) => {
      try {
        const query = new URLSearchParams({
          "$filter": `scopeId eq '${groupId}' and scopeType eq 'Group'`,
          "$expand": "policy($expand=rules)"
        });
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          graphApiUrl(`/beta/policies/roleManagementPolicyAssignments?${query.toString()}`),
          graphToken,
          signal
        );
        const requirementsByRole = buildRolePolicyRequirementMap(assignments);
        const byAccess: Record<string, Partial<ActivationRequirements>> = {};
        for (const assignment of assignments) {
          const accessId = getPimGroupPolicyAccessId(assignment);
          if (!accessId) continue;
          const requirements = getRoleDefinitionLookupKeys(assignment.roleDefinitionId)
            .concat(getRoleDefinitionLookupKeys(assignment.properties?.roleDefinitionId))
            .concat(getRoleDefinitionLookupKeys(assignment.id))
            .map((key) => requirementsByRole[key])
            .find(Boolean);
          if (requirements) byAccess[accessId] = requirements;
        }
        return [
          groupId,
          Object.keys(byAccess).length
            ? byAccess
            : Object.fromEntries(Object.entries(requirementsByRole).map(([, requirements]) => ["default", requirements]))
        ] as const;
      } catch {
        return [groupId, {}] as const;
      }
    }
  );
  return Object.fromEntries(entries);
}

function getPimGroupPolicyAccessId(assignment: RoleManagementPolicyAssignmentApi): "member" | "owner" | undefined {
  const candidates = [assignment.roleDefinitionId, assignment.properties?.roleDefinitionId, assignment.id]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (candidates.some((parts) => parts.includes("owner"))) return "owner";
  if (candidates.some((parts) => parts.includes("member"))) return "member";
  return undefined;
}

async function getGroupInfos(graphToken: string, groupIds: string[], signal?: AbortSignal): Promise<Record<string, GroupInfo>> {
  const uniqueIds = [...new Set(groupIds.filter(Boolean))];
  const entries = await mapWithConcurrency(
    chunkItems(uniqueIds, GRAPH_BATCH_REQUEST_LIMIT),
    3,
    async (batchIds) => {
      const fallbackEntries = batchIds.map((groupId) => [groupId, { id: groupId, displayName: groupId }] as const);
      try {
        const response = await fetchGraphBatch<GroupInfo>(
          batchIds.map((groupId, index) => ({
            id: String(index),
            method: "GET",
            url: `/groups/${encodePathSegment(groupId)}?$select=id,displayName,description,mail`
          })),
          graphToken,
          signal
        );
        const responsesById = new Map((response.responses || []).map((item) => [item.id, item]));
        return await Promise.all(batchIds.map(async (groupId, index) => {
          const item = responsesById.get(String(index));
          const group = item?.status && item.status >= 200 && item.status < 300 ? item.body : undefined;
          if (group?.id) return [groupId, group] as const;
          if (item?.status === 429 || (item?.status !== undefined && item.status >= 500)) {
            await delay(getGraphBatchRetryDelayMs(item.headers));
            try {
              const retried = await retryTransientMicrosoftRead(() => fetchJson<GroupInfo>(
                graphApiUrl(`/v1.0/groups/${encodePathSegment(groupId)}?$select=id,displayName,description,mail`),
                graphToken,
                signal
              ));
              if (retried.id) return [groupId, retried] as const;
            } catch {
              // Keep the stable local ID fallback below.
            }
          }
          return [groupId, { id: groupId, displayName: groupId }] as const;
        }));
      } catch {
        return fallbackEntries;
      }
    }
  );
  return Object.fromEntries(entries.flat());
}

function getGraphBatchRetryDelayMs(headers: Record<string, string> | undefined): number {
  const raw = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(5_000, Math.max(TRANSIENT_READ_RETRY_DELAY_MS, seconds * 1_000))
    : TRANSIENT_READ_RETRY_DELAY_MS;
}

async function getAzureRoles(azureManagementToken: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const scopeResult = await getAzureRoleScopes(azureManagementToken, signal);
  const result = await getAzureRolesForScopes(azureManagementToken, scopeResult.scopes, true, signal);
  return returnOrThrowPartialAzureData(result, scopeResult.warnings, "eligible Azure roles");
}

async function getAzureRoleSnapshot(azureManagementToken: string, signal?: AbortSignal): Promise<ActivationSnapshotFetchResult> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const scopeResult = await getAzureRoleScopes(azureManagementToken, signal);
  const [eligibleResult, activeResult] = await Promise.allSettled([
    getAzureRolesForScopes(azureManagementToken, scopeResult.scopes, true, signal),
    getActiveAzureRolesForScopes(azureManagementToken, scopeResult.scopes, signal)
  ]);
  if (eligibleResult.status === "rejected" && activeResult.status === "rejected") {
    throw eligibleResult.reason;
  }
  const eligible = eligibleResult.status === "fulfilled" ? eligibleResult.value : { items: [], warnings: [] };
  const active = activeResult.status === "fulfilled" ? activeResult.value : { items: [], warnings: [] };
  return {
    eligibleItems: eligible.items,
    activeItems: active.items,
    eligibleError: eligibleResult.status === "rejected"
      ? sanitizeErrorMessage(eligibleResult.reason)
      : formatAzurePartialWarning([...scopeResult.warnings, ...eligible.warnings], "eligible Azure roles"),
    activeError: activeResult.status === "rejected"
      ? sanitizeErrorMessage(activeResult.reason)
      : formatAzurePartialWarning([...scopeResult.warnings, ...active.warnings], "active Azure roles")
  };
}

async function getAzureRoleCoreSnapshot(azureManagementToken: string, signal?: AbortSignal): Promise<ActivationSnapshotFetchResult> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const scopeResult = await getAzureRoleScopes(azureManagementToken, signal);
  const [eligibleResult, activeResult] = await Promise.allSettled([
    getAzureRolesForScopes(azureManagementToken, scopeResult.scopes, false, signal),
    getActiveAzureRolesForScopes(azureManagementToken, scopeResult.scopes, signal)
  ]);
  if (eligibleResult.status === "rejected" && activeResult.status === "rejected") {
    throw eligibleResult.reason;
  }
  const eligible = eligibleResult.status === "fulfilled" ? eligibleResult.value : { items: [], warnings: [] };
  const active = activeResult.status === "fulfilled" ? activeResult.value : { items: [], warnings: [] };
  return {
    eligibleItems: eligible.items.map(markActivationPolicyPending),
    activeItems: active.items.map(markActivationPolicyPending),
    eligibleError: eligibleResult.status === "rejected"
      ? sanitizeErrorMessage(eligibleResult.reason)
      : formatAzurePartialWarning([...scopeResult.warnings, ...eligible.warnings], "eligible Azure roles"),
    activeError: activeResult.status === "rejected"
      ? sanitizeErrorMessage(activeResult.reason)
      : formatAzurePartialWarning([...scopeResult.warnings, ...active.warnings], "active Azure roles")
  };
}

async function getAzureRolesForScopes(
  azureManagementToken: string,
  scopes: AzureRoleScope[],
  includePolicies = true,
  signal?: AbortSignal
): Promise<AzureRoleLoadResult> {
  const roleGroups = await mapWithConcurrencySettled(
    scopes,
    4,
    async (scope) => {
      const roles = await retryTransientMicrosoftRead(() =>
        fetchAllPages<AzureRoleApi>(
          azureManagementUrl(
            `${scope.scope}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=asTarget()`
          ),
          azureManagementToken,
          signal
        )
      );
      return roles.map((role) => normalizeAzureRole(withAzureScopeContext(role, scope)));
    }
  );

  assertAtLeastOneAzureScopeSucceeded(roleGroups, "eligible Azure roles");
  const items = dedupeItems(roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : [])));
  const itemsWithPolicies = includePolicies ? await applyAzureRolePolicyRequirements(items, azureManagementToken, signal) : items;
  return {
    items: await applyAzureRoleDefinitionMetadata(itemsWithPolicies, azureManagementToken, signal),
    warnings: getAzureScopeWarnings(roleGroups, scopes)
  };
}

async function applyAzureRolePolicyRequirements(items: ActivationItem[], token: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const uniqueScopes = [...new Set(azureItems.map((item) => item.scope))];
  const policyEntries = await mapWithConcurrency(
    uniqueScopes,
    4,
    async (scope) => {
      try {
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          azureManagementUrl(`${scope}/providers/Microsoft.Authorization/roleManagementPolicyAssignments?api-version=2020-10-01`),
          token,
          signal
        );
        return [scope, buildRolePolicyRequirementMap(assignments)] as const;
      } catch {
        return [scope, {}] as const;
      }
    }
  );
  const requirementsByScope = Object.fromEntries(policyEntries);

  return items.map((item) => {
    if (item.type !== "azureRole") {
      return item;
    }

    const scopeRequirements = requirementsByScope[item.scope] || {};
    const requirements = getRoleDefinitionLookupKeys(item.roleDefinitionId)
      .map((key) => scopeRequirements[key])
      .find(Boolean);
    return applyActivationRequirements(item, requirements);
  });
}

async function getSubscriptions(token: string, signal?: AbortSignal): Promise<Array<{ subscriptionId: string; displayName: string }>> {
  return fetchAllPages<Array<{ subscriptionId: string; displayName: string }>[number]>(
    azureManagementUrl("/subscriptions?api-version=2020-01-01"),
    token,
    signal
  );
}

async function getAzureRoleScopes(token: string, signal?: AbortSignal): Promise<AzureRoleScopeResult> {
  const [subscriptions, managementGroups] = await Promise.allSettled([
    retryTransientMicrosoftRead(() => getSubscriptions(token, signal)),
    retryTransientMicrosoftRead(() => fetchAllPages<AzureManagementGroupApi>(
      azureManagementUrl("/providers/Microsoft.Management/managementGroups?api-version=2020-05-01"),
      token,
      signal
    ))
  ]);
  if (subscriptions.status === "rejected" && managementGroups.status === "rejected") {
    throw new Error(`Unable to enumerate Azure scopes. ${sanitizeErrorMessage(subscriptions.reason)}`.trim());
  }
  const scopes: AzureRoleScope[] = [
    ...(subscriptions.status === "fulfilled" ? subscriptions.value.map((subscription) => ({
      scope: `/subscriptions/${subscription.subscriptionId}`,
      displayName: subscription.displayName || subscription.subscriptionId,
      subscriptionId: subscription.subscriptionId
    })) : []),
    ...(managementGroups.status === "fulfilled" ? managementGroups.value.flatMap((group) => {
      const name = group.name || group.id?.split("/").filter(Boolean).at(-1);
      return name ? [{
        scope: `/providers/Microsoft.Management/managementGroups/${name}`,
        displayName: group.properties?.displayName || name
      }] : [];
    }) : [])
  ];
  const warnings = [
    ...(subscriptions.status === "rejected"
      ? [`Azure subscriptions could not be enumerated: ${sanitizeErrorMessage(subscriptions.reason)}`]
      : []),
    ...(managementGroups.status === "rejected"
      ? [`Azure management groups could not be enumerated: ${sanitizeErrorMessage(managementGroups.reason)}`]
      : [])
  ];
  const dedupedScopes = dedupeAzureScopes(scopes);
  if (!dedupedScopes.length) {
    throw new Error("Azure returned no accessible subscriptions or management groups for the captured portal token.");
  }
  return { scopes: dedupedScopes, warnings };
}

async function getActiveDirectoryRoles(graphToken: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const [instancesResult, requestsResult] = await Promise.allSettled([
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleInstances/filterByCurrentUser(on='principal')?$expand=roleDefinition"),
      graphToken,
      signal
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    )
  ]);
  if (instancesResult.status === "rejected") throw instancesResult.reason;
  const instances = instancesResult.value;
  const requests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const [definitions, scopeNames] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken, signal),
    getDirectoryScopeNamesBestEffort(graphToken, [...instances, ...requests], signal)
  ]);
  return [
    ...getDirectoryRolePendingRequestItems(requests, definitions, scopeNames),
    ...getDirectoryRoleActiveInstanceItems(instances, definitions, scopeNames)
  ];
}

async function getActiveAzureRoles(azureManagementToken: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const scopeResult = await getAzureRoleScopes(azureManagementToken, signal);
  const result = await getActiveAzureRolesForScopes(azureManagementToken, scopeResult.scopes, signal);
  return returnOrThrowPartialAzureData(result, scopeResult.warnings, "active Azure roles");
}

async function getActiveAzureRolesForScopes(
  azureManagementToken: string,
  scopes: AzureRoleScope[],
  signal?: AbortSignal
): Promise<AzureRoleLoadResult> {
  const now = Date.now();
  const roleGroups = await mapWithConcurrencySettled(
    scopes,
    4,
    async (scope) => {
      const roles = await retryTransientMicrosoftRead(() =>
        fetchAllPages<AzureRoleApi>(
          azureManagementUrl(
            `${scope.scope}/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=2020-10-01&$filter=asTarget()`
          ),
          azureManagementToken,
          signal
        )
      );
      return roles
        .map((role) => ({
          role,
          activeUntil: getActiveUntilFromScheduleInfo({ expiration: { endDateTime: role.properties?.endDateTime } })
        }))
        .filter(({ activeUntil }) => !activeUntil || Date.parse(activeUntil) > now)
        .map(({ role, activeUntil }) => {
          const item = normalizeAzureRole(withAzureScopeContext(role, scope));
          const activeAssignmentType = normalizeActiveAssignmentType(role.properties?.assignmentType);
          const isSelfActivated = activeAssignmentType === "activated";
          return {
            ...item,
            status: "active" as const,
            activeAssignmentType,
            assignmentScheduleId: isSelfActivated ? item.assignmentScheduleId : undefined,
            assignmentScheduleInstanceId: isSelfActivated ? item.assignmentScheduleInstanceId : undefined,
            ...(activeUntil ? { activeUntil } : {})
          };
        });
    }
  );

  assertAtLeastOneAzureScopeSucceeded(roleGroups, "active Azure roles");
  return {
    items: await applyAzureRoleDefinitionMetadata(
      dedupeItems(roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : []))),
      azureManagementToken,
      signal
    ),
    warnings: getAzureScopeWarnings(roleGroups, scopes)
  };
}

function assertAtLeastOneAzureScopeSucceeded<T>(
  results: Array<PromiseSettledResult<T>>,
  operation: string
): void {
  if (results.length && results.every((result) => result.status === "rejected")) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw new Error(`Unable to load ${operation} data from any subscription. ${sanitizeErrorMessage(firstError)}`.trim());
  }
}

function withAzureScopeContext(role: AzureRoleApi, scope: AzureRoleScope): AzureRoleApi {
  const expandedProperties = role.properties?.expandedProperties || {};
  return {
    ...role,
    ...(scope.subscriptionId ? { subscriptionId: scope.subscriptionId, subscriptionName: scope.displayName } : {}),
    properties: {
      ...role.properties,
      scope: role.properties?.scope || scope.scope,
      expandedProperties: {
        ...expandedProperties,
        scope: expandedProperties.scope || {
          id: scope.scope,
          displayName: scope.displayName,
          type: scope.subscriptionId ? "subscription" : "managementGroup"
        }
      }
    }
  };
}

function dedupeAzureScopes(scopes: AzureRoleScope[]): AzureRoleScope[] {
  return [...new Map(scopes.map((scope) => [scope.scope.toLowerCase(), scope])).values()];
}

function getAzureScopeWarnings<T>(results: Array<PromiseSettledResult<T>>, scopes: AzureRoleScope[]): string[] {
  return results.flatMap((result, index) => result.status === "rejected"
    ? [`${scopes[index]?.displayName || scopes[index]?.scope || "Azure scope"}: ${sanitizeErrorMessage(result.reason)}`]
    : []);
}

function formatAzurePartialWarning(warnings: string[], operation: string): string | undefined {
  const unique = [...new Set(warnings.filter(Boolean))];
  return unique.length
    ? `Some ${operation} data could not be loaded (${unique.length} scope issue${unique.length === 1 ? "" : "s"}). ${unique.slice(0, 3).join(" ")}`
    : undefined;
}

function returnOrThrowPartialAzureData(
  result: AzureRoleLoadResult,
  discoveryWarnings: string[],
  operation: string
): ActivationItem[] {
  const warning = formatAzurePartialWarning([...discoveryWarnings, ...result.warnings], operation);
  if (warning) throw new PartialActivationDataError(warning, result.items);
  return result.items;
}

function retryTransientMicrosoftRead<T>(operation: () => Promise<T>): Promise<T> {
  return retryOnceIf(
    operation,
    (error) => isTransientMicrosoftFailure(sanitizeErrorMessage(error)),
    TRANSIENT_READ_RETRY_DELAY_MS
  );
}

async function applyAzureRoleDefinitionMetadata(items: ActivationItem[], token: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const definitionIds = [...new Set(azureItems.map((item) => item.roleDefinitionId))];

  if (!definitionIds.length) {
    return items;
  }

  const definitions: Record<string, AzureRoleDefinitionInfo> = Object.fromEntries(
    await mapWithConcurrency(
      definitionIds,
      6,
      async (roleDefinitionId) => {
        try {
          const definition = await fetchJson<AzureRoleDefinitionResponse>(
            azureManagementUrl(`${roleDefinitionId}?api-version=2022-04-01`),
            token,
            signal
          );
          return [
            roleDefinitionId,
            {
              displayName: definition.properties?.roleName || roleDefinitionId.split("/").at(-1) || roleDefinitionId,
              isPrivileged: isPrivilegedAzureRoleDefinition(definition)
            }
          ] as const;
        } catch {
          return [
            roleDefinitionId,
            {
              displayName: roleDefinitionId.split("/").at(-1) || roleDefinitionId
            }
          ] as const;
        }
      }
    )
  );

  return items.map((item) => {
    if (item.type !== "azureRole") {
      return item;
    }
    const definition = definitions[item.roleDefinitionId];
    if (!definition) {
      return item;
    }
    const displayName = item.displayName === item.roleDefinitionId.split("/").at(-1) ? definition.displayName : item.displayName;
    return {
      ...item,
      ...(displayName ? { sourceName: displayName, displayName } : {}),
      ...(typeof definition.isPrivileged === "boolean" ? { isPrivileged: definition.isPrivileged } : {})
    };
  });
}

async function getActivePimGroups(graphToken: string, signal?: AbortSignal): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const [schedulesResult, requestsResult] = await Promise.allSettled([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken,
      signal
    )
  ]);
  if (schedulesResult.status === "rejected") throw schedulesResult.reason;
  const schedules = schedulesResult.value;
  const assignmentRequests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
  const groupIds = [
    ...new Set(
      [...schedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const [groupInfos, policyRequirements] = await Promise.all([
    getGroupInfos(graphToken, groupIds, signal),
    getPimGroupPolicyRequirementsBestEffort(graphToken, groupIds, signal)
  ]);
  const active = getActivePimGroupInstanceItems(schedules, groupInfos, policyRequirements);
  return [...getPimGroupPendingRequestItems(assignmentRequests, groupInfos, policyRequirements), ...active];
}

async function activateItems(
  items: ActivationItem[],
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo,
  bundleName?: string,
  options: ActivationSubmissionOptions = {}
): Promise<ActivationResponse> {
  if (!items.length) {
    throw new Error("Select at least one item to activate.");
  }
  const requiresJustification = items.some((item) => item.activationRequirements?.justification !== false);
  if (requiresJustification && !justification.trim()) {
    throw new Error("A justification is required.");
  }
  if (durationHours <= 0) {
    throw new Error("Duration must be greater than 0.");
  }

  const tokens = await getStoredTokens();
  const submittedAt = new Date().toISOString();
  const startDateTime = options.startDateTime || submittedAt;
  const executions = await mapWithConcurrency(
    items,
    4,
    async (item) => {
      let microsoftAccepted = false;
      let acceptedRequestId: string | undefined;
      try {
        return await runWithActivationItemLock(item, async () => {
          if (options.operationId) {
            await updateRequestOperationItem(options.operationId, item.id, {
              state: "sending",
              itemName: item.displayName,
              itemType: item.type,
              ...(item.tenantId ? { tenantId: item.tenantId } : {})
            });
          }
          const request = buildActivationRequest(item, durationHours, justification.trim(), ticketInfo, startDateTime);
          assertAllowedApiUrl(request.endpoint, request.tokenKind);
          const token = getTokenForActivation(tokens, item, request.tokenKind);
          if (!token) {
            throw createPortalAccessRequiredError(item, request.tokenKind, "activation");
          }
          assertRequestTokenReady(item, token, request.tokenKind, "activation");
          assertTokenCanActivate(item, token, request.tokenKind);

          const validationRequest = buildActivationValidationRequest(item, durationHours, justification.trim(), ticketInfo, startDateTime);
          if (validationRequest) {
            assertAllowedApiUrl(validationRequest.endpoint, validationRequest.tokenKind);
            await sendActivationRequest(validationRequest, token);
          }

          const data = await sendActivationRequest(request, token);
          const requestId = getResponseIdentifier(data.payload, request, data.location);
          microsoftAccepted = true;
          acceptedRequestId = requestId;
          const trackedRequest = requestId
            ? createTrackedPimRequest({
              item,
              action: "activate",
              requestId,
              operationId: options.operationId,
              payload: data.payload,
              requestedAt: submittedAt,
              scheduledStartAt: startDateTime,
              durationHours,
              justification: justification.trim(),
              ticketInfo,
              bundleName,
              continuationOfRequestId: options.continuationOfRequestId,
              tenantId: getTokenTenantId(token)
            })
            : undefined;
          if (options.operationId) {
            await updateRequestOperationItem(options.operationId, item.id, {
              state: "accepted",
              itemName: item.displayName,
              itemType: item.type,
              ...(getTokenTenantId(token) ? { tenantId: getTokenTenantId(token) } : {}),
              ...(requestId ? { requestId } : {}),
              ...(trackedRequest ? { pendingTrackedRequest: trackedRequest } : {}),
              result: {
                itemId: item.id,
                itemName: item.displayName,
                success: true,
                ...(requestId ? { requestId } : {}),
                requestStatus: "submitted"
              }
            });
          }
          const trackingStored = trackedRequest
            ? await persistTrackedSubmissionsBestEffort([trackedRequest])
            : false;
          if (options.operationId) {
            await updateRequestOperationItem(options.operationId, item.id, {
              state: trackingStored ? "tracking" : "accepted",
              itemName: item.displayName,
              itemType: item.type,
              ...(getTokenTenantId(token) ? { tenantId: getTokenTenantId(token) } : {}),
              ...(requestId ? { requestId } : {}),
              ...(trackedRequest && trackingStored ? { trackedRequestId: trackedRequest.id } : {}),
              pendingTrackedRequest: trackingStored ? undefined : trackedRequest
            });
          }
          return {
            result: {
              itemId: item.id,
              itemName: item.displayName,
              success: true,
              requestId,
              ...(!requestId || !trackingStored ? { trackingUnavailable: true } : {})
            },
            trackedRequest
          };
        });
      } catch (error) {
        const accessRecoveryTarget = getPortalAccessRecoveryTarget(error, item);
        const detail = sanitizeErrorMessage(error);
        const outcomeUnknown = microsoftAccepted || isAmbiguousMicrosoftWriteFailure(detail, Boolean(accessRecoveryTarget));
        const result: ActivationResult = {
          itemId: item.id,
          itemName: item.displayName,
          success: false,
          ...(acceptedRequestId ? { requestId: acceptedRequestId } : {}),
          error: outcomeUnknown ? formatUnknownWriteOutcome(detail) : detail,
          ...(accessRecoveryTarget ? { accessRecoveryTarget } : {}),
          ...(outcomeUnknown ? { outcomeUnknown: true } : {})
        };
        if (options.operationId) {
          await updateRequestOperationItem(options.operationId, item.id, {
            state: outcomeUnknown ? "uncertain" : "terminal",
            itemName: item.displayName,
            itemType: item.type,
            ...(item.tenantId ? { tenantId: item.tenantId } : {}),
            ...(acceptedRequestId ? { requestId: acceptedRequestId } : {}),
            result,
            error: result.error
          }).catch(() => undefined);
        }
        return {
          result,
          trackedRequest: undefined
        };
      }
    }
  );
  const results = executions.map((execution) => execution.result);
  const errors = results.filter((result) => !result.success);
  return {
    success: errors.length === 0,
    results,
    errors
  };
}

async function sendActivationRequest(request: ActivationRequest, token: string): Promise<ActivationWriteResponse> {
  const response = await fetchMicrosoftApi(request.endpoint, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request.body)
  }, MICROSOFT_API_WRITE_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(await getSafeApiErrorMessage(response));
  }

  return {
    payload: await safeJson(response),
    location: getAllowedResponseLocation(response)
  };
}

async function deactivateItems(
  items: ActivationItem[],
  justification: string,
  ticketInfo: TicketInfo,
  options: ActivationSubmissionOptions = {}
): Promise<ActivationResponse> {
  if (!items.length) {
    throw new Error("Select at least one active item to deactivate.");
  }

  const tokens = await getStoredTokens();
  const startDateTime = new Date().toISOString();
  const executions = await mapWithConcurrency(
    items,
    4,
    async (item) => {
      let microsoftAccepted = false;
      let acceptedRequestId: string | undefined;
      try {
        return await runWithActivationItemLock(item, async () => {
          if (options.operationId) {
            await updateRequestOperationItem(options.operationId, item.id, {
              state: "sending",
              itemName: item.displayName,
              itemType: item.type,
              ...(item.tenantId ? { tenantId: item.tenantId } : {})
            });
          }
          const request = buildDeactivationRequest(item, justification.trim(), ticketInfo, startDateTime);
          assertAllowedApiUrl(request.endpoint, request.tokenKind);
          const token = getTokenForActivation(tokens, item, request.tokenKind);
          if (!token) {
            throw createPortalAccessRequiredError(item, request.tokenKind, "deactivation");
          }
          assertRequestTokenReady(item, token, request.tokenKind, "deactivation");
          assertTokenCanActivate(item, token, request.tokenKind, "deactivation");
          const data = await sendActivationRequest(request, token);
          const requestId = getResponseIdentifier(data.payload, request, data.location);
          microsoftAccepted = true;
          acceptedRequestId = requestId;
          const trackedRequest = requestId
            ? createTrackedPimRequest({
              item,
              action: "deactivate",
              requestId,
              operationId: options.operationId,
              payload: data.payload,
              requestedAt: startDateTime,
              justification: justification.trim(),
              ticketInfo,
              tenantId: getTokenTenantId(token)
            })
            : undefined;
          if (options.operationId) {
            await updateRequestOperationItem(options.operationId, item.id, {
              state: "accepted",
              itemName: item.displayName,
              itemType: item.type,
              ...(getTokenTenantId(token) ? { tenantId: getTokenTenantId(token) } : {}),
              ...(requestId ? { requestId } : {}),
              ...(trackedRequest ? { pendingTrackedRequest: trackedRequest } : {}),
              result: {
                itemId: item.id,
                itemName: item.displayName,
                success: true,
                ...(requestId ? { requestId } : {}),
                requestStatus: "submitted"
              }
            });
          }
          const trackingStored = trackedRequest
            ? await persistTrackedSubmissionsBestEffort([trackedRequest])
            : false;
          if (options.operationId) {
            await updateRequestOperationItem(options.operationId, item.id, {
              state: trackingStored ? "tracking" : "accepted",
              itemName: item.displayName,
              itemType: item.type,
              ...(getTokenTenantId(token) ? { tenantId: getTokenTenantId(token) } : {}),
              ...(requestId ? { requestId } : {}),
              ...(trackedRequest && trackingStored ? { trackedRequestId: trackedRequest.id } : {}),
              pendingTrackedRequest: trackingStored ? undefined : trackedRequest
            });
          }
          return {
            result: {
              itemId: item.id,
              itemName: item.displayName,
              success: true,
              requestId,
              ...(!requestId || !trackingStored ? { trackingUnavailable: true } : {})
            },
            trackedRequest
          };
        });
      } catch (error) {
        const accessRecoveryTarget = getPortalAccessRecoveryTarget(error, item);
        const detail = sanitizeErrorMessage(error);
        const outcomeUnknown = microsoftAccepted || isAmbiguousMicrosoftWriteFailure(detail, Boolean(accessRecoveryTarget));
        const result: ActivationResult = {
          itemId: item.id,
          itemName: item.displayName,
          success: false,
          ...(acceptedRequestId ? { requestId: acceptedRequestId } : {}),
          error: outcomeUnknown ? formatUnknownWriteOutcome(detail) : detail,
          ...(accessRecoveryTarget ? { accessRecoveryTarget } : {}),
          ...(outcomeUnknown ? { outcomeUnknown: true } : {})
        };
        if (options.operationId) {
          await updateRequestOperationItem(options.operationId, item.id, {
            state: outcomeUnknown ? "uncertain" : "terminal",
            itemName: item.displayName,
            itemType: item.type,
            ...(item.tenantId ? { tenantId: item.tenantId } : {}),
            ...(acceptedRequestId ? { requestId: acceptedRequestId } : {}),
            result,
            error: result.error
          }).catch(() => undefined);
        }
        return {
          result,
          trackedRequest: undefined
        };
      }
    }
  );
  const results = executions.map((execution) => execution.result);
  const errors = results.filter((result) => !result.success);
  return {
    success: errors.length === 0,
    results,
    errors
  };
}

function assertTokenCanActivate(item: ActivationItem, token: string, tokenKind: TokenKind, operation = "activation"): void {
  if (tokenKind !== "graph" || item.type === "azureRole") {
    return;
  }

  const target: GraphTokenTarget = item.type === "pimGroup" ? "pimGroup" : "directoryRole";
  const decoded = decodeToken(token);
  if (!decoded || hasGraphActivationScope(decoded, target)) {
    return;
  }

  const label = target === "pimGroup" ? "PIM group" : "Entra role";
  const requiredScopes = getRequiredGraphActivationScopes(target).join(" or ");
  throw new PortalAccessRequiredError(
    target,
    `${label} ${operation} needs a stronger Microsoft Graph portal token with ${requiredScopes}.`
  );
}

function assertRequestTokenReady(
  item: ActivationItem,
  token: string,
  tokenKind: TokenKind,
  operation: "activation" | "deactivation"
): void {
  const validation = validateCapturedToken(
    token,
    tokenKind,
    Date.now() + MICROSOFT_API_WRITE_TOKEN_MIN_VALIDITY_MS
  );
  if (!validation.ok) {
    throw createPortalAccessRequiredError(item, tokenKind, operation);
  }

  const principalId = validation.decoded.oid;
  if (typeof principalId !== "string" || principalId.toLowerCase() !== item.principalId.toLowerCase()) {
    throw new Error("The selected role belongs to another signed-in account. Refresh role data before retrying.");
  }
  const tenantId = validation.decoded.tid;
  if (!item.tenantId || typeof tenantId !== "string" || tenantId.toLowerCase() !== item.tenantId.toLowerCase()) {
    throw new Error("The selected role belongs to another Microsoft tenant. Refresh role data before retrying.");
  }
}

class PortalAccessRequiredError extends Error {
  constructor(
    readonly target: AccessSetupTarget,
    message: string
  ) {
    super(message);
    this.name = "PortalAccessRequiredError";
  }
}

function createPortalAccessRequiredError(
  item: ActivationItem,
  tokenKind: TokenKind,
  operation: "activation" | "deactivation"
): PortalAccessRequiredError {
  const target: AccessSetupTarget = tokenKind === "azureManagement"
    ? "azureRole"
    : item.type === "pimGroup"
      ? "pimGroup"
      : "directoryRole";
  const label = target === "azureRole" ? "Azure role" : target === "pimGroup" ? "PIM group" : "Entra role";
  const tokenLabel = target === "azureRole" ? "Azure Management" : "Microsoft Graph";
  return new PortalAccessRequiredError(target, `${label} ${operation} needs a fresh ${tokenLabel} portal token.`);
}

function getPortalAccessRecoveryTarget(
  error: unknown,
  item: ActivationItem
): AccessSetupTarget | undefined {
  if (error instanceof PortalAccessRequiredError) {
    return error.target;
  }
  if (!isFreshPortalTokenRequired(sanitizeErrorMessage(error))) {
    return undefined;
  }
  return item.type;
}

function getTokenForActivation(tokens: StoredTokens, item: ActivationItem, tokenKind: TokenKind): string | undefined {
  if (tokenKind === "azureManagement") {
    return tokens.azureManagementToken;
  }
  if (item.type === "pimGroup") {
    return getGraphTokenForTarget(tokens, "pimGroup");
  }
  return getGraphTokenForTarget(tokens, "directoryRole");
}

async function fetchAllPages<T>(url: string, token: string, signal?: AbortSignal): Promise<T[]> {
  const tokenKind = getAllowedTokenKindForUrl(url);
  if (!tokenKind) {
    throw new Error("API URL is not allowed.");
  }
  return collectPaginatedValues(url, async (nextUrl) => {
    assertAllowedApiUrl(nextUrl, tokenKind);
    return fetchJson(nextUrl, token, signal);
  });
}

async function fetchJson<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
  assertAllowedApiUrl(url);
  const response = await fetchMicrosoftApi(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  }, MICROSOFT_API_READ_TIMEOUT_MS, signal);

  if (!response.ok) {
    throw new Error(await getSafeApiErrorMessage(response));
  }

  return (await response.json()) as T;
}

async function fetchGraphBatch<T>(
  requests: Array<{ id: string; method: "GET"; url: string }>,
  token: string,
  signal?: AbortSignal
): Promise<GraphBatchResponse<T>> {
  if (!requests.length || requests.length > GRAPH_BATCH_REQUEST_LIMIT) {
    throw new Error("Microsoft Graph batch size is invalid.");
  }
  const url = graphApiUrl("/v1.0/$batch");
  assertAllowedApiUrl(url, "graph");
  const response = await fetchMicrosoftApi(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests })
  }, MICROSOFT_API_READ_TIMEOUT_MS, signal);
  if (!response.ok) {
    throw new Error(await getSafeApiErrorMessage(response));
  }
  return (await response.json()) as GraphBatchResponse<T>;
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const safeChunkSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeChunkSize) {
    chunks.push(items.slice(index, index + safeChunkSize));
  }
  return chunks;
}

async function fetchMicrosoftApi(url: string, init: RequestInit, timeoutMs: number, parentSignal?: AbortSignal): Promise<Response> {
  assertAllowedApiUrl(url);
  const controller = new AbortController();
  let requestTimedOut = false;
  const timeout = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancelFromParent = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", cancelFromParent, { once: true });
  }
  try {
    return await fetch(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(requestTimedOut
        ? `Microsoft API request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
        : "Microsoft API request was canceled because the refresh deadline expired.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", cancelFromParent);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function getSafeApiErrorMessage(response: Response): Promise<string> {
  const fallback = `Microsoft API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let payload: unknown;
  let text = "";
  try {
    text = (await response.text()).slice(0, 8_192);
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  const apiMessage = getApiErrorMessage(payload, response);
  if (apiMessage) return sanitizeErrorMessage(apiMessage);
  if (contentType.includes("text/html") || /<\s*!doctype|<\s*html/i.test(text)) {
    return sanitizeErrorMessage(`${fallback} The Microsoft gateway returned an HTML error page; retry after the portal session is ready.`);
  }
  const plainText = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return sanitizeErrorMessage(plainText || fallback);
}

function dedupeItems(items: ActivationItem[]): ActivationItem[] {
  return [...new Map(items.map((item) => [normalizeActivationItemId(getActivationItemIdentity(item)), item])).values()];
}

function getApiErrorMessage(payload: unknown, response?: Response): string | undefined {
  const authenticateHeader = response?.headers.get("www-authenticate") || response?.headers.get("WWW-Authenticate");
  if (authenticateHeader && isClaimsChallengeMessage(authenticateHeader)) {
    return CLAIMS_CHALLENGE_MESSAGE;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  if (typeof message !== "string") {
    return undefined;
  }
  return isClaimsChallengeMessage(message) ? CLAIMS_CHALLENGE_MESSAGE : message;
}

async function persistTrackedSubmissionsBestEffort(requests: TrackedPimRequest[]): Promise<boolean> {
  if (!requests.length) {
    return true;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const store = await mutateTrackedRequests((current) => upsertTrackedRequests(current, requests));
      const settings = await loadSettings();
      await Promise.all([
        updateTrackedRequestBadge(store),
        scheduleTrackedRequestMaintenance(store, settings)
      ]);
      return true;
    } catch {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }

  // Microsoft already accepted the request. The durable operation item keeps
  // the complete non-secret tracking record so startup reconciliation can
  // retry this write without ever resubmitting the Microsoft request.
  try {
    const requestIds = new Set(requests.map((request) => request.id));
    const stored = await loadTrackedRequests();
    return requests.every((request) => requestIds.has(request.id)
      && stored.requests.some((candidate) => candidate.id === request.id));
  } catch {
    return false;
  }
}

function getTokenTenantId(token: string): string | undefined {
  const decoded = decodeToken(token);
  return typeof decoded?.tid === "string" ? decoded.tid : undefined;
}

function getResponseIdentifier(payload: unknown, request?: ActivationRequest, location?: string): string | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const identifier = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
    if (identifier) {
      return sanitizeResponseIdentifier(identifier);
    }
  }
  if (location) {
    try {
      return sanitizeResponseIdentifier(decodeURIComponent(new URL(location).pathname.split("/").filter(Boolean).at(-1) || ""));
    } catch {
      // Ignore malformed response metadata and use the request fallback below.
    }
  }
  if (request?.method === "PUT") {
    try {
      return sanitizeResponseIdentifier(decodeURIComponent(new URL(request.endpoint).pathname.split("/").filter(Boolean).at(-1) || ""));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sanitizeResponseIdentifier(value: string): string | undefined {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 512);
  return sanitized || undefined;
}

function getAllowedResponseLocation(response: Response): string | undefined {
  for (const header of ["operation-location", "location"]) {
    const value = response.headers.get(header);
    if (!value) continue;
    try {
      const location = new URL(value, response.url);
      if (location.protocol === "https:"
        && (location.hostname === "graph.microsoft.com" || location.hostname === "management.azure.com")) {
        return location.toString().slice(0, 2_048);
      }
    } catch {
      // Ignore untrusted or malformed response metadata.
    }
  }
  return undefined;
}
