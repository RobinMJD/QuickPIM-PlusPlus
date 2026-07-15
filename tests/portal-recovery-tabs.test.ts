import { describe, expect, test, vi } from "vitest";
import {
  PORTAL_RECOVERY_GROUP_TITLE,
  PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS,
  PORTAL_RECOVERY_SESSION_KEY,
  PORTAL_RECOVERY_SESSION_TTL_MS,
  closeCompletedPortalRecoveryTabs,
  closeExpiredPortalRecoveryTabs,
  closePortalRecoveryTabsForTargets,
  focusPortalRecoveryTabs,
  getPortalRecoveryStatus,
  openPortalRecoveryTabs,
  openPortalRecoveryTabsAndReconcile,
  type PortalRecoveryApis
} from "../src/lib/portalRecoveryTabs";
import { ENTRA_PORTAL_URLS } from "../src/lib/popupModel";
import type { TokenStatus } from "../src/lib/types";

function missingTokenStatus(): TokenStatus {
  return {
    graph: { hasToken: false },
    graphTargets: {
      directoryRole: { hasToken: false },
      pimGroup: { hasToken: false }
    },
    azureManagement: { hasToken: false }
  };
}

function readyTokenStatus(overrides: Partial<TokenStatus> = {}): TokenStatus {
  return {
    graph: { hasToken: true, capturedAt: 2 },
    graphTargets: {
      directoryRole: {
        hasToken: true,
        capturedAt: 2,
        grantedScopes: ["RoleAssignmentSchedule.ReadWrite.Directory"]
      },
      pimGroup: {
        hasToken: true,
        capturedAt: 2,
        grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
      }
    },
    azureManagement: { hasToken: true, capturedAt: 2 },
    ...overrides
  };
}

function createApis() {
  const storageData: Record<string, unknown> = {};
  const tabs = new Map<number, chrome.tabs.Tab>();
  let nextTabId = 1;
  const create = vi.fn(async (properties: chrome.tabs.CreateProperties) => {
    const tab = {
      id: nextTabId++,
      index: tabs.size,
      pinned: false,
      highlighted: false,
      windowId: properties.windowId ?? 7,
      active: Boolean(properties.active),
      incognito: false,
      selected: Boolean(properties.active),
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      url: properties.url
    } as chrome.tabs.Tab;
    tabs.set(tab.id!, tab);
    return tab;
  });
  const get = vi.fn(async (tabId: number) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error("No tab");
    return tab;
  });
  const remove = vi.fn(async (tabIds: number | number[]) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      tabs.delete(tabId);
    }
  });
  const group = vi.fn(async (options: chrome.tabs.GroupOptions) => {
    const tabIds = (Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds])
      .filter((tabId): tabId is number => typeof tabId === "number");
    for (const tabId of tabIds) {
      const tab = tabs.get(tabId);
      if (tab) tab.groupId = 44;
    }
    return 44;
  });
  const update = vi.fn(async () => undefined);
  const activateTab = vi.fn(async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error("No tab");
    tab.active = updateProperties.active === true;
    return tab;
  });
  const focusWindow = vi.fn(async (windowId: number) => ({ id: windowId } as chrome.windows.Window));
  const apis: PortalRecoveryApis = {
    tabs: { create, get, remove, group, update: activateTab },
    tabGroups: { update },
    windows: { update: focusWindow },
    storage: {
      get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(storageData, value); }),
      remove: vi.fn(async (key: string) => { delete storageData[key]; })
    }
  };
  return { apis, storageData, tabs, create, remove, group, update, activateTab, focusWindow };
}

describe("managed portal recovery tabs", () => {
  test("opens inactive pages in a collapsed named group and reuses them", async () => {
    const fixture = createApis();

    const first = await openPortalRecoveryTabs(["directoryRole", "pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    expect(first).toEqual({ requestedCount: 2, openedCount: 2, reusedCount: 0, managedCount: 2, grouped: true });
    expect(fixture.create).toHaveBeenNthCalledWith(1, { url: ENTRA_PORTAL_URLS.directoryRole, active: false });
    expect(fixture.create).toHaveBeenNthCalledWith(2, { url: ENTRA_PORTAL_URLS.pimGroup, active: false, windowId: 7 });
    expect(fixture.group).toHaveBeenCalledWith({ tabIds: [1, 2], createProperties: { windowId: 7 } });
    expect(fixture.update).toHaveBeenCalledWith(44, {
      title: PORTAL_RECOVERY_GROUP_TITLE,
      color: "blue",
      collapsed: true
    });

    const second = await openPortalRecoveryTabs(["directoryRole", "pimGroup"], missingTokenStatus(), fixture.apis, 1100);
    expect(second).toEqual({ requestedCount: 2, openedCount: 0, reusedCount: 2, managedCount: 2, grouped: true });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  test("drops a stale browser window before recreating closed recovery tabs", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.clear();

    const recreatedTab = {
      id: 20,
      index: 0,
      pinned: false,
      highlighted: false,
      windowId: 9,
      active: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      url: ENTRA_PORTAL_URLS.pimGroup
    } as chrome.tabs.Tab;
    fixture.create.mockImplementation(async (properties) => {
      if (properties.windowId !== undefined) {
        throw new Error("No window with id");
      }
      fixture.tabs.set(recreatedTab.id!, recreatedTab);
      return recreatedTab;
    });

    await expect(openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1100)).resolves.toMatchObject({
      openedCount: 1,
      managedCount: 1
    });
    expect(fixture.create).toHaveBeenLastCalledWith({ url: ENTRA_PORTAL_URLS.pimGroup, active: false });
  });

  test("closes only the targets that receive a newer usable token", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole", "azureRole"], missingTokenStatus(), fixture.apis, 1000);

    const graphOnly = readyTokenStatus({ azureManagement: { hasToken: false } });
    await expect(closeCompletedPortalRecoveryTabs(graphOnly, fixture.apis)).resolves.toEqual(["directoryRole"]);
    expect(fixture.remove).toHaveBeenCalledWith([1]);
    expect(fixture.tabs.has(2)).toBe(true);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeTruthy();

    await expect(closeCompletedPortalRecoveryTabs(readyTokenStatus(), fixture.apis)).resolves.toEqual(["azureRole"]);
    expect(fixture.remove).toHaveBeenCalledWith([2]);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("does not close or keep managing a recovery tab after the user navigates it elsewhere", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.get(1)!.url = "https://example.com/keep-this-page";

    await expect(closeCompletedPortalRecoveryTabs(readyTokenStatus(), fixture.apis)).resolves.toEqual([]);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.tabs.has(1)).toBe(true);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("keeps an extension-created tab tracked when a sign-in redirect hides its URL", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.get(1)!.url = undefined;
    fixture.tabs.get(1)!.pendingUrl = undefined;

    await expect(getPortalRecoveryStatus(fixture.apis, 1100)).resolves.toEqual({
      state: "interactionRequired",
      managedTargets: ["directoryRole"],
      interactionTargets: ["directoryRole"],
      grouped: true,
      interactionReason: "signIn"
    });
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeTruthy();
  });

  test("recognizes an explicit Microsoft account prompt and focuses its managed group", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.get(1)!.url = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";

    const result = await focusPortalRecoveryTabs(fixture.apis, 1100);

    expect(result.focused).toBe(true);
    expect(result.status.state).toBe("interactionRequired");
    expect(result.status.interactionReason).toBe("signIn");
    expect(fixture.update).toHaveBeenLastCalledWith(44, expect.objectContaining({ collapsed: false }));
    expect(fixture.activateTab).toHaveBeenCalledWith(1, { active: true });
    expect(fixture.focusWindow).toHaveBeenCalledWith(7, { focused: true });
  });

  test("requests attention after a portal page waits too long without producing a token", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["azureRole"], missingTokenStatus(), fixture.apis, 1000);

    await expect(getPortalRecoveryStatus(
      fixture.apis,
      1000 + PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS
    )).resolves.toEqual({
      state: "interactionRequired",
      managedTargets: ["azureRole"],
      interactionTargets: ["azureRole"],
      grouped: true,
      interactionReason: "microsoftPrompt"
    });
  });

  test("keeps a PIM group page open for a read-only token", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    const readOnly = readyTokenStatus({
      graphTargets: {
        pimGroup: {
          hasToken: true,
          capturedAt: 2,
          grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup"]
        }
      }
    });

    await expect(closeCompletedPortalRecoveryTabs(readOnly, fixture.apis)).resolves.toEqual([]);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  test("reconciles tokens captured while the recovery session is still opening", async () => {
    const fixture = createApis();
    const statuses = [missingTokenStatus(), readyTokenStatus()];

    await openPortalRecoveryTabsAndReconcile(
      ["directoryRole", "pimGroup", "azureRole"],
      async () => statuses.shift() || readyTokenStatus(),
      fixture.apis,
      1000
    );

    expect(fixture.remove).toHaveBeenCalledWith([1, 2, 3]);
    expect(fixture.tabs.size).toBe(0);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("closes all completed group tabs after API refresh confirmation", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole", "pimGroup", "azureRole"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.get(1)!.url = "https://entra.microsoft.com/?feature.msaljs=true#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles/provider/azurerbac";
    fixture.tabs.get(2)!.url = "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadgroup/provider/azurerbac";

    await expect(closePortalRecoveryTabsForTargets(
      ["directoryRole", "pimGroup", "azureRole"],
      fixture.apis
    )).resolves.toEqual(["directoryRole", "pimGroup", "azureRole"]);
    expect(fixture.remove).toHaveBeenCalledWith([1, 2, 3]);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("closes an abandoned recovery group after the safety timeout", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);

    await expect(closeExpiredPortalRecoveryTabs(fixture.apis, 1000 + PORTAL_RECOVERY_SESSION_TTL_MS - 1)).resolves.toEqual([]);
    await expect(closeExpiredPortalRecoveryTabs(fixture.apis, 1000 + PORTAL_RECOVERY_SESSION_TTL_MS)).resolves.toEqual(["pimGroup"]);
    expect(fixture.tabs.size).toBe(0);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });
});
