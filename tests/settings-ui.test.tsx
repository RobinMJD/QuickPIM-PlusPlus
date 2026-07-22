import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_KEY } from "../src/lib/cache";
import { POPUP_DRAFT_KEY } from "../src/lib/popupDraft";
import { REQUEST_TRACKING_KEY } from "../src/lib/requestTracking";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";
import { MAX_USER_JUSTIFICATION_LENGTH } from "../src/lib/justifications";

afterEach(() => {
  const cleanupWindow = window as Window & { __quickPimSettingsUnmount?: () => void };
  cleanupWindow.__quickPimSettingsUnmount?.();
  cleanupWindow.__quickPimSettingsUnmount = undefined;
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

describe("settings Home page", () => {
  test("opens on a home dashboard with grouped icon navigation and a GitHub changelog", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#home");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/releases/tags/v2.10.13")) {
        return {
          ok: true,
          json: async () => ({
            tag_name: "v2.10.13",
            name: "QuickPIM++ v2.10.13",
            body: "React rewrite, bundles, PIM groups, and cleaner settings.",
            html_url: "https://github.com/RobinMJD/QuickPIM-PlusPlus/releases/tag/v2.10.13",
            published_at: "2026-05-18T10:00:00.000Z"
          })
        };
      }
      return { ok: true, json: async () => [] };
    });
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("QuickPIM++ v2.10.13"));
    expect(document.body.textContent).toContain("2026-05-18");
    expect(document.body.textContent).not.toContain("5/18/2026");
    expect(document.body.textContent).toContain("Manage activation defaults, access setup, saved justifications, bundles, aliases, and local data.");
    expect(document.body.textContent).toContain("Overview");
    expect(document.body.textContent).toContain("Setup");
    expect(document.body.textContent).toContain("Daily Use");
    expect(document.body.textContent).toContain("Preferences");
    expect(document.body.textContent).toContain("Maintenance");

    const navButtons = [...document.querySelectorAll(".settings-nav button")].map((button) => button.textContent?.trim());
    expect(navButtons).toEqual([
      "Home",
      "Access Setup",
      "Activity",
      "Justifications",
      "Bundles",
      "Aliases",
      "Preferences",
      "Import / Export",
      "Diagnostics",
      "About"
    ]);
    expect(navButtons.at(-1)).toBe("About");
    expect(document.querySelectorAll(".settings-nav-icon")).toHaveLength(10);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/RobinMJD/QuickPIM-PlusPlus/releases/tags/v2.10.13");
  });

  test("uses cached GitHub changelog data without fetching again", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#home");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      "quickPimChangelog.v2": {
        fetchedAt: Date.now(),
        releaseTag: "v2.10.13",
        items: [
          {
            title: "Cached v2.10.13",
            description: "Cached release notes.",
            url: "https://github.com/RobinMJD/QuickPIM-PlusPlus/releases/tag/v2.10.13",
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

    await waitFor(() => expect(document.body.textContent).toContain("Cached v2.10.13"));
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
      if (url.endsWith("/releases/tags/v2.10.13")) {
        return {
          ok: true,
          json: async () => ({
            tag_name: "v2.10.13",
            name: "QuickPIM++ v2.10.13",
            body: "Fixes the settings changelog cache.",
            html_url: "https://github.com/RobinMJD/QuickPIM-PlusPlus/releases/tag/v2.10.13",
            published_at: "2026-05-21T10:00:00.000Z"
          })
        };
      }
      return { ok: true, json: async () => [] };
    });
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

    await waitFor(() => expect(document.body.textContent).toContain("QuickPIM++ v2.10.13"));
    expect(document.body.textContent).not.toContain("Cached v2.1.0");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/RobinMJD/QuickPIM-PlusPlus/releases/tags/v2.10.13");
    expect(storageData["quickPimChangelog.v2"]).toMatchObject({
      releaseTag: "v2.10.13"
    });
  });
});

describe("settings About page", () => {
  test("renders v2 version, original author credit, and local privacy note", async () => {
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
    expect(text).toContain("QuickPIM++ 2.10.13");
    expect(text).not.toContain("0.0.0");
    expect(text).toMatch(/Build: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(text).toContain("Original author: Daniel Bradley");
    expect(document.querySelector<HTMLAnchorElement>('a[href="https://github.com/DanielBradley1/QuickPIM"]')?.textContent).toBe(
      "Daniel Bradley"
    );
    expect(text).toContain("role bundles, saved justifications, favorites, aliases, dark mode, learned names, access setup, and much more!");
    expect(text).not.toContain("security hardening");
    expect(text).toContain("Tokens and settings stay in this browser profile.");
  });
});

describe("settings Access Setup page", () => {
  test("uses fresh cached eligible items when settings opens", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#aliases");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph:|azure:",
          errors: [],
          items: [
            {
              id: "directoryRole:reader:/",
              type: "directoryRole",
              sourceName: "Global Reader",
              displayName: "Global Reader",
              principalId: "user-1",
              roleDefinitionId: "reader",
              directoryScopeId: "/",
              scopeLabel: "Tenant",
              status: "eligible"
            }
          ]
        }
      }
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            throw new Error("Settings should use cached eligible data.");
          }
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: true, isExpired: false },
                azureManagement: { hasToken: true, isExpired: false }
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
    await waitFor(() => expect(document.body.textContent).toContain("Global Reader"));

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    expect(text).toContain("Access Setup");
    expect(text).toContain("Open missing portal pages");
    expect(text).not.toMatch(/dedicated app|manual token|app registration|PowerShell/i);

    clickButton("Open missing portal pages");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(openedTargets).toEqual([["directoryRole", "pimGroup", "azureRole"]]);
  });

  test("renders feature-specific success and failure diagnostics", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings(),
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graphDirectory:",
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
        active: {
          fetchedAt: Date.now(),
          cacheKey: "graphPimGroup:",
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
        },
        eligibleByTarget: {
          directoryRole: {
            fetchedAt: Date.now(),
            cacheKey: "graphDirectory:",
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
            cacheKey: "graphPimGroup:",
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
        },
        activeByTarget: {
          pimGroup: {
            fetchedAt: Date.now(),
            cacheKey: "graphPimGroup:",
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getTokenStatus") {
            return {
              success: true,
              data: {
                graph: { hasToken: true, isExpired: false },
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

    await waitFor(() => expect(document.body.textContent).toContain("Eligible assignments"));
    expect(document.body.textContent).toContain("Last failure");
    expect(document.body.textContent).toContain("PIM group active assignments");
    expect(document.body.textContent).toContain("missingCapability");
  });

  test("rescans existing Entra tabs before opening setup pages", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    let tokenRequests = 0;
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
                : {
                  graph: { hasToken: true, capturedAt: 2 },
                  graphTargets: {
                    directoryRole: {
                      hasToken: true,
                      capturedAt: 2,
                      grantedScopes: ["RoleEligibilitySchedule.Read.Directory", "RoleAssignmentSchedule.ReadWrite.Directory"]
                    },
                    pimGroup: {
                      hasToken: true,
                      capturedAt: 2,
                      grantedScopes: ["PrivilegedEligibilitySchedule.Read.AzureADGroup", "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup"]
                    }
                  },
                  azureManagement: { hasToken: true, capturedAt: 2 }
                };
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
    await waitFor(() => expect(document.body.textContent).toContain("Access Setup"));
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Access Setup"));

    clickButton("Recheck now");

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Access Setup"));

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Access Setup"));

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Access Setup"));

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
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Access Setup"));

    holdEligibleRefresh = true;
    clickButton("Refresh eligible items");
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

    const resultFilter = document.querySelector<HTMLSelectElement>('select[aria-label="Filter activity result"]')!;
    resultFilter.value = "failed";
    resultFilter.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(document.body.textContent).not.toContain("Global Reader"));
    expect(document.body.textContent).toContain("Security Group");

    clickButton("Clear history");
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
    const openPopup = vi.fn(async () => undefined);
    const createTab = vi.fn(async () => undefined);
    const chromeMock = {
      action: { openPopup },
      tabs: { create: createTab },
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    clickButton("Global Administrator");
    await waitFor(() => expect(document.body.textContent).toContain("Investigate production incident INC12345"));
    expect(document.body.textContent).toContain("request-1");
    expect(document.body.textContent).toContain("Pending approval");

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Role Bundles"));

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Role Bundles"));

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

    expect(actionRule).toContain("margin-top: 8px;");
    expect(actionRule).toContain("margin-bottom: 18px;");
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
  });

  test("preserves and autosaves a preference draft when another settings section changes", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const storageListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void> = [];
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Popup defaults"));
    await waitFor(() => expect(storageListeners).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(".settings-layout")?.getAttribute("aria-busy")).toBe("false"));

    const sortSelect = [...document.querySelectorAll<HTMLSelectElement>(".popup-defaults-grid select")][1];
    sortSelect.value = "scope";
    sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(sortSelect.value).toBe("scope"));

    const current = storageData[SETTINGS_KEY] as typeof DEFAULT_SETTINGS;
    const external = { ...current, savedJustifications: ["Remote saved reason"] };
    storageData[SETTINGS_KEY] = external;
    storageListeners[0]({ [SETTINGS_KEY]: { oldValue: current, newValue: external } }, "local");

    await waitFor(() => expect(sortSelect.value).toBe("scope"));
    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        savedJustifications: ["Remote saved reason"],
        preferences: expect.objectContaining({ defaultSort: "scope" })
      });
    });
  });

  test("serializes saves from different settings sections without losing either change", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    let preferenceSaveAttempts = 0;
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Popup defaults"));

    expect(document.body.textContent).toContain("Default activation duration");
    expect(document.body.textContent).toContain("Preselected in the popup when selected roles allow it.");
    expect(document.body.textContent).toContain("Default sort order");
    expect(document.body.textContent).toContain("Recent justification history limit");
    expect(document.body.textContent).not.toContain("Default duration");
    expect(document.body.textContent).toContain("Changes on this page are saved automatically.");
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
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Popup defaults"));
    await waitFor(() => expect(document.querySelector(".settings-layout")?.getAttribute("aria-busy")).toBe("false"));

    const recentLimit = document.querySelector<HTMLInputElement>('input[type="number"][min="1"]')!;
    setFieldValue(recentLimit, "12");
    await waitFor(() => expect(document.querySelector(".autosave-status")?.textContent).toContain("Changes pending"));
    clickButton("Home");

    await waitFor(() => expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({ recentJustificationLimit: 12 })
    }));
  });

  test("shows advanced preference controls in a dedicated section without a reveal toggle", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: createDefaultSettings()
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Advanced settings"));

    expect(document.body.textContent).not.toContain("Show advanced settings");
    expect(document.body.textContent).toContain("Usage counters");
    expect(document.body.textContent).toContain("Background pre-refresh");
    expect(document.body.textContent).toContain("Show enablement details");
    expect(document.body.textContent).toContain("Show last enablement date");
    expect(document.body.textContent).toContain("Request status notifications");
    const enablementDetailsToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show enablement details in popup"]');
    const lastEnablementToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show last enablement date in popup"]');
    const assignedRolesToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show assigned active roles in popup"]');
    const showRemainingTimeToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show remaining activation time in popup"]');
    const requestNotificationsToggle = document.querySelector<HTMLInputElement>('input[aria-label="Notify me about request updates"]');
    expect(enablementDetailsToggle).toBeTruthy();
    expect(lastEnablementToggle).toBeTruthy();
    expect(assignedRolesToggle).toBeTruthy();
    expect(showRemainingTimeToggle).toBeTruthy();
    expect(showRemainingTimeToggle!.checked).toBe(true);
    expect(requestNotificationsToggle).toBeTruthy();
    expect(enablementDetailsToggle!.checked).toBe(false);
    expect(lastEnablementToggle!.checked).toBe(false);
    expect(requestNotificationsToggle!.checked).toBe(false);
  });

  test("requests optional notification permission only when notifications are enabled", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = { [SETTINGS_KEY]: createDefaultSettings() };
    const requestPermission = vi.fn(async () => true);
    const chromeMock = {
      permissions: {
        request: requestPermission,
        remove: vi.fn(async () => true)
      },
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

  test("saves display preferences and applies dark mode to settings", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const settings = createDefaultSettings();
    settings.preferences.darkMode = true;
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

    const darkModeToggle = document.querySelector<HTMLInputElement>('input[aria-label="Dark mode"]');
    const enablementDetailsToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show enablement details in popup"]');
    const lastEnablementToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show last enablement date in popup"]');
    const assignedRolesToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show assigned active roles in popup"]');
    const showRemainingTimeToggle = document.querySelector<HTMLInputElement>('input[aria-label="Show remaining activation time in popup"]');
    expect(darkModeToggle).toBeTruthy();
    expect(enablementDetailsToggle).toBeTruthy();
    expect(lastEnablementToggle).toBeTruthy();
    expect(assignedRolesToggle).toBeTruthy();
    expect(showRemainingTimeToggle).toBeTruthy();
    await waitFor(() => expect(darkModeToggle!.checked).toBe(true));
    expect(enablementDetailsToggle!.checked).toBe(false);
    expect(lastEnablementToggle!.checked).toBe(false);
    expect(assignedRolesToggle!.checked).toBe(false);
    expect(showRemainingTimeToggle!.checked).toBe(true);
    enablementDetailsToggle!.click();
    lastEnablementToggle!.click();
    assignedRolesToggle!.click();
    showRemainingTimeToggle!.click();

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        preferences: expect.objectContaining({ darkMode: true, showAssignedRoles: true, showRemainingActivationTime: false, showEnablementDetails: true, showLastEnablementDate: true })
      });
      expect(document.body.classList.contains("dark-mode")).toBe(true);
    });
    await waitFor(() => expect(document.querySelector(".autosave-status")?.textContent).toContain("Saved"));
    expect(document.body.textContent).not.toContain("Settings saved.");
  });

  test("shows usage dates as yyyy-MM-dd in preferences", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

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
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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

    await waitFor(() => expect(document.body.textContent).toContain("2026-06-12"));
    expect(document.body.textContent).not.toContain("6/12/2026");
  });

  test("saves enabled feature preferences", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const settings = createDefaultSettings();
    settings.preferences.enabledFeatures = ["directoryRole", "pimGroup", "bundles"];
    settings.preferences.autoEnabledFeaturesInitialized = true;
    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: settings
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.10.13" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Enabled features"));

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
});

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
});
