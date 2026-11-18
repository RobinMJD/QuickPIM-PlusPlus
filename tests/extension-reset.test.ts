import { describe, expect, test, vi } from "vitest";
import { BROWSER_SYNC_PENDING_PURGE_KEY } from "../src/lib/browserSync";
import {
  EXTENSION_RESET_PENDING_KEY,
  resetExtensionData,
  resumePendingExtensionReset,
  type ExtensionResetApis
} from "../src/lib/extensionReset";

function createLocalStorage(data: Record<string, unknown> = { settings: { favorites: ["old-role"] } }) {
  return {
    data,
    get: vi.fn(async (key: string | null) => key === null ? { ...data } : { [key]: data[key] }),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of [keys].flat()) delete data[key];
    })
  };
}

function createApis(overrides: Partial<ExtensionResetApis> = {}): ExtensionResetApis {
  return {
    loadRequestOperations: vi.fn(async () => []),
    hasInFlightTasks: vi.fn(() => false),
    closePortalRecoveryTabs: vi.fn(async () => undefined),
    clearNotifications: vi.fn(async () => undefined),
    removeNotificationPermission: vi.fn(async () => false),
    purgeSyncedData: vi.fn(async () => undefined),
    local: createLocalStorage(),
    session: { clear: vi.fn(async () => undefined) },
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
    expect(apis.local.remove).not.toHaveBeenCalled();
    expect(apis.session.clear).not.toHaveBeenCalled();
  });

  test("clears persistent and session data plus best-effort browser artifacts", async () => {
    const local = createLocalStorage({ settings: {}, [BROWSER_SYNC_PENDING_PURGE_KEY]: { version: 1 } });
    const apis = createApis({ local });

    await resetExtensionData(apis);

    expect(apis.closePortalRecoveryTabs).toHaveBeenCalledOnce();
    expect(apis.clearNotifications).toHaveBeenCalledOnce();
    expect(apis.removeNotificationPermission).toHaveBeenCalledOnce();
    expect(apis.purgeSyncedData).toHaveBeenCalledOnce();
    expect(apis.local.set).toHaveBeenCalledOnce();
    expect(local.data).toEqual({});
    expect(apis.session.clear).toHaveBeenCalledOnce();
    expect(apis.clearAlarms).toHaveBeenCalledOnce();
    expect(apis.clearActionBadge).toHaveBeenCalledOnce();
  });

  test("completes the local reset and queues a retry when synchronized data cannot be purged", async () => {
    const local = createLocalStorage();
    const apis = createApis({
      local,
      purgeSyncedData: vi.fn(async () => { throw new Error("sync unavailable"); })
    });

    await resetExtensionData(apis);

    expect(apis.session.clear).toHaveBeenCalledOnce();
    expect(local.data).toEqual({
      [BROWSER_SYNC_PENDING_PURGE_KEY]: expect.objectContaining({ lastError: "sync unavailable" })
    });
  });

  test("still clears storage when optional browser cleanup fails", async () => {
    const apis = createApis({
      clearNotifications: vi.fn(async () => { throw new Error("notifications unavailable"); }),
      closePortalRecoveryTabs: vi.fn(async () => { throw new Error("tabs unavailable"); })
    });

    await resetExtensionData(apis);

    expect(await apis.local.get(null)).toEqual({});
    expect(apis.session.clear).toHaveBeenCalledOnce();
  });

  test("restores an interrupted local reset and keeps the failed cloud purge pending", async () => {
    const local = createLocalStorage();
    const apis = createApis({
      local,
      session: { clear: vi.fn(async () => { throw new Error("session unavailable"); }) },
      purgeSyncedData: vi.fn(async () => { throw new Error("sync unavailable"); })
    });

    await expect(resetExtensionData(apis)).rejects.toThrow("session unavailable");

    expect(local.data[EXTENSION_RESET_PENDING_KEY]).toMatchObject({ keepSyncPurge: true });
    expect(local.remove).not.toHaveBeenCalled();
    const session = { clear: vi.fn(async () => undefined) };
    await expect(resumePendingExtensionReset(local, session)).resolves.toBe(true);
    expect(session.clear).toHaveBeenCalledOnce();
    expect(local.data).toEqual({
      [BROWSER_SYNC_PENDING_PURGE_KEY]: expect.objectContaining({ lastError: "sync unavailable" })
    });
  });

  test("resumes a marked half-reset by clearing session before local data", async () => {
    const calls: string[] = [];
    const local = createLocalStorage({ [EXTENSION_RESET_PENDING_KEY]: { version: 1 }, settings: {} });
    local.remove.mockImplementationOnce(async () => { calls.push("local"); });
    const session = {
      clear: vi.fn(async () => { calls.push("session"); })
    };

    await expect(resumePendingExtensionReset(local, session)).resolves.toBe(true);
    expect(calls).toEqual(["session", "local"]);
  });

  test("does not clear anything when no reset marker exists", async () => {
    const local = createLocalStorage({});
    const session = { clear: vi.fn(async () => undefined) };

    await expect(resumePendingExtensionReset(local, session)).resolves.toBe(false);
    expect(session.clear).not.toHaveBeenCalled();
    expect(local.remove).not.toHaveBeenCalled();
  });
});
