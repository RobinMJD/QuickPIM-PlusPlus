import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTargetCacheKey } from "../src/lib/access";
import { DATA_CACHE_KEY } from "../src/lib/cache";
import { POPUP_DRAFT_KEY } from "../src/lib/popupDraft";
import { REQUEST_TRACKING_KEY } from "../src/lib/requestTracking";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";
import { MAX_USER_JUSTIFICATION_LENGTH } from "../src/lib/justifications";
import { formatLocalDateTime } from "../src/lib/dateFormat";
import { MAX_SETTINGS_BACKUP_BYTES } from "../src/lib/settingsBackup";
import { TEST_APP_VERSION, TEST_MANIFEST, TEST_RELEASE_TAG, testReleaseUrl } from "./testMetadata";

afterEach(async () => {
  const cleanupWindow = window as Window & { __quickPimSettingsUnmount?: () => void };
  cleanupWindow.__quickPimSettingsUnmount?.();
  cleanupWindow.__quickPimSettingsUnmount = undefined;
  // Preferences intentionally flush on unmount. Let that queue settle before
  // replacing the mocked Chrome storage for the next test.
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.body.className = "";
});

function clickButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return button;
}

function getExactButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function clickExactButton(label: string): HTMLButtonElement {
  const button = getExactButton(label);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return button;
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function createDefaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
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

function createBasicSettingsChrome(storageData: Record<string, unknown>, options: {
  removePermission?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    notifications: {
      create: vi.fn(async () => "quickpim-test")
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: options.removePermission || vi.fn(async () => true)
    },
    runtime: {
      getManifest: () => TEST_MANIFEST,
      getURL: (path: string) => `chrome-extension://quickpim/${path}`,
      sendMessage: vi.fn(async (message: { action: string; settings?: unknown; store?: unknown }) => {
        if (message.action === "getTokenStatus") {
          return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
        }
        if (message.action === "getActivationSnapshot") {
          return {
            success: true,
            data: {
              eligible: { items: [], errors: [], diagnostics: [] },
              active: { items: [], errors: [], diagnostics: [] },
              tokenStatus: { graph: { hasToken: false }, azureManagement: { hasToken: false } }
            }
          };
        }
        if (message.action === "restoreSettingsBackup") {
          storageData[SETTINGS_KEY] = message.settings;
          storageData[REQUEST_TRACKING_KEY] = message.store;
          return {
            success: true,
            data: { settings: message.settings, trackedRequests: message.store }
          };
        }
        return { success: true, data: { items: [], errors: [], diagnostics: [] } };
      })
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
        remove: vi.fn(async () => undefined)
      }
    }
  };
}

describe("settings Home page", () => {
  test("opens on a home dashboard with grouped icon navigation and a GitHub changelog", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#home");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(`/releases/tags/${TEST_RELEASE_TAG}`)) {
        return {
          ok: true,
          json: async () => ({
            tag_name: TEST_RELEASE_TAG,
            name: `QuickPIM++ ${TEST_RELEASE_TAG}`,
            body: "React rewrite, bundles, PIM groups, and cleaner settings.",
            html_url: testReleaseUrl(),
            published_at: "2026-05-18T10:00:00.000Z"
          })
        };
      }
      return { ok: true, json: async () => [] };
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("QuickPIM++ is a local-first activation console"));
    await waitFor(() => expect(document.body.textContent).toContain(`QuickPIM++ ${TEST_RELEASE_TAG}`));
    expect(document.body.textContent).toContain("2026-05-18");
    expect(document.body.textContent).not.toContain("5/18/2026");
    expect(document.body.textContent).toContain("Set up role access, personalize the popup, configure activation, and manage local data.");
    expect(document.body.textContent).toContain("Overview");
    expect(document.body.textContent).toContain("Access");
    expect(document.body.textContent).toContain("Activation");
    expect(document.body.textContent).toContain("Personalization");
    expect(document.body.textContent).toContain("Review");
    expect(document.body.textContent).toContain("Data & Support");
    expect(document.body.textContent).toContain("Product");

    const navButtons = [...document.querySelectorAll(".settings-nav button")].map((button) => button.textContent?.trim());
    expect(navButtons).toEqual([
      "Home",
      "Role Access",
      "Popup & Appearance",
      "Names & Aliases",
      "Activation & Notifications",
      "Justifications",
      "Bundles",
      "Activity & Usage",
      "Browser Sync",
      "Diagnostics",
      "Backup & Restore",
      "Reset QuickPIM++",
      "About"
    ]);
    expect(navButtons.at(-1)).toBe("About");
    expect(document.querySelectorAll(".settings-nav-icon")).toHaveLength(13);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.github.com/repos/RobinMJD/QuickPIM-PlusPlus/releases/tags/${TEST_RELEASE_TAG}`);
  });

  test("uses cached GitHub changelog data without fetching again", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#home");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      "quickPimChangelog.v2": {
        fetchedAt: Date.now(),
        releaseTag: TEST_RELEASE_TAG,
        items: [
          {
            title: `Cached ${TEST_RELEASE_TAG}`,
            description: "Cached release notes.",
            url: testReleaseUrl(),
            date: "2026-05-18T10:00:00.000Z"
          }
        ]
      }
    };
    const fetchMock = vi.fn(async () => {
      throw new Error("Fresh changelog fetch should not run for a valid cache.");
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain(`Cached ${TEST_RELEASE_TAG}`));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("ignores cached changelog data from a different app release", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#home");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      "quickPimChangelog.v2": {
        fetchedAt: Date.now(),
        releaseTag: "v2.1.0",
        items: [
          {
            title: "Cached v2.1.0",
            description: "Old cached release notes.",
            url: "https://github.com/RobinMJD/QuickPIM-PlusPlus/releases/tag/v2.1.0",
            date: "2026-05-18T10:00:00.000Z"
          }
        ]
      }
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(`/releases/tags/${TEST_RELEASE_TAG}`)) {
        return {
          ok: true,
          json: async () => ({
            tag_name: TEST_RELEASE_TAG,
            name: `QuickPIM++ ${TEST_RELEASE_TAG}`,
            body: "Fixes the settings changelog cache.",
            html_url: testReleaseUrl(),
            published_at: "2026-05-21T10:00:00.000Z"
          })
        };
      }
      return { ok: true, json: async () => [] };
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain(`QuickPIM++ ${TEST_RELEASE_TAG}`));
    expect(document.body.textContent).not.toContain("Cached v2.1.0");
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.github.com/repos/RobinMJD/QuickPIM-PlusPlus/releases/tags/${TEST_RELEASE_TAG}`);
    expect(storageData["quickPimChangelog.v2"]).toMatchObject({
      releaseTag: TEST_RELEASE_TAG
    });
  });
});

describe("settings About page", () => {
  test("renders independent rewrite attribution, version, and local privacy note", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#about");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "0.0.0" }),
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const text = document.body.textContent || "";
    expect(text).toContain(`QuickPIM++ ${TEST_APP_VERSION}`);
    expect(text).not.toContain("0.0.0");
    expect(text).toMatch(/Build: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(text).toContain("Concept credit: Daniel Bradley");
    expect(document.querySelector<HTMLAnchorElement>('a[href="https://github.com/DanielBradley1/QuickPIM"]')?.textContent).toBe(
      "Daniel Bradley"
    );
    expect(text).toContain("independent React and TypeScript implementation with a fully rewritten application codebase");
    expect(text).toContain("role bundles, saved justifications, favorites, aliases, dark mode, learned names, access setup, and much more!");
    expect(text).not.toContain("security hardening");
    expect(text).toContain("Tokens and settings stay in this browser profile.");
  });
});

describe("settings Access Setup page", () => {
  test("uses fresh cached eligible items when settings opens", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#aliases");
    const settings = createDefaultSettings();
    settings.aliasesByItemId = {
      "directoryRole:windows-laps:/": "Privileged workstation alias",
      "pimGroup:group-z:member": "Global Administrator"
    };

    const tokens = {
      graph: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 },
      graphTargets: {
        directoryRole: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 },
        pimGroup: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 }
      },
      azureManagement: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 }
    };
    const directoryItems = [
      {
        id: "directoryRole:windows-laps:/",
        type: "directoryRole",
        sourceName: "Windows LAPS Administrator",
        displayName: "Windows LAPS Administrator",
        principalId: "user-1",
        roleDefinitionId: "windows-laps",
        directoryScopeId: "/",
        scopeLabel: "Tenant",
        status: "eligible"
      },
      {
        id: "directoryRole:application-admin:/",
        type: "directoryRole",
        sourceName: "Application Administrator",
        displayName: "Application Administrator",
        principalId: "user-1",
        roleDefinitionId: "application-admin",
        directoryScopeId: "/",
        scopeLabel: "Tenant",
        status: "eligible"
      }
    ];
    const groupItems = [
      {
        id: "pimGroup:group-z:member",
        type: "pimGroup",
        sourceName: "GRP_Z_Privileged",
        displayName: "GRP_Z_Privileged",
        principalId: "user-1",
        groupId: "group-z",
        accessId: "member",
        scopeLabel: "Member",
        status: "eligible"
      },
      {
        id: "pimGroup:group-a:member",
        type: "pimGroup",
        sourceName: "GRP_A_Privileged",
        displayName: "GRP_A_Privileged",
        principalId: "user-1",
        groupId: "group-a",
        accessId: "member",
        scopeLabel: "Member",
        status: "eligible"
      }
    ];
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings,
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(tokens, "directoryRole"),
            errors: [],
            items: directoryItems
          },
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(tokens, "pimGroup"),
            errors: [],
            items: groupItems
          },
          azureRole: {
            fetchedAt: Date.now(),
            cacheKey: buildTargetCacheKey(tokens, "azureRole"),
            errors: [],
            items: []
          }
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            throw new Error("Settings should use cached eligible data.");
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: tokens
            };
          }
          return { success: true, data: true };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Windows LAPS Administrator"));

    const picker = document.querySelector<HTMLSelectElement>('select[aria-label="Role or group"]');
    expect(picker).toBeTruthy();
    const groups = [...picker!.querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["Roles", "Groups"]);
    expect([...groups[0].querySelectorAll("option")].map((option) => option.textContent?.trim())).toEqual([
      "Application Administrator / Tenant",
      "Windows LAPS Administrator / Tenant"
    ]);
    expect([...groups[1].querySelectorAll("option")].map((option) => option.textContent?.trim())).toEqual([
      "GRP_A_Privileged / Member",
      "GRP_Z_Privileged / Member"
    ]);
    expect(picker!.textContent).not.toContain("Privileged workstation alias");
    expect(picker!.textContent).not.toContain("Global Administrator");

    const actions = chromeMock.runtime.sendMessage.mock.calls.map(([message]) => message.action);
    expect(actions).not.toContain("getActivationItems");
  });

  test("renders portal-driven setup without dedicated app or PowerShell guidance", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const openedTargets: string[][] = [];
    let portalOpened = false;
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string; targets?: string[] }) => {
          if (message.action === "openPortalRecoveryTabs") {
            portalOpened = true;
            openedTargets.push(message.targets || []);
            return { success: true, data: { requestedCount: 3, openedCount: 3, reusedCount: 0, managedCount: 3, grouped: true } };
          }
          if (message.action === "getActivationItems" || message.action === "getActiveItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: portalOpened
                ? {
                  graph: { hasToken: true, capturedAt: Date.now() },
                  graphTargets: {
                    directoryRole: { hasToken: true, capturedAt: Date.now() },
                    pimGroup: { hasToken: true, capturedAt: Date.now() }
                  },
                  azureManagement: { hasToken: true, capturedAt: Date.now() }
                }
                : {
                  graph: { hasToken: false },
                  azureManagement: { hasToken: false }
                }
            };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      tabs: { create: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const text = document.body.textContent || "";
    expect(text).toContain("Role Access");
    expect(text).toContain("Open missing portal pages");
    expect(text).not.toMatch(/dedicated app|manual token|app registration|PowerShell/i);

    clickButton("Open missing portal pages");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(openedTargets).toEqual([["directoryRole", "pimGroup", "azureRole"]]);
  });

  test("renders feature-specific success and failure diagnostics", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const tokens = {
      graph: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 },
      graphTargets: {
        directoryRole: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 },
        pimGroup: { hasToken: true, isExpired: false, tenantId: "tenant-1", principalId: "user-1", capturedAt: 1 }
      },
      azureManagement: { hasToken: false }
    };
    const directoryCacheKey = buildTargetCacheKey(tokens, "directoryRole");
    const pimGroupCacheKey = buildTargetCacheKey(tokens, "pimGroup");
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: directoryCacheKey,
            errors: [],
            items: [],
            diagnostics: [
              {
                target: "directoryRole",
                success: true,
                checkedAt: "2026-06-12T10:00:00.000Z",
                operation: "eligible",
                endpointLabel: "Entra role eligibility"
              }
            ]
          },
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: pimGroupCacheKey,
            errors: [],
            items: [],
            diagnostics: [
              {
                target: "pimGroup",
                success: true,
                checkedAt: "2026-06-12T10:00:30.000Z",
                operation: "eligible",
                endpointLabel: "PIM group eligibility"
              }
            ]
          }
        },
        activeByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: directoryCacheKey,
            errors: [],
            items: [],
            diagnostics: [
              {
                target: "directoryRole",
                success: true,
                checkedAt: "2026-06-12T10:00:10.000Z",
                operation: "active",
                endpointLabel: "Entra role active assignments"
              }
            ]
          },
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: pimGroupCacheKey,
            errors: ["PermissionScopeNotGranted"],
            items: [],
            diagnostics: [
              {
                target: "pimGroup",
                success: false,
                checkedAt: "2026-06-12T10:01:00.000Z",
                operation: "active",
                endpointLabel: "PIM group active assignments",
                failureKind: "missingCapability",
                error: "PIM group access is limited."
              }
            ]
          }
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: tokens
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Eligible assignments"));
    expect(document.body.textContent).toContain("Last failure");
    expect(document.body.textContent).toContain("PIM group active assignments");
    expect(document.body.textContent).toContain("missingCapability");
  });

  test("rescans existing Entra tabs before opening setup pages", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const readyTokens = {
      graph: { hasToken: true, capturedAt: 2, tenantId: "tenant-1", principalId: "user-1" },
      graphTargets: {
        directoryRole: {
          hasToken: true,
          capturedAt: 2,
          tenantId: "tenant-1",
          principalId: "user-1",
          grantedScopes: ["RoleEligibilitySchedule.Read.Directory", "RoleAssignmentSchedule.ReadWrite.Directory"]
        },
        pimGroup: {
          hasToken: true,
          capturedAt: 2,
          tenantId: "tenant-1",
          principalId: "user-1",
          grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
        }
      },
      azureManagement: { hasToken: true, capturedAt: 2, tenantId: "tenant-1", principalId: "user-1" }
    };
    const readyEntry = (target: "directoryRole" | "pimGroup" | "azureRole", operation: "eligible" | "active") => ({
      fetchedAt: Date.now(),
      cacheKey: buildTargetCacheKey(readyTokens, target),
      errors: [],
      items: [],
      diagnostics: [{
        target,
        success: true,
        checkedAt: "2026-06-12T10:00:00.000Z",
        operation,
        endpointLabel: `${target} ${operation}`
      }]
    });
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligibleByTarget: {
          directoryRole: readyEntry("directoryRole", "eligible"),
          pimGroup: readyEntry("pimGroup", "eligible"),
          azureRole: readyEntry("azureRole", "eligible")
        },
        activeByTarget: {
          directoryRole: readyEntry("directoryRole", "active"),
          pimGroup: readyEntry("pimGroup", "active"),
          azureRole: readyEntry("azureRole", "active")
        }
      }
    };
    let tokenRequests = 0;
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems" || message.action === "getActiveItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus" || message.action === "refreshPortalTokens") {
            tokenRequests += 1;
            const currentTokens = tokenRequests === 1
                ? {
                  graph: { hasToken: false },
                  azureManagement: { hasToken: false }
                }
                : readyTokens;
            return message.action === "refreshPortalTokens"
              ? { success: true, data: { tokenStatus: currentTokens, tabsFound: 1, tabsScanned: 1, captured: ["graph", "azureManagement"] } }
              : { success: true, data: currentTokens };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon" }]),
        sendMessage: vi.fn(async () => ({ success: true })),
        create: vi.fn()
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));
    await waitFor(() => expect(tokenRequests).toBeGreaterThanOrEqual(1));

    clickButton("Open missing portal pages");

    await waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ action: "refreshPortalTokens" }));
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: "openPortalRecoveryTabs" }));
  });

  test("restores Microsoft sign-in recovery in Access Setup and focuses the managed tab", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");
    const settings = createDefaultSettings();
    settings.preferences.enabledFeatures = ["directoryRole"];
    settings.preferences.autoEnabledFeaturesInitialized = true;
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
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getTokenStatus") return { success: true, data: missingTokens };
      if (message.action === "getPortalRecoveryStatus") return { success: true, data: recoveryStatus };
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
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    });
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Microsoft sign-in needed"));
    expect(document.body.textContent).toContain("Choose an account or finish signing in");
    clickButton("Continue Microsoft sign-in");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ action: "focusPortalRecoveryTabs" }));
  });

  test("waits for a newer portal token instead of accepting an existing limited token", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const firstCapture = Date.now() - 5000;
    const cacheFetchedAt = firstCapture + 1000;
    const secondCapture = cacheFetchedAt + 1000;
    const settings = createDefaultSettings();
    settings.preferences.enabledFeatures = ["pimGroup"];
    settings.preferences.autoEnabledFeaturesInitialized = true;
    const limitedEntry = {
      items: [],
      errors: ["PermissionScopeNotGranted"],
      fetchedAt: cacheFetchedAt,
      cacheKey: "graphPimGroup:",
      diagnostics: [{
        target: "pimGroup" as const,
        success: false,
        checkedAt: new Date(cacheFetchedAt).toISOString(),
        failureKind: "missingCapability" as const,
        error: "PIM group access is limited."
      }]
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings,
      [DATA_CACHE_KEY]: {
        eligibleByTarget: { pimGroup: limitedEntry },
        activeByTarget: { pimGroup: limitedEntry }
      }
    };
    let tokenRequests = 0;
    const openedTargets: string[][] = [];
    const refreshedTargets: string[][] = [];
    const tokenStatus = (capturedAt: number) => ({
      graph: { hasToken: true, capturedAt },
      graphTargets: { pimGroup: { hasToken: true, capturedAt } },
      azureManagement: { hasToken: false }
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string; targets?: string[] }) => {
          if (message.action === "openPortalRecoveryTabs") {
            openedTargets.push(message.targets || []);
            return { success: true, data: { requestedCount: 1, openedCount: 1, reusedCount: 0, managedCount: 1, grouped: true } };
          }
          if (message.action === "getTokenStatus" || message.action === "refreshPortalTokens") {
            tokenRequests += 1;
            const currentTokens = tokenStatus(tokenRequests < 3 ? firstCapture : secondCapture);
            return message.action === "refreshPortalTokens"
              ? { success: true, data: { tokenStatus: currentTokens, tabsFound: 1, tabsScanned: 1, captured: tokenRequests < 3 ? [] : ["graph"] } }
              : { success: true, data: currentTokens };
          }
          if (message.action === "getActivationSnapshot") {
            refreshedTargets.push(message.targets || []);
            return {
              success: true,
              data: {
                eligible: { items: [], errors: [], diagnostics: [] },
                active: { items: [], errors: [], diagnostics: [] },
                eligibleByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
                activeByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
                tokenStatus: tokenStatus(secondCapture)
              }
            };
          }
          return { success: true, data: true };
        })
      },
      tabs: {
        query: vi.fn(async () => [{ id: 81, url: "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon" }]),
        sendMessage: vi.fn(async () => ({ success: true })),
        create: vi.fn()
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(tokenRequests).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(document.body.textContent).toContain("1 area(s)"));
    openedTargets.length = 0;

    clickButton("Open missing portal pages");

    await waitFor(() => expect(openedTargets).toContainEqual(["pimGroup"]));
    await waitFor(() => expect(refreshedTargets).toContainEqual(["pimGroup"]));
    expect(tokenRequests).toBeGreaterThanOrEqual(3);
  });

  test("recheck now rescans existing portal tabs before recomputing access state", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    let tokenRequests = 0;
    let resolveInitialTokenStatus: ((value: unknown) => void) | undefined;
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return {
              success: true,
              data: {
                items: [],
                errors: [],
                diagnostics: tokenRequests > 1
                  ? [
                    { target: "directoryRole", success: true, checkedAt: "2026-05-18T10:00:00.000Z" },
                    { target: "pimGroup", success: true, checkedAt: "2026-05-18T10:00:00.000Z" }
                  ]
                  : []
              }
            };
          }
          if (message.action === "getActiveItems") {
            return {
              success: true,
              data: {
                items: [],
                errors: [],
                diagnostics: [
                  { target: "directoryRole", success: true, checkedAt: "2026-05-18T10:00:00.000Z" },
                  { target: "pimGroup", success: true, checkedAt: "2026-05-18T10:00:00.000Z" }
                ]
              }
            };
          }
          if (message.action === "getTokenStatus" || message.action === "refreshPortalTokens") {
            tokenRequests += 1;
            const currentTokens = tokenRequests === 1
                ? {
                  graph: { hasToken: false },
                  azureManagement: { hasToken: true, capturedAt: 1 }
                }
                : {
                  graph: { hasToken: true, capturedAt: 2 },
                  azureManagement: { hasToken: true, capturedAt: 1 }
                };
            if (message.action === "getTokenStatus" && tokenRequests === 1) {
              return await new Promise((resolve) => {
                resolveInitialTokenStatus = resolve;
              });
            }
            return message.action === "refreshPortalTokens"
              ? { success: true, data: { tokenStatus: currentTokens, tabsFound: 1, tabsScanned: 1, captured: ["graph"] } }
              : { success: true, data: currentTokens };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      tabs: {
        query: vi.fn(async () => [{ id: 73, url: "https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon" }]),
        sendMessage: vi.fn(async () => ({ success: true })),
        create: vi.fn()
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));

    const recheckButton = clickButton("Recheck now");
    expect(recheckButton.disabled).toBe(false);
    resolveInitialTokenStatus?.({
      success: true,
      data: {
        graph: { hasToken: false },
        azureManagement: { hasToken: true, capturedAt: 1 }
      }
    });

    await waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ action: "refreshPortalTokens" }));
    await waitFor(() => expect(tokenRequests).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(document.body.textContent).toContain("Access data refreshed."));
  });

  test("does not queue another access refresh for token writes produced by its own portal scan", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const settings = createDefaultSettings();
    settings.preferences.enabledFeatures = ["pimGroup"];
    settings.preferences.autoEnabledFeaturesInitialized = true;
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    let storageChangeListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    let snapshotRequests = 0;
    const tokens = {
      graph: { hasToken: true, capturedAt: 2 },
      graphTargets: { pimGroup: { hasToken: true, capturedAt: 2 } },
      azureManagement: { hasToken: false }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return { success: true, data: tokens };
          }
          if (message.action === "refreshPortalTokens") {
            storageChangeListener?.({
              graphPimGroupToken: { oldValue: "old", newValue: "new" },
              graphPimGroupTokenTimestamp: { oldValue: 1, newValue: 2 }
            }, "session");
            return { success: true, data: { tokenStatus: tokens, tabsFound: 1, tabsScanned: 1, captured: ["graph"] } };
          }
          if (message.action === "getActivationSnapshot") {
            snapshotRequests += 1;
            return {
              success: true,
              data: {
                eligible: { items: [], errors: [], diagnostics: [] },
                active: { items: [], errors: [], diagnostics: [] },
                eligibleByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
                activeByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
                tokenStatus: tokens
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
          remove: vi.fn(async () => undefined)
        },
        onChanged: {
          addListener: vi.fn((listener) => { storageChangeListener = listener; }),
          removeListener: vi.fn()
        }
      },
      tabs: { create: vi.fn() }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));

    clickButton("Recheck now");

    await waitFor(() => expect(document.body.textContent).toContain("Access data refreshed."));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(snapshotRequests).toBe(1);
  });

  test("leaves the access loading state when a refresh operation times out", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const tokens = {
      graph: { hasToken: true, capturedAt: 1 },
      azureManagement: { hasToken: true, capturedAt: 1 }
    };
    const timeoutError = Object.assign(new Error("PIM Groups refresh timed out. Cached data remains available."), {
      name: "OperationTimeoutError"
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") return { success: true, data: tokens };
          if (message.action === "refreshPortalTokens") {
            return { success: true, data: { tokenStatus: tokens, tabsFound: 0, tabsScanned: 0, captured: [] } };
          }
          if (message.action === "getActivationSnapshot") throw timeoutError;
          return { success: true, data: true };
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
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));

    clickButton("Recheck now");

    await waitFor(() => expect(document.body.textContent).toContain("PIM Groups refresh timed out"));
    await waitFor(() => expect(document.querySelector(".loading-panel")).toBeNull());
    const recheckButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Recheck now"));
    expect(recheckButton?.disabled).toBe(false);
  });

  test("refreshes the affected feature when a portal token arrives after setup", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    let tokenRequests = 0;
    let storageChangeListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    const refreshedTargets: string[][] = [];
    const readyTokenStatus = {
      graph: { hasToken: true, capturedAt: 200 },
      graphTargets: {
        pimGroup: { hasToken: true, capturedAt: 200 }
      },
      azureManagement: { hasToken: false }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string; targets?: string[] }) => {
          if (message.action === "getTokenStatus") {
            tokenRequests += 1;
            return {
              success: true,
              data: tokenRequests === 1
                ? { graph: { hasToken: false }, azureManagement: { hasToken: false } }
                : readyTokenStatus
            };
          }
          if (message.action === "getActivationSnapshot") {
            refreshedTargets.push(message.targets || []);
            return {
              success: true,
              data: {
                eligible: { items: [], errors: [], diagnostics: [] },
                active: { items: [], errors: [], diagnostics: [] },
                eligibleByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
                activeByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
                tokenStatus: readyTokenStatus
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        },
        onChanged: {
          addListener: vi.fn((listener) => {
            storageChangeListener = listener;
          }),
          removeListener: vi.fn()
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(tokenRequests).toBeGreaterThanOrEqual(1));

    storageChangeListener?.({
      graphToken: { oldValue: undefined, newValue: "captured" },
      tokenTimestamp: { oldValue: undefined, newValue: 200 },
      graphPimGroupToken: { oldValue: undefined, newValue: "captured" },
      graphPimGroupTokenTimestamp: { oldValue: undefined, newValue: 200 }
    }, "session");

    await waitFor(() => expect(refreshedTargets).toContainEqual(["pimGroup"]), 2000);
    await waitFor(() => expect(document.body.textContent).toContain("Portal access updated."));
  });

  test("clears an older access error after a queued token recovery succeeds", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const configuredSettings = createDefaultSettings();
    configuredSettings.preferences.enabledFeatures = ["pimGroup"];
    configuredSettings.preferences.autoEnabledFeaturesInitialized = true;
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: configuredSettings };
    let storageChangeListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;
    let currentCapture = 1;
    let snapshotCalls = 0;
    let resolveFirstSnapshot: ((value: unknown) => void) | undefined;
    const status = () => ({
      graph: { hasToken: true, capturedAt: currentCapture },
      graphTargets: { pimGroup: { hasToken: true, capturedAt: currentCapture } },
      azureManagement: { hasToken: false }
    });
    const snapshot = (errors: string[], capturedAt: number) => ({
      success: true,
      data: {
        eligible: { items: [], errors, diagnostics: [] },
        active: { items: [], errors: [], diagnostics: [] },
        eligibleByTarget: { pimGroup: { items: [], errors, diagnostics: [] } },
        activeByTarget: { pimGroup: { items: [], errors: [], diagnostics: [] } },
        tokenStatus: {
          graph: { hasToken: true, capturedAt },
          graphTargets: { pimGroup: { hasToken: true, capturedAt } },
          azureManagement: { hasToken: false }
        }
      }
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return { success: true, data: status() };
          }
          if (message.action === "refreshPortalTokens") {
            return { success: true, data: { tokenStatus: status(), tabsFound: 1, tabsScanned: 1, captured: ["graph"] } };
          }
          if (message.action === "getActivationSnapshot") {
            snapshotCalls += 1;
            if (snapshotCalls === 1) {
              return await new Promise((resolve) => { resolveFirstSnapshot = resolve; });
            }
            return snapshot([], currentCapture);
          }
          return { success: true, data: true };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        },
        onChanged: {
          addListener: vi.fn((listener) => { storageChangeListener = listener; }),
          removeListener: vi.fn()
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));
    await waitFor(() => expect(storageChangeListener).toBeTypeOf("function"));

    currentCapture = 2;
    storageChangeListener?.({
      graphPimGroupToken: { oldValue: "initial", newValue: "first" },
      graphPimGroupTokenTimestamp: { oldValue: 1, newValue: 2 }
    }, "session");
    await waitFor(() => expect(snapshotCalls).toBe(1));
    currentCapture = 3;
    storageChangeListener?.({
      graphPimGroupToken: { oldValue: "first", newValue: "second" },
      graphPimGroupTokenTimestamp: { oldValue: 2, newValue: 3 }
    }, "session");
    await new Promise((resolve) => setTimeout(resolve, 450));
    resolveFirstSnapshot?.(snapshot(["Microsoft Graph access is limited in the captured portal token."], 2));

    await waitFor(() => expect(snapshotCalls).toBe(2), 2000);
    await waitFor(() => expect(document.body.textContent).toContain("Portal access updated."), 2000);
    expect(document.body.textContent).not.toContain("Microsoft Graph access is limited in the captured portal token.");
    expect(document.querySelector(".message.error")).toBeNull();
  });

  test("shows progress while rechecking access data", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    let eligibleCalls = 0;
    let holdEligibleRefresh = false;
    let resolveEligibleRefresh: ((value: unknown) => void) | undefined;
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            eligibleCalls += 1;
            if (holdEligibleRefresh) {
              return await new Promise((resolve) => {
                resolveEligibleRefresh = resolve;
              });
            }
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getActiveItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: true, capturedAt: 1 },
                azureManagement: { hasToken: true, capturedAt: 1 }
              }
            };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      tabs: {
        create: vi.fn()
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));

    holdEligibleRefresh = true;
    clickButton("Recheck now");
    await waitFor(() => expect(document.body.textContent).toContain("Refreshing access data"));
    expect(document.querySelectorAll(".smart-progress-panel")).toHaveLength(1);
    expect(document.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(
      [...document.querySelectorAll("p.message")].some((element) =>
        element.textContent?.includes("Refreshing access data")
      )
    ).toBe(false);
    expect(eligibleCalls).toBe(1);
    resolveEligibleRefresh?.({ success: true, data: { items: [], errors: [] } });
  });

  test("shows progress while refreshing eligible items", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    let eligibleCalls = 0;
    let holdEligibleRefresh = false;
    let resolveEligibleRefresh: ((value: unknown) => void) | undefined;
    let tokenStatusCalls = 0;
    let resolveInitialTokenStatus: ((value: unknown) => void) | undefined;
    const readyTokens = {
      success: true,
      data: {
        graph: { hasToken: true, capturedAt: 1 },
        azureManagement: { hasToken: true, capturedAt: 1 }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            eligibleCalls += 1;
            if (holdEligibleRefresh) {
              return await new Promise((resolve) => {
                resolveEligibleRefresh = resolve;
              });
            }
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getActiveItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            tokenStatusCalls += 1;
            if (tokenStatusCalls === 1) {
              return await new Promise((resolve) => {
                resolveInitialTokenStatus = resolve;
              });
            }
            return readyTokens;
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      tabs: {
        create: vi.fn()
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Role Access"));

    holdEligibleRefresh = true;
    const refreshButton = clickButton("Refresh eligible items");
    expect(refreshButton.disabled).toBe(false);
    await waitFor(() => expect(document.body.textContent).toContain("Waiting to refresh"));
    expect(eligibleCalls).toBe(0);
    resolveInitialTokenStatus?.(readyTokens);
    await waitFor(() => expect(eligibleCalls).toBe(1));

    expect(document.body.textContent).toContain("Refreshing eligible items");
    resolveEligibleRefresh?.({ success: true, data: { items: [], errors: [] } });
  });
});

describe("settings Activity page", () => {
  test("filters and clears local activity history", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#activity");

    const settings = createDefaultSettings();
    settings.activityHistory = [
      {
        id: "activity-1",
        action: "activate",
        result: "success",
        itemId: "directoryRole:reader:/",
        itemName: "Global Reader",
        itemType: "directoryRole",
        scopeLabel: "Tenant",
        requestedAt: "2026-06-12T09:00:00.000Z",
        completedAt: "2026-06-12T09:01:00.000Z",
        durationHours: 1,
        justification: "Review production change"
      },
      {
        id: "activity-2",
        action: "deactivate",
        result: "failed",
        itemId: "pimGroup:group-1:member",
        itemName: "Security Group",
        itemType: "pimGroup",
        scopeLabel: "Member",
        requestedAt: "2026-06-12T10:00:00.000Z",
        completedAt: "2026-06-12T10:01:00.000Z",
        error: "Portal token missing"
      }
    ];
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("RequestsHistory"));
    clickButton("History");
    await waitFor(() => expect(document.body.textContent).toContain("Global Reader"));
    expect(document.body.textContent).toContain("Security Group");
    expect(document.querySelector('button[aria-label="Copy justification"]')).toBeTruthy();

    const resultFilter = document.querySelector<HTMLSelectElement>('select[aria-label="Filter activity result"]')!;
    resultFilter.value = "failed";
    resultFilter.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(document.body.textContent).not.toContain("Global Reader"));
    expect(document.body.textContent).toContain("Security Group");

    clickButton("Clear history");
    await waitFor(() => expect(document.body.textContent).toContain("Clear the local activation and deactivation history?"));
    clickExactButton("Confirm");
    await waitFor(() =>
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        activityHistory: []
      })
    );
  });

  test("opens tracked request details and prepares an active request for disable", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#activity");

    const request = {
      id: "pimGroup:request-1",
      requestId: "request-1",
      action: "activate" as const,
      itemId: "pimGroup:group-1:member",
      itemName: "Global Administrator",
      itemType: "pimGroup" as const,
      scopeLabel: "Member",
      principalId: "principal-1",
      tenantId: "tenant-1",
      groupId: "group-1",
      accessId: "member" as const,
      status: "pendingApproval" as const,
      rawStatus: "PendingApproval",
      requestedAt: "2026-07-14T09:00:00.000Z",
      updatedAt: "2026-07-14T09:01:00.000Z",
      durationHours: 4,
      justification: "Investigate production incident INC12345",
      sourceInstallationId: "87654321-abcd-4def-8abc-1234567890ab",
      sourceDeviceName: "Admin laptop",
      checkCount: 1
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [REQUEST_TRACKING_KEY]: { version: 1, requests: [request] }
    };
    const activeStore = {
      version: 1 as const,
      requests: [{
        ...request,
        status: "active" as const,
        rawStatus: "Provisioned",
        activeUntil: "2099-07-14T13:00:00.000Z",
        updatedAt: "2026-07-14T09:02:00.000Z",
        lastCheckedAt: "2026-07-14T09:02:00.000Z",
        nextCheckAt: undefined
      }]
    };
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const openPopup = vi.fn(async () => undefined);
    const createTab = vi.fn(async () => undefined);
    const chromeMock = {
      action: { openPopup },
      tabs: { create: createTab },
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
          }
          if (message.action === "refreshTrackedRequests") {
            return { success: true, data: activeStore };
          }
          return { success: true, data: { items: [], errors: [] } };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(storageData, value);
          }),
          remove: vi.fn(async (key: string) => {
            delete storageData[key];
          })
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Global Administrator"));
    expect(document.body.textContent).toContain("From Admin laptop");
    expect(document.body.textContent).toContain("QP-87654321");
    expect(document.querySelector(".request-row time")?.textContent).toBe(formatLocalDateTime(request.requestedAt));
    clickButton("Global Administrator");
    await waitFor(() => expect(document.body.textContent).toContain("Investigate production incident INC12345"));
    expect(document.body.textContent).toContain("Source computerAdmin laptop");
    expect(document.body.textContent).toContain("request-1");
    expect(document.body.textContent).toContain("Pending approval");
    expect(document.body.textContent).toContain(formatLocalDateTime(request.requestedAt));

    const copyJustification = document.querySelector<HTMLButtonElement>('button[aria-label="Copy justification"]');
    expect(copyJustification).toBeTruthy();
    copyJustification?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(request.justification));
    await waitFor(() => expect(document.querySelector('button[aria-label="justification copied"]')).toBeTruthy());

    const statusButtons = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent?.trim() === "Check status");
    statusButtons.at(-1)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).toContain("Prepare disable"));

    clickButton("Open Microsoft PIM");
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("aadgroup") }));

    clickButton("Prepare disable");
    await waitFor(() => expect(storageData[POPUP_DRAFT_KEY]).toMatchObject({
      selectedIds: ["pimGroup:group-1:member"],
      requestMode: "deactivate",
      isActivationReviewOpen: true
    }));
    await waitFor(() => expect(openPopup).toHaveBeenCalledOnce());
  });
});

describe("settings justification guardrails", () => {
  test("top-aligns saved and recent reasons and copies a recent justification", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#justifications");
    const settings = createDefaultSettings();
    settings.savedJustifications = ["Saved incident reason"];
    settings.recentJustifications = ["Recent incident reason"];
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });

    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData));
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Recent incident reason"));
    expect(document.querySelector(".justification-columns")).toBeTruthy();
    const copyButton = document.querySelector<HTMLButtonElement>('button[aria-label="Copy recent justification"]');
    expect(copyButton).toBeTruthy();
    copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Recent incident reason"));
    await waitFor(() => expect(document.querySelector('button[aria-label="recent justification copied"]')).toBeTruthy());

    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const columnsRule = css.match(/\.justification-columns\s*\{[^}]+\}/)?.[0] || "";
    const adjacentRule = css.match(/\.justification-columns\s*>\s*\.settings-subsection\s*\+\s*\.settings-subsection\s*\{[^}]+\}/)?.[0] || "";
    expect(columnsRule).toContain("align-items: start;");
    expect(adjacentRule).toContain("margin-top: 0;");
  });

  test("blocks generic saved justifications", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#justifications");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Justifications"));
    expect(document.body.textContent).not.toContain("Justifications are requested for audit and approval");

    setFieldValue(document.querySelector<HTMLInputElement>('input[placeholder="Reusable justification"]')!, "needed");
    clickButton("Add");

    await waitFor(() => expect(document.body.textContent).toContain("Justifications are requested for audit and approval"));
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      savedJustifications: []
    });
  });

  test("updates saved justifications when settings storage changes", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#justifications");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };
    const storageListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void> = [];
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        },
        onChanged: {
          addListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => {
            storageListeners.push(listener);
          }),
          removeListener: vi.fn()
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("No saved justifications."));
    await waitFor(() => expect(storageListeners).toHaveLength(1));

    const nextSettings = {
      ...DEFAULT_SETTINGS,
      savedJustifications: ["Emergency patch approval"]
    };
    storageData[SETTINGS_KEY] = nextSettings;
    storageListeners[0]({ [SETTINGS_KEY]: { oldValue: DEFAULT_SETTINGS, newValue: nextSettings } }, "local");

    await waitFor(() => expect(document.body.textContent).toContain("Emergency patch approval"));
  });

  test("reorders saved justifications", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#justifications");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...createDefaultSettings(),
        savedJustifications: ["First saved query", "Second saved query", "Third saved query"]
      },
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: []
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Second saved query"));

    document.querySelector<HTMLButtonElement>('button[aria-label="Move Second saved query up"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() =>
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["Second saved query", "First saved query", "Third saved query"]
      })
    );
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('button[aria-label="Move Second saved query up"]')?.disabled).toBe(true));

    document.querySelector<HTMLButtonElement>('button[aria-label="Move First saved query down"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() =>
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["Second saved query", "Third saved query", "First saved query"]
      })
    );
  });
});

describe("settings Bundles page", () => {
  const bundleItems = [
    {
      id: "directoryRole:reader:/",
      type: "directoryRole",
      sourceName: "Reader",
      displayName: "Reader",
      principalId: "user-1",
      roleDefinitionId: "reader",
      directoryScopeId: "/",
      scopeLabel: "Tenant",
      status: "eligible",
      activationRequirements: {
        maxDurationHours: 2
      }
    },
    {
      id: "azureRole:owner:/subscriptions/sub-1",
      type: "azureRole",
      sourceName: "Owner",
      displayName: "Owner",
      principalId: "user-1",
      roleDefinitionId: "owner",
      scope: "/subscriptions/sub-1",
      scopeLabel: "Production",
      status: "eligible",
      activationRequirements: {
        maxDurationHours: 4
      }
    }
  ];

  test("uses two-line justification, hides ticket fields, and caps duration by selected items", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#bundles");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: bundleItems
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            throw new Error("Settings should use cached eligible data.");
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Bundles"));

    expect(document.body.textContent).not.toMatch(/Ticket system|Ticket number/i);
    expect(document.body.textContent).not.toContain("Justifications are requested for audit and approval");
    const justification = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bundle default justification"]');
    expect(justification?.rows).toBe(2);
    expect(justification?.maxLength).toBe(MAX_USER_JUSTIFICATION_LENGTH);

    const duration = document.querySelector<HTMLSelectElement>('select[aria-label="Bundle duration"]');
    expect(duration).toBeTruthy();
    expect([...duration!.options].map((option) => option.textContent)).toEqual(["Select roles first"]);
  });

  test("does not save invalid bundle defaults", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#bundles");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: bundleItems
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Bundles"));

    setFieldValue(document.querySelector<HTMLInputElement>('input[placeholder="Daily operations"]')!, "Daily operations");
    setFieldValue(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bundle default justification"]')!, "Admin");
    clickButton("Save bundle");

    expect(storageData[SETTINGS_KEY]).toMatchObject({
      bundles: []
    });
  });

  test("edits and duplicates saved bundles from the bundle list", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#bundles");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: {
        ...DEFAULT_SETTINGS,
        bundles: [
          {
            id: "bundle:daily-ops",
            name: "Daily ops",
            itemIds: ["directoryRole:reader:/"],
            defaultDurationHours: 2,
            defaultJustification: "Daily work"
          }
        ]
      },
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:missing|azure:missing",
          errors: [],
          items: bundleItems
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            throw new Error("Settings should use cached eligible data.");
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: true };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Daily ops"));

    clickButton("Edit");
    await waitFor(() => expect(document.body.textContent).toContain("Editing Daily ops"));
    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="Daily operations"]');
    const justification = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bundle default justification"]');
    expect(nameInput?.value).toBe("Daily ops");
    expect(justification?.value).toBe("Daily work");

    setFieldValue(nameInput!, "Daily operations");
    setFieldValue(justification!, "Daily support");
    clickButton("Save changes");

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        bundles: [
          {
            id: "bundle:daily-ops",
            name: "Daily operations",
            defaultJustification: "Daily support"
          }
        ]
      });
    });

    await waitFor(() => expect(document.body.textContent).toContain("Daily operations1 item(s) / Daily supportEditDuplicateRemove"));
    clickButton("Duplicate");
    await waitFor(() => expect(document.body.textContent).toContain("Duplicating Daily operations"));
    expect(nameInput?.value).toBe("Daily operations copy");
    clickButton("Save bundle");

    await waitFor(() => {
      expect((storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS).bundles).toHaveLength(2);
    });
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      bundles: expect.arrayContaining([
        expect.objectContaining({ id: "bundle:daily-ops", name: "Daily operations" }),
        expect.objectContaining({ id: expect.stringMatching(/^bundle:[0-9a-f-]+$/), name: "Daily operations copy" })
      ])
    });
  });
});

describe("settings layout spacing", () => {
  test("keeps form action buttons closer to their form than the next saved-list panel", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const actionRule = css.match(/\.settings-form-actions\s*\{[^}]+\}/)?.[0] || "";
    const nestedPanelRule = css.match(/\.panel\s*>\s*\.panel\s*\{[^}]+\}/)?.[0] || "";

    expect(actionRule).toContain("margin-top: 12px;");
    expect(actionRule).toContain("margin-bottom: 0;");
    expect(nestedPanelRule).toContain("margin-top: 16px;");
  });

  test("aligns popup default fields with consistent label and control rows", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const gridRule = css.match(/\.popup-defaults-grid\s*\{[^}]+\}/)?.[0] || "";
    const fieldRule = css.match(/\.popup-defaults-grid\s*>\s*\.field\s*\{[^}]+\}/)?.[0] || "";
    const labelRule = css.match(/\.popup-defaults-grid\s*>\s*\.field label\s*\{[^}]+\}/)?.[0] || "";

    expect(gridRule).toContain("align-items: stretch;");
    expect(fieldRule).toContain("grid-template-rows: 34px 40px minmax(34px, 1fr);");
    expect(labelRule).toContain("min-height: 34px;");
  });
});

describe("settings dark mode", () => {
  test("preserves an unsaved import draft when settings change elsewhere", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#data");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const storageListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void> = [];
    const emptyTokenStatus = { graph: { hasToken: false }, azureManagement: { hasToken: false } };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return { success: true, data: emptyTokenStatus };
          }
          if (message.action === "getActivationSnapshot") {
            return {
              success: true,
              data: {
                eligible: { items: [], errors: [], diagnostics: [] },
                active: { items: [], errors: [], diagnostics: [] },
                tokenStatus: emptyTokenStatus
              }
            };
          }
          return { success: true, data: { items: [], errors: [], diagnostics: [] } };
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        },
        onChanged: {
          addListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => storageListeners.push(listener)),
          removeListener: vi.fn()
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.querySelector("textarea.code-box")).toBeTruthy());
    await waitFor(() => expect(storageListeners).toHaveLength(1));

    const textarea = document.querySelector<HTMLTextAreaElement>("textarea.code-box")!;
    const localDraft = '{"savedJustifications":["Local draft"]}';
    setFieldValue(textarea, localDraft);
    await waitFor(() => expect(textarea.value).toBe(localDraft));

    const current = storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS;
    const external = { ...current, favoriteItemIds: ["directoryRole:reader:/"] };
    storageData[SETTINGS_KEY] = external;
    storageListeners[0]({ [SETTINGS_KEY]: { oldValue: current, newValue: external } }, "local");

    await waitFor(() => expect(textarea.value).toBe(localDraft));
    await waitFor(() => expect(document.body.textContent).toContain("Saved data changed elsewhere"));
  });

  test("preserves and autosaves a preference draft when another settings section changes", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const storageListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void> = [];
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => message.action === "getTokenStatus"
          ? { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } }
          : { success: true, data: { items: [], errors: [] } }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        },
        onChanged: {
          addListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => storageListeners.push(listener)),
          removeListener: vi.fn()
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Enabled tabs"));
    await waitFor(() => expect(storageListeners).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(".settings-layout")?.getAttribute("aria-busy")).toBe("false"));

    const countersToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show activation counters in popup"]')!;
    countersToggle.click();
    await waitFor(() => expect(countersToggle.checked).toBe(true));

    const current = storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS;
    const external = { ...current, savedJustifications: ["Remote saved reason"] };
    storageData[SETTINGS_KEY] = external;
    storageListeners[0]({ [SETTINGS_KEY]: { oldValue: current, newValue: external } }, "local");

    await waitFor(() => expect(countersToggle.checked).toBe(true));
    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["Remote saved reason"],
        preferences: expect.objectContaining({ showActivationCounters: true })
      });
    });
  });

  test("serializes saves from different settings sections without losing either change", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#display");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    let releasePreferenceSave!: () => void;
    const preferenceSaveStarted = new Promise<void>((resolve) => {
      releasePreferenceSave = resolve;
    });
    let unblockPreferenceSave!: () => void;
    const preferenceSaveBlocked = new Promise<void>((resolve) => {
      unblockPreferenceSave = resolve;
    });
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => message.action === "getTokenStatus"
          ? { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } }
          : { success: true, data: { items: [], errors: [] } }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            const next = value[SETTINGS_KEY] as typeof DEFAULT_SETTINGS | undefined;
            if (next?.preferences.showActivationCounters && !next.savedJustifications.length) {
              releasePreferenceSave();
              await preferenceSaveBlocked;
            }
            Object.assign(storageData, value);
          }),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.querySelector(".settings-layout")?.getAttribute("aria-busy")).toBe("false"));

    document.querySelector<HTMLInputElement>('input[aria-label="Show activation counters in popup"]')!.click();
    await preferenceSaveStarted;

    window.location.hash = "#justifications";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(document.querySelector<HTMLInputElement>('input[placeholder="Reusable justification"]')).toBeTruthy());
    setFieldValue(document.querySelector<HTMLInputElement>('input[placeholder="Reusable justification"]')!, "Incident INC-4242");
    clickButton("Add");
    unblockPreferenceSave();

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["Incident INC-4242"],
        preferences: expect.objectContaining({ showActivationCounters: true })
      });
    }, 3_000);
  });

  test("retries a transient preference autosave failure without requiring another edit", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#display");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    let preferenceSaveAttempts = 0;
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => message.action === "getTokenStatus"
          ? { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } }
          : { success: true, data: { items: [], errors: [] } })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            const nextSettings = value[SETTINGS_KEY] as typeof DEFAULT_SETTINGS | undefined;
            if (nextSettings?.preferences.showActivationCounters) {
              preferenceSaveAttempts += 1;
              if (preferenceSaveAttempts === 1) {
                throw new Error("Temporary storage failure");
              }
            }
            Object.assign(storageData, value);
          }),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Show activation counters in popup"]')
    ).toBeTruthy());
    const counterToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show activation counters in popup"]')!;
    counterToggle.click();

    await waitFor(() => expect(preferenceSaveAttempts).toBe(2), 3_000);
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({ showActivationCounters: true })
    });
    await waitFor(() => expect(document.querySelector(".autosave-status")?.textContent).toContain("Saved"));
  });

  test("clarifies popup defaults and uses labeled activation duration options", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#defaults");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Activation and extension timing"));

    expect(document.body.textContent).toContain("Default activation duration");
    expect(document.body.textContent).toContain("Preselected when selected roles allow it.");
    expect(document.body.textContent).not.toContain("Recent justification history limit");
    expect(document.body.textContent).not.toContain("Default duration");
    expect(document.body.textContent).toContain("Changes are saved automatically.");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Save preferences")).toBe(false);

    const duration = document.querySelector<HTMLSelectElement>('select[aria-label="Default activation duration"]');
    expect(duration).toBeTruthy();
    expect([...duration!.options].map((option) => option.textContent)).toEqual([
      "30 minutes",
      "1 hour",
      "2 hours",
      "4 hours",
      "8 hours",
      "12 hours",
      "24 hours"
    ]);
  });

  test("flushes a valid pending preference change when leaving the page", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#defaults");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => message.action === "getTokenStatus"
          ? { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } }
          : { success: true, data: { items: [], errors: [] } })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Activation and extension timing"));
    await waitFor(() => expect(document.querySelector(".settings-layout")?.getAttribute("aria-busy")).toBe("false"));

    const duration = document.querySelector<HTMLSelectElement>('select[aria-label="Default activation duration"]')!;
    duration.value = "2";
    duration.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".autosave-status")?.textContent).toContain("Changes pending"));
    clickButton("Home");

    await waitFor(() => expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({ defaultDurationHours: 2 })
    }));
  });

  test("organizes personalization, access refresh, and activation controls into focused pages", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Enabled tabs"));

    expect(document.body.textContent).not.toContain("Show advanced settings");
    expect(document.body.textContent).toContain("Show enablement details");
    expect(document.body.textContent).toContain("Show last enablement date");
    const enablementDetailsToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show enablement details in popup"]');
    const lastEnablementToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show last enablement date in popup"]');
    const assignedRolesToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show assigned active roles in popup"]');
    const showRemainingTimeToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show remaining activation time in popup"]');
    expect(enablementDetailsToggle).toBeTruthy();
    expect(lastEnablementToggle).toBeTruthy();
    expect(assignedRolesToggle).toBeTruthy();
    expect(showRemainingTimeToggle).toBeTruthy();
    expect(showRemainingTimeToggle!.checked).toBe(true);
    expect(enablementDetailsToggle!.checked).toBe(false);
    expect(lastEnablementToggle!.checked).toBe(false);
    const defaultStates = [...document.querySelectorAll(".preference-default-state")].map((item) => item.textContent?.trim());
    expect(defaultStates).toEqual([
      "Enabled by default",
      "Disabled by default",
      "Disabled by default",
      "Disabled by default",
      "Disabled by default"
    ]);

    expect(document.body.textContent).toContain("Background pre-refresh");
    expect(document.body.textContent).not.toContain("Request status notifications");

    clickButton("Role Access");
    await waitFor(() => expect(document.body.textContent).not.toContain("Background pre-refresh"));

    clickButton("Activation & Notifications");
    await waitFor(() => expect(document.body.textContent).toContain("Activation and extension timing"));
    const requestNotificationsToggle = document.querySelector<HTMLInputElement>('input[aria-label="Notify me about request updates"]');
    expect(requestNotificationsToggle).toBeTruthy();
    expect(requestNotificationsToggle!.checked).toBe(false);

    const extensionDuration = document.querySelector<HTMLSelectElement>('select[aria-label="Default PIM extension duration"]');
    expect(extensionDuration).toBeTruthy();
    expect(extensionDuration!.value).toBe("0.5");
    expect([...extensionDuration!.options].map((option) => option.textContent)).toEqual(["30 minutes", "1 hour", "2 hours", "4 hours"]);
  });

  test("requests optional notification permission only when notifications are enabled", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#automation");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const requestPermission = vi.fn(async () => true);
    const chromeMock = {
      notifications: {
        create: vi.fn(async () => "quickpim-test")
      },
      permissions: {
        contains: vi.fn(async () => false),
        request: requestPermission,
        remove: vi.fn(async () => true)
      },
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async (message: { action: string }) => message.action === "getTokenStatus"
          ? { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } }
          : { success: true, data: { items: [], errors: [] } })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(storageData, value);
          }),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.querySelector('input[aria-label="Notify me about request updates"]')).toBeTruthy());
    const toggle = document.querySelector<HTMLInputElement>('input[aria-label="Notify me about request updates"]')!;
    expect(requestPermission).not.toHaveBeenCalled();
    toggle.click();

    await waitFor(() => expect(requestPermission).toHaveBeenCalledWith({ permissions: ["notifications"] }));
    await waitFor(() => expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({ requestNotificationsEnabled: true, expiryReminderMinutes: 15 })
    }));
  });

  test("shows and repairs a saved notification preference whose browser permission is missing", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#automation");
    const settings = createDefaultSettings();
    settings.preferences.requestNotificationsEnabled = true;
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    let permissionGranted = false;
    const requestPermission = vi.fn(async () => {
      permissionGranted = true;
      return true;
    });
    const createNotification = vi.fn(async () => "quickpim-notification-test");
    const chromeMock = {
      notifications: { create: createNotification },
      permissions: {
        contains: vi.fn(async () => permissionGranted),
        request: requestPermission,
        remove: vi.fn(async () => true)
      },
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async () => ({ success: true, data: true }))
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Setup required"));
    expect(document.body.textContent).toContain("has not granted the optional notification permission");
    expect(document.body.textContent).toContain("Portal-only activations are not tracked");
    clickExactButton("Enable on this browser");
    await waitFor(() => expect(requestPermission).toHaveBeenCalledWith({ permissions: ["notifications"] }));
    await waitFor(() => expect(document.body.textContent).toContain("Desktop notification deliveryReady"));

    clickExactButton("Send test notification");
    await waitFor(() => expect(createNotification).toHaveBeenCalledWith(
      "quickpim-notification-test",
      expect.objectContaining({ title: "QuickPIM++ notifications are ready" })
    ));
    await waitFor(() => expect(document.body.textContent).toContain("Test sent"));
  });

  test("saves display preferences and applies dark mode to settings", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#display");

    const settings = createDefaultSettings();
    settings.preferences.darkMode = true;
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Dark mode"));
    await waitFor(() => expect(document.querySelector<HTMLInputElement>('input[aria-label="Show enablement details in popup"]')).toBeTruthy());

    const darkModeToggle = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Dark mode"]');
    const enablementDetailsToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show enablement details in popup"]');
    const lastEnablementToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show last enablement date in popup"]');
    const assignedRolesToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show assigned active roles in popup"]');
    const showRemainingTimeToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show remaining activation time in popup"]');
    expect(darkModeToggle).toBeTruthy();
    expect(enablementDetailsToggle).toBeTruthy();
    expect(lastEnablementToggle).toBeTruthy();
    expect(assignedRolesToggle).toBeTruthy();
    expect(showRemainingTimeToggle).toBeTruthy();
    await waitFor(() => expect(darkModeToggle!.getAttribute("aria-checked")).toBe("true"));
    expect(darkModeToggle!.textContent).toContain("Light mode");
    expect(darkModeToggle!.textContent).toContain("Dark mode");
    const colorThemeSection = darkModeToggle!.closest(".preference-section");
    const sourceSection = Array.from(document.querySelectorAll(".preference-section"))
      .find((section) => section.textContent?.includes("Enabled tabs"));
    expect(colorThemeSection).toBeTruthy();
    expect(sourceSection).toBeTruthy();
    expect(colorThemeSection!.compareDocumentPosition(sourceSection!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.classList.contains("dark-mode")).toBe(true);
    expect(enablementDetailsToggle!.checked).toBe(false);
    expect(lastEnablementToggle!.checked).toBe(false);
    expect(assignedRolesToggle!.checked).toBe(false);
    expect(showRemainingTimeToggle!.checked).toBe(true);
    darkModeToggle!.click();
    enablementDetailsToggle!.click();
    lastEnablementToggle!.click();
    assignedRolesToggle!.click();
    showRemainingTimeToggle!.click();

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        preferences: expect.objectContaining({ darkMode: false, showAssignedRoles: true, showRemainingActivationTime: false, showEnablementDetails: true, showLastEnablementDate: true })
      });
      expect(document.body.classList.contains("dark-mode")).toBe(false);
      expect(darkModeToggle!.getAttribute("aria-checked")).toBe("false");
    });
    await waitFor(() => expect(document.querySelector(".autosave-status")?.textContent).toContain("Saved"));
    expect(document.body.textContent).not.toContain("Settings saved.");
  });

  test("shows usage dates as yyyy-MM-dd in Activity & Usage", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#activity");

    const settings = createDefaultSettings();
    settings.usageStatsByItemId = {
      "directoryRole:reader:/": {
        activationCount: 3,
        lastUsedAt: "2026-06-12T09:30:00.000Z"
      }
    };
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
                azureManagement: { hasToken: false }
              }
            };
          }
          return { success: true, data: { items: [], errors: [] } };
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storageData, value)),
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Activity & Usage"));
    [...document.querySelectorAll(".activity-view-switch button")]
      .find((button) => button.textContent?.trim() === "Usage")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).toContain("2026-06-12"));
    expect(document.body.textContent).not.toContain("6/12/2026");
  });

  test("shows the renamed source installation in history and per-device usage", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#activity");
    const settings = createDefaultSettings();
    const installationId = "12345678-abcd-4def-8abc-1234567890ab";
    settings.activityHistory = [{
      id: "operation-1:activate:directoryRole:reader:/:success",
      action: "activate",
      result: "success",
      itemId: "directoryRole:reader:/",
      itemName: "Reader",
      itemType: "directoryRole",
      requestedAt: "2026-08-10T10:00:00.000Z",
      completedAt: "2026-08-10T10:00:01.000Z",
      sourceInstallationId: installationId,
      sourceDeviceName: "Old name"
    }];
    settings.usageStatsByItemId = {
      "directoryRole:reader:/": {
        activationCount: 2,
        byInstallationId: { [installationId]: { activationCount: 2 } }
      }
    };
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const chromeMock = createBasicSettingsChrome(storageData);
    const runtime = chromeMock.runtime as { sendMessage: (message: { action: string }) => Promise<unknown> };
    runtime.sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getBrowserSyncStatus") {
        return { success: true, data: {
          capability: "available",
          supported: true,
          enabled: true,
          browserLabel: "Google Chrome",
          sourceLabel: "Chrome Web Store",
          ecosystemLabel: "Chrome Sync",
          installationId: "current-device-id",
          deviceName: "Current PC",
          platform: "Windows",
          reminderMode: "daily",
          reminderDue: false,
          suspendedByPurge: false,
          omittedCategories: [],
          devices: [{
            installationId,
            name: "Admin workstation",
            browser: "Google Chrome",
            platform: "Windows",
            appVersion: TEST_MANIFEST.version,
            lastSyncAt: Date.now(),
            syncEnabled: true,
            nameUpdatedAt: Date.now()
          }]
        } };
      }
      if (message.action === "getTokenStatus") return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      if (message.action === "getActivationSnapshot") return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      return { success: true, data: { items: [], errors: [], diagnostics: [] } };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Activity & Usage"));
    clickExactButton("History");
    await waitFor(() => expect(document.body.textContent).toContain("From Admin workstation"));
    expect(document.body.textContent).toContain("QP-12345678");
    clickExactButton("Usage");
    await waitFor(() => expect(document.body.textContent).toContain("Admin workstation (QP-12345678): 2"));
  });

  test("saves enabled feature preferences", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#display");

    const settings = createDefaultSettings();
    settings.preferences.enabledFeatures = ["directoryRole", "pimGroup", "bundles"];
    settings.preferences.autoEnabledFeaturesInitialized = true;
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            return { success: true, data: { items: [], errors: [] } };
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: false },
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Enabled tabs"));

    const azureRolesFeature = document.querySelector<HTMLInputElement>('input[aria-label="Enable Azure Roles feature"]');
    expect(azureRolesFeature).toBeTruthy();
    await waitFor(() => expect(azureRolesFeature!.checked).toBe(false));
    azureRolesFeature!.click();

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        preferences: expect.objectContaining({
          enabledFeatures: ["directoryRole", "pimGroup", "azureRole", "bundles"],
          autoEnabledFeaturesInitialized: true
        })
      });
    });
  });

  test("flushes role-source changes before access recovery starts", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#display");
    const settings = createDefaultSettings();
    settings.preferences.enabledFeatures = ["directoryRole", "bundles"];
    settings.preferences.autoEnabledFeaturesInitialized = true;
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const openedTargets: string[][] = [];
    const missingTokens = {
      graph: { hasToken: false },
      azureManagement: { hasToken: false }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => TEST_MANIFEST,
        getURL: (path: string) => `chrome-extension://quickpim/${path}`,
        sendMessage: vi.fn(async (message: { action: string; targets?: string[] }) => {
          if (message.action === "getTokenStatus") {
            return { success: true, data: missingTokens };
          }
          if (message.action === "refreshPortalTokens") {
            return { success: true, data: { tokenStatus: missingTokens, tabsFound: 0, tabsScanned: 0, captured: [] } };
          }
          if (message.action === "openPortalRecoveryTabs") {
            openedTargets.push(message.targets || []);
            return { success: true, data: { opened: message.targets || [], managedCount: message.targets?.length || 0 } };
          }
          if (message.action === "getPortalRecoveryStatus") {
            return {
              success: true,
              data: {
                state: openedTargets.length ? "interactionRequired" : "idle",
                requestedTargets: openedTargets.at(-1) || [],
                openedTargets: openedTargets.at(-1) || [],
                pendingTargets: openedTargets.at(-1) || [],
                tabIds: []
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
          remove: vi.fn(async () => undefined)
        }
      }
    };

    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.body.textContent).toContain("Enabled tabs"));
    await waitFor(() => expect(document.querySelector('.settings-layout')?.getAttribute("aria-busy")).toBe("false"));

    const azureFeature = document.querySelector<HTMLInputElement>('input[aria-label="Enable Azure Roles feature"]')!;
    await waitFor(() => expect(azureFeature.checked).toBe(false));
    azureFeature.click();
    clickButton("Role Access");
    await waitFor(() => expect(document.body.textContent).toContain("Access status & recovery"));
    clickButton("Open missing portal pages");

    await waitFor(() => expect(openedTargets.length).toBeGreaterThan(0));
    expect(openedTargets.at(-1)).toEqual(["directoryRole", "azureRole"]);
    expect((storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS).preferences.enabledFeatures).toEqual([
      "directoryRole",
      "azureRole",
      "bundles"
    ]);
  });
});

describe("settings journey safeguards", () => {
  test("keeps legacy hashes mapped to their new journey pages", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData));
    vi.resetModules();
    await import("../src/settings/main");
    await waitFor(() => expect(document.querySelector(".settings-layout")?.getAttribute("aria-busy")).toBe("false"));

    const routes: Array<[string, string]> = [
      ["#access", "Role Access"],
      ["#sources", "Popup & Appearance"],
      ["#defaults", "Activation & Notifications"],
      ["#automation", "Activation & Notifications"],
      ["#activity", "Activity & Usage"],
      ["#display", "Popup & Appearance"],
      ["#preferences", "Popup & Appearance"],
      ["#aliases", "Names & Aliases"],
      ["#data", "Backup & Restore"]
    ];

    for (const [hash, heading] of routes) {
      window.history.replaceState(null, "", hash);
      window.dispatchEvent(new Event("hashchange"));
      await waitFor(() => expect(
        [...document.querySelectorAll("h2")].some((item) => item.textContent === heading),
        `${hash} should render ${heading}`
      ).toBe(true));
    }
  });

  test("places a guarded full reset after Backup & Restore and recommends a backup first", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#reset");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Reset QuickPIM++"));
    expect(document.body.textContent).toContain("Download a JSON backup before resetting");
    expect(getExactButton("Open Backup & Restore")).toBeTruthy();
    clickExactButton("Erase all extension data");
    await waitFor(() => expect(document.body.textContent).toContain("I understand this cannot be undone without a backup"));
    const confirm = getExactButton("Erase everything");
    expect(confirm.disabled).toBe(true);
    document.querySelector<HTMLInputElement>('.reset-extension-confirmation input[type="checkbox"]')!.click();
    await waitFor(() => expect(confirm.disabled).toBe(false));
    confirm.click();
    await waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ action: "resetExtensionData" }));
    await waitFor(() => expect(document.body.textContent).toContain("All QuickPIM++ data was cleared"));
  });

  test("shows the full Microsoft tenant and owns learned-name cleanup under Names & Aliases", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { action: string }): Promise<any> => {
      if (message.action === "getTokenStatus") {
        return {
          success: true,
          data: {
            graph: {
              hasToken: true,
              isExpired: false,
              principalName: "admin@contoso.onmicrosoft.com",
              principalId: "principal-1",
              tenantId: "687bbaa1-7c7d-4e66-8aa1-4633a953046b"
            },
            azureManagement: { hasToken: false }
          }
        };
      }
      if (message.action === "getActivationSnapshot") {
        return {
          success: true,
          data: {
            eligible: { items: [], errors: [], diagnostics: [] },
            active: { items: [], errors: [], diagnostics: [] }
          }
        };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.querySelector(".access-identity-value")?.textContent).toContain("687bbaa1-7c7d-4e66-8aa1-4633a953046b"));
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Clear learned names")).toBe(false);
    clickExactButton("Names & Aliases");
    await waitFor(() => expect(getExactButton("Clear learned names")).toBeTruthy());
  });

  test("restores only Popup & Appearance defaults and preserves role sources and user data", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#display");
    const settings = createDefaultSettings();
    settings.aliasesByItemId = { "directoryRole:reader:/": "Local Reader" };
    settings.savedJustifications = ["Keep this saved reason"];
    settings.preferences.defaultDurationHours = 4;
    settings.preferences.defaultSort = "scope";
    settings.preferences.darkMode = true;
    settings.preferences.showAssignedRoles = true;
    settings.preferences.showRemainingActivationTime = false;
    settings.preferences.showActivationCounters = true;
    settings.preferences.showEnablementDetails = true;
    settings.preferences.showLastEnablementDate = true;
    settings.preferences.enabledFeatures = ["directoryRole", "pimGroup"];
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData));
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(getExactButton("Restore defaults").disabled).toBe(false));
    clickExactButton("Restore defaults");
    await waitFor(() => expect(getExactButton("Restore")).toBeTruthy());
    clickExactButton("Restore");
    await waitFor(() => {
      const saved = storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS;
      expect(saved.preferences).toMatchObject({
        defaultDurationHours: 4,
        defaultSort: "scope",
        darkMode: false,
        showAssignedRoles: false,
        showRemainingActivationTime: true,
        showActivationCounters: false,
        showEnablementDetails: false,
        showLastEnablementDate: false,
        enabledFeatures: ["directoryRole", "pimGroup", "bundles"]
      });
      expect(saved.aliasesByItemId).toEqual({ "directoryRole:reader:/": "Local Reader" });
      expect(saved.savedJustifications).toEqual(["Keep this saved reason"]);
    });
    await waitFor(() => expect(getExactButton("Restore defaults").disabled).toBe(true));
  });

  test("restores activation defaults and removes the optional notification permission", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#automation");
    const settings = createDefaultSettings();
    settings.preferences.darkMode = true;
    settings.preferences.defaultDurationHours = 4;
    settings.preferences.defaultExtensionDurationHours = 2;
    settings.preferences.requestNotificationsEnabled = true;
    settings.preferences.expiryReminderMinutes = 60;
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const removePermission = vi.fn(async () => true);
    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData, { removePermission }));
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(getExactButton("Restore defaults").disabled).toBe(false));
    clickExactButton("Restore defaults");
    await waitFor(() => expect(getExactButton("Restore")).toBeTruthy());
    clickExactButton("Restore");
    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        preferences: expect.objectContaining({
          darkMode: true,
          defaultDurationHours: DEFAULT_SETTINGS.preferences.defaultDurationHours,
          defaultExtensionDurationHours: DEFAULT_SETTINGS.preferences.defaultExtensionDurationHours,
          requestNotificationsEnabled: false,
          expiryReminderMinutes: DEFAULT_SETTINGS.preferences.expiryReminderMinutes
        })
      });
      expect(removePermission).toHaveBeenCalledWith({ permissions: ["notifications"] });
    });
  });

  test("restores only the recent justification limit", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#justifications");
    const settings = createDefaultSettings();
    settings.savedJustifications = ["Saved reason"];
    settings.recentJustifications = ["Recent reason"];
    settings.preferences.recentJustificationLimit = 3;
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData));
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(getExactButton("Restore defaults").disabled).toBe(false));
    clickExactButton("Restore defaults");
    await waitFor(() => expect(getExactButton("Restore")).toBeTruthy());
    clickExactButton("Restore");
    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["Saved reason"],
        recentJustifications: ["Recent reason"],
        preferences: expect.objectContaining({ recentJustificationLimit: DEFAULT_SETTINGS.preferences.recentJustificationLimit })
      });
    });
  });

  test("renders only the selected Activity & Usage view", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#activity");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData));
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Activity & Usage"));
    expect(document.body.textContent).not.toContain("History retention");
    expect(document.body.textContent).not.toContain("Usage counters");
    clickExactButton("History");
    await waitFor(() => expect(document.body.textContent).toContain("History retention"));
    expect(document.body.textContent).not.toContain("Usage counters");
    clickExactButton("Usage");
    await waitFor(() => expect(document.body.textContent).toContain("Usage counters"));
    expect(document.body.textContent).not.toContain("History retention");
  });

  test("keeps Backup & Restore actions aligned with editor validity and dirty state", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#data");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { userAgent: window.navigator.userAgent, clipboard: { writeText } });
    vi.stubGlobal("chrome", createBasicSettingsChrome(storageData));
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>("textarea.code-box")).toBeTruthy());
    const editor = document.querySelector<HTMLTextAreaElement>("textarea.code-box")!;
    expect(getExactButton("Save changes").disabled).toBe(true);
    expect(getExactButton("Reload saved").disabled).toBe(true);
    expect(getExactButton("Copy JSON").disabled).toBe(false);
    expect(getExactButton("Download JSON").disabled).toBe(false);

    const partial = '{"preferences":{"darkMode":true}}';
    setFieldValue(editor, partial);
    await waitFor(() => expect(getExactButton("Save changes").disabled).toBe(false));
    expect(getExactButton("Reload saved").disabled).toBe(false);
    clickExactButton("Copy JSON");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(partial));

    setFieldValue(editor, "{");
    await waitFor(() => expect(getExactButton("Save changes").disabled).toBe(true));
    expect(getExactButton("Copy JSON").disabled).toBe(true);
    expect(getExactButton("Download JSON").disabled).toBe(true);
    expect(getExactButton("Reload saved").disabled).toBe(false);
    clickExactButton("Reload saved");
    await waitFor(() => expect(getExactButton("Reload saved").disabled).toBe(true));

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const oversizedFile = {
      name: "oversized.json",
      size: MAX_SETTINGS_BACKUP_BYTES + 1,
      text: vi.fn(async () => "{}")
    } as unknown as File;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [oversizedFile] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).toContain("larger than 1 MiB"));
    expect(oversizedFile.text).not.toHaveBeenCalled();

    const stagedJson = '{"preferences":{"darkMode":true}}';
    const stagedFile = {
      name: "quickpim-settings.json",
      size: stagedJson.length,
      text: vi.fn(async () => stagedJson)
    } as unknown as File;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [stagedFile] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).toContain("is loaded but has not been restored yet"));
    expect((storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS).preferences.darkMode).toBe(false);
    expect(editor.value).toContain('"darkMode": true');
    clickExactButton("Apply loaded backup");
    await waitFor(() => expect((storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS).preferences.darkMode).toBe(true));
    await waitFor(() => expect(getExactButton("Save changes").disabled).toBe(true));

    clickExactButton("Reset all settings");
    await waitFor(() => expect(getExactButton("Reset everything")).toBeTruthy());
    clickExactButton("Reset everything");
    await waitFor(() => expect(storageData[SETTINGS_KEY]).toEqual(DEFAULT_SETTINGS));
  });
});

describe("settings Browser Sync page", () => {
  test("distinguishes a local sync write from verified cross-device delivery", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#sync");
    const settings = createDefaultSettings();
    settings.activityHistory = [{
      id: "imported-activity",
      action: "activate",
      result: "success",
      itemId: "directoryRole:one:/",
      itemName: "Imported role",
      itemType: "directoryRole",
      requestedAt: new Date().toISOString(),
      sourceInstallationId: "backup-only-installation"
    }];
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: settings };
    const chromeMock = createBasicSettingsChrome(storageData);
    const status = {
      capability: "available",
      supported: true,
      enabled: true,
      browserLabel: "Microsoft Edge",
      sourceLabel: "Microsoft Edge Add-ons",
      ecosystemLabel: "Microsoft Edge Sync",
      installationId: "current-installation",
      deviceName: "Admin Mac",
      platform: "macOS",
      lastSyncAt: Date.now(),
      lastSuccessAt: Date.now(),
      reminderMode: "daily",
      reminderDue: false,
      suspendedByPurge: false,
      devices: [{
        installationId: "current-installation",
        name: "Admin Mac",
        browser: "Microsoft Edge",
        platform: "macOS",
        appVersion: TEST_MANIFEST.version,
        lastSyncAt: Date.now(),
        syncEnabled: true,
        nameUpdatedAt: Date.now()
      }],
      crossDeviceState: "waiting",
      otherInstallationCount: 0,
      omittedCategories: []
    };
    let currentStatus = status;
    const runtime = chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> };
    runtime.sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getBrowserSyncStatus" || message.action === "syncBrowserData") {
        return { success: true, data: currentStatus };
      }
      if (message.action === "setBrowserSyncEnabled") {
        currentStatus = { ...currentStatus, enabled: Boolean((message as { enabled?: boolean }).enabled) };
        return { success: true, data: currentStatus };
      }
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      }
      if (message.action === "getActivationSnapshot") {
        return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      }
      return { success: true, data: { items: [], errors: [] } };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Waiting for another installation"));
    expect(document.body.textContent).toContain("Not yet verified");
    expect(document.body.textContent).toContain("Data is stored in this browser's sync area");
    expect(document.body.textContent).toContain("0 events from other installations");
    expect(document.body.textContent).toContain("No other installation record has reached this browser yet.");
    expect(getExactButton("Send & receive now")).toBeTruthy();
    const syncSwitch = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Browser sync"]');
    expect(syncSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(syncSwitch?.textContent).toContain("On");
    expect(document.querySelector(".sync-section-heading")?.textContent).toContain("computer hostname");
    expect(document.querySelector(".sync-current-installation .sync-device-name-row")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Last successful sync");
    await waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith({ action: "syncBrowserData" }));
    syncSwitch?.click();
    await waitFor(() => expect(syncSwitch?.getAttribute("aria-checked")).toBe("false"));
    expect(syncSwitch?.textContent).toContain("Off");
    expect(runtime.sendMessage).toHaveBeenCalledWith({ action: "setBrowserSyncEnabled", enabled: false });
  });

  test("shows a returned sync failure instead of a contradictory success message", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#sync");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    const baseStatus = {
      capability: "available",
      supported: true,
      enabled: true,
      browserLabel: "Microsoft Edge",
      sourceLabel: "Microsoft Edge Add-ons",
      ecosystemLabel: "Microsoft Edge Sync",
      installationId: "current-installation",
      deviceName: "Admin Mac",
      platform: "macOS",
      lastSyncAt: Date.now(),
      lastSuccessAt: Date.now(),
      reminderMode: "daily",
      reminderDue: false,
      suspendedByPurge: false,
      devices: [{
        installationId: "current-installation",
        name: "Admin Mac",
        browser: "Microsoft Edge",
        platform: "macOS",
        appVersion: TEST_MANIFEST.version,
        lastSyncAt: Date.now(),
        syncEnabled: true,
        nameUpdatedAt: Date.now()
      }],
      crossDeviceState: "waiting",
      otherInstallationCount: 0,
      omittedCategories: []
    };
    let syncCalls = 0;
    const runtime = chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> };
    runtime.sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getBrowserSyncStatus") return { success: true, data: baseStatus };
      if (message.action === "syncBrowserData") {
        syncCalls += 1;
        return {
          success: true,
          data: syncCalls === 1
            ? baseStatus
            : { ...baseStatus, lastError: "Microsoft Edge Sync rejected the write." }
        };
      }
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      }
      if (message.action === "getActivationSnapshot") {
        return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      }
      return { success: true, data: { items: [], errors: [] } };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(syncCalls).toBe(1));
    await waitFor(() => expect(getExactButton("Send & receive now")).toBeTruthy());
    clickExactButton("Send & receive now");
    await waitFor(() => expect(document.body.textContent).toContain("Microsoft Edge Sync rejected the write."));
    expect(document.body.textContent).not.toContain("Saved in this browser's sync area. Open QuickPIM++ on the other computer");
  });

  test("flushes a pending installation name when leaving Browser Sync", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#sync");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    const status = createBrowserSyncUiStatus({ enabled: false });
    const runtime = chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> };
    runtime.sendMessage = vi.fn(async (message: { action: string; name?: string }) => {
      if (message.action === "getBrowserSyncStatus") return { success: true, data: status };
      if (message.action === "updateBrowserSyncDeviceName") {
        return { success: true, data: { ...status, deviceName: message.name || status.deviceName } };
      }
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      }
      if (message.action === "getActivationSnapshot") {
        return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.querySelector<HTMLInputElement>("#sync-device-name")?.value).toBe("Admin Mac"));
    setFieldValue(document.querySelector<HTMLInputElement>("#sync-device-name")!, "Operations laptop");
    clickExactButton("Home");

    await waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith({
      action: "updateBrowserSyncDeviceName",
      name: "Operations laptop"
    }));
  });

  test("prevents duplicate Browser Sync actions before React disables the control", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#sync");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    const status = createBrowserSyncUiStatus({ enabled: false });
    let toggleCalls = 0;
    const runtime = chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> };
    runtime.sendMessage = vi.fn(async (message: { action: string; enabled?: boolean }) => {
      if (message.action === "getBrowserSyncStatus") return { success: true, data: status };
      if (message.action === "setBrowserSyncEnabled") {
        toggleCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { success: true, data: { ...status, enabled: Boolean(message.enabled) } };
      }
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      }
      if (message.action === "getActivationSnapshot") {
        return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Browser sync"]')).toBeTruthy());
    const syncSwitch = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Browser sync"]')!;
    syncSwitch.click();
    syncSwitch.click();
    await waitFor(() => expect(toggleCalls).toBe(1));
  });

  test("shows a recoverable error when Browser Sync returns malformed status data", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#sync");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    const runtime = chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> };
    runtime.sendMessage = vi.fn(async (message: { action: string }) => {
      if (message.action === "getBrowserSyncStatus") return { success: true, data: { enabled: true } };
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      }
      if (message.action === "getActivationSnapshot") {
        return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.body.textContent).toContain("Browser sync returned an invalid status"));
    expect(getExactButton("Retry status check")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Checking browser sync...");
  });

  test("does not show installation-name success when cloud delivery failed", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#sync");
    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = createBasicSettingsChrome(storageData);
    const status = createBrowserSyncUiStatus({ enabled: false });
    let renameCalls = 0;
    const runtime = chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> };
    runtime.sendMessage = vi.fn(async (message: { action: string; name?: string }) => {
      if (message.action === "getBrowserSyncStatus") return { success: true, data: status };
      if (message.action === "updateBrowserSyncDeviceName") {
        renameCalls += 1;
        return {
          success: true,
          data: {
            ...status,
            deviceName: message.name || status.deviceName,
            lastError: "The installation name is saved locally, but could not be sent yet: sync unavailable"
          }
        };
      }
      if (message.action === "getTokenStatus") {
        return { success: true, data: { graph: { hasToken: false }, azureManagement: { hasToken: false } } };
      }
      if (message.action === "getActivationSnapshot") {
        return { success: true, data: { eligible: { items: [], errors: [] }, active: { items: [], errors: [] } } };
      }
      return { success: true, data: true };
    });
    vi.stubGlobal("chrome", chromeMock);
    vi.resetModules();
    await import("../src/settings/main");

    await waitFor(() => expect(document.querySelector<HTMLInputElement>("#sync-device-name")?.value).toBe("Admin Mac"));
    setFieldValue(document.querySelector<HTMLInputElement>("#sync-device-name")!, "Renamed laptop");
    await waitFor(() => expect(document.body.textContent).toContain("could not be sent yet"), 1_500);
    expect(document.body.textContent).not.toContain("Installation name saved.");
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(renameCalls).toBe(1);
  });
});

function createBrowserSyncUiStatus(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    capability: "available",
    supported: true,
    enabled: true,
    browserLabel: "Microsoft Edge",
    sourceLabel: "Microsoft Edge Add-ons",
    ecosystemLabel: "Microsoft Edge Sync",
    installationId: "current-installation",
    deviceName: "Admin Mac",
    platform: "macOS",
    lastSyncAt: now,
    lastSuccessAt: now,
    reminderMode: "daily",
    reminderDue: false,
    suspendedByPurge: false,
    devices: [{
      installationId: "current-installation",
      name: "Admin Mac",
      browser: "Microsoft Edge",
      platform: "macOS",
      appVersion: TEST_MANIFEST.version,
      lastSyncAt: now,
      syncEnabled: true,
      nameUpdatedAt: now
    }],
    crossDeviceState: "waiting",
    otherInstallationCount: 0,
    omittedCategories: [],
    ...overrides
  };
}

describe("settings message contrast", () => {
  test("uses a dedicated high-contrast success style for saved settings messages", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const successRule = css.match(/\.message\.success\s*\{[^}]+\}/)?.[0] || "";
    const darkSuccessRule = css.match(/body\.dark-mode\s+\.message\.success\s*\{[^}]+\}/)?.[0] || "";

    expect(successRule).toContain("background: #dcfce7;");
    expect(successRule).toContain("color: #14532d;");
    expect(successRule).toContain("border: 1px solid #86efac;");
    expect(darkSuccessRule).toContain("background: #14532d;");
    expect(darkSuccessRule).toContain("color: #dcfce7;");
  });

  test("keeps preference controls in balanced responsive grids", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

    expect(css).toMatch(/\.checkbox-grid\.enabled-features-grid\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.checkbox-grid\.enabled-features-grid\s*\{\s*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.settings-nav\s*\{[\s\S]*display: flex;[\s\S]*overflow-x: auto;/);
  });

  test("uses an explicit Browser Sync switch and separates installation guidance from its controls", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const switchRule = css.match(/\.sync-master-switch\s*\{[^}]+\}/)?.[0] || "";
    const headingRule = css.match(/\.sync-section-heading\s*\{[^}]+\}/)?.[0] || "";
    const installationRule = css.match(/\.sync-current-installation\s*\{[^}]+\}/)?.[0] || "";

    expect(switchRule).toContain("justify-content: space-between;");
    expect(switchRule).toContain("min-height: 54px;");
    expect(headingRule).toContain("margin-bottom: 14px;");
    expect(installationRule).toContain("gap: 7px;");
  });

  test("allows long Microsoft context values to wrap without clipping", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const identityValueRule = css.match(/\.access-identity\s*>\s*span\s*\{[^}]+\}/)?.[0] || "";

    expect(identityValueRule).toContain("min-width: 0;");
    expect(identityValueRule).toContain("overflow-wrap: anywhere;");
    expect(identityValueRule).toContain("word-break: break-word;");
  });
});
