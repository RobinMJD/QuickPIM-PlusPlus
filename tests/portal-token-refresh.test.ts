import { describe, expect, test, vi } from "vitest";
import {
  getPortalTokenRecoveryTargets,
  scanOpenEntraTabs,
  type ChromeTabsLike
} from "../src/lib/portalTokenRefresh";
import { buildTargetCacheKey } from "../src/lib/access";
import type { QuickPimDataCache, TokenStatus } from "../src/lib/types";

const now = Date.parse("2026-07-14T10:00:00.000Z");

describe("portal token background refresh", () => {
  test("scans each open Entra tab once and tolerates unavailable content scripts", async () => {
    const tabs: ChromeTabsLike = {
      query: vi.fn(async () => [
        { id: 11 } as chrome.tabs.Tab,
        { id: 11 } as chrome.tabs.Tab,
        { id: 12 } as chrome.tabs.Tab,
        {} as chrome.tabs.Tab
      ]),
      sendMessage: vi.fn(async (tabId: number) => {
        if (tabId === 12) {
          throw new Error("No receiving end");
        }
        return { success: true, data: { captured: ["graph", "azureManagement"] } };
      })
    };

    await expect(scanOpenEntraTabs(tabs)).resolves.toEqual({
      tabsFound: 2,
      tabsScanned: 1,
      captured: ["graph", "azureManagement"]
    });
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(tabs.sendMessage).toHaveBeenCalledWith(11, { action: "quickPimScanPortalTokens" });
  });

  test("bounds portal scanning and prioritizes active and recently used tabs", async () => {
    const portalTabs = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      active: index === 8,
      lastAccessed: index * 100
    })) as chrome.tabs.Tab[];
    const sendMessage = vi.fn(async (_tabId: number, _message: unknown) => ({ success: true, data: { captured: [] } }));
    const tabs: ChromeTabsLike = {
      query: vi.fn(async () => portalTabs),
      sendMessage
    };

    await expect(scanOpenEntraTabs(tabs, { maxTabs: 3 })).resolves.toEqual({
      tabsFound: 10,
      tabsScanned: 3,
      captured: []
    });
    expect(sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([9, 10, 8]);
  });

  test("recovers missing and near-expiry tokens without rescanning healthy targets", () => {
    const tokenStatus: TokenStatus = {
      graph: { hasToken: true, expiresAt: "2026-07-14T12:00:00.000Z" },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          expiresAt: "2026-07-14T10:08:00.000Z",
          grantedScopes: ["RoleAssignmentSchedule.ReadWrite.Directory"]
        },
        pimGroup: {
          hasToken: false
        }
      },
      azureManagement: { hasToken: true, expiresAt: "2026-07-14T12:00:00.000Z" }
    };

    expect(getPortalTokenRecoveryTargets({
      cache: {},
      enabledTargets: ["directoryRole", "pimGroup", "azureRole"],
      staleTargets: [],
      tokenStatus,
      now
    })).toEqual(["directoryRole", "pimGroup"]);
  });

  test("retries a limited target only when its cached data is stale", () => {
    const tokenStatus = healthyTokenStatus();
    const limitedEntry = {
      items: [],
      errors: ["PermissionScopeNotGranted"],
      fetchedAt: now,
      diagnostics: [{
        target: "pimGroup" as const,
        success: false,
        checkedAt: new Date(now).toISOString(),
        failureKind: "missingCapability" as const,
        error: "PIM group access is limited."
      }]
    };
    const cache: QuickPimDataCache = {
      eligibleByTarget: { pimGroup: limitedEntry },
      activeByTarget: { pimGroup: limitedEntry }
    };

    expect(getPortalTokenRecoveryTargets({
      cache,
      enabledTargets: ["pimGroup", "azureRole"],
      staleTargets: ["pimGroup"],
      tokenStatus,
      now
    })).toEqual(["pimGroup"]);
    expect(getPortalTokenRecoveryTargets({
      cache,
      enabledTargets: ["pimGroup", "azureRole"],
      staleTargets: [],
      tokenStatus,
      now
    })).toEqual([]);
    expect(getPortalTokenRecoveryTargets({
      cache,
      enabledTargets: ["pimGroup", "azureRole"],
      staleTargets: [],
      tokenStatus,
      force: true,
      now
    })).toEqual(["pimGroup"]);
  });

  test("does not rescan healthy ready tokens during a forced data refresh", () => {
    const tokenStatus = healthyTokenStatus();
    const readyEntry = {
      items: [],
      errors: [],
      fetchedAt: now,
      cacheKey: buildTargetCacheKey(tokenStatus, "directoryRole"),
      diagnostics: [{
        target: "directoryRole" as const,
        success: true,
        checkedAt: new Date(now).toISOString(),
        operation: "eligible" as const
      }]
    };
    const cache: QuickPimDataCache = {
      eligibleByTarget: { directoryRole: readyEntry },
      activeByTarget: { directoryRole: readyEntry }
    };

    expect(getPortalTokenRecoveryTargets({
      cache,
      enabledTargets: ["directoryRole"],
      staleTargets: ["directoryRole"],
      tokenStatus,
      force: true,
      now
    })).toEqual([]);
  });
});

function healthyTokenStatus(): TokenStatus {
  return {
    graph: { hasToken: true, expiresAt: "2026-07-14T12:00:00.000Z" },
    graphTargets: {
      directoryRole: {
        hasToken: true,
        expiresAt: "2026-07-14T12:00:00.000Z",
        grantedScopes: ["RoleAssignmentSchedule.ReadWrite.Directory"]
      },
      pimGroup: {
        hasToken: true,
        expiresAt: "2026-07-14T12:00:00.000Z",
        grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
      }
    },
    azureManagement: { hasToken: true, expiresAt: "2026-07-14T12:00:00.000Z" }
  };
}
