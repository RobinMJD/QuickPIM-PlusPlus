import type { ActivationItem, ReferenceDataCache, ReferenceValue } from "./types";
import { createStorageMutationLock } from "./storageMutation";
import { isSafeRecordKey } from "./security";

export const REFERENCE_DATA_KEY = "quickPimReferenceData.v1";

const MAX_REFERENCE_ITEMS = 300;
const MAX_REFERENCE_INPUT_ITEMS = MAX_REFERENCE_ITEMS * 4;
const MAX_REFERENCE_KEY_LENGTH = 256;
const MAX_REFERENCE_NAME_LENGTH = 120;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const withReferenceDataMutationLock = createStorageMutationLock("quickPimReferenceDataMutation");

export const DEFAULT_REFERENCE_DATA: ReferenceDataCache = {
  version: 1,
  directoryRoleDefinitions: {},
  pimGroups: {},
  azureRoleDefinitions: {},
  azureSubscriptions: {},
  scopes: {},
  directoryScopes: {}
};

export async function loadReferenceData(): Promise<ReferenceDataCache> {
  const result = await chrome.storage.local.get(REFERENCE_DATA_KEY);
  return mergeReferenceData(result[REFERENCE_DATA_KEY]);
}

export async function saveReferenceData(referenceData: ReferenceDataCache): Promise<void> {
  const incoming = mergeReferenceData(referenceData);
  await withReferenceDataMutationLock(async () => {
    const current = await loadReferenceData();
    const next = mergeReferenceDataForSave(current, incoming);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      await chrome.storage.local.set({ [REFERENCE_DATA_KEY]: next });
    }
  });
}

export async function clearReferenceData(): Promise<void> {
  await withReferenceDataMutationLock(() => chrome.storage.local.remove(REFERENCE_DATA_KEY));
}

export function mergeReferenceDataForSave(
  current: ReferenceDataCache,
  incoming: ReferenceDataCache
): ReferenceDataCache {
  const safeCurrent = mergeReferenceData(current);
  const safeIncoming = mergeReferenceData(incoming);
  return mergeReferenceData({
    directoryRoleDefinitions: mergeReferenceMaps(safeCurrent.directoryRoleDefinitions, safeIncoming.directoryRoleDefinitions),
    pimGroups: mergeReferenceMaps(safeCurrent.pimGroups, safeIncoming.pimGroups),
    azureRoleDefinitions: mergeReferenceMaps(safeCurrent.azureRoleDefinitions, safeIncoming.azureRoleDefinitions),
    azureSubscriptions: mergeReferenceMaps(safeCurrent.azureSubscriptions, safeIncoming.azureSubscriptions),
    scopes: mergeReferenceMaps(safeCurrent.scopes, safeIncoming.scopes),
    directoryScopes: mergeReferenceMaps(safeCurrent.directoryScopes, safeIncoming.directoryScopes)
  });
}

export function mergeReferenceData(input: unknown, now = Date.now()): ReferenceDataCache {
  const source = isRecord(input) ? input : {};
  return {
    version: 1,
    directoryRoleDefinitions: sanitizeReferenceMap(source.directoryRoleDefinitions, now),
    pimGroups: sanitizeReferenceMap(source.pimGroups, now),
    azureRoleDefinitions: sanitizeReferenceMap(source.azureRoleDefinitions, now),
    azureSubscriptions: sanitizeReferenceMap(source.azureSubscriptions, now),
    scopes: sanitizeReferenceMap(source.scopes, now),
    directoryScopes: sanitizeReferenceMap(source.directoryScopes, now)
  };
}

export function learnReferenceDataFromItems(
  current: ReferenceDataCache,
  items: ActivationItem[],
  updatedAt = new Date().toISOString()
): ReferenceDataCache {
  const next = mergeReferenceData(current);
  for (const item of items) {
    if (item.type === "directoryRole") {
      if (isResolvedDirectoryRoleName(item)) {
        setReference(next.directoryRoleDefinitions, item.roleDefinitionId, item.displayName, updatedAt);
      }
      if (item.directoryScopeId !== "/" && item.scopeLabel !== item.directoryScopeId) {
        setReference(next.directoryScopes, item.directoryScopeId, item.scopeLabel, updatedAt);
      }
      continue;
    }

    if (item.type === "pimGroup") {
      if (item.displayName !== item.groupId) {
        setReference(next.pimGroups, item.groupId, item.displayName, updatedAt);
      }
      continue;
    }

    if (isResolvedAzureRoleName(item)) {
      setReference(next.azureRoleDefinitions, item.roleDefinitionId, item.displayName, updatedAt);
    }
    if (item.subscriptionId && item.subscriptionName) {
      setReference(next.azureSubscriptions, item.subscriptionId, item.subscriptionName, updatedAt);
    }
    if (item.scope && item.scopeLabel && item.scopeLabel !== item.scope) {
      setReference(next.scopes, item.scope, item.scopeLabel, updatedAt);
    }
  }
  return mergeReferenceData(next);
}

export function applyReferenceDataToItems(items: ActivationItem[], referenceData: ReferenceDataCache): ActivationItem[] {
  return items.map((item) => applyReferenceDataToItem(item, referenceData));
}

export function getReferenceDisplayName(item: ActivationItem, referenceData: ReferenceDataCache | undefined): string | undefined {
  if (!referenceData) {
    return undefined;
  }

  if (item.type === "directoryRole" && !isResolvedDirectoryRoleName(item)) {
    return referenceData.directoryRoleDefinitions[canonicalReferenceKey(item.roleDefinitionId)]?.name;
  }

  if (item.type === "pimGroup" && item.displayName === item.groupId) {
    return referenceData.pimGroups[canonicalReferenceKey(item.groupId)]?.name;
  }

  if (item.type === "azureRole" && !isResolvedAzureRoleName(item)) {
    return referenceData.azureRoleDefinitions[canonicalReferenceKey(item.roleDefinitionId)]?.name;
  }

  return undefined;
}

export function getReferenceScopeLabel(item: ActivationItem, referenceData: ReferenceDataCache | undefined): string | undefined {
  if (!referenceData) {
    return undefined;
  }

  if (item.type === "directoryRole" && item.directoryScopeId !== "/" && item.scopeLabel === item.directoryScopeId) {
    return referenceData.directoryScopes[canonicalReferenceKey(item.directoryScopeId)]?.name;
  }

  if (item.type === "azureRole") {
    if (item.scopeLabel === item.scope || item.scopeLabel === item.subscriptionId || item.scopeLabel === "Azure") {
      return referenceData.scopes[canonicalReferenceKey(item.scope)]?.name || (item.subscriptionId ? referenceData.azureSubscriptions[canonicalReferenceKey(item.subscriptionId)]?.name : undefined);
    }
  }

  return undefined;
}

function applyReferenceDataToItem(item: ActivationItem, referenceData: ReferenceDataCache): ActivationItem {
  const displayName = getReferenceDisplayName(item, referenceData);
  const scopeLabel = getReferenceScopeLabel(item, referenceData);
  if (!displayName && !scopeLabel) {
    return item;
  }

  return {
    ...item,
    ...(displayName ? { displayName } : {}),
    ...(scopeLabel ? { scopeLabel, sourceScopeLabel: item.sourceScopeLabel || item.scopeLabel } : {})
  } as ActivationItem;
}

function isResolvedDirectoryRoleName(item: Extract<ActivationItem, { type: "directoryRole" }>): boolean {
  return Boolean(item.displayName && item.displayName !== item.roleDefinitionId);
}

function isResolvedAzureRoleName(item: Extract<ActivationItem, { type: "azureRole" }>): boolean {
  const leaf = item.roleDefinitionId.split("/").at(-1) || item.roleDefinitionId;
  return Boolean(item.displayName && item.displayName !== item.roleDefinitionId && item.displayName !== leaf);
}

function setReference(target: Record<string, ReferenceValue>, key: string | undefined, name: string | undefined, updatedAt: string): void {
  const safeKey = canonicalReferenceKey(sanitizeString(key, MAX_REFERENCE_KEY_LENGTH));
  const safeName = sanitizeString(name, MAX_REFERENCE_NAME_LENGTH);
  if (!safeKey || !isSafeRecordKey(safeKey) || !safeName) {
    return;
  }
  target[safeKey] = { name: safeName, updatedAt };
}

function mergeReferenceMaps(
  current: Record<string, ReferenceValue>,
  incoming: Record<string, ReferenceValue>
): Record<string, ReferenceValue> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    const canonicalKey = canonicalReferenceKey(key);
    if (!isSafeRecordKey(canonicalKey)) continue;
    const existing = merged[canonicalKey];
    const incomingTimestamp = Date.parse(value.updatedAt);
    const existingTimestamp = existing ? Date.parse(existing.updatedAt) : Number.NEGATIVE_INFINITY;
    if (!existing || incomingTimestamp > existingTimestamp || (incomingTimestamp === existingTimestamp && value.name.localeCompare(existing.name) > 0)) {
      merged[canonicalKey] = value;
    }
  }
  return merged;
}

function sanitizeReferenceMap(value: unknown, now: number): Record<string, ReferenceValue> {
  if (!isRecord(value)) {
    return {};
  }

  const rawEntries = Object.entries(value).slice(0, MAX_REFERENCE_INPUT_ITEMS);

  const entries = rawEntries
    .flatMap(([key, entry]) => {
      if (!isRecord(entry)) {
        return [];
      }
      const safeKey = canonicalReferenceKey(sanitizeString(key, MAX_REFERENCE_KEY_LENGTH));
      const safeName = sanitizeString(entry.name, MAX_REFERENCE_NAME_LENGTH);
      const rawUpdatedAt = sanitizeString(entry.updatedAt, 64);
      const timestamp = rawUpdatedAt ? Date.parse(rawUpdatedAt) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp > now + MAX_FUTURE_CLOCK_SKEW_MS) {
        return [];
      }
      const updatedAt = new Date(timestamp).toISOString();
      return safeKey && isSafeRecordKey(safeKey) && safeName ? [[safeKey, { name: safeName, updatedAt }] as const] : [];
    })
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt) || a[0].localeCompare(b[0]))
    .slice(0, MAX_REFERENCE_ITEMS);
  const newestByKey = new Map<string, ReferenceValue>();
  for (const [key, entry] of entries) {
    const canonicalKey = canonicalReferenceKey(key);
    const existing = newestByKey.get(canonicalKey);
    if (!existing || Date.parse(entry.updatedAt) > Date.parse(existing.updatedAt) || (entry.updatedAt === existing.updatedAt && entry.name.localeCompare(existing.name) > 0)) {
      newestByKey.set(canonicalKey, entry);
    }
  }
  return Object.fromEntries([...newestByKey.entries()].slice(0, MAX_REFERENCE_ITEMS));
}

function canonicalReferenceKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function sanitizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
