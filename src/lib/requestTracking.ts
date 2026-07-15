import { parseIsoDurationMs } from "./pim";
import { sanitizeErrorMessage, validateCapturedToken } from "./security";
import type {
  ActivationItem,
  ActivityAction,
  TrackedPimRequest,
  TrackedPimRequestStatus,
  TrackedPimRequestStore
} from "./types";

export const REQUEST_TRACKING_KEY = "quickPimRequests.v1";
export const REQUEST_TRACKING_ALARM_NAME = "quickPimRequestTracking";
export const REQUEST_TRACKING_TTL_MS = 24 * 60 * 60 * 1000;
export const REQUEST_TRACKING_MAX_DUE_PER_RUN = 20;
export const REQUEST_TRACKING_AZURE_CONCURRENCY = 3;
export const REQUEST_TRACKING_GRAPH_CONCURRENCY = 3;
export const DEFAULT_EXPIRY_REMINDER_MINUTES = 15;

const MAX_TRACKED_REQUESTS = 100;
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 160;
const MAX_SCOPE_LENGTH = 512;
const MAX_JUSTIFICATION_LENGTH = 1024;
const MAX_ERROR_LENGTH = 260;
const MAX_BUNDLE_NAME_LENGTH = 80;
const MAX_CHECK_COUNT = 30;
const ACCESS_RETRY_DELAY_MS = 10 * 60 * 1000;
const POLL_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;
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
  payload?: unknown;
  requestedAt: string;
  durationHours?: number;
  justification?: string;
  bundleName?: string;
  tenantId?: string;
  now?: number;
}

let requestStoreMutationQueue: Promise<void> = Promise.resolve();

export async function loadTrackedRequests(storage: StorageAreaLike = chrome.storage.local): Promise<TrackedPimRequestStore> {
  const result = await storage.get(REQUEST_TRACKING_KEY);
  return sanitizeTrackedRequestStore(result[REQUEST_TRACKING_KEY]);
}

export async function saveTrackedRequests(
  store: TrackedPimRequestStore,
  storage: StorageAreaLike = chrome.storage.local
): Promise<TrackedPimRequestStore> {
  const sanitized = sanitizeTrackedRequestStore(store);
  await storage.set({ [REQUEST_TRACKING_KEY]: sanitized });
  return sanitized;
}

export async function mutateTrackedRequests(
  mutator: (current: TrackedPimRequestStore) => TrackedPimRequestStore,
  storage: StorageAreaLike = chrome.storage.local
): Promise<TrackedPimRequestStore> {
  let result = EMPTY_REQUEST_STORE;
  const mutation = requestStoreMutationQueue.then(async () => {
    const current = await loadTrackedRequests(storage);
    result = await saveTrackedRequests(mutator(current), storage);
  });
  requestStoreMutationQueue = mutation.catch(() => undefined);
  await mutation;
  return result;
}

export async function clearTrackedRequests(storage: StorageAreaLike = chrome.storage.local): Promise<void> {
  const mutation = requestStoreMutationQueue.then(() => storage.remove(REQUEST_TRACKING_KEY));
  requestStoreMutationQueue = mutation.catch(() => undefined);
  await mutation;
}

export function createTrackedPimRequest(input: CreateTrackedRequestInput): TrackedPimRequest | undefined {
  const requestId = sanitizeString(input.requestId, MAX_ID_LENGTH);
  const requestedAt = sanitizeTimestamp(input.requestedAt);
  if (!requestId || !requestedAt) {
    return undefined;
  }

  const now = input.now ?? Date.now();
  const details = getRequestPayloadDetails(input.payload, input.action, requestedAt, input.durationHours, now);
  const base: TrackedPimRequest = {
    id: `${input.item.type}:${requestId}`,
    requestId,
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
    durationHours: normalizeDuration(input.durationHours),
    justification: input.justification,
    bundleName: input.bundleName,
    approvalId: details.approvalId,
    targetScheduleId: details.targetScheduleId,
    checkCount: 0,
    nextCheckAt: isTrackedRequestPendingStatus(details.status)
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
  }

  return sanitizeTrackedRequest(base);
}

export function upsertTrackedRequests(
  store: TrackedPimRequestStore,
  requests: TrackedPimRequest[]
): TrackedPimRequestStore {
  const byId = new Map(store.requests.map((request) => [request.id, request]));
  for (const request of requests) {
    const current = byId.get(request.id);
    byId.set(request.id, sanitizeTrackedRequest({ ...current, ...request }) || request);
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
  const details = getRequestPayloadDetails(payload, request.action, request.requestedAt, request.durationHours, now);
  const checkCount = request.checkCount + 1;
  const status = details.status;
  const canContinue = isTrackedRequestPendingStatus(status)
    && checkCount < MAX_CHECK_COUNT
    && now - Date.parse(request.requestedAt) < REQUEST_TRACKING_TTL_MS;
  return sanitizeTrackedRequest({
    ...request,
    status: canContinue || !isTrackedRequestPendingStatus(status) ? status : "statusUnavailable",
    rawStatus: details.rawStatus || request.rawStatus,
    updatedAt: new Date(now).toISOString(),
    completedAt: details.completedAt || request.completedAt,
    activeUntil: details.activeUntil || request.activeUntil,
    approvalId: details.approvalId || request.approvalId,
    targetScheduleId: details.targetScheduleId || request.targetScheduleId,
    lastCheckedAt: new Date(now).toISOString(),
    nextCheckAt: canContinue ? new Date(now + getRequestPollDelayMs(checkCount)).toISOString() : undefined,
    checkCount,
    lastError: undefined
  }) || request;
}

export function markTrackedRequestCheckFailure(
  request: TrackedPimRequest,
  error: unknown,
  now = Date.now(),
  options: { waitingForAccess?: boolean } = {}
): TrackedPimRequest {
  const checkCount = options.waitingForAccess ? request.checkCount : request.checkCount + 1;
  const trackingExpired = now - Date.parse(request.requestedAt) >= REQUEST_TRACKING_TTL_MS || checkCount >= MAX_CHECK_COUNT;
  const nextDelay = options.waitingForAccess ? ACCESS_RETRY_DELAY_MS : getRequestPollDelayMs(checkCount);
  return sanitizeTrackedRequest({
    ...request,
    status: trackingExpired ? "statusUnavailable" : request.status,
    updatedAt: new Date(now).toISOString(),
    lastCheckedAt: options.waitingForAccess ? request.lastCheckedAt : new Date(now).toISOString(),
    nextCheckAt: trackingExpired ? undefined : new Date(now + nextDelay).toISOString(),
    checkCount,
    lastError: sanitizeErrorMessage(error)
  }) || request;
}

export function getDueTrackedRequests(
  store: TrackedPimRequestStore,
  now = Date.now(),
  requestIds?: string[]
): TrackedPimRequest[] {
  const requestedIds = requestIds?.length ? new Set(requestIds) : undefined;
  return store.requests
    .filter((request) => {
      if (requestedIds && !requestedIds.has(request.id) && !requestedIds.has(request.requestId)) {
        return false;
      }
      if (requestedIds) {
        return request.status !== "expired";
      }
      return isTrackedRequestPending(request) && (!request.nextCheckAt || Date.parse(request.nextCheckAt) <= now);
    })
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
    if (
      options.notificationsEnabled
      && getEffectiveTrackedRequestStatus(request, now) === "active"
      && request.activeUntil
      && !request.expiryReminderSentAt
    ) {
      const activeUntil = Date.parse(request.activeUntil);
      if (Number.isFinite(activeUntil) && activeUntil > now) {
        candidates.push(activeUntil - normalizeReminderMinutes(options.expiryReminderMinutes) * 60_000);
      }
    }
  }
  if (!candidates.length) {
    return undefined;
  }
  return Math.max(now + 1_000, Math.min(...candidates));
}

export function getPendingTrackedRequestCount(store: TrackedPimRequestStore): number {
  return store.requests.filter(isTrackedRequestPending).length;
}

export function trackedRequestMatchesTokenIdentity(
  request: TrackedPimRequest,
  identity: { tenantId?: string; principalId?: string }
): boolean {
  if (!identity.principalId || request.principalId.toLowerCase() !== identity.principalId.toLowerCase()) {
    return false;
  }
  if (!request.tenantId) {
    return true;
  }
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
  return isTrackedRequestPendingStatus(getEffectiveTrackedRequestStatus(request));
}

export function isTrackedRequestPendingStatus(status: TrackedPimRequestStatus): boolean {
  return status === "submitted" || status === "pendingApproval" || status === "provisioning";
}

export function getEffectiveTrackedRequestStatus(
  request: TrackedPimRequest,
  now = Date.now()
): TrackedPimRequestStatus {
  if (request.status !== "active" || !request.activeUntil) {
    return request.status;
  }
  const activeUntil = Date.parse(request.activeUntil);
  return Number.isFinite(activeUntil) && activeUntil <= now ? "expired" : request.status;
}

export function trackedRequestStatusLabel(status: TrackedPimRequestStatus): string {
  switch (status) {
    case "pendingApproval": return "Pending approval";
    case "provisioning": return "Provisioning";
    case "active": return "Active";
    case "completed": return "Completed";
    case "denied": return "Denied";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    case "expired": return "Expired";
    case "statusUnavailable": return "Status unavailable";
    default: return "Submitted";
  }
}

export function normalizeTrackedRequestStatus(
  rawStatus: string | undefined,
  action: ActivityAction,
  activeUntil?: string,
  now = Date.now()
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
    status = "submitted";
  }

  if (status === "active" && activeUntil && Date.parse(activeUntil) <= now) {
    return "expired";
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

export function sanitizeTrackedRequestStore(value: unknown): TrackedPimRequestStore {
  if (!isRecord(value) || !Array.isArray(value.requests)) {
    return EMPTY_REQUEST_STORE;
  }
  const seen = new Set<string>();
  const requests: TrackedPimRequest[] = [];
  for (const valueRequest of value.requests) {
    const request = sanitizeTrackedRequest(valueRequest);
    if (!request || seen.has(request.id)) continue;
    seen.add(request.id);
    requests.push(request);
    if (requests.length >= MAX_TRACKED_REQUESTS) break;
  }
  requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return { version: 1, requests };
}

function sanitizeTrackedRequest(value: unknown): TrackedPimRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requestId = sanitizeString(value.requestId, MAX_ID_LENGTH);
  const itemId = sanitizeString(value.itemId, MAX_ID_LENGTH);
  const itemName = sanitizeString(value.itemName, MAX_NAME_LENGTH);
  const principalId = sanitizeString(value.principalId, MAX_ID_LENGTH);
  const requestedAt = sanitizeTimestamp(value.requestedAt);
  const updatedAt = sanitizeTimestamp(value.updatedAt);
  const action = value.action === "activate" || value.action === "deactivate" ? value.action : undefined;
  const itemType = value.itemType === "directoryRole" || value.itemType === "pimGroup" || value.itemType === "azureRole"
    ? value.itemType
    : undefined;
  const status = isTrackedStatus(value.status) ? value.status : undefined;
  if (!requestId || !itemId || !itemName || !principalId || !requestedAt || !updatedAt || !action || !itemType || !status) {
    return undefined;
  }

  const id = sanitizeString(value.id, MAX_ID_LENGTH) || `${itemType}:${requestId}`;
  return {
    id,
    requestId,
    action,
    itemId,
    itemName,
    itemType,
    scopeLabel: sanitizeString(value.scopeLabel, MAX_NAME_LENGTH),
    principalId,
    tenantId: sanitizeString(value.tenantId, MAX_ID_LENGTH),
    roleDefinitionId: sanitizeString(value.roleDefinitionId, MAX_ID_LENGTH),
    directoryScopeId: sanitizeString(value.directoryScopeId, MAX_SCOPE_LENGTH),
    groupId: sanitizeString(value.groupId, MAX_ID_LENGTH),
    accessId: value.accessId === "member" || value.accessId === "owner" ? value.accessId : undefined,
    azureScope: sanitizeString(value.azureScope, MAX_SCOPE_LENGTH),
    status,
    rawStatus: sanitizeString(value.rawStatus, 80),
    requestedAt,
    updatedAt,
    completedAt: sanitizeTimestamp(value.completedAt),
    activeUntil: sanitizeTimestamp(value.activeUntil),
    durationHours: normalizeDuration(value.durationHours),
    justification: sanitizeString(value.justification, MAX_JUSTIFICATION_LENGTH),
    bundleName: sanitizeString(value.bundleName, MAX_BUNDLE_NAME_LENGTH),
    approvalId: sanitizeString(value.approvalId, MAX_ID_LENGTH),
    targetScheduleId: sanitizeString(value.targetScheduleId, MAX_ID_LENGTH),
    lastCheckedAt: sanitizeTimestamp(value.lastCheckedAt),
    nextCheckAt: sanitizeTimestamp(value.nextCheckAt),
    checkCount: clampInteger(value.checkCount, 0, MAX_CHECK_COUNT, 0),
    lastError: typeof value.lastError === "string"
      ? sanitizeErrorMessage(value.lastError, MAX_ERROR_LENGTH) || undefined
      : undefined,
    notifiedStatus: isTrackedStatus(value.notifiedStatus) ? value.notifiedStatus : undefined,
    expiryReminderSentAt: sanitizeTimestamp(value.expiryReminderSentAt)
  };
}

function getRequestPayloadDetails(
  payload: unknown,
  action: ActivityAction,
  requestedAt: string,
  durationHours: number | undefined,
  now: number
): {
  status: TrackedPimRequestStatus;
  rawStatus?: string;
  completedAt?: string;
  activeUntil?: string;
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
  const effectiveStart = firstTimestamp(
    scheduleInfo.startDateTime,
    root.startDateTime,
    properties.startDateTime
  ) || requestedAt;
  const activeUntil = firstTimestamp(
    root.endDateTime,
    properties.endDateTime,
    expiration.endDateTime
  ) || getDurationEndDate(effectiveStart, stringValue(expiration.duration), durationHours);
  return {
    status: normalizeTrackedRequestStatus(rawStatus, action, activeUntil, now),
    rawStatus,
    completedAt: firstTimestamp(root.completedDateTime, properties.completedDateTime, properties.updatedOn),
    activeUntil,
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

function getDurationEndDate(requestedAt: string, isoDuration: string | undefined, durationHours: number | undefined): string | undefined {
  const start = Date.parse(requestedAt);
  const durationMs = isoDuration ? parseIsoDurationMs(isoDuration) : normalizeDuration(durationHours) ? Number(durationHours) * 60 * 60 * 1000 : 0;
  if (!Number.isFinite(start) || !durationMs) {
    return undefined;
  }
  return new Date(start + durationMs).toISOString();
}

function getRequestPollDelayMs(checkCount: number): number {
  return POLL_DELAYS_MS[Math.min(Math.max(0, checkCount), POLL_DELAYS_MS.length - 1)];
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

function isTrackedStatus(value: unknown): value is TrackedPimRequestStatus {
  return value === "submitted"
    || value === "pendingApproval"
    || value === "provisioning"
    || value === "active"
    || value === "completed"
    || value === "denied"
    || value === "failed"
    || value === "canceled"
    || value === "expired"
    || value === "statusUnavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
