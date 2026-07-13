import { describe, expect, test, vi } from "vitest";
import {
  PRE_REFRESH_ALARM_NAME,
  PRE_REFRESH_PERIOD_MINUTES,
  getPreRefreshTargets,
  shouldSkipPreRefresh,
  syncPreRefreshAlarm,
  type ChromeAlarmsLike
} from "../src/lib/preRefresh";
import {
  DEFAULT_ACTIVE_CACHE_TTL_MS,
  DEFAULT_ELIGIBLE_CACHE_TTL_MS
} from "../src/lib/cache";
import type { QuickPimDataCache, TokenStatus } from "../src/lib/types";

const now = Date.parse("2026-05-18T12:00:00.000Z");
const tokenStatus: TokenStatus = {
  graph: { hasToken: true, isExpired: false, expiresAt: "2026-05-18T14:00:00.000Z" },
  graphTargets: {
    directoryRole: { hasToken: true, isExpired: false, expiresAt: "2026-05-18T14:00:00.000Z" },
    pimGroup: { hasToken: true, isExpired: false, expiresAt: "2026-05-18T14:00:00.000Z" }
  },
  azureManagement: { hasToken: true, isExpired: false, expiresAt: "2026-05-18T14:00:00.000Z" }
};

describe("background pre-refresh", () => {
  test("creates or clears the Chrome alarm from the preference", async () => {
    const alarms = makeAlarms();

    await syncPreRefreshAlarm(alarms, true);
    expect(alarms.create).toHaveBeenCalledWith(PRE_REFRESH_ALARM_NAME, {
      periodInMinutes: PRE_REFRESH_PERIOD_MINUTES
    });

    await syncPreRefreshAlarm(alarms, false);
    expect(alarms.clear).toHaveBeenCalledWith(PRE_REFRESH_ALARM_NAME);
  });

  test("does not postpone an already-correct recurring alarm", async () => {
    const alarms = makeAlarms({ name: PRE_REFRESH_ALARM_NAME, scheduledTime: now, periodInMinutes: PRE_REFRESH_PERIOD_MINUTES });
    await syncPreRefreshAlarm(alarms, true);
    expect(alarms.create).not.toHaveBeenCalled();
  });

  test("skips pre-refresh when no valid tokens are available", () => {
    expect(shouldSkipPreRefresh({ graph: { hasToken: false }, azureManagement: { hasToken: false } })).toBe(true);
    expect(shouldSkipPreRefresh(tokenStatus)).toBe(false);
  });

  test("refreshes only enabled targets with stale eligible or active cache", () => {
    const cache: QuickPimDataCache = {
      eligibleByTarget: {
        directoryRole: { items: [], errors: [], fetchedAt: now - DEFAULT_ELIGIBLE_CACHE_TTL_MS + 10_000, cacheKey: "graphDirectory:2026-05-18T14:00:00.000Z:" },
        pimGroup: { items: [], errors: [], fetchedAt: now - DEFAULT_ELIGIBLE_CACHE_TTL_MS - 10_000, cacheKey: "graphPimGroup:2026-05-18T14:00:00.000Z:" },
        azureRole: { items: [], errors: [], fetchedAt: now - 60_000, cacheKey: "azure:2026-05-18T14:00:00.000Z:" }
      },
      activeByTarget: {
        directoryRole: { items: [], errors: [], fetchedAt: now - DEFAULT_ACTIVE_CACHE_TTL_MS - 10_000, cacheKey: "graphDirectory:2026-05-18T14:00:00.000Z:" },
        pimGroup: { items: [], errors: [], fetchedAt: now - 60_000, cacheKey: "graphPimGroup:2026-05-18T14:00:00.000Z:" },
        azureRole: { items: [], errors: [], fetchedAt: now - 60_000, cacheKey: "azure:2026-05-18T14:00:00.000Z:" }
      }
    };

    expect(getPreRefreshTargets({ cache, enabledTargets: ["directoryRole", "pimGroup"], tokenStatus, now })).toEqual([
      "directoryRole",
      "pimGroup"
    ]);
  });
});

function makeAlarms(existing?: chrome.alarms.Alarm): ChromeAlarmsLike {
  return {
    get: vi.fn(async () => existing),
    create: vi.fn(async () => undefined),
    clear: vi.fn(async () => true)
  };
}
