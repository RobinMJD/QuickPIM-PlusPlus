import { describe, expect, test } from "vitest";
import {
  BROWSER_SYNC_CONTROL_KEY,
  BROWSER_SYNC_KEY_PREFIX,
  BROWSER_SYNC_MANIFEST_KEY,
  BROWSER_SYNC_REMINDER_INTERVAL_MS,
  dismissBrowserSyncReminder,
  formatBrowserSyncInstallationId,
  getBrowserSyncCapability,
  getBrowserSyncInstallationIdentity,
  getBrowserSyncStatus,
  markBrowserSyncReminderShown,
  purgeBrowserSyncData,
  renameBrowserSyncDevice,
  sanitizeBrowserSyncSnapshot,
  setBrowserSyncEnabled,
  synchronizeBrowserData
} from "../src/lib/browserSync";
import {
  CHROME_WEB_STORE_EXTENSION_ID,
  EDGE_ADDONS_EXTENSION_ID,
  classifyExtensionDistribution
} from "../src/lib/distribution";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  mutateSettingsInStorage,
  recordOperationActivity
} from "../src/lib/settings";
import type { ActivationItem, QuickPimSettings } from "../src/lib/types";

class MemoryStorage {
  data: Record<string, unknown>;
  accessLevel?: string;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (keys === undefined || keys === null) return structuredClone(this.data);
    if (typeof keys === "string") return { [keys]: structuredClone(this.data[keys]) };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(this.data[key])]));
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, structuredClone(this.data[key] ?? fallback)]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(items));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }

  async setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> {
    this.accessLevel = options.accessLevel;
  }
}

class BlockingSettingsStorage extends MemoryStorage {
  private releaseWrite?: () => void;
  private writeStarted?: () => void;
  private shouldBlockSettingsWrite = false;

  armSettingsWriteBlock() {
    this.shouldBlockSettingsWrite = true;
    return {
      started: new Promise<void>((resolve) => { this.writeStarted = resolve; }),
      release: () => this.releaseWrite?.()
    };
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    if (this.shouldBlockSettingsWrite && Object.hasOwn(items, SETTINGS_KEY)) {
      this.writeStarted?.();
      await new Promise<void>((resolve) => { this.releaseWrite = resolve; });
      this.shouldBlockSettingsWrite = false;
    }
    await super.set(items);
  }
}

class BlockingManifestStorage extends MemoryStorage {
  private releaseRead?: () => void;
  private readStarted?: () => void;
  private shouldBlockManifestRead = false;

  armManifestReadBlock() {
    this.shouldBlockManifestRead = true;
    return {
      started: new Promise<void>((resolve) => { this.readStarted = resolve; }),
      release: () => this.releaseRead?.()
    };
  }

  override async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (this.shouldBlockManifestRead && keys === BROWSER_SYNC_MANIFEST_KEY) {
      this.readStarted?.();
      await new Promise<void>((resolve) => { this.releaseRead = resolve; });
      this.shouldBlockManifestRead = false;
    }
    return super.get(keys);
  }
}

class ConcurrentDeviceStorage extends MemoryStorage {
  private injectAfterNextDeviceSnapshot = false;

  override async set(items: Record<string, unknown>): Promise<void> {
    await super.set(items);
    if (Object.keys(items).some((key) => key.startsWith("quickPimSync.device.v1."))) {
      this.injectAfterNextDeviceSnapshot = true;
    }
  }

  override async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const snapshot = await super.get(keys);
    if (keys === null && this.injectAfterNextDeviceSnapshot) {
      this.injectAfterNextDeviceSnapshot = false;
      this.data["quickPimSync.device.v1.concurrent-device"] = {
        installationId: "concurrent-device",
        name: "Concurrent device",
        browser: "Google Chrome",
        platform: "Linux",
        appVersion: "2.16.4",
        lastSyncAt: 1_001,
        syncEnabled: true,
        nameUpdatedAt: 1_001
      };
    }
    return snapshot;
  }
}

const chromeStore = classifyExtensionDistribution({
  userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36",
  extensionId: CHROME_WEB_STORE_EXTENSION_ID,
  installType: "normal"
});
const edgeStore = classifyExtensionDistribution({
  userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0",
  extensionId: EDGE_ADDONS_EXTENSION_ID,
  installType: "normal"
});

describe("native browser sync", () => {
  test("sanitizes remote categories and rejects unsafe record keys before merging", () => {
    const snapshot = sanitizeBrowserSyncSnapshot({
      version: 1,
      categories: {
        preferences: {
          updatedAt: 1,
          updatedBy: "device-1",
          value: { darkMode: true }
        },
        aliasesByItemId: {
          updatedAt: 1,
          updatedBy: "device-1",
          value: JSON.parse(`{
            "directoryRole:safe:/": "Safe alias",
            "__proto__": "ignored",
            "constructor": "ignored"
          }`)
        },
        usageStatsByItemId: {
          updatedAt: 1,
          updatedBy: "device-1",
          value: JSON.parse(`{
            "directoryRole:safe:/": {"activationCount": 2},
            "prototype": {"activationCount": 99}
          }`)
        },
        bundles: {
          updatedAt: Number.MAX_VALUE,
          updatedBy: "device-1",
          value: []
        }
      }
    });

    expect(snapshot?.categories.aliasesByItemId?.value).toEqual({
      "directoryRole:safe:/": "Safe alias"
    });
    expect(snapshot?.categories.preferences?.value).toEqual({ darkMode: true });
    expect(snapshot?.categories.usageStatsByItemId?.value).toEqual({
      "directoryRole:safe:/": { activationCount: 2, legacyActivationCount: 2 }
    });
    expect(snapshot?.categories.bundles).toBeUndefined();
  });

  test("keeps a stable generated installation ID and exposes a readable short form", async () => {
    const local = new MemoryStorage();
    const first = await getBrowserSyncInstallationIdentity({ local, distribution: chromeStore, platform: "Windows" });
    const second = await getBrowserSyncInstallationIdentity({ local, distribution: chromeStore, platform: "Windows" });

    expect(second).toEqual(first);
    expect(first.installationId).toHaveLength(36);
    expect(formatBrowserSyncInstallationId(first.installationId)).toMatch(/^QP-[A-Z0-9]{8}$/);
  });

  test("supports only the matching official Chrome and Edge editions", () => {
    expect(getBrowserSyncCapability(chromeStore, true)).toMatchObject({ supported: true, ecosystemLabel: "Chrome Sync" });
    expect(getBrowserSyncCapability(edgeStore, true)).toMatchObject({ supported: true, ecosystemLabel: "Microsoft Edge Sync" });
    expect(getBrowserSyncCapability(classifyExtensionDistribution({
      userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      extensionId: "local-build",
      installType: "development"
    }), true)).toMatchObject({ supported: false, capability: "limited" });
    expect(getBrowserSyncCapability(chromeStore, false)).toMatchObject({ supported: false, capability: "unavailable" });
  });

  test("syncs portable settings and activity while keeping each cloud item bounded", async () => {
    const sync = new MemoryStorage();
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.aliasesByItemId["directoryRole:one"] = "Daily admin";
    firstSettings.savedJustifications = ["Needed for change CHG001."];
    firstSettings.activityHistory = [{
      id: "activity-one",
      action: "activate",
      result: "success",
      itemId: "directoryRole:one",
      itemName: "Role one",
      itemType: "directoryRole",
      requestedAt: "2026-08-10T08:00:00.000Z"
    }];
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: firstSettings });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });

    expect(sync.accessLevel).toBe("TRUSTED_CONTEXTS");
    for (const [key, value] of Object.entries(sync.data)) {
      expect(new TextEncoder().encode(key + JSON.stringify(value)).length).toBeLessThan(8_192);
    }

    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });
    const restored = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as typeof firstSettings;
    expect(restored.aliasesByItemId).toEqual(firstSettings.aliasesByItemId);
    expect(restored.savedJustifications).toEqual(firstSettings.savedJustifications);
    expect(restored.activityHistory).toHaveLength(1);

    const status = await getBrowserSyncStatus({ local: secondLocal, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });
    expect(status.devices).toHaveLength(2);
    expect(status.devices.map((device) => device.platform).sort()).toEqual(["Windows", "macOS"]);
  });

  test("removes only the prior committed chunk generation and preserves a concurrent upload", async () => {
    const sync = new MemoryStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    const firstGeneration = (sync.data[BROWSER_SYNC_MANIFEST_KEY] as { generation: string }).generation;
    const concurrentChunkKey = "quickPimSync.chunk.v1.concurrent-upload.0";
    sync.data[concurrentChunkKey] = "pending";

    const edited = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    edited.aliasesByItemId["directoryRole:one"] = "Updated name";
    await local.set({ [SETTINGS_KEY]: edited });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });

    expect(Object.keys(sync.data).some((key) => key.startsWith(`quickPimSync.chunk.v1.${firstGeneration}.`))).toBe(false);
    expect(sync.data[concurrentChunkKey]).toBe("pending");
    const currentGeneration = (sync.data[BROWSER_SYNC_MANIFEST_KEY] as { generation: string }).generation;
    expect(Object.keys(sync.data).some((key) => key.startsWith(`quickPimSync.chunk.v1.${currentGeneration}.`))).toBe(true);
  });

  test("removes stale orphaned sync chunks without touching a fresh concurrent upload", async () => {
    const sync = new MemoryStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const initialNow = 1_000_000;
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: initialNow, platform: "Windows" });

    const staleGeneration = `${(initialNow - 5 * 60_000 - 1).toString(36)}-stale-upload`;
    const freshGeneration = `${(initialNow - 60_000).toString(36)}-fresh-upload`;
    const staleKey = `quickPimSync.chunk.v1.${staleGeneration}.0`;
    const freshKey = `quickPimSync.chunk.v1.${freshGeneration}.0`;
    sync.data[staleKey] = "stale";
    sync.data[freshKey] = "fresh";

    const edited = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    edited.aliasesByItemId["directoryRole:one"] = "Updated name";
    await local.set({ [SETTINGS_KEY]: edited });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: initialNow + 1, platform: "Windows" });

    expect(sync.data).not.toHaveProperty(staleKey);
    expect(sync.data[freshKey]).toBe("fresh");
  });

  test("merges concurrent activity as events and usage as per-installation counters", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });
    const firstIdentity = await getBrowserSyncInstallationIdentity({ local: firstLocal, distribution: chromeStore, platform: "Windows" });
    const secondIdentity = await getBrowserSyncInstallationIdentity({ local: secondLocal, distribution: chromeStore, platform: "macOS" });
    const item: ActivationItem = {
      id: "directoryRole:one:/",
      type: "directoryRole",
      principalId: "principal",
      status: "eligible",
      displayName: "Role one",
      sourceName: "Role one",
      scopeLabel: "Tenant",
      roleDefinitionId: "one",
      directoryScopeId: "/"
    };
    const record = (
      settings: QuickPimSettings,
      operationId: string,
      completedAt: string,
      source: typeof firstIdentity
    ) => recordOperationActivity(settings, {
      operationId,
      action: "activate",
      items: [item],
      response: {
        success: true,
        results: [{ itemId: item.id, itemName: item.displayName, success: true, requestId: operationId }],
        errors: []
      },
      requestedAt: completedAt,
      completedAt,
      durationHours: 1,
      source
    });

    const firstSettings = record(
      (await firstLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings,
      "operation-first",
      "2026-08-10T10:00:00.000Z",
      firstIdentity
    );
    const secondSettings = record(
      (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings,
      "operation-second",
      "2026-08-10T10:00:01.000Z",
      secondIdentity
    );
    await firstLocal.set({ [SETTINGS_KEY]: firstSettings });
    await secondLocal.set({ [SETTINGS_KEY]: secondSettings });

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 3_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 4_000, platform: "macOS" });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 5_000, platform: "Windows" });

    const thirdLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: thirdLocal, sync, distribution: chromeStore, now: 6_000, platform: "Linux" });
    const merged = (await thirdLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.activityHistory.map((entry) => entry.id).sort()).toEqual([
      `operation-first:activate:${item.id}:success`,
      `operation-second:activate:${item.id}:success`
    ]);
    expect(merged.usageStatsByItemId[item.id]).toMatchObject({
      activationCount: 2,
      byInstallationId: {
        [firstIdentity.installationId]: { activationCount: 1 },
        [secondIdentity.installationId]: { activationCount: 1 }
      }
    });
  });

  test("lets a user rename another installation by its stable ID", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });
    const firstStatus = await getBrowserSyncStatus({ local: firstLocal, sync, distribution: edgeStore, now: 3_000, platform: "Windows" });
    const second = firstStatus.devices.find((device) => device.platform === "macOS");
    expect(second).toBeDefined();

    await renameBrowserSyncDevice(
      { local: firstLocal, sync, distribution: edgeStore, now: 4_000, platform: "Windows" },
      second!.installationId,
      "Admin MacBook"
    );
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 5_000, platform: "macOS" });
    const secondIdentity = await getBrowserSyncInstallationIdentity({ local: secondLocal, distribution: edgeStore, platform: "macOS" });
    expect(secondIdentity.deviceName).toBe("Admin MacBook");
  });

  test("does not write a remote rename while sync is disabled locally", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });
    const firstStatus = await getBrowserSyncStatus({ local: firstLocal, sync, distribution: edgeStore, now: 3_000, platform: "Windows" });
    const second = firstStatus.devices.find((device) => device.platform === "macOS")!;
    await setBrowserSyncEnabled({ local: firstLocal, sync, distribution: edgeStore, now: 4_000, platform: "Windows" }, false);

    await expect(renameBrowserSyncDevice(
      { local: firstLocal, sync, distribution: edgeStore, now: 5_000, platform: "Windows" },
      second.installationId,
      "Should not be written"
    )).rejects.toThrow(/enable browser sync/i);

    const unchanged = await getBrowserSyncStatus({ local: secondLocal, sync, distribution: edgeStore, now: 6_000, platform: "macOS" });
    expect(unchanged.devices.find((device) => device.installationId === second.installationId)?.name).toBe(second.name);
  });

  test("purges cloud data, pauses this installation, and prevents another installation from recreating it", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: { ...structuredClone(DEFAULT_SETTINGS), savedJustifications: ["Specific reason"] } });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });

    const purged = await purgeBrowserSyncData({ local: secondLocal, sync, distribution: edgeStore, now: 3_000, platform: "macOS" });
    expect(purged.enabled).toBe(false);
    expect(Object.keys(sync.data).filter((key) => key.startsWith(BROWSER_SYNC_KEY_PREFIX))).toEqual([BROWSER_SYNC_CONTROL_KEY]);

    const firstAfterPurge = await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 4_000, platform: "Windows" });
    expect(firstAfterPurge.enabled).toBe(false);
    expect(firstAfterPurge.suspendedByPurge).toBe(false);
    expect(Object.keys(sync.data).filter((key) => key.startsWith(BROWSER_SYNC_KEY_PREFIX))).toEqual([BROWSER_SYNC_CONTROL_KEY]);
  });

  test("does not restore a stale snapshot committed by a writer that started before a purge", async () => {
    const sync = new MemoryStorage();
    const staleSettings = structuredClone(DEFAULT_SETTINGS);
    staleSettings.savedJustifications = ["Old synced value"];
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: staleSettings });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    const staleCloudData = structuredClone(sync.data);

    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });
    await purgeBrowserSyncData({ local: secondLocal, sync, distribution: edgeStore, now: 3_000, platform: "macOS" });
    await secondLocal.set({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await setBrowserSyncEnabled({ local: secondLocal, sync, distribution: edgeStore, now: 4_000, platform: "macOS" }, true);

    for (const [key, value] of Object.entries(staleCloudData)) {
      if (key !== BROWSER_SYNC_CONTROL_KEY && key.startsWith(BROWSER_SYNC_KEY_PREFIX)) sync.data[key] = value;
    }
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 5_000, platform: "macOS" });

    const restored = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(restored.savedJustifications).toEqual([]);
    const manifest = sync.data[BROWSER_SYNC_MANIFEST_KEY] as { epochAt?: number };
    expect(manifest.epochAt).toBeGreaterThan(3_000);
  });

  test("bounds stored installation records to the newest twenty devices", async () => {
    const sync = new MemoryStorage();
    for (let index = 0; index < 21; index += 1) {
      const installationId = `device-${index.toString().padStart(2, "0")}`;
      sync.data[`quickPimSync.device.v1.${installationId}`] = {
        installationId,
        name: `Device ${index}`,
        browser: "Google Chrome",
        platform: "Windows",
        appVersion: "2.16.4",
        lastSyncAt: index + 1,
        syncEnabled: true,
        nameUpdatedAt: index + 1
      };
    }
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 10_000, platform: "macOS" });

    expect(Object.keys(sync.data).filter((key) => key.startsWith("quickPimSync.device.v1."))).toHaveLength(20);
    const status = await getBrowserSyncStatus({ local, sync, distribution: chromeStore, now: 10_001, platform: "macOS" });
    expect(status.devices).toHaveLength(20);
    expect(status.devices.some((device) => device.platform === "macOS")).toBe(true);
  });

  test("ignores synchronized device timestamps outside the valid JavaScript date range", async () => {
    const sync = new MemoryStorage({
      "quickPimSync.device.v1.invalid-date-device": {
        installationId: "invalid-date-device",
        name: "Invalid date device",
        browser: "Google Chrome",
        platform: "Windows",
        appVersion: "2.16.4",
        lastSyncAt: Number.MAX_VALUE,
        syncEnabled: true,
        nameUpdatedAt: Number.MAX_VALUE
      }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    const status = await getBrowserSyncStatus({ local, sync, distribution: chromeStore, now: 1_000, platform: "macOS" });

    expect(status.devices).toEqual([]);
  });

  test("does not remove a device registered while stale device cleanup is running", async () => {
    const sync = new ConcurrentDeviceStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });

    expect(sync.data).toHaveProperty("quickPimSync.device.v1.concurrent-device");
  });

  test("lets a newer local edit win even when this computer clock is behind the cloud revision", async () => {
    const sync = new MemoryStorage();
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.aliasesByItemId["directoryRole:one"] = "Cloud value";
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: firstSettings });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 1_000_000, platform: "Windows" });

    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 100, platform: "macOS" });
    const edited = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as typeof firstSettings;
    edited.aliasesByItemId["directoryRole:one"] = "New local value";
    await secondLocal.set({ [SETTINGS_KEY]: edited });

    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 200, platform: "macOS" });
    const thirdLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: thirdLocal, sync, distribution: chromeStore, now: 300, platform: "Linux" });
    const restored = (await thirdLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as typeof firstSettings;
    expect(restored.aliasesByItemId["directoryRole:one"]).toBe("New local value");
  });

  test("does not overwrite a settings edit made while a sync pass is applying remote data", async () => {
    const sync = new MemoryStorage();
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.aliasesByItemId["directoryRole:one"] = "Cloud value";
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: firstSettings });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });

    const secondLocal = new BlockingSettingsStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const blockedWrite = secondLocal.armSettingsWriteBlock();
    const syncing = synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });
    await blockedWrite.started;

    const editing = mutateSettingsInStorage(secondLocal, (current) => ({
      ...current,
      preferences: { ...current.preferences, darkMode: true }
    }));
    await Promise.resolve();
    blockedWrite.release();
    await Promise.all([syncing, editing]);

    const restored = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(restored.aliasesByItemId["directoryRole:one"]).toBe("Cloud value");
    expect(restored.preferences.darkMode).toBe(true);
  });

  test("does not let an in-flight sync re-enable browser sync after the user disables it", async () => {
    const sync = new BlockingManifestStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });

    const blockedRead = sync.armManifestReadBlock();
    const syncing = synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });
    await blockedRead.started;
    const disabling = setBrowserSyncEnabled(
      { local, sync, distribution: chromeStore, now: 2_001, platform: "Windows" },
      false
    );
    await Promise.resolve();
    blockedRead.release();
    await Promise.all([syncing, disabling]);

    const status = await getBrowserSyncStatus({ local, sync, distribution: chromeStore, now: 2_002, platform: "Windows" });
    expect(status.enabled).toBe(false);
  });

  test("shows unsupported-install reminders at most once per day and allows permanent dismissal", async () => {
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const sync = new MemoryStorage();
    const development = classifyExtensionDistribution({
      userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      extensionId: "local-build",
      installType: "development"
    });
    expect((await getBrowserSyncStatus({ local, sync, distribution: development, now: 1_000, platform: "Windows" })).reminderDue).toBe(true);
    await markBrowserSyncReminderShown({ local, sync, distribution: development, now: 1_000, platform: "Windows" });
    expect((await getBrowserSyncStatus({ local, sync, distribution: development, now: 1_001, platform: "Windows" })).reminderDue).toBe(false);
    await dismissBrowserSyncReminder({ local, sync, distribution: development, now: 1_000, platform: "Windows" }, "daily");
    expect((await getBrowserSyncStatus({ local, sync, distribution: development, now: 2_000, platform: "Windows" })).reminderDue).toBe(false);
    expect((await getBrowserSyncStatus({ local, sync, distribution: development, now: 1_000 + BROWSER_SYNC_REMINDER_INTERVAL_MS, platform: "Windows" })).reminderDue).toBe(true);
    await dismissBrowserSyncReminder({ local, sync, distribution: development, now: 2_000, platform: "Windows" }, "never");
    expect((await getBrowserSyncStatus({ local, sync, distribution: development, now: 2_000 + BROWSER_SYNC_REMINDER_INTERVAL_MS * 2, platform: "Windows" })).reminderDue).toBe(false);
  });
});
