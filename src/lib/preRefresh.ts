import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS,
  getTargetCacheStatus
} from "./cache";
import { buildTargetCacheKeys } from "./access";
import type { AccessSetupTarget, QuickPimDataCache, TokenStatus } from "./types";

export interface ChromeAlarmsLike {
  create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): Promise<void> | void;
  clear(name: string): Promise<boolean> | boolean;
}

export const PRE_REFRESH_ALARM_NAME = "quickPimPreRefresh";
export const PRE_REFRESH_PERIOD_MINUTES = 10;

export async function syncPreRefreshAlarm(alarms: ChromeAlarmsLike, enabled: boolean): Promise<void> {
  if (enabled) {
    await alarms.create(PRE_REFRESH_ALARM_NAME, { periodInMinutes: PRE_REFRESH_PERIOD_MINUTES });
    return;
  }
  await alarms.clear(PRE_REFRESH_ALARM_NAME);
}

export function shouldSkipPreRefresh(tokenStatus: TokenStatus | null | undefined): boolean {
  if (!tokenStatus) {
    return true;
  }
  const graphReady = tokenStatus.graph.hasToken && !tokenStatus.graph.isExpired;
  const directoryReady = tokenStatus.graphTargets?.directoryRole?.hasToken && !tokenStatus.graphTargets.directoryRole.isExpired;
  const pimReady = tokenStatus.graphTargets?.pimGroup?.hasToken && !tokenStatus.graphTargets.pimGroup.isExpired;
  const azureReady = tokenStatus.azureManagement.hasToken && !tokenStatus.azureManagement.isExpired;
  return !graphReady && !directoryReady && !pimReady && !azureReady;
}

export function getPreRefreshTargets(options: {
  cache: QuickPimDataCache;
  enabledTargets: AccessSetupTarget[];
  tokenStatus: TokenStatus;
  now?: number;
}): AccessSetupTarget[] {
  const now = options.now ?? Date.now();
  const targetCacheKeys = buildTargetCacheKeys(options.tokenStatus, options.enabledTargets);

  return options.enabledTargets.filter((target) => {
    if (!hasUsableTokenForTarget(options.tokenStatus, target)) {
      return false;
    }
    const eligible = getTargetCacheStatus({
      cache: options.cache,
      bucket: "eligible",
      target,
      cacheKey: targetCacheKeys[target],
      now,
      freshTtlMs: DEFAULT_ELIGIBLE_CACHE_TTL_MS
    });
    const active = getTargetCacheStatus({
      cache: options.cache,
      bucket: "active",
      target,
      cacheKey: targetCacheKeys[target],
      now,
      freshTtlMs: DEFAULT_ACTIVE_CACHE_TTL_MS
    });
    return !eligible.isFresh || !active.isFresh;
  });
}

function hasUsableTokenForTarget(tokenStatus: TokenStatus, target: AccessSetupTarget): boolean {
  if (target === "azureRole") {
    return Boolean(tokenStatus.azureManagement.hasToken && !tokenStatus.azureManagement.isExpired);
  }
  const targetStatus = tokenStatus.graphTargets?.[target] || tokenStatus.graph;
  return Boolean(targetStatus?.hasToken && !targetStatus.isExpired);
}
