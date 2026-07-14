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

export interface StoredTokenMutation<T> {
  set?: Partial<StoredTokens>;
  remove?: string[];
  result: T;
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

let tokenMutationQueue: Promise<void> = Promise.resolve();
let defaultLegacyMigration: Promise<boolean> | undefined;

export async function getStoredTokensFromSession(options?: {
  local?: ChromeStorageAreaLike;
  session?: ChromeStorageAreaLike;
  now?: number;
}): Promise<StoredTokens> {
  const session = options?.session || chrome.storage.session;
  const local = options?.local || chrome.storage.local;
  if (options?.local || options?.session || options?.now !== undefined) {
    await migrateLegacyLocalTokensToSession({ local, session, now: options?.now });
  } else {
    defaultLegacyMigration ||= migrateLegacyLocalTokensToSession().catch((error) => {
      defaultLegacyMigration = undefined;
      throw error;
    });
    await defaultLegacyMigration;
  }
  return compactStoredTokens(await session.get(TOKEN_STORAGE_KEYS));
}

export async function updateStoredTokensInSession<T>(
  mutation: (current: StoredTokens) => StoredTokenMutation<T> | Promise<StoredTokenMutation<T>>,
  options?: { local?: ChromeStorageAreaLike; session?: ChromeStorageAreaLike }
): Promise<T> {
  const local = options?.local || chrome.storage.local;
  const session = options?.session || chrome.storage.session;
  return enqueueTokenMutation(async () => {
    const current = compactStoredTokens(await session.get(TOKEN_STORAGE_KEYS));
    const update = await mutation(current);
    if (update.remove?.length) {
      await Promise.all([session.remove(update.remove), local.remove(update.remove)]);
    }
    if (update.set && Object.keys(update.set).length) {
      await session.set(update.set as Record<string, unknown>);
    }
    return update.result;
  });
}

export async function removeStoredTokenKeys(keys: string[]): Promise<void> {
  await enqueueTokenMutation(async () => {
    await Promise.all([
      chrome.storage.session.remove(keys),
      chrome.storage.local.remove(keys)
    ]);
  });
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
  return enqueueTokenMutation(() => migrateLegacyTokens({ local, session, now }));
}

export async function removeStoredTokenGroupsIfMatching(
  groups: Array<{ tokenKey: keyof StoredTokens; expectedToken: string; keys: string[] }>,
  options?: { local?: ChromeStorageAreaLike; session?: ChromeStorageAreaLike }
): Promise<void> {
  const local = options?.local || chrome.storage.local;
  const session = options?.session || chrome.storage.session;
  await enqueueTokenMutation(async () => {
    const current = await session.get(groups.map((group) => String(group.tokenKey)));
    const keys = groups.flatMap((group) => current[group.tokenKey] === group.expectedToken ? group.keys : []);
    if (keys.length) {
      await Promise.all([session.remove(keys), local.remove(keys)]);
    }
  });
}

async function migrateLegacyTokens(options: {
  local: ChromeStorageAreaLike;
  session: ChromeStorageAreaLike;
  now: number;
}): Promise<boolean> {
  const { local, session, now } = options;
  const legacy = await local.get(TOKEN_STORAGE_KEYS);
  const current = await session.get(TOKEN_STORAGE_KEYS);
  const updates: Partial<StoredTokens> = {};
  let expectedIdentity = getFirstValidIdentity(current, now);

  for (const group of TOKEN_GROUPS) {
    const currentToken = current[group.tokenKey];
    if (typeof currentToken === "string" && validateCapturedToken(currentToken, group.kind, now).ok) {
      continue;
    }
    const token = legacy[group.tokenKey];
    if (typeof token !== "string") {
      continue;
    }
    const validation = validateCapturedToken(token, group.kind, now);
    if (!validation.ok) {
      continue;
    }
    const identity = getTokenIdentity(validation.decoded);
    if (expectedIdentity && identity && expectedIdentity !== identity) {
      continue;
    }
    expectedIdentity ||= identity;
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

async function enqueueTokenMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = tokenMutationQueue.then(mutation);
  tokenMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function getFirstValidIdentity(values: Record<string, unknown>, now: number): string | undefined {
  for (const group of TOKEN_GROUPS) {
    const token = values[group.tokenKey];
    if (typeof token !== "string") {
      continue;
    }
    const validation = validateCapturedToken(token, group.kind, now);
    if (validation.ok) {
      const identity = getTokenIdentity(validation.decoded);
      if (identity) {
        return identity;
      }
    }
  }
  return undefined;
}

function getTokenIdentity(decoded: Record<string, unknown>): string | undefined {
  return typeof decoded.tid === "string" && typeof decoded.oid === "string"
    ? `${decoded.tid.toLowerCase()}:${decoded.oid.toLowerCase()}`
    : undefined;
}

function setTokenUpdateValue<K extends keyof StoredTokens>(updates: Partial<StoredTokens>, key: K, value: StoredTokens[K]): void {
  updates[key] = value;
}

function compactStoredTokens(values: Record<string, unknown>): StoredTokens {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as StoredTokens;
}
