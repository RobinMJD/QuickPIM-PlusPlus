import type {
  AccessDiagnostic,
  AccessDiagnosticOperation,
  AccessFailureKind,
  AccessSetupTarget,
  ActivationDataResult,
  ActivationItem,
  CachedActivationEntry,
  QuickPimDataCache,
  TargetActivationCache
} from "./types";
import { createStorageMutationLock } from "./storageMutation";

export const DATA_CACHE_KEY = "quickPimDataCache.v1";
export const DEFAULT_ELIGIBLE_CACHE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ACTIVE_CACHE_TTL_MS = 10 * 60 * 1000;
export const STALE_ELIGIBLE_CACHE_TTL_MS = 60 * 60 * 1000;
export const CACHE_TARGETS: AccessSetupTarget[] = ["directoryRole", "pimGroup", "azureRole"];

const withDataCacheMutationLock = createStorageMutationLock("quickPimDataCacheMutation");
const MAX_CACHE_ITEMS = 1_000;
const MAX_CACHE_ERRORS = 20;
const MAX_CACHE_DIAGNOSTICS = 40;
const MAX_CACHE_INPUT_ITEMS = MAX_CACHE_ITEMS * 4;
const MAX_CACHE_INPUT_ERRORS = MAX_CACHE_ERRORS * 4;
const MAX_CACHE_INPUT_DIAGNOSTICS = MAX_CACHE_DIAGNOSTICS * 4;
const MAX_CACHE_STRING_LENGTH = 512;
const MAX_CACHE_IDENTITY_LENGTH = 4_096;
const MAX_CACHE_KEY_LENGTH = 8_192;
const MAX_CACHE_ERROR_LENGTH = 500;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;

const ITEM_STATUSES = new Set(["eligible", "active", "pendingApproval"]);
const ASSIGNMENT_TYPES = new Set(["activated", "assigned", "unknown"]);
const DIAGNOSTIC_OPERATIONS = new Set<AccessDiagnosticOperation>([
  "eligible",
  "active",
  "policy",
  "nameLookup",
  "activation",
  "deactivation"
]);
const FAILURE_KINDS = new Set<AccessFailureKind>([
  "missingToken",
  "expiredToken",
  "missingCapability",
  "forbidden",
  "claimsChallenge",
  "network",
  "unknown"
]);

type CacheBucket = "eligible" | "active";

export interface TargetCacheStatus {
  target: AccessSetupTarget;
  entry?: CachedActivationEntry;
  isFresh: boolean;
  isUsable: boolean;
}

export function isCacheEntryFresh(
  entry: CachedActivationEntry | undefined,
  ttlMs: number,
  now = Date.now(),
  cacheKey?: string
): entry is CachedActivationEntry {
  const age = entry ? now - entry.fetchedAt : Number.POSITIVE_INFINITY;
  const latestAttemptFailed = Boolean(
    entry?.errors.length
    && entry.refreshStartedAt !== undefined
    && entry.refreshStartedAt >= entry.fetchedAt
  );
  return Boolean(
    entry &&
      Number.isFinite(entry.fetchedAt) &&
      age >= -5 * 60 * 1000 &&
      age < ttlMs &&
      !latestAttemptFailed &&
      (cacheKey === undefined || entry.cacheKey === cacheKey)
  );
}

function isCacheSnapshotUsable(
  entry: CachedActivationEntry | undefined,
  ttlMs: number,
  now: number,
  cacheKey?: string
): entry is CachedActivationEntry {
  const age = entry ? now - entry.fetchedAt : Number.POSITIVE_INFINITY;
  return Boolean(
    entry
    && Number.isFinite(entry.fetchedAt)
    && age >= -5 * 60 * 1000
    && age < ttlMs
    && (cacheKey === undefined || entry.cacheKey === cacheKey)
  );
}

export function formatCacheAge(fetchedAt: number | undefined, now = Date.now()): string {
  if (!fetchedAt) {
    return "not cached";
  }

  const ageMs = Math.max(0, now - fetchedAt);
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) {
    return "less than 1 min ago";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export async function loadDataCache(): Promise<QuickPimDataCache> {
  const result = await chrome.storage.local.get(DATA_CACHE_KEY);
  return sanitizeDataCache(result[DATA_CACHE_KEY]);
}

export async function saveDataCache(cache: QuickPimDataCache): Promise<void> {
  await withDataCacheMutationLock(async () => {
    const current = await loadDataCache();
    await chrome.storage.local.set({ [DATA_CACHE_KEY]: mergeDataCachesForSave(current, cache) });
  });
}

export async function clearDataCache(): Promise<void> {
  await withDataCacheMutationLock(() => chrome.storage.local.remove(DATA_CACHE_KEY));
}

export function mergeDataCachesForSave(current: QuickPimDataCache, incoming: QuickPimDataCache): QuickPimDataCache {
  const safeCurrent = sanitizeDataCache(current);
  const safeIncoming = sanitizeDataCache(incoming);
  return {
    version: 2,
    eligible: chooseCacheEntry(safeCurrent.eligible, safeIncoming.eligible),
    active: chooseCacheEntry(safeCurrent.active, safeIncoming.active),
    eligibleByTarget: mergeTargetCache(safeCurrent.eligibleByTarget, safeIncoming.eligibleByTarget),
    activeByTarget: mergeTargetCache(safeCurrent.activeByTarget, safeIncoming.activeByTarget)
  };
}

export function sanitizeDataCache(value: unknown, now = Date.now()): QuickPimDataCache {
  if (!isRecord(value)) return {};
  const eligible = sanitizeCacheEntry(value.eligible, undefined, now);
  const active = sanitizeCacheEntry(value.active, undefined, now);
  const eligibleByTarget = sanitizeTargetCache(value.eligibleByTarget, now);
  const activeByTarget = sanitizeTargetCache(value.activeByTarget, now);
  return {
    version: 2,
    ...(eligible ? { eligible } : {}),
    ...(active ? { active } : {}),
    ...(eligibleByTarget ? { eligibleByTarget } : {}),
    ...(activeByTarget ? { activeByTarget } : {})
  };
}

export async function getDataWithCache(
  key: CacheBucket,
  cache: QuickPimDataCache,
  ttlMs: number,
  force: boolean,
  fetcher: () => Promise<{ items: CachedActivationEntry["items"]; errors: string[]; diagnostics?: CachedActivationEntry["diagnostics"] }>,
  now = Date.now(),
  cacheKey?: string
): Promise<{ entry: CachedActivationEntry; fromCache: boolean; cache: QuickPimDataCache }> {
  const cached = cache[key];
  if (!force && isCacheEntryFresh(cached, ttlMs, now, cacheKey)) {
    return { entry: markDiagnosticsFromCache({ ...cached, errors: [] }, true), fromCache: true, cache };
  }

  try {
    const fresh = await fetcher();
    const entry: CachedActivationEntry = {
      ...fresh,
      fetchedAt: now,
      cacheKey,
      diagnostics: markDiagnostics(fresh.diagnostics, false)
    };
    return { entry, fromCache: false, cache: { ...cache, [key]: entry } };
  } catch (error) {
    if (cached) {
      return {
        entry: markDiagnosticsFromCache({
          ...cached,
          errors: [error instanceof Error ? error.message : String(error)]
        }, true),
        fromCache: true,
        cache
      };
    }
    throw error;
  }
}

export async function getActivationDataWithCache(options: {
  cache: QuickPimDataCache;
  force: boolean;
  now?: number;
  tokenCacheKey?: string;
  eligibleTtlMs?: number;
  activeTtlMs?: number;
  fetchEligible: () => Promise<{ items: CachedActivationEntry["items"]; errors: string[]; diagnostics?: CachedActivationEntry["diagnostics"] }>;
  fetchActive: () => Promise<{ items: CachedActivationEntry["items"]; errors: string[]; diagnostics?: CachedActivationEntry["diagnostics"] }>;
}): Promise<{
  eligible: Awaited<ReturnType<typeof getDataWithCache>>;
  active: Awaited<ReturnType<typeof getDataWithCache>>;
  cache: QuickPimDataCache;
}> {
  const now = options.now ?? Date.now();
  const [eligible, active] = await Promise.all([
    getDataWithCache(
      "eligible",
      options.cache,
      options.eligibleTtlMs ?? DEFAULT_ELIGIBLE_CACHE_TTL_MS,
      options.force,
      options.fetchEligible,
      now,
      options.tokenCacheKey
    ),
    getDataWithCache(
      "active",
      options.cache,
      options.activeTtlMs ?? DEFAULT_ACTIVE_CACHE_TTL_MS,
      options.force,
      options.fetchActive,
      now,
      options.tokenCacheKey
    )
  ]);

  return {
    eligible,
    active,
    cache: {
      ...options.cache,
      ...(eligible.cache.eligible ? { eligible: eligible.cache.eligible } : {}),
      ...(active.cache.active ? { active: active.cache.active } : {})
    }
  };
}

export function getTargetCacheStatus(options: {
  cache: QuickPimDataCache;
  bucket: CacheBucket;
  target: AccessSetupTarget;
  cacheKey?: string;
  compatibleCacheKey?: (cacheKey: string | undefined) => boolean;
  legacyCacheKey?: string;
  now?: number;
  freshTtlMs: number;
  usableTtlMs?: number;
}): TargetCacheStatus {
  const now = options.now ?? Date.now();
  const usableTtlMs = options.usableTtlMs ?? options.freshTtlMs;
  const entry = getTargetEntry(options.cache, options.bucket, options.target);
  const exactEntry = entry;
  if (isCacheSnapshotUsable(exactEntry, usableTtlMs, now, options.cacheKey)) {
    return {
      target: options.target,
      entry: markDiagnosticsFromCache({ ...exactEntry, errors: [] }, true),
      isFresh: isCacheEntryFresh(exactEntry, options.freshTtlMs, now, options.cacheKey),
      isUsable: true
    };
  }

  if (
    entry
    && options.compatibleCacheKey?.(entry.cacheKey)
    && isCacheSnapshotUsable(entry, usableTtlMs, now)
  ) {
    return {
      target: options.target,
      entry: markDiagnosticsFromCache({ ...entry, errors: [] }, true),
      // A scope change can keep same-account display data usable, but it must
      // still trigger a fresh API check before request capabilities are trusted.
      isFresh: false,
      isUsable: true
    };
  }

  const legacyEntry = getLegacyTargetEntry(options.cache, options.bucket, options.target);
  if (isCacheSnapshotUsable(legacyEntry, usableTtlMs, now, options.legacyCacheKey)) {
    return {
      target: options.target,
      entry: markDiagnosticsFromCache({ ...legacyEntry, errors: [] }, true),
      isFresh: isCacheEntryFresh(legacyEntry, options.freshTtlMs, now, options.legacyCacheKey),
      isUsable: true
    };
  }

  return { target: options.target, isFresh: false, isUsable: false };
}

export function mergeTargetEntries(entries: Array<CachedActivationEntry | undefined>, fetchedAt = Date.now(), cacheKey?: string): CachedActivationEntry {
  const present = entries.filter((entry): entry is CachedActivationEntry => Boolean(entry));
  return {
    items: dedupeItems(present.flatMap((entry) => entry.items)),
    errors: present.flatMap((entry) => entry.errors || []),
    diagnostics: present.flatMap((entry) => entry.diagnostics || []),
    fetchedAt: present.length ? Math.max(...present.map((entry) => entry.fetchedAt)) : fetchedAt,
    cacheKey,
    ...(present.some((entry) => entry.truncated) ? { truncated: true } : {}),
    ...(present.some((entry) => entry.totalItems !== undefined)
      ? { totalItems: present.reduce((total, entry) => total + (entry.totalItems ?? entry.items.length), 0) }
      : {})
  };
}

export function getTargetEntriesFromCache(
  cache: QuickPimDataCache,
  bucket: CacheBucket,
  targets: AccessSetupTarget[],
  cacheKeys: Partial<Record<AccessSetupTarget, string>>,
  options: {
    compatibleCacheKey?: (target: AccessSetupTarget, cacheKey: string | undefined) => boolean;
    legacyCacheKey?: string;
    now?: number;
    freshTtlMs: number;
    usableTtlMs?: number;
  }
): Partial<Record<AccessSetupTarget, TargetCacheStatus>> {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      getTargetCacheStatus({
        cache,
        bucket,
        target,
        cacheKey: cacheKeys[target],
        compatibleCacheKey: options.compatibleCacheKey
          ? (cacheKey) => options.compatibleCacheKey!(target, cacheKey)
          : undefined,
        legacyCacheKey: options.legacyCacheKey,
        now: options.now,
        freshTtlMs: options.freshTtlMs,
        usableTtlMs: options.usableTtlMs
      })
    ])
  );
}

export function updateCacheFromTargetResults(
  cache: QuickPimDataCache,
  bucket: CacheBucket,
  targets: AccessSetupTarget[],
  resultsByTarget: Partial<Record<AccessSetupTarget, ActivationDataResult>>,
  fetchedAt: number,
  cacheKeys: Partial<Record<AccessSetupTarget, string>>,
  refreshStartedAt = fetchedAt
): QuickPimDataCache {
  const mapKey = bucket === "eligible" ? "eligibleByTarget" : "activeByTarget";
  const nextByTarget: TargetActivationCache = { ...(cache[mapKey] || {}) };

  for (const target of targets) {
    const result = resultsByTarget[target];
    if (!result) {
      continue;
    }
    const previous = nextByTarget[target];
    const diagnostics = result.diagnostics?.filter((item) => item.target === target);
    const failed = Boolean(result.errors?.length) && !diagnostics?.some((item) => item.success);
    if (failed && previous && previous.cacheKey === cacheKeys[target]) {
      nextByTarget[target] = {
        ...previous,
        errors: result.errors || [],
        diagnostics: mergeDiagnostics(previous.diagnostics, diagnostics),
        refreshStartedAt
      };
      continue;
    }
    nextByTarget[target] = {
      items: result.items.filter((item) => item.type === target),
      errors: result.errors || [],
      diagnostics: result.diagnostics,
      fetchedAt: failed ? 0 : fetchedAt,
      refreshStartedAt,
      cacheKey: cacheKeys[target]
    };
  }

  return {
    ...cache,
    [mapKey]: nextByTarget
  };
}

export function splitActivationResultByTarget(
  result: ActivationDataResult,
  targets: AccessSetupTarget[]
): Partial<Record<AccessSetupTarget, ActivationDataResult>> {
  return Object.fromEntries(targets.map((target) => {
    const diagnostics = result.diagnostics?.filter((item) => item.target === target);
    const diagnosticErrors = diagnostics?.filter((item) => !item.success).map((item) => item.error).filter((item): item is string => Boolean(item)) || [];
    return [target, {
      items: result.items.filter((item) => item.type === target),
      errors: diagnosticErrors.length ? diagnosticErrors : targets.length === 1 ? result.errors || [] : [],
      diagnostics
    }];
  }));
}

function mergeDiagnostics(
  previous: CachedActivationEntry["diagnostics"],
  incoming: CachedActivationEntry["diagnostics"]
): CachedActivationEntry["diagnostics"] {
  return [...(previous || []), ...(incoming || [])]
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt))
    .slice(-20);
}

function markDiagnosticsFromCache(entry: CachedActivationEntry, fromCache: boolean): CachedActivationEntry {
  return {
    ...entry,
    diagnostics: markDiagnostics(entry.diagnostics, fromCache)
  };
}

function markDiagnostics(
  diagnostics: CachedActivationEntry["diagnostics"] | undefined,
  fromCache: boolean
): CachedActivationEntry["diagnostics"] | undefined {
  return diagnostics?.map((item) => ({ ...item, fromCache }));
}

function getTargetEntry(cache: QuickPimDataCache, bucket: CacheBucket, target: AccessSetupTarget): CachedActivationEntry | undefined {
  const byTarget = bucket === "eligible" ? cache.eligibleByTarget : cache.activeByTarget;
  return byTarget?.[target];
}

function getLegacyTargetEntry(cache: QuickPimDataCache, bucket: CacheBucket, target: AccessSetupTarget): CachedActivationEntry | undefined {
  const legacy = bucket === "eligible" ? cache.eligible : cache.active;
  if (!legacy) {
    return undefined;
  }
  return {
    ...legacy,
    items: legacy.items.filter((item) => item.type === target),
    errors: [],
    diagnostics: legacy.diagnostics?.filter((item) => item.target === target)
  };
}

function dedupeItems(items: CachedActivationEntry["items"]): CachedActivationEntry["items"] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function mergeTargetCache(
  current: TargetActivationCache | undefined,
  incoming: TargetActivationCache | undefined
): TargetActivationCache | undefined {
  if (!current && !incoming) {
    return undefined;
  }

  return Object.fromEntries(
    CACHE_TARGETS.flatMap((target) => {
      const entry = chooseCacheEntry(current?.[target], incoming?.[target]);
      return entry ? [[target, entry] as const] : [];
    })
  );
}

function chooseCacheEntry(
  current: CachedActivationEntry | undefined,
  incoming: CachedActivationEntry | undefined
): CachedActivationEntry | undefined {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }

  if (incoming.cacheKey === current.cacheKey) {
    const currentUsable = isUsableCacheEntry(current);
    const incomingUsable = isUsableCacheEntry(incoming);
    if (currentUsable !== incomingUsable) {
      const successful = currentUsable ? current : incoming;
      const failed = currentUsable ? incoming : current;
      const successfulStartedAt = getFiniteTimestamp(successful.refreshStartedAt) ?? 0;
      const failedStartedAt = getFiniteTimestamp(failed.refreshStartedAt) ?? 0;
      const refreshStartedAt = Math.max(successfulStartedAt, failedStartedAt);
      const diagnostics = mergeDiagnostics(successful.diagnostics, failed.diagnostics);
      return {
        ...successful,
        errors: failedStartedAt >= successfulStartedAt ? failed.errors : successful.errors,
        ...(diagnostics?.length ? { diagnostics } : {}),
        ...(refreshStartedAt ? { refreshStartedAt } : {})
      };
    }
  }

  const currentRefreshStartedAt = getFiniteTimestamp(current.refreshStartedAt);
  const incomingRefreshStartedAt = getFiniteTimestamp(incoming.refreshStartedAt);
  if (currentRefreshStartedAt !== undefined || incomingRefreshStartedAt !== undefined) {
    if (currentRefreshStartedAt === undefined) return incoming;
    if (incomingRefreshStartedAt === undefined) return current;
    if (incomingRefreshStartedAt !== currentRefreshStartedAt) {
      return incomingRefreshStartedAt > currentRefreshStartedAt ? incoming : current;
    }
  }

  if (incoming.cacheKey !== current.cacheKey || incoming.fetchedAt >= current.fetchedAt) {
    return incoming;
  }
  return current;
}

function isUsableCacheEntry(entry: CachedActivationEntry): boolean {
  return Number.isFinite(entry.fetchedAt) && entry.fetchedAt > 0;
}

function getFiniteTimestamp(value: number | undefined): number | undefined {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= MAX_DATE_EPOCH_MS ? Number(value) : undefined;
}

function sanitizeTargetCache(value: unknown, now: number): TargetActivationCache | undefined {
  if (!isRecord(value)) return undefined;
  const entries = CACHE_TARGETS.flatMap((target) => {
    const entry = sanitizeCacheEntry(value[target], target, now);
    return entry ? [[target, entry] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sanitizeCacheEntry(value: unknown, expectedTarget: AccessSetupTarget | undefined, now: number): CachedActivationEntry | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  const fetchedAt = getFiniteTimestamp(typeof value.fetchedAt === "number" ? value.fetchedAt : undefined);
  if (fetchedAt === undefined || fetchedAt > now + MAX_FUTURE_CLOCK_SKEW_MS) return undefined;
  const cacheKey = sanitizeIdentityString(value.cacheKey, MAX_CACHE_KEY_LENGTH);

  const seen = new Set<string>();
  const inputItems = value.items.slice(0, MAX_CACHE_INPUT_ITEMS);
  const items = inputItems.flatMap((candidate) => {
    const item = sanitizeCachedActivationItem(candidate, cacheKey);
    if (!item || (expectedTarget && item.type !== expectedTarget)) return [];
    const key = item.id.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [item];
  }).slice(0, MAX_CACHE_ITEMS);
  const errors = Array.isArray(value.errors)
    ? value.errors.slice(0, MAX_CACHE_INPUT_ERRORS).flatMap((error) => sanitizeOptionalString(error, MAX_CACHE_ERROR_LENGTH) || []).slice(0, MAX_CACHE_ERRORS)
    : [];
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.slice(-MAX_CACHE_INPUT_DIAGNOSTICS).flatMap((diagnostic) => sanitizeDiagnostic(diagnostic, now) || []).slice(-MAX_CACHE_DIAGNOSTICS)
    : undefined;
  const rawRefreshStartedAt = getFiniteTimestamp(typeof value.refreshStartedAt === "number" ? value.refreshStartedAt : undefined);
  const refreshStartedAt = rawRefreshStartedAt !== undefined && rawRefreshStartedAt <= now + MAX_FUTURE_CLOCK_SKEW_MS
    ? rawRefreshStartedAt
    : undefined;
  const sourceTotalItems = Number(value.totalItems);
  const totalItems = Number.isSafeInteger(sourceTotalItems) && sourceTotalItems >= items.length
    ? sourceTotalItems
    : value.items.length;
  const truncated = value.truncated === true || value.items.length > MAX_CACHE_ITEMS || value.items.length > MAX_CACHE_INPUT_ITEMS;
  const boundedErrors = truncated
    ? [...errors, `Cached role data is incomplete: showing ${items.length} of at least ${totalItems} items.`].slice(-MAX_CACHE_ERRORS)
    : errors;
  return {
    items,
    errors: boundedErrors,
    fetchedAt,
    ...(refreshStartedAt !== undefined ? { refreshStartedAt } : {}),
    ...(cacheKey ? { cacheKey } : {}),
    ...(diagnostics?.length ? { diagnostics } : {}),
    ...(truncated ? { truncated: true, totalItems } : {})
  };
}

function sanitizeCachedActivationItem(value: unknown, cacheKey?: string): ActivationItem | undefined {
  if (!isRecord(value) || !ITEM_STATUSES.has(String(value.status))) return undefined;
  const id = sanitizeIdentityString(value.id);
  const sourceName = sanitizeRequiredString(value.sourceName);
  const displayName = sanitizeRequiredString(value.displayName);
  const principalId = sanitizeIdentityString(value.principalId, 256);
  const scopeLabel = sanitizeRequiredString(value.scopeLabel);
  if (!id || !sourceName || !displayName || principalId === undefined || !scopeLabel) return undefined;
  const activationPolicyState = value.activationPolicyState === "pending" || value.activationPolicyState === "ready"
    ? value.activationPolicyState as "pending" | "ready"
    : undefined;
  const tenantId = sanitizeTenantId(value.tenantId)
    || getCachedTenantId(cacheKey, value.type as ActivationItem["type"], principalId);

  const common = {
    id,
    sourceName,
    displayName,
    principalId,
    scopeLabel,
    status: value.status as ActivationItem["status"],
    ...(tenantId ? { tenantId } : {}),
    ...(sanitizeOptionalString(value.sourceScopeLabel) ? { sourceScopeLabel: sanitizeOptionalString(value.sourceScopeLabel) } : {}),
    ...(ASSIGNMENT_TYPES.has(String(value.activeAssignmentType)) ? { activeAssignmentType: value.activeAssignmentType as ActivationItem["activeAssignmentType"] } : {}),
    ...(sanitizeTimestamp(value.activeUntil) ? { activeUntil: sanitizeTimestamp(value.activeUntil) } : {}),
    ...(sanitizeIdentityString(value.assignmentScheduleId) ? { assignmentScheduleId: sanitizeIdentityString(value.assignmentScheduleId) } : {}),
    ...(sanitizeIdentityString(value.assignmentScheduleInstanceId) ? { assignmentScheduleInstanceId: sanitizeIdentityString(value.assignmentScheduleInstanceId) } : {}),
    ...(typeof value.isPrivileged === "boolean" ? { isPrivileged: value.isPrivileged } : {}),
    ...(activationPolicyState ? { activationPolicyState } : {}),
    ...(sanitizeActivationRequirements(value.activationRequirements) ? { activationRequirements: sanitizeActivationRequirements(value.activationRequirements) } : {})
  };

  if (value.type === "directoryRole") {
    const roleDefinitionId = sanitizeIdentityString(value.roleDefinitionId);
    const directoryScopeId = sanitizeIdentityString(value.directoryScopeId);
    return roleDefinitionId && directoryScopeId ? { ...common, type: "directoryRole", roleDefinitionId, directoryScopeId } : undefined;
  }
  if (value.type === "pimGroup") {
    const groupId = sanitizeIdentityString(value.groupId);
    if (!groupId || (value.accessId !== "member" && value.accessId !== "owner")) return undefined;
    return {
      ...common,
      type: "pimGroup",
      groupId,
      accessId: value.accessId,
      ...(sanitizeOptionalString(value.memberType) ? { memberType: sanitizeOptionalString(value.memberType) } : {})
    };
  }
  if (value.type === "azureRole") {
    const roleDefinitionId = sanitizeIdentityString(value.roleDefinitionId);
    const scope = sanitizeIdentityString(value.scope);
    if (!roleDefinitionId || !scope) return undefined;
    return {
      ...common,
      type: "azureRole",
      roleDefinitionId,
      scope,
      ...(sanitizeIdentityString(value.subscriptionId) ? { subscriptionId: sanitizeIdentityString(value.subscriptionId) } : {}),
      ...(sanitizeOptionalString(value.subscriptionName) ? { subscriptionName: sanitizeOptionalString(value.subscriptionName) } : {}),
      ...(sanitizeIdentityString(value.roleEligibilityScheduleId) ? { roleEligibilityScheduleId: sanitizeIdentityString(value.roleEligibilityScheduleId) } : {})
    };
  }
  return undefined;
}

function getCachedTenantId(
  cacheKey: string | undefined,
  itemType: ActivationItem["type"],
  principalId: string
): string | undefined {
  if (!cacheKey) return undefined;
  const preferredLabels = itemType === "azureRole"
    ? ["azure"]
    : itemType === "directoryRole"
      ? ["graphDirectory", "graph"]
      : ["graphPimGroup", "graph"];
  const parts = cacheKey.split("|");
  for (const label of preferredLabels) {
    const matchingPart = parts.find((part) => part.startsWith(`${label}:`));
    if (!matchingPart) continue;
    const segments = matchingPart.split(":");
    // Valid identity-bound keys contain label, tenant, principal, then token
    // capability metadata. Sentinels such as `graph:missing` and tokens with
    // no known identity must never be interpreted as a tenant.
    if (segments.length < 4 || segments[2].toLowerCase() !== principalId.toLowerCase()) continue;
    const tenantId = sanitizeTenantId(segments[1]);
    if (tenantId) return tenantId;
  }
  return undefined;
}

function sanitizeTenantId(value: unknown): string | undefined {
  const tenantId = sanitizeIdentityString(value, 128);
  return tenantId && /^[a-zA-Z0-9-]+$/.test(tenantId) ? tenantId : undefined;
}

function sanitizeActivationRequirements(value: unknown): ActivationItem["activationRequirements"] | undefined {
  if (!isRecord(value)) return undefined;
  const maxDurationHours = Number(value.maxDurationHours);
  const result: NonNullable<ActivationItem["activationRequirements"]> = {
    ...(typeof value.justification === "boolean" ? { justification: value.justification } : {}),
    ...(typeof value.ticket === "boolean" ? { ticket: value.ticket } : {}),
    ...(typeof value.approval === "boolean" ? { approval: value.approval } : {}),
    ...(Number.isFinite(maxDurationHours) && maxDurationHours >= 0.5 && maxDurationHours <= 24 ? { maxDurationHours } : {})
  };
  return Object.keys(result).length ? result : undefined;
}

function sanitizeDiagnostic(value: unknown, now: number): AccessDiagnostic | undefined {
  if (!isRecord(value) || !CACHE_TARGETS.includes(value.target as AccessSetupTarget) || typeof value.success !== "boolean") return undefined;
  const checkedAt = sanitizeTimestamp(value.checkedAt);
  if (!checkedAt) return undefined;
  if (Date.parse(checkedAt) > now + MAX_FUTURE_CLOCK_SKEW_MS) return undefined;
  const operation = DIAGNOSTIC_OPERATIONS.has(value.operation as AccessDiagnosticOperation)
    ? value.operation as AccessDiagnosticOperation
    : undefined;
  const failureKind = FAILURE_KINDS.has(value.failureKind as AccessFailureKind)
    ? value.failureKind as AccessFailureKind
    : undefined;
  return {
    target: value.target as AccessSetupTarget,
    success: value.success,
    checkedAt,
    ...(sanitizeOptionalString(value.error, MAX_CACHE_ERROR_LENGTH) ? { error: sanitizeOptionalString(value.error, MAX_CACHE_ERROR_LENGTH) } : {}),
    ...(typeof value.fromCache === "boolean" ? { fromCache: value.fromCache } : {}),
    ...(operation ? { operation } : {}),
    ...(sanitizeOptionalString(value.endpointLabel, 120) ? { endpointLabel: sanitizeOptionalString(value.endpointLabel, 120) } : {}),
    ...(failureKind ? { failureKind } : {})
  };
}

function sanitizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function sanitizeRequiredString(value: unknown): string | undefined {
  return sanitizeOptionalString(value, MAX_CACHE_STRING_LENGTH);
}

function sanitizeIdentityString(value: unknown, maxLength = MAX_CACHE_IDENTITY_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function sanitizeOptionalString(value: unknown, maxLength = MAX_CACHE_STRING_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
