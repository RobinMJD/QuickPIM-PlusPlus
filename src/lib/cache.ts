import type { AccessSetupTarget, ActivationDataResult, CachedActivationEntry, QuickPimDataCache, TargetActivationCache } from "./types";

export const DATA_CACHE_KEY = "quickPimDataCache.v1";
export const DEFAULT_ELIGIBLE_CACHE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ACTIVE_CACHE_TTL_MS = 10 * 60 * 1000;
export const STALE_ELIGIBLE_CACHE_TTL_MS = 60 * 60 * 1000;
export const CACHE_TARGETS: AccessSetupTarget[] = ["directoryRole", "pimGroup", "azureRole"];

let dataCacheMutationQueue: Promise<void> = Promise.resolve();

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
  return Boolean(
    entry &&
      Number.isFinite(entry.fetchedAt) &&
      age >= -5 * 60 * 1000 &&
      age < ttlMs &&
      (cacheKey === undefined || entry.cacheKey === cacheKey)
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
  return (result[DATA_CACHE_KEY] as QuickPimDataCache | undefined) || {};
}

export async function saveDataCache(cache: QuickPimDataCache): Promise<void> {
  const mutation = dataCacheMutationQueue.then(async () => {
    const current = await loadDataCache();
    await chrome.storage.local.set({ [DATA_CACHE_KEY]: mergeDataCachesForSave(current, cache) });
  });
  dataCacheMutationQueue = mutation.catch(() => undefined);
  await mutation;
}

export async function clearDataCache(): Promise<void> {
  const mutation = dataCacheMutationQueue.then(() => chrome.storage.local.remove(DATA_CACHE_KEY));
  dataCacheMutationQueue = mutation.catch(() => undefined);
  await mutation;
}

export function mergeDataCachesForSave(current: QuickPimDataCache, incoming: QuickPimDataCache): QuickPimDataCache {
  return {
    eligible: chooseCacheEntry(current.eligible, incoming.eligible),
    active: chooseCacheEntry(current.active, incoming.active),
    eligibleByTarget: mergeTargetCache(current.eligibleByTarget, incoming.eligibleByTarget),
    activeByTarget: mergeTargetCache(current.activeByTarget, incoming.activeByTarget)
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
  legacyCacheKey?: string;
  now?: number;
  freshTtlMs: number;
  usableTtlMs?: number;
}): TargetCacheStatus {
  const now = options.now ?? Date.now();
  const usableTtlMs = options.usableTtlMs ?? options.freshTtlMs;
  const entry = getTargetEntry(options.cache, options.bucket, options.target);
  if (isCacheEntryFresh(entry, usableTtlMs, now, options.cacheKey)) {
    return {
      target: options.target,
      entry: markDiagnosticsFromCache({ ...entry, errors: [] }, true),
      isFresh: isCacheEntryFresh(entry, options.freshTtlMs, now, options.cacheKey),
      isUsable: true
    };
  }

  const legacyEntry = getLegacyTargetEntry(options.cache, options.bucket, options.target);
  if (isCacheEntryFresh(legacyEntry, usableTtlMs, now, options.legacyCacheKey)) {
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
    cacheKey
  };
}

export function getTargetEntriesFromCache(
  cache: QuickPimDataCache,
  bucket: CacheBucket,
  targets: AccessSetupTarget[],
  cacheKeys: Partial<Record<AccessSetupTarget, string>>,
  options: { legacyCacheKey?: string; now?: number; freshTtlMs: number; usableTtlMs?: number }
): Partial<Record<AccessSetupTarget, TargetCacheStatus>> {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      getTargetCacheStatus({
        cache,
        bucket,
        target,
        cacheKey: cacheKeys[target],
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
        diagnostics: mergeDiagnostics(previous.diagnostics, diagnostics)
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
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : undefined;
}
