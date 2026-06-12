import { validateCapturedToken } from "./security";
import type { TokenKind } from "./types";

export interface StoredTokens {
  graphToken?: string;
  tokenTimestamp?: number;
  tokenSource?: string;
  graphDirectoryRoleToken?: string;
  graphDirectoryRoleTokenTimestamp?: number;
  graphDirectoryRoleTokenSource?: string;
  graphPimGroupToken?: string;
  graphPimGroupTokenTimestamp?: number;
  graphPimGroupTokenSource?: string;
  azureManagementToken?: string;
  azureManagementTokenTimestamp?: number;
  azureManagementTokenSource?: string;
}

export interface ChromeStorageAreaLike {
  get(keys?: string | string[]): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const TOKEN_STORAGE_KEYS = [
  "graphToken",
  "tokenTimestamp",
  "tokenSource",
  "graphDirectoryRoleToken",
  "graphDirectoryRoleTokenTimestamp",
  "graphDirectoryRoleTokenSource",
  "graphPimGroupToken",
  "graphPimGroupTokenTimestamp",
  "graphPimGroupTokenSource",
  "azureManagementToken",
  "azureManagementTokenTimestamp",
  "azureManagementTokenSource"
];

const TOKEN_GROUPS: Array<{ tokenKey: keyof StoredTokens; timestampKey: keyof StoredTokens; sourceKey: keyof StoredTokens; kind: TokenKind }> = [
  { tokenKey: "graphToken", timestampKey: "tokenTimestamp", sourceKey: "tokenSource", kind: "graph" },
  { tokenKey: "graphDirectoryRoleToken", timestampKey: "graphDirectoryRoleTokenTimestamp", sourceKey: "graphDirectoryRoleTokenSource", kind: "graph" },
  { tokenKey: "graphPimGroupToken", timestampKey: "graphPimGroupTokenTimestamp", sourceKey: "graphPimGroupTokenSource", kind: "graph" },
  {
    tokenKey: "azureManagementToken",
    timestampKey: "azureManagementTokenTimestamp",
    sourceKey: "azureManagementTokenSource",
    kind: "azureManagement"
  }
];

export async function getStoredTokensFromSession(options?: {
  local?: ChromeStorageAreaLike;
  session?: ChromeStorageAreaLike;
  now?: number;
}): Promise<StoredTokens> {
  const session = options?.session || chrome.storage.session;
  const local = options?.local || chrome.storage.local;
  const sessionTokens = await session.get(TOKEN_STORAGE_KEYS);
  if (hasAnyStoredToken(sessionTokens)) {
    return compactStoredTokens(sessionTokens);
  }

  await migrateLegacyLocalTokensToSession({ local, session, now: options?.now });
  return compactStoredTokens(await session.get(TOKEN_STORAGE_KEYS));
}

export async function setStoredTokensInSession(values: Partial<StoredTokens>): Promise<void> {
  await chrome.storage.session.set(values as Record<string, unknown>);
}

export async function removeStoredTokenKeys(keys: string[]): Promise<void> {
  await Promise.all([
    chrome.storage.session.remove(keys),
    chrome.storage.local.remove(keys)
  ]);
}

export async function clearStoredTokens(): Promise<void> {
  await removeStoredTokenKeys(TOKEN_STORAGE_KEYS);
}

export async function migrateLegacyLocalTokensToSession(options?: {
  local?: ChromeStorageAreaLike;
  session?: ChromeStorageAreaLike;
  now?: number;
}): Promise<boolean> {
  const local = options?.local || chrome.storage.local;
  const session = options?.session || chrome.storage.session;
  const now = options?.now ?? Date.now();
  const legacy = await local.get(TOKEN_STORAGE_KEYS);
  const updates: Partial<StoredTokens> = {};

  for (const group of TOKEN_GROUPS) {
    const token = legacy[group.tokenKey];
    if (typeof token !== "string") {
      continue;
    }
    const validation = validateCapturedToken(token, group.kind, now);
    if (!validation.ok) {
      continue;
    }
    setTokenUpdateValue(updates, group.tokenKey, token);
    const timestamp = legacy[group.timestampKey];
    const source = legacy[group.sourceKey];
    if (typeof timestamp === "number") {
      setTokenUpdateValue(updates, group.timestampKey, timestamp);
    }
    if (typeof source === "string") {
      setTokenUpdateValue(updates, group.sourceKey, source);
    }
  }

  if (Object.keys(updates).length) {
    await session.set(updates as Record<string, unknown>);
  }
  await local.remove(TOKEN_STORAGE_KEYS);
  return Object.keys(updates).length > 0;
}

function setTokenUpdateValue<K extends keyof StoredTokens>(updates: Partial<StoredTokens>, key: K, value: StoredTokens[K]): void {
  updates[key] = value;
}

function hasAnyStoredToken(values: Record<string, unknown>): boolean {
  return TOKEN_GROUPS.some((group) => typeof values[group.tokenKey] === "string");
}

function compactStoredTokens(values: Record<string, unknown>): StoredTokens {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as StoredTokens;
}
