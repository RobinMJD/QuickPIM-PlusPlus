import { APP_VERSION } from "./appMetadata";
import {
  browserFamilyLabel,
  type ExtensionDistributionInfo
} from "./distribution";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  mutateSettingsInStorage
} from "./settings";
import { isSafeRecordKey } from "./security";
import { createStorageMutationLock } from "./storageMutation";
import type { ActivityHistoryEntry, QuickPimPreferences, QuickPimSettings, UsageStats } from "./types";

export const BROWSER_SYNC_ALARM_NAME = "quickPimBrowserSync";
export const BROWSER_SYNC_LOCAL_STATE_KEY = "quickPimBrowserSyncState.v1";
export const BROWSER_SYNC_CONTROL_KEY = "quickPimSync.control.v1";
export const BROWSER_SYNC_MANIFEST_KEY = "quickPimSync.manifest.v1";
export const BROWSER_SYNC_DEVICES_KEY = "quickPimSync.devices.v1";
export const BROWSER_SYNC_KEY_PREFIX = "quickPimSync.";
export const BROWSER_SYNC_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

const BROWSER_SYNC_CHUNK_PREFIX = "quickPimSync.chunk.v1.";
const BROWSER_SYNC_DEVICE_PREFIX = "quickPimSync.device.v1.";
const BROWSER_SYNC_CHUNK_BYTES = 7_000;
const BROWSER_SYNC_ORPHAN_GRACE_MS = 5 * 60_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
// Keep enough headroom for the previous generation, device registry, and
// manifest while a replacement snapshot is being committed.
const BROWSER_SYNC_PAYLOAD_BYTES = 44_000;
const MAX_SYNC_DEVICES = 20;
const MAX_DEVICE_NAME_LENGTH = 60;
const MAX_SYNC_ACTIVITY_ENTRIES = 100;
const withBrowserSyncOperationLock = createStorageMutationLock("quickPimBrowserSyncOperation");

type SyncCategoryName =
  | "preferences"
  | "aliasesByItemId"
  | "favoriteItemIds"
  | "savedJustifications"
  | "recentJustifications"
  | "bundles"
  | "usageStatsByItemId"
  | "activityHistory";

const SYNC_CATEGORY_NAMES: SyncCategoryName[] = [
  "preferences",
  "aliasesByItemId",
  "favoriteItemIds",
  "savedJustifications",
  "recentJustifications",
  "bundles",
  "usageStatsByItemId",
  "activityHistory"
];

const SYNCED_PREFERENCE_KEYS: Array<keyof QuickPimPreferences> = [
  "defaultDurationHours",
  "defaultExtensionDurationHours",
  "defaultSort",
  "defaultSortDirection",
  "recentJustificationLimit",
  "activityHistoryLimit",
  "darkMode",
  "showAssignedRoles",
  "showRemainingActivationTime",
  "showActivationCounters",
  "showEnablementDetails",
  "showLastEnablementDate",
  "backgroundPreRefreshEnabled",
  "expiryReminderMinutes",
  "enabledFeatures",
  "autoEnabledFeaturesInitialized"
];

export type BrowserSyncReminderMode = "daily" | "never";
export type BrowserSyncCapability = "available" | "limited" | "unavailable";

interface SyncCategory {
  updatedAt: number;
  updatedBy: string;
  value: unknown;
}

interface BrowserSyncSnapshot {
  version: 1;
  categories: Partial<Record<SyncCategoryName, SyncCategory>>;
}

interface BrowserSyncManifest {
  version: 1;
  generation: string;
  chunkCount: number;
  byteLength: number;
  hash: string;
  updatedAt: number;
  updatedBy: string;
  epochAt?: number;
  omittedCategories?: SyncCategoryName[];
}

interface BrowserSyncControl {
  version: 1;
  purgedAt?: number;
  epochAt?: number;
}

export interface BrowserSyncDevice {
  installationId: string;
  name: string;
  browser: string;
  platform: string;
  appVersion: string;
  lastSyncAt: number;
  syncEnabled: boolean;
  nameUpdatedAt: number;
}

interface BrowserSyncDeviceRegistry {
  version: 1;
  devices: BrowserSyncDevice[];
}

export interface BrowserSyncLocalState {
  version: 1;
  enabled: boolean;
  installationId: string;
  deviceName: string;
  deviceNameUpdatedAt: number;
  reminderMode: BrowserSyncReminderMode;
  lastReminderAt?: number;
  lastSyncAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  lastRemoteGeneration?: string;
  lastAppliedPurgeAt?: number;
  categoryHashes: Partial<Record<SyncCategoryName, string>>;
  categoryUpdatedAt: Partial<Record<SyncCategoryName, number>>;
  omittedCategories?: SyncCategoryName[];
}

export interface BrowserSyncInstallationIdentity {
  installationId: string;
  deviceName: string;
}

export interface BrowserSyncStatus {
  capability: BrowserSyncCapability;
  supported: boolean;
  enabled: boolean;
  browserLabel: string;
  sourceLabel: string;
  ecosystemLabel?: string;
  reason?: string;
  installationId: string;
  deviceName: string;
  platform: string;
  lastSyncAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  reminderMode: BrowserSyncReminderMode;
  reminderDue: boolean;
  suspendedByPurge: boolean;
  devices: BrowserSyncDevice[];
  omittedCategories: string[];
}

interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

export interface BrowserSyncApis {
  local: StorageAreaLike;
  sync?: StorageAreaLike;
  distribution: ExtensionDistributionInfo;
  now?: number;
  platform?: string;
}

export function getBrowserSyncCapability(
  distribution: ExtensionDistributionInfo,
  hasSyncStorage = typeof chrome !== "undefined" && Boolean(chrome.storage?.sync)
): Pick<BrowserSyncStatus, "capability" | "supported" | "browserLabel" | "sourceLabel" | "ecosystemLabel" | "reason"> {
  const browserLabel = browserFamilyLabel(distribution.browser);
  const sourceLabel = distribution.distribution === "chromeWebStore"
    ? "Chrome Web Store"
    : distribution.distribution === "edgeAddons"
      ? "Microsoft Edge Add-ons"
      : distribution.distribution === "development"
        ? "Local development install"
        : distribution.distribution === "managed"
          ? "Managed installation"
          : distribution.distribution === "sideload"
            ? "Sideloaded installation"
            : "Unknown installation source";

  if (!hasSyncStorage) {
    return {
      capability: "unavailable",
      supported: false,
      browserLabel,
      sourceLabel,
      reason: "This browser does not provide extension sync storage. Use Backup & Restore to move data manually."
    };
  }
  if (distribution.browser === "chrome" && distribution.distribution === "chromeWebStore") {
    return {
      capability: "available",
      supported: true,
      browserLabel,
      sourceLabel,
      ecosystemLabel: "Chrome Sync"
    };
  }
  if (distribution.browser === "edge" && distribution.distribution === "edgeAddons") {
    return {
      capability: "available",
      supported: true,
      browserLabel,
      sourceLabel,
      ecosystemLabel: "Microsoft Edge Sync"
    };
  }

  const reason = distribution.distribution === "development" || distribution.distribution === "sideload"
    ? "This installation has its own extension identity, so it cannot share Store-edition sync data. Install the official edition for this browser, or use Backup & Restore."
    : distribution.distribution === "managed"
      ? "Managed installations cannot be assumed to share the public Store identity. Ask your browser administrator for the official QuickPIM++ Store deployment, or use Backup & Restore."
      : "Native extension sync is available only in the official Chrome Web Store edition on Chrome or the Microsoft Edge Add-ons edition on Edge. Backup & Restore remains available.";
  return {
    capability: "limited",
    supported: false,
    browserLabel,
    sourceLabel,
    reason
  };
}

export async function initializeBrowserSyncAccess(sync: StorageAreaLike | undefined): Promise<void> {
  try {
    await sync?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chromium versions may not expose setAccessLevel. Sync remains extension-scoped.
  }
}

export async function getBrowserSyncInstallationIdentity(
  apis: Pick<BrowserSyncApis, "local" | "distribution" | "platform">
): Promise<BrowserSyncInstallationIdentity> {
  return withBrowserSyncOperationLock(() => getBrowserSyncInstallationIdentityUnlocked(apis));
}

async function getBrowserSyncInstallationIdentityUnlocked(
  apis: Pick<BrowserSyncApis, "local" | "distribution" | "platform">
): Promise<BrowserSyncInstallationIdentity> {
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  return {
    installationId: state.installationId,
    deviceName: state.deviceName
  };
}

export function formatBrowserSyncInstallationId(installationId: string): string {
  const compact = installationId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return compact ? `QP-${compact.slice(0, 8)}` : "QP-UNKNOWN";
}

export function isBrowserSyncDeviceStorageKey(key: string): boolean {
  return key === BROWSER_SYNC_DEVICES_KEY || key.startsWith(BROWSER_SYNC_DEVICE_PREFIX);
}

export async function getBrowserSyncStatus(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => getBrowserSyncStatusUnlocked(apis));
}

async function getBrowserSyncStatusUnlocked(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  const now = apis.now ?? Date.now();
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  const control = apis.sync ? await loadControl(apis.sync) : { version: 1 as const };
  const registry = apis.sync ? await loadDeviceRegistry(apis.sync) : { version: 1 as const, devices: [] };
  const suspendedByPurge = Boolean(control.purgedAt && control.purgedAt > (state.lastAppliedPurgeAt || 0) && (control.epochAt || 0) <= control.purgedAt);
  return {
    ...capability,
    enabled: state.enabled,
    installationId: state.installationId,
    deviceName: state.deviceName,
    platform: normalizePlatform(apis.platform || detectPlatform()),
    lastSyncAt: state.lastSyncAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    reminderMode: state.reminderMode,
    reminderDue: !capability.supported
      && state.reminderMode !== "never"
      && (!state.lastReminderAt || now - state.lastReminderAt >= BROWSER_SYNC_REMINDER_INTERVAL_MS),
    suspendedByPurge,
    devices: registry.devices,
    omittedCategories: state.omittedCategories || []
  };
}

export async function synchronizeBrowserData(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => synchronizeBrowserDataUnlocked(apis));
}

async function synchronizeBrowserDataUnlocked(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  const now = apis.now ?? Date.now();
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  let state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  if (!capability.supported || !apis.sync || !state.enabled) {
    return getBrowserSyncStatusUnlocked(apis);
  }

  const sync = apis.sync;
  try {
    await initializeBrowserSyncAccess(sync);
    state = await reconcileLocalDeviceName(apis.local, sync, state);
    const control = await loadControl(sync);
    if (control.purgedAt && control.purgedAt > (state.lastAppliedPurgeAt || 0) && (control.epochAt || 0) <= control.purgedAt) {
      state = {
        ...state,
        enabled: false,
        lastAppliedPurgeAt: control.purgedAt,
        lastError: "Synced data was deleted from another installation. Sync is paused until you enable it again."
      };
      await saveLocalState(apis.local, state);
      return getBrowserSyncStatusUnlocked(apis);
    }

    const epochAt = control.epochAt || 0;
    const remote = await readRemoteSnapshot(sync, epochAt);
    let merged: BrowserSyncSnapshot = { version: 1, categories: {} };
    let mergedHashes: Partial<Record<SyncCategoryName, string>> = {};
    await mutateSettingsInStorage(apis.local, (latestSettings) => {
      const localSnapshot = buildLocalSnapshot(latestSettings, state, now, remote?.snapshot);
      merged = mergeSnapshots(localSnapshot.snapshot, remote?.snapshot);
      const mergedSettings = applySnapshotToSettings(latestSettings, merged);
      mergedHashes = getCategoryHashes(mergedSettings);
      return mergedSettings;
    });
    const fitted = fitSnapshotForSync(merged);
    const remoteHash = remote?.manifest.hash;
    const fittedHash = hashString(canonicalStringify(fitted.snapshot));
    let generation = remote?.manifest.generation;
    if (fittedHash !== remoteHash) {
      generation = await writeRemoteSnapshot(
        sync,
        fitted.snapshot,
        state.installationId,
        now,
        fitted.omittedCategories,
        remote?.manifest.generation,
        epochAt
      );
    }

    const mergedCategoryUpdatedAt = Object.fromEntries(
      SYNC_CATEGORY_NAMES.flatMap((name) => merged.categories[name]
        ? [[name, merged.categories[name]!.updatedAt] as const]
        : [])
    );
    state = {
      ...state,
      lastSyncAt: now,
      lastSuccessAt: now,
      lastError: undefined,
      lastRemoteGeneration: generation,
      categoryHashes: mergedHashes,
      categoryUpdatedAt: mergedCategoryUpdatedAt,
      omittedCategories: fitted.omittedCategories
    };
    await saveLocalState(apis.local, state);
    await updateDeviceRegistry(sync, state, capability.browserLabel, normalizePlatform(apis.platform || detectPlatform()), now, true);
  } catch (error) {
    state = {
      ...state,
      lastSyncAt: now,
      lastError: sanitizeSyncError(error)
    };
    await saveLocalState(apis.local, state);
  }
  return getBrowserSyncStatusUnlocked(apis);
}

export async function setBrowserSyncEnabled(apis: BrowserSyncApis, enabled: boolean): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => setBrowserSyncEnabledUnlocked(apis, enabled));
}

async function setBrowserSyncEnabledUnlocked(apis: BrowserSyncApis, enabled: boolean): Promise<BrowserSyncStatus> {
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  let state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  if (enabled && !capability.supported) {
    throw new Error(capability.reason || "Browser sync is unavailable for this installation.");
  }
  state = { ...state, enabled, lastError: undefined };
  await saveLocalState(apis.local, state);
  if (!apis.sync) return getBrowserSyncStatusUnlocked(apis);

  const now = apis.now ?? Date.now();
  if (enabled) {
    const control = await loadControl(apis.sync);
    if (control.purgedAt && (control.epochAt || 0) <= control.purgedAt) {
      await apis.sync.set({
        [BROWSER_SYNC_CONTROL_KEY]: {
          ...control,
          version: 1,
          epochAt: Math.max(now, control.purgedAt + 1)
        } satisfies BrowserSyncControl
      });
      state = { ...state, lastAppliedPurgeAt: control.purgedAt };
      await saveLocalState(apis.local, state);
    }
    return synchronizeBrowserDataUnlocked(apis);
  }
  await updateDeviceRegistry(apis.sync, state, capability.browserLabel, normalizePlatform(apis.platform || detectPlatform()), now, false);
  return getBrowserSyncStatusUnlocked(apis);
}

export async function updateBrowserSyncDeviceName(apis: BrowserSyncApis, name: string): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => updateBrowserSyncDeviceNameUnlocked(apis, name));
}

async function updateBrowserSyncDeviceNameUnlocked(apis: BrowserSyncApis, name: string): Promise<BrowserSyncStatus> {
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  const deviceName = sanitizeDeviceName(name) || buildDefaultDeviceName(apis.distribution, apis.platform);
  const now = apis.now ?? Date.now();
  const nextState = { ...state, deviceName, deviceNameUpdatedAt: Math.max(now, state.deviceNameUpdatedAt + 1) };
  await saveLocalState(apis.local, nextState);
  if (apis.sync && state.enabled && getBrowserSyncCapability(apis.distribution, true).supported) {
    await updateDeviceRegistry(
      apis.sync,
      nextState,
      browserFamilyLabel(apis.distribution.browser),
      normalizePlatform(apis.platform || detectPlatform()),
      now,
      state.enabled
    );
  }
  return getBrowserSyncStatusUnlocked(apis);
}

export async function renameBrowserSyncDevice(
  apis: BrowserSyncApis,
  installationId: string,
  name: string
): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => renameBrowserSyncDeviceUnlocked(apis, installationId, name));
}

async function renameBrowserSyncDeviceUnlocked(
  apis: BrowserSyncApis,
  installationId: string,
  name: string
): Promise<BrowserSyncStatus> {
  const capability = getBrowserSyncCapability(apis.distribution, Boolean(apis.sync));
  if (!apis.sync || !capability.supported) {
    throw new Error(capability.reason || "Browser sync storage is unavailable.");
  }
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  if (!state.enabled) {
    throw new Error("Enable Browser Sync on this installation before renaming another installation.");
  }
  const safeId = sanitizeText(installationId, 80);
  const deviceName = sanitizeDeviceName(name);
  if (!safeId || !deviceName) throw new Error("Choose a valid installation and name.");
  const registry = await loadDeviceRegistry(apis.sync);
  const device = registry.devices.find((entry) => entry.installationId === safeId);
  if (!device) throw new Error("This installation is no longer present in browser sync.");
  const now = apis.now ?? Date.now();
  const renamed = {
    ...device,
    name: deviceName,
    nameUpdatedAt: Math.max(now, device.nameUpdatedAt + 1)
  };
  await apis.sync.set({ [deviceKey(safeId)]: renamed });

  if (state.installationId === safeId) {
    await saveLocalState(apis.local, {
      ...state,
      deviceName,
      deviceNameUpdatedAt: renamed.nameUpdatedAt
    });
  }
  return getBrowserSyncStatusUnlocked(apis);
}

export async function dismissBrowserSyncReminder(
  apis: BrowserSyncApis,
  mode: BrowserSyncReminderMode
): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => dismissBrowserSyncReminderUnlocked(apis, mode));
}

async function dismissBrowserSyncReminderUnlocked(
  apis: BrowserSyncApis,
  mode: BrowserSyncReminderMode
): Promise<BrowserSyncStatus> {
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  await saveLocalState(apis.local, {
    ...state,
    reminderMode: mode,
    lastReminderAt: apis.now ?? Date.now()
  });
  return getBrowserSyncStatusUnlocked(apis);
}

export async function markBrowserSyncReminderShown(apis: BrowserSyncApis): Promise<void> {
  return withBrowserSyncOperationLock(() => markBrowserSyncReminderShownUnlocked(apis));
}

async function markBrowserSyncReminderShownUnlocked(apis: BrowserSyncApis): Promise<void> {
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  if (state.reminderMode === "never") return;
  await saveLocalState(apis.local, {
    ...state,
    lastReminderAt: apis.now ?? Date.now()
  });
}

export async function purgeBrowserSyncData(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  return withBrowserSyncOperationLock(() => purgeBrowserSyncDataUnlocked(apis));
}

async function purgeBrowserSyncDataUnlocked(apis: BrowserSyncApis): Promise<BrowserSyncStatus> {
  if (!apis.sync) {
    throw new Error("Browser sync storage is unavailable.");
  }
  const now = apis.now ?? Date.now();
  await apis.sync.set({
    [BROWSER_SYNC_CONTROL_KEY]: { version: 1, purgedAt: now, epochAt: 0 } satisfies BrowserSyncControl
  });
  const all = await apis.sync.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(BROWSER_SYNC_KEY_PREFIX) && key !== BROWSER_SYNC_CONTROL_KEY);
  if (keys.length) await apis.sync.remove(keys);
  const state = await loadBrowserSyncLocalState(apis.local, apis.distribution, apis.platform);
  await saveLocalState(apis.local, {
    ...state,
    enabled: false,
    lastAppliedPurgeAt: now,
    lastSyncAt: now,
    lastSuccessAt: undefined,
    lastRemoteGeneration: undefined,
    lastError: undefined,
    categoryHashes: {},
    categoryUpdatedAt: {},
    omittedCategories: []
  });
  return getBrowserSyncStatusUnlocked(apis);
}

export function sanitizeBrowserSyncStatus(value: unknown): BrowserSyncStatus | null {
  if (!isRecord(value) || typeof value.supported !== "boolean" || typeof value.enabled !== "boolean") return null;
  const capability = value.capability === "available" || value.capability === "limited" || value.capability === "unavailable"
    ? value.capability
    : value.supported ? "available" : "limited";
  return {
    capability,
    supported: value.supported,
    enabled: value.enabled,
    browserLabel: sanitizeText(value.browserLabel, 80) || "Browser",
    sourceLabel: sanitizeText(value.sourceLabel, 80) || "Unknown installation",
    ecosystemLabel: sanitizeText(value.ecosystemLabel, 80) || undefined,
    reason: sanitizeText(value.reason, 400) || undefined,
    installationId: sanitizeText(value.installationId, 80),
    deviceName: sanitizeDeviceName(value.deviceName) || "This installation",
    platform: sanitizeText(value.platform, 80) || "Unknown platform",
    lastSyncAt: sanitizeTimestamp(value.lastSyncAt),
    lastSuccessAt: sanitizeTimestamp(value.lastSuccessAt),
    lastError: sanitizeText(value.lastError, 300) || undefined,
    reminderMode: value.reminderMode === "never" ? "never" : "daily",
    reminderDue: value.reminderDue === true,
    suspendedByPurge: value.suspendedByPurge === true,
    devices: sanitizeDevices(value.devices),
    omittedCategories: Array.isArray(value.omittedCategories)
      ? value.omittedCategories.filter((item): item is string => typeof item === "string").slice(0, SYNC_CATEGORY_NAMES.length)
      : []
  };
}

function buildLocalSnapshot(
  settings: QuickPimSettings,
  state: BrowserSyncLocalState,
  now: number,
  remote?: BrowserSyncSnapshot
) {
  const values = getSyncCategoryValues(settings);
  const categories: Partial<Record<SyncCategoryName, SyncCategory>> = {};
  const defaultHashes = getCategoryHashes(DEFAULT_SETTINGS);
  const hashes = getCategoryHashes(settings);
  for (const name of SYNC_CATEGORY_NAMES) {
    const changed = state.categoryHashes[name] !== hashes[name];
    const initialTimestamp = hashes[name] === defaultHashes[name] ? 0 : now;
    const changedTimestamp = Math.max(
      now,
      (state.categoryUpdatedAt[name] || 0) + 1,
      (remote?.categories[name]?.updatedAt || 0) + 1
    );
    categories[name] = {
      updatedAt: changed
        ? state.categoryHashes[name] === undefined && initialTimestamp === 0 ? 0 : changedTimestamp
        : state.categoryUpdatedAt[name] || initialTimestamp,
      updatedBy: state.installationId,
      value: values[name]
    };
  }
  return { snapshot: { version: 1 as const, categories }, hashes };
}

function mergeSnapshots(local: BrowserSyncSnapshot, remote?: BrowserSyncSnapshot): BrowserSyncSnapshot {
  if (!remote) return local;
  const categories: BrowserSyncSnapshot["categories"] = {};
  for (const name of SYNC_CATEGORY_NAMES) {
    const localCategory = local.categories[name];
    const remoteCategory = remote.categories[name];
    if (!localCategory) categories[name] = remoteCategory;
    else if (!remoteCategory) categories[name] = localCategory;
    else if (name === "activityHistory") {
      categories[name] = mergeActivityHistoryCategories(localCategory, remoteCategory);
    } else if (name === "usageStatsByItemId") {
      categories[name] = mergeUsageCategories(localCategory, remoteCategory);
    }
    else if (localCategory.updatedAt !== remoteCategory.updatedAt) {
      categories[name] = localCategory.updatedAt > remoteCategory.updatedAt ? localCategory : remoteCategory;
    } else {
      categories[name] = localCategory.updatedBy.localeCompare(remoteCategory.updatedBy) >= 0 ? localCategory : remoteCategory;
    }
  }
  return { version: 1, categories };
}

function mergeActivityHistoryCategories(local: SyncCategory, remote: SyncCategory): SyncCategory {
  const localEntries = sanitizeActivityHistoryValue(local.value);
  const remoteEntries = sanitizeActivityHistoryValue(remote.value);
  if (!localEntries.length && local.updatedAt > remote.updatedAt) return local;
  if (!remoteEntries.length && remote.updatedAt > local.updatedAt) return remote;

  const entries = new Map<string, ActivityHistoryEntry>();
  for (const entry of [...remoteEntries, ...localEntries]) {
    const existing = entries.get(entry.id);
    if (!existing || compareActivityEntries(entry, existing) >= 0) entries.set(entry.id, entry);
  }
  const winner = chooseCategoryMetadata(local, remote);
  return {
    ...winner,
    value: [...entries.values()]
      .sort((left, right) => activityTimestamp(right).localeCompare(activityTimestamp(left)) || right.id.localeCompare(left.id))
      .slice(0, MAX_SYNC_ACTIVITY_ENTRIES)
  };
}

function mergeUsageCategories(local: SyncCategory, remote: SyncCategory): SyncCategory {
  const localStats = sanitizeUsageValue(local.value);
  const remoteStats = sanitizeUsageValue(remote.value);
  if (!Object.keys(localStats).length && local.updatedAt > remote.updatedAt) return local;
  if (!Object.keys(remoteStats).length && remote.updatedAt > local.updatedAt) return remote;

  const merged: Record<string, UsageStats> = {};
  for (const itemId of new Set([...Object.keys(localStats), ...Object.keys(remoteStats)])) {
    if (!isSafeRecordKey(itemId)) continue;
    const left = localStats[itemId];
    const right = remoteStats[itemId];
    merged[itemId] = left && right ? mergeUsageStats(left, right) : structuredClone(left || right!);
  }
  return { ...chooseCategoryMetadata(local, remote), value: sortObject(merged) };
}

function mergeUsageStats(left: UsageStats, right: UsageStats): UsageStats {
  const byInstallationId: NonNullable<UsageStats["byInstallationId"]> = {};
  for (const installationId of new Set([
    ...Object.keys(left.byInstallationId || {}),
    ...Object.keys(right.byInstallationId || {})
  ])) {
    if (!isSafeRecordKey(installationId)) continue;
    const leftEntry = left.byInstallationId?.[installationId];
    const rightEntry = right.byInstallationId?.[installationId];
    if (!leftEntry) byInstallationId[installationId] = structuredClone(rightEntry!);
    else if (!rightEntry) byInstallationId[installationId] = structuredClone(leftEntry);
    else byInstallationId[installationId] = {
      activationCount: Math.max(leftEntry.activationCount, rightEntry.activationCount),
      ...(latestTimestamp(leftEntry.lastUsedAt, rightEntry.lastUsedAt)
        ? { lastUsedAt: latestTimestamp(leftEntry.lastUsedAt, rightEntry.lastUsedAt) }
        : {})
    };
  }
  const leftKnown = Object.values(left.byInstallationId || {}).reduce((total, entry) => total + entry.activationCount, 0);
  const rightKnown = Object.values(right.byInstallationId || {}).reduce((total, entry) => total + entry.activationCount, 0);
  const legacyActivationCount = Math.max(
    left.legacyActivationCount ?? Math.max(0, left.activationCount - leftKnown),
    right.legacyActivationCount ?? Math.max(0, right.activationCount - rightKnown)
  );
  const knownTotal = Object.values(byInstallationId).reduce((total, entry) => total + entry.activationCount, 0);
  return {
    activationCount: Math.min(100000, legacyActivationCount + knownTotal),
    ...(latestTimestamp(left.lastUsedAt, right.lastUsedAt)
      ? { lastUsedAt: latestTimestamp(left.lastUsedAt, right.lastUsedAt) }
      : {}),
    ...(legacyActivationCount ? { legacyActivationCount } : {}),
    ...(Object.keys(byInstallationId).length ? { byInstallationId } : {})
  };
}

function sanitizeActivityHistoryValue(value: unknown): ActivityHistoryEntry[] {
  return mergeSettings({ activityHistory: Array.isArray(value) ? value : [] }).activityHistory;
}

function sanitizeUsageValue(value: unknown): Record<string, UsageStats> {
  return mergeSettings({
    usageStatsByItemId: (isRecord(value) ? value : {}) as QuickPimSettings["usageStatsByItemId"]
  }).usageStatsByItemId;
}

function chooseCategoryMetadata(left: SyncCategory, right: SyncCategory): SyncCategory {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  return left.updatedBy.localeCompare(right.updatedBy) >= 0 ? left : right;
}

function compareActivityEntries(left: ActivityHistoryEntry, right: ActivityHistoryEntry): number {
  return activityTimestamp(left).localeCompare(activityTimestamp(right))
    || canonicalStringify(left).localeCompare(canonicalStringify(right));
}

function activityTimestamp(entry: ActivityHistoryEntry): string {
  return entry.completedAt || entry.requestedAt;
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function applySnapshotToSettings(current: QuickPimSettings, snapshot: BrowserSyncSnapshot): QuickPimSettings {
  const next: Partial<QuickPimSettings> = { ...current };
  for (const name of SYNC_CATEGORY_NAMES) {
    const category = snapshot.categories[name];
    if (!category) continue;
    if (name === "preferences") {
      next.preferences = { ...current.preferences, ...(isRecord(category.value) ? category.value : {}) } as QuickPimPreferences;
    } else {
      (next as Record<string, unknown>)[name] = category.value;
    }
  }
  return mergeSettings(next);
}

function getSyncCategoryValues(settings: QuickPimSettings): Record<SyncCategoryName, unknown> {
  const preferences = Object.fromEntries(SYNCED_PREFERENCE_KEYS.map((key) => [key, settings.preferences[key]]));
  return {
    preferences,
    aliasesByItemId: sortObject(settings.aliasesByItemId),
    favoriteItemIds: settings.favoriteItemIds,
    savedJustifications: settings.savedJustifications,
    recentJustifications: settings.recentJustifications,
    bundles: settings.bundles,
    usageStatsByItemId: sortObject(settings.usageStatsByItemId),
    activityHistory: [...settings.activityHistory]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, MAX_SYNC_ACTIVITY_ENTRIES)
  };
}

function getCategoryHashes(settings: QuickPimSettings): Partial<Record<SyncCategoryName, string>> {
  const values = getSyncCategoryValues(settings);
  return Object.fromEntries(SYNC_CATEGORY_NAMES.map((name) => [name, hashString(canonicalStringify(values[name]))]));
}

function fitSnapshotForSync(snapshot: BrowserSyncSnapshot): { snapshot: BrowserSyncSnapshot; omittedCategories: SyncCategoryName[] } {
  const fitted: BrowserSyncSnapshot = structuredClone(snapshot);
  const omittedCategories: SyncCategoryName[] = [];
  for (const name of ["activityHistory", "usageStatsByItemId", "recentJustifications"] as SyncCategoryName[]) {
    if (utf8Length(canonicalStringify(fitted)) <= BROWSER_SYNC_PAYLOAD_BYTES) break;
    delete fitted.categories[name];
    omittedCategories.push(name);
  }
  if (utf8Length(canonicalStringify(fitted)) > BROWSER_SYNC_PAYLOAD_BYTES) {
    throw new Error("Portable settings exceed the browser sync quota. Reduce aliases or bundle size, or use Backup & Restore.");
  }
  return { snapshot: fitted, omittedCategories };
}

async function readRemoteSnapshot(
  sync: StorageAreaLike,
  minimumEpochAt = 0
): Promise<{ manifest: BrowserSyncManifest; snapshot: BrowserSyncSnapshot } | undefined> {
  const manifestValue = (await sync.get(BROWSER_SYNC_MANIFEST_KEY))[BROWSER_SYNC_MANIFEST_KEY];
  const manifest = sanitizeManifest(manifestValue);
  if (!manifest) return undefined;
  if ((manifest.epochAt || 0) < minimumEpochAt) return undefined;
  const keys = Array.from({ length: manifest.chunkCount }, (_, index) => chunkKey(manifest.generation, index));
  const chunks = await sync.get(keys);
  const serialized = keys.map((key) => typeof chunks[key] === "string" ? chunks[key] : "").join("");
  if (utf8Length(serialized) !== manifest.byteLength || hashString(serialized) !== manifest.hash) {
    throw new Error("Synced settings were incomplete. QuickPIM++ will retry after the browser finishes syncing.");
  }
  const parsed: unknown = JSON.parse(serialized);
  const snapshot = sanitizeBrowserSyncSnapshot(parsed);
  if (!snapshot) throw new Error("Synced settings use an unsupported format.");
  return { manifest, snapshot };
}

async function writeRemoteSnapshot(
  sync: StorageAreaLike,
  snapshot: BrowserSyncSnapshot,
  installationId: string,
  now: number,
  omittedCategories: SyncCategoryName[],
  previousGeneration?: string,
  epochAt = 0
): Promise<string> {
  const serialized = canonicalStringify(snapshot);
  const chunks = splitUtf8(serialized, BROWSER_SYNC_CHUNK_BYTES);
  const generation = `${now.toString(36)}-${installationId.slice(-8)}-${randomId().slice(-6)}`;
  await removeStaleOrphanedChunks(sync, now, new Set(previousGeneration ? [previousGeneration] : []));
  await sync.set(Object.fromEntries(chunks.map((chunk, index) => [chunkKey(generation, index), chunk])));
  const manifest: BrowserSyncManifest = {
    version: 1,
    generation,
    chunkCount: chunks.length,
    byteLength: utf8Length(serialized),
    hash: hashString(serialized),
    updatedAt: now,
    updatedBy: installationId,
    ...(epochAt ? { epochAt } : {}),
    ...(omittedCategories.length ? { omittedCategories } : {})
  };
  await sync.set({ [BROWSER_SYNC_MANIFEST_KEY]: manifest });
  // Delete only the committed generation this write replaced. Removing every
  // other generation can erase chunks another installation is uploading
  // concurrently before that installation publishes its manifest.
  if (previousGeneration && previousGeneration !== generation) {
    const all = await sync.get(null);
    const previousPrefix = `${BROWSER_SYNC_CHUNK_PREFIX}${previousGeneration}.`;
    const previousChunks = Object.keys(all).filter((key) => key.startsWith(previousPrefix));
    if (previousChunks.length) await sync.remove(previousChunks);
  }
  return generation;
}

async function removeStaleOrphanedChunks(
  sync: StorageAreaLike,
  now: number,
  protectedGenerations: Set<string>
): Promise<void> {
  const all = await sync.get(null);
  const staleKeys = Object.keys(all).filter((key) => {
    if (!key.startsWith(BROWSER_SYNC_CHUNK_PREFIX)) return false;
    const suffix = key.slice(BROWSER_SYNC_CHUNK_PREFIX.length);
    const chunkSeparator = suffix.lastIndexOf(".");
    if (chunkSeparator <= 0) return false;
    const generation = suffix.slice(0, chunkSeparator);
    if (protectedGenerations.has(generation)) return false;
    const timestampPart = generation.split("-", 1)[0];
    if (!/^[0-9a-z]+$/i.test(timestampPart)) return false;
    const generatedAt = Number.parseInt(timestampPart, 36);
    return Number.isSafeInteger(generatedAt)
      && generatedAt > 0
      && now - generatedAt >= BROWSER_SYNC_ORPHAN_GRACE_MS;
  });
  if (staleKeys.length) await sync.remove(staleKeys);
}

async function loadBrowserSyncLocalState(
  local: StorageAreaLike,
  distribution: ExtensionDistributionInfo,
  platform?: string
): Promise<BrowserSyncLocalState> {
  const value = (await local.get(BROWSER_SYNC_LOCAL_STATE_KEY))[BROWSER_SYNC_LOCAL_STATE_KEY];
  const source = isRecord(value) ? value : {};
  const installationId = sanitizeText(source.installationId, 80) || randomId();
  const state: BrowserSyncLocalState = {
    version: 1,
    enabled: source.enabled !== false,
    installationId,
    deviceName: sanitizeDeviceName(source.deviceName) || buildDefaultDeviceName(distribution, platform),
    deviceNameUpdatedAt: sanitizeTimestamp(source.deviceNameUpdatedAt) || 0,
    reminderMode: source.reminderMode === "never" ? "never" : "daily",
    lastReminderAt: sanitizeTimestamp(source.lastReminderAt),
    lastSyncAt: sanitizeTimestamp(source.lastSyncAt),
    lastSuccessAt: sanitizeTimestamp(source.lastSuccessAt),
    lastError: sanitizeText(source.lastError, 300) || undefined,
    lastRemoteGeneration: sanitizeText(source.lastRemoteGeneration, 120) || undefined,
    lastAppliedPurgeAt: sanitizeTimestamp(source.lastAppliedPurgeAt),
    categoryHashes: sanitizeCategoryNumberMap(source.categoryHashes, false),
    categoryUpdatedAt: sanitizeCategoryNumberMap(source.categoryUpdatedAt, true),
    omittedCategories: sanitizeCategoryNames(source.omittedCategories)
  };
  if (!isRecord(value) || canonicalStringify(value) !== canonicalStringify(state)) {
    await saveLocalState(local, state);
  }
  return state;
}

async function saveLocalState(local: StorageAreaLike, state: BrowserSyncLocalState): Promise<void> {
  await local.set({ [BROWSER_SYNC_LOCAL_STATE_KEY]: state });
}

async function loadControl(sync: StorageAreaLike): Promise<BrowserSyncControl> {
  const value = (await sync.get(BROWSER_SYNC_CONTROL_KEY))[BROWSER_SYNC_CONTROL_KEY];
  if (!isRecord(value)) return { version: 1 };
  return {
    version: 1,
    purgedAt: sanitizeTimestamp(value.purgedAt),
    epochAt: sanitizeTimestamp(value.epochAt)
  };
}

async function loadDeviceRegistry(sync: StorageAreaLike): Promise<BrowserSyncDeviceRegistry> {
  return buildDeviceRegistry(await sync.get(null));
}

function buildDeviceRegistry(values: Record<string, unknown>): BrowserSyncDeviceRegistry {
  const legacy = values[BROWSER_SYNC_DEVICES_KEY];
  const candidates = [
    ...(isRecord(legacy) && Array.isArray(legacy.devices) ? legacy.devices : []),
    ...Object.entries(values)
      .filter(([key]) => key.startsWith(BROWSER_SYNC_DEVICE_PREFIX))
      .map(([, value]) => value)
  ];
  const devicesById = new Map<string, BrowserSyncDevice>();
  for (const device of sanitizeDevices(candidates)) {
    const current = devicesById.get(device.installationId);
    if (!current || device.lastSyncAt > current.lastSyncAt || device.nameUpdatedAt > current.nameUpdatedAt) {
      devicesById.set(device.installationId, mergeDeviceRecords(current, device));
    }
  }
  return {
    version: 1,
    devices: [...devicesById.values()].sort((a, b) => b.lastSyncAt - a.lastSyncAt).slice(0, MAX_SYNC_DEVICES)
  };
}

async function updateDeviceRegistry(
  sync: StorageAreaLike,
  state: BrowserSyncLocalState,
  browser: string,
  platform: string,
  now: number,
  syncEnabled: boolean
): Promise<void> {
  const registry = await loadDeviceRegistry(sync);
  const existing = registry.devices.find((item) => item.installationId === state.installationId);
  const current: BrowserSyncDevice = {
    installationId: state.installationId,
    name: existing && existing.nameUpdatedAt > state.deviceNameUpdatedAt ? existing.name : state.deviceName,
    browser,
    platform,
    appVersion: APP_VERSION,
    lastSyncAt: now,
    syncEnabled,
    nameUpdatedAt: Math.max(existing?.nameUpdatedAt || 0, state.deviceNameUpdatedAt)
  };
  await sync.set({ [deviceKey(state.installationId)]: current });
  const all = await sync.get(null);
  const latestRegistry = buildDeviceRegistry(all);
  const retainedIds = new Set(latestRegistry.devices.map((device) => device.installationId));
  const staleDeviceKeys = Object.keys(all).filter((key) => {
    if (!key.startsWith(BROWSER_SYNC_DEVICE_PREFIX)) return false;
    return !retainedIds.has(key.slice(BROWSER_SYNC_DEVICE_PREFIX.length));
  });
  if (staleDeviceKeys.length) await sync.remove(staleDeviceKeys);
}

function sanitizeDevices(value: unknown): BrowserSyncDevice[] {
  if (!Array.isArray(value)) return [];
  const devicesById = new Map<string, BrowserSyncDevice>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const installationId = sanitizeText(item.installationId, 80);
    const lastSyncAt = sanitizeTimestamp(item.lastSyncAt);
    if (!installationId || !lastSyncAt) continue;
    const device: BrowserSyncDevice = {
      installationId,
      name: sanitizeDeviceName(item.name) || "QuickPIM++ installation",
      browser: sanitizeText(item.browser, 80) || "Browser",
      platform: sanitizeText(item.platform, 80) || "Unknown platform",
      appVersion: sanitizeText(item.appVersion, 30) || "Unknown version",
      lastSyncAt,
      syncEnabled: item.syncEnabled !== false,
      nameUpdatedAt: sanitizeTimestamp(item.nameUpdatedAt) || 0
    };
    devicesById.set(installationId, mergeDeviceRecords(devicesById.get(installationId), device));
  }
  return [...devicesById.values()]
    .sort((a, b) => b.lastSyncAt - a.lastSyncAt)
    .slice(0, MAX_SYNC_DEVICES);
}

async function reconcileLocalDeviceName(
  local: StorageAreaLike,
  sync: StorageAreaLike,
  state: BrowserSyncLocalState
): Promise<BrowserSyncLocalState> {
  const device = (await loadDeviceRegistry(sync)).devices.find((entry) => entry.installationId === state.installationId);
  if (!device || device.nameUpdatedAt <= state.deviceNameUpdatedAt || device.name === state.deviceName) return state;
  const next = {
    ...state,
    deviceName: device.name,
    deviceNameUpdatedAt: device.nameUpdatedAt
  };
  await saveLocalState(local, next);
  return next;
}

function mergeDeviceRecords(
  left: BrowserSyncDevice | undefined,
  right: BrowserSyncDevice
): BrowserSyncDevice {
  if (!left) return right;
  const nameSource = right.nameUpdatedAt >= left.nameUpdatedAt ? right : left;
  const statusSource = right.lastSyncAt >= left.lastSyncAt ? right : left;
  return {
    ...statusSource,
    name: nameSource.name,
    nameUpdatedAt: nameSource.nameUpdatedAt,
    lastSyncAt: Math.max(left.lastSyncAt, right.lastSyncAt)
  };
}

function deviceKey(installationId: string): string {
  return `${BROWSER_SYNC_DEVICE_PREFIX}${installationId}`;
}

export function sanitizeBrowserSyncSnapshot(value: unknown): BrowserSyncSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.categories)) return undefined;
  const categories: BrowserSyncSnapshot["categories"] = {};
  for (const name of SYNC_CATEGORY_NAMES) {
    const category = value.categories[name];
    if (!isRecord(category)) continue;
    const updatedAt = Number(category.updatedAt);
    const updatedBy = sanitizeText(category.updatedBy, 80);
    const sanitizedValue = sanitizeSyncCategoryValue(name, category.value);
    if (!Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > MAX_DATE_EPOCH_MS || !updatedBy || sanitizedValue === undefined) continue;
    categories[name] = { updatedAt, updatedBy, value: sanitizedValue };
  }
  return { version: 1, categories };
}

function sanitizeSyncCategoryValue(name: SyncCategoryName, value: unknown): unknown | undefined {
  const expectsRecord = name === "preferences" || name === "aliasesByItemId" || name === "usageStatsByItemId";
  if (expectsRecord ? !isRecord(value) : !Array.isArray(value)) return undefined;
  const normalized = mergeSettings({ [name]: value } as Partial<QuickPimSettings>);
  if (name === "preferences") {
    return Object.fromEntries(SYNCED_PREFERENCE_KEYS.flatMap((key) =>
      Object.hasOwn(value as Record<string, unknown>, key)
        ? [[key, normalized.preferences[key]] as const]
        : []
    ));
  }
  return getSyncCategoryValues(normalized)[name];
}

function sanitizeManifest(value: unknown): BrowserSyncManifest | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const generation = sanitizeText(value.generation, 120);
  const chunkCount = Number(value.chunkCount);
  const byteLength = Number(value.byteLength);
  const hash = sanitizeText(value.hash, 32);
  const updatedAt = Number(value.updatedAt);
  const updatedBy = sanitizeText(value.updatedBy, 80);
  const epochAt = sanitizeTimestamp(value.epochAt);
  if (!generation || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 20 || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > BROWSER_SYNC_PAYLOAD_BYTES || !hash || !Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > MAX_DATE_EPOCH_MS || !updatedBy) return undefined;
  return {
    version: 1,
    generation,
    chunkCount,
    byteLength,
    hash,
    updatedAt,
    updatedBy,
    ...(epochAt ? { epochAt } : {}),
    omittedCategories: sanitizeCategoryNames(value.omittedCategories)
  };
}

function sanitizeCategoryNumberMap(value: unknown, numeric: true): Partial<Record<SyncCategoryName, number>>;
function sanitizeCategoryNumberMap(value: unknown, numeric: false): Partial<Record<SyncCategoryName, string>>;
function sanitizeCategoryNumberMap(value: unknown, numeric: boolean) {
  if (!isRecord(value)) return {};
  const result: Partial<Record<SyncCategoryName, number | string>> = {};
  for (const name of SYNC_CATEGORY_NAMES) {
    const item = value[name];
    if (numeric) {
      const parsed = Number(item);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_DATE_EPOCH_MS) result[name] = parsed;
    } else if (typeof item === "string" && item.length <= 32) {
      result[name] = item;
    }
  }
  return result;
}

function sanitizeCategoryNames(value: unknown): SyncCategoryName[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is SyncCategoryName => SYNC_CATEGORY_NAMES.includes(item as SyncCategoryName)))];
}

function buildDefaultDeviceName(distribution: ExtensionDistributionInfo, platform?: string): string {
  return `${browserFamilyLabel(distribution.browser)} on ${normalizePlatform(platform || detectPlatform())}`;
}

function detectPlatform(): string {
  const navigatorWithHints = navigator as Navigator & { userAgentData?: { platform?: string } };
  return navigatorWithHints.userAgentData?.platform || navigator.platform || "Unknown platform";
}

function normalizePlatform(value: string): string {
  const normalized = sanitizeText(value, 80).replace(/^MacIntel$/i, "macOS").replace(/^Win32$/i, "Windows");
  return normalized || "Unknown platform";
}

function sanitizeDeviceName(value: unknown): string {
  return sanitizeText(value, MAX_DEVICE_NAME_LENGTH);
}

function sanitizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function sanitizeTimestamp(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_DATE_EPOCH_MS ? parsed : undefined;
}

function sanitizeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "Browser sync failed.");
  return sanitizeText(message, 300) || "Browser sync failed.";
}

function randomId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function chunkKey(generation: string, index: number): string {
  return `${BROWSER_SYNC_CHUNK_PREFIX}${generation}.${index}`;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (current && bytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sortObject<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
