import type {
  AccessSetupTarget,
  ActivationItem,
  ActivationItemType,
  ActivationResult,
  ActivationResponse,
  RequestOperationAction,
  RequestOperationItemRecord,
  RequestOperationItemState,
  RequestOperationRecord,
  RequestOperationState,
  TrackedPimRequest,
  TrackedPimRequestStatus
} from "./types";
import { createStorageMutationLock } from "./storageMutation";
import { normalizeActivationItemId } from "./activationIdentity";
import { sanitizeTrackedRequestStore } from "./requestTracking";

export const REQUEST_OPERATIONS_LOCAL_KEY = "quickPimRequestOperations.v2";
// Compatibility export for callers that used the old constant name.
export const REQUEST_OPERATIONS_SESSION_KEY = REQUEST_OPERATIONS_LOCAL_KEY;
export const LEGACY_REQUEST_OPERATIONS_SESSION_KEY = "quickPimRequestOperations.v1";
export const REQUEST_OPERATION_TTL_MS = 30 * 24 * 60 * 60_000;
export const REQUEST_OPERATION_RECONCILIATION_GRACE_MS = 2 * 60_000;
export const REQUEST_OPERATION_MAX_NONTERMINAL_AGE_MS = 7 * 24 * 60 * 60_000;

const MAX_TERMINAL_OPERATIONS = 100;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
const withRequestOperationMutationLock = createStorageMutationLock("quickPimRequestOperationMutation");

export type RequestOperationIdentity = Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets"> &
  Partial<Pick<RequestOperationRecord, "tenantId" | "principalId" | "durationHours" | "justification" | "ticketInfo" | "bundleName" | "sourceInstallationId">>;

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface LoadRequestOperationOptions {
  storage?: StorageAreaLike;
  legacyStorage?: StorageAreaLike;
  now?: number;
}

export async function loadRequestOperations(
  options: LoadRequestOperationOptions = {}
): Promise<RequestOperationRecord[]> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  const result = await storage.get(REQUEST_OPERATIONS_LOCAL_KEY);
  const storedValue = result[REQUEST_OPERATIONS_LOCAL_KEY];
  let operations = sanitizeRequestOperations(storedValue, now);

  if (!options.storage) {
    const legacyStorage = options.legacyStorage || chrome.storage.session;
    const [legacySession, legacyLocal] = await Promise.all([
      readStorageValue(legacyStorage, LEGACY_REQUEST_OPERATIONS_SESSION_KEY),
      readStorageValue(storage, LEGACY_REQUEST_OPERATIONS_SESSION_KEY)
    ]);
    const migrated = sanitizeRequestOperations([
      ...operations,
      ...sanitizeRequestOperations(legacySession, now),
      ...sanitizeRequestOperations(legacyLocal, now)
    ], now);
    if (JSON.stringify(migrated) !== JSON.stringify(operations) || legacySession !== undefined || legacyLocal !== undefined) {
      operations = await mutateOperations(storage, now, (current) => mergeOperations(current, migrated));
      await Promise.all([
        legacyStorage.remove(LEGACY_REQUEST_OPERATIONS_SESSION_KEY).catch(() => undefined),
        storage.remove(LEGACY_REQUEST_OPERATIONS_SESSION_KEY).catch(() => undefined)
      ]);
    }
  }

  if (Array.isArray(storedValue) && JSON.stringify(operations) !== JSON.stringify(storedValue)) {
    return mutateOperations(storage, now, (current) => current);
  }
  return operations;
}

export async function beginRequestOperation(
  operation: Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets" | "startedAt"> &
    Partial<Pick<RequestOperationRecord, "tenantId" | "principalId" | "items" | "durationHours" | "justification" | "ticketInfo" | "bundleName" | "sourceInstallationId" | "sourceDeviceName">>,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<boolean> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  const items = operation.items?.length
    ? operation.items
    : operation.itemIds.flatMap((itemId) => createPreparedOperationItem(itemId, now, operation.tenantId, operation.principalId) || []);
  if (items.length !== new Set(operation.itemIds.map(normalizeActivationItemId)).size) {
    throw new Error("Request operation items are incomplete or ambiguous.");
  }
  let claimed = false;
  await mutateOperations(storage, now, (current) => {
    const existing = current.find((item) => item.id === operation.id);
    if (existing) {
      if (getRequestOperationFingerprint(existing) !== getRequestOperationFingerprint(operation)) {
        throw new Error("This request operation ID was already used for different role work.");
      }
      return current;
    }

    const normalizedItemIds = new Set(operation.itemIds.map(normalizeActivationItemId));
    const conflicting = current.find((candidate) =>
      (candidate.state === "running" || candidate.state === "uncertain")
      && tenantBoundariesMatch(candidate.tenantId, operation.tenantId)
      && tenantBoundariesMatch(candidate.principalId, operation.principalId)
      && candidate.itemIds.some((itemId) => normalizedItemIds.has(normalizeActivationItemId(itemId)))
    );
    if (conflicting) {
      throw new Error("A QuickPIM++ request for one or more selected items is already in progress.");
    }

    claimed = true;
    return [
      {
        ...operation,
        items,
        state: "running",
        updatedAt: now,
        revision: 1
      },
      ...current
    ];
  });
  return claimed;
}

export function createRequestOperationItems(items: ActivationItem[], now = Date.now()): RequestOperationItemRecord[] {
  const unique = new Map<string, RequestOperationItemRecord>();
  for (const item of items) {
    const itemId = normalizeActivationItemId(item.id);
    if (unique.has(itemId)) continue;
    unique.set(itemId, {
      itemId,
      itemName: item.displayName,
      itemType: item.type,
      ...(item.tenantId ? { tenantId: item.tenantId } : {}),
      ...(item.principalId ? { principalId: item.principalId } : {}),
      ...(item.scopeLabel ? { scopeLabel: item.scopeLabel } : {}),
      state: "prepared",
      updatedAt: now
    });
  }
  return [...unique.values()];
}

export function getRequestOperationFingerprint(operation: RequestOperationIdentity): string {
  const ticketSystem = normalizeFingerprintText(operation.ticketInfo?.ticketSystem) || null;
  const ticketNumber = normalizeFingerprintText(operation.ticketInfo?.ticketNumber) || null;
  return JSON.stringify({
    action: operation.action,
    tenantId: normalizeOptionalText(operation.tenantId).toLowerCase() || null,
    principalId: normalizeOptionalText(operation.principalId).toLowerCase() || null,
    sourceInstallationId: normalizeOptionalText(operation.sourceInstallationId).toLowerCase() || null,
    itemIds: [...new Set(operation.itemIds.map(normalizeActivationItemId))].sort(),
    targets: [...new Set(operation.targets)].sort(),
    durationHours: operation.durationHours ?? null,
    justification: normalizeFingerprintText(operation.justification) || null,
    ticketInfo: ticketSystem || ticketNumber ? { ticketSystem, ticketNumber } : null,
    bundleName: normalizeFingerprintText(operation.bundleName) || null
  });
}

export function trackedRequestMatchesOperation(
  request: TrackedPimRequest,
  operation: RequestOperationRecord
): boolean {
  if (
    request.action !== operation.action
    || !operation.itemIds.map(normalizeActivationItemId).includes(normalizeActivationItemId(request.itemId))
    || !tenantBoundariesMatch(request.tenantId, operation.tenantId)
    || !tenantBoundariesMatch(request.principalId, operation.principalId)
  ) {
    return false;
  }

  if (request.operationId) {
    return request.operationId === operation.id;
  }

  // Tenantless legacy records are deliberately left unresolved. Guessing can
  // reconcile a request from another tenant that happens to reuse the same IDs.
  if (!request.tenantId || !operation.tenantId) return false;
  const requestedAt = Date.parse(request.requestedAt);
  const earliestMatch = operation.startedAt - 30_000;
  const latestMatch = operation.updatedAt + REQUEST_OPERATION_RECONCILIATION_GRACE_MS;
  return Number.isFinite(requestedAt)
    && requestedAt >= earliestMatch
    && requestedAt <= latestMatch
    && request.durationHours === operation.durationHours
    && normalizeOptionalText(request.justification) === normalizeOptionalText(operation.justification)
    && normalizeOptionalText(request.ticketSystem) === normalizeOptionalText(operation.ticketInfo?.ticketSystem)
    && normalizeOptionalText(request.ticketNumber) === normalizeOptionalText(operation.ticketInfo?.ticketNumber)
    && normalizeOptionalText(request.bundleName) === normalizeOptionalText(operation.bundleName)
    && tenantBoundariesMatch(request.sourceInstallationId, operation.sourceInstallationId);
}

export async function updateRequestOperationItem(
  operationId: string,
  itemId: string,
  update: Partial<Omit<RequestOperationItemRecord, "itemId" | "updatedAt">> & { state: RequestOperationItemState },
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  const normalizedItemId = normalizeActivationItemId(itemId);
  let operationFound = false;
  let itemFound = false;
  await mutateOperations(storage, now, (current) => current.map((operation) => {
    if (operation.id !== operationId || (operation.state !== "running" && operation.state !== "uncertain")) return operation;
    operationFound = true;
    const existingItems = operation.items?.length
      ? operation.items
      : operation.itemIds.flatMap((candidate) => createPreparedOperationItem(candidate, operation.startedAt, operation.tenantId, operation.principalId) || []);
    const items = existingItems.map((item) => {
      if (normalizeActivationItemId(item.itemId) !== normalizedItemId) return item;
      itemFound = true;
      return { ...item, ...update, updatedAt: now };
    });
    return {
      ...operation,
      items,
      state: items.some((item) => item.state === "uncertain") ? "uncertain" : "running",
      updatedAt: now,
      revision: (operation.revision || 0) + 1
    };
  }));
  if (!operationFound) throw new Error("Request operation is not available for an item update.");
  if (!itemFound) throw new Error("Request operation item was not found.");
}

export async function completeRequestOperation(
  id: string,
  response: ActivationResponse,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  await mutateOperations(storage, now, (current) => current.map((operation) => {
    if (operation.id !== id) return operation;
    const resultsById = new Map<string, ActivationResult[]>();
    for (const result of response.results) {
      const itemId = normalizeActivationItemId(result.itemId);
      resultsById.set(itemId, [...(resultsById.get(itemId) || []), result]);
    }
    const items = (operation.items?.length
      ? operation.items
      : operation.itemIds.flatMap((itemId) => createPreparedOperationItem(itemId, operation.startedAt, operation.tenantId, operation.principalId) || []))
      .map((item) => {
        const matches = resultsById.get(normalizeActivationItemId(item.itemId)) || [];
        const result = matches[0];
        if (!result || matches.length !== 1) {
          const error = !result
            ? "The background response omitted this requested item. Check Microsoft PIM before retrying."
            : "The background response contained duplicate results for this item. Check Microsoft PIM before retrying.";
          return {
            ...item,
            state: "uncertain" as const,
            updatedAt: now,
            error,
            result: {
              itemId: item.itemId,
              itemName: item.itemName,
              success: false,
              error,
              outcomeUnknown: true
            }
          };
        }
        const trackingPending = result.success && result.trackingUnavailable && Boolean(item.pendingTrackedRequest);
        return {
          ...item,
          state: result.outcomeUnknown
            ? "uncertain" as const
            : trackingPending
              ? "accepted" as const
              : "terminal" as const,
          updatedAt: now,
          result,
          ...(result.requestId ? { requestId: result.requestId } : {}),
          ...(result.error ? { error: result.error } : {})
        };
      });
    const uncertain = items.some((item) => item.state === "uncertain");
    const followUpPending = items.some((item) => item.state === "accepted");
    return {
      ...operation,
      items,
      state: uncertain ? "uncertain" : followUpPending ? "running" : "complete",
      response,
      updatedAt: now,
      revision: (operation.revision || 0) + 1,
      ...(uncertain || followUpPending ? {} : { terminalAt: now })
    };
  }));
}

export async function failRequestOperation(
  id: string,
  error: string,
  options: { storage?: StorageAreaLike; now?: number; uncertain?: boolean } = {}
): Promise<void> {
  const state = options.uncertain ? "uncertain" : "error";
  await updateRequestOperation(id, { state, error: error.slice(0, 1_000) }, options);
}

export async function touchRequestOperation(
  id: string,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  await mutateOperations(storage, now, (current) => current.map((item) =>
    item.id === id && (item.state === "running" || item.state === "uncertain")
      ? { ...item, updatedAt: now, revision: (item.revision || 0) + 1 }
      : item));
}

export async function dismissRequestOperations(
  ids: string[],
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  const idSet = new Set(ids);
  await mutateOperations(storage, now, (current) => current.filter((item) => !idSet.has(item.id)));
}

export function sanitizeRequestOperations(value: unknown, now = Date.now()): RequestOperationRecord[] {
  if (!Array.isArray(value)) return [];
  const sanitized = value
    .flatMap((item) => sanitizeRequestOperation(item, now) || [])
    .sort((left, right) => right.startedAt - left.startedAt);
  const nonterminal = sanitized.filter((item) => item.state === "running" || item.state === "uncertain");
  const terminal = sanitized
    .filter((item) => item.state === "complete" || item.state === "error")
    .slice(0, MAX_TERMINAL_OPERATIONS);
  return [...nonterminal, ...terminal].sort((left, right) => right.startedAt - left.startedAt);
}

export function selectNextRequestOperation(
  operations: RequestOperationRecord[],
  excludedIds: ReadonlySet<string> = new Set()
): RequestOperationRecord | undefined {
  const available = operations.filter((operation) => !excludedIds.has(operation.id));
  const terminal = available
    .filter((operation) => operation.state === "complete" || operation.state === "error")
    .sort(compareOperationAge)[0];
  if (terminal) return terminal;
  return available
    .filter((operation) => operation.state === "running" || operation.state === "uncertain")
    .sort(compareOperationAge)[0];
}

async function updateRequestOperation(
  id: string,
  update: Pick<RequestOperationRecord, "state"> & Partial<Pick<RequestOperationRecord, "response" | "error">>,
  options: { storage?: StorageAreaLike; now?: number }
): Promise<void> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now ?? Date.now();
  await mutateOperations(storage, now, (current) => current.map((item) => item.id === id
      ? {
        ...item,
        ...update,
        updatedAt: now,
        revision: (item.revision || 0) + 1,
        ...((update.state === "complete" || update.state === "error") ? { terminalAt: now } : {})
      }
    : item));
}

async function mutateOperations(
  storage: StorageAreaLike,
  now: number,
  mutation: (current: RequestOperationRecord[]) => RequestOperationRecord[]
): Promise<RequestOperationRecord[]> {
  return withRequestOperationMutationLock(async () => {
    const result = await storage.get(REQUEST_OPERATIONS_LOCAL_KEY);
    const current = sanitizeRequestOperations(result[REQUEST_OPERATIONS_LOCAL_KEY], now);
    const next = sanitizeRequestOperations(mutation(current), now);
    await saveOperations(storage, next);
    return next;
  });
}

async function saveOperations(storage: StorageAreaLike, operations: RequestOperationRecord[]): Promise<void> {
  if (operations.length) {
    await storage.set({ [REQUEST_OPERATIONS_LOCAL_KEY]: operations });
  } else {
    await storage.remove(REQUEST_OPERATIONS_LOCAL_KEY);
  }
}

function sanitizeRequestOperation(value: unknown, now: number): RequestOperationRecord | undefined {
  if (!isRecord(value) || !isOperationId(value.id) || (value.action !== "activate" && value.action !== "deactivate")) {
    return undefined;
  }
  if (value.state !== "running" && value.state !== "complete" && value.state !== "error" && value.state !== "uncertain") {
    return undefined;
  }
  const startedAt = sanitizeEpochMilliseconds(value.startedAt);
  const updatedAt = sanitizeEpochMilliseconds(value.updatedAt);
  if (startedAt === undefined || updatedAt === undefined) return undefined;
  const terminalAt = sanitizeEpochMilliseconds(value.terminalAt);
  const nextActionAt = sanitizeEpochMilliseconds(value.nextActionAt);
  const retentionAnchor = Math.max(terminalAt || 0, nextActionAt || 0, updatedAt);
  const terminal = value.state === "complete" || value.state === "error";
  if (
    (terminal && now - retentionAnchor > REQUEST_OPERATION_TTL_MS)
    || updatedAt > now + MAX_FUTURE_CLOCK_SKEW_MS
    || startedAt > now + MAX_FUTURE_CLOCK_SKEW_MS
    || updatedAt < startedAt
    || (!terminal && now - updatedAt > REQUEST_OPERATION_MAX_NONTERMINAL_AGE_MS)
    || (terminalAt !== undefined && (terminalAt < startedAt || terminalAt > now + MAX_FUTURE_CLOCK_SKEW_MS))
    || (nextActionAt !== undefined && (nextActionAt < startedAt || nextActionAt > now + REQUEST_OPERATION_TTL_MS))
  ) return undefined;
  const itemIds = [...new Set(sanitizeStrings(value.itemIds, 100, 512).map(normalizeActivationItemId))];
  const targets = sanitizeTargets(value.targets);
  if (!itemIds.length || !targets.length) return undefined;
  const tenantId = sanitizeOptionalId(value.tenantId);
  const principalId = sanitizeOptionalId(value.principalId);
  const response = sanitizeActivationResponse(value.response);
  const items = sanitizeRequestOperationItems(value.items, itemIds, startedAt, tenantId, principalId, response, now);
  if (items.length !== itemIds.length) return undefined;
  return {
    id: value.id,
    action: value.action as RequestOperationAction,
    itemIds,
    targets,
    ...(tenantId ? { tenantId } : {}),
    ...(principalId ? { principalId } : {}),
    ...(items.length ? { items } : {}),
    state: value.state,
    startedAt,
    updatedAt,
    ...(terminalAt ? { terminalAt } : {}),
    ...(nextActionAt ? { nextActionAt } : {}),
    ...(value.action === "activate"
      && typeof value.durationHours === "number"
      && Number.isFinite(value.durationHours)
      && value.durationHours >= 0.5
      && value.durationHours <= 24
      ? { durationHours: value.durationHours }
      : {}),
    ...(typeof value.justification === "string" ? { justification: value.justification.slice(0, 1_000) } : {}),
    ...(sanitizeTicketInfo(value.ticketInfo) ? { ticketInfo: sanitizeTicketInfo(value.ticketInfo) } : {}),
    ...(typeof value.bundleName === "string" ? { bundleName: value.bundleName.slice(0, 80) } : {}),
    ...(typeof value.sourceInstallationId === "string" ? { sourceInstallationId: value.sourceInstallationId.slice(0, 80) } : {}),
    ...(typeof value.sourceDeviceName === "string" ? { sourceDeviceName: value.sourceDeviceName.slice(0, 60) } : {}),
    revision: clampRevision(value.revision),
    ...(response ? { response } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 1_000) } : {})
  };
}

function sanitizeRequestOperationItems(
  value: unknown,
  itemIds: string[],
  startedAt: number,
  operationTenantId: string | undefined,
  operationPrincipalId: string | undefined,
  response: ActivationResponse | undefined,
  now: number
): RequestOperationItemRecord[] {
  const values = Array.isArray(value) ? value : [];
  const byId = new Map<string, RequestOperationItemRecord>();
  for (const candidate of values.slice(0, 100)) {
    if (!isRecord(candidate) || typeof candidate.itemId !== "string") continue;
    const itemId = normalizeActivationItemId(candidate.itemId.slice(0, 512));
    if (!itemIds.includes(itemId) || !isOperationItemState(candidate.state)) continue;
    const updatedAt = sanitizeEpochMilliseconds(candidate.updatedAt);
    if (updatedAt === undefined || updatedAt > now + MAX_FUTURE_CLOCK_SKEW_MS || updatedAt < startedAt) continue;
    const itemType = sanitizeActivationItemType(candidate.itemType) || inferActivationItemType(itemId);
    if (!itemType) continue;
    const result = sanitizeActivationResult(candidate.result);
    const pendingTrackedRequest = sanitizePendingTrackedRequest(candidate.pendingTrackedRequest, now);
    const tenantId = sanitizeOptionalId(candidate.tenantId) || operationTenantId;
    const principalId = sanitizeOptionalId(candidate.principalId) || operationPrincipalId;
    byId.set(itemId, {
      itemId,
      itemName: typeof candidate.itemName === "string" ? candidate.itemName.slice(0, 256) : itemId,
      itemType,
      ...(tenantId ? { tenantId } : {}),
      ...(principalId ? { principalId } : {}),
      ...(typeof candidate.scopeLabel === "string" ? { scopeLabel: candidate.scopeLabel.slice(0, 512) } : {}),
      state: candidate.state,
      updatedAt,
      ...(typeof candidate.requestId === "string" ? { requestId: candidate.requestId.slice(0, 512) } : {}),
      ...(typeof candidate.trackedRequestId === "string" ? { trackedRequestId: candidate.trackedRequestId.slice(0, 512) } : {}),
      ...(pendingTrackedRequest ? { pendingTrackedRequest } : {}),
      ...(result ? { result } : {}),
      ...(typeof candidate.error === "string" ? { error: candidate.error.slice(0, 1_000) } : {})
    });
  }
  const responseById = new Map((response?.results || []).map((result) => [normalizeActivationItemId(result.itemId), result]));
  return itemIds.flatMap((itemId) => {
    const existing = byId.get(itemId);
    if (existing) return [existing];
    const prepared = createPreparedOperationItem(itemId, startedAt, operationTenantId, operationPrincipalId);
    if (!prepared) return [];
    const result = responseById.get(itemId);
    if (!result) {
      if (!response) return [prepared];
      const error = "The stored background response omitted this requested item. Check Microsoft PIM before retrying.";
      return [{
        ...prepared,
        state: "uncertain",
        updatedAt: now,
        error,
        result: {
          itemId,
          itemName: prepared.itemName,
          success: false,
          error,
          outcomeUnknown: true
        }
      }];
    }
    return [{
      ...prepared,
      state: result.outcomeUnknown ? "uncertain" : "terminal",
      result,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.error ? { error: result.error } : {})
    }];
  });
}

function sanitizePendingTrackedRequest(value: unknown, now: number): TrackedPimRequest | undefined {
  return sanitizeTrackedRequestStore({ version: 1, requests: [value] }, now).requests[0];
}

function createPreparedOperationItem(itemId: string, updatedAt: number, tenantId?: string, principalId?: string): RequestOperationItemRecord | undefined {
  const normalizedItemId = normalizeActivationItemId(itemId);
  const itemType = inferActivationItemType(normalizedItemId);
  if (!itemType) return undefined;
  return {
    itemId: normalizedItemId,
    itemName: normalizedItemId,
    itemType,
    ...(tenantId ? { tenantId } : {}),
    ...(principalId ? { principalId } : {}),
    state: "prepared",
    updatedAt
  };
}

function sanitizeTicketInfo(value: unknown): RequestOperationRecord["ticketInfo"] | undefined {
  if (!isRecord(value)) return undefined;
  const ticketSystem = typeof value.ticketSystem === "string" ? value.ticketSystem.trim().slice(0, 128) : "";
  const ticketNumber = typeof value.ticketNumber === "string" ? value.ticketNumber.trim().slice(0, 128) : "";
  return ticketSystem || ticketNumber ? { ticketSystem, ticketNumber } : undefined;
}

function sanitizeTargets(value: unknown): AccessSetupTarget[] {
  if (!Array.isArray(value)) return [];
  const allowed: AccessSetupTarget[] = ["directoryRole", "pimGroup", "azureRole"];
  return [...new Set(value.filter((item): item is AccessSetupTarget => allowed.includes(item as AccessSetupTarget)))];
}

function sanitizeStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))].slice(0, limit);
}

function sanitizeEpochMilliseconds(value: unknown): number | undefined {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= MAX_DATE_EPOCH_MS
    ? timestamp
    : undefined;
}

function sanitizeActivationResponse(value: unknown): ActivationResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.results)) return undefined;
  const results = value.results
    .flatMap((result) => sanitizeActivationResult(result) || [])
    .slice(0, 100);
  if (!results.length) return undefined;
  const errors = results.filter((result) => !result.success);
  return {
    success: errors.length === 0,
    results,
    errors,
    ...(typeof value.sourceInstallationId === "string" ? { sourceInstallationId: value.sourceInstallationId.slice(0, 80) } : {}),
    ...(typeof value.sourceDeviceName === "string" ? { sourceDeviceName: value.sourceDeviceName.slice(0, 60) } : {})
  };
}

function sanitizeActivationResult(value: unknown): ActivationResult | undefined {
  if (!isRecord(value) || typeof value.itemId !== "string" || !value.itemId || typeof value.itemName !== "string") {
    return undefined;
  }
  if (typeof value.success !== "boolean") return undefined;
  const accessRecoveryTarget = sanitizeTargets(
    value.accessRecoveryTarget ? [value.accessRecoveryTarget] : []
  )[0];
  const requestStatus = isTrackedRequestStatus(value.requestStatus) ? value.requestStatus : undefined;
  return {
    itemId: value.itemId.slice(0, 512),
    itemName: value.itemName.slice(0, 256),
    success: value.success,
    ...(typeof value.requestId === "string" ? { requestId: value.requestId.slice(0, 512) } : {}),
    ...(requestStatus ? { requestStatus } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 1_000) } : {}),
    ...(accessRecoveryTarget ? { accessRecoveryTarget } : {}),
    ...(value.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    ...(value.trackingUnavailable === true ? { trackingUnavailable: true } : {})
  };
}

function mergeOperations(current: RequestOperationRecord[], incoming: RequestOperationRecord[]): RequestOperationRecord[] {
  const merged = new Map<string, RequestOperationRecord>();
  for (const operation of [...current, ...incoming]) {
    const existing = merged.get(operation.id);
    if (!existing || compareOperationVersion(operation, existing) > 0) merged.set(operation.id, operation);
  }
  return [...merged.values()];
}

async function readStorageValue(storage: StorageAreaLike, key: string): Promise<unknown> {
  try {
    return (await storage.get(key))[key];
  } catch {
    return undefined;
  }
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

function isOperationItemState(value: unknown): value is RequestOperationItemState {
  return value === "prepared" || value === "sending" || value === "accepted" || value === "tracking"
    || value === "terminal" || value === "uncertain";
}

function sanitizeActivationItemType(value: unknown): ActivationItemType | undefined {
  return value === "directoryRole" || value === "pimGroup" || value === "azureRole" ? value : undefined;
}

function inferActivationItemType(itemId: string): ActivationItemType | undefined {
  const normalized = itemId.replace(/^tenant:[^:]+:/iu, "");
  if (normalized.startsWith("directoryRole:")) return "directoryRole";
  if (normalized.startsWith("pimGroup:")) return "pimGroup";
  if (normalized.startsWith("azureRole:")) return "azureRole";
  return undefined;
}

function isTrackedRequestStatus(value: unknown): value is TrackedPimRequestStatus {
  return value === "submitted" || value === "pendingApproval" || value === "provisioning"
    || value === "scheduled" || value === "active" || value === "completed" || value === "denied"
    || value === "failed" || value === "canceled" || value === "expired" || value === "unknown"
    || value === "statusUnavailable";
}

function tenantBoundariesMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

function compareOperationAge(left: RequestOperationRecord, right: RequestOperationRecord): number {
  const leftAnchor = left.terminalAt ?? left.updatedAt ?? left.startedAt;
  const rightAnchor = right.terminalAt ?? right.updatedAt ?? right.startedAt;
  return leftAnchor - rightAnchor || left.startedAt - right.startedAt || left.id.localeCompare(right.id);
}

function sanitizeOptionalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 128);
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeOptionalText(value: string | undefined): string {
  return value?.trim() || "";
}

function normalizeFingerprintText(value: string | undefined): string {
  return value?.trim().replace(/\s+/gu, " ") || "";
}

function clampRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function compareOperationVersion(left: RequestOperationRecord, right: RequestOperationRecord): number {
  const revision = (left.revision || 0) - (right.revision || 0);
  if (revision) return revision;
  const updated = left.updatedAt - right.updatedAt;
  if (updated) return updated;
  const stateRank: Record<RequestOperationState, number> = { running: 0, uncertain: 1, error: 2, complete: 3 };
  const state = stateRank[left.state] - stateRank[right.state];
  if (state) return state;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
