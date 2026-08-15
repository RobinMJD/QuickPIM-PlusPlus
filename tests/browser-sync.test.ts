import { describe, expect, test } from "vitest";
import {
  BROWSER_SYNC_CONTROL_KEY,
  BROWSER_SYNC_DEVICES_KEY,
  BROWSER_SYNC_EPOCH_KEY,
  BROWSER_SYNC_KEY_PREFIX,
  BROWSER_SYNC_LOCAL_STATE_KEY,
  BROWSER_SYNC_MANIFEST_KEY,
  BROWSER_SYNC_PENDING_PURGE_KEY,
  BROWSER_SYNC_PURGE_KEY,
  BROWSER_SYNC_REMINDER_INTERVAL_MS,
  BROWSER_SYNC_VERIFICATION_FRESHNESS_MS,
  dismissBrowserSyncReminder,
  formatBrowserSyncInstallationId,
  getBrowserSyncCapability,
  getBrowserSyncInstallationIdentity,
  getBrowserSyncStatus,
  isBrowserSyncDeviceStorageKey,
  isBrowserSyncPayloadStorageKey,
  markBrowserSyncReminderShown,
  purgeBrowserSyncData,
  queueBrowserSyncPurgeRetry,
  renameBrowserSyncDevice,
  sanitizeBrowserSyncSnapshot,
  setBrowserSyncEnabled,
  synchronizeBrowserData,
  updateBrowserSyncDeviceName
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

class CountingStorage extends MemoryStorage {
  deviceWrites = 0;

  override async set(items: Record<string, unknown>): Promise<void> {
    if (Object.keys(items).some((key) => key.startsWith("quickPimSync.device.v1."))) {
      this.deviceWrites += 1;
    }
    await super.set(items);
  }
}

class WriteCountingStorage extends MemoryStorage {
  writes = 0;

  override async set(items: Record<string, unknown>): Promise<void> {
    this.writes += 1;
    await super.set(items);
  }
}

class QuotaStorage extends MemoryStorage {
  maxBytesInUse = 0;

  override async set(items: Record<string, unknown>): Promise<void> {
    const next = { ...this.data, ...structuredClone(items) };
    const itemSizes = Object.entries(next).map(([key, value]) =>
      new TextEncoder().encode(key + JSON.stringify(value)).length
    );
    if (itemSizes.some((size) => size > 8_192)) throw new Error("QUOTA_BYTES_PER_ITEM exceeded");
    const total = itemSizes.reduce((sum, size) => sum + size, 0);
    if (total > 102_400) throw new Error("QUOTA_BYTES exceeded");
    this.maxBytesInUse = Math.max(this.maxBytesInUse, total);
    await super.set(items);
  }
}

class FailingReadStorage extends MemoryStorage {
  override async get(): Promise<Record<string, unknown>> {
    throw new Error("Browser sync backend is temporarily unavailable.");
  }
}

class ToggleFailingStorage extends MemoryStorage {
  failReads = false;
  failDeviceWrites = false;

  override async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (this.failReads) throw new Error("Browser sync backend is temporarily unavailable.");
    return super.get(keys);
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    if (this.failDeviceWrites && Object.keys(items).some((key) => key.startsWith("quickPimSync.device.v1."))) {
      throw new Error("Browser sync backend is temporarily unavailable.");
    }
    return super.set(items);
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
        appVersion: "2.17.0",
        lastSyncAt: 1_001,
        syncEnabled: true,
        nameUpdatedAt: 1_001
      };
    }
    return snapshot;
  }
}

class DelayedChunkStorage extends MemoryStorage {
  private delayed?: { key: string; value: unknown };
  private chunkReadCount = 0;

  delayOneCommittedChunk(): void {
    const key = Object.keys(this.data).find((candidate) => candidate.startsWith("quickPimSync.chunk.v1."));
    if (!key) throw new Error("No committed sync chunk is available to delay.");
    this.delayed = { key, value: structuredClone(this.data[key]) };
    delete this.data[key];
  }

  override async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (Array.isArray(keys) && this.delayed && keys.includes(this.delayed.key)) {
      this.chunkReadCount += 1;
      if (this.chunkReadCount >= 2) {
        this.data[this.delayed.key] = this.delayed.value;
        this.delayed = undefined;
      }
    }
    return super.get(keys);
  }
}

class CoordinationRaceStorage extends MemoryStorage {
  private nextMarker?: Record<string, unknown>;

  injectAfterNextSnapshot(marker: Record<string, unknown>): void {
    this.nextMarker = marker;
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    await super.set(items);
    if (this.nextMarker && Object.hasOwn(items, BROWSER_SYNC_MANIFEST_KEY)) {
      Object.assign(this.data, structuredClone(this.nextMarker));
      this.nextMarker = undefined;
    }
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
  test("classifies every browser-sync coordination key for background reconciliation", () => {
    expect(isBrowserSyncPayloadStorageKey(BROWSER_SYNC_CONTROL_KEY)).toBe(true);
    expect(isBrowserSyncPayloadStorageKey(BROWSER_SYNC_PURGE_KEY)).toBe(true);
    expect(isBrowserSyncPayloadStorageKey(BROWSER_SYNC_EPOCH_KEY)).toBe(true);
    expect(isBrowserSyncPayloadStorageKey(BROWSER_SYNC_MANIFEST_KEY)).toBe(true);
    expect(isBrowserSyncPayloadStorageKey("quickPimSync.chunk.v1.generation.0")).toBe(true);
    expect(isBrowserSyncPayloadStorageKey("quickPimSync.device.v1.installation-1")).toBe(false);
    expect(isBrowserSyncDeviceStorageKey("quickPimSync.device.v1.installation-1")).toBe(true);
    expect(isBrowserSyncDeviceStorageKey(BROWSER_SYNC_DEVICES_KEY)).toBe(true);
  });

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

  test("reads an existing local installation identity without waiting for an in-flight cloud sync", async () => {
    const sync = new BlockingManifestStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const expected = await getBrowserSyncInstallationIdentity({ local, distribution: chromeStore, platform: "Windows" });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    const blockedRead = sync.armManifestReadBlock();
    const syncing = synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });
    await blockedRead.started;

    const identity = await getBrowserSyncInstallationIdentity({ local, distribution: chromeStore, platform: "Windows" });

    expect(identity).toEqual(expected);
    blockedRead.release();
    await syncing;
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
    const firstStatus = await getBrowserSyncStatus({ local: firstLocal, sync, distribution: chromeStore, now: 1_001, platform: "Windows" });
    expect(firstStatus).toMatchObject({ crossDeviceState: "waiting", otherInstallationCount: 0 });

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
    expect(status).toMatchObject({
      crossDeviceState: "verified",
      otherInstallationCount: 1,
      lastOtherInstallationSyncAt: 1_000
    });
  });

  test("keeps escaped payloads within the real browser sync item and total quotas", async () => {
    const sync = new QuotaStorage();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.preferences.activityHistoryLimit = 100;
    settings.activityHistory = Array.from({ length: 100 }, (_, index) => ({
      id: `quota-activity-${index}`,
      action: "activate" as const,
      result: "success" as const,
      itemId: `directoryRole:quota-${index}:/`,
      itemName: `Quota role ${index}`,
      itemType: "directoryRole" as const,
      requestedAt: new Date(Date.UTC(2026, 7, 10, 8, 0, index)).toISOString(),
      justification: `Change CHG${index} requires ${"\\\"".repeat(220)}`
    }));
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    let status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    expect(status.lastError).toBeUndefined();

    await mutateSettingsInStorage(local, (current) => ({
      ...current,
      aliasesByItemId: { ...current.aliasesByItemId, "directoryRole:quota:/": "Quota-safe update" }
    }));
    status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });

    expect(status.lastError).toBeUndefined();
    expect(sync.maxBytesInUse).toBeLessThanOrEqual(102_400);
    for (const [key, value] of Object.entries(sync.data)) {
      expect(new TextEncoder().encode(key + JSON.stringify(value)).length).toBeLessThanOrEqual(8_192);
    }
  });

  test("removes only aged superseded generations before a reconciliation write", async () => {
    const sync = new QuotaStorage();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.activityHistory = Array.from({ length: 100 }, (_, index) => ({
      id: `orphan-activity-${index}`,
      action: "activate" as const,
      result: "success" as const,
      itemId: `directoryRole:orphan-${index}:/`,
      itemName: `Orphan pressure role ${index}`,
      itemType: "directoryRole" as const,
      requestedAt: new Date(Date.UTC(2026, 7, 10, 9, 0, index)).toISOString(),
      justification: `Concurrent change ${index}: ${"x".repeat(240)}`
    }));
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });

    const manifest = sync.data[BROWSER_SYNC_MANIFEST_KEY] as { generation: string };
    const currentPrefix = `quickPimSync.chunk.v1.${manifest.generation}.`;
    const reconciliationNow = 200_000_000;
    const orphanGeneration = `${(reconciliationNow - 48 * 60 * 60_000 - 1).toString(36)}-a1-orphan-device`;
    const orphanChunks = Object.fromEntries(Object.entries(sync.data).flatMap(([key, value]) =>
      key.startsWith(currentPrefix)
        ? [[key.replace(manifest.generation, orphanGeneration), value] as const]
        : []
    ));
    await sync.set(orphanChunks);

    await mutateSettingsInStorage(local, (current) => ({
      ...current,
      aliasesByItemId: { ...current.aliasesByItemId, "directoryRole:orphan:/": "Reconciled" }
    }));
    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: reconciliationNow, platform: "Windows" });

    expect(status.lastError).toBeUndefined();
    expect(Object.keys(sync.data).some((key) => key.includes(orphanGeneration))).toBe(false);
  });

  test("rejects unsupported snapshot versions before they can replace local data", () => {
    expect(sanitizeBrowserSyncSnapshot({ version: 2, categories: {} })).toBeUndefined();
  });

  test("fails closed on unsupported cloud control versions", async () => {
    const sync = new MemoryStorage({
      [BROWSER_SYNC_CONTROL_KEY]: { version: 2, purgedAt: 1_500, epochAt: 0 }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    const status = await getBrowserSyncStatus({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });
    const synchronized = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_001, platform: "Windows" });

    expect(status.suspendedByPurge).toBe(false);
    expect(status.enabled).toBe(true);
    expect(status.lastError).toMatch(/control metadata.*unsupported version/i);
    expect(synchronized.lastError).toMatch(/control metadata.*unsupported version/i);
    expect(sync.data[BROWSER_SYNC_MANIFEST_KEY]).toBeUndefined();
  });

  test("fails closed on cloud control timestamps beyond the clock-skew window", async () => {
    const now = 2_000;
    const sync = new MemoryStorage({
      [BROWSER_SYNC_CONTROL_KEY]: { version: 1, purgedAt: now + 24 * 60 * 60 * 1000 + 1, epochAt: 0 }
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId["directoryRole:local:/"] = "Keep this alias";
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now, platform: "Windows" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status.lastError).toMatch(/control metadata contains an invalid timestamp/i);
    expect(sync.data[BROWSER_SYNC_MANIFEST_KEY]).toBeUndefined();
    expect(preserved.aliasesByItemId["directoryRole:local:/"]).toBe("Keep this alias");
  });

  test.each([
    [BROWSER_SYNC_PURGE_KEY, { version: 2, purgedAt: 1_500 }, /purge metadata.*unsupported version/i],
    [BROWSER_SYNC_EPOCH_KEY, { version: 1, epochAt: -1 }, /resume metadata contains an invalid timestamp/i]
  ])("fails closed on malformed split coordination metadata in %s", async (key, marker, expectedError) => {
    const sync = new MemoryStorage({ [key]: marker });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId["directoryRole:local:/"] = "Keep this alias";
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status.lastError).toMatch(expectedError);
    expect(sync.data[BROWSER_SYNC_MANIFEST_KEY]).toBeUndefined();
    expect(preserved.aliasesByItemId["directoryRole:local:/"]).toBe("Keep this alias");
  });

  test("retries a committed generation when browser sync delivers its chunks after the manifest", async () => {
    const sync = new DelayedChunkStorage();
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.aliasesByItemId["directoryRole:one:/"] = "Delivered after retry";
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: firstSettings });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    sync.delayOneCommittedChunk();

    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const status = await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });
    const restored = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status.lastError).toBeUndefined();
    expect(restored.aliasesByItemId["directoryRole:one:/"]).toBe("Delivered after retry");
  });

  test("does not overwrite local data when cloud metadata is malformed", async () => {
    const malformedManifest = {
      version: 1,
      generation: "invalid",
      chunkCount: 999,
      byteLength: 1,
      hash: "bad",
      updatedAt: 1_000,
      updatedBy: "remote-device"
    };
    const sync = new MemoryStorage({ [BROWSER_SYNC_MANIFEST_KEY]: malformedManifest });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId["directoryRole:local:/"] = "Keep this local alias";
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status.lastError).toMatch(/metadata is invalid/i);
    expect(preserved.aliasesByItemId["directoryRole:local:/"]).toBe("Keep this local alias");
    expect(sync.data[BROWSER_SYNC_MANIFEST_KEY]).toEqual(malformedManifest);
  });

  test("rejects a manifest epoch beyond the clock-skew window", async () => {
    const sync = new MemoryStorage();
    const seed = structuredClone(DEFAULT_SETTINGS);
    seed.aliasesByItemId["directoryRole:cloud:/"] = "Cloud alias";
    await synchronizeBrowserData({
      local: new MemoryStorage({ [SETTINGS_KEY]: seed }),
      sync,
      distribution: chromeStore,
      now: 1_000,
      platform: "Windows"
    });
    const manifest = sync.data[BROWSER_SYNC_MANIFEST_KEY] as Record<string, unknown>;
    manifest.epochAt = 2_000 + 24 * 60 * 60 * 1000 + 1;

    const localSettings = structuredClone(DEFAULT_SETTINGS);
    localSettings.aliasesByItemId["directoryRole:local:/"] = "Keep local";
    const local = new MemoryStorage({ [SETTINGS_KEY]: localSettings });
    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status.lastError).toMatch(/metadata is invalid/i);
    expect(preserved.aliasesByItemId).toEqual({ "directoryRole:local:/": "Keep local" });
  });

  test("keeps status and local data available when browser sync reads fail", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId["directoryRole:local:/"] = "Local alias survives";
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });
    const sync = new FailingReadStorage();

    const status = await synchronizeBrowserData({
      local,
      sync,
      distribution: chromeStore,
      now: 2_000,
      platform: "Windows"
    });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status).toMatchObject({ supported: true, enabled: true, crossDeviceState: "waiting" });
    expect(status.lastError).toMatch(/temporarily unavailable/i);
    expect(preserved.aliasesByItemId["directoryRole:local:/"]).toBe("Local alias survives");
  });

  test("merges unrelated concurrent edits without restoring a deletion", async () => {
    const sync = new MemoryStorage();
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.aliasesByItemId["directoryRole:shared:/"] = "Shared alias";
    firstSettings.favoriteItemIds = ["directoryRole:shared:/"];
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: firstSettings });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 10_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 11_000, platform: "macOS" });

    await mutateSettingsInStorage(firstLocal, (settings) => ({
      ...settings,
      aliasesByItemId: {
        ...settings.aliasesByItemId,
        "directoryRole:first:/": "First computer"
      },
      favoriteItemIds: [...settings.favoriteItemIds, "directoryRole:first:/"]
    }));
    await mutateSettingsInStorage(secondLocal, (settings) => ({
      ...settings,
      aliasesByItemId: {
        ...settings.aliasesByItemId,
        "directoryRole:second:/": "Second computer"
      },
      favoriteItemIds: [...settings.favoriteItemIds, "directoryRole:second:/"]
    }));
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 12_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 13_000, platform: "macOS" });

    let merged = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.aliasesByItemId).toMatchObject({
      "directoryRole:shared:/": "Shared alias",
      "directoryRole:first:/": "First computer",
      "directoryRole:second:/": "Second computer"
    });
    expect(new Set(merged.favoriteItemIds)).toEqual(new Set([
      "directoryRole:shared:/",
      "directoryRole:first:/",
      "directoryRole:second:/"
    ]));

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 14_000, platform: "Windows" });
    await mutateSettingsInStorage(firstLocal, (settings) => {
      const aliasesByItemId = { ...settings.aliasesByItemId };
      delete aliasesByItemId["directoryRole:shared:/"];
      return { ...settings, aliasesByItemId };
    });
    await mutateSettingsInStorage(secondLocal, (settings) => ({
      ...settings,
      aliasesByItemId: {
        ...settings.aliasesByItemId,
        "directoryRole:third:/": "Another local edit"
      }
    }));
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 15_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 16_000, platform: "macOS" });

    merged = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.aliasesByItemId).not.toHaveProperty("directoryRole:shared:/");
    expect(merged.aliasesByItemId).toHaveProperty("directoryRole:third:/", "Another local edit");
  });

  test("does not acknowledge a write until it is read back, preserving an edit hidden by a concurrent writer", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 10_000, platform: "Windows" });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 10_001, platform: "Windows" });

    // Prepare the cloud generation a second installation would have produced
    // after reading the same baseline, but before seeing the first edit.
    const staleCloud = new MemoryStorage(structuredClone(sync.data));
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: secondLocal, sync: staleCloud, distribution: chromeStore, now: 10_002, platform: "macOS" });
    await mutateSettingsInStorage(secondLocal, (settings) => ({
      ...settings,
      aliasesByItemId: { ...settings.aliasesByItemId, "directoryRole:second:/": "Second edit" }
    }));
    await synchronizeBrowserData({ local: secondLocal, sync: staleCloud, distribution: chromeStore, now: 10_003, platform: "macOS" });

    await mutateSettingsInStorage(firstLocal, (settings) => ({
      ...settings,
      aliasesByItemId: { ...settings.aliasesByItemId, "directoryRole:first:/": "First edit" }
    }));
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 10_004, platform: "Windows" });

    // Simulate the second installation winning the manifest race with its
    // stale-baseline generation.
    for (const key of Object.keys(sync.data)) {
      if (key === BROWSER_SYNC_MANIFEST_KEY || key.startsWith("quickPimSync.chunk.v1.")) delete sync.data[key];
    }
    for (const [key, value] of Object.entries(staleCloud.data)) {
      if (key === BROWSER_SYNC_MANIFEST_KEY || key.startsWith("quickPimSync.chunk.v1.")) {
        sync.data[key] = structuredClone(value);
      }
    }

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 10_005, platform: "Windows" });
    const merged = (await firstLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.aliasesByItemId).toMatchObject({
      "directoryRole:first:/": "First edit",
      "directoryRole:second:/": "Second edit"
    });
  });

  test("merges concurrent enabled-tab changes independently", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 10_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 11_000, platform: "macOS" });

    await mutateSettingsInStorage(firstLocal, (settings) => ({
      ...settings,
      preferences: {
        ...settings.preferences,
        enabledFeatures: settings.preferences.enabledFeatures.filter((feature) => feature !== "azureRole")
      }
    }));
    await mutateSettingsInStorage(secondLocal, (settings) => ({
      ...settings,
      preferences: {
        ...settings.preferences,
        enabledFeatures: settings.preferences.enabledFeatures.filter((feature) => feature !== "pimGroup")
      }
    }));
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 12_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 13_000, platform: "macOS" });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 14_000, platform: "Windows" });

    const merged = (await firstLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.preferences.enabledFeatures).toContain("directoryRole");
    expect(merged.preferences.enabledFeatures).toContain("bundles");
    expect(merged.preferences.enabledFeatures).not.toContain("pimGroup");
    expect(merged.preferences.enabledFeatures).not.toContain("azureRole");
  });

  test("merges disjoint edits from two fresh installations on their first sync", async () => {
    const sync = new MemoryStorage();
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.aliasesByItemId["directoryRole:first:/"] = "First computer";
    const secondSettings = structuredClone(DEFAULT_SETTINGS);
    secondSettings.aliasesByItemId["directoryRole:second:/"] = "Second computer";
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: firstSettings });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: secondSettings });

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 20_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 21_000, platform: "macOS" });

    const merged = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.aliasesByItemId).toEqual({
      "directoryRole:first:/": "First computer",
      "directoryRole:second:/": "Second computer"
    });
  });

  test("merges concurrent edits to different fields of the same bundle", async () => {
    const sync = new MemoryStorage();
    const baseline = structuredClone(DEFAULT_SETTINGS);
    baseline.bundles = [{
      id: "daily-admin",
      name: "Daily admin",
      itemIds: ["directoryRole:one:/"],
      defaultDurationHours: 1,
      defaultJustification: "Needed for the daily administration task."
    }];
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: baseline });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 30_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 31_000, platform: "macOS" });

    await mutateSettingsInStorage(firstLocal, (settings) => ({
      ...settings,
      bundles: [{
        ...settings.bundles[0]!,
        name: "Renamed daily admin",
        itemIds: [...settings.bundles[0]!.itemIds, "directoryRole:two:/"]
      }]
    }));
    await mutateSettingsInStorage(secondLocal, (settings) => ({
      ...settings,
      bundles: [{
        ...settings.bundles[0]!,
        defaultDurationHours: 2,
        itemIds: [...settings.bundles[0]!.itemIds, "pimGroup:group-three:member"]
      }]
    }));

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 32_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 33_000, platform: "macOS" });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 34_000, platform: "Windows" });

    const merged = (await firstLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.bundles[0]).toMatchObject({
      name: "Renamed daily admin",
      defaultDurationHours: 2
    });
    expect(new Set(merged.bundles[0]!.itemIds)).toEqual(new Set([
      "directoryRole:one:/",
      "directoryRole:two:/",
      "pimGroup:group-three:member"
    ]));
  });

  test("requires a recent enabled peer before reporting cross-device sync as verified", async () => {
    const now = 1_000_000_000;
    const remoteKey = "quickPimSync.device.v1.remote-device";
    const sync = new MemoryStorage({
      [remoteKey]: {
        installationId: "remote-device",
        name: "Work laptop",
        browser: "Microsoft Edge",
        platform: "Windows",
        appVersion: "2.17.0",
        lastSyncAt: now - 1_000,
        syncEnabled: false,
        nameUpdatedAt: now - 1_000
      }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    const disabled = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now, platform: "macOS" });
    expect(disabled).toMatchObject({
      crossDeviceState: "waiting",
      otherInstallationCount: 0,
      lastOtherInstallationSyncAt: now - 1_000
    });

    (sync.data[remoteKey] as { syncEnabled: boolean; lastSyncAt: number }).syncEnabled = true;
    (sync.data[remoteKey] as { syncEnabled: boolean; lastSyncAt: number }).lastSyncAt = now - BROWSER_SYNC_VERIFICATION_FRESHNESS_MS - 1;
    const stale = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now, platform: "macOS" });
    expect(stale).toMatchObject({ crossDeviceState: "waiting", otherInstallationCount: 0 });

    (sync.data[remoteKey] as { lastSyncAt: number }).lastSyncAt = now - 1;
    const current = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now, platform: "macOS" });
    expect(current).toMatchObject({ crossDeviceState: "verified", otherInstallationCount: 1 });

    (sync.data[remoteKey] as { lastSyncAt: number }).lastSyncAt = now + 5 * 60_000 + 1;
    const future = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now, platform: "macOS" });
    expect(future).toMatchObject({ crossDeviceState: "waiting", otherInstallationCount: 0 });
  });

  test("retains the newest activity that fits instead of dropping all history at the sync quota boundary", async () => {
    const sync = new MemoryStorage();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.preferences.activityHistoryLimit = 100;
    settings.activityHistory = Array.from({ length: 100 }, (_, index) => ({
      id: `activity-${index}`,
      action: "activate" as const,
      result: "success" as const,
      itemId: `directoryRole:${index}:/`,
      itemName: `Role ${index}`,
      itemType: "directoryRole" as const,
      scopeLabel: `Administrative unit ${index}`,
      requestedAt: new Date(Date.UTC(2026, 7, 10, 10) + index * 60_000).toISOString(),
      completedAt: new Date(Date.UTC(2026, 7, 10, 10) + index * 60_000 + 1_000).toISOString(),
      justification: `Needed for a specific administrative change ${index}. ${"Detailed audit context. ".repeat(12)}`,
      sourceInstallationId: "source-work-laptop",
      sourceDeviceName: "Work laptop"
    }));
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const firstStatus = await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    expect(firstStatus.omittedCategories).toContain("activityHistory");

    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const secondStatus = await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });
    const restored = (await secondLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(restored.activityHistory.length).toBeGreaterThan(0);
    expect(restored.activityHistory.length).toBeLessThan(100);
    expect(restored.activityHistory[0]?.id).toBe("activity-99");
    expect(secondStatus.omittedCategories).toContain("activityHistory");

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 3_000, platform: "Windows" });
    const completeLocalCopy = (await firstLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(completeLocalCopy.activityHistory).toHaveLength(100);
    expect(completeLocalCopy.activityHistory[0]?.id).toBe("activity-99");
  });

  test("omits an oversized alias category instead of failing every sync run", async () => {
    const sync = new QuotaStorage();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
      `directoryRole:${index}:${"scope".repeat(12)}`,
      `Long but valid alias ${index} ${"x".repeat(95)}`
    ]));
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const first = await synchronizeBrowserData({ local, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    const second = await synchronizeBrowserData({ local, sync, distribution: edgeStore, now: 2_000, platform: "Windows" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(first.lastError).toBeUndefined();
    expect(second.lastError).toBeUndefined();
    expect(first.omittedCategories).toContain("aliasesByItemId");
    expect(preserved.aliasesByItemId).toHaveProperty(`directoryRole:299:${"scope".repeat(12)}`);
  });

  test("keeps a new concurrent activity event when another installation clears earlier history", async () => {
    const sync = new MemoryStorage();
    const base = structuredClone(DEFAULT_SETTINGS);
    base.activityHistory = [{
      id: "old-event",
      action: "activate",
      result: "success",
      itemId: "directoryRole:old:/",
      itemName: "Old role",
      itemType: "directoryRole",
      requestedAt: "2026-08-10T08:00:00.000Z"
    }];
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: base });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 2_000, platform: "macOS" });

    await mutateSettingsInStorage(firstLocal, (settings) => ({ ...settings, activityHistory: [] }));
    await mutateSettingsInStorage(secondLocal, (settings) => ({
      ...settings,
      activityHistory: [{
        id: "new-event",
        action: "deactivate",
        result: "success",
        itemId: "directoryRole:new:/",
        itemName: "New role",
        itemType: "directoryRole",
        requestedAt: "2026-08-10T09:00:00.000Z"
      }, ...settings.activityHistory]
    }));

    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 3_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: chromeStore, now: 4_000, platform: "macOS" });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: chromeStore, now: 5_000, platform: "Windows" });
    const merged = (await firstLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(merged.activityHistory.map((entry) => entry.id)).toEqual(["new-event"]);
  });

  test("retains recent prior chunks and preserves a concurrent upload until the cleanup grace period", async () => {
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

    expect(Object.keys(sync.data).some((key) => key.startsWith(`quickPimSync.chunk.v1.${firstGeneration}.`))).toBe(true);
    expect(sync.data[concurrentChunkKey]).toBe("pending");
    const currentGeneration = (sync.data[BROWSER_SYNC_MANIFEST_KEY] as { generation: string }).generation;
    expect(Object.keys(sync.data).some((key) => key.startsWith(`quickPimSync.chunk.v1.${currentGeneration}.`))).toBe(true);
  });

  test("removes stale orphaned sync chunks without touching a fresh concurrent upload", async () => {
    const sync = new MemoryStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const initialNow = 200_000_000;
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: initialNow, platform: "Windows" });

    const staleGeneration = `${(initialNow - 48 * 60 * 60_000 - 1).toString(36)}-stale-upload`;
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

  test("keeps a concurrent activation when another installation resets usage counters", async () => {
    const sync = new MemoryStorage();
    const itemId = "directoryRole:counter-reset:/";
    const baseline = structuredClone(DEFAULT_SETTINGS);
    baseline.usageStatsByItemId[itemId] = {
      activationCount: 1,
      lastUsedAt: "2026-08-10T09:00:00.000Z",
      byInstallationId: {
        "baseline-device": { activationCount: 1, lastUsedAt: "2026-08-10T09:00:00.000Z" }
      }
    };
    const resetLocal = new MemoryStorage({ [SETTINGS_KEY]: baseline });
    const activeLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: resetLocal, sync, distribution: chromeStore, now: 10_000, platform: "Windows" });
    await synchronizeBrowserData({ local: activeLocal, sync, distribution: chromeStore, now: 11_000, platform: "macOS" });

    await mutateSettingsInStorage(resetLocal, (settings) => ({ ...settings, usageStatsByItemId: {} }));
    await mutateSettingsInStorage(activeLocal, (settings) => ({
      ...settings,
      usageStatsByItemId: {
        ...settings.usageStatsByItemId,
        [itemId]: {
          activationCount: 2,
          lastUsedAt: "2026-08-10T10:00:00.000Z",
          byInstallationId: {
            "baseline-device": { activationCount: 1, lastUsedAt: "2026-08-10T09:00:00.000Z" },
            "concurrent-device": { activationCount: 1, lastUsedAt: "2026-08-10T10:00:00.000Z" }
          }
        }
      }
    }));

    await synchronizeBrowserData({ local: resetLocal, sync, distribution: chromeStore, now: 12_000, platform: "Windows" });
    await synchronizeBrowserData({ local: activeLocal, sync, distribution: chromeStore, now: 13_000, platform: "macOS" });
    await synchronizeBrowserData({ local: resetLocal, sync, distribution: chromeStore, now: 14_000, platform: "Windows" });

    const merged = (await resetLocal.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    expect(merged.usageStatsByItemId[itemId]).toEqual({
      activationCount: 1,
      lastUsedAt: "2026-08-10T10:00:00.000Z",
      byInstallationId: {
        "concurrent-device": { activationCount: 1, lastUsedAt: "2026-08-10T10:00:00.000Z" }
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

  test("does not let a stale local clock undo a newer device rename", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });
    const firstIdentity = await getBrowserSyncInstallationIdentity({ local: firstLocal, distribution: edgeStore, platform: "Windows" });

    await renameBrowserSyncDevice(
      { local: secondLocal, sync, distribution: edgeStore, now: 3_000, platform: "macOS" },
      firstIdentity.installationId,
      "Remote temporary name"
    );
    await updateBrowserSyncDeviceName(
      { local: firstLocal, sync, distribution: edgeStore, now: 2_500, platform: "Windows" },
      "Local final name"
    );
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 2_600, platform: "Windows" });

    const identity = await getBrowserSyncInstallationIdentity({ local: firstLocal, distribution: edgeStore, platform: "Windows" });
    const status = await getBrowserSyncStatus({ local: secondLocal, sync, distribution: edgeStore, now: 3_100, platform: "macOS" });
    expect(identity.deviceName).toBe("Local final name");
    expect(status.devices.find((device) => device.installationId === firstIdentity.installationId)?.name).toBe("Local final name");
  });

  test("does not rewrite an unchanged device heartbeat when the local clock moves backward", async () => {
    const sync = new CountingStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 100_000, platform: "Windows" });
    sync.deviceWrites = 0;

    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 100, platform: "Windows" });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 200, platform: "Windows" });

    expect(sync.deviceWrites).toBe(0);
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

  test("keeps sync disabled locally when the cloud installation-status write fails", async () => {
    const sync = new ToggleFailingStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    sync.failDeviceWrites = true;

    const status = await setBrowserSyncEnabled({ local, sync, distribution: edgeStore, now: 2_000, platform: "Windows" }, false);

    expect(status.enabled).toBe(false);
    expect(status.lastError).toMatch(/off locally.*could not be updated/i);
  });

  test("keeps sync enabled locally and schedules recovery when the cloud control read fails", async () => {
    const sync = new ToggleFailingStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await setBrowserSyncEnabled({ local, sync, distribution: edgeStore, now: 1_000, platform: "Windows" }, false);
    sync.failReads = true;

    const status = await setBrowserSyncEnabled({ local, sync, distribution: edgeStore, now: 2_000, platform: "Windows" }, true);

    expect(status.enabled).toBe(true);
    expect(status.lastError).toMatch(/enabled locally.*could not be checked/i);
  });

  test("keeps a renamed installation locally when the cloud registry is unavailable", async () => {
    const sync = new ToggleFailingStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    sync.failReads = true;

    const status = await updateBrowserSyncDeviceName(
      { local, sync, distribution: edgeStore, now: 2_000, platform: "Windows" },
      "Local workstation"
    );
    const identity = await getBrowserSyncInstallationIdentity({ local, distribution: edgeStore, platform: "Windows" });

    expect(identity.deviceName).toBe("Local workstation");
    expect(status.lastError).toMatch(/saved locally.*could not be sent yet/i);
  });

  test("purges cloud data, pauses this installation, and prevents another installation from recreating it", async () => {
    const sync = new MemoryStorage();
    const firstLocal = new MemoryStorage({ [SETTINGS_KEY]: { ...structuredClone(DEFAULT_SETTINGS), savedJustifications: ["Specific reason"] } });
    const secondLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });
    await synchronizeBrowserData({ local: secondLocal, sync, distribution: edgeStore, now: 2_000, platform: "macOS" });

    const purged = await purgeBrowserSyncData({ local: secondLocal, sync, distribution: edgeStore, now: 3_000, platform: "macOS" });
    expect(purged.enabled).toBe(false);
    expect(Object.keys(sync.data).filter((key) => key.startsWith(BROWSER_SYNC_KEY_PREFIX)).sort()).toEqual([
      BROWSER_SYNC_CONTROL_KEY,
      BROWSER_SYNC_PURGE_KEY
    ].sort());

    const firstAfterPurge = await synchronizeBrowserData({ local: firstLocal, sync, distribution: edgeStore, now: 4_000, platform: "Windows" });
    expect(firstAfterPurge.enabled).toBe(false);
    expect(firstAfterPurge.suspendedByPurge).toBe(false);
    expect(Object.keys(sync.data).filter((key) => key.startsWith(BROWSER_SYNC_KEY_PREFIX)).sort()).toEqual([
      BROWSER_SYNC_CONTROL_KEY,
      BROWSER_SYNC_PURGE_KEY
    ].sort());
  });

  test("blocks stale cloud restoration while a reset purge is pending and retries it later", async () => {
    const sync = new ToggleFailingStorage();
    const sourceLocal = new MemoryStorage({
      [SETTINGS_KEY]: { ...structuredClone(DEFAULT_SETTINGS), savedJustifications: ["Stale cloud reason"] }
    });
    await synchronizeBrowserData({ local: sourceLocal, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });

    const resetLocal = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await queueBrowserSyncPurgeRetry(resetLocal, new Error("sync unavailable"), 2_000);
    sync.failReads = true;

    const interrupted = await synchronizeBrowserData({ local: resetLocal, sync, distribution: edgeStore, now: 3_000, platform: "macOS" });
    expect(interrupted.lastError).toMatch(/still needs deletion/i);
    expect(resetLocal.data[BROWSER_SYNC_PENDING_PURGE_KEY]).toBeDefined();
    expect((resetLocal.data[SETTINGS_KEY] as QuickPimSettings).savedJustifications).toEqual([]);

    sync.failReads = false;
    const recovered = await synchronizeBrowserData({ local: resetLocal, sync, distribution: edgeStore, now: 4_000, platform: "macOS" });
    expect(recovered.enabled).toBe(false);
    expect(resetLocal.data[BROWSER_SYNC_PENDING_PURGE_KEY]).toBeUndefined();
    expect((resetLocal.data[SETTINGS_KEY] as QuickPimSettings).savedJustifications).toEqual([]);
    expect(Object.keys(sync.data).filter((key) => key.startsWith(BROWSER_SYNC_KEY_PREFIX)).sort()).toEqual([
      BROWSER_SYNC_CONTROL_KEY,
      BROWSER_SYNC_PURGE_KEY
    ].sort());
  });

  test("advances the purge marker monotonically when this computer's clock is behind", async () => {
    const sync = new MemoryStorage({
      [BROWSER_SYNC_CONTROL_KEY]: { version: 1, purgedAt: 10_000, epochAt: 12_000 }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    await purgeBrowserSyncData({ local, sync, distribution: edgeStore, now: 5_000, platform: "Windows" });

    expect(sync.data[BROWSER_SYNC_CONTROL_KEY]).toEqual({ version: 1, purgedAt: 12_001, epochAt: 0 });
    expect(sync.data[BROWSER_SYNC_PURGE_KEY]).toEqual({ version: 1, purgedAt: 12_001 });
  });

  test("keeps purge and resume markers independent so a concurrent resume cannot erase a purge", async () => {
    const sync = new MemoryStorage({
      [BROWSER_SYNC_CONTROL_KEY]: { version: 1, purgedAt: 10_000, epochAt: 0 },
      [BROWSER_SYNC_PURGE_KEY]: { version: 1, purgedAt: 10_000 }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    await setBrowserSyncEnabled({ local, sync, distribution: chromeStore, now: 11_000, platform: "Windows" }, true);
    expect(sync.data[BROWSER_SYNC_EPOCH_KEY]).toEqual({ version: 1, epochAt: 11_000 });

    // A newer purge is a separate monotonic marker and remains authoritative.
    sync.data[BROWSER_SYNC_PURGE_KEY] = { version: 1, purgedAt: 12_000 };
    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 12_001, platform: "Windows" });
    expect(status.enabled).toBe(false);
    expect(status.lastError).toMatch(/deleted from another installation/i);
    expect(sync.data[BROWSER_SYNC_EPOCH_KEY]).toEqual({ version: 1, epochAt: 11_000 });
  });

  test("keeps an already-applied active purge authoritative until a resume marker exists", async () => {
    const sync = new MemoryStorage({
      [BROWSER_SYNC_PURGE_KEY]: { version: 1, purgedAt: 10_000 },
      "quickPimSync.device.v1.installation-1": {
        installationId: "installation-1",
        name: "Workstation",
        browser: "Google Chrome",
        platform: "Windows",
        appVersion: "2.17.0",
        lastSyncAt: 9_000,
        syncEnabled: true,
        nameUpdatedAt: 1
      }
    });
    const local = new MemoryStorage({
      [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS),
      [BROWSER_SYNC_LOCAL_STATE_KEY]: {
        version: 1,
        enabled: true,
        installationId: "installation-1",
        deviceName: "Workstation",
        deviceNameUpdatedAt: 1,
        reminderMode: "daily",
        lastAppliedPurgeAt: 10_000,
        categoryHashes: {},
        categoryUpdatedAt: {},
        categoryBaselines: {}
      }
    });

    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 10_001, platform: "Windows" });

    expect(status.enabled).toBe(false);
    expect(status.lastError).toMatch(/deleted from another installation/i);
    expect(sync.data[BROWSER_SYNC_MANIFEST_KEY]).toBeUndefined();
    expect(sync.data["quickPimSync.device.v1.installation-1"]).toBeUndefined();
  });

  test("does not recreate a device heartbeat when a purge races with snapshot delivery", async () => {
    const sync = new CoordinationRaceStorage();
    sync.injectAfterNextSnapshot({
      [BROWSER_SYNC_PURGE_KEY]: { version: 1, purgedAt: 1_001 }
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId["directoryRole:local:/"] = "Local alias";
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });

    expect(status.enabled).toBe(false);
    expect(status.lastError).toMatch(/deleted from another installation/i);
    expect(Object.keys(sync.data).some((key) => key.startsWith("quickPimSync.device.v1."))).toBe(false);
  });

  test("retries without losing local data when a resume epoch advances during a sync", async () => {
    const sync = new CoordinationRaceStorage();
    sync.injectAfterNextSnapshot({
      [BROWSER_SYNC_EPOCH_KEY]: { version: 1, epochAt: 1_001 }
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aliasesByItemId["directoryRole:local:/"] = "Local alias";
    const local = new MemoryStorage({ [SETTINGS_KEY]: settings });

    const interrupted = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 1_000, platform: "Windows" });
    const recovered = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 2_000, platform: "Windows" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;
    const manifest = sync.data[BROWSER_SYNC_MANIFEST_KEY] as { epochAt?: number };

    expect(interrupted.lastError).toMatch(/coordination changed temporarily/i);
    expect(recovered.lastError).toBeUndefined();
    expect(preserved.aliasesByItemId["directoryRole:local:/"]).toBe("Local alias");
    expect(manifest.epochAt).toBe(1_001);
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
        appVersion: "2.17.0",
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

  test("retains this installation and a newer remote rename when device timestamps crowd it out", async () => {
    const sync = new MemoryStorage();
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const identity = await getBrowserSyncInstallationIdentity({ local, distribution: chromeStore, platform: "Windows" });
    const localState = (await local.get(BROWSER_SYNC_LOCAL_STATE_KEY))[BROWSER_SYNC_LOCAL_STATE_KEY] as Record<string, unknown>;
    await local.set({
      [BROWSER_SYNC_LOCAL_STATE_KEY]: {
        ...localState,
        deviceName: "Old local name",
        deviceNameUpdatedAt: 10
      }
    });
    for (let index = 0; index < 20; index += 1) {
      const installationId = `newer-device-${index.toString().padStart(2, "0")}`;
      sync.data[`quickPimSync.device.v1.${installationId}`] = {
        installationId,
        name: `Newer device ${index}`,
        browser: "Google Chrome",
        platform: "Linux",
        appVersion: "2.17.0",
        lastSyncAt: 1_000 + index,
        syncEnabled: true,
        nameUpdatedAt: 1_000 + index
      };
    }
    sync.data[`quickPimSync.device.v1.${identity.installationId}`] = {
      installationId: identity.installationId,
      name: "Remote final name",
      browser: "Google Chrome",
      platform: "Windows",
      appVersion: "2.17.0",
      lastSyncAt: 50,
      syncEnabled: true,
      nameUpdatedAt: 50
    };

    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: 100, platform: "Windows" });
    const restoredIdentity = await getBrowserSyncInstallationIdentity({ local, distribution: chromeStore, platform: "Windows" });
    const deviceKeys = Object.keys(sync.data).filter((key) => key.startsWith("quickPimSync.device.v1."));

    expect(restoredIdentity.deviceName).toBe("Remote final name");
    expect(deviceKeys).toHaveLength(20);
    expect(deviceKeys).toContain(`quickPimSync.device.v1.${identity.installationId}`);
  });

  test("ignores synchronized device timestamps outside the valid JavaScript date range", async () => {
    const sync = new MemoryStorage({
      "quickPimSync.device.v1.invalid-date-device": {
        installationId: "invalid-date-device",
        name: "Invalid date device",
        browser: "Google Chrome",
        platform: "Windows",
        appVersion: "2.17.0",
        lastSyncAt: Number.MAX_VALUE,
        syncEnabled: true,
        nameUpdatedAt: Number.MAX_VALUE
      }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    const status = await getBrowserSyncStatus({ local, sync, distribution: chromeStore, now: 1_000, platform: "macOS" });

    expect(status.devices).toEqual([]);
  });

  test("rejects implausibly future sync revisions and device records", async () => {
    const now = 1_000_000;
    const future = now + 24 * 60 * 60 * 1000 + 1;
    const snapshot = sanitizeBrowserSyncSnapshot({
      version: 1,
      categories: {
        aliasesByItemId: {
          updatedAt: future,
          updatedBy: "future-device",
          value: { "directoryRole:one:/": "Pinned alias" }
        }
      }
    }, now);
    expect(snapshot?.categories.aliasesByItemId).toBeUndefined();

    const sync = new MemoryStorage({
      "quickPimSync.device.v1.future-device": {
        installationId: "future-device",
        name: "Future device",
        browser: "Microsoft Edge",
        platform: "Windows",
        appVersion: "2.17.0",
        lastSyncAt: future,
        syncEnabled: true,
        nameUpdatedAt: future
      }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    const status = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now, platform: "macOS" });
    expect(status.devices).toEqual([]);
    expect(status.crossDeviceState).toBe("waiting");
  });

  test("clamps plausible future device timestamps to the local observation time", async () => {
    const now = 1_000_000;
    const sync = new MemoryStorage({
      "quickPimSync.device.v1.skewed-device": {
        installationId: "skewed-device",
        name: "Clock-skewed device",
        browser: "Microsoft Edge",
        platform: "Windows",
        appVersion: "2.18.0",
        lastSyncAt: now + 60_000,
        syncEnabled: true,
        nameUpdatedAt: now + 60_000
      }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    const status = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now, platform: "macOS" });

    expect(status.devices[0]).toMatchObject({ lastSyncAt: now, nameUpdatedAt: now });
  });

  test("does not rewrite existing local sync state while rendering status", async () => {
    const local = new WriteCountingStorage({
      [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS),
      [BROWSER_SYNC_LOCAL_STATE_KEY]: {
        version: 1,
        enabled: true,
        installationId: "existing-installation",
        deviceName: "Admin workstation",
        legacyNoise: "retained until a mutating sync pass"
      }
    });
    const sync = new MemoryStorage();

    const status = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now: 1_000, platform: "Windows" });

    expect(status.installationId).toBe("existing-installation");
    expect(local.writes).toBe(0);
  });

  test("migrates the legacy device registry before removing its aggregate key", async () => {
    const sync = new MemoryStorage({
      [BROWSER_SYNC_DEVICES_KEY]: {
        version: 1,
        devices: [{
          installationId: "legacy-device",
          name: "Legacy work laptop",
          browser: "Microsoft Edge",
          platform: "Windows",
        appVersion: "2.17.0",
          lastSyncAt: 900,
          syncEnabled: true,
          nameUpdatedAt: 900
        }]
      }
    });
    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });

    await synchronizeBrowserData({ local, sync, distribution: edgeStore, now: 1_000, platform: "macOS" });

    expect(sync.data).not.toHaveProperty(BROWSER_SYNC_DEVICES_KEY);
    expect(sync.data).toHaveProperty("quickPimSync.device.v1.legacy-device");
    const status = await getBrowserSyncStatus({ local, sync, distribution: edgeStore, now: 1_001, platform: "macOS" });
    expect(status.devices.some((device) => device.installationId === "legacy-device")).toBe(true);
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

  test("keeps a local edit unsynchronized when the future cloud revision cannot be advanced safely", async () => {
    const localNow = 2_000;
    const futureNow = localNow + 24 * 60 * 60 * 1000;
    const sync = new MemoryStorage();
    const remoteSettings = structuredClone(DEFAULT_SETTINGS);
    remoteSettings.aliasesByItemId["directoryRole:remote:/"] = "Remote value";
    await synchronizeBrowserData({
      local: new MemoryStorage({ [SETTINGS_KEY]: remoteSettings }),
      sync,
      distribution: chromeStore,
      now: futureNow,
      platform: "Windows"
    });

    const local = new MemoryStorage({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
    await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: localNow, platform: "macOS" });
    await mutateSettingsInStorage(local, (settings) => ({
      ...settings,
      aliasesByItemId: { ...settings.aliasesByItemId, "directoryRole:local:/": "Local value" }
    }));
    const status = await synchronizeBrowserData({ local, sync, distribution: chromeStore, now: localNow, platform: "macOS" });
    const preserved = (await local.get(SETTINGS_KEY))[SETTINGS_KEY] as QuickPimSettings;

    expect(status.lastError).toMatch(/clocks are too far apart/i);
    expect(preserved.aliasesByItemId["directoryRole:local:/"]).toBe("Local value");
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
