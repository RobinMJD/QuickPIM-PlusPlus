import { buildAccessCapabilityItems, buildTargetCacheKeys } from "./access";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  getTargetCacheStatus
} from "./cache";
import { mapWithConcurrencySettled } from "./concurrency";
import { withTimeout } from "./async";
import { sanitizeErrorMessage } from "./security";
import type {
  AccessSetupTarget,
  QuickPimDataCache,
  TokenKind,
  TokenStatus,
  TokenStatusEntry
} from "./types";

export const ENTRA_PORTAL_TAB_PATTERN = "https://entra.microsoft.com/*";
export const PORTAL_TOKEN_RECOVERY_WINDOW_MINUTES = 10;
export const PORTAL_TAB_SCAN_TIMEOUT_MS = 8_000;
export const PORTAL_TAB_SCAN_CONCURRENCY = 4;
export const PORTAL_TAB_QUERY_TIMEOUT_MS = 2_000;
export const PORTAL_TAB_SCAN_MAX_TABS = 64;
export const PORTAL_TOKEN_SCAN_DIAGNOSTIC_KEY = "quickPimPortalTokenScanDiagnostic.v1";

export interface ChromeTabsLike {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface PortalTabScanResult {
  tabsFound: number;
  tabsAttempted: number;
  tabsScanned: number;
  failedTabs: number;
  captured: TokenKind[];
  failureSummary?: string;
}

export interface PortalTokenScanDiagnostic extends PortalTabScanResult {
  checkedAt: string;
}

interface PortalScanStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

export async function recordPortalTokenScanDiagnostic(
  result: PortalTabScanResult,
  storage: PortalScanStorageLike = chrome.storage.local,
  now = Date.now()
): Promise<PortalTokenScanDiagnostic> {
  const diagnostic: PortalTokenScanDiagnostic = {
    checkedAt: new Date(now).toISOString(),
    tabsFound: clampScanCount(result.tabsFound),
    tabsAttempted: clampScanCount(result.tabsAttempted),
    tabsScanned: clampScanCount(result.tabsScanned),
    failedTabs: clampScanCount(result.failedTabs),
    captured: [...new Set(result.captured.filter((item) => item === "graph" || item === "azureManagement"))],
    ...(result.failureSummary ? { failureSummary: sanitizeErrorMessage(result.failureSummary, 500) } : {})
  };
  await storage.set({ [PORTAL_TOKEN_SCAN_DIAGNOSTIC_KEY]: diagnostic });
  return diagnostic;
}

export async function loadPortalTokenScanDiagnostic(
  storage: PortalScanStorageLike = chrome.storage.local
): Promise<PortalTokenScanDiagnostic | undefined> {
  const result = await storage.get(PORTAL_TOKEN_SCAN_DIAGNOSTIC_KEY);
  return sanitizePortalTokenScanDiagnostic(result[PORTAL_TOKEN_SCAN_DIAGNOSTIC_KEY]);
}

export function sanitizePortalTokenScanDiagnostic(value: unknown): PortalTokenScanDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const checkedAt = typeof record.checkedAt === "string" ? record.checkedAt : "";
  if (!Number.isFinite(Date.parse(checkedAt))) return undefined;
  return {
    checkedAt: new Date(checkedAt).toISOString(),
    tabsFound: clampScanCount(record.tabsFound),
    tabsAttempted: clampScanCount(record.tabsAttempted),
    tabsScanned: clampScanCount(record.tabsScanned),
    failedTabs: clampScanCount(record.failedTabs),
    captured: Array.isArray(record.captured)
      ? [...new Set(record.captured.filter((item): item is TokenKind => item === "graph" || item === "azureManagement"))]
      : [],
    ...(typeof record.failureSummary === "string" && record.failureSummary.trim()
      ? { failureSummary: sanitizeErrorMessage(record.failureSummary, 500) }
      : {})
  };
}

export async function scanOpenEntraTabs(
  tabs: ChromeTabsLike,
  options: { timeoutMs?: number; concurrency?: number; maxTabs?: number } = {}
): Promise<PortalTabScanResult> {
  let portalTabs: chrome.tabs.Tab[];
  try {
    portalTabs = await withTimeout(
      tabs.query({ url: ENTRA_PORTAL_TAB_PATTERN }),
      PORTAL_TAB_QUERY_TIMEOUT_MS,
      "Portal tab lookup timed out."
    );
  } catch (error) {
    return {
      tabsFound: 0,
      tabsAttempted: 0,
      tabsScanned: 0,
      failedTabs: 0,
      captured: [],
      failureSummary: sanitizeErrorMessage(error)
    };
  }

  const uniqueTabs = [...new Map(
    portalTabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number")
      .map((tab) => [tab.id, tab])
  ).values()];
  const tabIds = uniqueTabs
    .sort((a, b) => Number(isRecoveryTab(b)) - Number(isRecoveryTab(a))
      || getPortalRoutePriority(b) - getPortalRoutePriority(a)
      || Number(Boolean(b.active)) - Number(Boolean(a.active))
      || (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, options.maxTabs ?? PORTAL_TAB_SCAN_MAX_TABS)
    .map((tab) => tab.id);
  const settled = await mapWithConcurrencySettled(
    tabIds,
    options.concurrency ?? PORTAL_TAB_SCAN_CONCURRENCY,
    (tabId) => withTimeout(
      tabs.sendMessage(tabId, { action: "quickPimScanPortalTokens" }),
      options.timeoutMs ?? PORTAL_TAB_SCAN_TIMEOUT_MS,
      "Portal token scan timed out."
    )
  );

  const captured = new Set<TokenKind>();
  let tabsScanned = 0;
  const failures: string[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled" || !isSuccessfulScanResponse(result.value)) {
      failures.push(result.status === "rejected"
        ? sanitizeErrorMessage(result.reason)
        : getScanResponseFailure(result.value));
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
    tabsFound: uniqueTabs.length,
    tabsAttempted: tabIds.length,
    tabsScanned,
    failedTabs: failures.length,
    captured: [...captured],
    ...(failures.length ? { failureSummary: summarizeFailures(failures) } : {})
  };
}

function isRecoveryTab(tab: chrome.tabs.Tab): boolean {
  return (tab.url || tab.pendingUrl || "").includes("quickpimRecovery=");
}

function getPortalRoutePriority(tab: chrome.tabs.Tab): number {
  const url = (tab.url || tab.pendingUrl || "").toLowerCase();
  return Number(url.includes("activationmenublade")) * 4
    + Number(url.includes("aadmigratedroles")) * 3
    + Number(url.includes("aadgroup")) * 3
    + Number(url.includes("azurerbac")) * 3;
}

function summarizeFailures(failures: string[]): string {
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const message = sanitizeErrorMessage(failure, 180);
    counts.set(message, (counts.get(message) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([message, count]) => count > 1 ? `${message} (${count} tabs)` : message)
    .join(" ");
}

function getScanResponseFailure(value: unknown): string {
  if (value && typeof value === "object") {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return sanitizeErrorMessage(error);
  }
  return "The Microsoft portal page did not return a token-scan result.";
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
    return nonReadyTargets.has(target) && (Boolean(options.force) || staleTargets.has(target));
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
    return true;
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

function clampScanCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.min(10_000, Math.floor(count))) : 0;
}
