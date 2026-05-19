import type { CachedActivationEntry, QuickPimDataCache } from "./types";

export const DATA_CACHE_KEY = "quickPimDataCache.v1";
export const DEFAULT_ELIGIBLE_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_ACTIVE_CACHE_TTL_MS = 10 * 60 * 1000;

export function isCacheEntryFresh(
  entry: CachedActivationEntry | undefined,
  ttlMs: number,
  now = Date.now(),
  cacheKey?: string
): entry is CachedActivationEntry {
  return Boolean(entry && now - entry.fetchedAt < ttlMs && (cacheKey === undefined || entry.cacheKey === cacheKey));
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
  await chrome.storage.local.set({ [DATA_CACHE_KEY]: cache });
}

export async function clearDataCache(): Promise<void> {
  await chrome.storage.local.remove(DATA_CACHE_KEY);
}

export async function getDataWithCache(
  key: keyof QuickPimDataCache,
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
