import { parseIsoDurationMs } from "./pim";
import { sanitizeErrorMessage, validateCapturedToken } from "./security";
import { createStorageMutationLock } from "./storageMutation";
import type {
  ActivationItem,
  ActivityAction,
  TrackedPimRequest,
  TrackedPimRequestStatus,
  TrackedPimRequestStore
} from "./types";

export const REQUEST_TRACKING_KEY = "quickPimRequests.v1";
export const REQUEST_TRACKING_ALARM_NAME = "quickPimRequestTracking";
export const REQUEST_TRACKING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REQUEST_TRACKING_MAX_DUE_PER_RUN = 20;
export const REQUEST_TRACKING_AZURE_CONCURRENCY = 3;
export const REQUEST_TRACKING_GRAPH_CONCURRENCY = 3;
export const DEFAULT_EXPIRY_REMINDER_MINUTES = 15;
export const EXPIRY_REMINDER_CATCH_UP_GRACE_MS = 60 * 60 * 1000;
export const EXPIRY_REMINDER_RETRY_DELAY_MS = 5 * 60 * 1000;
export const ACTIVE_ASSIGNMENT_VISIBILITY_GRACE_MS = 30 * 60 * 1000;
export const ACTIVE_ASSIGNMENT_RECHECK_MS = 10 * 60 * 1000;

const MAX_TRACKED_REQUESTS = 100;
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 160;
const MAX_SCOPE_LENGTH = 512;
const MAX_JUSTIFICATION_LENGTH = 1024;
const MAX_ERROR_LENGTH = 260;
const MAX_BUNDLE_NAME_LENGTH = 80;
const MAX_TICKET_FIELD_LENGTH = 128;
const MAX_STORED_CHECK_COUNT = 100_000;
const ACCESS_RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_REQUEST_METADATA_PRE_REQUEST_SKEW_MS = 24 * 60 * 60 * 1000;
const POLL_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000] as const;
const EMPTY_REQUEST_STORE: TrackedPimRequestStore = { version: 1, requests: [] };

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface CreateTrackedRequestInput {
  item: ActivationItem;
  action: ActivityAction;
  requestId: string;
  operationId?: string;
  payload?: unknown;
  requestedAt: string;
  durationHours?: number;
  justification?: string;
  ticketInfo?: { ticketSystem?: string; ticketNumber?: string };
  bundleName?: string;
  tenantId?: string;
  scheduledStartAt?: string;
  continuationOfRequestId?: string;
  now?: number;
}

const withTrackedRequestMutationLock = createStorageMutationLock("quickPimTrackedRequestMutation");

export function runWithTrackedRequestMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  return withTrackedRequestMutationLock(operation);
}

export async function loadTrackedRequests(storage: StorageAreaLike = chrome.storage.local): Promise<TrackedPimRequestStore> {
  const result = await storage.get(REQUEST_TRACKING_KEY);
  return sanitizeTrackedRequestStore(result[REQUEST_TRACKING_KEY]);
}

export async function saveTrackedRequests(
  store: TrackedPimRequestStore,
  storage: StorageAreaLike = chrome.storage.local
): Promise<TrackedPimRequestStore> {
  return withTrackedRequestMutationLock(() => saveTrackedRequestsUnlocked(store, storage));
}

async function saveTrackedRequestsUnlocked(
  store: TrackedPimRequestStore,
  storage: StorageAreaLike
): Promise<TrackedPimRequestStore> {
  const sanitized = sanitizeTrackedRequestStore(store);
  await storage.set({ [REQUEST_TRACKING_KEY]: sanitized });
  return sanitized;
}

export async function mutateTrackedRequests(
  mutator: (current: TrackedPimRequestStore) => TrackedPimRequestStore,
  storage: StorageAreaLike = chrome.storage.local
): Promise<TrackedPimRequestStore> {
  return withTrackedRequestMutationLock(async () => {
    const current = await loadTrackedRequests(storage);
    return saveTrackedRequestsUnlocked(mutator(current), storage);
  });
}

export async function clearTrackedRequests(storage: StorageAreaLike = chrome.storage.local): Promise<void> {
  await withTrackedRequestMutationLock(() => storage.remove(REQUEST_TRACKING_KEY));
}

export function createTrackedPimRequest(input: CreateTrackedRequestInput): TrackedPimRequest | undefined {
  const requestId = sanitizeString(input.requestId, MAX_ID_LENGTH);
  const requestedAt = sanitizeTimestamp(input.requestedAt);
  if (!requestId || !requestedAt) {
    return undefined;
  }

  const now = input.now ?? Date.now();
  const details = getRequestPayloadDetails(
    input.payload,
    input.action,
    requestedAt,
    input.durationHours,
    now,
    input.scheduledStartAt
  );
  const base: TrackedPimRequest = {
    id: buildTrackedRequestId(input.item.type, requestId, input.tenantId || input.item.tenantId),
    requestId,
    operationId: sanitizeOperationId(input.operationId),
    action: input.action,
    itemId: input.item.id,
    itemName: input.item.displayName || input.item.sourceName,
    itemType: input.item.type,
    scopeLabel: input.item.scopeLabel,
    principalId: input.item.principalId,
    tenantId: input.tenantId,
    status: details.status,
    rawStatus: details.rawStatus,
    requestedAt,
    updatedAt: new Date(now).toISOString(),
    completedAt: details.completedAt,
    activeUntil: details.activeUntil,
    activeFrom: details.activeFrom,
    durationHours: normalizeDuration(input.durationHours),
    justification: input.justification,
    ticketSystem: input.ticketInfo?.ticketSystem,
    ticketNumber: input.ticketInfo?.ticketNumber,
    bundleName: input.bundleName,
    activationRequirements: input.item.activationRequirements,
    continuationOfRequestId: input.continuationOfRequestId,
    approvalId: details.approvalId,
    targetScheduleId: details.targetScheduleId,
    checkCount: 0,
    nextCheckAt: shouldContinueTracking(details.status, details.activeUntil)
      ? new Date(now + getRequestPollDelayMs(0)).toISOString()
      : undefined
  };

  if (input.item.type === "directoryRole") {
    base.roleDefinitionId = input.item.roleDefinitionId;
    base.directoryScopeId = input.item.directoryScopeId;
  } else if (input.item.type === "pimGroup") {
    base.groupId = input.item.groupId;
    base.accessId = input.item.accessId;
  } else {
    base.roleDefinitionId = input.item.roleDefinitionId;
    base.azureScope = input.item.scope;
    base.roleEligibilityScheduleId = input.item.roleEligibilityScheduleId;
  }

  return sanitizeTrackedRequest(base, now);
}

export function upsertTrackedRequests(
  store: TrackedPimRequestStore,
  requests: TrackedPimRequest[]
): TrackedPimRequestStore {
  const byId = new Map(store.requests.map((request) => [request.id, request]));
  for (const request of requests) {
    const current = byId.get(request.id);
    if (current && compareTrackedRequestVersion(request, current) < 0) continue;
    byId.set(request.id, sanitizeTrackedRequest({ ...current, ...request }) || current || request);
  }
  return sanitizeTrackedRequestStore({
    version: 1,
    requests: [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
  });
}

export function updateTrackedRequestFromPayload(
  request: TrackedPimRequest,
  payload: unknown,
  now = Date.now()
): TrackedPimRequest {
  const details = getRequestPayloadDetails(
    payload,
    request.action,
    request.requestedAt,
    request.durationHours,
    now,
    request.activeFrom
  );
  const checkCount = request.checkCount + 1;
  const status = details.status;
  const canContinue = shouldContinueTracking(status, details.activeUntil || request.activeUntil)
    && now - Date.parse(request.requestedAt) < REQUEST_TRACKING_TTL_MS;
  return sanitizeTrackedRequest({
    ...request,
    status: canContinue || !isTrackedRequestPendingStatus(status) ? status : "statusUnavailable",
    rawStatus: details.rawStatus || request.rawStatus,
    updatedAt: new Date(now).toISOString(),
    completedAt: details.completedAt || request.completedAt,
    activeUntil: details.hasActiveUntil ? details.activeUntil : request.activeUntil,
    activeFrom: details.hasActiveFrom ? details.activeFrom : request.activeFrom,
    approvalId: details.approvalId || request.approvalId,
    targetScheduleId: details.targetScheduleId || request.targetScheduleId,
    lastCheckedAt: new Date(now).toISOString(),
    nextCheckAt: canContinue ? new Date(now + getRequestPollDelayMs(checkCount)).toISOString() : undefined,
    checkCount,
    lastError: undefined,
    notifiedStatus: status === request.status ? request.notifiedStatus : undefined
  }, now) || request;
}

export function reconcileTrackedRequestWithActiveAssignments(
  request: TrackedPimRequest,
  activeItems: ActivationItem[],
  now = Date.now(),
  activeItemsComplete = true
): TrackedPimRequest {
  if (request.action !== "activate" || getEffectiveTrackedRequestStatus(request, now) !== "active" || request.activeUntil) {
    return request;
  }

  const activeItem = activeItems.find((item) => trackedRequestMatchesActiveItem(request, item));
  if (activeItem) {
    const candidate = {
      ...request,
      status: "active",
      activeUntil: activeItem.activeUntil,
      activeAssignmentMissingSince: undefined,
      updatedAt: new Date(now).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      nextCheckAt: activeItem.activeUntil
        ? undefined
        : new Date(now + ACTIVE_ASSIGNMENT_RECHECK_MS).toISOString(),
      lastError: undefined
    };
    return sanitizeTrackedRequest(candidate, now) || request;
  }

  const missingSince = request.activeAssignmentMissingSince || new Date(now).toISOString();
  const missingSinceMs = Date.parse(missingSince);
  const visibilityExpired = activeItemsComplete && Number.isFinite(missingSinceMs)
    && now - missingSinceMs >= ACTIVE_ASSIGNMENT_VISIBILITY_GRACE_MS;
  return sanitizeTrackedRequest({
    ...request,
    status: visibilityExpired ? "expired" : "active",
    activeAssignmentMissingSince: visibilityExpired ? undefined : missingSince,
    updatedAt: new Date(now).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    completedAt: visibilityExpired ? new Date(now).toISOString() : request.completedAt,
    nextCheckAt: visibilityExpired ? undefined : new Date(now + ACTIVE_ASSIGNMENT_RECHECK_MS).toISOString(),
    lastError: visibilityExpired ? undefined : "Waiting for the active assignment to become visible."
  }, now) || request;
}

export function markTrackedRequestCheckFailure(
  request: TrackedPimRequest,
  error: unknown,
  now = Date.now(),
  options: { waitingForAccess?: boolean; waitingForVisibility?: boolean } = {}
): TrackedPimRequest {
  const isWaiting = options.waitingForAccess || options.waitingForVisibility;
  const checkCount = isWaiting ? request.checkCount : request.checkCount + 1;
  const trackingExpired = now - Date.parse(request.requestedAt) >= REQUEST_TRACKING_TTL_MS;
  const nextDelay = options.waitingForAccess
    ? ACCESS_RETRY_DELAY_MS
    : options.waitingForVisibility
      ? 2 * 60_000
      : getRequestPollDelayMs(checkCount);
  return sanitizeTrackedRequest({
    ...request,
    status: trackingExpired ? "statusUnavailable" : request.status,
    updatedAt: new Date(now).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    nextCheckAt: trackingExpired ? undefined : new Date(now + nextDelay).toISOString(),
    checkCount,
    lastError: sanitizeErrorMessage(error)
  }, now) || request;
}

export function getDueTrackedRequests(
  store: TrackedPimRequestStore,
  now = Date.now(),
  requestIds?: string[]
): TrackedPimRequest[] {
  const requestedIds = requestIds?.length ? new Set(requestIds.map((id) => id.toLowerCase())) : undefined;
  return store.requests
    .filter((request) => {
      if (requestedIds && !requestedIds.has(request.id.toLowerCase()) && !requestedIds.has(request.requestId.toLowerCase())) {
        return false;
      }
      if (requestedIds) return true;
      return isTrackedRequestPending(request) && (!request.nextCheckAt || Date.parse(request.nextCheckAt) <= now);
    })
    .sort((left, right) => getTrackedRequestUrgency(left, now) - getTrackedRequestUrgency(right, now)
      || left.requestedAt.localeCompare(right.requestedAt)
      || left.id.localeCompare(right.id))
    .slice(0, REQUEST_TRACKING_MAX_DUE_PER_RUN);
}

export function getRequestTrackingMaintenanceTime(
  store: TrackedPimRequestStore,
  options: { notificationsEnabled: boolean; expiryReminderMinutes: number; now?: number }
): number | undefined {
  const now = options.now ?? Date.now();
  const candidates: number[] = [];
  for (const request of store.requests) {
    if (isTrackedRequestPending(request)) {
      const nextCheck = request.nextCheckAt ? Date.parse(request.nextCheckAt) : now;
      if (Number.isFinite(nextCheck)) {
        candidates.push(nextCheck);
      }
    }
    if (request.status === "scheduled" && request.activeFrom) {
      const activeFrom = Date.parse(request.activeFrom);
      if (Number.isFinite(activeFrom) && activeFrom > now) {
        candidates.push(activeFrom);
      }
    }
  }
  if (options.notificationsEnabled) {
    const nextReminder = getNextTrackedExpiryReminderTime(store, options.expiryReminderMinutes, now);
    if (nextReminder !== undefined) {
      candidates.push(nextReminder);
    }
  }
  if (!candidates.length) {
    return undefined;
  }
  return Math.max(now + 1_000, Math.min(...candidates));
}

export type TrackedExpiryReminderDecision = "upcoming" | "missed";

export function getTrackedExpiryReminderDecision(
  request: TrackedPimRequest,
  reminderMinutes: number,
  now = Date.now()
): TrackedExpiryReminderDecision | undefined {
  if (request.action !== "activate" || !request.activeUntil || request.expiryReminderSentAt) {
    return undefined;
  }
  const activeUntil = Date.parse(request.activeUntil);
  if (!Number.isFinite(activeUntil)) {
    return undefined;
  }
  const attemptedAt = request.expiryReminderAttemptedAt
    ? Date.parse(request.expiryReminderAttemptedAt)
    : Number.NaN;
  if (Number.isFinite(attemptedAt) && now < attemptedAt + EXPIRY_REMINDER_RETRY_DELAY_MS) {
    return undefined;
  }
  if (activeUntil <= now) {
    return getEffectiveTrackedRequestStatus(request, now) === "expired"
      && now - activeUntil <= EXPIRY_REMINDER_CATCH_UP_GRACE_MS
        ? "missed"
        : undefined;
  }
  if (getEffectiveTrackedRequestStatus(request, now) !== "active") {
    return undefined;
  }
  const reminderAt = activeUntil - normalizeReminderMinutes(reminderMinutes) * 60_000;
  return now >= reminderAt ? "upcoming" : undefined;
}

export function getNextTrackedExpiryReminderTime(
  store: TrackedPimRequestStore,
  reminderMinutes: number,
  now = Date.now()
): number | undefined {
  const candidates: number[] = [];
  for (const request of store.requests) {
    if (request.action !== "activate" || !request.activeUntil || request.expiryReminderSentAt) {
      continue;
    }
    const activeUntil = Date.parse(request.activeUntil);
    if (!Number.isFinite(activeUntil) || now - activeUntil > EXPIRY_REMINDER_CATCH_UP_GRACE_MS) {
      continue;
    }
    const attemptedAt = request.expiryReminderAttemptedAt
      ? Date.parse(request.expiryReminderAttemptedAt)
      : Number.NaN;
    const retryAt = Number.isFinite(attemptedAt)
      ? attemptedAt + EXPIRY_REMINDER_RETRY_DELAY_MS
      : Number.NaN;
    if (activeUntil <= now) {
      if (getEffectiveTrackedRequestStatus(request, now) === "expired") {
        candidates.push(Number.isFinite(retryAt) && retryAt > now ? retryAt : now);
      }
      continue;
    }
    if (getEffectiveTrackedRequestStatus(request, now) !== "active") {
      continue;
    }
    const reminderAt = activeUntil - normalizeReminderMinutes(reminderMinutes) * 60_000;
    candidates.push(Number.isFinite(retryAt) && retryAt > now && reminderAt <= now ? retryAt : reminderAt);
  }
  return candidates.length ? Math.max(now + 1_000, Math.min(...candidates)) : undefined;
}

export function getPendingTrackedRequestCount(store: TrackedPimRequestStore): number {
  return store.requests.filter((request) =>
    isTrackedRequestPending(request) || getEffectiveTrackedRequestStatus(request) === "scheduled"
  ).length;
}

export function reconcileTrackedExtensionSources(
  store: TrackedPimRequestStore,
  now = Date.now()
): TrackedPimRequestStore {
  const retryableSourceIds = new Set(
    store.requests.flatMap((request) => {
      if (!request.continuationOfRequestId) return [];
      const status = getEffectiveTrackedRequestStatus(request, now);
      return status === "denied" || status === "failed" || status === "canceled" || status === "expired"
        ? [request.continuationOfRequestId.toLowerCase()]
        : [];
    })
  );
  if (!retryableSourceIds.size) {
    return store;
  }

  let changed = false;
  const requests = store.requests.map((request) => {
    const continuationExists = request.extensionRequestId
      ? store.requests.some((candidate) => candidate.requestId.toLowerCase() === request.extensionRequestId?.toLowerCase())
      : false;
    const extensionRequestedAt = request.extensionRequestedAt ? Date.parse(request.extensionRequestedAt) : Number.NaN;
    const orphanedContinuation = request.extensionAttemptState === "queued"
      && !continuationExists
      && Number.isFinite(extensionRequestedAt)
      && now - extensionRequestedAt >= ACTIVE_ASSIGNMENT_VISIBILITY_GRACE_MS;
    if (
      request.extensionAttemptState !== "queued"
      || (!retryableSourceIds.has(request.requestId.toLowerCase()) && !orphanedContinuation)
    ) {
      return request;
    }
    changed = true;
    return {
      ...request,
      extensionAttemptState: undefined,
      extensionRequestId: undefined,
      extensionLastError: "The previous extension request was not completed.",
      updatedAt: new Date(now).toISOString()
    };
  });
  return changed ? { version: 1, requests } : store;
}

export function trackedRequestMatchesTokenIdentity(
  request: TrackedPimRequest,
  identity: { tenantId?: string; principalId?: string }
): boolean {
  if (!identity.principalId || request.principalId.toLowerCase() !== identity.principalId.toLowerCase()) {
    return false;
  }
  if (!request.tenantId) return false;
  return Boolean(identity.tenantId && request.tenantId.toLowerCase() === identity.tenantId.toLowerCase());
}

export function trackedRequestMatchesValidatedToken(
  request: TrackedPimRequest,
  token: string,
  now = Date.now()
): boolean {
  const tokenKind = request.itemType === "azureRole" ? "azureManagement" : "graph";
  const validation = validateCapturedToken(token, tokenKind, now);
  if (!validation.ok) {
    return false;
  }
  return trackedRequestMatchesTokenIdentity(request, {
    tenantId: typeof validation.decoded.tid === "string" ? validation.decoded.tid : undefined,
    principalId: typeof validation.decoded.oid === "string" ? validation.decoded.oid : undefined
  });
}

export function isTrackedRequestPending(request: TrackedPimRequest): boolean {
  const status = getEffectiveTrackedRequestStatus(request);
  return isTrackedRequestPendingStatus(status)
    || status === "scheduled"
    || (status === "active" && !request.activeUntil);
}

export function isTrackedRequestPendingStatus(status: TrackedPimRequestStatus): boolean {
  return status === "submitted" || status === "pendingApproval" || status === "provisioning";
}

export function getEffectiveTrackedRequestStatus(
  request: TrackedPimRequest,
  now = Date.now()
): TrackedPimRequestStatus {
  const activeFrom = request.activeFrom ? Date.parse(request.activeFrom) : Number.NaN;
  if (request.status === "scheduled") {
    if (Number.isFinite(activeFrom) && activeFrom > now) {
      return "scheduled";
    }
    const activeUntil = request.activeUntil ? Date.parse(request.activeUntil) : Number.NaN;
    return Number.isFinite(activeUntil) && activeUntil <= now ? "expired" : "active";
  }
  if (request.status !== "active" || !request.activeUntil) {
    return request.status;
  }
  if (Number.isFinite(activeFrom) && activeFrom > now) {
    return "scheduled";
  }
  const activeUntil = Date.parse(request.activeUntil);
  return Number.isFinite(activeUntil) && activeUntil <= now ? "expired" : request.status;
}

export function trackedRequestStatusLabel(status: TrackedPimRequestStatus): string {
  switch (status) {
    case "pendingApproval": return "Pending approval";
    case "provisioning": return "Provisioning";
    case "scheduled": return "Scheduled";
    case "active": return "Active";
    case "completed": return "Completed";
    case "denied": return "Denied";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    case "expired": return "Expired";
    case "unknown": return requestUnknownStatusLabel(status);
    case "statusUnavailable": return "Status unavailable";
    default: return "Submitted";
  }
}

export function normalizeTrackedRequestStatus(
  rawStatus: string | undefined,
  action: ActivityAction,
  activeUntil?: string,
  now = Date.now(),
  activeFrom?: string
): TrackedPimRequestStatus {
  const normalized = rawStatus?.replace(/[^a-z]/gi, "").toLowerCase();
  let status: TrackedPimRequestStatus;
  if (!normalized || normalized === "submitted" || normalized === "pending") {
    status = "submitted";
  } else if (normalized === "pendingapproval" || normalized === "pendingadmindecision") {
    status = "pendingApproval";
  } else if ([
    "accepted",
    "pendingevaluation",
    "pendingprovisioning",
    "pendingapprovalprovisioning",
    "pendingrevocation",
    "adminapproved",
    "provisioningstarted",
    "pendingschedulecreation",
    "schedulecreated",
    "pendingexternalprovisioning"
  ].includes(normalized)) {
    status = "provisioning";
  } else if (normalized === "provisioned" || normalized === "granted" || normalized === "completed") {
    status = action === "activate" ? "active" : "completed";
  } else if (normalized === "denied" || normalized === "admindenied") {
    status = "denied";
  } else if (["failed", "failedasresourceislocked", "invalid", "timedout"].includes(normalized)) {
    status = "failed";
  } else if (normalized === "canceled" || normalized === "cancelled") {
    status = "canceled";
  } else if (normalized === "revoked") {
    status = "completed";
  } else if (normalized === "expired") {
    status = "expired";
  } else {
    status = "unknown";
  }

  if (status === "active") {
    if (activeUntil && Date.parse(activeUntil) <= now) {
      return "expired";
    }
    if (activeFrom && Date.parse(activeFrom) > now) {
      return "scheduled";
    }
  }
  return status;
}

export function getActivationRequestItemStatus(
  rawStatus: string | undefined
): "active" | "pendingApproval" | undefined {
  if (!rawStatus?.trim()) {
    return undefined;
  }
  const status = normalizeTrackedRequestStatus(rawStatus, "activate");
  if (status === "active") {
    return "active";
  }
  if (status === "submitted" || status === "pendingApproval" || status === "provisioning") {
    return "pendingApproval";
  }
  return undefined;
}

export function sanitizeTrackedRequestStore(value: unknown, now = Date.now()): TrackedPimRequestStore {
  if (!isRecord(value) || !Array.isArray(value.requests)) {
    return EMPTY_REQUEST_STORE;
  }
  const byId = new Map<string, TrackedPimRequest>();
  for (const valueRequest of value.requests) {
    const request = sanitizeTrackedRequest(valueRequest, now);
    if (!request) continue;
    const current = byId.get(request.id);
    if (!current || compareTrackedRequestVersion(request, current) > 0) byId.set(request.id, request);
  }
  const requests = [...byId.values()]
    .sort((a, b) => getTrackedRetentionRank(a, now) - getTrackedRetentionRank(b, now)
      || b.requestedAt.localeCompare(a.requestedAt)
      || a.id.localeCompare(b.id))
    .slice(0, MAX_TRACKED_REQUESTS)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id));
  return { version: 1, requests };
}

function sanitizeTrackedRequest(value: unknown, now = Date.now()): TrackedPimRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requestId = sanitizeString(value.requestId, MAX_ID_LENGTH);
  const operationId = sanitizeOperationId(value.operationId);
  const itemId = sanitizeString(value.itemId, MAX_ID_LENGTH);
  const itemName = sanitizeString(value.itemName, MAX_NAME_LENGTH);
  const principalId = sanitizeString(value.principalId, MAX_ID_LENGTH) || "__unknown_principal__";
  const requestedAt = sanitizeTimestamp(value.requestedAt);
  const updatedAt = sanitizeTimestamp(value.updatedAt);
  const action = value.action === "activate" || value.action === "deactivate" ? value.action : undefined;
  const itemType = value.itemType === "directoryRole" || value.itemType === "pimGroup" || value.itemType === "azureRole"
    ? value.itemType
    : undefined;
  const status = isTrackedStatus(value.status) ? value.status : undefined;
  if (!requestId || !itemId || !itemName || !requestedAt || !updatedAt || !action || !itemType || !status) {
    return undefined;
  }
  const requestedAtMs = Date.parse(requestedAt);
  const updatedAtMs = Date.parse(updatedAt);
  if (
    requestedAtMs > now + MAX_FUTURE_CLOCK_SKEW_MS
    || updatedAtMs > now + MAX_FUTURE_CLOCK_SKEW_MS
    || updatedAtMs < requestedAtMs
  ) {
    return undefined;
  }

  const completedAt = sanitizeRequestMetadataTimestamp(value.completedAt, requestedAtMs, now);
  const extensionRequestedAt = sanitizeRequestMetadataTimestamp(value.extensionRequestedAt, requestedAtMs, now);
  const lastCheckedAt = sanitizeRequestMetadataTimestamp(value.lastCheckedAt, requestedAtMs, now);
  const expiryReminderAttemptedAt = sanitizeRequestMetadataTimestamp(value.expiryReminderAttemptedAt, requestedAtMs, now);
  const expiryReminderSentAt = sanitizeRequestMetadataTimestamp(value.expiryReminderSentAt, requestedAtMs, now);
  const activeAssignmentMissingSince = sanitizeRequestMetadataTimestamp(value.activeAssignmentMissingSince, requestedAtMs, now);
  const parsedNextCheckAt = sanitizeTimestamp(value.nextCheckAt);
  const nextCheckAtMs = parsedNextCheckAt ? Date.parse(parsedNextCheckAt) : Number.NaN;
  const scheduleAnchor = Math.max(
    requestedAtMs,
    Date.parse(String(value.activeFrom || "")) || 0,
    Date.parse(String(value.activeUntil || "")) || 0
  );
  const trackingDeadlineMs = scheduleAnchor + REQUEST_TRACKING_TTL_MS;
  const nextCheckAt = Number.isFinite(nextCheckAtMs)
    && nextCheckAtMs >= requestedAtMs
    && nextCheckAtMs <= trackingDeadlineMs + MAX_FUTURE_CLOCK_SKEW_MS
      ? parsedNextCheckAt
      : undefined;

  const tenantId = sanitizeString(value.tenantId, MAX_ID_LENGTH);
  const id = tenantId
    ? buildTrackedRequestId(itemType, requestId, tenantId)
    : sanitizeString(value.id, MAX_ID_LENGTH) || buildTrackedRequestId(itemType, requestId);
  const activeFrom = sanitizeTimestamp(value.activeFrom);
  const activeUntil = sanitizeTimestamp(value.activeUntil);
  const activeFromMs = activeFrom ? Date.parse(activeFrom) : Number.NaN;
  const activeUntilMs = activeUntil ? Date.parse(activeUntil) : Number.NaN;
  const validActiveUntil = !Number.isFinite(activeFromMs) || !Number.isFinite(activeUntilMs) || activeUntilMs > activeFromMs
    ? activeUntil
    : undefined;
  return {
    id,
    requestId,
    operationId,
    action,
    itemId,
    itemName,
    itemType,
    scopeLabel: sanitizeString(value.scopeLabel, MAX_NAME_LENGTH),
    principalId,
    tenantId,
    roleDefinitionId: sanitizeString(value.roleDefinitionId, MAX_ID_LENGTH),
    directoryScopeId: sanitizeString(value.directoryScopeId, MAX_SCOPE_LENGTH),
    groupId: sanitizeString(value.groupId, MAX_ID_LENGTH),
    accessId: value.accessId === "member" || value.accessId === "owner" ? value.accessId : undefined,
    azureScope: sanitizeString(value.azureScope, MAX_SCOPE_LENGTH),
    status,
    rawStatus: sanitizeString(value.rawStatus, 80),
    requestedAt,
    updatedAt,
    completedAt,
    activeUntil: validActiveUntil,
    activeFrom,
    durationHours: normalizeDuration(value.durationHours),
    justification: sanitizeString(value.justification, MAX_JUSTIFICATION_LENGTH),
    ticketSystem: sanitizeString(value.ticketSystem, MAX_TICKET_FIELD_LENGTH),
    ticketNumber: sanitizeString(value.ticketNumber, MAX_TICKET_FIELD_LENGTH),
    bundleName: sanitizeString(value.bundleName, MAX_BUNDLE_NAME_LENGTH),
    roleEligibilityScheduleId: sanitizeString(value.roleEligibilityScheduleId, MAX_SCOPE_LENGTH),
    activationRequirements: sanitizeActivationRequirements(value.activationRequirements),
    continuationOfRequestId: sanitizeString(value.continuationOfRequestId, MAX_ID_LENGTH),
    extensionAttemptState: value.extensionAttemptState === "submitting" || value.extensionAttemptState === "queued" || value.extensionAttemptState === "uncertain"
      ? value.extensionAttemptState
      : undefined,
    extensionRequestedAt,
    extensionRequestId: sanitizeString(value.extensionRequestId, MAX_ID_LENGTH),
    extensionLastError: typeof value.extensionLastError === "string"
      ? sanitizeErrorMessage(value.extensionLastError, MAX_ERROR_LENGTH) || undefined
      : undefined,
    approvalId: sanitizeString(value.approvalId, MAX_ID_LENGTH),
    targetScheduleId: sanitizeString(value.targetScheduleId, MAX_ID_LENGTH),
    activeAssignmentMissingSince,
    lastCheckedAt,
    nextCheckAt,
    checkCount: clampInteger(value.checkCount, 0, MAX_STORED_CHECK_COUNT, 0),
    lastError: typeof value.lastError === "string"
      ? sanitizeErrorMessage(value.lastError, MAX_ERROR_LENGTH) || undefined
      : undefined,
    notifiedStatus: isTrackedStatus(value.notifiedStatus) ? value.notifiedStatus : undefined,
    expiryReminderAttemptedAt,
    expiryReminderSentAt,
    notificationLastAttemptAt: sanitizeRequestMetadataTimestamp(value.notificationLastAttemptAt, requestedAtMs, now),
    notificationLastError: typeof value.notificationLastError === "string"
      ? sanitizeErrorMessage(value.notificationLastError, MAX_ERROR_LENGTH) || undefined
      : undefined,
    sourceInstallationId: sanitizeString(value.sourceInstallationId, 80),
    sourceDeviceName: sanitizeString(value.sourceDeviceName, 60)
  };
}

function trackedRequestMatchesActiveItem(request: TrackedPimRequest, item: ActivationItem): boolean {
  if (item.type !== request.itemType || item.status !== "active" || item.activeAssignmentType === "assigned") {
    return false;
  }
  if (!request.tenantId || !item.tenantId || normalizeIdentifier(request.tenantId) !== normalizeIdentifier(item.tenantId)) {
    return false;
  }
  if (!request.principalId || !item.principalId || normalizeIdentifier(request.principalId) !== normalizeIdentifier(item.principalId)) {
    return false;
  }
  if (item.type === "directoryRole") {
    return roleDefinitionIdsMatch(request.roleDefinitionId, item.roleDefinitionId)
      && normalizeResourcePath(request.directoryScopeId || "/") === normalizeResourcePath(item.directoryScopeId);
  }
  if (item.type === "pimGroup") {
    return normalizeIdentifier(request.groupId) === normalizeIdentifier(item.groupId)
      && request.accessId === item.accessId;
  }
  return roleDefinitionIdsMatch(request.roleDefinitionId, item.roleDefinitionId)
    && normalizeResourcePath(request.azureScope || "") === normalizeResourcePath(item.scope);
}

function roleDefinitionIdsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizeIdentifier(left);
  const normalizedRight = normalizeIdentifier(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.split("/").filter(Boolean).at(-1) === normalizedRight.split("/").filter(Boolean).at(-1);
}

function normalizeIdentifier(value: string | undefined): string {
  return value?.trim().toLowerCase() || "";
}

function normalizeResourcePath(value: string): string {
  const normalized = normalizeIdentifier(value);
  return /^\/+$/u.test(normalized) ? "/" : normalized.replace(/\/+$/u, "");
}

function sanitizeRequestMetadataTimestamp(value: unknown, requestedAtMs: number, now: number): string | undefined {
  const timestamp = sanitizeTimestamp(value);
  if (!timestamp) {
    return undefined;
  }
  const timestampMs = Date.parse(timestamp);
  return timestampMs >= requestedAtMs - MAX_REQUEST_METADATA_PRE_REQUEST_SKEW_MS
    && timestampMs <= now + MAX_FUTURE_CLOCK_SKEW_MS
    ? timestamp
    : undefined;
}

function getRequestPayloadDetails(
  payload: unknown,
  action: ActivityAction,
  requestedAt: string,
  durationHours: number | undefined,
  now: number,
  scheduledStartAt?: string
): {
  status: TrackedPimRequestStatus;
  rawStatus?: string;
  completedAt?: string;
  activeUntil?: string;
  activeFrom?: string;
  hasActiveUntil: boolean;
  hasActiveFrom: boolean;
  approvalId?: string;
  targetScheduleId?: string;
} {
  const root = isRecord(payload) ? payload : {};
  const properties = isRecord(root.properties) ? root.properties : {};
  const scheduleInfo = isRecord(root.scheduleInfo)
    ? root.scheduleInfo
    : isRecord(properties.scheduleInfo)
      ? properties.scheduleInfo
      : {};
  const expiration = isRecord(scheduleInfo.expiration) ? scheduleInfo.expiration : {};
  const rawStatus = stringValue(root.status) || stringValue(properties.status);
  const explicitStart = firstTimestamp(
    scheduleInfo.startDateTime,
    root.startDateTime,
    properties.startDateTime,
    scheduledStartAt
  );
  const effectiveStart = explicitStart || requestedAt;
  const explicitEnd = firstTimestamp(
    root.endDateTime,
    properties.endDateTime,
    expiration.endDateTime
  );
  const explicitOrServerDurationEnd = firstTimestamp(
    root.endDateTime,
    properties.endDateTime,
    expiration.endDateTime
  ) || getDurationEndDate(effectiveStart, stringValue(expiration.duration));
  const scheduledStartMs = scheduledStartAt ? Date.parse(scheduledStartAt) : Number.NaN;
  const requestedAtMs = Date.parse(requestedAt);
  const plannedContinuationEnd = Number.isFinite(scheduledStartMs)
    && Number.isFinite(requestedAtMs)
    && scheduledStartMs > requestedAtMs + 500
    && normalizeDuration(durationHours)
      ? new Date(scheduledStartMs + Number(durationHours) * 60 * 60_000).toISOString()
      : undefined;
  const activeUntil = explicitOrServerDurationEnd || plannedContinuationEnd;
  return {
    status: normalizeTrackedRequestStatus(rawStatus, action, activeUntil, now, effectiveStart),
    rawStatus,
    completedAt: firstTimestamp(root.completedDateTime, properties.completedDateTime, properties.updatedOn),
    activeUntil,
    activeFrom: explicitStart,
    hasActiveUntil: explicitEnd !== undefined || Object.prototype.hasOwnProperty.call(expiration, "duration"),
    hasActiveFrom: explicitStart !== undefined,
    approvalId: sanitizeString(root.approvalId || properties.approvalId, MAX_ID_LENGTH),
    targetScheduleId: sanitizeString(
      root.targetScheduleId
        || root.roleAssignmentScheduleId
        || properties.targetRoleAssignmentScheduleId
        || properties.targetRoleAssignmentScheduleInstanceId,
      MAX_ID_LENGTH
    )
  };
}

function getDurationEndDate(requestedAt: string, isoDuration: string | undefined): string | undefined {
  const start = Date.parse(requestedAt);
  const durationMs = isoDuration ? parseIsoDurationMs(isoDuration) : 0;
  if (!Number.isFinite(start) || !durationMs) {
    return undefined;
  }
  return new Date(start + durationMs).toISOString();
}

function getRequestPollDelayMs(checkCount: number): number {
  return POLL_DELAYS_MS[Math.min(Math.max(0, checkCount), POLL_DELAYS_MS.length - 1)];
}

function getTrackedRequestUrgency(request: TrackedPimRequest, now: number): number {
  const nextCheckAt = request.nextCheckAt ? Date.parse(request.nextCheckAt) : now;
  return Number.isFinite(nextCheckAt) ? nextCheckAt : now;
}

function getTrackedRetentionRank(request: TrackedPimRequest, now: number): number {
  const status = getEffectiveTrackedRequestStatus(request, now);
  if (isTrackedRequestPendingStatus(status) || status === "scheduled") return 0;
  if (status === "active") return 1;
  if (status === "statusUnavailable" || status === "unknown") return 2;
  return 3;
}

function compareTrackedRequestVersion(left: TrackedPimRequest, right: TrackedPimRequest): number {
  const updated = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  if (updated) return updated;
  const statusRank: Record<TrackedPimRequestStatus, number> = {
    submitted: 0,
    pendingApproval: 1,
    provisioning: 2,
    scheduled: 3,
    active: 4,
    unknown: 5,
    statusUnavailable: 6,
    completed: 7,
    denied: 8,
    failed: 9,
    canceled: 10,
    expired: 11
  };
  const status = statusRank[getEffectiveTrackedRequestStatus(left)] - statusRank[getEffectiveTrackedRequestStatus(right)];
  if (status) return status;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function shouldContinueTracking(status: TrackedPimRequestStatus, activeUntil?: string): boolean {
  return isTrackedRequestPendingStatus(status)
    || status === "scheduled"
    || (status === "active" && !activeUntil);
}

function buildTrackedRequestId(
  itemType: ActivationItem["type"],
  requestId: string,
  tenantId?: string
): string {
  const tenant = tenantId?.trim().toLowerCase() || "unscoped";
  return `tenant:${tenant}:${itemType}:${stableTextHash(requestId)}`;
}

function stableTextHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeReminderMinutes(value: number): number {
  return [5, 15, 30, 60].includes(value) ? value : DEFAULT_EXPIRY_REMINDER_MINUTES;
}

function normalizeDuration(value: unknown): number | undefined {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0.5 && duration <= 24 ? duration : undefined;
}

function sanitizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function firstTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    const timestamp = sanitizeTimestamp(value);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function sanitizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function sanitizeOperationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function sanitizeActivationRequirements(value: unknown): ActivationItem["activationRequirements"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const maxDurationHours = normalizeDuration(value.maxDurationHours);
  const requirements: NonNullable<ActivationItem["activationRequirements"]> = {
    ...(typeof value.justification === "boolean" ? { justification: value.justification } : {}),
    ...(typeof value.ticket === "boolean" ? { ticket: value.ticket } : {}),
    ...(typeof value.approval === "boolean" ? { approval: value.approval } : {}),
    ...(maxDurationHours ? { maxDurationHours } : {})
  };
  return Object.keys(requirements).length ? requirements : undefined;
}

function isTrackedStatus(value: unknown): value is TrackedPimRequestStatus {
  return value === "submitted"
    || value === "pendingApproval"
    || value === "provisioning"
    || value === "scheduled"
    || value === "active"
    || value === "completed"
    || value === "denied"
    || value === "failed"
    || value === "canceled"
    || value === "expired"
    || value === "unknown"
    || value === "statusUnavailable";
}

function requestUnknownStatusLabel(status: TrackedPimRequestStatus): string {
  void status;
  return "Unknown Microsoft status";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
