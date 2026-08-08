import { describe, expect, test, vi } from "vitest";
import { resetExtensionData, type ExtensionResetApis } from "../src/lib/extensionReset";

function createApis(overrides: Partial<ExtensionResetApis> = {}): ExtensionResetApis {
  return {
    loadRequestOperations: vi.fn(async () => []),
    hasInFlightTasks: vi.fn(() => false),
    closePortalRecoveryTabs: vi.fn(async () => undefined),
    clearNotifications: vi.fn(async () => undefined),
    removeNotificationPermission: vi.fn(async () => false),
    clearLocalStorage: vi.fn(async () => undefined),
    clearSessionStorage: vi.fn(async () => undefined),
    clearAlarms: vi.fn(async () => false),
    clearActionBadge: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("full extension reset", () => {
  test("refuses to clear data while a request operation is running", async () => {
    const apis = createApis({
      loadRequestOperations: vi.fn(async () => [{ state: "running" } as never])
    });

    await expect(resetExtensionData(apis)).rejects.toThrow("current activation or deactivation");
    expect(apis.clearLocalStorage).not.toHaveBeenCalled();
    expect(apis.clearSessionStorage).not.toHaveBeenCalled();
  });

  test("clears persistent and session data plus best-effort browser artifacts", async () => {
    const apis = createApis();

    await resetExtensionData(apis);

    expect(apis.closePortalRecoveryTabs).toHaveBeenCalledOnce();
    expect(apis.clearNotifications).toHaveBeenCalledOnce();
    expect(apis.removeNotificationPermission).toHaveBeenCalledOnce();
    expect(apis.clearLocalStorage).toHaveBeenCalledOnce();
    expect(apis.clearSessionStorage).toHaveBeenCalledOnce();
    expect(apis.clearAlarms).toHaveBeenCalledOnce();
    expect(apis.clearActionBadge).toHaveBeenCalledOnce();
  });

  test("still clears storage when optional browser cleanup fails", async () => {
    const apis = createApis({
      clearNotifications: vi.fn(async () => { throw new Error("notifications unavailable"); }),
      closePortalRecoveryTabs: vi.fn(async () => { throw new Error("tabs unavailable"); })
    });

    await resetExtensionData(apis);

    expect(apis.clearLocalStorage).toHaveBeenCalledOnce();
    expect(apis.clearSessionStorage).toHaveBeenCalledOnce();
  });
});
