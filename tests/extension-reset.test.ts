import { describe, expect, test, vi } from "vitest";
import {
  EXTENSION_RESET_PENDING_KEY,
  resetExtensionData,
  resumePendingExtensionReset,
  type ExtensionResetApis
} from "../src/lib/extensionReset";

function createApis(overrides: Partial<ExtensionResetApis> = {}): ExtensionResetApis {
  return {
    loadRequestOperations: vi.fn(async () => []),
    hasInFlightTasks: vi.fn(() => false),
    closePortalRecoveryTabs: vi.fn(async () => undefined),
    clearNotifications: vi.fn(async () => undefined),
    removeNotificationPermission: vi.fn(async () => false),
    purgeSyncedData: vi.fn(async () => undefined),
    queueSyncedDataPurge: vi.fn(async () => undefined),
    prepareResetRecovery: vi.fn(async () => undefined),
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

    await expect(resetExtensionData(apis)).rejects.toThrow("current activation, refresh, sync, or status check");
    expect(apis.clearLocalStorage).not.toHaveBeenCalled();
    expect(apis.clearSessionStorage).not.toHaveBeenCalled();
  });

  test("clears persistent and session data plus best-effort browser artifacts", async () => {
    const apis = createApis();

    await resetExtensionData(apis);

    expect(apis.closePortalRecoveryTabs).toHaveBeenCalledOnce();
    expect(apis.clearNotifications).toHaveBeenCalledOnce();
    expect(apis.removeNotificationPermission).toHaveBeenCalledOnce();
    expect(apis.purgeSyncedData).toHaveBeenCalledOnce();
    expect(apis.prepareResetRecovery).toHaveBeenCalledOnce();
    expect(apis.clearLocalStorage).toHaveBeenCalledOnce();
    expect(apis.clearSessionStorage).toHaveBeenCalledOnce();
    expect(apis.clearAlarms).toHaveBeenCalledOnce();
    expect(apis.clearActionBadge).toHaveBeenCalledOnce();
  });

  test("completes the local reset and queues a retry when synchronized data cannot be purged", async () => {
    const apis = createApis({
      purgeSyncedData: vi.fn(async () => { throw new Error("sync unavailable"); })
    });

    await resetExtensionData(apis);

    expect(apis.clearLocalStorage).toHaveBeenCalledOnce();
    expect(apis.clearSessionStorage).toHaveBeenCalledOnce();
    expect(apis.queueSyncedDataPurge).toHaveBeenCalledWith(expect.objectContaining({ message: "sync unavailable" }));
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

  test("leaves the durable reset marker available when session clearing fails", async () => {
    const apis = createApis({
      clearSessionStorage: vi.fn(async () => { throw new Error("session unavailable"); })
    });

    await expect(resetExtensionData(apis)).rejects.toThrow("session unavailable");

    expect(apis.prepareResetRecovery).toHaveBeenCalledOnce();
    expect(apis.clearLocalStorage).not.toHaveBeenCalled();
  });

  test("resumes a marked half-reset by clearing session before local data", async () => {
    const calls: string[] = [];
    const local = {
      get: vi.fn(async () => ({ [EXTENSION_RESET_PENDING_KEY]: { version: 1 } })),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => { calls.push("local"); })
    };
    const session = {
      clear: vi.fn(async () => { calls.push("session"); })
    };

    await expect(resumePendingExtensionReset(local, session)).resolves.toBe(true);
    expect(calls).toEqual(["session", "local"]);
  });

  test("does not clear anything when no reset marker exists", async () => {
    const local = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    };
    const session = { clear: vi.fn(async () => undefined) };

    await expect(resumePendingExtensionReset(local, session)).resolves.toBe(false);
    expect(session.clear).not.toHaveBeenCalled();
    expect(local.clear).not.toHaveBeenCalled();
  });
});
