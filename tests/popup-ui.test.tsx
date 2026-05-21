import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_KEY } from "../src/lib/cache";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.body.textContent?.match(/Loading access/g) || []).toHaveLength(1);
    expect(document.body.textContent).toContain("Loading access data (this can take up to 15 seconds)");
    expect(document.body.textContent).not.toContain("Loading access data (step");

    eligible.resolve({ success: true, data: { items: [], errors: [] } });
    active.resolve({ success: true, data: { items: [], errors: [] } });
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

    await waitFor(() => expect(document.body.textContent).toContain("0 eligible items"));
    expect(document.body.textContent).not.toContain("Using cached data");
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

  test("auto-enables only features with eligible items after the first successful fetch", async () => {
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
            return Promise.resolve({ success: true, data: { items: [azureItem], errors: [], diagnostics: [] } });
          }
          if (message.action === "getActiveItems") {
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

    await waitFor(() => expect(document.body.textContent).toContain("Reader"));
    expect(storageData[SETTINGS_KEY]).toMatchObject({
      preferences: expect.objectContaining({
        enabledFeatures: ["azureRole", "bundles"],
        autoEnabledFeaturesInitialized: true
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

    expect(openedUrls).toEqual(["chrome-extension://quickpim/settings.html#bundles"]);
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

    await waitFor(() => expect(document.body.textContent).toContain("Activation in progress (step 1/3): Sending activation request"));
    activation.resolve({
      success: true,
      data: {
        success: true,
        results: [{ itemId: eligibleItem.id, itemName: "Reader", success: true }],
        errors: []
      }
    });

    await waitFor(() => expect(document.body.textContent).toContain("Activation in progress (step 3/3): Refreshing activation status"));
    refreshedEligible.resolve({ success: true, data: { items: [], errors: [] } });
    refreshedActive.resolve({ success: true, data: { items: [{ ...eligibleItem, status: "active" }], errors: [] } });

    await waitFor(() => expect(document.body.textContent).toContain("Activation confirmed for 1 item."));
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

describe("popup role row styling", () => {
  test("right-aligns activation count and status badge in the status column", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const statusStackRule = css.match(/\.role-status-stack\s*\{[^}]+\}/)?.[0] || "";

    expect(statusStackRule).toContain("justify-items: end;");
    expect(statusStackRule).toContain("text-align: right;");
  });

  test("keeps popup controls compact and separates activation buttons from fields", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const toolbarRule = css.match(/\.toolbar\s*\{[^}]+\}/)?.[0] || "";
    const headerActionsRule = css.match(/\.header-actions\s*\{[^}]+\}/)?.[0] || "";
    const activationButtonRule = css.match(/\.activation-bar\s+\.button-row\s*\{[^}]+\}/)?.[0] || "";

    expect(headerActionsRule).toContain("justify-content: flex-end;");
    expect(toolbarRule).toContain("grid-template-columns: minmax(0, 1fr) 150px;");
    expect(activationButtonRule).toContain("margin-top: 10px;");
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

    await waitFor(() => expect(document.body.textContent).toContain("0 eligible items"));
    await waitFor(() => expect(document.body.classList.contains("dark-mode")).toBe(true));
  });
});
