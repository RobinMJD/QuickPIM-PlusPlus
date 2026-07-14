import { buildAccessCapabilityItems, buildTargetCacheKeys } from "./access";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  getTargetCacheStatus
} from "./cache";
import { mapWithConcurrencySettled } from "./concurrency";
import type {
  AccessSetupTarget,
  QuickPimDataCache,
  TokenKind,
  TokenStatus,
  TokenStatusEntry
} from "./types";

export const ENTRA_PORTAL_TAB_PATTERN = "https://entra.microsoft.com/*";
export const PORTAL_TOKEN_RECOVERY_WINDOW_MINUTES = 10;
export const PORTAL_TAB_SCAN_TIMEOUT_MS = 6_500;
export const PORTAL_TAB_SCAN_CONCURRENCY = 4;

export interface ChromeTabsLike {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface PortalTabScanResult {
  tabsFound: number;
  tabsScanned: number;
  captured: TokenKind[];
}

export async function scanOpenEntraTabs(
  tabs: ChromeTabsLike,
  options: { timeoutMs?: number; concurrency?: number } = {}
): Promise<PortalTabScanResult> {
  let portalTabs: chrome.tabs.Tab[];
  try {
    portalTabs = await tabs.query({ url: ENTRA_PORTAL_TAB_PATTERN });
  } catch {
    return { tabsFound: 0, tabsScanned: 0, captured: [] };
  }

  const tabIds = [...new Set(
    portalTabs
      .map((tab) => tab.id)
      .filter((tabId): tabId is number => typeof tabId === "number")
  )];
  const settled = await mapWithConcurrencySettled(
    tabIds,
    options.concurrency ?? PORTAL_TAB_SCAN_CONCURRENCY,
    (tabId) => withTimeout(
      tabs.sendMessage(tabId, { action: "quickPimScanPortalTokens" }),
      options.timeoutMs ?? PORTAL_TAB_SCAN_TIMEOUT_MS
    )
  );

  const captured = new Set<TokenKind>();
  let tabsScanned = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled" || !isSuccessfulScanResponse(result.value)) {
      continue;
    }
    tabsScanned += 1;
    for (const tokenKind of result.value.data?.captured || []) {
      if (tokenKind === "graph" || tokenKind === "azureManagement") {
        captured.add(tokenKind);
      }
    }
  }

  return {
    tabsFound: tabIds.length,
    tabsScanned,
    captured: [...captured]
  };
}

export function getStaleCacheTargets(options: {
  cache: QuickPimDataCache;
  enabledTargets: AccessSetupTarget[];
  tokenStatus: TokenStatus;
  now?: number;
}): AccessSetupTarget[] {
  const now = options.now ?? Date.now();
  const cacheKeys = buildTargetCacheKeys(options.tokenStatus, options.enabledTargets);
  return options.enabledTargets.filter((target) => {
    const eligible = getTargetCacheStatus({
      cache: options.cache,
      bucket: "eligible",
      target,
      cacheKey: cacheKeys[target],
      now,
      freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS
    });
    const active = getTargetCacheStatus({
      cache: options.cache,
      bucket: "active",
      target,
      cacheKey: cacheKeys[target],
      now,
      freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
    });
    return !eligible.isFresh || !active.isFresh;
  });
}

export function getPortalTokenRecoveryTargets(options: {
  cache: QuickPimDataCache;
  enabledTargets: AccessSetupTarget[];
  staleTargets: AccessSetupTarget[];
  tokenStatus: TokenStatus;
  force?: boolean;
  now?: number;
  refreshWindowMinutes?: number;
}): AccessSetupTarget[] {
  if (options.force) {
    return [...options.enabledTargets];
  }

  const staleTargets = new Set(options.staleTargets);
  const nonReadyTargets = new Set(
    buildAccessCapabilityItems(options.tokenStatus, options.cache, options.enabledTargets)
      .filter((capability) => capability.status !== "ready")
      .map((capability) => capability.target)
  );

  return options.enabledTargets.filter((target) => {
    const token = getTargetTokenStatus(options.tokenStatus, target);
    if (tokenNeedsRecovery(
      token,
      options.now ?? Date.now(),
      options.refreshWindowMinutes ?? PORTAL_TOKEN_RECOVERY_WINDOW_MINUTES
    )) {
      return true;
    }
    return staleTargets.has(target) && nonReadyTargets.has(target);
  });
}

function getTargetTokenStatus(tokenStatus: TokenStatus, target: AccessSetupTarget): TokenStatusEntry | undefined {
  if (target === "azureRole") {
    return tokenStatus.azureManagement;
  }
  return tokenStatus.graphTargets?.[target] || tokenStatus.graph;
}

function tokenNeedsRecovery(token: TokenStatusEntry | undefined, now: number, refreshWindowMinutes: number): boolean {
  if (!token?.hasToken || token.isExpired) {
    return true;
  }
  if (typeof token.expiresInMinutes === "number") {
    return token.expiresInMinutes <= refreshWindowMinutes;
  }
  if (!token.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(token.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now <= refreshWindowMinutes * 60_000;
}

function isSuccessfulScanResponse(value: unknown): value is {
  success: true;
  data?: { captured?: TokenKind[] };
} {
  return Boolean(value && typeof value === "object" && (value as { success?: unknown }).success === true);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Portal token scan timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
