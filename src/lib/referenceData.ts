import type { ActivationItem, ReferenceDataCache, ReferenceValue } from "./types";

export const REFERENCE_DATA_KEY = "quickPimReferenceData.v1";

const MAX_REFERENCE_ITEMS = 300;
const MAX_REFERENCE_KEY_LENGTH = 256;
const MAX_REFERENCE_NAME_LENGTH = 120;

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
  await chrome.storage.local.set({ [REFERENCE_DATA_KEY]: mergeReferenceData(referenceData) });
}

export async function clearReferenceData(): Promise<void> {
  await chrome.storage.local.remove(REFERENCE_DATA_KEY);
}

export function mergeReferenceData(input: unknown): ReferenceDataCache {
  const source = isRecord(input) ? input : {};
  return {
    version: 1,
    directoryRoleDefinitions: sanitizeReferenceMap(source.directoryRoleDefinitions),
    pimGroups: sanitizeReferenceMap(source.pimGroups),
    azureRoleDefinitions: sanitizeReferenceMap(source.azureRoleDefinitions),
    azureSubscriptions: sanitizeReferenceMap(source.azureSubscriptions),
    scopes: sanitizeReferenceMap(source.scopes),
    directoryScopes: sanitizeReferenceMap(source.directoryScopes)
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
    return referenceData.directoryRoleDefinitions[item.roleDefinitionId]?.name;
  }

  if (item.type === "pimGroup" && item.displayName === item.groupId) {
    return referenceData.pimGroups[item.groupId]?.name;
  }

  if (item.type === "azureRole" && !isResolvedAzureRoleName(item)) {
    return referenceData.azureRoleDefinitions[item.roleDefinitionId]?.name;
  }

  return undefined;
}

export function getReferenceScopeLabel(item: ActivationItem, referenceData: ReferenceDataCache | undefined): string | undefined {
  if (!referenceData) {
    return undefined;
  }

  if (item.type === "directoryRole" && item.directoryScopeId !== "/" && item.scopeLabel === item.directoryScopeId) {
    return referenceData.directoryScopes[item.directoryScopeId]?.name;
  }

  if (item.type === "azureRole") {
    if (item.scopeLabel === item.scope || item.scopeLabel === item.subscriptionId || item.scopeLabel === "Azure") {
      return referenceData.scopes[item.scope]?.name || (item.subscriptionId ? referenceData.azureSubscriptions[item.subscriptionId]?.name : undefined);
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
    ...(displayName ? { displayName, sourceName: displayName } : {}),
    ...(scopeLabel ? { scopeLabel } : {})
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
  const safeKey = sanitizeString(key, MAX_REFERENCE_KEY_LENGTH);
  const safeName = sanitizeString(name, MAX_REFERENCE_NAME_LENGTH);
  if (!safeKey || !safeName) {
    return;
  }
  target[safeKey] = { name: safeName, updatedAt };
}

function sanitizeReferenceMap(value: unknown): Record<string, ReferenceValue> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .slice(0, MAX_REFERENCE_ITEMS)
    .flatMap(([key, entry]) => {
      if (!isRecord(entry)) {
        return [];
      }
      const safeKey = sanitizeString(key, MAX_REFERENCE_KEY_LENGTH);
      const safeName = sanitizeString(entry.name, MAX_REFERENCE_NAME_LENGTH);
      const updatedAt = sanitizeString(entry.updatedAt, 64) || new Date(0).toISOString();
      return safeKey && safeName ? [[safeKey, { name: safeName, updatedAt }] as const] : [];
    });
  return Object.fromEntries(entries);
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
