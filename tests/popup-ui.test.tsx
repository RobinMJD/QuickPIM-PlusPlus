import { afterEach, describe, expect, test, vi } from "vitest";
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
