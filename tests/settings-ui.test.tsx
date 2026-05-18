import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function clickButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return button;
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

describe("settings About page", () => {
  test("renders v2 version, original author credit, and local privacy note", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#about");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM", version: "2.0.0" }),
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
    expect(text).toContain("QuickPIM 2.0.0");
    expect(text).toContain("Original author: Daniel Bradley");
    expect(text).toContain("Tokens and settings stay in this browser profile.");
  });
});

describe("settings Access Setup page", () => {
  test("renders portal-driven setup without dedicated app or PowerShell guidance", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "#access");

    const storageData: Record<string, unknown> = {
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    };
    const openedUrls: string[] = [];
    const chromeMock = {
      runtime: {
        getManifest: () => ({ name: "QuickPIM", version: "2.0.0" }),
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
        getManifest: () => ({ name: "QuickPIM", version: "2.0.0" }),
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
        getManifest: () => ({ name: "QuickPIM", version: "2.0.0" }),
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
        getManifest: () => ({ name: "QuickPIM", version: "2.0.0" }),
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
