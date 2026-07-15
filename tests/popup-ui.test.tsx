import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_KEY } from "../src/lib/cache";
import { buildTargetCacheKey } from "../src/lib/access";
import { POPUP_DRAFT_KEY } from "../src/lib/popupDraft";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";
import { MAX_USER_JUSTIFICATION_LENGTH } from "../src/lib/justifications";
import type { ActivationItem } from "../src/lib/types";

afterEach(() => {
  const cleanupWindow = window as Window & { __quickPimPopupUnmount?: () => void };
  cleanupWindow.__quickPimPopupUnmount?.();
  cleanupWindow.__quickPimPopupUnmount = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.body.className = "";
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void | boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = assertion();
      if (result !== false) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for assertion.");
}

function clickButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return button;
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("popup loading UI", () => {
  test("shows only one loading access message while data is loading", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligible = deferred<{ success: true; data: { items: []; errors: [] } }>();
    const active = deferred<{ success: true; data: { items: []; errors: [] } }>();
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return eligible.promise;
          }
          if (message.action === "getActiveItems") {
            return active.promise;
          }
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: true });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");
    await waitFor(() => expect(document.querySelector(".progress-track")).toBeTruthy());

    expect(document.body.textContent?.match(/Loading access/g) || []).toHaveLength(1);
    expect(document.body.textContent).toContain("Loading access data");
    expect(document.body.textContent).toContain("Step");
    expect(document.body.textContent).toContain("This can take up to 15 seconds");
    expect(document.body.textContent).not.toContain("Loading access data (this can take up to 15 seconds)");
    const progressTrack = document.querySelector<HTMLElement>('[role="progressbar"]');
    expect(progressTrack).toBeTruthy();
    const firstPercent = Number(progressTrack?.getAttribute("aria-valuenow"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const laterPercent = Number(progressTrack?.getAttribute("aria-valuenow"));
    expect(laterPercent).toBeGreaterThan(firstPercent);

    eligible.resolve({ success: true, data: { items: [], errors: [] } });
    active.resolve({ success: true, data: { items: [], errors: [] } });
  });

  test("loads role types in parallel and renders the first completed tab immediately", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const directorySnapshot = deferred<{ success: true; data: {
      eligible: { items: ActivationItem[]; errors: []; diagnostics: [] };
      active: { items: ActivationItem[]; errors: []; diagnostics: [] };
    } }>();
    const pimGroupSnapshot = deferred<{ success: true; data: {
      eligible: { items: ActivationItem[]; errors: []; diagnostics: [] };
      active: { items: ActivationItem[]; errors: []; diagnostics: [] };
    } }>();
    const azureSnapshot = deferred<{ success: true; data: {
      eligible: { items: ActivationItem[]; errors: []; diagnostics: [] };
      active: { items: ActivationItem[]; errors: []; diagnostics: [] };
    } }>();
    const snapshots = {
      directoryRole: directorySnapshot,
      pimGroup: pimGroupSnapshot,
      azureRole: azureSnapshot
    };
    const entraRole: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const pimGroup: ActivationItem = {
      id: "pimGroup:group-1:member",
      type: "pimGroup",
      sourceName: "Privileged Group",
      displayName: "Privileged Group",
      principalId: "principal-1",
      scopeLabel: "Member",
      status: "eligible",
      groupId: "group-1",
      accessId: "member"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          autoEnabledFeaturesInitialized: true
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string; targets?: Array<keyof typeof snapshots> }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: {
            graph: { hasToken: true, isExpired: false },
            azureManagement: { hasToken: true, isExpired: false }
          }
        });
      }
      if (message.action === "getActivationSnapshot") {
        return snapshots[message.targets![0]].promise;
      }
      return Promise.resolve({ success: true, data: true });
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => {
      const calls = sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.action === "getActivationSnapshot");
      expect(calls).toHaveLength(3);
      expect(calls.map((message) => message.targets?.[0])).toEqual(expect.arrayContaining(["directoryRole", "pimGroup", "azureRole"]));
    });

    directorySnapshot.resolve({
      success: true,
      data: {
        eligible: { items: [entraRole], errors: [], diagnostics: [] },
        active: { items: [], errors: [], diagnostics: [] }
      }
    });
    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(document.body.textContent).not.toContain("Loading access data");
    expect(document.querySelector(".refresh-progress-panel")?.textContent).toContain("Entra Roles ready (1/3)");

    pimGroupSnapshot.resolve({
      success: true,
      data: {
        eligible: { items: [pimGroup], errors: [], diagnostics: [] },
        active: { items: [], errors: [], diagnostics: [] }
      }
    });
    clickButton("PIM Groups");
    await waitFor(() => expect(document.body.textContent).toContain("Privileged Group"));
    expect(document.querySelector(".refresh-progress-panel")).toBeTruthy();

    azureSnapshot.resolve({
      success: true,
      data: {
        eligible: { items: [], errors: [], diagnostics: [] },
        active: { items: [], errors: [], diagnostics: [] }
      }
    });
    await waitFor(() => expect(document.querySelector(".refresh-progress-panel")).toBeFalsy());
  });

  test("keeps successful role data when another parallel source fails", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const directorySnapshot = deferred<{ success: true; data: {
      eligible: { items: ActivationItem[]; errors: []; diagnostics: [] };
      active: { items: ActivationItem[]; errors: []; diagnostics: [] };
    } }>();
    const entraRole: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole", "pimGroup", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string; targets?: string[] }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: {
            graph: { hasToken: true, isExpired: false },
            azureManagement: { hasToken: false }
          }
        });
      }
      if (message.action === "getActivationSnapshot" && message.targets?.[0] === "directoryRole") {
        return directorySnapshot.promise;
      }
      if (message.targets?.[0] === "pimGroup") {
        return Promise.resolve({ success: false, error: "Network unavailable" });
      }
      return Promise.resolve({ success: true, data: true });
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => {
      const targetCalls = sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.action === "getActivationSnapshot")
        .map((message) => message.targets?.[0]);
      expect(targetCalls).toEqual(expect.arrayContaining(["directoryRole", "pimGroup"]));
    });
    directorySnapshot.resolve({
      success: true,
      data: {
        eligible: { items: [entraRole], errors: [], diagnostics: [] },
        active: { items: [], errors: [], diagnostics: [] }
      }
    });

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    await waitFor(() => expect(document.body.textContent).toContain("PIM Groups: Network unavailable"));
    const failedProgress = document.querySelector(".refresh-progress-panel");
    expect(failedProgress?.classList.contains("error")).toBe(true);
    expect(failedProgress?.textContent).toContain("Step 5/5");
    expect(failedProgress?.textContent).toContain("Refresh completed with an issue");
  });
});

describe("popup compact controls", () => {
  test("does not show cached-data debug messages to the user", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getActivationItems" || message.action === "getActiveItems") {
            throw new Error("Popup should use cached activation data.");
          }
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: true });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Load your PIM roles"));
    expect(document.body.textContent).not.toContain("Using cached data");
  });

  test("renders fresh per-feature cache immediately without blocking or fetching", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: "graphDirectory:missing",
            errors: [],
            items: [eligibleItem]
          }
        },
        activeByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: "graphDirectory:missing",
            errors: [],
            items: []
          },
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: "graphPimGroup:missing",
            errors: [],
            items: []
          },
          azureRole: {
            fetchedAt: Date.now(),
            cacheKey: "azure:missing",
            errors: [],
            items: []
          }
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: {
            graph: { hasToken: false },
            azureManagement: { hasToken: false }
          }
        });
      }
      throw new Error("Fresh cache should not fetch activation data.");
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(document.body.textContent).not.toContain("Loading access data");
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "getActivationSnapshot" }));
  });

  test("renders cached data before renewing a near-expiry token and avoids an unnecessary role refetch", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const initialTokens = {
      graph: { hasToken: true, tenantId: "tenant-1", principalId: "principal-1" },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          tenantId: "tenant-1",
          principalId: "principal-1",
          expiresInMinutes: 5,
          expiresAt: "2026-07-14T10:05:00.000Z",
          grantedScopes: ["RoleAssignmentSchedule.ReadWrite.Directory"]
        }
      },
      azureManagement: { hasToken: false }
    };
    const renewedTokens = {
      ...initialTokens,
      graphTargets: {
        directoryRole: {
          ...initialTokens.graphTargets.directoryRole,
          capturedAt: 2,
          expiresInMinutes: 60,
          expiresAt: "2026-07-14T11:00:00.000Z"
        }
      }
    };
    const tokenRefresh = deferred<{ success: true; data: {
      tokenStatus: typeof renewedTokens;
      tabsFound: number;
      tabsScanned: number;
      captured: ["graph"];
    } }>();
    const cacheKey = buildTargetCacheKey(initialTokens, "directoryRole");
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: { fetchedAt: Date.now(), cacheKey, errors: [], items: [eligibleItem] }
        },
        activeByTarget: {
          directoryRole: { fetchedAt: Date.now(), cacheKey, errors: [], items: [] }
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({ success: true, data: initialTokens });
      }
      if (message.action === "refreshPortalTokens") {
        return tokenRefresh.promise;
      }
      if (message.action === "getActivationSnapshot") {
        throw new Error("A same-capability token renewal must not invalidate fresh role data.");
      }
      return Promise.resolve({ success: true, data: true });
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(document.body.textContent).not.toContain("Loading access data");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ action: "refreshPortalTokens" }));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "getActivationSnapshot" }));

    tokenRefresh.resolve({
      success: true,
      data: { tokenStatus: renewedTokens, tabsFound: 1, tabsScanned: 1, captured: ["graph"] }
    });
    await waitFor(() => expect(document.querySelector(".refresh-progress-panel")).toBeFalsy());
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "getActivationSnapshot" }));
  });

  test("opens only the portal pages needed by enabled features from manual refresh", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const missingTokens = {
      graph: { hasToken: false },
      azureManagement: { hasToken: false }
    };
    const recoveredTokens = {
      graph: { hasToken: true, capturedAt: 2 },
      graphTargets: {
        pimGroup: {
          hasToken: true,
          capturedAt: 2,
          grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
        }
      },
      azureManagement: { hasToken: false }
    };
    let recoveryOpened = false;
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["pimGroup", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      }
    };
    const createTab = vi.fn(async (_options: { url: string }) => undefined);
    const sendMessage = vi.fn(async (message: { action: string; targets?: string[] }) => {
      if (message.action === "getTokenStatus") {
        return { success: true, data: recoveryOpened ? recoveredTokens : missingTokens };
      }
      if (message.action === "refreshPortalTokens") {
        return {
          success: true,
          data: { tokenStatus: missingTokens, tabsFound: 0, tabsScanned: 0, captured: [] }
        };
      }
      if (message.action === "getActivationSnapshot") {
        return {
          success: true,
          data: {
            eligible: { items: [], errors: [], diagnostics: [] },
            active: { items: [], errors: [], diagnostics: [] },
            tokenStatus: recoveredTokens
          }
        };
      }
      if (message.action === "openPortalRecoveryTabs") {
        recoveryOpened = true;
        return {
          success: true,
          data: { requestedCount: 1, openedCount: 1, reusedCount: 0, managedCount: 1, grouped: true }
        };
      }
      return { success: true, data: true };
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: createTab }
    });
    vi.resetModules();
    await import("../src/popup/main");

    const refreshLabel = "Refresh all enabled data and recover missing portal access";
    await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${refreshLabel}"]`);
      expect(button?.disabled).toBe(false);
    });
    createTab.mockClear();
    document.querySelector<HTMLButtonElement>(`button[aria-label="${refreshLabel}"]`)?.click();

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ action: "openPortalRecoveryTabs", targets: ["pimGroup"] }), 2500);
    expect(createTab).not.toHaveBeenCalled();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ action: "getActivationSnapshot", targets: ["pimGroup"] }), 2500);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ action: "closePortalRecoveryTabs", targets: ["pimGroup"] }), 2500);
  });

  test("recovers both enabled Graph features when only cached Azure data is visible", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const missingGraphTokens = {
      graph: { hasToken: false },
      graphTargets: {
        directoryRole: { hasToken: false },
        pimGroup: { hasToken: false }
      },
      azureManagement: {
        hasToken: true,
        capturedAt: 1,
        tenantId: "tenant-1",
        principalId: "principal-1"
      }
    };
    const recoveredTokens = {
      graph: {
        hasToken: true,
        capturedAt: 2,
        tenantId: "tenant-1",
        principalId: "principal-1"
      },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          capturedAt: 2,
          tenantId: "tenant-1",
          principalId: "principal-1",
          grantedScopes: ["RoleAssignmentSchedule.ReadWrite.Directory"]
        },
        pimGroup: {
          hasToken: true,
          capturedAt: 2,
          tenantId: "tenant-1",
          principalId: "principal-1",
          grantedScopes: ["PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
        }
      },
      azureManagement: missingGraphTokens.azureManagement
    };
    const azureItem: ActivationItem = {
      id: "azureRole:contributor:/subscriptions/sub-1",
      type: "azureRole",
      sourceName: "Contributor",
      displayName: "Contributor",
      principalId: "principal-1",
      scopeLabel: "Production",
      status: "eligible",
      roleDefinitionId: "contributor",
      scope: "/subscriptions/sub-1"
    };
    let recoveryOpened = false;
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          azureRole: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(missingGraphTokens, "azureRole"),
            errors: [],
            items: [azureItem]
          }
        },
        activeByTarget: {
          azureRole: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(missingGraphTokens, "azureRole"),
            errors: [],
            items: []
          }
        }
      }
    };
    const sendMessage = vi.fn(async (message: { action: string; targets?: string[] }) => {
      if (message.action === "getTokenStatus") {
        return { success: true, data: recoveryOpened ? recoveredTokens : missingGraphTokens };
      }
      if (message.action === "refreshPortalTokens") {
        return {
          success: true,
          data: {
            tokenStatus: recoveryOpened ? recoveredTokens : missingGraphTokens,
            tabsFound: 0,
            tabsScanned: 0,
            captured: []
          }
        };
      }
      if (message.action === "openPortalRecoveryTabs") {
        recoveryOpened = true;
        return {
          success: true,
          data: { requestedCount: 2, openedCount: 2, reusedCount: 0, managedCount: 2, grouped: true }
        };
      }
      if (message.action === "getActivationSnapshot") {
        const items = message.targets?.[0] === "azureRole" ? [azureItem] : [];
        return {
          success: true,
          data: {
            eligible: { items, errors: [], diagnostics: [] },
            active: { items: [], errors: [], diagnostics: [] },
            tokenStatus: recoveryOpened ? recoveredTokens : missingGraphTokens
          }
        };
      }
      return { success: true, data: true };
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Contributor"));
    await waitFor(() => {
      const tabLabels = [...document.querySelectorAll(".tab-button")].map((button) => button.textContent?.trim());
      expect(tabLabels).toEqual(["Azure Roles", "Bundles"]);
    });
    expect(document.body.textContent).toContain("2 role sources need a refresh.");
    expect(document.body.textContent).toContain("Use Refresh in the top-right.");
    expect(document.body.textContent).not.toContain("Fix access");
    sendMessage.mockClear();
    const refreshLabel = "Refresh all enabled data and recover missing portal access";
    document.querySelector<HTMLButtonElement>(`button[aria-label="${refreshLabel}"]`)?.click();

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      action: "openPortalRecoveryTabs",
      targets: ["directoryRole", "pimGroup"]
    }), 2500);
    expect(sendMessage).not.toHaveBeenCalledWith({
      action: "openPortalRecoveryTabs",
      targets: expect.arrayContaining(["azureRole"])
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      action: "closePortalRecoveryTabs",
      targets: ["directoryRole", "pimGroup"]
    }), 2500);
  });

  test("presents first use as one calm refresh step without duplicate access warnings", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const missingTokens = {
      graph: { hasToken: false },
      graphTargets: {
        directoryRole: { hasToken: false },
        pimGroup: { hasToken: false }
      },
      azureManagement: { hasToken: false }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [POPUP_DRAFT_KEY]: {
        updatedAt: Date.now(),
        tab: "bundles",
        search: "",
        sortMode: "name",
        quickFilters: [],
        selectedIds: [],
        durationHours: 0.5,
        justification: "",
        ticketSystem: "",
        ticketNumber: "",
        isActivationReviewOpen: false
      }
    };
    const openedUrls: string[] = [];
    const recoveryOpen = deferred<{
      success: true;
      data: { managedCount: number; grouped: boolean; openedTargets: string[]; reusedTargets: string[] };
    }>();
    const sendMessage = vi.fn(async (message: { action: string; targets?: string[] }) => {
      if (message.action === "getTokenStatus") {
        return { success: true, data: missingTokens };
      }
      if (message.action === "openPortalRecoveryTabs") {
        return recoveryOpen.promise;
      }
      if (message.action === "refreshPortalTokens") {
        return {
          success: true,
          data: { tokenStatus: missingTokens, tabsFound: 0, tabsScanned: 0, captured: [] }
        };
      }
      if (message.action === "getActivationSnapshot") {
        const error = message.targets?.[0] === "azureRole"
          ? "Azure Management token is missing."
          : "Graph token is missing.";
        return {
          success: true,
          data: {
            eligible: { items: [], errors: [error], diagnostics: [] },
            active: { items: [], errors: [error], diagnostics: [] },
            tokenStatus: missingTokens
          }
        };
      }
      return { success: true, data: true };
    });

    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn(async ({ url }: { url: string }) => {
          openedUrls.push(url);
        })
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Load your PIM roles"));
    expect(document.body.textContent).toContain("Use the highlighted Refresh button above.");
    expect(document.body.textContent).toContain("Graph access needed");
    expect(document.body.textContent).toContain("Azure access needed");
    expect(document.body.textContent).not.toContain("Some QuickPIM++ data is missing or stale.");
    expect(document.body.textContent).not.toContain("Fix access");
    expect(document.body.textContent).not.toContain("Graph token is missing.");
    expect(document.body.textContent).not.toContain("Create role bundles from Settings.");
    expect(document.querySelectorAll(".tab-button")).toHaveLength(0);
    expect(document.querySelector(".refresh-button")?.classList.contains("needs-attention")).toBe(true);
    expect(document.querySelector(".initial-access-arrow")).toBeTruthy();
    expect(document.querySelector(".initial-access-icon")).toBeFalsy();
    expect(document.querySelector('button[aria-label^="Open "]')).toBeFalsy();
    clickButton("Access details");
    await waitFor(() => expect(openedUrls).toEqual(["chrome-extension://quickpim/settings.html#access"]));

    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh all enabled data and recover missing portal access"]'
    )?.click();
    await waitFor(() => {
      const activeTab = document.querySelector<HTMLButtonElement>(".tab-button.active");
      expect(activeTab?.textContent?.trim()).toBe("Entra Roles");
    });
    recoveryOpen.resolve({
      success: true,
      data: { managedCount: 0, grouped: false, openedTargets: [], reusedTargets: [] }
    });
  });

  test("turns first-run token recovery into a persistent Microsoft sign-in step", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const missingTokens = {
      graph: { hasToken: false },
      graphTargets: { directoryRole: { hasToken: false }, pimGroup: { hasToken: false } },
      azureManagement: { hasToken: false }
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      preferences: {
        ...DEFAULT_SETTINGS.preferences,
        enabledFeatures: ["directoryRole", "pimGroup", "azureRole"],
        autoEnabledFeaturesInitialized: true
      }
    };
    let recoveryStatus: Record<string, unknown> = {
      state: "idle",
      managedTargets: [],
      interactionTargets: [],
      grouped: false
    };
    const sendMessage = vi.fn(async (message: { action: string; targets?: string[] }) => {
      if (message.action === "getTokenStatus") return { success: true, data: missingTokens };
      if (message.action === "getPortalRecoveryStatus") return { success: true, data: recoveryStatus };
      if (message.action === "openPortalRecoveryTabs") {
        recoveryStatus = {
          state: "interactionRequired",
          managedTargets: message.targets || [],
          interactionTargets: message.targets || [],
          grouped: true,
          interactionReason: "signIn"
        };
        return { success: true, data: { requestedCount: 3, openedCount: 3, reusedCount: 0, managedCount: 3, grouped: true } };
      }
      if (message.action === "focusPortalRecoveryTabs") {
        return { success: true, data: { focused: true, status: recoveryStatus } };
      }
      if (message.action === "getActivationSnapshot") {
        return {
          success: true,
          data: {
            eligible: { items: [], errors: ["Graph token is missing."], diagnostics: [] },
            active: { items: [], errors: ["Graph token is missing."], diagnostics: [] },
            tokenStatus: missingTokens
          }
        };
      }
      return { success: true, data: true };
    });
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://quickpim/${path}`, sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");
    await waitFor(() => expect(document.body.textContent).toContain("Load your PIM roles"));

    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh all enabled data and recover missing portal access"]'
    )?.click();

    await waitFor(() => expect(document.body.textContent).toContain("Microsoft sign-in needed"), 2500);
    expect(document.body.textContent).toContain("Choose an account or finish signing in");
    expect(document.querySelector('.message.error')).toBeFalsy();
    expect(document.querySelector('button[aria-label="Continue Microsoft sign-in"]')).toBeTruthy();
    clickButton("Continue sign-in");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ action: "focusPortalRecoveryTabs" }));
  });

  test("restores a pending Microsoft sign-in step when the popup is reopened", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const missingTokens = {
      graph: { hasToken: false },
      graphTargets: { directoryRole: { hasToken: false } },
      azureManagement: { hasToken: false }
    };
    const recoveryStatus = {
      state: "interactionRequired",
      managedTargets: ["directoryRole"],
      interactionTargets: ["directoryRole"],
      grouped: true,
      interactionReason: "signIn"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole"],
          autoEnabledFeaturesInitialized: true
        }
      }
    };
    const sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getTokenStatus") return { success: true, data: missingTokens };
      if (message.action === "getPortalRecoveryStatus") return { success: true, data: recoveryStatus };
      if (message.action === "getActivationSnapshot") {
        return {
          success: true,
          data: {
            eligible: { items: [], errors: ["Graph token is missing."], diagnostics: [] },
            active: { items: [], errors: ["Graph token is missing."], diagnostics: [] },
            tokenStatus: missingTokens
          }
        };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://quickpim/${path}`, sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Microsoft sign-in needed"));
    expect(sendMessage).not.toHaveBeenCalledWith({ action: "openPortalRecoveryTabs", targets: expect.anything() });
  });

  test("automatically resumes loading roles after Microsoft sign-in completes", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const missingTokens = {
      graph: { hasToken: false },
      graphTargets: { directoryRole: { hasToken: false } },
      azureManagement: { hasToken: false }
    };
    const readyTokens = {
      graph: { hasToken: true, capturedAt: 2, expiresInMinutes: 45 },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          capturedAt: 2,
          expiresInMinutes: 45,
          grantedScopes: ["RoleEligibilitySchedule.Read.Directory", "RoleAssignmentSchedule.ReadWrite.Directory"]
        }
      },
      azureManagement: { hasToken: false }
    };
    const role: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Global Reader",
      displayName: "Global Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const interactionStatus = {
      state: "interactionRequired",
      managedTargets: ["directoryRole"],
      interactionTargets: ["directoryRole"],
      grouped: true,
      interactionReason: "signIn"
    };
    const idleStatus = {
      state: "idle",
      managedTargets: [],
      interactionTargets: [],
      grouped: false
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole"],
          autoEnabledFeaturesInitialized: true
        }
      }
    };
    let statusChecks = 0;
    let tokenChecks = 0;
    let snapshotChecks = 0;
    const sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getPortalRecoveryStatus") {
        statusChecks += 1;
        return { success: true, data: statusChecks < 3 ? interactionStatus : idleStatus };
      }
      if (message.action === "getTokenStatus") {
        tokenChecks += 1;
        return { success: true, data: tokenChecks === 1 ? missingTokens : readyTokens };
      }
      if (message.action === "refreshPortalTokens") {
        return { success: true, data: { tokenStatus: missingTokens, tabsFound: 0, tabsScanned: 0, captured: [] } };
      }
      if (message.action === "getActivationSnapshot") {
        snapshotChecks += 1;
        const hasRole = snapshotChecks > 1;
        return {
          success: true,
          data: {
            eligible: { items: hasRole ? [role] : [], errors: hasRole ? [] : ["Graph token is missing."], diagnostics: [] },
            active: { items: [], errors: [], diagnostics: [] },
            tokenStatus: hasRole ? readyTokens : missingTokens
          }
        };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://quickpim/${path}`, sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Microsoft sign-in needed"));
    await waitFor(() => expect(document.body.textContent).toContain("Global Reader"), 3_000);
    expect(snapshotChecks).toBeGreaterThan(1);
    expect(document.body.textContent).not.toContain("Load your PIM roles");
  });

  test("keeps cached roles usable while later token recovery waits for sign-in", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const item: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Global Reader",
      displayName: "Global Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const missingTokens = {
      graph: { hasToken: false },
      graphTargets: { directoryRole: { hasToken: false } },
      azureManagement: { hasToken: false }
    };
    const cacheEntry = {
      fetchedAt: Date.now(),
      cacheKey: buildTargetCacheKey(missingTokens, "directoryRole"),
      errors: [],
      diagnostics: [],
      items: [item]
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: { directoryRole: cacheEntry },
        activeByTarget: { directoryRole: { ...cacheEntry, items: [] } }
      }
    };
    const recoveryStatus = {
      state: "interactionRequired",
      managedTargets: ["directoryRole"],
      interactionTargets: ["directoryRole"],
      grouped: true,
      interactionReason: "signIn"
    };
    const sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getTokenStatus") return { success: true, data: missingTokens };
      if (message.action === "getPortalRecoveryStatus") return { success: true, data: recoveryStatus };
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://quickpim/${path}`, sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Global Reader"));
    expect(document.body.textContent).toContain("Microsoft sign-in is needed to finish refreshing access.");
    expect(document.body.textContent).toContain("Continue sign-in");
  });

  test("renders pending approval rows as readonly and excludes them from eligible count", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:admin:/",
      type: "directoryRole",
      sourceName: "User Administrator",
      displayName: "User Administrator",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "admin",
      directoryScopeId: "/",
      activationRequirements: {
        approval: true
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: "graphDirectory:missing",
            errors: [],
            items: [eligibleItem]
          }
        },
        activeByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: "graphDirectory:missing",
            errors: [],
            items: [{ ...eligibleItem, status: "pendingApproval" }]
          }
        }
      }
    };

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          throw new Error("Fresh cache should not fetch activation data.");
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("User Administrator"));
    expect(document.body.textContent).toContain("Pending approval");
    expect(document.body.textContent).toContain("0 eligible items");
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')).toBeNull();
  });

  test("shows stale eligible cache immediately while refreshing in the background", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const staleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const refreshedItem: ActivationItem = {
      ...staleItem,
      id: "directoryRole:admin:/",
      sourceName: "Admin",
      displayName: "Admin",
      roleDefinitionId: "admin"
    };
    const snapshot = deferred<{ success: true; data: { eligible: { items: ActivationItem[]; errors: []; diagnostics: [] }; active: { items: []; errors: []; diagnostics: [] } } }>();
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now() - 40 * 60 * 1000,
            cacheKey: "graphDirectory:missing",
            errors: [],
            items: [staleItem]
          }
        },
        activeByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: "graphDirectory:missing",
            errors: [],
            items: []
          }
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: {
            graph: { hasToken: false },
            azureManagement: { hasToken: false }
          }
        });
      }
      if (message.action === "getActivationSnapshot") {
        return snapshot.promise;
      }
      return Promise.resolve({ success: true, data: { items: [], errors: [] } });
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(document.body.textContent).not.toContain("Loading access data");
    await waitFor(() => expect(document.body.textContent).toContain("Fetching latest data"));
    const refreshText = document.querySelector(".refresh-progress-panel")?.textContent || "";
    expect(refreshText).toContain("Refreshing access data");
    expect(refreshText).not.toMatch(/Refreshing access data.*Refreshing .*access data/i);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: "getActivationSnapshot" }));

    snapshot.resolve({
      success: true,
      data: {
        eligible: { items: [refreshedItem], errors: [], diagnostics: [] },
        active: { items: [], errors: [], diagnostics: [] }
      }
    });
    await waitFor(() => expect(document.body.textContent).toContain("Admin"));
  });

  test("renders filter and sort icons next to their toolbar fields", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(document.querySelector(".filter-field .field-icon")).toBeTruthy();
    expect(document.querySelector(".sort-field .field-icon")).toBeTruthy();
  });

  test("hides empty role tabs while keeping populated role tabs visible", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const azureItem: ActivationItem = {
      id: "azureRole:reader:/subscriptions/sub-1",
      type: "azureRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Production",
      status: "eligible",
      roleDefinitionId: "reader",
      scope: "/subscriptions/sub-1"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [azureItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    const tabLabels = [...document.querySelectorAll(".tab-button")].map((button) => button.textContent?.trim());
    expect(tabLabels).toEqual(["Azure Roles", "Bundles"]);
  });

  test("auto-enables features that only return active PIM items after the first successful fetch", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const azureItem: ActivationItem = {
      id: "azureRole:reader:/subscriptions/sub-1",
      type: "azureRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Production",
      status: "active",
      activeAssignmentType: "activated",
      assignmentScheduleId: "schedule-1",
      roleDefinitionId: "reader",
      scope: "/subscriptions/sub-1"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string; targets?: string[] }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: true, capturedAt: 1 },
                azureManagement: { hasToken: true, capturedAt: 1 }
              }
            });
          }
          if (message.action === "getActivationItems") {
            return Promise.resolve({ success: true, data: { items: [], errors: [], diagnostics: [] } });
          }
          if (message.action === "getActiveItems") {
            return Promise.resolve({ success: true, data: { items: [azureItem], errors: [], diagnostics: [] } });
          }
          return Promise.resolve({ success: true, data: true });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({
        enabledFeatures: ["azureRole", "bundles"],
        autoEnabledFeaturesInitialized: true
      })
    });
  });

  test("does not auto-hide role sources when one half of the first fetch fails", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const initialSettings = structuredClone(DEFAULT_SETTINGS);
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: initialSettings };
    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: true, capturedAt: 1 },
                azureManagement: { hasToken: true, capturedAt: 1 }
              }
            });
          }
          if (message.action === "getActivationItems") {
            return Promise.resolve({ success: true, data: { items: [], errors: [], diagnostics: [] } });
          }
          if (message.action === "getActiveItems") {
            return Promise.resolve({ success: true, data: { items: [], errors: ["Temporary active-assignment failure"], diagnostics: [] } });
          }
          return Promise.resolve({ success: true, data: true });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(
      chromeMock.runtime.sendMessage.mock.calls.some(([message]) => message.action === "getActiveItems")
    ).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({
        enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"],
        autoEnabledFeaturesInitialized: false
      })
    });
  });

  test("fetches only enabled role features", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["azureRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string; targets?: string[] }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: true, capturedAt: 1 },
                azureManagement: { hasToken: true, capturedAt: 1 }
              }
            });
          }
          if (message.action === "getActivationItems" || message.action === "getActiveItems") {
            return Promise.resolve({ success: true, data: { items: [], errors: [], diagnostics: [] } });
          }
          return Promise.resolve({ success: true, data: true });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("0 eligible items"));
    const fetchMessages = chromeMock.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.action === "getActivationItems" || message.action === "getActiveItems");
    expect(fetchMessages.map((message) => message.targets)).toEqual([["azureRole"], ["azureRole"]]);
  });

  test("manual popup refresh targets every enabled role source through the snapshot endpoint", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const tokens = {
      graph: { hasToken: true, tenantId: "tenant-1", principalId: "principal-1" },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          tenantId: "tenant-1",
          principalId: "principal-1",
          grantedScopes: [
            "RoleEligibilitySchedule.Read.Directory",
            "RoleAssignmentSchedule.ReadWrite.Directory"
          ]
        },
        pimGroup: {
          hasToken: true,
          tenantId: "tenant-1",
          principalId: "principal-1",
          grantedScopes: [
            "PrivilegedEligibilitySchedule.Read.AzureADGroup",
            "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"
          ]
        }
      },
      azureManagement: { hasToken: true, tenantId: "tenant-1", principalId: "principal-1" }
    };
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(tokens, "directoryRole"),
            errors: [],
            items: [eligibleItem]
          }
        },
        activeByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(tokens, "directoryRole"),
            errors: [],
            items: []
          }
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string; targets?: string[] }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: tokens
        });
      }
      if (message.action === "getActivationSnapshot") {
        return Promise.resolve({
          success: true,
          data: {
            eligible: { items: [eligibleItem], errors: [], diagnostics: [] },
            active: { items: [], errors: [], diagnostics: [] }
          }
        });
      }
      return Promise.resolve({ success: true, data: { items: [], errors: [] } });
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    await waitFor(() => expect(document.querySelector(".refresh-progress-panel")).toBeFalsy());
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh all enabled data and recover missing portal access"]'
    )?.disabled).toBe(false));
    sendMessage.mockClear();
    document.querySelector<HTMLButtonElement>('button[aria-label="Refresh all enabled data and recover missing portal access"]')?.click();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await waitFor(() => {
      const snapshotTargets = sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.action === "getActivationSnapshot")
        .map((message) => message.targets?.[0])
        .sort();
      expect(snapshotTargets).toEqual(["azureRole", "directoryRole", "pimGroup"]);
    });
    await waitFor(() => expect(document.querySelector(".refresh-progress-panel")).toBeFalsy());
    expect(document.body.textContent).not.toContain("Refresh completed.");
  });

  test("hides popup tabs for disabled features", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const items: ActivationItem[] = [
      {
        id: "directoryRole:reader:/",
        type: "directoryRole",
        sourceName: "Reader",
        displayName: "Reader",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        roleDefinitionId: "reader",
        directoryScopeId: "/"
      },
      {
        id: "azureRole:owner:/subscriptions/sub-1",
        type: "azureRole",
        sourceName: "Owner",
        displayName: "Owner",
        principalId: "principal-1",
        scopeLabel: "Production",
        status: "eligible",
        roleDefinitionId: "owner",
        scope: "/subscriptions/sub-1"
      }
    ];
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["directoryRole", "pimGroup", "bundles"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing|features:directoryRole,pimGroup",
          errors: [],
          items
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing|features:directoryRole,pimGroup",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    const tabLabels = [...document.querySelectorAll(".tab-button")].map((button) => button.textContent?.trim());
    expect(tabLabels).toEqual(["Entra Roles", "Bundles"]);
  });

  test("does not force a disabled feature tab back into view when all features are disabled", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: [],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [
            {
              id: "directoryRole:reader:/",
              type: "directoryRole",
              sourceName: "Reader",
              displayName: "Reader",
              principalId: "principal-1",
              scopeLabel: "Tenant",
              status: "eligible",
              roleDefinitionId: "reader",
              directoryScopeId: "/"
            }
          ]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("No enabled features have data yet"));
    expect(document.querySelectorAll(".tab-button")).toHaveLength(0);
  });

  test("opens the Bundles settings section from the Bundles tab", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["bundles"],
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };
    const openedUrls: string[] = [];

    const chromeMock = {
      runtime: {
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        openOptionsPage: vi.fn(),
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn(({ url }: { url: string }) => openedUrls.push(url))
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("0 eligible items"));
    clickButton("Bundles");
    await waitFor(() => expect(document.body.textContent).toContain("Create role bundles from Settings."));
    clickButton("Open settings");

    await waitFor(() => expect(openedUrls).toEqual(["chrome-extension://quickpim/settings.html#bundles"]));
    expect(chromeMock.runtime.openOptionsPage).not.toHaveBeenCalled();
  });

  test("shows an Unselect all button while rows are selected and clears selection", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(document.body.textContent).not.toContain("Unselect all");
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();

    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(document.body.textContent).not.toContain("Activate 1 selected");
    expect(document.body.textContent).not.toContain("Activation time");
    expect(document.body.textContent).toContain("Unselect all");

    clickButton("Unselect all");

    await waitFor(() => expect(document.body.textContent).not.toContain("Continue"));
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  test("toggles selection when clicking role text or blank row space", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/"
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const row = document.querySelector<HTMLElement>(".role-row")!;

    document.querySelector<HTMLElement>(".role-title")?.click();
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(document.body.textContent).toContain("Continue");
    expect(document.body.textContent).not.toContain("Activate 1 selected");

    row.click();
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(document.body.textContent).not.toContain("Continue");
  });

  test("shows activation progress through request and refresh before final confirmation", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      activationRequirements: {
        justification: false,
        ticket: false
      }
    };
    const activation = deferred<{
      success: true;
      data: {
        success: true;
        results: Array<{ itemId: string; itemName: string; success: true }>;
        errors: [];
      };
    }>();
    const refreshedEligible = deferred<{ success: true; data: { items: ActivationItem[]; errors: [] } }>();
    const refreshedActive = deferred<{ success: true; data: { items: ActivationItem[]; errors: [] } }>();
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "activateItems") {
            return activation.promise;
          }
          if (message.action === "getActivationItems") {
            return refreshedEligible.promise;
          }
          if (message.action === "getActiveItems") {
            return refreshedActive.promise;
          }
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: true });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(document.body.textContent).not.toContain("Activation time");
    expect(document.body.textContent).not.toContain("Activate 1 selected");
    clickButton("Continue");
    await waitFor(() => expect(document.body.textContent).toContain("Activate 1 selected"));
    clickButton("Activate 1 selected");

    await waitFor(() => expect(document.body.textContent).toContain("Activation in progressStep 1/3Sending activation request"));
    activation.resolve({
      success: true,
      data: {
        success: true,
        results: [{ itemId: eligibleItem.id, itemName: "Reader", success: true }],
        errors: []
      }
    });

    await waitFor(() => expect(document.body.textContent).toContain("Activation in progressStep 3/3Refreshing activation status"));
    refreshedEligible.resolve({ success: true, data: { items: [], errors: [] } });
    refreshedActive.resolve({ success: true, data: { items: [{ ...eligibleItem, status: "active" }], errors: [] } });

    await waitFor(() => expect(document.body.textContent).toContain("Activation request submitted for 1 item."));
    expect(document.body.textContent).not.toContain("Forced refresh completed.");
  });

  test("marks required justification with a red asterisk", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      activationRequirements: {
        justification: true,
        ticket: false
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();

    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(document.querySelector(".required-marker")).toBeFalsy();
    expect(document.body.textContent).not.toContain("Justification");
    clickButton("Continue");
    await waitFor(() => expect(document.querySelector(".required-marker")).toBeTruthy());
    expect(document.querySelector(".required-marker")?.textContent).toBe("*");
    expect(document.body.textContent).not.toContain("Justifications are requested for audit and approval");
    expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")?.maxLength).toBe(MAX_USER_JUSTIFICATION_LENGTH);
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(css.match(/\.required-marker\s*\{[^}]+\}/)?.[0] || "").toContain("color: #dc2626;");
  });

  test("uses an icon-only save justification action beside the justification label", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      activationRequirements: {
        justification: true,
        ticket: false
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();

    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(document.querySelector(".justification-label-row")).toBeFalsy();
    clickButton("Continue");
    await waitFor(() => expect(document.querySelector(".justification-label-row")).toBeTruthy());
    expect(document.body.textContent).not.toContain("Save justification");

    const saveButton = document.querySelector<HTMLButtonElement>('button[aria-label="Save justification"]');
    expect(saveButton).toBeTruthy();
    expect(saveButton?.title).toBe("Save this justification for reuse");
    expect(saveButton?.querySelector(".save-icon")).toBeTruthy();
    expect(document.querySelector(".activation-bar > .button-row")?.textContent).not.toContain("Save justification");

    setFieldValue(document.querySelector<HTMLTextAreaElement>(".justification-textarea")!, "INC-123 break fix");
    saveButton?.click();

    await waitFor(() =>
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["INC-123 break fix"]
      })
    );
  });

  test("keeps saved justifications behind a dedicated picker instead of mixing them with recent chips", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      activationRequirements: {
        justification: true,
        ticket: false
      }
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      savedJustifications: ["Saved break fix", "Saved audit review"],
      recentJustifications: ["Recent support", "Saved break fix", "Recent cleanup"]
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    clickButton("Continue");

    await waitFor(() => expect(document.querySelector(".justification-chip")).toBeTruthy());
    const chips = [...document.querySelectorAll<HTMLButtonElement>(".justification-chip")].map((button) => button.textContent?.trim());
    expect(chips).toEqual(["Recent support", "Recent cleanup"]);
    expect(document.body.textContent).not.toContain("Saved audit review");

    clickButton("Saved");
    await waitFor(() => expect(document.body.textContent).toContain("Saved audit review"));
    clickButton("Saved audit review");

    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")?.value).toBe("Saved audit review"));
    expect(document.querySelector(".saved-justification-menu")).toBeFalsy();
  });

  test("shows activation errors without waiting forever", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "pimGroup:group-1:member",
      type: "pimGroup",
      sourceName: "Cybersec PIM Group",
      displayName: "Cybersec PIM Group",
      principalId: "principal-1",
      scopeLabel: "Member",
      status: "eligible",
      groupId: "group-1",
      accessId: "member",
      activationRequirements: {
        justification: false,
        ticket: false
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "activateItems") {
            const permissionError = JSON.stringify({
              errorCode: "PermissionScopeNotGranted",
              message: "Authorization failed due to missing permission scope PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup."
            });
            return Promise.resolve({
              success: true,
              data: {
                success: false,
                results: [{ itemId: eligibleItem.id, itemName: "Cybersec PIM Group", success: false, error: permissionError }],
                errors: [{ itemId: eligibleItem.id, itemName: "Cybersec PIM Group", success: false, error: permissionError }]
              }
            });
          }
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Cybersec PIM Group"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    clickButton("Continue");
    await waitFor(() => expect(document.body.textContent).toContain("Activate 1 selected"));
    clickButton("Activate 1 selected");

    await waitFor(() => expect(document.body.textContent).toContain("Activation failed for 1 item."));
    expect(document.body.textContent).toContain("Cybersec PIM Group: PIM Groups access is limited in the captured portal token.");
    expect(document.body.textContent).not.toContain("PermissionScopeNotGranted");
  });

  test("selects active rows for deactivation and prevents mixing with activation selections", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "pimGroup:group-1:member",
      type: "pimGroup",
      sourceName: "Eligible Group",
      displayName: "Eligible Group",
      principalId: "principal-1",
      scopeLabel: "Member",
      status: "eligible",
      groupId: "group-1",
      accessId: "member",
      activationRequirements: {
        justification: false,
        ticket: false
      }
    };
    const activeItem: ActivationItem = {
      id: "pimGroup:group-2:member",
      type: "pimGroup",
      sourceName: "Active Group",
      displayName: "Active Group",
      principalId: "principal-1",
      scopeLabel: "Member",
      status: "active",
      activeAssignmentType: "activated",
      groupId: "group-2",
      accessId: "member",
      assignmentScheduleId: "active-schedule-1",
      activeUntil: new Date(Date.now() + 2 * 60 * 60_000 + 5 * 60_000 + 30_000).toISOString()
    };
    const assignedItem: ActivationItem = {
      ...activeItem,
      id: "pimGroup:group-3:member",
      sourceName: "Assigned Group",
      displayName: "Assigned Group",
      groupId: "group-3",
      activeAssignmentType: "assigned",
      assignmentScheduleId: "assigned-schedule-1"
    };
    const activeEligibleItem: ActivationItem = {
      ...activeItem,
      status: "eligible",
      assignmentScheduleId: undefined,
      activeUntil: undefined
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          enabledFeatures: ["pimGroup"],
          showAssignedRoles: true,
          autoEnabledFeaturesInitialized: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: "graphPimGroup:",
            errors: [],
            items: [eligibleItem, activeEligibleItem]
          }
        },
        activeByTarget: {
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: "graphPimGroup:",
            errors: [],
            items: [activeItem, assignedItem]
          }
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string }) => {
      if (message.action === "deactivateItems") {
        return Promise.resolve({
          success: true,
          data: {
            success: true,
            results: [{ itemId: activeItem.id, itemName: "Active Group", success: true }],
            errors: []
          }
        });
      }
      if (message.action === "getActivationSnapshot") {
        return Promise.resolve({
          success: true,
          data: {
            eligible: { items: [eligibleItem], errors: [], diagnostics: [] },
            active: { items: [], errors: [], diagnostics: [] }
          }
        });
      }
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: {
            graph: { hasToken: true, capturedAt: 1 },
            azureManagement: { hasToken: false }
          }
        });
      }
      return Promise.resolve({ success: true, data: true });
    });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: { create: vi.fn() }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Assigned Group"));
    const rows = [...document.querySelectorAll<HTMLElement>(".role-row")];
    const eligibleRow = rows.find((row) => row.textContent?.includes("Eligible Group"))!;
    const activeRow = rows.find((row) => row.textContent?.includes("Active Group"))!;
    const assignedRow = rows.find((row) => row.textContent?.includes("Assigned Group"))!;
    const eligibleCheckbox = eligibleRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const activeCheckbox = activeRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    expect(activeRow.textContent).toContain("PIM active");
    const remainingCounter = activeRow.querySelector<HTMLElement>(".remaining-activation-time");
    expect(remainingCounter?.textContent).toBe("2h 05m");
    expect(remainingCounter?.getAttribute("aria-label")).toContain("remaining on PIM activation");
    expect(assignedRow.textContent).toContain("Assigned");
    expect(assignedRow.classList.contains("assigned-row")).toBe(true);
    expect(assignedRow.querySelector('input[type="checkbox"]')).toBeNull();
    expect(assignedRow.querySelector(".remaining-activation-time")).toBeNull();
    expect(assignedRow.title).toContain("not a PIM activation");

    activeCheckbox.click();
    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(activeCheckbox.checked).toBe(true);
    expect(eligibleCheckbox.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Activation time");

    clickButton("Continue");
    await waitFor(() => expect(document.body.textContent).toContain("Disable 1 selected"));
    expect(document.body.textContent).not.toContain("Activation time");
    clickButton("Disable 1 selected");

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: "deactivateItems",
        items: [expect.objectContaining({ id: activeItem.id, status: "active" })]
      }))
    );
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "activateItems" }));
  });

  test("hides activation counters by default and shows them when enabled in preferences", async () => {
    async function renderWithCounterPreference(showActivationCounters: boolean) {
      document.body.innerHTML = '<div id="root"></div>';
      const eligibleItem: ActivationItem = {
        id: "directoryRole:reader:/",
        type: "directoryRole",
        sourceName: "Reader",
        displayName: "Reader",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        roleDefinitionId: "reader",
        directoryScopeId: "/"
      };
      const storageData: Record<string, unknown> = {
        [SETTINGS_KEY]: {
          ...DEFAULT_SETTINGS,
          preferences: {
            ...DEFAULT_SETTINGS.preferences,
            showActivationCounters
          },
          usageStatsByItemId: {
            [eligibleItem.id]: {
              activationCount: 7
            }
          }
        },
        [DATA_CACHE_KEY]: {
          eligible: {
            fetchedAt: Date.now(),
            cacheKey: "graph:missing|azure:missing",
            errors: [],
            items: [eligibleItem]
          },
          active: {
            fetchedAt: Date.now(),
            cacheKey: "graph:missing|azure:missing",
            errors: [],
            items: []
          }
        }
      };

      vi.stubGlobal("chrome", {
        runtime: {
          sendMessage: vi.fn((message: { action: string }) => {
            if (message.action === "getTokenStatus") {
              return Promise.resolve({
                success: true,
                data: {
                  graph: { hasToken: false },
                  azureManagement: { hasToken: false }
                }
              });
            }
            return Promise.resolve({ success: true, data: { items: [], errors: [] } });
          })
        },
        storage: {
          local: {
            get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
            set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
            remove: vi.fn(async () => undefined)
          }
        },
        tabs: { create: vi.fn() }
      });
      vi.resetModules();
      await import("../src/popup/main");
      await waitFor(() => expect(document.body.textContent).toContain("Reader"));
      return document.querySelector(".activation-count");
    }

    expect(await renderWithCounterPreference(false)).toBeNull();
    const cleanupWindow = window as Window & { __quickPimPopupUnmount?: () => void };
    cleanupWindow.__quickPimPopupUnmount?.();
    cleanupWindow.__quickPimPopupUnmount = undefined;
    vi.unstubAllGlobals();
    expect(await renderWithCounterPreference(true)).toBeTruthy();
  });

  test("separates policy details from last enablement dates", async () => {
    async function renderWithDetailPreferences(showEnablementDetails: boolean, showLastEnablementDate: boolean) {
      document.body.innerHTML = '<div id="root"></div>';
      const eligibleItem: ActivationItem = {
        id: "directoryRole:reader:/",
        type: "directoryRole",
        sourceName: "Reader",
        displayName: "Reader",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        roleDefinitionId: "reader",
        directoryScopeId: "/",
        activationRequirements: {
          approval: true,
          justification: true,
          maxDurationHours: 4,
          ticket: false
        }
      };
      const storageData: Record<string, unknown> = {
        [SETTINGS_KEY]: {
          ...DEFAULT_SETTINGS,
          preferences: {
            ...DEFAULT_SETTINGS.preferences,
            showEnablementDetails,
            showLastEnablementDate
          },
          usageStatsByItemId: {
            [eligibleItem.id]: {
              activationCount: 2,
              lastUsedAt: "2026-06-12T09:30:00.000Z"
            }
          }
        },
        [DATA_CACHE_KEY]: {
          eligible: {
            fetchedAt: Date.now(),
            cacheKey: "graph:missing|azure:missing",
            errors: [],
            items: [eligibleItem]
          },
          active: {
            fetchedAt: Date.now(),
            cacheKey: "graph:missing|azure:missing",
            errors: [],
            items: []
          }
        }
      };

      vi.stubGlobal("chrome", {
        runtime: {
          sendMessage: vi.fn((message: { action: string }) => {
            if (message.action === "getTokenStatus") {
              return Promise.resolve({
                success: true,
                data: {
                  graph: { hasToken: false },
                  azureManagement: { hasToken: false }
                }
              });
            }
            return Promise.resolve({ success: true, data: { items: [], errors: [] } });
          })
        },
        storage: {
          local: {
            get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
            set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
            remove: vi.fn(async () => undefined)
          }
        },
        tabs: { create: vi.fn() }
      });
      vi.resetModules();
      await import("../src/popup/main");
      await waitFor(() => expect(document.body.textContent).toContain("Reader"));
      return document.body.textContent || "";
    }

    const hiddenText = await renderWithDetailPreferences(false, false);
    expect(hiddenText).not.toContain("Max duration");
    expect(hiddenText).not.toContain("Reason required");
    expect(hiddenText).not.toContain("last enabled");
    const cleanupWindow = window as Window & { __quickPimPopupUnmount?: () => void };
    cleanupWindow.__quickPimPopupUnmount?.();
    cleanupWindow.__quickPimPopupUnmount = undefined;
    vi.unstubAllGlobals();
    const policyText = await renderWithDetailPreferences(true, false);
    expect(policyText).toContain("Max duration: 4 hours");
    expect(policyText).toContain("Reason required");
    expect(policyText).not.toContain("last enabled");
    const policyCleanupWindow = window as Window & { __quickPimPopupUnmount?: () => void };
    policyCleanupWindow.__quickPimPopupUnmount?.();
    policyCleanupWindow.__quickPimPopupUnmount = undefined;
    vi.unstubAllGlobals();
    const text = await renderWithDetailPreferences(false, true);
    expect(text).not.toContain("Max duration");
    expect(text).toContain("last enabled 2026-06-12");
    expect(text).not.toContain("6/12/2026");
  });

  test("shows matching portal actions for claims challenge activation errors", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:user-admin:/",
      type: "directoryRole",
      sourceName: "User Administrator",
      displayName: "User Administrator",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "user-admin",
      directoryScopeId: "/",
      activationRequirements: {
        justification: true,
        ticket: false
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };
    const claims = encodeURIComponent(JSON.stringify({ access_token: { acrs: { essential: true, value: "c1" } } }));
    const createTab = vi.fn();

    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "activateItems") {
            const error = `Authorization failed. &claims=${claims}`;
            return Promise.resolve({
              success: true,
              data: {
                success: false,
                results: [{ itemId: eligibleItem.id, itemName: "User Administrator", success: false, error }],
                errors: [{ itemId: eligibleItem.id, itemName: "User Administrator", success: false, error }]
              }
            });
          }
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: createTab
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("User Administrator"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    clickButton("Continue");
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")).toBeTruthy());
    setFieldValue(document.querySelector<HTMLTextAreaElement>(".justification-textarea")!, "Needed to resolve helpdesk escalation.");
    clickButton("Activate 1 selected");

    await waitFor(() => expect(document.body.textContent).toContain("Activation failed for 1 item."));
    expect(document.body.textContent).toContain("User Administrator: Microsoft requires an additional sign-in or MFA challenge");
    expect(document.body.textContent).toContain("Complete the Microsoft prompt in the matching portal page");
    expect(document.body.textContent).toContain("Activate 1 selected");
    expect(document.body.textContent).not.toContain(claims);
    expect(document.body.textContent).not.toContain("claims=");

    clickButton("Open Entra Roles portal");
    await waitFor(() => expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("aadmigratedroles") })));

    clickButton("Access Setup");
    await waitFor(() => expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://quickpim/settings.html#access" }));
  });

  test("toggles favorite rows with a star button and keeps favorites first", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const items: ActivationItem[] = [
      {
        id: "directoryRole:zebra:/",
        type: "directoryRole",
        sourceName: "Zebra Role",
        displayName: "Zebra Role",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        roleDefinitionId: "zebra",
        directoryScopeId: "/"
      },
      {
        id: "directoryRole:alpha:/",
        type: "directoryRole",
        sourceName: "Alpha Role",
        displayName: "Alpha Role",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        roleDefinitionId: "alpha",
        directoryScopeId: "/"
      }
    ];
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Alpha Role"));
    expect([...document.querySelectorAll(".role-title")].map((item) => item.textContent)).toEqual(["Alpha Role", "Zebra Role"]);

    document.querySelector<HTMLButtonElement>('button[aria-label="Add Zebra Role to favorites"]')?.click();

    await waitFor(() => {
      expect([...document.querySelectorAll(".role-title")].map((item) => item.textContent)).toEqual(["Zebra Role", "Alpha Role"]);
    });
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      favoriteItemIds: ["directoryRole:zebra:/"]
    });
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Remove Zebra Role from favorites"]')).toBeTruthy();
  });

  test("shows a crown icon after high privilege role names only", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const items: ActivationItem[] = [
      {
        id: "directoryRole:global-admin:/",
        type: "directoryRole",
        sourceName: "Global Administrator",
        displayName: "Global Administrator",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        isPrivileged: true,
        roleDefinitionId: "global-admin",
        directoryScopeId: "/"
      },
      {
        id: "directoryRole:reader:/",
        type: "directoryRole",
        sourceName: "Global Reader",
        displayName: "Global Reader",
        principalId: "principal-1",
        scopeLabel: "Tenant",
        status: "eligible",
        roleDefinitionId: "reader",
        directoryScopeId: "/"
      }
    ];
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Global Administrator"));
    const rows = [...document.querySelectorAll(".role-row")];
    const adminRow = rows.find((row) => row.textContent?.includes("Global Administrator"));
    const readerRow = rows.find((row) => row.textContent?.includes("Global Reader"));
    expect(adminRow?.querySelector(".crown-icon")).toBeTruthy();
    expect(readerRow?.querySelector(".crown-icon")).toBeFalsy();
  });
});

describe("popup activation guardrails", () => {
  test("warns when selecting more than four Entra roles", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const items: ActivationItem[] = Array.from({ length: 5 }, (_, index) => ({
      id: `directoryRole:role-${index + 1}:/`,
      type: "directoryRole",
      sourceName: `Role ${index + 1}`,
      displayName: `Role ${index + 1}`,
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: `role-${index + 1}`,
      directoryScopeId: "/",
      activationRequirements: {
        justification: false,
        ticket: false
      }
    }));
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Role 5"));
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => checkbox.click());

    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(document.body.textContent).not.toContain("PIM works best when roles are activated only for a specific need");
    clickButton("Continue");
    await waitFor(() => expect(document.body.textContent).toContain("PIM works best when roles are activated only for a specific need"));
    expect(document.body.textContent).toContain("Selecting many Entra roles by default reduces the value of just-in-time access.");
  });

  test("blocks generic justification text before sending activation", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const eligibleItem: ActivationItem = {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "principal-1",
      scopeLabel: "Tenant",
      status: "eligible",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      activationRequirements: {
        justification: true,
        ticket: false
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: [eligibleItem]
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };
    const sendMessage = vi.fn((message: { action: string }) => {
      if (message.action === "getTokenStatus") {
        return Promise.resolve({
          success: true,
          data: {
            graph: { hasToken: false },
            azureManagement: { hasToken: false }
          }
        });
      }
      if (message.action === "activateItems") {
        return Promise.resolve({ success: true, data: { success: true, results: [], errors: [] } });
      }
      return Promise.resolve({ success: true, data: { items: [], errors: [] } });
    });

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    });
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")).toBeFalsy();
    clickButton("Continue");
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")).toBeTruthy());
    setFieldValue(document.querySelector<HTMLTextAreaElement>(".justification-textarea")!, "BAU");
    clickButton("Activate 1 selected");

    await waitFor(() => expect(document.body.textContent).toContain("Justifications are requested for audit and approval"));
    expect(document.body.textContent).toContain("Generic answers such as BAU, Admin, or needed are blocked.");
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "activateItems" }));
  });
});

describe("popup draft persistence", () => {
  const pimGroupItem: ActivationItem = {
    id: "pimGroup:group-1:member",
    type: "pimGroup",
    sourceName: "Privileged Group",
    displayName: "Privileged Group",
    principalId: "principal-1",
    groupId: "group-1",
    accessId: "member",
    scopeLabel: "Group",
    status: "eligible",
    activationRequirements: {
      justification: true,
      ticket: true,
      maxDurationHours: 2
    }
  };

  function popupChromeMock(storageData: Record<string, unknown>, item: ActivationItem = pimGroupItem) {
    return {
      runtime: {
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationSnapshot") {
            return {
              success: true,
              data: {
                eligible: { items: [item], errors: [], diagnostics: [] },
                active: { items: [], errors: [], diagnostics: [] },
                eligibleByTarget: { [item.type]: { items: [item], errors: [], diagnostics: [] } },
                activeByTarget: { [item.type]: { items: [], errors: [], diagnostics: [] } }
              }
            };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: true, isExpired: false, tokenAge: 1 },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: true };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async (key: string) => {
            delete storageData[key];
          })
        }
      },
      tabs: {
        create: vi.fn()
      }
    };
  }

  test("shows only the useful quick filters", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: DEFAULT_SETTINGS };
    vi.stubGlobal("chrome", popupChromeMock(storageData));
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Privileged Group"));
    const labels = [...document.querySelectorAll<HTMLButtonElement>(".filter-chip")].map((button) => button.textContent?.trim());
    expect(labels).toEqual(["Favorites", "Eligible", "Active", "Needs reason"]);
  });

  test("restores selection, tab, search, sort, review state, duration, justification, and tickets", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [POPUP_DRAFT_KEY]: {
        updatedAt: Date.now(),
        tab: "pimGroup",
        search: "Privileged",
        sortMode: "activationCount",
        selectedIds: [pimGroupItem.id],
        durationHours: 2,
        justification: "Needed for group maintenance",
        ticketSystem: "ServiceNow",
        ticketNumber: "INC-123",
        isActivationReviewOpen: true
      }
    };

    vi.stubGlobal("chrome", popupChromeMock(storageData));
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Activate 1 selected"));
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")).toBeTruthy());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Filter roles"]')?.value).toBe("Privileged");
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Sort roles"]')?.value).toBe("activationCount");
    expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")?.value).toBe("Needed for group maintenance");
    const inputs = [...document.querySelectorAll<HTMLInputElement>(".activation-grid .input")];
    expect(inputs.map((input) => input.value)).toEqual(["ServiceNow", "INC-123"]);
    expect(document.querySelector<HTMLSelectElement>(".activation-bar .select")?.value).toBe("2");
  });

  test("keeps restored selected ids until activation data loads, then prunes invalid ids", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const snapshot = deferred<{ success: true; data: { eligible: { items: ActivationItem[]; errors: []; diagnostics: [] }; active: { items: []; errors: []; diagnostics: [] } } }>();
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [POPUP_DRAFT_KEY]: {
        updatedAt: Date.now(),
        tab: "pimGroup",
        search: "",
        sortMode: "name",
        selectedIds: [pimGroupItem.id],
        durationHours: 1,
        justification: "Needed for group maintenance",
        ticketSystem: "",
        ticketNumber: "",
        isActivationReviewOpen: true
      }
    };
    const chromeMock = popupChromeMock(storageData);
    (chromeMock.runtime as any).sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getActivationSnapshot") {
        return snapshot.promise;
      }
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: true, isExpired: false }, azureManagement: { hasToken: false } } };
      }
      return { success: true, data: true };
    });

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(storageData[POPUP_DRAFT_KEY]).toBeTruthy();
    snapshot.resolve({ success: true, data: { eligible: { items: [], errors: [], diagnostics: [] }, active: { items: [], errors: [], diagnostics: [] } } });

    await waitFor(() => expect(storageData[POPUP_DRAFT_KEY]).toMatchObject({ selectedIds: [], tab: "bundles" }));
    expect(document.body.textContent).not.toContain("Activate 1 selected");
  });

  test("saves draft after edits, preserves it before opening portal, and clears it from Unselect all", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const chromeMock = popupChromeMock(storageData);

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Privileged Group"));
    document.querySelector<HTMLElement>(".role-row.selectable")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).toContain("Continue"));
    clickButton("Continue");
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".justification-textarea")).toBeTruthy());
    setFieldValue(document.querySelector<HTMLTextAreaElement>(".justification-textarea")!, "Needed for group maintenance");
    const inputs = [...document.querySelectorAll<HTMLInputElement>(".activation-grid .input")];
    setFieldValue(inputs[0], "ServiceNow");
    setFieldValue(inputs[1], "INC-456");

    await waitFor(() => {
      expect(storageData[POPUP_DRAFT_KEY]).toMatchObject({
        tab: "pimGroup",
        selectedIds: [pimGroupItem.id],
        justification: "Needed for group maintenance",
        ticketSystem: "ServiceNow",
        ticketNumber: "INC-456",
        isActivationReviewOpen: true
      });
    });

    document.querySelector<HTMLButtonElement>('button[aria-label="Open PIM Groups in Microsoft Entra"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalled());
    expect(storageData[POPUP_DRAFT_KEY]).toBeTruthy();

    clickButton("Unselect all");
    await waitFor(() => expect(storageData[POPUP_DRAFT_KEY]).toBeUndefined());
  });
});

describe("popup role row styling", () => {
  test("right-aligns activation count and status badge in the status column", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const statusStackRule = css.match(/\.role-status-stack\s*\{[^}]+\}/)?.[0] || "";

    expect(statusStackRule).toContain("justify-items: end;");
    expect(statusStackRule).toContain("text-align: right;");
  });

  test("bounds long role names so they wrap inside the row instead of overlapping status", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const rowRule = css.match(/\.role-row\s*\{[^}]+\}/)?.[0] || "";
    const mainRule = css.match(/\.role-main\s*\{[^}]+\}/)?.[0] || "";
    const titleTextRule = css.match(/\.role-title\s+span\s*\{[^}]+\}/)?.[0] || "";

    expect(rowRule).toContain("minmax(58px, auto)");
    expect(mainRule).toContain("min-width: 0;");
    expect(mainRule).toContain("overflow: hidden;");
    expect(titleTextRule).toContain("overflow-wrap: anywhere;");
  });

  test("keeps popup controls compact and separates activation buttons from fields", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const toolbarRule = css.match(/\.toolbar\s*\{[^}]+\}/)?.[0] || "";
    const headerActionsRule = css.match(/\.header-actions\s*\{[^}]+\}/)?.[0] || "";
    const activationButtonRule = css.match(/\.activation-bar\s+\.button-row\s*\{[^}]+\}/)?.[0] || "";

    expect(headerActionsRule).toContain("justify-content: flex-end;");
    expect(toolbarRule).toContain("grid-template-columns: minmax(0, 1fr) 150px;");
    expect(activationButtonRule).toContain("margin-top: 0;");
  });

  test("positions the refresh success check over the refresh button and fades it out", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const refreshButtonRule = css.match(/\.refresh-button\s*\{[^}]+\}/)?.[0] || "";
    const successRule = css.match(/\.refresh-success-indicator\s*\{[^}]+\}/)?.[0] || "";

    expect(refreshButtonRule).toContain("position: relative;");
    expect(successRule).toContain("position: absolute;");
    expect(successRule).toContain("animation: refreshSuccessFade 4s ease forwards;");
  });

  test("keeps activation review in flow with sticky bottom behavior instead of fixed overlap", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const shellRule = css.match(/\.app-shell\s*\{[^}]+\}/)?.[0] || "";
    const contentRule = css.match(/\.content\s*\{[^}]+\}/)?.[0] || "";
    const activationRule = css.match(/\.activation-bar\s*\{[^}]+\}/)?.[0] || "";

    expect(shellRule).toContain("display: flex;");
    expect(shellRule).toContain("flex-direction: column;");
    expect(shellRule).toContain("min-height: 600px;");
    expect(shellRule).not.toContain("min-height: 640px;");
    expect(contentRule).toContain("padding-bottom: 12px;");
    expect(contentRule).not.toContain("padding-bottom: 248px;");
    expect(activationRule).toContain("position: sticky;");
    expect(activationRule).toContain("z-index: 20;");
    expect(activationRule).toContain("margin-top: auto;");
    expect(activationRule).toContain("flex-shrink: 0;");
    expect(activationRule).toContain("overflow-y: auto;");
    expect(activationRule).not.toContain("position: fixed;");
  });

  test("keeps activation progress visible near the top while the popup scrolls", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const progressRule = css.match(/\.activation-progress-panel\s*\{[^}]+\}/)?.[0] || "";

    expect(progressRule).toContain("position: sticky;");
    expect(progressRule).toContain("top: 0;");
    expect(progressRule).toContain("z-index: 20;");
  });

  test("adds icon padding inside toolbar fields", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const iconRule = css.match(/\.field-icon\s*\{[^}]+\}/)?.[0] || "";
    const iconInputRule = css.match(/\.control-with-icon\s+\.input,\s*\.control-with-icon\s+\.select\s*\{[^}]+\}/)?.[0] || "";

    expect(iconRule).toContain("position: absolute;");
    expect(iconInputRule).toContain("padding-left: 34px;");
  });

  test("includes dark mode surface overrides", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const darkRule = css.match(/body\.dark-mode\s*\{[^}]+\}/)?.[0] || "";
    const darkPanelRule = css.match(/body\.dark-mode\s+\.panel,\s*body\.dark-mode\s+\.role-row\s*\{[^}]+\}/)?.[0] || "";

    expect(darkRule).toContain("color-scheme: dark;");
    expect(darkPanelRule).toContain("background: #1e293b;");
  });
});

describe("popup dark mode", () => {
  test("applies the saved dark mode preference on load", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        preferences: {
          ...DEFAULT_SETTINGS.preferences,
          darkMode: true
        }
      },
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        },
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn((message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return Promise.resolve({
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            });
          }
          return Promise.resolve({ success: true, data: { items: [], errors: [] } });
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      },
      tabs: {
        create: vi.fn()
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/popup/main");

    await waitFor(() => expect(document.body.textContent).toContain("Load your PIM roles"));
    await waitFor(() => expect(document.body.classList.contains("dark-mode")).toBe(true));
  });
});
