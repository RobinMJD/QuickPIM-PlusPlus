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
import { withTimeout } from "./lib/async";
import { runWithActivationItemLock } from "./lib/requestGate";
import { getEnabledRoleFeatures, loadSettings, SETTINGS_KEY } from "./lib/settings";
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
  createTrackedPimRequest,
  getDueTrackedRequests,
  getActivationRequestItemStatus,
  getEffectiveTrackedRequestStatus,
  getPendingTrackedRequestCount,
  getRequestTrackingMaintenanceTime,
  isTrackedRequestPending,
  loadTrackedRequests,
  markTrackedRequestCheckFailure,
  mutateTrackedRequests,
  trackedRequestMatchesValidatedToken,
  trackedRequestStatusLabel,
  updateTrackedRequestFromPayload,
  upsertTrackedRequests,
  REQUEST_TRACKING_KEY
} from "./lib/requestTracking";
import {
  getPortalTokenRecoveryTargets,
  getStaleCacheTargets,
  scanOpenEntraTabs
} from "./lib/portalTokenRefresh";
import {
  PORTAL_RECOVERY_CLEANUP_ALARM_NAME,
  PORTAL_RECOVERY_SESSION_TTL_MS,
  closeCompletedPortalRecoveryTabs,
  closeExpiredPortalRecoveryTabs,
  closePortalRecoveryTabsForTargets,
  focusPortalRecoveryTabs,
  getPortalRecoveryStatus,
  openPortalRecoveryTabsAndReconcile,
  type PortalRecoveryApis
} from "./lib/portalRecoveryTabs";
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
import { isPrivilegedAzureRoleDefinition } from "./lib/privilegedRoles";
import {
  assertAllowedApiUrl,
  getAllowedTokenKindForUrl,
  isAllowedPortalTokenSource,
  sanitizeErrorMessage,
  validateCapturedToken
} from "./lib/security";
import { assertFreshToken, decodeToken, makeTokenStatus } from "./lib/token";
import { selectBestStoredGraphTokenForTarget, selectPortalTokenCandidates } from "./lib/tokenCandidates";
import {
  beginRequestOperation,
  completeRequestOperation,
  dismissRequestOperations,
  failRequestOperation,
  loadRequestOperations
} from "./lib/requestOperations";
import {
  getAccessRecoveryTargets,
  mergeRetriedActivationResponse,
  replaceAccessRecoveryErrors
} from "./lib/requestRecovery";
import {
  clearStoredTokens,
  getStoredTokensFromSession,
  removeStoredTokenGroupsIfMatching,
  TOKEN_STORAGE_KEYS,
  updateStoredTokensInSession,
  type StoredTokens
} from "./lib/tokenStorage";
import type {
  ActivationItem,
  ActivationDataResult,
  ActivationRequest,
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
  TrackedPimRequest,
  TrackedPimRequestStatus,
  TrackedPimRequestStore
} from "./lib/types";

type ActivationRequirements = NonNullable<ActivationItem["activationRequirements"]>;
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

const REQUEST_HEADER_OPTIONS = ["requestHeaders", "extraHeaders"];
const MICROSOFT_API_READ_TIMEOUT_MS = 12_000;
const MICROSOFT_API_WRITE_TIMEOUT_MS = 45_000;
const MICROSOFT_API_WRITE_TOKEN_MIN_VALIDITY_MS = 5 * 60_000;
const REQUEST_PORTAL_RECOVERY_WAIT_TIMEOUT_MS = 90_000;
const REQUEST_PORTAL_RECOVERY_POLL_INTERVAL_MS = 750;
const TARGET_SNAPSHOT_TIMEOUT_MS = 22_000;
let portalTokenRefreshInFlight: Promise<PortalTokenRefreshResult> | undefined;
let requestTrackingMaintenanceInFlight: Promise<TrackedPimRequestStore> | undefined;
const requestOperationTasks = new Map<string, Promise<ActivationResponse>>();
const REQUEST_TRACKING_NOTIFICATION_PREFIX = "quickpim-request:";
const REQUEST_TRACKING_STORAGE_TIMEOUT_MS = 750;

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
  (details) => captureToken(details),
  { urls: ["https://graph.microsoft.com/*", "https://management.azure.com/*"] },
  REQUEST_HEADER_OPTIONS
);

void initializeBackgroundRefresh();

chrome.runtime.onInstalled?.addListener(() => {
  void initializeBackgroundRefresh();
  void initializeRequestTracking();
});

chrome.runtime.onStartup?.addListener(() => {
  void initializeBackgroundRefresh().then(() => runBackgroundPreRefresh());
  void initializeRequestTracking();
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_KEY]?.newValue) {
    void initializeBackgroundRefresh();
    void initializeRequestTracking();
  }
  if (areaName === "local" && changes[REQUEST_TRACKING_KEY]) {
    void initializeRequestTracking();
  }
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === PRE_REFRESH_ALARM_NAME) {
    void runBackgroundPreRefresh();
  } else if (alarm.name === REQUEST_TRACKING_ALARM_NAME) {
    void runTrackedRequestMaintenance();
  } else if (alarm.name === PORTAL_RECOVERY_CLEANUP_ALARM_NAME) {
    void closeExpiredPortalRecoveryTabs(getPortalRecoveryApis());
  }
});

chrome.notifications?.onClicked?.addListener((notificationId) => {
  if (!notificationId.startsWith(REQUEST_TRACKING_NOTIFICATION_PREFIX)) {
    return;
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#activity") });
  void chrome.notifications.clear(notificationId);
});

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

  handleMessage(validatedMessage, sender)
    .then((data) => sendResponse({ success: true, data }))
    .catch((error: unknown) => {
      const message = sanitizeErrorMessage(error);
      sendResponse({ success: false, error: message });
    });
  return true;
});

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

async function runTrackedRequestMaintenance(
  requestIds?: string[],
  force = false
): Promise<TrackedPimRequestStore> {
  if (requestTrackingMaintenanceInFlight) {
    const current = await requestTrackingMaintenanceInFlight;
    if (!force) {
      return current;
    }
  }

  const maintenance = performTrackedRequestMaintenance(requestIds, force);
  requestTrackingMaintenanceInFlight = maintenance.finally(() => {
    requestTrackingMaintenanceInFlight = undefined;
  });
  return requestTrackingMaintenanceInFlight;
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
  const updatedStore = updates.size || hasEffectiveStatusChanges
    ? await mutateTrackedRequests((current) => ({
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
    }))
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
    updateRequestsFromPayloadCollection(trackable, payloads, updates, now);
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
      updateRequestsFromPayloadCollection(principalRequests, payloads, updates, now);
    } catch (error) {
      for (const request of principalRequests) {
        updates.set(request.id, markTrackedRequestCheckFailure(request, error, now));
      }
    }
  });
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

function updateRequestsFromPayloadCollection(
  requests: TrackedPimRequest[],
  payloads: Record<string, unknown>[],
  updates: Map<string, TrackedPimRequest>,
  now: number
): void {
  const byId = new Map(payloads.flatMap((payload) => {
    const id = getResponseIdentifier(payload);
    return id ? [[id.toLowerCase(), payload] as const] : [];
  }));
  for (const request of requests) {
    const payload = byId.get(request.requestId.toLowerCase());
    updates.set(
      request.id,
      payload
        ? updateTrackedRequestFromPayload(request, payload, now)
        : markTrackedRequestCheckFailure(request, "Microsoft has not exposed this request status yet.", now)
    );
  }
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
  for (const request of nextStore.requests) {
    const previous = previousById.get(request.id);
    const status = getEffectiveTrackedRequestStatus(request, now);
    if (previous && previous.status !== status && isNotifiableRequestStatus(status) && request.notifiedStatus !== status) {
      const shown = await showTrackedRequestNotification(request, status);
      if (shown) {
        patches.set(request.id, { notifiedStatus: status });
      }
    }

    if (status === "active" && request.activeUntil && !request.expiryReminderSentAt) {
      const expiresAt = Date.parse(request.activeUntil);
      const reminderAt = expiresAt - reminderMinutes * 60_000;
      if (Number.isFinite(expiresAt) && now >= reminderAt && now < expiresAt) {
        const shown = await showExpiryReminderNotification(request, reminderMinutes);
        if (shown) {
          patches.set(request.id, {
            ...patches.get(request.id),
            expiryReminderSentAt: new Date(now).toISOString()
          });
        }
      }
    }
  }

  if (!patches.size) {
    return nextStore;
  }
  return mutateTrackedRequests((current) => ({
    version: 1,
    requests: current.requests.map((request) => ({ ...request, ...patches.get(request.id) }))
  }));
}

async function showTrackedRequestNotification(
  request: TrackedPimRequest,
  status: TrackedPimRequestStatus
): Promise<boolean> {
  const action = request.action === "activate" ? "activation" : "deactivation";
  const message = status === "active"
    ? `${request.itemName} is now active.`
    : status === "completed"
      ? `${request.itemName} deactivation completed.`
      : `${request.itemName} ${action} was ${trackedRequestStatusLabel(status).toLowerCase()}.`;
  return createRequestNotification(request, `Request ${trackedRequestStatusLabel(status).toLowerCase()}`, message, status);
}

async function showExpiryReminderNotification(request: TrackedPimRequest, reminderMinutes: number): Promise<boolean> {
  return createRequestNotification(
    request,
    "PIM access expiring soon",
    `${request.itemName} expires in about ${reminderMinutes} minutes.`,
    "active",
    "expiry"
  );
}

async function createRequestNotification(
  request: TrackedPimRequest,
  title: string,
  message: string,
  status: TrackedPimRequestStatus,
  suffix = "status"
): Promise<boolean> {
  try {
    await chrome.notifications.create(
      `${REQUEST_TRACKING_NOTIFICATION_PREFIX}${request.itemType}:${request.requestId.slice(0, 128)}:${status}:${suffix}`,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("img/QuickPim128.png"),
        title,
        message,
        contextMessage: "Click to open request details."
      }
    );
    return true;
  } catch {
    return false;
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
  const refreshStartedAt = Date.now();
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
}

async function handleMessage(message: ReturnType<typeof validateQuickPimMessage>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.action) {
    case "getTokenStatus":
      return getTokenStatus();
    case "refreshPortalTokens":
      return refreshPortalTokensFromOpenTabs();
    case "getPortalRecoveryStatus":
      return getPortalRecoveryStatus(getPortalRecoveryApis());
    case "focusPortalRecoveryTabs":
      return focusPortalRecoveryTabs(getPortalRecoveryApis());
    case "openPortalRecoveryTabs":
      return openManagedPortalRecoveryTabs(message.targets);
    case "closePortalRecoveryTabs":
      return closePortalRecoveryTabsForTargets(message.targets, getPortalRecoveryApis());
    case "clearToken":
      await clearTokens();
      return true;
    case "getActivationItems":
      return getActivationItems(message.targets);
    case "getActiveItems":
      return getActiveItems(message.targets);
    case "getActivationSnapshot":
      return getActivationSnapshot(message.targets);
    case "refreshTrackedRequests":
      return runTrackedRequestMaintenance(message.requestIds, true);
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
          startedAt: Date.now(),
          durationHours: message.durationHours,
          justification: message.justification,
          bundleName: message.bundleName
        },
        () => activateItemsWithPortalRecovery(
          message.items,
          message.durationHours,
          message.justification,
          message.ticketInfo || {},
          message.bundleName
        )
      );
    case "deactivateItems":
      return runDurableRequestOperation(
        {
          id: message.operationId,
          action: "deactivate",
          itemIds: message.items.map((item) => item.id),
          targets: uniqueAccessTargets(message.items.map((item) => item.type)),
          startedAt: Date.now(),
          justification: message.justification
        },
        () => deactivateItemsWithPortalRecovery(
          message.items,
          message.justification || "",
          message.ticketInfo || {}
        )
      );
    default:
      throw new Error("Unsupported QuickPIM++ message");
  }
}

async function loadRequestOperationsForPopup(): Promise<RequestOperationRecord[]> {
  const operations = await loadRequestOperations();
  const orphaned = operations.filter((operation) =>
    operation.state === "running" && !requestOperationTasks.has(operation.id)
  );
  if (!orphaned.length) {
    return operations;
  }

  const error = "QuickPIM++ restarted while this request was running. Check Microsoft PIM before retrying to avoid a duplicate request.";
  await Promise.all(orphaned.map((operation) => failRequestOperation(operation.id, error)));
  return loadRequestOperations();
}

function runDurableRequestOperation(
  operation: Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets" | "startedAt"> &
    Partial<Pick<RequestOperationRecord, "durationHours" | "justification" | "bundleName">>,
  execute: () => Promise<ActivationResponse>
): Promise<ActivationResponse> {
  const existingTask = requestOperationTasks.get(operation.id);
  if (existingTask) {
    return existingTask;
  }

  const task = (async () => {
    const stored = (await loadRequestOperations()).find((item) => item.id === operation.id);
    if (stored?.state === "complete" && stored.response) {
      return stored.response;
    }
    if (stored?.state === "error") {
      throw new Error(stored.error || "The previous QuickPIM++ request failed.");
    }
    if (stored?.state === "running") {
      const error = "QuickPIM++ restarted while this request was running. Check Microsoft PIM before retrying to avoid a duplicate request.";
      await failRequestOperation(operation.id, error);
      throw new Error(error);
    }

    await beginRequestOperation(operation);
    try {
      const response = await execute();
      await completeRequestOperation(operation.id, response);
      return response;
    } catch (error) {
      const detail = sanitizeErrorMessage(error);
      await failRequestOperation(operation.id, detail);
      throw error;
    }
  })();

  requestOperationTasks.set(operation.id, task);
  void task.then(
    () => requestOperationTasks.delete(operation.id),
    () => requestOperationTasks.delete(operation.id)
  );
  return task;
}

async function activateItemsWithPortalRecovery(
  items: ActivationItem[],
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo,
  bundleName?: string
): Promise<ActivationResponse> {
  return executeWithPortalAccessRecovery(
    items,
    "activation",
    (retryItems) => activateItems(retryItems, durationHours, justification, ticketInfo, bundleName)
  );
}

async function deactivateItemsWithPortalRecovery(
  items: ActivationItem[],
  justification: string,
  ticketInfo: TicketInfo
): Promise<ActivationResponse> {
  return executeWithPortalAccessRecovery(
    items,
    "deactivation",
    (retryItems) => deactivateItems(retryItems, justification, ticketInfo)
  );
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
  const retryItems = items.filter((item) => retryIds.has(item.id));
  if (!retryItems.length) {
    return initialResponse;
  }

  const recovery = await recoverPortalAccessForRequest(recoveryTargets);
  if (!recovery.ready) {
    return replaceAccessRecoveryErrors(
      initialResponse,
      recovery.error || `Microsoft portal access required for ${operation} could not be refreshed automatically.`
    );
  }

  return mergeRetriedActivationResponse(initialResponse, await execute(retryItems));
}

async function recoverPortalAccessForRequest(
  targets: AccessSetupTarget[]
): Promise<{ ready: boolean; error?: string }> {
  try {
    await refreshPortalTokensFromOpenTabs();
  } catch {
    // Dedicated background tabs remain available if passive tab scanning fails.
  }

  let tokenStatus = await getTokenStatus();
  let remainingTargets = getRequestMissingAccessTargets(targets, tokenStatus);
  if (!remainingTargets.length) {
    return { ready: true };
  }

  const opened = await openManagedPortalRecoveryTabs(remainingTargets);
  if (!opened.managedCount) {
    return {
      ready: false,
      error: "QuickPIM++ could not open the Microsoft portal page needed for this request. Your selection and inputs remain saved."
    };
  }

  const deadline = Date.now() + REQUEST_PORTAL_RECOVERY_WAIT_TIMEOUT_MS;
  let passiveScanAt = 0;
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
    remainingTargets = getRequestMissingAccessTargets(targets, tokenStatus);
    if (!remainingTargets.length) {
      await closeCompletedRecoveryTabs(tokenStatus);
      return { ready: true };
    }
  }

  const recoveryStatus = await getPortalRecoveryStatus(getPortalRecoveryApis());
  const interactionRequired = recoveryStatus.state === "interactionRequired";
  return {
    ready: false,
    error: interactionRequired
      ? "Microsoft sign-in or another portal prompt must be completed before this request can continue. Your selection and inputs remain saved."
      : `QuickPIM++ could not capture ${remainingTargets.map(accessTargetLabel).join(" and ")} request access in time. Your selection and inputs remain saved.`
  };
}

function getRequestMissingAccessTargets(targets: AccessSetupTarget[], tokenStatus: TokenStatus): AccessSetupTarget[] {
  const now = Date.now();
  return targets.filter((target) => {
    if (!hasRequiredPortalToken(target, tokenStatus)) {
      return true;
    }
    const token = target === "azureRole"
      ? tokenStatus.azureManagement
      : tokenStatus.graphTargets?.[target] || tokenStatus.graph;
    const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.NaN;
    return Number.isFinite(expiresAt) && expiresAt <= now + MICROSOFT_API_WRITE_TOKEN_MIN_VALIDITY_MS;
  });
}

function uniqueAccessTargets(targets: AccessSetupTarget[]): AccessSetupTarget[] {
  const requested = new Set(targets);
  return (["directoryRole", "pimGroup", "azureRole"] as AccessSetupTarget[])
    .filter((target) => requested.has(target));
}

function accessTargetLabel(target: AccessSetupTarget): string {
  return target === "directoryRole" ? "Entra role" : target === "pimGroup" ? "PIM group" : "Azure role";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function refreshPortalTokensFromOpenTabs(): Promise<PortalTokenRefreshResult> {
  if (portalTokenRefreshInFlight) {
    return portalTokenRefreshInFlight;
  }

  const refresh = (async (): Promise<PortalTokenRefreshResult> => {
    const scanResult = await scanOpenEntraTabs(chrome.tabs);
    const tokenStatus = await getTokenStatus();
    await closeCompletedRecoveryTabs(tokenStatus);
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

function captureToken(details: chrome.webRequest.WebRequestHeadersDetails): void {
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

  void storeCapturedToken(tokenKind, token, portalSource || "https://entra.microsoft.com/")
    .then(async (stored) => {
      if (stored) {
        await closeCompletedRecoveryTabs(await getTokenStatus());
      }
    })
    .catch(() => undefined);
}

async function capturePortalTokens(
  tokens: string[],
  source: string | undefined,
  sender: chrome.runtime.MessageSender
): Promise<{ captured: TokenKind[] }> {
  const sourceUrl = sender.url || sender.tab?.url || sender.origin;
  if (!isAllowedPortalTokenSource(sourceUrl)) {
    throw new Error("Portal token capture is only allowed from Microsoft Entra pages.");
  }

  const storedTokens = await getStoredTokens();
  const candidates = selectPortalTokenCandidates(tokens, {
    preferredIdentity: sender.tab?.active === true
      ? undefined
      : getFirstValidStoredTokenIdentity(storedTokens)
  });
  const captured = new Set<TokenKind>();
  for (const candidate of candidates) {
    const stored = await storeCapturedToken(
      candidate.tokenKind,
      candidate.token,
      source || sourceUrl || "entra.microsoft.com storage",
      Date.now(),
      { allowIdentityChange: sender.tab?.active === true }
    );
    if (stored) {
      captured.add(candidate.tokenKind);
    }
  }
  if (captured.size) {
    await closeCompletedRecoveryTabs(await getTokenStatus());
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
    storage: chrome.storage.session,
    windows: chrome.windows
  };
}

async function openManagedPortalRecoveryTabs(targets: AccessSetupTarget[]) {
  const result = await openPortalRecoveryTabsAndReconcile(targets, getTokenStatus, getPortalRecoveryApis());
  if (result.managedCount) {
    await chrome.alarms.create(PORTAL_RECOVERY_CLEANUP_ALARM_NAME, {
      when: Date.now() + PORTAL_RECOVERY_SESSION_TTL_MS
    });
  }
  return result;
}

async function closeCompletedRecoveryTabs(tokenStatus: TokenStatus): Promise<void> {
  await closeCompletedPortalRecoveryTabs(tokenStatus, getPortalRecoveryApis());
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

  const lifetimePreference = shouldKeepCurrentForUsableLifetime(currentValidation.decoded, incoming, timestamp);
  if (lifetimePreference !== undefined) {
    return !lifetimePreference;
  }

  const currentScore = getGraphTokenTargetScore(currentValidation.decoded, target);
  const incomingScore = getGraphTokenTargetScore(incoming, target);
  if (currentScore > incomingScore) {
    return false;
  }
  const currentAuthScore = getGraphTokenAuthStrengthScore(currentValidation.decoded);
  const incomingAuthScore = getGraphTokenAuthStrengthScore(incoming);
  if (currentScore === incomingScore && currentAuthScore > incomingAuthScore) {
    return false;
  }
  const currentExpiry = Number(currentValidation.decoded.exp) || 0;
  const incomingExpiry = Number(incoming.exp) || 0;
  return incomingScore > currentScore || incomingAuthScore > currentAuthScore || incomingExpiry >= currentExpiry;
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
  const lifetimePreference = shouldKeepCurrentForUsableLifetime(current, incoming, now);
  if (lifetimePreference !== undefined) {
    return lifetimePreference;
  }
  const currentScore = getTokenCaptureScore(current, tokenKind);
  const incomingScore = getTokenCaptureScore(incoming, tokenKind);
  if (currentScore > incomingScore) {
    return true;
  }
  if (tokenKind === "graph" && currentScore === incomingScore) {
    const currentAuthScore = getGraphTokenAuthStrengthScore(current);
    const incomingAuthScore = getGraphTokenAuthStrengthScore(incoming);
    if (currentAuthScore > incomingAuthScore) {
      return true;
    }
    if (incomingAuthScore > currentAuthScore) {
      return false;
    }
  }
  const currentExpiry = Number(current.exp) || 0;
  const incomingExpiry = Number(incoming.exp) || 0;
  return currentScore === incomingScore && currentExpiry >= incomingExpiry;
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
    diagnostics: results.map((result) => result.diagnostic)
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
    diagnostics: results.map((result) => result.diagnostic)
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
  const fetchers: Record<AccessSetupTarget, () => Promise<TargetSnapshotResult>> = {
    directoryRole: () =>
      fetchSnapshotGroup(
        "directoryRole",
        "graph",
        getGraphTokenForTarget(tokens, "directoryRole"),
        getDirectoryRoleSnapshot,
        getDirectoryRoles,
        getActiveDirectoryRoles
      ),
    azureRole: () =>
      fetchSnapshotGroup(
        "azureRole",
        "azureManagement",
        tokens.azureManagementToken,
        getAzureRoleSnapshot,
        getAzureRoles,
        getActiveAzureRoles
      ),
    pimGroup: () =>
      fetchSnapshotGroup(
        "pimGroup",
        "graph",
        getGraphTokenForTarget(tokens, "pimGroup"),
        getPimGroupSnapshot,
        getPimGroups,
        getActivePimGroups
      )
  };
  const results = await Promise.all(targets.map(async (target) => {
    try {
      return await withTimeout(
        fetchers[target](),
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

async function fetchSnapshotGroup(
  target: AccessSetupTarget,
  tokenKind: TokenKind,
  token: string | undefined,
  fetcher: (token: string) => Promise<[ActivationItem[], ActivationItem[]]>,
  eligibleFallback: (token: string) => Promise<ActivationItem[]>,
  activeFallback: (token: string) => Promise<ActivationItem[]>
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
    const [eligibleItems, activeItems] = await fetcher(token);
    return {
      target,
      eligible: makeSnapshotData(target, eligibleItems, undefined, "eligible"),
      active: makeSnapshotData(target, activeItems, undefined, "active")
    };
  } catch {
    const [eligible, active] = await Promise.all([
      fetchItemGroup(target, tokenKind, token, eligibleFallback, "eligible"),
      fetchItemGroup(target, tokenKind, token, activeFallback, "active")
    ]);
    return {
      target,
      eligible: itemGroupToSnapshotData(eligible),
      active: itemGroupToSnapshotData(active)
    };
  }
}

function itemGroupToSnapshotData(result: { items: ActivationItem[]; error?: string; diagnostic: AccessDiagnostic }): ActivationDataResult {
  return { items: result.items, errors: result.error ? [result.error] : [], diagnostics: [result.diagnostic] };
}

function makeSnapshotData(target: AccessSetupTarget, items: ActivationItem[], error?: string, operation: "eligible" | "active" = "eligible"): ActivationDataResult {
  const checkedAt = new Date().toISOString();
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
    }]
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
  fetcher: (token: string) => Promise<ActivationItem[]>,
  operation: "eligible" | "active"
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
    const items = await fetcher(token);
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
    return {
      items: [],
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

async function getDirectoryRoles(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const roles = await fetchAllPages<DirectoryRoleApi>(
    graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilityScheduleInstances/filterByCurrentUser(on='principal')?${new URLSearchParams({ "$expand": "roleDefinition" }).toString()}`),
    graphToken
  );
  const [definitions, scopeNames, policyRequirements] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken),
    getDirectoryScopeNamesBestEffort(graphToken, roles),
    getDirectoryRolePolicyRequirementsBestEffort(graphToken)
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

async function getDirectoryRoleSnapshot(graphToken: string): Promise<[ActivationItem[], ActivationItem[]]> {
  assertFreshToken(graphToken, "graph");
  const [eligibleRoles, assignmentInstances, assignmentRequests] = await Promise.all([
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl(`/v1.0/roleManagement/directory/roleEligibilityScheduleInstances/filterByCurrentUser(on='principal')?${new URLSearchParams({ "$expand": "roleDefinition" }).toString()}`),
      graphToken
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleInstances/filterByCurrentUser(on='principal')?$expand=roleDefinition"),
      graphToken
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const [definitions, scopeNames, policyRequirements] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken),
    getDirectoryScopeNamesBestEffort(graphToken, [...eligibleRoles, ...assignmentInstances, ...assignmentRequests]),
    getDirectoryRolePolicyRequirementsBestEffort(graphToken)
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
  return [eligible, [...pending, ...active]];
}

function getDirectoryRoleActiveInstanceItems(
  instances: DirectoryRoleApi[],
  definitions: Record<string, DirectoryRoleDefinitionInfo>,
  scopeNames: Record<string, string>,
  policyRequirements: Record<string, Partial<ActivationRequirements>> = {}
): ActivationItem[] {
  const now = Date.now();
  return instances
    .filter((role) => !role.endDateTime || new Date(role.endDateTime).getTime() > now)
    .map((role) => {
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
        ...(role.endDateTime ? { activeUntil: new Date(role.endDateTime).toISOString() } : {}),
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

async function getDirectoryRoleDefinitions(graphToken: string): Promise<Record<string, DirectoryRoleDefinitionInfo>> {
  const roles = await fetchAllPages<DirectoryRoleDefinitionApi>(
    graphApiUrl("/v1.0/roleManagement/directory/roleDefinitions"),
    graphToken
  );
  return buildDirectoryRoleDefinitionInfoMap(roles);
}

async function getDirectoryRoleDefinitionsBestEffort(graphToken: string): Promise<Record<string, DirectoryRoleDefinitionInfo>> {
  try {
    return await getDirectoryRoleDefinitions(graphToken);
  } catch {
    return {};
  }
}

async function getDirectoryRolePolicyRequirementsBestEffort(
  graphToken: string
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
        graphToken
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
      result[role.id] = info;
    }
    if (role.templateId) {
      result[role.templateId] = info;
    }
  }
  return result;
}

function withDirectoryRoleDefinitionName(role: DirectoryRoleApi, definitions: Record<string, DirectoryRoleDefinitionInfo>): DirectoryRoleApi {
  const roleDefinitionId = role.roleDefinitionId || role.roleDefinition?.id || role.roleDefinition?.templateId || role.id || "";
  const definition =
    definitions[roleDefinitionId] ||
    definitions[role.roleDefinition?.id || ""] ||
    definitions[role.roleDefinition?.templateId || ""];
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
  roles: Array<Pick<DirectoryRoleApi, "directoryScopeId">>
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
    const displayName = await fetchDirectoryScopeDisplayName(graphToken, scopeId);
    return displayName ? ([scopeId, displayName] as const) : undefined;
  });
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}

async function fetchDirectoryScopeDisplayName(graphToken: string, directoryScopeId: string): Promise<string | undefined> {
  const objectId = extractDirectoryScopeObjectId(directoryScopeId);
  if (!objectId) {
    return undefined;
  }

  for (const url of getDirectoryScopeLookupUrls(directoryScopeId, objectId)) {
    try {
      const data = await fetchJson<{ displayName?: string; userPrincipalName?: string }>(url, graphToken);
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

async function getPimGroups(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const schedules = await fetchAllPages<PimGroupApi>(
    graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances/filterByCurrentUser(on='principal')"),
    graphToken
  );
  const groupIds = [...new Set(schedules.map((schedule) => schedule.groupId).filter(Boolean) as string[])];
  const groupInfos = await getGroupInfos(
    graphToken,
    groupIds
  );
  const policyRequirements = await getPimGroupPolicyRequirementsBestEffort(graphToken, groupIds);

  return schedules.map((schedule) => {
    const item = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
    const groupPolicy = policyRequirements[item.groupId];
    return applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default);
  });
}

async function getPimGroupSnapshot(graphToken: string): Promise<[ActivationItem[], ActivationItem[]]> {
  assertFreshToken(graphToken, "graph");
  const [eligibleSchedules, activeSchedules, assignmentRequests] = await Promise.all([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const groupIds = [
    ...new Set(
      [...eligibleSchedules, ...activeSchedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const [groupInfos, policyRequirements] = await Promise.all([
    getGroupInfos(graphToken, groupIds),
    getPimGroupPolicyRequirementsBestEffort(
      graphToken,
      groupIds
    )
  ]);
  const eligible = eligibleSchedules.map((schedule) => {
    const item = normalizePimGroup(schedule, groupInfos[schedule.groupId || ""]);
    const groupPolicy = policyRequirements[item.groupId];
    return applyActivationRequirements(item, groupPolicy?.[item.accessId] || groupPolicy?.default);
  });
  const active = getActivePimGroupInstanceItems(activeSchedules, groupInfos, policyRequirements);
  const pending = getPimGroupPendingRequestItems(assignmentRequests, groupInfos, policyRequirements);
  return [eligible, [...pending, ...active]];
}

function getActivePimGroupInstanceItems(
  instances: PimGroupApi[],
  groupInfos: Record<string, GroupInfo>,
  policyRequirements: Record<string, Record<string, Partial<ActivationRequirements>>>
): ActivationItem[] {
  const now = Date.now();
  return instances
    .map((schedule) => ({ schedule, activeUntil: schedule.endDateTime || getActiveUntilFromScheduleInfo(schedule.scheduleInfo) }))
    .filter(({ activeUntil }) => !activeUntil || new Date(activeUntil).getTime() > now)
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
        ...(activeUntil ? { activeUntil: new Date(activeUntil).toISOString() } : {})
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
  groupIds: string[]
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
          graphToken
        );
        const requirementsByRole = buildRolePolicyRequirementMap(assignments);
        return [
          groupId,
          Object.fromEntries(
            Object.entries(requirementsByRole).map(([roleDefinitionId, requirements]) => [
              roleDefinitionId.toLowerCase().includes("owner") ? "owner" : roleDefinitionId.toLowerCase().includes("member") ? "member" : "default",
              requirements
            ])
          )
        ] as const;
      } catch {
        return [groupId, {}] as const;
      }
    }
  );
  return Object.fromEntries(entries);
}

async function getGroupInfos(graphToken: string, groupIds: string[]): Promise<Record<string, GroupInfo>> {
  const entries = await mapWithConcurrency(
    groupIds,
    6,
    async (groupId) => {
      try {
        const group = await fetchJson<GroupInfo>(
          graphApiUrl(`/v1.0/groups/${encodePathSegment(groupId)}?$select=id,displayName,description,mail`),
          graphToken
        );
        return [groupId, group] as const;
      } catch {
        return [groupId, { id: groupId, displayName: groupId }] as const;
      }
    }
  );
  return Object.fromEntries(entries);
}

async function getAzureRoles(azureManagementToken: string): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  return getAzureRolesForSubscriptions(azureManagementToken, subscriptions);
}

async function getAzureRoleSnapshot(azureManagementToken: string): Promise<[ActivationItem[], ActivationItem[]]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  return Promise.all([
    getAzureRolesForSubscriptions(azureManagementToken, subscriptions),
    getActiveAzureRolesForSubscriptions(azureManagementToken, subscriptions)
  ]);
}

async function getAzureRolesForSubscriptions(
  azureManagementToken: string,
  subscriptions: Array<{ subscriptionId: string; displayName: string }>
): Promise<ActivationItem[]> {
  const roleGroups = await mapWithConcurrencySettled(
    subscriptions,
    4,
    async (subscription) => {
      const roles = await fetchAllPages<AzureRoleApi>(
        azureManagementUrl(
          `/subscriptions/${encodePathSegment(subscription.subscriptionId)}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=2020-10-01&$filter=asTarget()`
        ),
        azureManagementToken
      );
      return roles.map((role) =>
        normalizeAzureRole({
          ...role,
          subscriptionId: subscription.subscriptionId,
          subscriptionName: subscription.displayName
        })
      );
    }
  );

  assertAtLeastOneSubscriptionSucceeded(roleGroups, "eligible Azure roles");
  const items = roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : []));
  const itemsWithPolicies = await applyAzureRolePolicyRequirements(items, azureManagementToken);
  return applyAzureRoleDefinitionMetadata(itemsWithPolicies, azureManagementToken);
}

async function applyAzureRolePolicyRequirements(items: ActivationItem[], token: string): Promise<ActivationItem[]> {
  const azureItems = items.filter((item): item is Extract<ActivationItem, { type: "azureRole" }> => item.type === "azureRole");
  const uniqueScopes = [...new Set(azureItems.map((item) => item.scope))];
  const policyEntries = await mapWithConcurrency(
    uniqueScopes,
    4,
    async (scope) => {
      try {
        const assignments = await fetchAllPages<RoleManagementPolicyAssignmentApi>(
          azureManagementUrl(`${scope}/providers/Microsoft.Authorization/roleManagementPolicyAssignments?api-version=2020-10-01`),
          token
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

async function getSubscriptions(token: string): Promise<Array<{ subscriptionId: string; displayName: string }>> {
  return fetchAllPages<Array<{ subscriptionId: string; displayName: string }>[number]>(
    azureManagementUrl("/subscriptions?api-version=2020-01-01"),
    token
  );
}

async function getActiveDirectoryRoles(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const [instances, requests] = await Promise.all([
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleInstances/filterByCurrentUser(on='principal')?$expand=roleDefinition"),
      graphToken
    ),
    fetchAllPages<DirectoryRoleApi>(
      graphApiUrl("/v1.0/roleManagement/directory/roleAssignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const [definitions, scopeNames] = await Promise.all([
    getDirectoryRoleDefinitionsBestEffort(graphToken),
    getDirectoryScopeNamesBestEffort(graphToken, [...instances, ...requests])
  ]);
  return [
    ...getDirectoryRolePendingRequestItems(requests, definitions, scopeNames),
    ...getDirectoryRoleActiveInstanceItems(instances, definitions, scopeNames)
  ];
}

async function getActiveAzureRoles(azureManagementToken: string): Promise<ActivationItem[]> {
  assertFreshToken(azureManagementToken, "azureManagement");
  const subscriptions = await getSubscriptions(azureManagementToken);
  return getActiveAzureRolesForSubscriptions(azureManagementToken, subscriptions);
}

async function getActiveAzureRolesForSubscriptions(
  azureManagementToken: string,
  subscriptions: Array<{ subscriptionId: string; displayName: string }>
): Promise<ActivationItem[]> {
  const now = Date.now();
  const roleGroups = await mapWithConcurrencySettled(
    subscriptions,
    4,
    async (subscription) => {
      const roles = await fetchAllPages<AzureRoleApi>(
        azureManagementUrl(
          `/subscriptions/${encodePathSegment(subscription.subscriptionId)}/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=2020-10-01&$filter=asTarget()`
        ),
        azureManagementToken
      );
      return roles
        .filter((role) => !role.properties?.endDateTime || new Date(role.properties.endDateTime).getTime() > now)
        .map((role) => {
          const item = normalizeAzureRole({
            ...role,
            subscriptionId: subscription.subscriptionId,
            subscriptionName: subscription.displayName
          });
          const activeAssignmentType = normalizeActiveAssignmentType(role.properties?.assignmentType);
          const isSelfActivated = activeAssignmentType === "activated";
          return {
            ...item,
            status: "active" as const,
            activeAssignmentType,
            assignmentScheduleId: isSelfActivated ? item.assignmentScheduleId : undefined,
            assignmentScheduleInstanceId: isSelfActivated ? item.assignmentScheduleInstanceId : undefined,
            ...(role.properties?.endDateTime ? { activeUntil: new Date(role.properties.endDateTime).toISOString() } : {})
          };
        });
    }
  );

  assertAtLeastOneSubscriptionSucceeded(roleGroups, "active Azure roles");
  return applyAzureRoleDefinitionMetadata(
    roleGroups.flatMap((group) => (group.status === "fulfilled" ? group.value : [])),
    azureManagementToken
  );
}

function assertAtLeastOneSubscriptionSucceeded<T>(
  results: Array<PromiseSettledResult<T>>,
  operation: string
): void {
  if (results.length && results.every((result) => result.status === "rejected")) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw new Error(`Unable to load ${operation} data from any subscription. ${sanitizeErrorMessage(firstError)}`.trim());
  }
}

async function applyAzureRoleDefinitionMetadata(items: ActivationItem[], token: string): Promise<ActivationItem[]> {
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
            token
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

async function getActivePimGroups(graphToken: string): Promise<ActivationItem[]> {
  assertFreshToken(graphToken, "graph");
  const [schedules, assignmentRequests] = await Promise.all([
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleInstances/filterByCurrentUser(on='principal')"),
      graphToken
    ),
    fetchAllPages<PimGroupApi>(
      graphApiUrl("/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests/filterByCurrentUser(on='principal')"),
      graphToken
    )
  ]);
  const groupIds = [
    ...new Set(
      [...schedules, ...assignmentRequests]
        .map((schedule) => schedule.groupId)
        .filter(Boolean) as string[]
    )
  ];
  const [groupInfos, policyRequirements] = await Promise.all([
    getGroupInfos(graphToken, groupIds),
    getPimGroupPolicyRequirementsBestEffort(graphToken, groupIds)
  ]);
  const active = getActivePimGroupInstanceItems(schedules, groupInfos, policyRequirements);
  return [...getPimGroupPendingRequestItems(assignmentRequests, groupInfos, policyRequirements), ...active];
}

async function activateItems(
  items: ActivationItem[],
  durationHours: number,
  justification: string,
  ticketInfo: TicketInfo,
  bundleName?: string
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
  const startDateTime = new Date().toISOString();
  const executions = await mapWithConcurrency(
    items,
    4,
    async (item) => {
      try {
        return await runWithActivationItemLock(item, async () => {
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
          const requestId = getResponseIdentifier(data, request);
          return {
            result: {
              itemId: item.id,
              itemName: item.displayName,
              success: true,
              requestId
            },
            trackedRequest: requestId
              ? createTrackedPimRequest({
                item,
                action: "activate",
                requestId,
                payload: data,
                requestedAt: startDateTime,
                durationHours,
                justification: justification.trim(),
                bundleName,
                tenantId: getTokenTenantId(token)
              })
              : undefined
          };
        });
      } catch (error) {
        const accessRecoveryTarget = getPortalAccessRecoveryTarget(error);
        return {
          result: {
            itemId: item.id,
            itemName: item.displayName,
            success: false,
            error: sanitizeErrorMessage(error),
            ...(accessRecoveryTarget ? { accessRecoveryTarget } : {})
          },
          trackedRequest: undefined
        };
      }
    }
  );
  const results = executions.map((execution) => execution.result);
  await persistTrackedSubmissionsBestEffort(
    executions.flatMap((execution) => execution.trackedRequest ? [execution.trackedRequest] : [])
  );

  const errors = results.filter((result) => !result.success);
  return {
    success: errors.length === 0,
    results,
    errors
  };
}

async function sendActivationRequest(request: ActivationRequest, token: string): Promise<unknown> {
  const response = await fetchMicrosoftApi(request.endpoint, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request.body)
  }, MICROSOFT_API_WRITE_TIMEOUT_MS);

  if (!response.ok) {
    const errorData = await safeJson(response);
    throw new Error(sanitizeErrorMessage(getApiErrorMessage(errorData, response) || `${response.status} ${response.statusText}`));
  }

  return safeJson(response);
}

async function deactivateItems(
  items: ActivationItem[],
  justification: string,
  ticketInfo: TicketInfo
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
      try {
        return await runWithActivationItemLock(item, async () => {
          const request = buildDeactivationRequest(item, justification.trim(), ticketInfo, startDateTime);
          assertAllowedApiUrl(request.endpoint, request.tokenKind);
          const token = getTokenForActivation(tokens, item, request.tokenKind);
          if (!token) {
            throw createPortalAccessRequiredError(item, request.tokenKind, "deactivation");
          }
          assertRequestTokenReady(item, token, request.tokenKind, "deactivation");
          assertTokenCanActivate(item, token, request.tokenKind, "deactivation");
          const data = await sendActivationRequest(request, token);
          const requestId = getResponseIdentifier(data, request);
          return {
            result: {
              itemId: item.id,
              itemName: item.displayName,
              success: true,
              requestId
            },
            trackedRequest: requestId
              ? createTrackedPimRequest({
                item,
                action: "deactivate",
                requestId,
                payload: data,
                requestedAt: startDateTime,
                justification: justification.trim(),
                tenantId: getTokenTenantId(token)
              })
              : undefined
          };
        });
      } catch (error) {
        const accessRecoveryTarget = getPortalAccessRecoveryTarget(error);
        return {
          result: {
            itemId: item.id,
            itemName: item.displayName,
            success: false,
            error: sanitizeErrorMessage(error),
            ...(accessRecoveryTarget ? { accessRecoveryTarget } : {})
          },
          trackedRequest: undefined
        };
      }
    }
  );
  const results = executions.map((execution) => execution.result);
  await persistTrackedSubmissionsBestEffort(
    executions.flatMap((execution) => execution.trackedRequest ? [execution.trackedRequest] : [])
  );

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
  try {
    assertFreshToken(token, tokenKind, Date.now() + MICROSOFT_API_WRITE_TOKEN_MIN_VALIDITY_MS);
  } catch {
    throw createPortalAccessRequiredError(item, tokenKind, operation);
  }

  const principalId = decodeToken(token)?.oid;
  if (typeof principalId === "string" && principalId.toLowerCase() !== item.principalId.toLowerCase()) {
    throw new Error("The selected role belongs to another signed-in account. Refresh role data before retrying.");
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

function getPortalAccessRecoveryTarget(error: unknown): AccessSetupTarget | undefined {
  return error instanceof PortalAccessRequiredError ? error.target : undefined;
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

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const tokenKind = getAllowedTokenKindForUrl(url);
  if (!tokenKind) {
    throw new Error("API URL is not allowed.");
  }
  return collectPaginatedValues(url, async (nextUrl) => {
    assertAllowedApiUrl(nextUrl, tokenKind);
    return fetchJson(nextUrl, token);
  });
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  assertAllowedApiUrl(url);
  const response = await fetchMicrosoftApi(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  }, MICROSOFT_API_READ_TIMEOUT_MS);

  if (!response.ok) {
    const errorData = await safeJson(response);
    throw new Error(sanitizeErrorMessage(getApiErrorMessage(errorData, response) || `${response.status} ${response.statusText}`));
  }

  return (await response.json()) as T;
}

async function fetchMicrosoftApi(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Microsoft API request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function dedupeItems(items: ActivationItem[]): ActivationItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
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

async function persistTrackedSubmissionsBestEffort(requests: TrackedPimRequest[]): Promise<void> {
  if (!requests.length) {
    return;
  }
  try {
    await withTimeout((async () => {
      const store = await mutateTrackedRequests((current) => upsertTrackedRequests(current, requests));
      const settings = await loadSettings();
      await Promise.all([
        updateTrackedRequestBadge(store),
        scheduleTrackedRequestMaintenance(store, settings)
      ]);
    })(), REQUEST_TRACKING_STORAGE_TIMEOUT_MS, "Request tracking storage timed out.");
  } catch {
    // Microsoft already accepted the request. Tracking must not alter that result.
  }
}

function getTokenTenantId(token: string): string | undefined {
  const decoded = decodeToken(token);
  return typeof decoded?.tid === "string" ? decoded.tid : undefined;
}

function getResponseIdentifier(payload: unknown, request?: ActivationRequest): string | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const identifier = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
    if (identifier) {
      return identifier;
    }
  }
  if (request?.method === "PUT") {
    try {
      return decodeURIComponent(new URL(request.endpoint).pathname.split("/").filter(Boolean).at(-1) || "") || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
