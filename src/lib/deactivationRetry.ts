import { getActivationItemIdentity } from "./activationIdentity";
import { buildDeactivationRequest } from "./pim";
import { sanitizeErrorMessage } from "./security";
import { createStorageMutationLock } from "./storageMutation";
import type { ActivationItem, ActivationResponse, TicketInfo } from "./types";

export const DEACTIVATION_RETRY_KEY = "quickPimDeactivationRetries.v1";
export const DEACTIVATION_RETRY_ALARM = "quickpim-deactivation-retry";
export const MINIMUM_ACTIVE_MS = 5 * 60_000;
const RETRY_MARGIN_MS = 5_000;
const MAX_LATE_MS = 15 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const withMutation = createStorageMutationLock("quickPimDeactivationRetryMutation");

export interface DeactivationRetry {
  id: string;
  item: ActivationItem;
  justification: string;
  ticketInfo: TicketInfo;
  createdAt: number;
  updatedAt: number;
  retryAt: number;
  state: "offered" | "queued" | "running" | "submitted" | "failed";
  detail?: string;
}

export interface RetryStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

export function isMinimumActiveDurationMessage(message: string): boolean {
  return /active duration is too short/i.test(message)
    && /min(?:i?mum|iumum)\s+required\s+is\s+5\s+minutes/i.test(message);
}

// Pin both schedule identifiers: a new activation of the same role must never
// inherit an old disable request, even when its tenant and scope are unchanged.
export function isSameRetryActivation(expected: ActivationItem, actual: ActivationItem): boolean {
  return getActivationItemIdentity(expected) === getActivationItemIdentity(actual)
    && expected.principalId.toLowerCase() === actual.principalId.toLowerCase()
    && actual.status === "active" && actual.activeAssignmentType === "activated"
    && expected.assignmentScheduleId === actual.assignmentScheduleId
    && expected.assignmentScheduleInstanceId === actual.assignmentScheduleInstanceId;
}

export function getDeactivationRetryTime(item: ActivationItem, rejectedAt: number): number {
  const start = item.activeFrom ? Date.parse(item.activeFrom) : Number.NaN;
  // Older cached items may lack a start time. Waiting five minutes from the
  // rejection is conservative; never infer activation time from a token's age.
  return Math.max(rejectedAt, Number.isFinite(start) && start <= rejectedAt
    ? start + MINIMUM_ACTIVE_MS : rejectedAt + MINIMUM_ACTIVE_MS) + RETRY_MARGIN_MS;
}

export async function loadDeactivationRetries(storage: RetryStorage = chrome.storage.local, now = Date.now()): Promise<DeactivationRetry[]> {
  const value = (await storage.get(DEACTIVATION_RETRY_KEY))[DEACTIVATION_RETRY_KEY];
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry): DeactivationRetry[] => {
    try {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string"
        || !/^[a-zA-Z0-9-]{1,100}$/.test(entry.id)
        || !["offered", "queued", "running", "submitted", "failed"].includes(entry.state)
        || ![entry.createdAt, entry.updatedAt, entry.retryAt].every(Number.isSafeInteger)
        || entry.createdAt > now + 30_000 || entry.createdAt < now - RETENTION_MS
        || entry.updatedAt < entry.createdAt || entry.updatedAt > now + 30_000
        || entry.retryAt <= entry.createdAt || entry.retryAt > entry.createdAt + MINIMUM_ACTIVE_MS + RETRY_MARGIN_MS
        || typeof entry.justification !== "string" || entry.justification.length > 2_000) return [];
      if (entry.state === "offered" && now > entry.retryAt + MAX_LATE_MS) return [];
      const item = snapshotItem(entry.item);
      const ticketInfo: TicketInfo = {};
      for (const field of ["ticketSystem", "ticketNumber"] as const) {
        const text = entry.ticketInfo?.[field];
        if (text !== undefined && (typeof text !== "string" || text.length > 128)) return [];
        if (text) ticketInfo[field] = text;
      }
      buildDeactivationRequest({ ...item, activeUntil: undefined }, entry.justification, ticketInfo);
      return [{ id: entry.id, item, justification: entry.justification, ticketInfo,
        createdAt: entry.createdAt, updatedAt: entry.updatedAt, retryAt: entry.retryAt, state: entry.state,
        ...(typeof entry.detail === "string" ? { detail: entry.detail.slice(0, 500) } : {}) }];
    } catch { return []; }
  });
}

export async function offerDeactivationRetry(
  item: ActivationItem, justification: string, ticketInfo: TicketInfo,
  storage: RetryStorage = chrome.storage.local, now = Date.now()
): Promise<void> {
  const snapshot = snapshotItem(item);
  buildDeactivationRequest(snapshot, justification, ticketInfo);
  await mutate(storage, now, (entries) => {
    if (entries.some((entry) => isSameRetryActivation(entry.item, snapshot)
      && ["offered", "queued", "running"].includes(entry.state))) return entries;
    // Never evict an accepted pending retry to make room for another offer.
    if (entries.length >= 100) return entries;
    return [{ id: crypto.randomUUID(), item: snapshot, justification, ticketInfo,
      createdAt: now, updatedAt: now, retryAt: getDeactivationRetryTime(snapshot, now), state: "offered" as const }, ...entries].slice(0, 100);
  });
}

export async function acceptDeactivationRetry(id: string, storage: RetryStorage = chrome.storage.local, now = Date.now()): Promise<void> {
  await mutate(storage, now, (entries) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry || entry.state !== "offered") throw new Error("This disable retry is no longer available.");
    if (now > entry.retryAt + MAX_LATE_MS) throw new Error("This disable retry expired. Disable the active item again.");
    return entries.map((candidate) => candidate.id === id ? { ...candidate, state: "queued", updatedAt: now } : candidate);
  });
}

export async function cancelDeactivationRetry(id: string, storage: RetryStorage = chrome.storage.local, now = Date.now()): Promise<void> {
  await mutate(storage, now, (entries) => {
    if (entries.some((entry) => entry.id === id && entry.state === "running")) {
      throw new Error("The disable retry has already started. Check its result before retrying manually.");
    }
    return entries.filter((entry) => entry.id !== id);
  });
}

export async function recoverInterruptedDeactivationRetries(storage: RetryStorage = chrome.storage.local, now = Date.now()): Promise<void> {
  await mutate(storage, now, (entries) => entries.map((entry) => entry.state === "running"
    ? { ...entry, state: "failed", updatedAt: now, detail: "The browser interrupted this retry. Check Microsoft PIM before disabling again; no request was resent." }
    : entry));
}

export async function runDueDeactivationRetries(options: {
  storage?: RetryStorage;
  now?: () => number;
  readActiveItems(entry: DeactivationRetry): Promise<ActivationItem[]>;
  submit(entry: DeactivationRetry, item: ActivationItem): Promise<ActivationResponse>;
}): Promise<void> {
  const storage = options.storage || chrome.storage.local;
  const now = options.now || Date.now;
  const entries = await loadDeactivationRetries(storage, now());
  for (const entry of entries.filter((candidate) => candidate.state === "queued" && candidate.retryAt <= now())) {
    let claimed = false;
    await mutate(storage, now(), (current) => current.map((candidate) => {
      if (candidate.id !== entry.id || candidate.state !== "queued") return candidate;
      claimed = true;
      return { ...candidate, state: "running", updatedAt: now() };
    }));
    if (!claimed) continue;
    try {
      if (now() > entry.retryAt + MAX_LATE_MS) throw new Error("The browser missed the retry window. Disable the active item again if still needed.");
      const current = (await options.readActiveItems(entry)).find((item) => isSameRetryActivation(entry.item, item));
      if (!current || (current.activeUntil && Date.parse(current.activeUntil) <= now())) {
        throw new Error("The original activation is no longer active or has changed. No disable request was sent.");
      }
      const response = await options.submit(entry, current);
      const result = response.results.find((candidate) => candidate.itemId === current.id);
      if (!result?.success) throw new Error(result?.error || response.errors[0]?.error || "The retry did not confirm a disable request. Check Microsoft PIM before retrying.");
      await finish(entry.id, "submitted", "Disable requested. Follow its Microsoft status in Activity & Usage.");
    } catch (error) {
      await finish(entry.id, "failed", sanitizeErrorMessage(error) || "Disable retry stopped. Check Microsoft PIM.");
    }
  }
  async function finish(id: string, state: "submitted" | "failed", detail: string) {
    await mutate(storage, now(), (current) => current.map((entry) => entry.id === id
      ? { ...entry, state, detail: detail.slice(0, 500), updatedAt: now() } : entry));
  }
}

async function mutate(storage: RetryStorage, now: number, update: (entries: DeactivationRetry[]) => DeactivationRetry[]): Promise<void> {
  await withMutation(async () => storage.set({ [DEACTIVATION_RETRY_KEY]: update(await loadDeactivationRetries(storage, now)) }));
}

function snapshotItem(value: ActivationItem): ActivationItem {
  if (!value || !value.tenantId || !/^[a-zA-Z0-9-]{1,128}$/.test(value.tenantId)
    || value.status !== "active" || value.activeAssignmentType !== "activated") throw new Error("The activation identity is unavailable.");
  const fields = ["id", "tenantId", "principalId", "sourceName", "displayName", "scopeLabel", "status", "type",
    "activeAssignmentType", "activeFrom", "activeUntil", "assignmentScheduleId", "assignmentScheduleInstanceId",
    "roleDefinitionId", "directoryScopeId", "scope", "groupId", "accessId"] as const;
  const item = Object.fromEntries(fields.flatMap((field) => {
    const text = (value as unknown as Record<string, unknown>)[field];
    if (text === undefined) return [];
    if (typeof text !== "string" || !text.length || text.length > 512) throw new Error("The activation identity is invalid.");
    return [[field, text]];
  })) as unknown as ActivationItem;
  if (!item.principalId || !item.assignmentScheduleId || !item.assignmentScheduleInstanceId) throw new Error("The exact activation schedule is unavailable.");
  for (const date of [item.activeFrom, item.activeUntil]) {
    if (date && !Number.isFinite(Date.parse(date))) throw new Error("The activation time is invalid.");
  }
  return item;
}
