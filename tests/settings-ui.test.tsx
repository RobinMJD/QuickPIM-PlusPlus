import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_KEY } from "../src/lib/cache";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";

afterEach(() => {
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
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
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
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/releases")) {
        return {
          ok: true,
          json: async () => [
            {
              tag_name: "v2.0.0",
              name: "QuickPIM++ v2.0.0",
              body: "React rewrite, bundles, PIM groups, and cleaner settings.",
              html_url: "https://github.com/RobinMJD/QuickPIM/releases/tag/v2.0.0",
              published_at: "2026-05-18T10:00:00.000Z"
            }
          ]
        };
      }
      return { ok: true, json: async () => [] };
    });
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("QuickPIM++ v2.0.0"));
    expect(document.body.textContent).toContain("Manage activation defaults, access setup, saved justifications, bundles, aliases, and local data.");
    expect(document.body.textContent).toContain("Setup");
    expect(document.body.textContent).toContain("Configuration");
    expect(document.body.textContent).toContain("Maintenance");

    const navButtons = [...document.querySelectorAll(".settings-nav button")].map((button) => button.textContent?.trim());
    expect(navButtons).toEqual([
      "Home",
      "Access Setup",
      "Aliases",
      "Justifications",
      "Bundles",
      "Preferences",
      "Import / Export",
      "About"
    ]);
    expect(navButtons.at(-1)).toBe("About");
    expect(document.querySelectorAll(".settings-nav-icon")).toHaveLength(8);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/RobinMJD/QuickPIM/releases?per_page=5");
  });

  test("uses cached GitHub changelog data without fetching again", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#home");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      "quickPimChangelog.v1": {
        fetchedAt: Date.now(),
        items: [
          {
            title: "Cached v2.0.0",
            description: "Cached release notes.",
            url: "https://github.com/RobinMJD/QuickPIM/releases/tag/v2.0.0",
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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

    await waitFor(() => expect(document.body.textContent).toContain("Cached v2.0.0"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("settings About page", () => {
  test("renders v2 version, original author credit, and local privacy note", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#about");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
    expect(text).toContain("QuickPIM++ 2.0.0");
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
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [DATA_CACHE_KEY]: {
        eligible: {
          fetchedAt: Date.now(),
          cacheKey: "graph::|azure::",
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const openedUrls: string[] = [];
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems" || message.action === "getActiveItems") {
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
        }),
        getURL: (path: string) => `chrome-extension://quickpim/${path}`
      },
      tabs: {
        create: vi.fn(({ url }: { url: string }) => openedUrls.push(url))
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
    expect(text).toContain("Access Setup");
    expect(text).toContain("Open missing portal pages");
    expect(text).not.toMatch(/dedicated app|manual token|app registration|PowerShell/i);

    clickButton("Open missing portal pages");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(openedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("aadmigratedroles"),
        expect.stringContaining("aadgroup"),
        expect.stringContaining("azurerbac")
      ])
    );
  });

  test("recheck now fetches fresh token status before recomputing access state", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    let tokenRequests = 0;
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
          if (message.action === "getTokenStatus") {
            tokenRequests += 1;
            return {
              success: true,
              data: tokenRequests === 1
                ? {
                  graph: { hasToken: false },
                  azureManagement: { hasToken: true, capturedAt: 1 }
                }
                : {
                  graph: { hasToken: true, capturedAt: 2 },
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

    clickButton("Recheck now");

    await waitFor(() => expect(tokenRequests).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(document.querySelectorAll(".permission-state.ok").length).toBeGreaterThanOrEqual(3));
  });

  test("shows progress while rechecking access data", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    let eligibleCalls = 0;
    let resolveEligibleRefresh: ((value: unknown) => void) | undefined;
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            eligibleCalls += 1;
            if (eligibleCalls > 1) {
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

    clickButton("Recheck now");
    await waitFor(() => expect(eligibleCalls).toBe(2));

    expect(document.body.textContent).toContain("Refreshing access data");
    resolveEligibleRefresh?.({ success: true, data: { items: [], errors: [] } });
    await waitFor(() => expect(document.body.textContent).toContain("Access data refreshed."));
  });

  test("shows progress while refreshing eligible items", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    let eligibleCalls = 0;
    let resolveEligibleRefresh: ((value: unknown) => void) | undefined;
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
        sendMessage: vi.fn(async (message: { action: string }) => {
          if (message.action === "getActivationItems") {
            eligibleCalls += 1;
            if (eligibleCalls > 1) {
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

    clickButton("Refresh eligible items");
    await waitFor(() => expect(eligibleCalls).toBe(2));

    expect(document.body.textContent).toContain("Refreshing eligible items");
    resolveEligibleRefresh?.({ success: true, data: { items: [], errors: [] } });
    await waitFor(() => expect(document.body.textContent).toContain("Eligible items refreshed."));
  });
});

describe("settings justification guardrails", () => {
  test("blocks generic saved justifications", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#justifications");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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

    const nextSettings = {
      ...DEFAULT_SETTINGS,
      savedJustifications: ["Emergency patch approval"]
    };
    storageData[SETTINGS_KEY] = nextSettings;
    expect(storageListeners).toHaveLength(1);
    storageListeners[0]({ [SETTINGS_KEY]: { oldValue: DEFAULT_SETTINGS, newValue: nextSettings } }, "local");

    await waitFor(() => expect(document.body.textContent).toContain("Emergency patch approval"));
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
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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

    const readerOption = [...document.querySelectorAll("label.checkbox-option")].find((item) => item.textContent?.includes("Reader"));
    readerOption?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();

    await waitFor(() => {
      const duration = document.querySelector<HTMLSelectElement>('select[aria-label="Bundle duration"]');
      expect(duration).toBeTruthy();
      expect([...duration!.options].map((option) => option.textContent)).toEqual(["30 minutes", "1 hour", "2 hours"]);
    });
  });

  test("blocks generic bundle default justifications", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#bundles");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
    const readerOption = [...document.querySelectorAll("label.checkbox-option")].find((item) => item.textContent?.includes("Reader"));
    readerOption?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    clickButton("Save bundle");

    await waitFor(() => expect(document.body.textContent).toContain("Generic answers such as BAU, Admin, or needed are blocked."));
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
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
        expect.objectContaining({ id: "bundle:daily-operations-copy", name: "Daily operations copy" })
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
});

describe("settings dark mode", () => {
  test("clarifies popup defaults and uses labeled activation duration options", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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

  test("saves the dark mode preference and applies it to settings", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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

    document.querySelector<HTMLInputElement>('input[aria-label="Dark mode"]')?.click();
    clickButton("Save preferences");

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        preferences: expect.objectContaining({ darkMode: true })
      });
      expect(document.body.classList.contains("dark-mode")).toBe(true);
    });
    expect(document.querySelector(".message.success")?.textContent).toContain("Settings saved.");
  });

  test("saves hidden popup tab preferences", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#preferences");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM++", version: "2.0.0" }),
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
    await waitFor(() => expect(document.body.textContent).toContain("Popup tabs"));

    document.querySelector<HTMLInputElement>('input[aria-label="Hide Azure Roles tab"]')?.click();
    clickButton("Save preferences");

    await waitFor(() => {
      expect(storageData[SETTINGS_KEY]).toMatchObject({
        preferences: expect.objectContaining({ hiddenPopupTabs: ["azureRole"] })
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
});
