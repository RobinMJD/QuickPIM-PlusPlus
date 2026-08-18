import { describe, expect, test, vi } from "vitest";
import {
  PORTAL_RECOVERY_GROUP_TITLE,
  PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS,
  PORTAL_RECOVERY_SESSION_KEY,
  PORTAL_RECOVERY_SESSION_TTL_MS,
  closeExpiredPortalRecoveryTabs,
  closeOrphanedPortalRecoveryTabs,
  closePortalRecoveryTabsForTargets,
  focusPortalRecoveryTabs,
  getPortalRecoveryJourneyCreatedAt,
  getPortalRecoveryStatus,
  openPortalRecoveryTabs,
  openPortalRecoveryTabsAndReconcile,
  type PortalRecoveryApis
} from "../src/lib/portalRecoveryTabs";
import { ENTRA_PORTAL_URLS } from "../src/lib/popupModel";
import type { TokenStatus } from "../src/lib/types";

function recoveryUrl(target: keyof typeof ENTRA_PORTAL_URLS, createdAt = 1000): string {
  const url = new URL(ENTRA_PORTAL_URLS[target]);
  url.searchParams.set("quickpimRecovery", `${target}.${createdAt}`);
  return url.toString();
}

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
  const tabGroups = new Map<number, chrome.tabGroups.TabGroup>();
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
  const query = vi.fn(async (queryInfo: chrome.tabs.QueryInfo = {}) => [...tabs.values()].filter((tab) =>
    queryInfo.groupId === undefined || tab.groupId === queryInfo.groupId
  ));
  const remove = vi.fn(async (tabIds: number | number[]) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      tabs.delete(tabId);
    }
  });
  const ungroup = vi.fn(async (tabIds: number | number[]) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      const tab = tabs.get(tabId);
      if (tab) tab.groupId = -1;
    }
  });
  const group = vi.fn(async (options: chrome.tabs.GroupOptions) => {
    const tabIds = (Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds])
      .filter((tabId): tabId is number => typeof tabId === "number");
    for (const tabId of tabIds) {
      const tab = tabs.get(tabId);
      if (tab) tab.groupId = 44;
    }
    tabGroups.set(44, {
      id: 44,
      collapsed: false,
      color: "grey",
      title: "",
      windowId: 7
    });
    return 44;
  });
  const update = vi.fn(async (groupId: number, properties: chrome.tabGroups.UpdateProperties) => {
    const current = tabGroups.get(groupId);
    if (!current) return undefined;
    const updated = { ...current, ...properties } as chrome.tabGroups.TabGroup;
    tabGroups.set(groupId, updated);
    return updated;
  });
  const queryGroups = vi.fn(async (queryInfo: chrome.tabGroups.QueryInfo) => [...tabGroups.values()].filter((groupInfo) =>
    queryInfo.title === undefined || groupInfo.title === queryInfo.title
  ));
  const activateTab = vi.fn(async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error("No tab");
    tab.active = updateProperties.active === true;
    return tab;
  });
  const focusWindow = vi.fn(async (windowId: number) => ({ id: windowId } as chrome.windows.Window));
  const apis: PortalRecoveryApis = {
    tabs: { create, get, query, remove, group, ungroup, update: activateTab },
    tabGroups: { update, query: queryGroups },
    windows: { update: focusWindow },
    storage: {
      get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(storageData, structuredClone(value));
      }),
      remove: vi.fn(async (key: string) => { delete storageData[key]; })
    }
  };
  return {
    apis,
    storageData,
    tabs,
    tabGroups,
    create,
    query,
    remove,
    ungroup,
    group,
    update,
    queryGroups,
    activateTab,
    focusWindow
  };
}

describe("managed portal recovery tabs", () => {
  test("opens one authentication leader, defers the other pages, and reuses the staged session", async () => {
    const fixture = createApis();

    const first = await openPortalRecoveryTabs(["directoryRole", "pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    expect(first).toEqual({ requestedCount: 2, openedCount: 1, reusedCount: 0, managedCount: 2, grouped: true, journeyCreatedAt: 1000 });
    expect(fixture.create).toHaveBeenNthCalledWith(1, { url: recoveryUrl("directoryRole"), active: false });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.group).toHaveBeenCalledWith({ tabIds: [1], createProperties: { windowId: 7 } });
    expect(fixture.update).toHaveBeenCalledWith(44, {
      title: PORTAL_RECOVERY_GROUP_TITLE,
      color: "blue",
      collapsed: true
    });

    const second = await openPortalRecoveryTabs(["directoryRole", "pimGroup"], missingTokenStatus(), fixture.apis, 1100);
    expect(second).toEqual({ requestedCount: 2, openedCount: 0, reusedCount: 2, managedCount: 2, grouped: true, journeyCreatedAt: 1000 });
    expect(fixture.create).toHaveBeenCalledTimes(1);

    fixture.tabs.get(1)!.url = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
    await expect(getPortalRecoveryStatus(fixture.apis, 1200, missingTokenStatus())).resolves.toMatchObject({
      state: "interactionRequired",
      managedTargets: ["directoryRole", "pimGroup"],
      interactionTargets: ["directoryRole"],
      interactionReason: "signIn"
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);

    fixture.tabs.get(1)!.url = ENTRA_PORTAL_URLS.directoryRole;
    await expect(getPortalRecoveryStatus(fixture.apis, 1300, missingTokenStatus())).resolves.toMatchObject({
      state: "waiting",
      managedTargets: ["directoryRole", "pimGroup"],
      interactionTargets: []
    });
    expect(fixture.create).toHaveBeenNthCalledWith(2, { url: recoveryUrl("pimGroup"), active: false, windowId: 7 });
    expect(fixture.group).toHaveBeenCalledWith({ groupId: 44, tabIds: [2] });
  });

  test("does not let an unrelated Azure token bypass staged sign-in for missing Graph targets", async () => {
    const fixture = createApis();
    const azureOnly = missingTokenStatus();
    azureOnly.azureManagement = { hasToken: true, capturedAt: 2 };

    await expect(openPortalRecoveryTabs(
      ["directoryRole", "pimGroup"],
      azureOnly,
      fixture.apis,
      1000
    )).resolves.toEqual({
      requestedCount: 2,
      openedCount: 1,
      reusedCount: 0,
      managedCount: 2,
      grouped: true,
      journeyCreatedAt: 1000
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.create).toHaveBeenCalledWith({
      url: recoveryUrl("directoryRole"),
      active: false
    });
  });

  test("ignores a recovery session dated implausibly far in the future", async () => {
    const fixture = createApis();
    fixture.storageData[PORTAL_RECOVERY_SESSION_KEY] = {
      version: 1,
      createdAt: 10 * 60_000,
      tabsByTarget: { directoryRole: 99 },
      baselineTokenSignatures: {},
      deferredTargets: []
    };

    await expect(getPortalRecoveryStatus(fixture.apis, 1000)).resolves.toEqual({
      state: "idle",
      managedTargets: [],
      interactionTargets: [],
      grouped: false
    });
    expect(fixture.apis.tabs.get).not.toHaveBeenCalled();
  });

  test("releases deferred pages when the leader captures a token without showing a sign-in prompt", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole", "pimGroup", "azureRole"], missingTokenStatus(), fixture.apis, 1000);

    await expect(getPortalRecoveryStatus(fixture.apis, 1500, readyTokenStatus())).resolves.toMatchObject({
      state: "waiting",
      managedTargets: ["directoryRole", "pimGroup", "azureRole"]
    });
    expect(fixture.create).toHaveBeenCalledTimes(3);
    expect(fixture.create).toHaveBeenNthCalledWith(2, { url: recoveryUrl("pimGroup"), active: false, windowId: 7 });
    expect(fixture.create).toHaveBeenNthCalledWith(3, { url: recoveryUrl("azureRole"), active: false, windowId: 7 });
  });

  test("keeps a failed leader candidate deferred when a later target opens", async () => {
    const fixture = createApis();
    fixture.create.mockRejectedValueOnce(new Error("Temporary tab creation failure"));

    await expect(openPortalRecoveryTabs(
      ["directoryRole", "pimGroup", "azureRole"],
      missingTokenStatus(),
      fixture.apis,
      1000
    )).resolves.toEqual({
      requestedCount: 3,
      openedCount: 1,
      reusedCount: 0,
      managedCount: 3,
      grouped: true,
      journeyCreatedAt: 1000
    });

    expect(fixture.create).toHaveBeenNthCalledWith(1, { url: recoveryUrl("directoryRole"), active: false });
    expect(fixture.create).toHaveBeenNthCalledWith(2, { url: recoveryUrl("pimGroup"), active: false });

    await getPortalRecoveryStatus(fixture.apis, 1100, readyTokenStatus());
    expect(fixture.create).toHaveBeenCalledWith({ url: recoveryUrl("directoryRole"), active: false, windowId: 7 });
    expect(fixture.create).toHaveBeenCalledWith({ url: recoveryUrl("azureRole"), active: false, windowId: 7 });
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
    expect(fixture.create).toHaveBeenLastCalledWith({ url: recoveryUrl("pimGroup"), active: false });
  });

  test("reopens one staged recovery journey after the user closes its whole group", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole", "pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.clear();

    await expect(openPortalRecoveryTabs(
      ["directoryRole", "pimGroup"],
      missingTokenStatus(),
      fixture.apis,
      1100
    )).resolves.toMatchObject({ openedCount: 1, managedCount: 2 });

    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.tabs.size).toBe(1);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toMatchObject({
      authenticationTarget: "pimGroup",
      deferredTargets: ["directoryRole"]
    });
  });

  test("reconstructs a restored recovery tab only from its exact journey marker", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);
    const original = fixture.tabs.get(1)!;
    fixture.tabs.delete(1);
    fixture.tabs.set(42, { ...original, id: 42 });
    fixture.tabs.set(43, { ...original, id: 43, url: ENTRA_PORTAL_URLS.directoryRole });

    await expect(getPortalRecoveryStatus(fixture.apis, 1100)).resolves.toMatchObject({
      state: "waiting",
      managedTargets: ["directoryRole"]
    });
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toMatchObject({
      tabsByTarget: { directoryRole: 42 }
    });
  });

  test("does not close or keep managing a recovery tab after the user navigates it elsewhere", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    fixture.tabs.get(1)!.url = "https://example.com/keep-this-page";

    await expect(closePortalRecoveryTabsForTargets(["pimGroup"], fixture.apis, 1000)).resolves.toEqual([]);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.ungroup).toHaveBeenCalledWith(1);
    expect(fixture.tabs.get(1)?.groupId).toBe(-1);
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

  test("does not invent a Microsoft prompt just because a portal page is slow", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["azureRole"], missingTokenStatus(), fixture.apis, 1000);

    await expect(getPortalRecoveryStatus(
      fixture.apis,
      1000 + PORTAL_RECOVERY_INTERACTION_TIMEOUT_MS
    )).resolves.toEqual({
      state: "waiting",
      managedTargets: ["azureRole"],
      interactionTargets: [],
      grouped: true
    });
  });

  test("keeps newly opened recovery tabs until an API check proves target capability", async () => {
    const fixture = createApis();
    const statuses = [missingTokenStatus(), readyTokenStatus()];

    await openPortalRecoveryTabsAndReconcile(
      ["directoryRole", "pimGroup", "azureRole"],
      async () => statuses.shift() || readyTokenStatus(),
      fixture.apis,
      1000
    );

    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.tabs.size).toBe(1);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeTruthy();
  });

  test("closes all completed group tabs after API refresh confirmation", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole", "pimGroup", "azureRole"], readyTokenStatus(), fixture.apis, 1000);
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

  test("keeps an expired session owned when tab removal fails and does not open duplicates", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    fixture.remove.mockRejectedValue(new Error("Tabs are temporarily locked"));

    await expect(closeExpiredPortalRecoveryTabs(
      fixture.apis,
      1000 + PORTAL_RECOVERY_SESSION_TTL_MS
    )).resolves.toEqual([]);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeTruthy();

    await expect(openPortalRecoveryTabs(
      ["pimGroup"],
      missingTokenStatus(),
      fixture.apis,
      1000 + PORTAL_RECOVERY_SESSION_TTL_MS + 1
    )).resolves.toMatchObject({ openedCount: 0, reusedCount: 1, managedCount: 1 });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.tabs.size).toBe(1);
  });

  test("opens a different requested source even when an expired tab cannot be removed", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    fixture.remove.mockRejectedValue(new Error("Tabs are temporarily locked"));

    await expect(openPortalRecoveryTabs(
      ["directoryRole"],
      missingTokenStatus(),
      fixture.apis,
      1000 + PORTAL_RECOVERY_SESSION_TTL_MS + 1
    )).resolves.toMatchObject({ openedCount: 1, reusedCount: 0, managedCount: 1 });

    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.tabs.size).toBe(2);
    await expect(getPortalRecoveryJourneyCreatedAt(
      fixture.apis,
      1000 + PORTAL_RECOVERY_SESSION_TTL_MS + 2
    )).resolves.toBe(1000 + PORTAL_RECOVERY_SESSION_TTL_MS + 1);
  });

  test("status reconciliation closes an expired session without requiring a popup refresh", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);

    await expect(getPortalRecoveryStatus(
      fixture.apis,
      1000 + PORTAL_RECOVERY_SESSION_TTL_MS
    )).resolves.toEqual({
      state: "idle",
      managedTargets: [],
      interactionTargets: [],
      grouped: false
    });
    expect(fixture.tabs.size).toBe(0);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("persists ownership immediately before grouping can yield", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);

    const firstStorageWrite = vi.mocked(fixture.apis.storage.set).mock.invocationCallOrder[0];
    const grouping = fixture.group.mock.invocationCallOrder[0];
    expect(firstStorageWrite).toBeLessThan(grouping);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeTruthy();
  });

  test("persists deferred sign-in intent before grouping can yield", async () => {
    const fixture = createApis();

    await openPortalRecoveryTabs(["directoryRole", "pimGroup"], missingTokenStatus(), fixture.apis, 1000);

    const storageSet = vi.mocked(fixture.apis.storage.set);
    const stagedWriteIndex = storageSet.mock.calls.findIndex(([value]) => {
      const session = value[PORTAL_RECOVERY_SESSION_KEY] as Record<string, unknown> | undefined;
      return session?.authenticationTarget === "directoryRole"
        && Array.isArray(session.deferredTargets)
        && session.deferredTargets.includes("pimGroup");
    });
    expect(stagedWriteIndex).toBeGreaterThanOrEqual(0);
    expect(storageSet.mock.invocationCallOrder[stagedWriteIndex]).toBeLessThan(
      fixture.group.mock.invocationCallOrder[0]
    );
  });

  test("keeps durable ownership and intent when grouping metadata cannot be saved", async () => {
    const fixture = createApis();
    const storageSet = vi.mocked(fixture.apis.storage.set);
    storageSet.mockImplementation(async (value: Record<string, unknown>) => {
      if (storageSet.mock.calls.length >= 3) {
        throw new Error("Final group metadata save failed");
      }
      Object.assign(fixture.storageData, structuredClone(value));
    });

    await expect(openPortalRecoveryTabs(
      ["directoryRole", "pimGroup"],
      missingTokenStatus(),
      fixture.apis,
      1000
    )).resolves.toMatchObject({ openedCount: 1, managedCount: 2, grouped: true });
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toMatchObject({
      tabsByTarget: { directoryRole: 1 },
      authenticationTarget: "directoryRole",
      deferredTargets: ["pimGroup"]
    });
  });

  test("keeps a created tab owned when browser grouping fails", async () => {
    const fixture = createApis();
    fixture.group.mockRejectedValue(new Error("Tab grouping unavailable"));

    await expect(openPortalRecoveryTabs(
      ["directoryRole"],
      missingTokenStatus(),
      fixture.apis,
      1000
    )).resolves.toEqual({
      requestedCount: 1,
      openedCount: 1,
      reusedCount: 0,
      managedCount: 1,
      grouped: false,
      journeyCreatedAt: 1000
    });
    expect(fixture.tabs.size).toBe(1);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toMatchObject({
      tabsByTarget: { directoryRole: 1 }
    });

    await expect(closePortalRecoveryTabsForTargets(
      ["directoryRole"],
      fixture.apis,
      1000
    )).resolves.toEqual(["directoryRole"]);
    expect(fixture.tabs.size).toBe(0);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("keeps only failed tab removals owned and finishes them on retry", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(
      ["directoryRole", "pimGroup", "azureRole"],
      readyTokenStatus(),
      fixture.apis,
      1000
    );
    const remove = fixture.remove;
    remove.mockImplementation(async (tabIds: number | number[]) => {
      if (Array.isArray(tabIds)) {
        throw new Error("Batch close failed");
      }
      if (tabIds === 2) {
        throw new Error("PIM Groups tab is temporarily locked");
      }
      fixture.tabs.delete(tabIds);
    });

    await expect(closePortalRecoveryTabsForTargets(
      ["directoryRole", "pimGroup", "azureRole"],
      fixture.apis,
      1000
    )).resolves.toEqual(["directoryRole", "azureRole"]);
    expect([...fixture.tabs.keys()]).toEqual([2]);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toMatchObject({
      tabsByTarget: { pimGroup: 2 }
    });

    remove.mockImplementation(async (tabIds: number | number[]) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        fixture.tabs.delete(tabId);
      }
    });
    await expect(closePortalRecoveryTabsForTargets(
      ["pimGroup"],
      fixture.apis,
      1000
    )).resolves.toEqual(["pimGroup"]);
    expect(fixture.tabs.size).toBe(0);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });

  test("closes a newly created tab if durable ownership cannot be persisted", async () => {
    const fixture = createApis();
    vi.mocked(fixture.apis.storage.set).mockRejectedValue(new Error("Storage unavailable"));

    await expect(openPortalRecoveryTabs(
      ["directoryRole"],
      missingTokenStatus(),
      fixture.apis,
      1000
    )).resolves.toMatchObject({ openedCount: 0, managedCount: 0 });
    expect(fixture.remove).toHaveBeenCalledWith(1);
    expect(fixture.tabs.size).toBe(0);
  });

  test("removes an orphaned exact QuickPIM++ recovery group after a worker restart", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);
    delete fixture.storageData[PORTAL_RECOVERY_SESSION_KEY];

    await expect(closeOrphanedPortalRecoveryTabs(fixture.apis, 1100)).resolves.toEqual([1]);
    expect(fixture.tabs.size).toBe(0);
  });

  test("never treats tabs from the active recovery group as orphans", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["directoryRole"], missingTokenStatus(), fixture.apis, 1000);

    await expect(closeOrphanedPortalRecoveryTabs(fixture.apis, 1100)).resolves.toEqual([]);
    expect(fixture.tabs.size).toBe(1);
  });

  test("does not let a stale verifier close a newer recovery journey", async () => {
    const fixture = createApis();
    await openPortalRecoveryTabs(["pimGroup"], missingTokenStatus(), fixture.apis, 1000);
    await expect(getPortalRecoveryJourneyCreatedAt(fixture.apis, 1100)).resolves.toBe(1000);

    await expect(closePortalRecoveryTabsForTargets(
      ["pimGroup"],
      fixture.apis,
      999
    )).resolves.toEqual([]);
    expect(fixture.tabs.size).toBe(1);
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeTruthy();
  });

  test("removes malformed durable ownership records instead of retrying them forever", async () => {
    const fixture = createApis();
    fixture.storageData[PORTAL_RECOVERY_SESSION_KEY] = { version: 99, createdAt: 1000 };

    await expect(getPortalRecoveryJourneyCreatedAt(fixture.apis, 1100)).resolves.toBeUndefined();
    expect(fixture.storageData[PORTAL_RECOVERY_SESSION_KEY]).toBeUndefined();
  });
});
