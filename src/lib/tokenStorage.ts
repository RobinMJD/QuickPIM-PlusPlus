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
export const TOKEN_MIGRATION_STATE_KEY = "quickPimTokenMigration.v2";

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
      // Remove the legacy local copy first. If that fails, keep the session
      // token usable and surface the failure instead of resurrecting it during
      // the next browser session.
      await local.remove(update.remove);
      await session.remove(update.remove);
    }
    if (update.set && Object.keys(update.set).length) {
      await session.set(update.set as Record<string, unknown>);
    }
    return update.result;
  });
}

export async function removeStoredTokenKeys(keys: string[]): Promise<void> {
  await enqueueTokenMutation(async () => {
    await chrome.storage.local.remove(keys);
    await chrome.storage.session.remove(keys);
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
      await local.remove(keys);
      await session.remove(keys);
    }
  });
}

async function migrateLegacyTokens(options: {
  local: ChromeStorageAreaLike;
  session: ChromeStorageAreaLike;
  now: number;
}): Promise<boolean> {
  const { local, session, now } = options;
  const legacy = await local.get([...TOKEN_STORAGE_KEYS, TOKEN_MIGRATION_STATE_KEY]);
  const current = await session.get(TOKEN_STORAGE_KEYS);
  const migrationComplete = isMigrationMarker(legacy[TOKEN_MIGRATION_STATE_KEY]);
  const candidates = collectTokenGroupCandidates(current, migrationComplete ? {} : legacy, now);
  const selectedIdentity = selectCoherentIdentity(candidates);
  const updates: Partial<StoredTokens> = {};
  const removals: string[] = [];
  let copiedLegacyToken = false;

  for (const group of TOKEN_GROUPS) {
    const selected = candidates
      .filter((candidate) => candidate.group.tokenKey === group.tokenKey && candidate.identity === selectedIdentity)
      .sort(compareTokenGroupCandidates)[0];
    if (!selected) {
      if (current[group.tokenKey] !== undefined || current[group.timestampKey] !== undefined || current[group.sourceKey] !== undefined) {
        removals.push(String(group.tokenKey), String(group.timestampKey), String(group.sourceKey));
      }
      continue;
    }
    setTokenUpdateValue(updates, group.tokenKey, selected.token as StoredTokens[typeof group.tokenKey]);
    setTokenUpdateValue(updates, group.timestampKey, selected.timestamp as StoredTokens[typeof group.timestampKey]);
    if (selected.source) setTokenUpdateValue(updates, group.sourceKey, selected.source as StoredTokens[typeof group.sourceKey]);
    copiedLegacyToken ||= selected.origin === "legacy";
  }

  if (removals.length) await session.remove([...new Set(removals)]);
  if (Object.keys(updates).length) await session.set(updates as Record<string, unknown>);

  // Mark migration complete even if a browser-specific local removal problem
  // occurs, so a stale legacy generation can never be selected again. The
  // removal is still awaited and reported to the caller.
  await local.set({ [TOKEN_MIGRATION_STATE_KEY]: { version: 2, completedAt: now } });
  await local.remove(TOKEN_STORAGE_KEYS);
  return copiedLegacyToken;
}

async function enqueueTokenMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = tokenMutationQueue.then(mutation);
  tokenMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

interface TokenGroupCandidate {
  group: typeof TOKEN_GROUPS[number];
  token: string;
  identity: string;
  timestamp: number;
  source?: string;
  expiry: number;
  origin: "session" | "legacy";
}

function collectTokenGroupCandidates(
  current: Record<string, unknown>,
  legacy: Record<string, unknown>,
  now: number
): TokenGroupCandidate[] {
  const candidates: TokenGroupCandidate[] = [];
  for (const [origin, values] of [["session", current], ["legacy", legacy]] as const) {
    for (const group of TOKEN_GROUPS) {
      const token = values[group.tokenKey];
      if (typeof token !== "string") continue;
      const validation = validateCapturedToken(token, group.kind, now);
      if (!validation.ok) continue;
      const identity = getTokenIdentity(validation.decoded);
      if (!identity) continue;
      candidates.push({
        group,
        token,
        identity,
        timestamp: sanitizeCaptureTimestamp(values[group.timestampKey], validation.decoded, now),
        ...(typeof values[group.sourceKey] === "string" ? { source: String(values[group.sourceKey]).slice(0, 256) } : {}),
        expiry: Number(validation.decoded.exp) || 0,
        origin
      });
    }
  }
  return candidates;
}

function selectCoherentIdentity(candidates: TokenGroupCandidate[]): string | undefined {
  const identities = new Map<string, TokenGroupCandidate[]>();
  for (const candidate of candidates) {
    identities.set(candidate.identity, [...(identities.get(candidate.identity) || []), candidate]);
  }
  return [...identities.entries()]
    .sort((left, right) => {
      const leftSessionCoverage = new Set(left[1].filter((item) => item.origin === "session").map((item) => item.group.tokenKey)).size;
      const rightSessionCoverage = new Set(right[1].filter((item) => item.origin === "session").map((item) => item.group.tokenKey)).size;
      const leftCoverage = new Set(left[1].map((item) => item.group.tokenKey)).size;
      const rightCoverage = new Set(right[1].map((item) => item.group.tokenKey)).size;
      const leftFreshness = Math.max(0, ...left[1].map((item) => item.expiry));
      const rightFreshness = Math.max(0, ...right[1].map((item) => item.expiry));
      return rightSessionCoverage - leftSessionCoverage
        || rightCoverage - leftCoverage
        || rightFreshness - leftFreshness
        || left[0].localeCompare(right[0]);
    })[0]?.[0];
}

function compareTokenGroupCandidates(left: TokenGroupCandidate, right: TokenGroupCandidate): number {
  return Number(right.origin === "session") - Number(left.origin === "session")
    || right.expiry - left.expiry
    || right.timestamp - left.timestamp
    || left.token.localeCompare(right.token);
}

function sanitizeCaptureTimestamp(value: unknown, decoded: Record<string, unknown>, now: number): number {
  const issuedAt = Number(decoded.iat) * 1_000;
  const minimum = Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt - 5 * 60_000 : now - 24 * 60 * 60_000;
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp >= minimum && timestamp <= now + 5 * 60_000) {
    return Math.min(timestamp, now);
  }
  return Number.isFinite(issuedAt) && issuedAt > 0 && issuedAt <= now + 5 * 60_000
    ? Math.min(issuedAt, now)
    : now;
}

function isMigrationMarker(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { version?: unknown }).version === 2);
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
