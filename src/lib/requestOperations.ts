import type {
  AccessSetupTarget,
  ActivationResult,
  ActivationResponse,
  RequestOperationAction,
  RequestOperationRecord
} from "./types";

export const REQUEST_OPERATIONS_SESSION_KEY = "quickPimRequestOperations.v1";
export const REQUEST_OPERATION_TTL_MS = 30 * 60_000;

const MAX_OPERATIONS = 20;
let requestOperationMutationQueue: Promise<void> = Promise.resolve();

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
    await saveOperations(storage, operations);
  }
  return operations;
}

export async function beginRequestOperation(
  operation: Pick<RequestOperationRecord, "id" | "action" | "itemIds" | "targets" | "startedAt"> &
    Partial<Pick<RequestOperationRecord, "durationHours" | "justification" | "bundleName">>,
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
): Promise<void> {
  const operation = requestOperationMutationQueue.then(async () => {
    const result = await storage.get(REQUEST_OPERATIONS_SESSION_KEY);
    const current = sanitizeRequestOperations(result[REQUEST_OPERATIONS_SESSION_KEY], now);
    await saveOperations(storage, mutation(current).slice(0, MAX_OPERATIONS));
  });
  requestOperationMutationQueue = operation.catch(() => undefined);
  await operation;
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
  if (!Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)) return undefined;
  const startedAt = Number(value.startedAt);
  const updatedAt = Number(value.updatedAt);
  if (now - updatedAt > REQUEST_OPERATION_TTL_MS || updatedAt > now + 5 * 60_000) return undefined;
  const itemIds = sanitizeStrings(value.itemIds, 100, 512);
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
    ...(typeof value.durationHours === "number" && Number.isFinite(value.durationHours) ? { durationHours: value.durationHours } : {}),
    ...(typeof value.justification === "string" ? { justification: value.justification.slice(0, 1_000) } : {}),
    ...(typeof value.bundleName === "string" ? { bundleName: value.bundleName.slice(0, 80) } : {}),
    ...(response ? { response } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 1_000) } : {})
  };
}

function sanitizeTargets(value: unknown): AccessSetupTarget[] {
  if (!Array.isArray(value)) return [];
  const allowed: AccessSetupTarget[] = ["directoryRole", "pimGroup", "azureRole"];
  return [...new Set(value.filter((item): item is AccessSetupTarget => allowed.includes(item as AccessSetupTarget)))];
}

function sanitizeStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0).map((item) => item.slice(0, maxLength)))].slice(0, limit);
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
    errors
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
    ...(accessRecoveryTarget ? { accessRecoveryTarget } : {})
  };
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
