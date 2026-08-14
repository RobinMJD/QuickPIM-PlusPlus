import type {
  AccessSetupTarget,
  ActivationResult,
  ActivationResponse,
  RequestOperationAction,
  RequestOperationRecord,
  TrackedPimRequest
} from "./types";
import { createStorageMutationLock } from "./storageMutation";
import { normalizeActivationItemId } from "./activationIdentity";

export const REQUEST_OPERATIONS_SESSION_KEY = "quickPimRequestOperations.v1";
export const REQUEST_OPERATION_TTL_MS = 2 * 60 * 60_000;
export const REQUEST_OPERATION_RECONCILIATION_GRACE_MS = 2 * 60_000;

const MAX_OPERATIONS = 20;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
const withRequestOperationMutationLock = createStorageMutationLock("quickPimRequestOperationMutation");

export type RequestOperationIdentity = Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets"> &
  Partial<Pick<RequestOperationRecord, "durationHours" | "justification" | "ticketInfo" | "bundleName">>;

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export async function loadRequestOperations(
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<RequestOperationRecord[]> {
  const storage = options.storage || chrome.storage.session;
  const now = options.now ?? Date.now();
  const result = await storage.get(REQUEST_OPERATIONS_SESSION_KEY);
  const storedValue = result[REQUEST_OPERATIONS_SESSION_KEY];
  const operations = sanitizeRequestOperations(storedValue, now);
  if (Array.isArray(storedValue) && JSON.stringify(operations) !== JSON.stringify(storedValue)) {
    // Re-read inside the mutation queue so cleanup cannot overwrite an operation
    // that started after this read completed.
    return mutateOperations(storage, now, (current) => current);
  }
  return operations;
}

export async function beginRequestOperation(
  operation: Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets" | "startedAt"> &
    Partial<Pick<RequestOperationRecord, "durationHours" | "justification" | "ticketInfo" | "bundleName" | "sourceInstallationId" | "sourceDeviceName">>,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.session;
  const now = options.now ?? Date.now();
  await mutateOperations(storage, now, (current) => [
    {
      ...operation,
      state: "running",
      updatedAt: now
    },
    ...current.filter((item) => item.id !== operation.id)
  ]);
}

export function getRequestOperationFingerprint(operation: RequestOperationIdentity): string {
  const ticketSystem = operation.ticketInfo?.ticketSystem?.trim() || null;
  const ticketNumber = operation.ticketInfo?.ticketNumber?.trim() || null;
  return JSON.stringify({
    action: operation.action,
    itemIds: [...new Set(operation.itemIds.map(normalizeActivationItemId))].sort(),
    targets: [...new Set(operation.targets)].sort(),
    durationHours: operation.durationHours ?? null,
    justification: operation.justification ?? null,
    ticketInfo: ticketSystem || ticketNumber ? { ticketSystem, ticketNumber } : null,
    bundleName: operation.bundleName ?? null
  });
}

export function trackedRequestMatchesOperation(
  request: TrackedPimRequest,
  operation: RequestOperationRecord
): boolean {
  if (
    request.action !== operation.action
    || !operation.itemIds.map(normalizeActivationItemId).includes(normalizeActivationItemId(request.itemId))
  ) {
    return false;
  }

  if (request.operationId) {
    return request.operationId === operation.id;
  }

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
    && (!operation.sourceInstallationId || !request.sourceInstallationId
      || request.sourceInstallationId === operation.sourceInstallationId);
}

export async function completeRequestOperation(
  id: string,
  response: ActivationResponse,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  await updateRequestOperation(id, { state: "complete", response }, options);
}

export async function failRequestOperation(
  id: string,
  error: string,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  await updateRequestOperation(id, { state: "error", error: error.slice(0, 1_000) }, options);
}

export async function touchRequestOperation(
  id: string,
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.session;
  const now = options.now ?? Date.now();
  await mutateOperations(storage, now, (current) => current.map((item) => item.id === id && item.state === "running"
    ? { ...item, updatedAt: now }
    : item));
}

export async function dismissRequestOperations(
  ids: string[],
  options: { storage?: StorageAreaLike; now?: number } = {}
): Promise<void> {
  const storage = options.storage || chrome.storage.session;
  const now = options.now ?? Date.now();
  const idSet = new Set(ids);
  await mutateOperations(storage, now, (current) => current.filter((item) => !idSet.has(item.id)));
}

export function sanitizeRequestOperations(value: unknown, now = Date.now()): RequestOperationRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => sanitizeRequestOperation(item, now) || [])
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_OPERATIONS);
}

async function updateRequestOperation(
  id: string,
  update: Pick<RequestOperationRecord, "state"> & Partial<Pick<RequestOperationRecord, "response" | "error">>,
  options: { storage?: StorageAreaLike; now?: number }
): Promise<void> {
  const storage = options.storage || chrome.storage.session;
  const now = options.now ?? Date.now();
  await mutateOperations(storage, now, (current) => current.map((item) => item.id === id
    ? { ...item, ...update, updatedAt: now }
    : item));
}

async function mutateOperations(
  storage: StorageAreaLike,
  now: number,
  mutation: (current: RequestOperationRecord[]) => RequestOperationRecord[]
): Promise<RequestOperationRecord[]> {
  return withRequestOperationMutationLock(async () => {
    const result = await storage.get(REQUEST_OPERATIONS_SESSION_KEY);
    const current = sanitizeRequestOperations(result[REQUEST_OPERATIONS_SESSION_KEY], now);
    const next = sanitizeRequestOperations(mutation(current), now).slice(0, MAX_OPERATIONS);
    await saveOperations(storage, next);
    return next;
  });
}

async function saveOperations(storage: StorageAreaLike, operations: RequestOperationRecord[]): Promise<void> {
  if (operations.length) {
    await storage.set({ [REQUEST_OPERATIONS_SESSION_KEY]: operations });
  } else {
    await storage.remove(REQUEST_OPERATIONS_SESSION_KEY);
  }
}

function sanitizeRequestOperation(value: unknown, now: number): RequestOperationRecord | undefined {
  if (!isRecord(value) || !isOperationId(value.id) || (value.action !== "activate" && value.action !== "deactivate")) {
    return undefined;
  }
  if (value.state !== "running" && value.state !== "complete" && value.state !== "error") return undefined;
  const startedAt = sanitizeEpochMilliseconds(value.startedAt);
  const updatedAt = sanitizeEpochMilliseconds(value.updatedAt);
  if (startedAt === undefined || updatedAt === undefined) return undefined;
  if (
    now - updatedAt > REQUEST_OPERATION_TTL_MS
    || updatedAt > now + MAX_FUTURE_CLOCK_SKEW_MS
    || startedAt > now + MAX_FUTURE_CLOCK_SKEW_MS
    || updatedAt < startedAt
  ) return undefined;
  const itemIds = [...new Set(sanitizeStrings(value.itemIds, 100, 512).map(normalizeActivationItemId))];
  const targets = sanitizeTargets(value.targets);
  if (!itemIds.length || !targets.length) return undefined;
  const response = sanitizeActivationResponse(value.response);
  return {
    id: value.id,
    action: value.action as RequestOperationAction,
    itemIds,
    targets,
    state: value.state,
    startedAt,
    updatedAt,
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
    ...(response ? { response } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 1_000) } : {})
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
  return {
    itemId: value.itemId.slice(0, 512),
    itemName: value.itemName.slice(0, 256),
    success: value.success,
    ...(typeof value.requestId === "string" ? { requestId: value.requestId.slice(0, 512) } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 1_000) } : {}),
    ...(accessRecoveryTarget ? { accessRecoveryTarget } : {}),
    ...(value.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    ...(value.trackingUnavailable === true ? { trackingUnavailable: true } : {})
  };
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeOptionalText(value: string | undefined): string {
  return value?.trim() || "";
}
