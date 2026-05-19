import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_CACHE_KEY } from "../src/lib/cache";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/settings";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
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
    expect(document.querySelector(".filter-field .field-icon")).toBeTruthy();
    expect(document.querySelector(".sort-field .field-icon")).toBeTruthy();
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
});
